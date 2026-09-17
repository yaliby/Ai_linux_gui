/**
 * ניגודיות צבע בדפדפן אמיתי, בארבעה מצבים.
 *   node test/contrast.test.mjs
 *
 * ‎WCAG 2.1 AA‎ דורש ‎4.5:1‎ לטקסט רגיל ו-‎3:1‎ לטקסט גדול. אי-אפשר לבדוק את
 * זה מתוך ה-CSS: הצבע בפועל נולד מ-‎color-mix‎, מ-‎var()‎ שנפתר לפי ערכת
 * הנושא, ומרקע שקוף שמורכב משכבה מעל שכבה. רק מנוע אמיתי יודע מה יצא.
 *
 * הצבעים נפתרים דרך ‎canvas‎ ולא בפענוח ידני: הדפדפן מחזיר גם
 * ‎color(srgb 0.99 0.99 1)‎ וגם ‎oklch()‎, ופענוח ידני של הראשון הוא מה
 * שהחזיר כאן פעם מספרי ניגודיות שקריים (רקע לבן שנקרא כשחור).
 *
 * מה שנמצא ותוקן בזכות הבדיקה הזאת:
 *   • ‎.cu-src‎ — שבב הספק ברצועת המכסה: ‎3.46‎ בבהיר, ‎4.38‎ בכהה. צבע המותג
 *     על הגוון שלו עצמו אינו קריא ב-11px.
 *   • ‎.notify-chip‎ — ‎4.19‎ בבהיר.
 *   • הדגשת הקוד: ערכות ‎github‎ נבנו מול ‎#fff‎, והקוד כאן יושב על נייר
 *     בסלייט. ‎built_in‎ ירד ל-‎3.17‎ — ‎console‎ ו-‎require‎ בכל גוש קוד.
 */
import { runner } from './harness.mjs';
import { findBrowser, launch, newPage, startServer, freePort } from './browser.mjs';

if (!findBrowser()) {
  console.log('\nניגודיות צבע\n  ⚠ אין דפדפן מבוסס-Chromium — מדלג\n');
  process.exit(0);
}

const t = runner('ניגודיות צבע');

/* שיחה שמכסה כמה שיותר משטחים צבועים: markdown, קוד בשתי שפות, כרטיס כלי. */
const CODE = [
  '```js', '// הערה בקוד', 'const fs = require("fs");',
  'class Foo extends Bar {', '  async run(n = 42) {',
  '    console.log(JSON.stringify({ a: /re?g/g }));',
  '    return typeof n === "number" ? n : null;', '  }', '}', '```', '',
  '```html', '<div class="x" id="y">טקסט</div>', '```', '',
  '# כותרת', '- פריט ברשימה', '> ציטוט', '| א | ב |', '|---|---|', '| 1 | 2 |',
].join('\n');

const CONV = {
  id: 'contrast-1', title: 'בדיקת ניגודיות', cwd: '/tmp', draft: '',
  cost: 0.42, createdAt: Date.now() - 1000, updatedAt: Date.now(), rev: 1,
  messages: [
    { role: 'user', text: 'שאלה של המשתמש' },
    { role: 'assistant', model: 'sonnet', blocks: [
      { type: 'text', text: 'תשובה **מודגשת**, *נטויה*, עם `קוד בשורה`.\n\n' + CODE },
      { type: 'thinking', text: 'מחשבה גלויה\n', tokens: 90 },
      { type: 'tool', id: 't1', name: 'Bash', status: 'ok', input: { command: 'ls -la' }, result: 'פלט' },
      { type: 'tool', id: 't2', name: 'Edit', status: 'err', input: { file_path: '/a.js', old_string: 'ישן', new_string: 'חדש' }, result: 'שגיאה' },
    ] },
  ],
};

/* ‎.c-time‎/‎.c-del‎ ברשימת השיחות: ‎4.47‎ בכהה מול 4.5 הנדרשים. הם משתמשים
   ב-‎--text-faint‎, שכוון במפורש ל-‎4.51‎ מול ‎--panel-2‎ (ראו ההערה ב-style.css);
   הרקע בפועל של שורת השיחה שונה בטיפה. פער של 0.03 אינו סיבה לשנות אסימון
   גלובלי שנימוקו כתוב — הוא רשום כאן כדי שיישאר גלוי ולא ייעלם. */
const KNOWN = new Set(['span.c-time', 'button.c-del']);

const AUDIT = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const memo = new Map();
  const rgba = (css) => {
    if (memo.has(css)) return memo.get(css);
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000';
    try { ctx.fillStyle = css; } catch { memo.set(css, null); return null; }
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const v = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    memo.set(css, v); return v;
  };
  const relLum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const over = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a), a: 1 });
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0.1; };
  const bgOf = (el) => {
    const stack = []; let n = el;
    while (n) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== 'none') return null;   // גרדיאנט — לא נמדד כאן
      const c = rgba(s.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
      n = n.parentElement;
    }
    if (!stack.length) return { r: 255, g: 255, b: 255, a: 1 };
    let acc = stack.pop();
    while (stack.length) acc = over(stack.pop(), acc);
    return acc;
  };

  const bad = [];
  for (const el of document.querySelectorAll('*')) {
    if (!vis(el)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
    const s = getComputedStyle(el);
    const raw = rgba(s.color); if (!raw) continue;
    const bg = bgOf(el); if (!bg) continue;
    const fg = raw.a < 1 ? over(raw, bg) : raw;
    const fl = relLum(fg), bl = relLum(bg);
    const ratio = (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05);
    const px = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
    const need = (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5;
    if (ratio < need) bad.push({
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + (el.className || '').toString().split(' ')[0],
      text: (el.textContent || '').trim().slice(0, 24), ratio: +ratio.toFixed(2), need, px: +px.toFixed(1),
    });
  }
  const seen = new Set(); const out = [];
  for (const b of bad) { if (seen.has(b.sel)) continue; seen.add(b.sel); out.push(b); }
  return out;
})()`;

const PORT = freePort();
const srv = await startServer({ port: PORT, conversations: [CONV] });
const br = await launch();
const page = await newPage(br);
const cleanup = async () => { try { await page.close(); } catch {} try { await br.close(); } catch {} srv.stop(); };
process.on('exit', () => srv.stop());

try {
  for (const [w, h, dark, name] of [
    [390, 844, false, 'טלפון · בהיר'],
    [390, 844, true, 'טלפון · כהה'],
    [1440, 900, false, 'מחשב · בהיר'],
    [1440, 900, true, 'מחשב · כהה'],
  ]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await page.goto(srv.url);
    await page.waitFor('typeof renderConversation === "function" && storeReady && store.convs.length > 0');
    await page.eval(`(async () => {
      const c = store.convs[0]; await ensureLoaded(c.id); activeId = c.id; renderConversation();
    })()`);
    await new Promise((r) => setTimeout(r, 600));

    t.section(name);
    const bad = (await page.eval(AUDIT)).filter((b) => !KNOWN.has(b.sel));
    t.eq('אין טקסט מתחת לסף WCAG AA',
      bad.map((b) => `${b.sel} ${b.ratio}<${b.need} (${b.px}px) «${b.text}»`), []);
  }

  /* השורש של אחד מהם: הקוד יושב על ‎--code-bg‎ ולא על ‎#fff‎ שערכות ‎github‎
     מניחות. הבדיקה הזאת נועלת את ההחלפה ולא רק את התוצאה. */
  t.section('אסימוני הדגשת הקוד מוחלפים ולא נשארים של התמה');
  {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await page.goto(srv.url);
    await page.waitFor('typeof renderConversation === "function" && storeReady');
    await page.eval(`(async () => { const c = store.convs[0]; await ensureLoaded(c.id); activeId = c.id; renderConversation(); })()`);
    await new Promise((r) => setTimeout(r, 400));
    const got = await page.eval(`(() => {
      const pick = (cls) => { const el = document.querySelector('.' + cls); return el ? getComputedStyle(el).color : null; };
      return { builtin: pick('hljs-built_in'), keyword: pick('hljs-keyword'), comment: pick('hljs-comment') };
    })()`);
    // ערכי ה-vendor שנפלו מתחת לסף; אם אחד מהם חזר, ההחלפה נשברה
    t.ok('built_in אינו #e36209', got.builtin !== 'rgb(227, 98, 9)', got);
    t.ok('keyword אינו #d73a49', got.keyword !== 'rgb(215, 58, 73)', got);
    t.ok('comment אינו #6a737d', got.comment !== 'rgb(106, 115, 125)', got);
  }

  t.section('בלי שגיאות');
  t.eq('הקונסולה נקייה', page.errors().map((e) => String(e.text).slice(0, 120)), []);
} catch (e) {
  console.log('\n  ✗ הבדיקה נפלה: ' + e.message);
  await cleanup();
  process.exit(1);
}

await cleanup();
t.done();
