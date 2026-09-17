/**
 * שכבת הדחיסה של הנכסים הסטטיים (`lib/static-compress.js`).
 *   node test/static-compress.test.mjs
 *
 * הדחיסה יושבת *לפני* ‎express.static‎ ומחליפה את גוף התשובה. לכן מה שנבדק
 * כאן אינו יחס הדחיסה אלא מה שעלול להישבר בגללה:
 *
 *   • הגוף מפוענח בחזרה בדיוק לקובץ המקורי — בשני הקידודים.
 *   • מי שלא ביקש קידוד מקבל את הקובץ כמות שהוא.
 *   • הבקשה שגרמה למחדל אינה ממתינה לדחיסה, אלא נופלת ל-‎express.static‎.
 *   • ‎ETag‎ של גרסה דחוסה שונה מזה של הלא-דחוסה, ו-‎304‎ לא נושא גוף.
 *   • ‎mtime‎ שהשתנה פוסל את המטמון — אחרת עריכת ‎app.js‎ לא הייתה נראית.
 *   • ‎..‎ בנתיב לא יוצא מהשורש.
 *
 * הכול מול תיקייה זמנית ושרת על פורט אקראי. אין נגיעה ב-‎public/‎ האמיתי.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const createStaticCompress = require('../lib/static-compress.js');
const { pickEncoding, acceptedEncodings, brotliQuality } = createStaticCompress;

const t = runner('דחיסת נכסים סטטיים');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-sc-'));
const VENDOR = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-sc-v-'));
process.on('exit', () => {
  for (const d of [DIR, VENDOR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// טקסט שנדחס היטב, גדול בהרבה מ-MIN_SIZE
const BIG = ('שורה של טקסט עברי שחוזר על עצמו כדי שהדחיסה תהיה משמעותית.\n').repeat(400);
const SMALL = 'קטן';
fs.writeFileSync(path.join(DIR, 'app.js'), BIG);
fs.writeFileSync(path.join(DIR, 'style.css'), BIG);
fs.writeFileSync(path.join(DIR, 'index.html'), BIG);
fs.writeFileSync(path.join(DIR, 'tiny.css'), SMALL);
fs.writeFileSync(path.join(DIR, 'photo.png'), Buffer.alloc(4000, 7));
fs.mkdirSync(path.join(DIR, 'sub'));
fs.writeFileSync(path.join(DIR, 'sub', 'deep.js'), BIG);
fs.writeFileSync(path.join(VENDOR, 'lib.js'), BIG);
fs.writeFileSync(path.join(os.tmpdir(), 'rtl-sc-outside.js'), 'סוד');

const mounts = [
  { prefix: '/', dir: DIR },
  { prefix: '/vendor/x', dir: VENDOR },
];
const mw = createStaticCompress({ mounts });
const app = express();
app.use(mw);
for (const m of mounts) (m.prefix === '/' ? app.use(express.static(m.dir)) : app.use(m.prefix, express.static(m.dir)));

const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = srv.address().port;

/** בקשה גולמית — ‎fetch‎ מפענח קידודים מעצמו ומסתיר בדיוק את מה שנבדק כאן. */
function raw(pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** מבקש עד שהתשובה מגיעה דחוסה — הדחיסה א־סינכרונית בכוונה. */
async function untilCompressed(pathname, enc, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await raw(pathname, { headers: { 'Accept-Encoding': enc } });
    if (last.headers['content-encoding']) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  return last;
}

// ---------------------------------------------------------------------------
t.section('בחירת הקידוד מ-Accept-Encoding');
{
  t.eq('brotli מנצח gzip', pickEncoding('gzip, deflate, br'), 'br');
  t.eq('רק gzip', pickEncoding('gzip, deflate'), 'gzip');
  t.eq('אין כותרת', pickEncoding(undefined), null);
  t.eq('אין קידוד מוכר', pickEncoding('deflate, zstd'), null);
  t.eq('כוכבית נחשבת', pickEncoding('*'), 'br');
  // ‎q=0‎ הוא סירוב מפורש, לא חולשה. דפדפן ששולח ‎br;q=0‎ לא יידע לפענח brotli.
  t.eq('br;q=0 נשלל', pickEncoding('br;q=0, gzip'), 'gzip');
  t.eq('שניהם נשללו', pickEncoding('br;q=0, gzip;q=0'), null);
  t.eq('העדפה מפורשת ל-gzip', pickEncoding('br;q=0.5, gzip;q=1.0'), 'gzip');
  t.eq('רווחים ואותיות גדולות', pickEncoding('  GZIP ;  Q=0.9 '), 'gzip');

  t.eq('קטן → איכות 11', brotliQuality(100 * 1024), 11);
  t.eq('בינוני → 9', brotliQuality(1024 * 1024), 9);
  t.eq('ענק → 5', brotliQuality(9 * 1024 * 1024), 5);

  // הרשימה המסודרת היא מה שמאפשר להגיש gzip כשה-brotli עוד נדחס
  t.eq('סדר מלא', acceptedEncodings('gzip, deflate, br'), ['br', 'gzip']);
  t.eq('העדפה מפורשת הופכת את הסדר', acceptedEncodings('br;q=0.5, gzip'), ['gzip', 'br']);
  t.eq('רק אחד', acceptedEncodings('gzip'), ['gzip']);
  t.eq('כלום', acceptedEncodings('deflate'), []);
}

// ---------------------------------------------------------------------------
/* brotli באיכות 11 על ‎app.js‎ לוקח 650ms, ו-gzip 13ms. בלי נפילה לקידוד
   הפחות-מועדף, טעינה ראשונה אחרי הפעלת השרת הייתה מקבלת את הקובץ לא דחוס
   בכלל — וזה בדיוק הרגע שאחרי עדכון, כשהקליפה נטענת מחדש ממילא. */
t.section('מגישים את הטוב ביותר שכבר קיים');
{
  fs.writeFileSync(path.join(DIR, 'both.js'), BIG);
  const only = createStaticCompress({ mounts: [{ prefix: '/', dir: DIR }] });
  const meta = only._internal.resolveFile('/both.js');

  // מזינים ידנית *רק* את ה-gzip, כמו בחלון שבו brotli עדיין רץ
  const gzBody = zlib.gzipSync(fs.readFileSync(meta.file), { level: 9 });
  only._internal.cache.set(meta.file + '\0gzip', {
    body: gzBody, enc: 'gzip', type: 'application/javascript; charset=UTF-8',
    size: meta.size, mtimeMs: meta.mtimeMs,
    etag: `W/"${meta.size.toString(16)}-${Math.floor(meta.mtimeMs).toString(16)}-gzip"`,
    atime: Date.now(),
  });

  const app2 = express();
  app2.use(only);
  app2.use(express.static(DIR));
  const s2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
  const p2 = s2.address().port;
  const get = (hdrs) => new Promise((res) => {
    http.get({ host: '127.0.0.1', port: p2, path: '/both.js', headers: hdrs }, (r) => {
      const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res({ headers: r.headers, body: Buffer.concat(c) }));
    });
  });

  const r = await get({ 'Accept-Encoding': 'br, gzip' });
  t.eq('ביקש brotli וקיבל gzip', r.headers['content-encoding'], 'gzip');
  t.ok('והגוף תקין', zlib.gunzipSync(r.body).equals(fs.readFileSync(meta.file)));
  t.ok('וה-ETag מסמן gzip', r.headers['etag'].endsWith('-gzip"'), r.headers['etag']);

  // ובינתיים brotli נדחס ברקע, ולכן הבקשה הבאה כבר מקבלת אותו
  for (let i = 0; i < 80 && !only._internal.cache.has(meta.file + '\0br'); i++) {
    await new Promise((r2) => setTimeout(r2, 25));
  }
  const r2 = await get({ 'Accept-Encoding': 'br, gzip' });
  t.eq('ומיד אחר כך brotli', r2.headers['content-encoding'], 'br');
  t.ok('קטן יותר מה-gzip', r2.body.length < gzBody.length, [r2.body.length, gzBody.length]);
  t.ok('והגוף עדיין תקין', zlib.brotliDecompressSync(r2.body).equals(fs.readFileSync(meta.file)));

  s2.close();
}

// ---------------------------------------------------------------------------
/* הדבר היחיד שהדחיסה מבטיחה: מה שהלקוח מפענח זהה בדיוק לקובץ. */
t.section('הגוף מפוענח בחזרה לקובץ המקורי');
{
  const want = fs.readFileSync(path.join(DIR, 'app.js'));

  const br = await untilCompressed('/app.js', 'br');
  t.eq('brotli — Content-Encoding', br.headers['content-encoding'], 'br');
  t.ok('brotli — הגוף באמת קטן יותר', br.body.length < want.length / 2, [br.body.length, want.length]);
  t.ok('brotli — מפוענח זהה', zlib.brotliDecompressSync(br.body).equals(want));
  t.eq('brotli — Content-Length תואם לגוף', Number(br.headers['content-length']), br.body.length);
  t.eq('brotli — Vary', br.headers['vary'], 'Accept-Encoding');
  t.eq('brotli — סוג התוכן נשמר', br.headers['content-type'], 'application/javascript; charset=UTF-8');

  const gz = await untilCompressed('/style.css', 'gzip');
  t.eq('gzip — Content-Encoding', gz.headers['content-encoding'], 'gzip');
  t.ok('gzip — מפוענח זהה', zlib.gunzipSync(gz.body).equals(fs.readFileSync(path.join(DIR, 'style.css'))));
  t.eq('gzip — סוג התוכן נשמר', gz.headers['content-type'], 'text/css; charset=UTF-8');

  const deep = await untilCompressed('/sub/deep.js', 'br');
  t.eq('תת-תיקייה נדחסת גם היא', deep.headers['content-encoding'], 'br');

  const vend = await untilCompressed('/vendor/x/lib.js', 'br');
  t.eq('שורש ממופה נדחס גם הוא', vend.headers['content-encoding'], 'br');
  t.ok('ותוכנו נכון', zlib.brotliDecompressSync(vend.body).equals(fs.readFileSync(path.join(VENDOR, 'lib.js'))));
}

// ---------------------------------------------------------------------------
t.section('מה שלא אמור להידחס');
{
  const plain = await raw('/app.js', { headers: { 'Accept-Encoding': 'identity' } });
  t.eq('בלי Accept-Encoding מתאים — 200 רגיל', plain.status, 200);
  t.eq('ובלי Content-Encoding', plain.headers['content-encoding'], undefined);
  t.ok('והגוף הוא הקובץ עצמו', plain.body.equals(fs.readFileSync(path.join(DIR, 'app.js'))));
  // גם כאן חייב ‎Vary‎: בלעדיו מטמון משותף יגיש את הגרסה הזאת למי שכן מפענח.
  t.eq('אבל עם Vary', plain.headers['vary'], 'Accept-Encoding');

  const tiny = await untilCompressed('/tiny.css', 'br', 6);
  t.eq('קובץ מתחת ל-MTU לא נדחס', tiny.headers['content-encoding'], undefined);
  t.eq('ומוגש כרגיל', tiny.body.toString(), SMALL);

  const png = await untilCompressed('/photo.png', 'br', 6);
  t.eq('PNG לא נכנס לרשימה', png.headers['content-encoding'], undefined);
  t.eq('ומוגש שלם', png.body.length, 4000);

  // ‎Range‎ על גוף דחוס הוא מלכודת נכונות — מוותרים עליו במכוון.
  const rng = await raw('/app.js', { headers: { 'Accept-Encoding': 'br', Range: 'bytes=0-99' } });
  t.eq('Range עוקף את הדחיסה', rng.status, 206);
  t.eq('ואינו דחוס', rng.headers['content-encoding'], undefined);
  t.eq('ומחזיר בדיוק את הטווח', rng.body.length, 100);
}

// ---------------------------------------------------------------------------
/* ההבטחה שבזכותה הדחיסה לא עולה בהשהיה: הבקשה שגילתה שאין גרסה דחוסה
   מקבלת את הקובץ מיד, ולא ממתינה ל-brotli באיכות 11. */
t.section('הבקשה הראשונה אינה ממתינה לדחיסה');
{
  fs.writeFileSync(path.join(DIR, 'fresh.js'), BIG);
  const t0 = Date.now();
  const first = await raw('/fresh.js', { headers: { 'Accept-Encoding': 'br' } });
  const took = Date.now() - t0;
  t.eq('נענתה מיד', first.status, 200);
  t.eq('בלי דחיסה', first.headers['content-encoding'], undefined);
  t.ok('ובזמן קצר', took < 300, took);

  const later = await untilCompressed('/fresh.js', 'br');
  t.eq('והבאה כן דחוסה', later.headers['content-encoding'], 'br');
}

// ---------------------------------------------------------------------------
t.section('אימות מטמון: ETag ו-304');
{
  const hit = await untilCompressed('/index.html', 'br');
  const etag = hit.headers['etag'];
  t.ok('יש ETag', !!etag, etag);
  t.ok('והוא מסמן את הקידוד', etag.endsWith('-br"'), etag);

  const plain = await raw('/index.html', { headers: { 'Accept-Encoding': 'identity' } });
  t.ok('ETag שונה מזה של הלא-דחוס', plain.headers['etag'] !== etag, [plain.headers['etag'], etag]);

  const nm = await raw('/index.html', { headers: { 'Accept-Encoding': 'br', 'If-None-Match': etag } });
  t.eq('אותו ETag → 304', nm.status, 304);
  t.eq('ו-304 בלי גוף', nm.body.length, 0);
  // ‎304‎ מתאר "מה שיש לך תקף", ולא ייצוג חדש — אסור לו לטעון על קידוד.
  t.eq('ובלי Content-Encoding', nm.headers['content-encoding'], undefined);

  const other = await raw('/index.html', { headers: { 'Accept-Encoding': 'br', 'If-None-Match': 'W/"something-else"' } });
  t.eq('ETag אחר → 200 מלא', other.status, 200);
  t.eq('ודחוס', other.headers['content-encoding'], 'br');

  const head = await raw('/index.html', { headers: { 'Accept-Encoding': 'br' }, method: 'HEAD' });
  t.eq('HEAD — 200', head.status, 200);
  t.eq('HEAD — בלי גוף', head.body.length, 0);
  t.eq('HEAD — אורך של הגרסה הדחוסה', Number(head.headers['content-length']), hit.body.length);
}

// ---------------------------------------------------------------------------
/* בלי זה עריכת ‎app.js‎ בזמן פיתוח הייתה מגישה לנצח את הגרסה שנדחסה בהפעלה. */
t.section('שינוי בקובץ פוסל את המטמון');
{
  const before = await untilCompressed('/style.css', 'br');
  const wasEtag = before.headers['etag'];
  t.ok('נדחס', !!wasEtag, wasEtag);

  const NEW = BIG + '\n/* גרסה חדשה לגמרי */\n'.repeat(50);
  fs.writeFileSync(path.join(DIR, 'style.css'), NEW);
  // ‎mtime‎ בקנה מידה של מילישניות — דוחפים אותו קדימה כדי שהשינוי ייראה גם
  // כשהכתיבה קרתה באותה מילישנייה.
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(DIR, 'style.css'), future, future);

  // המטמון נפסל, ולכן הבקשה נופלת ל-‎express.static‎ — שמחזיר ETag משלו.
  // מה שאסור הוא שהגרסה הדחוסה הישנה תוגש.
  const mid = await raw('/style.css', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('מיד אחרי השינוי — בלי הגרסה הדחוסה הישנה', mid.headers['content-encoding'], undefined);
  t.ok('וגם לא ה-ETag שלה', mid.headers['etag'] !== wasEtag, mid.headers['etag']);
  t.ok('אלא הקובץ החדש כמות שהוא', mid.body.toString() === NEW, mid.body.length);

  const after = await untilCompressed('/style.css', 'br');
  t.ok('ואז נדחס מחדש', after.headers['content-encoding'] === 'br');
  t.ok('עם ETag חדש', after.headers['etag'] !== wasEtag, [wasEtag, after.headers['etag']]);
  t.ok('והתוכן הוא החדש', zlib.brotliDecompressSync(after.body).toString() === NEW);

  const stale = await raw('/style.css', { headers: { 'Accept-Encoding': 'br', 'If-None-Match': wasEtag } });
  t.eq('ETag ישן כבר לא מזכה ב-304', stale.status, 200);
}

// ---------------------------------------------------------------------------
t.section('נתיבים לא יוצאים מהשורש');
{
  const esc = mw._internal.resolveFile('/../rtl-sc-outside.js');
  t.eq('‎..‎ נחסם', esc, null);
  t.eq('‎..‎ מקודד נחסם גם הוא', mw._internal.resolveFile('/%2e%2e/rtl-sc-outside.js'), null);
  t.eq('בייט אפס נחסם', mw._internal.resolveFile('/app.js\0.png'), null);
  t.eq('אחוז פסול לא מפיל', mw._internal.resolveFile('/%zz.js'), null);
  t.eq('קובץ שאינו קיים', mw._internal.resolveFile('/אין-כזה.js'), null);
  t.eq('תיקייה אינה קובץ', mw._internal.resolveFile('/sub'), null);
  t.ok('קובץ תקין כן נפתר', !!mw._internal.resolveFile('/app.js'));
  // ‎/‎ לבדו הוא ‎index.html‎, כמו ב-‎express.static‎
  t.ok('שורש → index.html', (mw._internal.resolveFile('/') || {}).file.endsWith('index.html'));
}

// ---------------------------------------------------------------------------
t.section('סיכום');
{
  const s = mw.stats();
  t.ok('נדחסו קבצים', s.compressed > 0, s);
  t.ok('והמטמון חסך בפועל', s.bytesOut < s.bytesIn / 2, s);
  t.ok('והוא תופס זיכרון סביר', s.bytes < 5 * 1024 * 1024, s.bytes);
}

srv.close();
t.done();
