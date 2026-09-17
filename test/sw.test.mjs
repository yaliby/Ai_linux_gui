/**
 * ה-Service Worker (`public/sw.js`) — שיתוף פנימה, מטמון קליפה, ומענה מתוך
 * ההתראה.
 *
 * הקוד הזה רץ בדיוק כשאין דף פתוח: לחיצה על "אשר" בהתראה כשהאפליקציה סגורה,
 * ושיתוף מאפליקציה אחרת שמגיע כ-POST רב-חלקי. אין שם מסך לראות עליו שגיאה,
 * ולכן הוא נבדק כאן מול `self` מזויף — עם `Request`/`Response`/`FormData`
 * האמיתיים של Node, כדי שפענוח ה-multipart יהיה זה של הדפדפן ולא חיקוי שלו.
 */
import fs from 'node:fs';
import { runner } from './harness.mjs';

const t = runner('Service Worker');

const SRC = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://sol.local';

/** מטמון בזיכרון עם ה-API של Cache Storage. */
function cacheStore() {
  const store = new Map();
  const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name);
      return {
        async put(req, res) { c.set(keyOf(req), res); },
        async addAll(list) { for (const u of list) c.set(new URL(u, ORIGIN).href, new Response('shell')); },
        async keys() { return [...c.keys()].map((u) => new Request(u)); },
        async delete(req) { return c.delete(keyOf(req)); },
        async match(req) { return c.get(keyOf(req)) || undefined; },
      };
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(req) {
      for (const c of store.values()) { const hit = c.get(keyOf(req)); if (hit) return hit; }
      return undefined;
    },
  };
}

/** מרים מופע SW טרי ומחזיר שליטה עליו. */
function boot(opts = {}) {
  const listeners = new Map();
  const posted = [];
  const focused = [];
  const opened = [];
  const fetches = [];
  const shown = [];
  const wins = (opts.windows || []).map((url) => ({
    url, postMessage: (m) => posted.push({ url, m }), focus: async () => { focused.push(url); },
  }));

  const self_ = {
    location: { origin: ORIGIN, href: ORIGIN + '/sw.js' },
    addEventListener(type, fn) { listeners.set(type, fn); },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => wins,
      openWindow: async (u) => { opened.push(u); },
    },
    registration: {
      showNotification: async (title, o) => { shown.push({ title, ...(o || {}) }); },
    },
  };

  const caches_ = opts.caches || cacheStore();
  const fakeFetch = async (req, init) => {
    const url = typeof req === 'string' ? req : req.url;
    fetches.push({ url, init: init || (req && req.method ? { method: req.method } : null), body: init && init.body });
    if (opts.offline) throw new Error('רשת נפלה');
    return new Response('מהרשת: ' + url, { status: 200 });
  };

  new Function('self', 'caches', 'fetch', SRC)(self_, caches_, fakeFetch);

  const fire = async (type, ev) => {
    const fn = listeners.get(type);
    if (!fn) throw new Error('אין מאזין ל-' + type);
    const waits = [];
    let responded;
    const e = { ...ev, waitUntil: (p) => waits.push(p), respondWith: (p) => { responded = p; } };
    fn(e);
    await Promise.all(waits);
    return { responded: responded ? await responded : undefined, handled: responded !== undefined };
  };

  return { fire, caches: caches_, posted, focused, opened, fetches, shown, listeners };
}

// ---------------------------------------------------------------------------
t.section('התקנה ופינוי גרסאות');
{
  const sw = boot();
  await sw.fire('install', {});
  const names = await sw.caches.keys();
  t.eq('מטמון קליפה אחד', names.length, 1);
  t.ok('בשם עם גרסה', /shell-v\d+/.test(names[0]), names[0]);
  const c = await sw.caches.open(names[0]);
  t.eq('כל קבצי הקליפה', (await c.keys()).length, 5);

  // גרסה ישנה + תיבת השיתוף
  sw.caches.store.set('rtl-claude-shell-v1', new Map());
  sw.caches.store.set('rtl-claude-share', new Map([['x', new Response('ממתין')]]));
  await sw.fire('activate', {});
  const after = await sw.caches.keys();
  t.ok('הגרסה הישנה נמחקה', !after.includes('rtl-claude-shell-v1'), after);
  t.ok('תיבת השיתוף שרדה', after.includes('rtl-claude-share'), after);
  t.ok('הגרסה הנוכחית נשארה', after.some((n) => /shell-v\d+/.test(n)), after);
}

// ---------------------------------------------------------------------------
t.section('מה עובר דרך המטמון ומה לא');
{
  let sw = boot();
  await sw.fire('install', {});                          // כמו התקנה אמיתית
  t.eq('קריאת API לא נתפסת', (await sw.fire('fetch', { request: new Request(ORIGIN + '/api/store') })).handled, false);
  t.eq('מקור זר לא נתפס', (await sw.fire('fetch', { request: new Request('https://other.example/x') })).handled, false);
  t.eq('POST רגיל לא נתפס', (await sw.fire('fetch', { request: new Request(ORIGIN + '/api/upload', { method: 'POST', body: '{}' }) })).handled, false);

  const r = await sw.fire('fetch', { request: new Request(ORIGIN + '/app.js') });
  t.eq('קובץ קליפה נתפס', r.handled, true);
  t.eq('ומוגש מהרשת', await r.responded.text(), 'מהרשת: ' + ORIGIN + '/app.js');
  await new Promise((res) => setTimeout(res, 10));       // העתקה למטמון היא ברקע
  const c = await sw.caches.open((await sw.caches.keys())[0]);
  t.ok('ונשמר לרשת ביטחון', !!(await c.match(ORIGIN + '/app.js')));

  // אותו מטמון בדיוק, עכשיו בלי רשת
  const off = await boot({ offline: true, caches: sw.caches })
    .fire('fetch', { request: new Request(ORIGIN + '/app.js') });
  t.eq('בלי רשת מוגש מהמטמון', await off.responded.text(), 'מהרשת: ' + ORIGIN + '/app.js');

  // דף שלא במטמון כלל נופל ל-index.html, כדי שלא יקפוץ מסך ריק
  const miss = await boot({ offline: true, caches: sw.caches })
    .fire('fetch', { request: new Request(ORIGIN + '/?conv=xyz') });
  t.ok('ניווט ללא רשת מקבל את הקליפה', !!miss.responded, miss.responded);
}

// ---------------------------------------------------------------------------
t.section('שיתוף מאפליקציה אחרת');
{
  const sw = boot();
  const fd = new FormData();
  fd.set('title', 'כותרת');
  fd.set('text', 'הטקסט ששותף');
  fd.set('url', 'https://example.com/a');
  fd.append('files', new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
  fd.append('files', new File(['לא תמונה'], 'doc.txt', { type: 'text/plain' }));

  const res = (await sw.fire('fetch', { request: new Request(ORIGIN + '/share', { method: 'POST', body: fd }) })).responded;
  t.eq('מפנה לדף', res.status, 303);
  t.eq('עם סימון שיתוף', res.headers.get('location'), ORIGIN + '/?share=1');

  const box = await sw.caches.open('rtl-claude-share');
  const text = await (await box.match('/__share/text')).text();
  t.eq('כותרת, טקסט וקישור אחד מתחת לשני', text, 'כותרת\nהטקסט ששותף\nhttps://example.com/a');
  const keys = (await box.keys()).map((k) => new URL(k.url).pathname);
  t.ok('התמונה נשמרה', keys.includes('/__share/file/0'), keys);
  t.ok('קובץ שאינו תמונה לא נשמר', !keys.includes('/__share/file/1'), keys);

  // שיתוף חדש מוחק את הקודם
  const fd2 = new FormData();
  fd2.set('text', 'שיתוף שני');
  await sw.fire('fetch', { request: new Request(ORIGIN + '/share', { method: 'POST', body: fd2 }) });
  const box2 = await sw.caches.open('rtl-claude-share');
  const keys2 = (await box2.keys()).map((k) => new URL(k.url).pathname);
  t.eq('רק השיתוף האחרון בתיבה', keys2, ['/__share/text']);
  t.eq('והוא החדש', await (await box2.match('/__share/text')).text(), 'שיתוף שני');

  // POST בלי גוף תקין לא מפיל את ה-handler
  const bad = boot();
  const r = (await bad.fire('fetch', { request: new Request(ORIGIN + '/share', { method: 'POST', body: 'לא multipart', headers: { 'Content-Type': 'text/plain' } }) })).responded;
  t.eq('גוף שאינו טופס — חוזרים לדף', r.status, 303);
  t.eq('בלי סימון שיתוף', r.headers.get('location'), ORIGIN + '/');
}

// ---------------------------------------------------------------------------
t.section('מענה מתוך ההתראה (האפליקציה סגורה)');
{
  const sw = boot();
  let closed = false;
  await sw.fire('notificationclick', {
    action: 'allow',
    notification: { data: { convId: 'c1', requestId: 'r1' }, close: () => { closed = true; } },
  });
  t.ok('ההתראה נסגרה', closed);
  t.eq('נשלחה תשובה לשרת', sw.fetches.length, 1);
  t.eq('לנתיב הנכון', sw.fetches[0].url, '/api/permission-answer');
  t.eq('עם ההחלטה', JSON.parse(sw.fetches[0].body), { convId: 'c1', requestId: 'r1', decision: 'allow' });
  t.eq('בלי לפתוח את האפליקציה', sw.opened.length, 0);

  const deny = boot();
  await deny.fire('notificationclick', { action: 'deny', notification: { data: { convId: 'c1', requestId: 'r1' }, close() {} } });
  t.eq('דחייה נשלחת גם היא', JSON.parse(deny.fetches[0].body).decision, 'deny');

  // כפתור בלי הקשר — לא שולחים בקשה חסרה, פותחים את האפליקציה
  const partial = boot();
  await partial.fire('notificationclick', { action: 'allow', notification: { data: {}, close() {} } });
  t.eq('בלי מזהים אין בקשה', partial.fetches.length, 0);
  t.eq('ובמקום זה נפתח חלון', partial.opened.length, 1);

  // כשל רשת — התראה חוזרת במקום שתיקה
  const offline = boot({ offline: true });
  await offline.fire('notificationclick', {
    action: 'deny',
    notification: { data: { convId: 'c1', requestId: 'r9' }, close() {} },
  });
  t.eq('גם באופליין נשלחה בקשה (שנכשלה)', offline.fetches.length, 1);
  t.ok('התראת כשל מוצגת', offline.shown.some((n) => /לא הצלחנו/.test(n.title)));
}

t.section('לחיצה על גוף ההתראה');
{
  // חלון פתוח — מקבל פוקוס, בלי טאב חדש
  let sw = boot({ windows: [ORIGIN + '/', ORIGIN + '/?x=1'] });
  await sw.fire('notificationclick', { notification: { data: { url: '/' }, close() {} } });
  t.eq('אין טאב חדש', sw.opened.length, 0);
  t.eq('פוקוס לחלון אחד', sw.focused.length, 1);
  t.eq('אבל כל הטאבים מנוקים מהסימון', sw.posted.length, 2);

  // אין חלון פתוח — נפתח אחד
  sw = boot();
  await sw.fire('notificationclick', { notification: { data: { url: '/?conv=abc' }, close() {} } });
  t.eq('נפתח חלון', sw.opened, [ORIGIN + '/?conv=abc']);

  // כתובת זרה ב-data לא פותחת אתר חיצוני
  sw = boot();
  await sw.fire('notificationclick', { notification: { data: { url: 'https://evil.example/steal' }, close() {} } });
  t.eq('נשארים במקור שלנו', sw.opened, [ORIGIN + '/']);

  // כתובת מוזרה: לא קורסת, ובשום מקרה לא יוצאת מהמקור שלנו
  sw = boot();
  await sw.fire('notificationclick', { notification: { data: { url: '::::' }, close() {} } });
  t.eq('נפתח משהו אחד', sw.opened.length, 1);
  t.eq('ותמיד במקור שלנו', new URL(sw.opened[0]).origin, ORIGIN);
}

t.done();
