/**
 * גבולות התור מול ה-CLI — שרת אמיתי, ‎claude‎ מדומה ב-PATH.
 *
 * שתי תקלות מהשטח, ושתיהן נראו אותו דבר מבחוץ ("המודל לא עונה"):
 *  - משימת רקע שהסתיימה משאירה ב-CLI task-notification בתור. הוא מטפל בה לפני
 *    ההודעה שלנו, עם result משלה, והשרת סגר עליו את התור בזמן שהמודל עוד עבד.
 *  - תיקייה על כונן תקוע: ה-git status שה-CLI מריץ לפני כל בקשה לא חוזר, וההודעה
 *    לא יוצאת לעולם. הסימן לשתיהן הוא ה-replay של ההודעה שלנו.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = Number(process.env.SIM_CLI_PORT || 4897);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-sim-cli-'));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const _warn = process.emitWarning;
process.emitWarning = (w, ...r) => { if (!String(w).includes('NODE_TLS_REJECT_UNAUTHORIZED')) _warn.call(process, w, ...r); };
const ROOT = new URL('..', import.meta.url).pathname;
const secure = fs.existsSync(path.join(ROOT, 'certs', 'cert.pem'));
const BASE = `${secure ? 'https' : 'http'}://127.0.0.1:${PORT}`;
const WSURL = `${secure ? 'wss' : 'ws'}://127.0.0.1:${PORT}`;

// ה-CLI המדומה: מתנהג לפי טקסט ההודעה, כדי שכל תרחיש יהיה הודעה אחת.
const BIN = path.join(HOME, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (!args.includes('stream-json')) process.exit(0);
const sid = 'fake-' + process.pid;
const gitOff = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS === '1';
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\\n');
const result = (n, extra) => out({ type: 'result', subtype: 'success', is_error: false, num_turns: n, result: '', ...extra });
function reply(text) {
  out({ type: 'user', isReplay: true, message: { role: 'user', content: text } });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo:' + text + (gitOff ? ' [nogit]' : '') }] } });
  result(1);
}
out({ type: 'system', subtype: 'init', cwd: process.cwd() });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.type !== 'user') continue;
    const text = typeof m.message.content === 'string' ? m.message.content : '';
    out({ type: 'system', subtype: 'status', status: 'requesting' });
    if (text === 'hang' && !gitOff) continue;            // git status על כונן תקוע
    if (text.startsWith('/')) { result(0, { result: 'local' }); continue; }  // פקודה מקומית: בלי replay
    if (text === 'early') { result(0); setTimeout(() => reply(text), 400); continue; }
    if (text === 'orphan') { result(0); continue; }      // ה-replay לא מגיע לעולם
    reply(text);
  }
});
`, { mode: 0o755 });

const t = runner('גבולות התור מול ה-CLI');

const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env, HOME, PATH: BIN + path.delimiter + process.env.PATH,
    PORT: String(PORT), REMOTE_PORT: String(PORT + 1),
    OMNIROUTE_BASE_URL: '', LOCAL_BASE_URL: 'http://127.0.0.1:9999/v1', CCR_GATEWAY_URL: '', CURSOR_SESSION_TOKEN: '',
    RTL_STALL_MS: '1500', RTL_FOREIGN_RESULT_MS: '1200',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', (b) => { srvOut += b; });
srv.stderr.on('data', (b) => { srvOut += b; });
const cleanup = () => {
  try { process.kill(srv.pid); } catch {}
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
async function finish() {
  try { process.kill(srv.pid); } catch {}
  await Promise.race([new Promise((r) => srv.once('exit', r)), new Promise((r) => setTimeout(r, 2000))]);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
}

let up = false;
for (let k = 0; k < 100 && !up; k++) {
  try { up = (await fetch(BASE + '/api/store')).ok; } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
if (!up) { console.error('השרת לא עלה:\n' + srvOut); cleanup(); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** שיחה אחת: מנוי, שליחה, ואיסוף הפריימים עד שהתור נסגר. */
async function conversation(id, cwd) {
  const ws = new WebSocket(WSURL, { rejectUnauthorized: false });
  const inbox = [];
  ws.on('message', (raw) => { try { inbox.push({ at: Date.now(), m: JSON.parse(raw.toString()) }); } catch {} });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'subscribe', conversationId: id }));
  for (let k = 0; k < 50 && !inbox.some((x) => x.m.kind === 'sync'); k++) await sleep(20);
  return {
    inbox,
    /** שולח ומחזיר את כל מה שהגיע עד busy:false (או עד שנגמר הזמן). */
    async turn(text, ms = 6000) {
      inbox.length = 0;
      const t0 = Date.now();
      ws.send(JSON.stringify({ type: 'user', text, cwd }));
      for (;;) {
        const end = inbox.find((x) => x.m.kind === 'busy' && x.m.running === false);
        if (end) break;
        if (Date.now() - t0 > ms) break;
        await sleep(20);
      }
      await sleep(100);
      const evts = inbox.filter((x) => x.m.kind === 'event').map((x) => x.m.evt);
      const end = inbox.find((x) => x.m.kind === 'busy' && x.m.running === false);
      return {
        ms: end ? end.at - t0 : null,
        results: evts.filter((e) => e.type === 'result').length,
        text: evts.filter((e) => e.type === 'assistant').map((e) => e.message.content[0].text).join('|'),
        toasts: inbox.filter((x) => x.m.kind === 'toast').map((x) => x.m.text),
        halts: inbox.filter((x) => x.m.kind === 'halt' || (x.m.kind === 'event' && x.m.evt.type === 'halt')).length,
      };
    },
    close: () => new Promise((res) => { ws.on('close', res); ws.close(); }),
  };
}

const okDir = fs.mkdtempSync(path.join(HOME, 'ok-'));
const stuckDir = fs.mkdtempSync(path.join(HOME, 'stuck-'));

// ---------------------------------------------------------------------------
t.section('תור רגיל');
{
  const c = await conversation('cliturn1', okDir);
  const r = await c.turn('hello');
  t.eq('התשובה הגיעה', r.text, 'echo:hello');
  t.eq('result אחד ללקוח', r.results, 1);
  t.ok('נסגר מיד', r.ms != null && r.ms < 1000, r.ms);

  t.section('פקודת סלאש מקומית — result בלי replay');
  const s = await c.turn('/cost');
  t.eq('result אחד', s.results, 1);
  t.ok('נסגר מיד, בלי לחכות ל-replay', s.ms != null && s.ms < 800, s.ms);

  t.section('result של task-notification לפני ההודעה שלנו');
  const e = await c.turn('early');
  t.eq('התשובה האמיתית הגיעה בתוך התור', e.text, 'echo:early');
  t.eq('ה-result הזר לא הועבר ללקוח', e.results, 1);
  t.ok('התור נסגר רק אחרי התשובה', e.ms != null && e.ms >= 350, e.ms);

  t.section('result זר שאחריו שקט — נסגר בכל זאת');
  const o = await c.turn('orphan');
  t.eq('result אחד בסוף', o.results, 1);
  t.ok('נסגר אחרי ההמתנה ולא נתקע', o.ms != null && o.ms >= 1000 && o.ms < 3000, o.ms);

  const after = await c.turn('hello again');
  t.eq('התור הבא עובד כרגיל', after.text, 'echo:hello again');
  await c.close();
}

// ---------------------------------------------------------------------------
t.section('תיקייה שה-git בה תקוע');
{
  const c = await conversation('cliturn2', stuckDir);
  const r = await c.turn('hang');
  t.eq('אחרי הפעלה מחדש בלי git — התשובה הגיעה', r.text, 'echo:hang [nogit]');
  t.eq('result אחד', r.results, 1);
  t.ok('נאמר למשתמש למה', r.toasts.some((x) => /git/.test(x)), r.toasts);
  t.ok('לא נעצר בשגיאה', r.halts === 0, r.halts);
  await c.close();

  const d = await conversation('cliturn3', stuckDir);
  const r2 = await d.turn('hi');
  t.eq('שיחה חדשה באותה תיקייה עולה ישר בלי git', r2.text, 'echo:hi [nogit]');
  t.ok('בלי להמתין שוב', r2.ms != null && r2.ms < 1000, r2.ms);
  await d.close();

  const e = await conversation('cliturn4', okDir);
  const r3 = await e.turn('hi');
  t.eq('תיקייה אחרת לא מושפעת', r3.text, 'echo:hi');
  await e.close();
}

t.section('סיכום');
await sleep(200);
t.ok('אין שגיאות חריגות בשרת', !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(srvOut), srvOut.slice(-500));

await finish();
t.done();
