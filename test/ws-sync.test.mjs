/**
 * סנכרון בין מכשירים — שני חיבורי WebSocket אמיתיים אל שרת אמיתי.
 *
 * ההבטחה של "הטלפון אינו עותק אלא מסך נוסף על אותה שיחה" חיה כולה בפרוטוקול
 * הזה: ‎subscribe‎ → ‎sync‎, ואחריו ‎ui‎ / ‎presence‎ / ‎pong‎. אין כאן תור אמיתי
 * (הוא היה דורש את ה-CLI), ובכוונה — מה שנשבר בשטח הוא דווקא מה שמסביבו:
 * מכשיר שמקבל את ההד של עצמו, מונה מכשירים שלא יורד בניתוק, או ‎sync‎ שחוזר
 * בלי הכרטיסים הפתוחים.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = Number(process.env.SIM_WS_PORT || 4893);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-sim-ws-'));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// אזהרת Node על ביטול אימות התעודה היא נכונה — וגם צפויה כאן, כי התעודה
// המקומית חתומה-עצמית. משתיקים אותה כדי שדוח הבדיקה יישאר קריא.
const _warn = process.emitWarning;
process.emitWarning = (w, ...r) => { if (!String(w).includes('NODE_TLS_REJECT_UNAUTHORIZED')) _warn.call(process, w, ...r); };
const ROOT = new URL('..', import.meta.url).pathname;
const secure = fs.existsSync(path.join(ROOT, 'certs', 'cert.pem'));
const BASE = `${secure ? 'https' : 'http'}://127.0.0.1:${PORT}`;
const WSURL = `${secure ? 'wss' : 'ws'}://127.0.0.1:${PORT}`;

const t = runner('סנכרון בין מכשירים (WebSocket)');

const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, HOME, PORT: String(PORT), REMOTE_PORT: String(PORT + 1), OMNIROUTE_BASE_URL: '', LOCAL_BASE_URL: 'http://127.0.0.1:9999/v1', CCR_GATEWAY_URL: '', CURSOR_SESSION_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', (b) => { srvOut += b; });
srv.stderr.on('data', (b) => { srvOut += b; });
const cleanup = () => {
  try { process.kill(srv.pid); } catch {}
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);                     // רשת ביטחון אם הבדיקה נפלה

/** סגירה מסודרת: קודם ממתינים שהתהליך ימות, ורק אז מוחקים את הבית הזמני —
 *  אחרת הוא כותב את שורות היומן האחרונות שלו לתיקייה שהרגע נמחקה, ויוצר
 *  אותה מחדש. */
async function finish() {
  try { process.kill(srv.pid); } catch {}
  await Promise.race([
    new Promise((r) => srv.once('exit', r)),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  // השרת מריץ תהליכי עזר (למשל `cursor-agent --list-models`), והם עלולים
  // לכתוב לבית הזמני רגע אחרי שהוא מת. מחיקה שנייה סוגרת את הזנב הזה.
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
}

let up = false;
for (let k = 0; k < 100 && !up; k++) {
  try { up = (await fetch(BASE + '/api/store')).ok; } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
if (!up) { console.error('השרת לא עלה:\n' + srvOut); cleanup(); process.exit(1); }

/** מכשיר מדומה: חיבור, תיבת דואר, והמתנה להודעה לפי סוג. */
async function device(ua) {
  const ws = new WebSocket(WSURL, { headers: { 'User-Agent': ua }, rejectUnauthorized: false });
  const inbox = [];
  ws.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch {} });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return {
    ws, inbox, ua,
    send: (o) => ws.send(JSON.stringify(o)),
    /** ממתין להודעה מסוג מסוים (אחרי הנקודה שבה התחלנו לחכות). */
    async next(kind, ms = 2500) {
      const t0 = Date.now();
      for (;;) {
        const i = inbox.findIndex((m) => m.kind === kind);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() - t0 > ms) throw new Error('לא הגיע ' + kind + ' תוך ' + ms + 'ms');
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    has: (kind) => inbox.some((m) => m.kind === kind),
    clear: () => { inbox.length = 0; },
    close: () => new Promise((res) => { ws.on('close', res); ws.close(); }),
  };
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
t.section('מנוי ראשון — sync מלא');
{
  const a = await device('Mozilla/5.0 (Macintosh)');
  a.send({ type: 'subscribe', conversationId: 'wsconv1' });
  const sync = await a.next('sync');
  t.eq('השיחה הנכונה', sync.convId, 'wsconv1');
  t.eq('שיחה חדשה מתחילה ב-reset', sync.mode, 'reset');
  t.eq('אין תור רץ', sync.running, false);
  t.eq('אין כרטיסי הרשאה פתוחים', sync.perms, []);
  t.eq('אין תור המתנה', Array.isArray(sync.queue) ? sync.queue.length : sync.queue, 0);
  t.eq('אין הודעות מתוזמנות', Array.isArray(sync.schedules) ? sync.schedules.length : 0, 0);
  t.eq('אין מכסה שנגמרה', sync.limit, null);
  t.eq('אין דואט', sync.duet, null);

  const pres = await a.next('presence');
  t.eq('מכשיר אחד', pres.count, 1);
  t.eq('מזוהה לפי סוג', pres.devices, ['Mac']);
  t.eq('והוא הכותב לדיסק', pres.primary, true);

  a.send({ type: 'ping', t: 42 });
  const pong = await a.next('pong');
  t.eq('פינג חוזר עם החותמת', pong.t, 42);
  await a.close();
}

// ---------------------------------------------------------------------------
t.section('שני מכשירים על אותה שיחה');
{
  const mac = await device('Mozilla/5.0 (Macintosh)');
  mac.send({ type: 'subscribe', conversationId: 'wsconv2' });
  await mac.next('sync');
  await mac.next('presence');

  const phone = await device('Mozilla/5.0 (Linux; Android 14)');
  phone.send({ type: 'subscribe', conversationId: 'wsconv2' });
  await phone.next('sync');

  const p = await mac.next('presence');
  t.eq('המחשב יודע ששניים צופים', p.count, 2);
  t.eq('ורואה את הטלפון בשם', p.devices.includes('Android'), true);

  // ui עובר לצד השני בלבד
  mac.clear(); phone.clear();
  mac.send({ type: 'ui', field: 'draft', value: 'נכתב במחשב' });
  const ui = await phone.next('ui');
  t.eq('הטיוטה הגיעה לטלפון', ui.value, 'נכתב במחשב');
  t.eq('עם שם השולח', ui.by, 'Mac');
  t.eq('השיחה מסומנת', ui.convId, 'wsconv2');
  await settle();
  t.eq('והשולח לא קיבל הד של עצמו', mac.has('ui'), false);

  // גם בכיוון ההפוך, ולכל שדה
  phone.clear(); mac.clear();
  phone.send({ type: 'ui', field: 'model', value: 'cursor/auto' });
  const back = await mac.next('ui');
  t.eq('בורר המודל עבר לכיוון השני', [back.field, back.value], ['model', 'cursor/auto']);

  // ניתוק אחד — המונה יורד אצל השני
  mac.clear();
  await phone.close();
  const after = await mac.next('presence');
  t.eq('נשאר מכשיר אחד', after.count, 1);
  t.eq('והוא הכותב', after.primary, true);
  await mac.close();
}

// ---------------------------------------------------------------------------
t.section('קח שליטה ממכשיר משני');
{
  const mac = await device('Mozilla/5.0 (Macintosh)');
  mac.send({ type: 'subscribe', conversationId: 'wsconvClaim' });
  await mac.next('sync');
  await mac.next('presence');

  const phone = await device('Mozilla/5.0 (Linux; Android 14)');
  phone.send({ type: 'subscribe', conversationId: 'wsconvClaim' });
  await phone.next('sync');
  const phonePres = await phone.next('presence');
  t.eq('הטלפון נכנס כמשני', phonePres.primary, false);
  await mac.next('presence');

  mac.clear(); phone.clear();
  phone.send({ type: 'claim_primary' });
  const taken = await phone.next('presence');
  t.eq('הטלפון הפך לכותב', taken.primary, true);
  const demoted = await mac.next('presence');
  t.eq('והמחשב ירד לתצוגה', demoted.primary, false);
  t.eq('שניהם עדיין מחוברים', [taken.count, demoted.count], [2, 2]);

  await phone.close();
  await mac.close();
}

// ---------------------------------------------------------------------------
t.section('בידוד בין שיחות');
{
  const one = await device('Mozilla/5.0 (Macintosh)');
  const two = await device('Mozilla/5.0 (Windows NT)');
  one.send({ type: 'subscribe', conversationId: 'wsconvA' });
  two.send({ type: 'subscribe', conversationId: 'wsconvB' });
  await one.next('sync'); await two.next('sync');
  one.clear(); two.clear();

  one.send({ type: 'ui', field: 'draft', value: 'שייך ל-A' });
  await settle();
  t.eq('שיחה אחרת לא שומעת', two.has('ui'), false);

  // מעבר בין שיחות: מנוי חדש מחליף את הישן
  two.send({ type: 'subscribe', conversationId: 'wsconvA' });
  await two.next('sync');
  one.clear(); two.clear();
  one.send({ type: 'ui', field: 'draft', value: 'עכשיו כן' });
  const got = await two.next('ui');
  t.eq('אחרי המעבר כן שומעים', got.value, 'עכשיו כן');
  await one.close(); await two.close();
}

// ---------------------------------------------------------------------------
t.section('קלט שגוי לא מפיל את החיבור');
{
  const d = await device('Mozilla/5.0 (Macintosh)');
  d.ws.send('לא JSON בכלל');
  d.send({ type: 'ui', field: 'draft', value: 'לפני מנוי' });      // בלי subscribe
  d.send({ type: 'subscribe', conversationId: '../../etc/passwd' }); // מזהה פסול
  await settle();
  t.eq('החיבור עדיין פתוח', d.ws.readyState, 1);
  t.eq('ומזהה פסול לא יצר מנוי', d.has('sync'), false);

  d.send({ type: 'subscribe', conversationId: 'wsconvC' });
  t.eq('ומיד אחרי זה מנוי תקין עובד', (await d.next('sync')).convId, 'wsconvC');
  await d.close();
}

// ---------------------------------------------------------------------------
t.section('חיבור מחדש אחרי ניתוק');
{
  const d = await device('Mozilla/5.0 (Linux; Android 14)');
  d.send({ type: 'subscribe', conversationId: 'wsconvD' });
  const first = await d.next('sync');
  await d.close();

  const again = await device('Mozilla/5.0 (Linux; Android 14)');
  again.send({ type: 'subscribe', conversationId: 'wsconvD', sinceSeq: first.seq });
  const back = await again.next('sync');
  t.eq('אותה שיחה', back.convId, 'wsconvD');
  t.ok('ה-seq לא נסוג', back.seq >= first.seq, { first: first.seq, back: back.seq });
  const pres = await again.next('presence');
  t.eq('המכשיר הישן כבר לא נספר', pres.count, 1);
  await again.close();
}

// ---------------------------------------------------------------------------
t.section('הודעה מתוזמנת מסתנכרנת בין מכשירים');
{
  const mac = await device('Mozilla/5.0 (Macintosh)');
  mac.send({ type: 'subscribe', conversationId: 'wsconvSched' });
  await mac.next('sync');
  await mac.next('presence');

  const phone = await device('Mozilla/5.0 (Linux; Android 14)');
  phone.send({ type: 'subscribe', conversationId: 'wsconvSched' });
  await phone.next('sync');
  await phone.next('presence');
  await mac.next('presence');

  mac.clear(); phone.clear();
  const at = Date.now() + 60 * 60 * 1000;
  mac.send({
    type: 'schedule_add',
    text: 'בדוק את הלוגים',
    at,
    model: '',
    permissionMode: 'acceptEdits',
  });
  const listed = await mac.next('schedules');
  t.eq('המחשב רואה פריט אחד', listed.items.length, 1);
  t.eq('עם הטקסט', listed.items[0].text, 'בדוק את הלוגים');
  t.eq('ועם השעה', listed.items[0].at, at);
  const echoed = await phone.next('schedules');
  t.eq('גם הטלפון קיבל', echoed.items[0].text, 'בדוק את הלוגים');

  phone.clear(); mac.clear();
  phone.send({ type: 'schedule_remove', id: listed.items[0].id });
  const empty = await mac.next('schedules');
  t.eq('ביטול בטלפון מנקה במחשב', empty.items.length, 0);

  mac.clear();
  mac.send({ type: 'schedule_add', text: 'מאוחר מדי', at: Date.now() - 1000 });
  const err = await mac.next('toast');
  t.eq('שעה שעברה נדחית', err.err, true);
  t.ok('עם הסבר', /עברה|שעה/.test(err.text), err.text);

  await phone.close();
  await mac.close();
}

// ---------------------------------------------------------------------------
t.section('שידור קונפיג ומודלים חיים (Live Config Broadcast)');
{
  const client = await device('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  client.send({ type: 'subscribe', conversationId: 'wsconvLiveCfg' });
  await client.next('sync');
  await client.next('presence');
  client.clear();

  // נשנה הגדרות ספק מקומי ב-API כדי להפעיל שידור חי
  const https = require('node:https');
  const http = require('node:http');
  const agent = BASE.startsWith('https') ? new https.Agent({ rejectUnauthorized: false }) : undefined;
  const mod = BASE.startsWith('https') ? https : http;

  const putReq = mod.request(new URL('/api/local', BASE), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    agent,
  }, (res) => {
    res.resume();
  });
  putReq.write(JSON.stringify({ baseUrl: 'http://127.0.0.1:1234/v1', temperature: 0.7 }));
  putReq.end();

  const cfgMsg = await client.next('config', 3000);
  t.ok('הלקוח קיבל עדכון קונפיג ב-WebSocket', !!cfgMsg);
  t.ok('קונפיג כולל רשימת מודלים', Array.isArray(cfgMsg && cfgMsg.models));
  t.ok('קונפיג כולל סטטוס ספק מקומי', !!(cfgMsg && cfgMsg.local));

  await client.close();
}

t.section('סיכום');
await settle(200);
t.ok('אין שגיאות חריגות בשרת', !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(srvOut), srvOut.slice(-500));

await finish();
t.done();
