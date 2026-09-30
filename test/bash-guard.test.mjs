/**
 * שומר Bash: פקודה שהורגת את Sol נדחית גם ב-GOD.
 *   node test/bash-guard.test.mjs
 *
 * החצי הראשון בודק את ההכרעה עצמה. החצי השני מרים את server.js עם CLI
 * מדומה — אותו מסלול שבו GOD כותב control_response — ומוודא ש-allow לא
 * יוצא על pkill node, ושאישור ידני (מסך והתראה) לא מעביר אותו.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const { inspectBash } = require('../lib/bash-guard.js');
const WebSocket = require('ws');

const t = runner('שומר Bash — Sol לא הורג את עצמו');

const ctx = {
  solPid: 4242,
  solPgid: 4242,
  solPorts: [4173, 4174],
  solRoot: '/home/user/rtl-claude',
  solScript: '/home/user/rtl-claude/server.js',
  commandLine: 'node /home/user/rtl-claude/server.js',
  home: '/home/user',
  names: ['node', 'npm', 'server.js', 'rtl-claude', 'sol'],
};

function judge(command, toolName = 'Bash', extra = {}) {
  return inspectBash({ toolName, input: { command }, ...ctx, ...extra });
}
function denied(command, toolName = 'Bash') {
  const r = judge(command, toolName);
  t.eq(command + ' — נחסם', r.allow, false);
  t.ok(command + ' — הסבר בעברית', r.reason && /שרת Sol/.test(r.reason) && /קפוא/.test(r.reason), r.reason);
}
function allowed(command, toolName = 'Bash') {
  const r = judge(command, toolName);
  t.eq(command + ' — מותר', r.allow, true);
  t.eq(command + ' — בלי סיבה', r.reason, undefined);
}

// ---------------------------------------------------------------------------
t.section('נדחה: הורג את Sol');
{
  denied('pkill -9 node');
  denied('pkill -9 python node cargo');
  denied('pkill -9 python node cargo tauri app');
  denied('killall node');
  denied('killall npm');
  denied('pkill server.js');
  denied('kill -9 4242');
  denied('kill -9 -4242');
  denied('kill -9 -1');
  denied('pkill -f node');
  denied('pkill -f server.js');
  denied('fuser -k 4173/tcp');
  denied('fuser -k 4174/tcp');
  denied('lsof -ti :4173 | xargs kill -9');
  denied('lsof -ti:4174 | xargs kill');
  denied('kill -9 $(lsof -t -i:4173)');
  denied('npx kill-port 4173');
  denied('rm -rf /home/user/rtl-claude');
  denied('rm -rf /home/user/rtl-claude/');
  denied('rm -rf /home/user/rtl-claude/server.js');
  denied('rm -rf ~/rtl-claude');
}

t.section('מותר: הריגה ממוקדת של משהו אחר, ופקודה רגילה');
{
  allowed('pkill -9 -f tauri');
  allowed('pkill cargo');
  allowed('pkill -f GuitarScaleViewer');
  allowed('ls');
  allowed('pkill python');
  allowed('pkill nodejs');
  allowed('killall cargo');
  allowed('kill -9 999');
  allowed('fuser -k 3000/tcp');
  allowed('lsof -ti :3000 | xargs kill -9');
  allowed('lsof -ti :4173');
  allowed('rm -rf /tmp/x');
  allowed('echo pkill -9 node');
  // כלי שאינו shell לא רץ בטרמינל, גם אם הטקסט נראה כמו pkill
  allowed('pkill -9 node', 'Edit');
  allowed('pkill -9 node', 'Read');
}

t.section('עטיפות ושרשור');
{
  denied("bash -c 'pkill -9 node'");
  denied('bash -lc "pkill -9 node"');
  denied('sh -c "pkill -9 node"');
  denied('sudo killall node');
  denied('sudo -n killall node');
  denied("sudo bash -c 'pkill -9 node'");
  denied('pkill    -9     node');
  denied('ls; pkill -9 node');
  denied('true && pkill node');
  denied('FOO=1 pkill node');
  denied('nice -n 5 pkill -9 node');
  allowed('bash -c \'pkill -9 -f tauri\'');
  allowed('sudo pkill cargo');
}

t.section('השרת והלקוח מחוברים לשומר');
{
  const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  t.ok('server מייבא inspectBash', /require\('\.\/lib\/bash-guard'\)/.test(srv));
  t.ok('godApprove שואל לפני allow', /function godApprove[\s\S]{0,500}guardTool\(/.test(srv));
  t.ok('דחייה כותבת behavior deny', /behavior: 'deny'/.test(srv));
  t.ok('נרשם god.deny ו-bash.guard', /dbg\('god\.deny'/.test(srv) && /dbg\('bash\.guard'/.test(srv));
  t.ok('אישור ידני נבדק', /function answerPermission[\s\S]{0,700}guardTool\(/.test(srv));
  t.ok('הלקוח מציג god_deny', /case 'god_deny': onGodDeny/.test(app));
}

// ---------------------------------------------------------------------------
/* המסלול האמיתי: שרת, CLI מדומה, ושקע. בלי זה הבדיקה הייתה מאשרת מודול
   שאף אחד לא קורא לו — ו-GOD היה ממשיך לאשר את pkill node. */
t.section('דרך השרת עצמו');

const PORT = Number(process.env.SIM_GUARD_PORT || 4917);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-bash-guard-'));
const GUARD_LOG = path.join(HOME, 'guard-responses.jsonl');
fs.writeFileSync(GUARD_LOG, '');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const _warn = process.emitWarning;
process.emitWarning = (w, ...r) => { if (!String(w).includes('NODE_TLS_REJECT_UNAUTHORIZED')) _warn.call(process, w, ...r); };
const ROOT = new URL('..', import.meta.url).pathname;
const secure = fs.existsSync(path.join(ROOT, 'certs', 'cert.pem'));
const BASE = `${secure ? 'https' : 'http'}://127.0.0.1:${PORT}`;
const WSURL = `${secure ? 'wss' : 'ws'}://127.0.0.1:${PORT}`;

const BIN = path.join(HOME, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (!args.includes('stream-json')) process.exit(0);
const sid = 'fake-' + process.pid;
const log = process.env.GUARD_LOG;
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\\n');
let buf = '';
let pending = null;
let pendingText = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'control_response' && pending && m.response && m.response.request_id === pending) {
      const inner = (m.response && m.response.response) || {};
      fs.appendFileSync(log, JSON.stringify({ id: pending, behavior: inner.behavior || '', message: inner.message || '' }) + '\\n');
      out({ type: 'user', isReplay: true, message: { role: 'user', content: pendingText } });
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'beh:' + (inner.behavior || '') }] } });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: '' });
      pending = null;
      continue;
    }
    if (m.type !== 'user') continue;
    const text = typeof m.message.content === 'string' ? m.message.content : '';
    if (!text.startsWith('GUARD ')) continue;
    const command = text.slice(6);
    const id = 'req-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    pending = id;
    pendingText = text;
    out({ type: 'system', subtype: 'init', cwd: process.cwd() });
    out({
      type: 'control_request', request_id: id,
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command }, description: '' },
    });
  }
});
`, { mode: 0o755 });

const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env, HOME, PATH: BIN + path.delimiter + process.env.PATH,
    PORT: String(PORT), REMOTE_PORT: String(PORT + 1), GUARD_LOG,
    OMNIROUTE_BASE_URL: '', LOCAL_BASE_URL: 'http://127.0.0.1:9999/v1', CCR_GATEWAY_URL: '', CURSOR_SESSION_TOKEN: '',
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

let up = false;
for (let k = 0; k < 100 && !up; k++) {
  try { up = (await fetch(BASE + '/api/store')).ok; } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
if (!up) {
  console.error('השרת לא עלה:\n' + srvOut);
  cleanup();
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(HOME, 'work-'));

function readDecisions() {
  return fs.readFileSync(GUARD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function connect(id) {
  const ws = new WebSocket(WSURL, { rejectUnauthorized: false });
  const inbox = [];
  ws.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch {} });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'subscribe', conversationId: id }));
  for (let k = 0; k < 50 && !inbox.some((m) => m.kind === 'sync'); k++) await sleep(20);
  return {
    inbox,
    send(obj) { ws.send(JSON.stringify(obj)); },
    close: () => new Promise((res) => { ws.on('close', res); ws.close(); }),
  };
}

async function runGod(conn, command) {
  const before = conn.inbox.length;
  conn.send({ type: 'user', text: 'GUARD ' + command, cwd: work, permissionMode: 'god' });
  const t0 = Date.now();
  let end = false;
  for (;;) {
    const frames = conn.inbox.slice(before);
    if (frames.some((m) => m.kind === 'busy' && m.running === false)) { end = true; break; }
    if (Date.now() - t0 > 8000) break;
    await sleep(20);
  }
  await sleep(100);
  return conn.inbox.slice(before);
}

{
  const god = await connect('guardgod1');
  const killFrames = await runGod(god, 'pkill -9 node');
  const dec1 = readDecisions().at(-1);
  t.eq('GOD: ה-CLI קיבל deny על pkill -9 node', dec1 && dec1.behavior, 'deny');
  t.ok('GOD: ההסבר מגיע ל-CLI', dec1 && /שרת Sol/.test(dec1.message), dec1 && dec1.message);
  t.ok('GOD: אין god_allow', !killFrames.some((m) => m.kind === 'god_allow'));
  t.ok('GOD: אין כרטיס הרשאה', !killFrames.some((m) => m.kind === 'permission'));
  t.ok('GOD: יש god_deny', killFrames.some((m) => m.kind === 'god_deny' && /שרת Sol/.test(m.text)));
  t.ok('GOD: יש טוסט', killFrames.some((m) => m.kind === 'toast' && m.err && /שרת Sol/.test(m.text)));
  t.ok('GOD: התור נסגר', killFrames.some((m) => m.kind === 'busy' && m.running === false));

  const broad = await runGod(god, 'pkill -9 python node cargo');
  t.eq('GOD: pkill רחב עם node נדחה', readDecisions().at(-1).behavior, 'deny');
  t.ok('GOD: גם הוא בלי god_allow', !broad.some((m) => m.kind === 'god_allow'));

  const wrapped = await runGod(god, "bash -c 'pkill -9 node'");
  t.eq('GOD: bash -c נדחה', readDecisions().at(-1).behavior, 'deny');
  t.ok('GOD: העטיפה לא עקפה', !wrapped.some((m) => m.kind === 'god_allow'));

  const pidKill = await runGod(god, 'kill -9 ' + srv.pid);
  t.eq('GOD: kill של ה-PID של Sol נדחה', readDecisions().at(-1).behavior, 'deny');
  t.ok('GOD: השרת עדיין חי', (await fetch(BASE + '/api/store')).ok);
  t.ok('GOD: אין god_allow על ה-PID', !pidKill.some((m) => m.kind === 'god_allow'));

  const cargo = await runGod(god, 'pkill cargo');
  t.eq('GOD: pkill cargo מאושר', readDecisions().at(-1).behavior, 'allow');
  t.ok('GOD: יש god_allow', cargo.some((m) => m.kind === 'god_allow'));
  t.ok('GOD: אין god_deny על cargo', !cargo.some((m) => m.kind === 'god_deny'));

  const tauri = await runGod(god, 'pkill -9 -f tauri');
  t.eq('GOD: pkill -f tauri מאושר', readDecisions().at(-1).behavior, 'allow');
  t.ok('GOD: tauri לא נחסם', !tauri.some((m) => m.kind === 'god_deny'));

  const plain = await runGod(god, 'ls');
  t.eq('GOD: ls מאושר', readDecisions().at(-1).behavior, 'allow');
  t.ok('GOD: ls ביומן האישורים', plain.some((m) => m.kind === 'god_allow'));
  await god.close();

  // אישור מהמסך
  const manual = await connect('guardman1');
  const beforeM = manual.inbox.length;
  manual.send({ type: 'user', text: 'GUARD pkill -9 node', cwd: work, permissionMode: 'acceptEdits' });
  const t0 = Date.now();
  let perm = null;
  for (;;) {
    perm = manual.inbox.slice(beforeM).find((m) => m.kind === 'permission');
    if (perm) break;
    if (Date.now() - t0 > 8000) break;
    await sleep(20);
  }
  t.ok('ידני: נפתח כרטיס', !!perm, manual.inbox.slice(beforeM).map((m) => m.kind));
  t.ok('ידני: GOD לא אישר לבד', !manual.inbox.slice(beforeM).some((m) => m.kind === 'god_allow'));
  manual.send({
    type: 'permission', requestId: perm.id, decision: 'allow',
    updatedInput: { command: 'pkill -9 node' }, label: 'allow',
  });
  const t1 = Date.now();
  for (;;) {
    if (manual.inbox.slice(beforeM).some((m) => m.kind === 'busy' && m.running === false)) break;
    if (Date.now() - t1 > 8000) break;
    await sleep(20);
  }
  await sleep(80);
  const manFrames = manual.inbox.slice(beforeM);
  t.eq('ידני: ה-CLI קיבל deny ולא allow', readDecisions().at(-1).behavior, 'deny');
  t.ok('ידני: הכרטיס נסגר כדחייה', manFrames.some((m) => m.kind === 'permission_resolved' && m.decision === 'deny'));
  t.ok('ידני: טוסט מסביר', manFrames.some((m) => m.kind === 'toast' && m.err && /שרת Sol/.test(m.text)));
  await manual.close();

  // אישור מההתראה — בלי updatedInput, כמו ה-Service Worker
  const phone = await connect('guardph1');
  const beforeP = phone.inbox.length;
  phone.send({ type: 'user', text: 'GUARD sudo killall node', cwd: work, permissionMode: 'manual' });
  const t2 = Date.now();
  let perm2 = null;
  for (;;) {
    perm2 = phone.inbox.slice(beforeP).find((m) => m.kind === 'permission');
    if (perm2) break;
    if (Date.now() - t2 > 8000) break;
    await sleep(20);
  }
  t.ok('התראה: יש בקשה פתוחה', !!perm2);
  const res = await fetch(BASE + '/api/permission-answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ convId: 'guardph1', requestId: perm2.id, decision: 'allow' }),
  });
  const body = await res.json();
  t.eq('התראה: השרת ענה', body.ok, true);
  const t3 = Date.now();
  for (;;) {
    if (phone.inbox.slice(beforeP).some((m) => m.kind === 'busy' && m.running === false)) break;
    if (Date.now() - t3 > 8000) break;
    await sleep(20);
  }
  await sleep(80);
  t.eq('התראה: sudo killall node נדחה', readDecisions().at(-1).behavior, 'deny');
  t.ok('התראה: לא נשלח allow', readDecisions().at(-1).behavior !== 'allow');
  await phone.close();

  // אישור ידני של פקודה בטוחה עדיין עובר
  const okm = await connect('guardok1');
  const beforeO = okm.inbox.length;
  okm.send({ type: 'user', text: 'GUARD pkill -f GuitarScaleViewer', cwd: work, permissionMode: 'acceptEdits' });
  const t4 = Date.now();
  let perm3 = null;
  for (;;) {
    perm3 = okm.inbox.slice(beforeO).find((m) => m.kind === 'permission');
    if (perm3) break;
    if (Date.now() - t4 > 8000) break;
    await sleep(20);
  }
  t.ok('ידני בטוח: יש כרטיס', !!perm3);
  okm.send({
    type: 'permission', requestId: perm3.id, decision: 'allow',
    updatedInput: { command: 'pkill -f GuitarScaleViewer' },
  });
  const t5 = Date.now();
  for (;;) {
    if (okm.inbox.slice(beforeO).some((m) => m.kind === 'busy' && m.running === false)) break;
    if (Date.now() - t5 > 8000) break;
    await sleep(20);
  }
  await sleep(80);
  t.eq('ידני בטוח: pkill GuitarScaleViewer אושר', readDecisions().at(-1).behavior, 'allow');
  await okm.close();

  await sleep(150);
  const log = fs.readFileSync(path.join(HOME, '.claude', 'rtl-claude', 'rtl-claude.log'), 'utf8');
  t.ok('היומן: god.deny', /god\.deny/.test(log));
  t.ok('היומן: bash.guard', /bash\.guard/.test(log));
  t.ok('היומן: bash.guard על המסלול הידני', /bash\.guard[^\n]*"via":"user"/.test(log));
  t.ok('אין חריגה בשרת', !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(srvOut), srvOut.slice(-400));
  t.ok('השרת לא מת מהפקודות', (await fetch(BASE + '/api/store')).ok);
}

try { process.kill(srv.pid); } catch {}
await Promise.race([new Promise((r) => srv.once('exit', r)), sleep(2000)]);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}

t.done();
