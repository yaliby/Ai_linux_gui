/**
 * דחיסת תשובות ה-API (`lib/api-compress.js`).
 *   node test/api-compress.test.mjs
 *
 * השכבה הזאת עוטפת את ‎res.json‎ ו-‎res.send‎ — כלומר נוגעת בכל תשובה שהשרת
 * מחזיר. לכן מה שנבדק כאן אינו יחס הדחיסה אלא שהעטיפה לא שברה כלום:
 *
 *   • הגוף מפוענח בחזרה לאותו JSON בדיוק, כולל עברית ותווים מיוחדים.
 *   • קוד הסטטוס, כותרות שהמסלול הוסיף, ו-‎res.send‎ של טקסט — כולם שורדים.
 *   • תשובה קטנה עוברת במסלול הרגיל ולא נדחסת.
 *   • ‎ETag‎ שונה לכל קידוד, ו-‎304‎ אינו נושא גוף.
 *   • תשובה ריקה, ‎204‎, ומבנה מעגלי שלא ניתן לסריאליזציה — לא מפילים דבר.
 *
 * הרקע למספרים: השיחה הגדולה במכונה שעליה נכתב זה היא גוף של 887KB שיורד
 * ל-73KB, ו-‎/api/config‎ הוא 66KB שיורדים ל-6KB.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import zlib from 'node:zlib';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const createApiCompress = require('../lib/api-compress.js');

const t = runner('דחיסת תשובות ה-API');

/* גוף גדול וחוזרני, כמו שיחה אמיתית */
const BIG = {
  ok: true,
  conversation: {
    id: 'c1', title: 'שיחה עם כותרת בעברית · ותווים מיוחדים "\\" \n\t',
    messages: Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      text: 'שורה של טקסט עברי שחוזר על עצמו ' + i,
      blocks: [{ type: 'tool', name: 'Bash', result: 'פלט '.repeat(40) }],
    })),
  },
};
const SMALL = { ok: true, n: 1 };

const app = express();
app.use('/api', createApiCompress());
app.get('/api/big', (req, res) => res.json(BIG));
app.get('/api/small', (req, res) => res.json(SMALL));
app.get('/api/text', (req, res) => res.type('text/plain; charset=utf-8').send('שורת יומן\n'.repeat(400)));
app.get('/api/status', (req, res) => res.status(418).json(BIG));
app.get('/api/headers', (req, res) => { res.set('X-Sol', 'shalom'); res.json(BIG); });
app.get('/api/empty', (req, res) => res.status(204).end());
app.get('/api/circular', (req, res) => { const o = { a: 1 }; o.self = o; try { res.json(o); } catch { res.status(500).end(); } });
app.get('/api/buffer', (req, res) => res.type('application/octet-stream').send(Buffer.alloc(9000, 65)));
// מחוץ ל-‎/api‎ השכבה לא מותקנת בכלל
app.get('/plain', (req, res) => res.json(BIG));

const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = srv.address().port;

function raw(pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const decode = (r) => {
  const e = r.headers['content-encoding'];
  if (e === 'br') return zlib.brotliDecompressSync(r.body);
  if (e === 'gzip') return zlib.gunzipSync(r.body);
  return r.body;
};

// ---------------------------------------------------------------------------
t.section('הגוף מגיע שלם');
{
  const br = await raw('/api/big', { headers: { 'Accept-Encoding': 'br, gzip' } });
  t.eq('נדחס ב-brotli', br.headers['content-encoding'], 'br');
  t.eq('סוג התוכן נכון', br.headers['content-type'], 'application/json; charset=utf-8');
  t.eq('Content-Length תואם לגוף', Number(br.headers['content-length']), br.body.length);
  t.eq('Vary', br.headers['vary'], 'Accept-Encoding');
  // התאמה מלאה ולא רק "נראה דומה" — כולל העברית והתווים המיוחדים שבכותרת
  t.eq('מפוענח לאותו אובייקט בדיוק', JSON.parse(decode(br).toString('utf8')), BIG);
  t.ok('והוא באמת קטן יותר', br.body.length < Buffer.byteLength(JSON.stringify(BIG)) / 4, br.body.length);

  const gz = await raw('/api/big', { headers: { 'Accept-Encoding': 'gzip' } });
  t.eq('gzip כשזה מה שיש', gz.headers['content-encoding'], 'gzip');
  t.eq('ואותו תוכן', JSON.parse(decode(gz).toString('utf8')), BIG);

  const id = await raw('/api/big', { headers: { 'Accept-Encoding': 'identity' } });
  t.eq('בלי קידוד — בלי דחיסה', id.headers['content-encoding'], undefined);
  t.eq('והגוף עדיין נכון', JSON.parse(id.body.toString('utf8')), BIG);
  t.eq('אבל עם Vary', id.headers['vary'], 'Accept-Encoding');
}

// ---------------------------------------------------------------------------
t.section('מה שלא נדחס');
{
  const s = await raw('/api/small', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('תשובה קטנה עוברת כרגיל', s.headers['content-encoding'], undefined);
  t.eq('ותוכנה נכון', JSON.parse(s.body.toString('utf8')), SMALL);
  // המסלול הרגיל של express — כולל ה-ETag שהוא מייצר בעצמו
  t.ok('ויש לה ETag משלה', !!s.headers['etag'], s.headers['etag']);

  const out = await raw('/plain', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('מחוץ ל-/api השכבה לא פועלת', out.headers['content-encoding'], undefined);
  t.eq('אין שם אפילו Vary', out.headers['vary'], undefined);
}

// ---------------------------------------------------------------------------
/* עטיפה של ‎res.json‎ היא הזדמנות מצוינת לאבד סטטוס או כותרת שהמסלול הוסיף. */
t.section('מה שהמסלול קבע נשמר');
{
  const st = await raw('/api/status', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('קוד הסטטוס שרד', st.status, 418);
  t.eq('והגוף נדחס', st.headers['content-encoding'], 'br');
  t.eq('ותוכנו נכון', JSON.parse(decode(st).toString('utf8')).ok, true);

  const h = await raw('/api/headers', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('כותרת מותאמת שרדה', h.headers['x-sol'], 'shalom');
  t.eq('לצד הדחיסה', h.headers['content-encoding'], 'br');
}

// ---------------------------------------------------------------------------
t.section('res.send של טקסט וגוף בינארי');
{
  const txt = await raw('/api/text', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('טקסט נדחס גם הוא', txt.headers['content-encoding'], 'br');
  t.eq('סוג התוכן נשמר', txt.headers['content-type'], 'text/plain; charset=utf-8');
  t.eq('והטקסט זהה', decode(txt).toString('utf8'), 'שורת יומן\n'.repeat(400));

  const buf = await raw('/api/buffer', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('Buffer נדחס', buf.headers['content-encoding'], 'br');
  t.eq('ותוכנו זהה', decode(buf).length, 9000);
  t.eq('וסוגו נשמר', buf.headers['content-type'], 'application/octet-stream');
}

// ---------------------------------------------------------------------------
t.section('אימות מטמון');
{
  const a = await raw('/api/big', { headers: { 'Accept-Encoding': 'br' } });
  const etBr = a.headers['etag'];
  t.ok('יש ETag', !!etBr, etBr);
  t.eq('ועם no-cache', a.headers['cache-control'], 'no-cache');

  const same = await raw('/api/big', { headers: { 'Accept-Encoding': 'br', 'If-None-Match': etBr } });
  t.eq('אותו ETag → 304', same.status, 304);
  t.eq('ובלי גוף', same.body.length, 0);
  t.eq('ובלי Content-Encoding', same.headers['content-encoding'], undefined);

  // שני קידודים הם שני ייצוגים — ‎ETag‎ משותף היה גורם לדפדפן לפענח לא נכון
  const g = await raw('/api/big', { headers: { 'Accept-Encoding': 'gzip' } });
  t.ok('ETag של gzip שונה', g.headers['etag'] !== etBr, [etBr, g.headers['etag']]);

  const cross = await raw('/api/big', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etBr } });
  t.eq('ETag של brotli לא מזכה ב-304 על gzip', cross.status, 200);
  t.eq('אלא בגוף gzip מלא', cross.headers['content-encoding'], 'gzip');
}

// ---------------------------------------------------------------------------
/* השכבה יושבת על *כל* תשובת API, ולכן מקרה קצה שמפיל אותה מפיל את השרת. */
t.section('מקרי קצה לא מפילים');
{
  const e = await raw('/api/empty', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('204 נשאר 204', e.status, 204);
  t.eq('ובלי גוף', e.body.length, 0);

  const c = await raw('/api/circular', { headers: { 'Accept-Encoding': 'br' } });
  t.ok('מבנה מעגלי לא תלה את החיבור', c.status >= 200, c.status);

  const head = await raw('/api/big', { headers: { 'Accept-Encoding': 'br' }, method: 'HEAD' });
  t.eq('HEAD — 200', head.status, 200);
  t.eq('HEAD — בלי גוף', head.body.length, 0);

  // ובקשה רגילה מיד אחרי כל אלה עדיין עובדת
  const after = await raw('/api/big', { headers: { 'Accept-Encoding': 'br' } });
  t.eq('והשרת ממשיך לעבוד', JSON.parse(decode(after).toString('utf8')).ok, true);
}

srv.close();
t.done();
