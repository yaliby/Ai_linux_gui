/**
 * מעבדה לקוד הלקוח: DOM מזויף + מנוע פריסה קטן + SpeechRecognition מזויף.
 *
 * למה לא jsdom: מה שנשבר בשורת הכתיבה הוא *מדידה* — רוחב חריץ, רוחב טקסט,
 * גובה שנגזר מהם. jsdom מחזיר 0 בכל מדידה, ולכן בדיקה מעליו הייתה מאשרת
 * קוד שבור. כאן יש מודל פריסה מפורש (flex בשורה, עטיפה, ריפודים), ולכן
 * הבדיקה באמת שואלת "מה יקרה על מסך ברוחב 360 עם טקסט באורך X".
 *
 * המודל לא מתיימר להיות דפדפן: רוחב תו קבוע, גובה שורה קבוע, בלי BIDI ובלי
 * גופנים. זה מספיק בדיוק בשביל ההחלטות שהקוד מקבל, וזה מה שנבדק.
 */
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

export function slice(from, to, src = SRC) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`לא נמצא ב-app.js: ${from}`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`לא נמצא ב-app.js: ${to}`);
  return src.slice(a, b);
}

// ---------------------------------------------------------------- DOM מזויף

class ClassList {
  constructor(el, initial = '') { this.el = el; this.set = new Set(String(initial).split(/\s+/).filter(Boolean)); }
  // ‎onchange‎ מותקן על ה-body: בדפדפן שינוי מחלקה מחשב פריסה מחדש לפני
  // המדידה הבאה, וכאן זה מה שמחזיק את המלבנים תואמים למצב.
  add(...c) { c.forEach((x) => this.set.add(x)); this.onchange && this.onchange(); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); this.onchange && this.onchange(); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c); else this.set.delete(c);
    this.onchange && this.onchange();
    return want;
  }
  get value() { return [...this.set].join(' '); }
  toString() { return this.value; }
}

class El {
  constructor(tag, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this.id = opts.id || '';
    this.classList = new ClassList(this, opts.cls || '');
    this.style = {};
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = new Map();
    this.anims = [];
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.value = opts.value !== undefined ? opts.value : '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
    this.doc = opts.doc || null;
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { if (k === 'id') this.id = ''; delete this.attrs[k]; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type) || [];
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  }
  dispatch(type, ev = {}) {
    const e = { type, preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.propagationStopped = true; }, target: this, ...ev };
    for (const fn of (this.listeners.get(type) || []).slice()) fn(e);
    const inline = this['on' + type];
    if (typeof inline === 'function') inline(e);
    return e;
  }
  focus() { if (this.doc) this.doc.activeElement = this; }
  blur() { if (this.doc && this.doc.activeElement === this) this.doc.activeElement = this.doc.body; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  getBoundingClientRect() {
    const r = this.rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  get clientWidth() { return Math.round(this.rect.width); }
  get clientHeight() { return Math.round(this.rect.height); }
  get scrollHeight() { return this._scrollHeight !== undefined ? this._scrollHeight : Math.round(this.rect.height); }
  closest(sel) {
    let n = this;
    while (n) { if (matches(n, sel)) return n; n = n.parent; }
    return null;
  }
  querySelectorAll(sel) { return all(this).filter((n) => n !== this && matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  cloneNode() {
    const c = new El(this.tagName, { id: this.id, cls: this.classList.value, doc: this.doc });
    c.textContent = this.textContent;
    c.rect = { ...this.rect };
    c.attrs = { ...this.attrs };
    for (const ch of this.children) c.appendChild(ch.cloneNode(true));
    return c;
  }
  animate(frames, opts) {
    const a = {
      el: this, frames, opts, playState: 'running',
      finished: Promise.resolve(),
      cancel() { this.playState = 'idle'; const i = a.el.anims.indexOf(a); if (i >= 0) a.el.anims.splice(i, 1); },
    };
    this.anims.push(a);
    return a;
  }
  getAnimations() { return this.anims.slice(); }
}

function matches(el, sel) {
  for (const part of String(sel).split(',').map((s) => s.trim())) {
    if (part.startsWith('#') && el.id === part.slice(1)) return true;
    if (part.startsWith('.') && el.classList.contains(part.slice(1))) return true;
    if (part === '[id]' && el.id) return true;
    if (/^[a-z]+$/i.test(part) && el.tagName === part.toUpperCase()) return true;
  }
  return false;
}
function all(root, out = []) {
  out.push(root);
  for (const c of root.children) all(c, out);
  return out;
}

// ------------------------------------------------------------ מנוע הפריסה

const CARD_PAD = 8;      // .composer-card padding
const GAP = 6;           // body.compose-compact .composer-card gap
const BTN = 34;          // .attach
const SEND = 38;         // #sendBtn
const LINE = 24;         // line-height בפועל של התיבה
const IN_PAD_Y = 16;     // ריפוד אנכי של התיבה

/**
 * מחשב מחדש את כל המלבנים לפי מחלקות ה-body ורוחב הכרטיס.
 * זה הלב של הסימולציה: אותה פריסה שה-CSS מתאר, בחשבון מפורש.
 */
function relayout(env) {
  const { body, card, input, mic, attach, sched, send, pills } = env.els;
  const compact = body.classList.contains('compose-compact');
  const tall = body.classList.contains('compose-tall');
  const inner = env.cardWidth - CARD_PAD * 2;
  const vis = (el) => el && !el.classList.contains('hidden');

  card.rect = { left: 0, top: 0, width: env.cardWidth, height: 0 };
  const btns = [mic, attach, send].filter(vis);
  const btnW = (el) => (el === send ? SEND : BTN);

  let inputW, inputTop, rowTop;
  if (!compact) {
    inputW = inner;                       // דסקטופ: תיבה מלאה, כפתורים מתחת
    inputTop = CARD_PAD;
  } else if (tall) {
    inputW = inner;
    inputTop = CARD_PAD;
  } else {
    inputW = inner - btns.reduce((s, b) => s + btnW(b), 0) - GAP * btns.length;
    inputTop = CARD_PAD;
  }
  inputW = Math.max(40, inputW);

  const padX = compact && tall ? 24 : compact ? 16 : 28;
  input._padX = padX;
  const lines = textLines(input.value, inputW - padX, env.charW);
  const h = lines * LINE + IN_PAD_Y;
  input.rect = { left: CARD_PAD, top: inputTop, width: inputW, height: Math.min(h, env.maxInputH) };
  input._scrollHeight = h;

  rowTop = compact && !tall ? inputTop : inputTop + input.rect.height + GAP;
  let x = CARD_PAD;
  if (compact && !tall) {
    // mic · attach · [input] · send באותה שורה
    for (const b of [mic, attach].filter(vis)) { b.rect = { left: x, top: rowTop, width: btnW(b), height: BTN }; x += btnW(b) + GAP; }
    input.rect.left = x; x += inputW + GAP;
    if (vis(send)) { send.rect = { left: x, top: rowTop, width: SEND, height: SEND }; }
    if (pills) pills.rect = { left: 0, top: 0, width: 0, height: 0 };   // display:none בקומפקט
    if (sched) sched.rect = { left: 0, top: 0, width: 0, height: 0 };   // וגם התזמון, בחריץ הצר
  } else {
    for (const b of [mic, attach, sched].filter(vis)) { b.rect = { left: x, top: rowTop, width: btnW(b), height: BTN }; x += btnW(b) + GAP; }
    const pillW = Math.max(0, inner - (x - CARD_PAD) - (vis(send) ? SEND + GAP : 0));
    if (pills) pills.rect = (compact && tall) || !compact
      ? { left: x, top: rowTop, width: pillW, height: 32 }
      : { left: 0, top: 0, width: 0, height: 0 };
    x += pillW + GAP;
    if (vis(send)) send.rect = { left: x, top: rowTop, width: SEND, height: SEND };
  }
  card.rect.height = rowTop + BTN + CARD_PAD;
}

/**
 * כמה שורות ייצא הטקסט ברוחב נתון. שבירה על רווחים, ומילה ארוכה מהשורה
 * נשברת באמצע — זו ההתנהגות של ‎textarea‎ (‎pre-wrap‎ + ‎break-word‎), ובלעדיה
 * הסימולציה הייתה מדווחת "שורה אחת" בדיוק על המקרה שהפיצ'ר בא לתפוס.
 */
function textLines(v, w, charW) {
  if (!v) return 1;
  const per = Math.max(1, Math.floor(w / charW));   // תווים שנכנסים בשורה
  let lines = 0;
  for (const para of String(v).split('\n')) {
    if (!para) { lines++; continue; }
    let n = 1, cur = 0;
    for (const tok of para.split(/(\s+)/)) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) { cur = Math.min(per, cur + tok.length); continue; }  // רווח נגרר "נתלה"
      let word = tok;
      if (word.length > per) {
        if (cur > 0) { n++; cur = 0; }
        while (word.length > per) { word = word.slice(per); n++; }
        cur = word.length;
        continue;
      }
      if (cur + word.length > per && cur > 0) { n++; cur = word.length; }
      else cur += word.length;
    }
    lines += n;
  }
  return Math.max(1, lines);
}

// ------------------------------------------------------- SpeechRecognition

/** מנוע הכרה מזויף — מדבר את אותה שפת אירועים של Chrome. */
export class FakeRecognition {
  constructor() {
    this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1;
    this.state = 'idle';
    this.onresult = this.onerror = this.onend = this.onstart = null;
    FakeRecognition.made.push(this);
    this.startCalls = 0;
    this.results = [];
    if (FakeRecognition.throwOnConstruct) throw new Error('nope');
  }
  start() {
    this.startCalls++;
    if (FakeRecognition.throwOnStart) throw new Error('InvalidStateError');
    if (this.state === 'running') throw new Error('InvalidStateError: already started');
    this.state = 'running';
    this.results = [];
    if (this.onstart) this.onstart({});
  }
  stop() { if (this.state !== 'running') return; this.state = 'idle'; if (this.onend) this.onend({}); }
  abort() { if (this.state !== 'running') { this.state = 'idle'; return; } this.state = 'idle'; if (this.onend) this.onend({}); }

  /** תוצאות חדשות מהמנוע. chunks = [[text, isFinal], ...] */
  emit(chunks) {
    if (this.state !== 'running') throw new Error('emit על מנוע שאינו רץ');
    const resultIndex = this.results.length;
    for (const [t, fin] of chunks) {
      if (this.results.length && !this.results[this.results.length - 1].isFinal && !this._newSegment) {
        this.results[this.results.length - 1] = mkRes(t, fin);
      } else {
        this.results.push(mkRes(t, fin));
      }
      this._newSegment = fin;
    }
    const ev = { resultIndex: Math.min(resultIndex, this.results.length - 1), results: this.results };
    if (this.onresult) this.onresult(ev);
  }
  err(error) { if (this.onerror) this.onerror({ error }); }
}
FakeRecognition.made = [];
FakeRecognition.throwOnStart = false;
FakeRecognition.throwOnConstruct = false;
const mkRes = (t, fin) => { const r = [{ transcript: t, confidence: 0.9 }]; r.isFinal = !!fin; r.length = 1; return r; };

// --------------------------------------------------------------- הסביבה

/**
 * מרכיב סביבה חדשה וטוענת לתוכה את הקוד האמיתי מ-app.js.
 * מחזיר את ה-API שהבדיקות מנהלות דרכו.
 */
export function makeEnv(opts = {}) {
  const env = {
    cardWidth: opts.cardWidth || 344,
    charW: opts.charW || 8,
    maxInputH: opts.maxInputH || 300,
    toasts: [], logs: [], saved: 0, drafts: [], sent: [],
  };
  FakeRecognition.made.length = 0;
  FakeRecognition.throwOnStart = false;
  FakeRecognition.throwOnConstruct = false;

  const doc = {
    activeElement: null,
    hidden: false,
    listeners: new Map(),
    addEventListener(t, fn) { if (!doc.listeners.has(t)) doc.listeners.set(t, []); doc.listeners.get(t).push(fn); },
    removeEventListener() {},
    dispatch(t, ev = {}) {
      const e = { type: t, preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.propagationStopped = true; }, ...ev };
      for (const fn of (doc.listeners.get(t) || []).slice()) fn(e);
      return e;
    },
    createElement(tag) {
      const el = new El(tag, { doc });
      if (tag === 'canvas') el.getContext = () => ({ font: '', measureText: (s) => ({ width: s.length * env.charW }) });
      return el;
    },
    querySelector(sel) { return doc.body.querySelector(sel) || (matches(doc.body, sel) ? doc.body : null); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
  };

  const body = new El('body', { doc });
  doc.body = body;
  doc.activeElement = body;
  // documentElement.style.setProperty — שם נכתבים --app-h / --app-top
  const root = new El('html', { doc });
  root.cssVars = {};
  root.style.setProperty = (k, v) => { root.cssVars[k] = v; };
  root.style.removeProperty = (k) => { delete root.cssVars[k]; };
  doc.documentElement = root;
  env.cssVars = root.cssVars;

  const composer = body.appendChild(new El('div', { cls: 'composer', doc }));
  const card = composer.appendChild(new El('div', { cls: 'composer-card', doc }));
  const dictStrip = card.appendChild(new El('div', { id: 'dictStrip', cls: 'dict-strip hidden', doc }));
  const dictLang = dictStrip.appendChild(new El('button', { id: 'dictLang', doc }));
  const dictDone = dictStrip.appendChild(new El('button', { id: 'dictDone', doc }));
  const input = card.appendChild(new El('textarea', { id: 'input', doc }));
  const bar = card.appendChild(new El('div', { cls: 'composer-bar', doc }));
  const attach = bar.appendChild(new El('button', { id: 'attachBtn', cls: 'attach', doc }));
  const mic = bar.appendChild(new El('button', { id: 'micBtn', cls: 'attach mic hidden', doc }));
  const sched = bar.appendChild(new El('button', { id: 'schedBtn', cls: 'attach', doc }));
  const pills = bar.appendChild(new El('div', { cls: 'pill-row', doc }));
  pills.appendChild(new El('select', { id: 'model', doc }));
  // שליחה ועצירה הם כפתור אחד: שליחה ריקה בזמן תור = עצור (ראו sendBtn ב-app.js)
  const send = bar.appendChild(new El('button', { id: 'sendBtn', doc }));

  env.els = { body, card, input, mic, attach, sched, send, pills, dictStrip, dictLang, dictDone, composer };
  const byId = { input, micBtn: mic, attachBtn: attach, schedBtn: sched, sendBtn: send, dictStrip, dictLang, dictDone, model: pills.children[0] };

  env.relayout = () => relayout(env);
  body.classList.onchange = () => relayout(env);
  env.relayout();

  // ---- גלובלים שהקוד מצפה להם
  const win = {
    innerHeight: opts.innerHeight || 740,
    isSecureContext: opts.secure !== false,
    SpeechRecognition: opts.noSpeech ? undefined : FakeRecognition,
    webkitSpeechRecognition: undefined,
    addEventListener(t, fn) { doc.addEventListener('win:' + t, fn); },
  };
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.getComputedStyle = (el) => {
    if (el === card) return { paddingLeft: CARD_PAD + 'px', paddingRight: CARD_PAD + 'px' };
    if (el === input) {
      const p = (input._padX || 16) / 2;
      return { paddingLeft: p + 'px', paddingRight: p + 'px', fontWeight: '400', fontSize: '15.5px', fontFamily: 'ui' };
    }
    return { paddingLeft: '0px', paddingRight: '0px', fontWeight: '400', fontSize: '15px', fontFamily: 'ui' };
  };
  globalThis.matchMedia = (q) => ({
    matches: /reduced-motion/.test(q) ? !!opts.reduceMotion
      : /pointer: *coarse/.test(q) ? opts.coarse !== false
        : false,
    addEventListener() {}, removeEventListener() {},
  });
  globalThis.addEventListener = win.addEventListener;
  globalThis.$ = (id) => byId[id] || null;
  globalThis.store = { settings: opts.settings || {}, history: [] };
  globalThis.save = () => { env.saved++; };
  globalThis.toast = (t, err) => env.toasts.push({ t, err: !!err });
  globalThis.dlog = (tag, data) => env.logs.push({ tag, data });
  globalThis.stashDraft = () => env.drafts.push(input.value);
  globalThis.stashDraftSoon = () => { env.draftsSoon = (env.draftsSoon || 0) + 1; };
  globalThis.sendMessage = (t) => { env.sent.push(t !== undefined ? t : input.value); if (globalThis.__dictOn && globalThis.__dictOn()) env.api.dictStop(); };
  globalThis.interruptTurn = () => {};

  // כל שינוי ב-value מחייב פריסה מחדש — בדפדפן זה קורה מעצמו
  const rawValue = { v: '' };
  Object.defineProperty(input, 'value', {
    get() { return rawValue.v; },
    set(nv) { rawValue.v = String(nv); relayout(env); },
    configurable: true,
  });

  const composerSrc = slice('function composeTallDecision(', "$('sendBtn').onclick");
  const dictSrc = slice('const DICT_LANGS = [', "$('godLiveBtn').onclick");
  const api = new Function(`
    ${composerSrc}
    ${dictSrc}
    return {
      composeTallDecision, composeNarrowSlotPx, shouldComposeTall, autoGrow, setComposeTall, growInput,
      dictStart, dictStop, dictToggle, dictSetLang, dictPaint, dictJoin, dictAnchorAtCaret, dictRender, dictReanchor,
      dictLang, dictSupported,
      get on() { return dictOn; },
      get rec() { return dictRec; },
      get anchor() { return dictAnchor; },
      set anchor(v) { dictAnchor = v; },
      get loops() { return dictLoops; },
    };
  `)();
  env.api = api;
  // באפליקציה שתי היחידות חיות באותו מודול; כאן הן שתי הידורים נפרדים,
  // ולכן מה שאחת קוראת מהשנייה חייב לעבור דרך הגלובל.
  globalThis.autoGrow = api.autoGrow;
  globalThis.__dictOn = () => api.on;

  // ---- שליטה מהבדיקה
  env.type = (s) => { input.value = input.value + s; input.selectionStart = input.selectionEnd = input.value.length; input.dispatch('input', {}); };
  env.setText = (s) => { input.value = s; input.selectionStart = input.selectionEnd = s.length; input.dispatch('input', {}); };
  env.keydown = (key, extra = {}) => input.dispatch('keydown', { key, ...extra });
  env.keyboard = (open) => { body.classList.toggle('compose-compact', open); relayout(env); api.autoGrow(); };
  env.tall = () => body.classList.contains('compose-tall');
  /** כמה שורות הטקסט תופס בפועל בפריסה הנוכחית — המדד שהפיצ'ר בא למנוע. */
  env.lines = () => Math.round((input._scrollHeight - IN_PAD_Y) / LINE);
  env.rec = () => FakeRecognition.made[FakeRecognition.made.length - 1];
  env.recs = () => FakeRecognition.made;
  env.hideTab = () => { doc.hidden = true; doc.dispatch('visibilitychange'); };
  env.showTab = () => { doc.hidden = false; doc.dispatch('visibilitychange'); };
  env.pagehide = () => doc.dispatch('win:pagehide');
  env.click = (id) => byId[id].dispatch('click');
  env.El = El;
  return env;
}

/**
 * מחבר את הקוד האמיתי שעוקב אחרי `visualViewport` (פתיחת מקלדת) לסביבה.
 * מחזיר שליטה: `env.keyboard(open)` דרך אירועי resize אמיתיים, לא דרך
 * הוספת מחלקה ביד — כדי שמה שנבדק יהיה ההחלטה של הקוד, לא ההנחה שלי.
 */
export function installViewport(env, opts = {}) {
  const vv = {
    width: opts.width || 390,
    height: opts.height || 740,
    offsetTop: 0,
    listeners: new Map(),
    addEventListener(t, fn) { if (!vv.listeners.has(t)) vv.listeners.set(t, []); vv.listeners.get(t).push(fn); },
    dispatch(t) { for (const fn of (vv.listeners.get(t) || []).slice()) fn({ type: t }); },
  };
  globalThis.window.visualViewport = vv;
  globalThis.window.scrollY = 0;
  globalThis.window.scrollTo = (x, y) => { globalThis.window.scrollY = y; env.scrolls = (env.scrolls || 0) + 1; };
  globalThis.stick = true;
  globalThis.autoScroll = () => { env.autoScrolls = (env.autoScrolls || 0) + 1; };
  new Function(slice('(function trackVisualViewport() {', '})();') + '})();')();
  env.vv = vv;
  env.resting = vv.height;
  env.keyboard = (open, kb = 320) => {
    vv.height = open ? env.resting - kb : env.resting;
    vv.dispatch('resize');
    env.relayout();
  };
  return vv;
}

// ------------------------------------------------------------ דיווח בדיקות

export function runner(title) {
  let pass = 0, fail = 0;
  console.log('\n' + title);
  const t = {
    eq(name, got, want) {
      const ok = JSON.stringify(got) === JSON.stringify(want);
      if (ok) { pass++; console.log('  ✓', name); }
      else { fail++; console.log('  ✗', name, '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)); }
    },
    ok(name, cond, extra) { t.eq(name, !!cond, true); if (!cond && extra !== undefined) console.log('      ' + JSON.stringify(extra)); },
    section(s) { console.log('\n' + s); },
    done() { console.log(`\n${pass} עברו, ${fail} נכשלו`); process.exit(fail ? 1 : 0); },
    get fail() { return fail; },
  };
  return t;
}
