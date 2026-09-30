'use strict';
/* ==========================================================================
   שומר Bash — Sol לא מאשר פקודה שהורגת את עצמו
   --------------------------------------------------------------------------
   במצב GOD השרת עונה «אשר» לכל can_use_tool לפני שהפקודה רצה. פקודה כמו
   ‎pkill -9 python node cargo‎ הורגת את ‎node server.js‎ של Sol עצמו: התור
   לא מגיע ל-‎turn.end‎, המסך נשאר קפוא, והפורט יורד.

   כאן נעצרת רק פקודה שפוגעת ב-Sol. ‎pkill cargo‎ ו-‎pkill -f tauri‎ נשארים
   מותרים — הריגה ממוקדת של אפליקציה אחרת אינה הריגה של השרת.

   הפונקציה טהורה: אין לה תהליך, אין לה פורט, ואין לה דיסק. השרת מעביר את
   ה-PID, הפורטים והנתיב שלו, וההכרעה חוזרת בלי לכתוב תשובה ל-CLI.
   ========================================================================== */

const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'zsh', 'powershell', 'cmd', 'bashinput']);
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'nice', 'time', 'stdbuf', 'ionice', 'setsid', 'env', 'timeout', 'busybox']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ash', 'ksh']);
const DEFAULT_NAMES = ['node', 'npm', 'server.js', 'rtl-claude', 'sol'];
const DEFAULT_PORTS = [4173, 4174];

const NAMED_SIGNAL = /^(SIG)?(HUP|INT|QUIT|ILL|TRAP|ABRT|IOT|BUS|FPE|KILL|USR1|SEGV|USR2|PIPE|ALRM|TERM|STKFLT|CHLD|CLD|CONT|STOP|TSTP|TTIN|TTOU|URG|XCPU|XFSZ|VTALRM|PROF|WINCH|IO|POLL|PWR|SYS|EMT|INFO)$/;

const FLAG_TAKES_ARG = new Set([
  '-u', '-g', '-h', '-p', '-n', '-s', '-C', '-T', '-r', '-t', '-k', '-o', '-e', '-d', '-U', '-G', '-P', '-F', '-O', '-q',
  '--user', '--group', '--host', '--prompt', '--chdir', '--signal', '--kill-after', '--adjustment', '--unset',
  '--older', '--older-than', '--younger-than', '--pidfile', '--delimiter', '--parent', '--session', '--terminal',
  '--euid', '--uid', '--pgroup', '--namespace', '--queue',
]);

/** שם הקובץ בלי נתיב, באותיות קטנות — ‎/usr/bin/pkill‎ ו-‎pkill‎ הם אותו כלי. */
function binName(cmd) {
  const s = String(cmd || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

function deny(detail) {
  return {
    allow: false,
    reason: `Sol חסם פקודה שהייתה הורגת את שרת Sol (${detail}). בלי השרת התור נתקע והמסך נשאר קפוא.`,
  };
}

function commandOf(tool, input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const raw = input.command != null ? input.command : input.cmd;
  if (Array.isArray(raw)) return raw.map((x) => String(x)).join(' ');
  if (typeof raw === 'string') return raw;
  const t = String(tool || '').toLowerCase();
  if (t === 'bashinput' && typeof input.input === 'string') return input.input;
  return '';
}

function buildCtx(opts) {
  const names = (Array.isArray(opts.names) && opts.names.length ? opts.names : DEFAULT_NAMES)
    .map((n) => String(n));
  const ports = (Array.isArray(opts.solPorts) && opts.solPorts.length ? opts.solPorts : DEFAULT_PORTS)
    .map((p) => Number(p)).filter((p) => p > 0);
  const lines = [];
  if (opts.commandLine) lines.push(String(opts.commandLine));
  if (opts.solScript) {
    lines.push('node ' + opts.solScript);
    lines.push(String(opts.solScript));
  }
  const norm = (p) => normalizePath(expandUser(p, opts.home));
  return {
    pid: Number(opts.solPid) || 0,
    pgid: Number(opts.solPgid) || Number(opts.solPid) || 0,
    ports,
    names,
    home: opts.home ? String(opts.home).replace(/\/$/, '') : '',
    root: norm(opts.solRoot),
    script: norm(opts.solScript),
    lines,
  };
}

function expandUser(p, home) {
  if (!p || !home) return p;
  if (p === '~') return home;
  if (String(p).startsWith('~/')) return String(home).replace(/\/$/, '') + p.slice(1);
  return p;
}

/**
 * האם ארגומנט של ‎pkill‎/‎killall‎ מכוון לשם מוגן.
 * התאמה מילולית (‎node‎, ‎node|cargo‎) או ביטוי שתואם את השם כולו ואינו
 * תו-כללי קצר — כדי ש-‎pkill cargo‎ לא ייחסם ו-‎pkill node‎ כן.
 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ביטוי שהמודל שלח. דפוס מתפוצץ (‎(a+)+‎) היה תוקע את לולאת האירועים —
 * אותה קפיאה שבאנו למנוע. ארוך או מקונן מדי נבדק רק מילולית.
 */
function safeRegExp(pattern, flags) {
  const p = String(pattern);
  if (p.length > 80) return null;
  if (/(\.\*){2,}|\([^)]*[+*][^)]*\)[+*]/.test(p)) return null;
  try { return new RegExp(p, flags); } catch { return null; }
}

/**
 * שם מוגן כמטרה: שוויון (‎node‎), חלופה (‎node|cargo‎), או ביטוי שתואם
 * את השם *כולו*. ‎server‎ לא נחשב פגיעה ב-‎server.js‎ — בלי ‎-f‎ pkill
 * משווה לשם התהליך, והוא ‎node‎ ולא ‎server.js‎.
 */
function mentionsName(pattern, name) {
  const p = String(pattern);
  const n = String(name);
  if (!p || !n) return false;
  if (p.toLowerCase() === n.toLowerCase()) return true;
  const token = new RegExp('(?:^|[|()^$\\s])' + escapeRe(n) + '(?:$|[|()^$\\s])', 'i');
  if (token.test(p)) return true;
  if (isMatchAll(p)) return true;
  if (literalWeight(p) < 2 && p.length < 3) return false;
  const anchored = safeRegExp('^(?:' + p + ')$', 'i');
  if (anchored && anchored.test(n)) return true;
  const loose = safeRegExp(p, 'i');
  if (!loose) return false;
  const m = loose.exec(n);
  return !!(m && m[0].length === n.length && literalWeight(p) >= Math.min(3, n.length));
}

function isMatchAll(p) {
  return /^\^?(?:\.\*|\.\+|\.\*\?|\.\+\?)\$?$/.test(String(p).trim());
}

/** כמה תווים מילוליים יש בביטוי — בלי ‎.*‎ וסוגריים, כדי לסנן ‎pkill e‎. */
function literalWeight(pattern) {
  let n = 0;
  let cls = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { n += 1; i += 1; continue; }
    if (c === '[') { cls = true; continue; }
    if (c === ']' && cls) { cls = false; continue; }
    if (cls) { if (/[A-Za-z0-9]/.test(c)) n += 1; continue; }
    if ('.+*?(){}|^$'.includes(c)) continue;
    if (/[A-Za-z0-9_]/.test(c)) n += 1;
  }
  return n;
}

/** ‎pkill -f‎ תואם את שורת הפקודה. אם הביטוי בוחר את התהליך של Sol — לחסום. */
function lineMatches(pattern, ctx) {
  if (ctx.root && (pattern === ctx.root || pattern.includes(ctx.root + '/'))) return true;
  if (ctx.script && pattern.includes(ctx.script)) return true;
  if (literalWeight(pattern) < 3 && !isMatchAll(pattern)) return false;
  const re = safeRegExp(pattern, 'i');
  if (!re) return false;
  if (ctx.lines.some((line) => line && re.test(line))) return true;
  if (ctx.script && re.test(ctx.script)) return true;
  return false;
}

function patternHits(pattern, ctx, { full }) {
  if (ctx.names.some((name) => mentionsName(pattern, name))) return true;
  if (full && lineMatches(pattern, ctx)) return true;
  return false;
}

function isSignalToken(a) {
  if (/^-\d+$/.test(a)) {
    const n = Number(a.slice(1));
    return n >= 0 && n <= 64;
  }
  return /^-[A-Za-z]/.test(a) && NAMED_SIGNAL.test(a.slice(1));
}

/**
 * מפרק ‎pkill‎/‎killall‎/‎pgrep‎ לדגלים ולמטרות.
 * ‎-9‎ הוא איתות ולא שם תהליך; ‎-f‎ הוא התאמה לשורת הפקודה.
 */
function parseProcArgs(argv, kind) {
  let full = false;
  // ‎pkill‎ תמיד ביטוי; ‎killall‎ רק עם ‎-r‎. ‎-x‎/‎-i‎ נבלעים כדי שלא ייקראו שם תהליך.
  let regex = kind === 'pkill' || kind === 'pgrep';
  const targets = [];
  // ‎-n‎/‎-o‎ של pkill הם «החדש»/«הישן» ולא צורכים את שם התהליך.
  const takes = new Set(['-g', '-G', '-P', '-s', '-t', '-u', '-U', '-F', '-d', '-q', '--signal', '--user', '--group', '--parent', '--session', '--terminal', '--euid', '--uid', '--pidfile', '--delimiter', '--pgroup', '--queue']);
  if (kind === 'killall') { takes.add('-o'); takes.add('-y'); takes.add('--older-than'); takes.add('--younger-than'); }
  else { takes.add('-O'); takes.add('--older'); }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { targets.push(...argv.slice(i + 1)); break; }
    if (a === '-f' || a === '--full') { full = true; continue; }
    if (a === '-x' || a === '--exact') continue;
    if (a === '-r' || a === '--regexp') { regex = true; continue; }
    if (a === '-i' && kind !== 'killall') continue;
    if (a === '-I' || a === '--ignore-case') continue;
    if (a.startsWith('--signal=')) continue;
    if (a === '--signal' || (kind === 'killall' && (a === '-s'))) { i += 1; continue; }
    if (isSignalToken(a)) continue;
    if (takes.has(a)) { i += 1; continue; }
    if (/^-\d+[A-Za-z]+$/.test(a)) {
      if (a.replace(/^-\d+/, '').includes('f')) full = true;
      continue;
    }
    if (/^-[a-zA-Z]+$/.test(a)) {
      if (a.includes('f')) full = true;
      if (a.includes('r')) regex = true;
      const last = a[a.length - 1];
      if ('gGPstuUFdOq'.includes(last)) i += 1;
      continue;
    }
    if (a.startsWith('--')) continue;
    targets.push(a);
  }
  return { full, regex, targets };
}

function procTargetsSol(argv, ctx, kind) {
  const parsed = parseProcArgs(argv, kind);
  const asRegex = kind !== 'killall' || parsed.regex;
  for (const pattern of parsed.targets) {
    // ‎killall‎ בלי ‎-r‎ משווה שם במדויק. ‎pkill‎ הוא ביטוי, גם בלי ‎-f‎.
    if (!asRegex) {
      if (ctx.names.some((n) => n.toLowerCase() === pattern.toLowerCase())) return pattern;
      continue;
    }
    if (patternHits(pattern, ctx, { full: !!parsed.full })) return pattern;
  }
  return null;
}

function parseKillPids(argv) {
  const args = argv.slice(1);
  if (!args.length) return [];
  if (args.some((a) => a === '-l' || a === '-L' || a === '--list' || a === '-h' || a === '--help')) return [];
  const pids = [];
  let i = 0;
  if (args[i] === '-s' || args[i] === '--signal' || args[i] === '-n') i += 2;
  else if (args[i] && String(args[i]).startsWith('--signal=')) i += 1;
  else if (args[i] && isSignalToken(args[i]) && args.length > i + 1) i += 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      for (const p of args.slice(i + 1)) if (/^-?\d+$/.test(p)) pids.push(p);
      break;
    }
    if (/^-?\d+$/.test(a)) pids.push(a);
  }
  return pids;
}

function killHits(argv, ctx) {
  for (const raw of parseKillPids(argv)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n === -1) return 'kill -1';
    const abs = Math.abs(n);
    if (ctx.pid && abs === ctx.pid) return 'kill ' + ctx.pid;
    if (n < 0 && ctx.pgid && abs === ctx.pgid) return 'kill -' + ctx.pgid;
  }
  return null;
}

function fuserHits(argv, ctx) {
  let kill = false;
  const ports = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-k' || a === '--kill') { kill = true; continue; }
    if (a === '-n' || a === '--namespace') { i += 1; continue; }
    if (a.startsWith('-')) {
      if (a.includes('k')) kill = true;
      const last = a[a.length - 1];
      if ('n'.includes(last) && a !== '-k') i += 1;
      continue;
    }
    const m = String(a).match(/^(\d{2,5})(?:\/(?:tcp|udp|sctp))?$/i);
    if (m) ports.push(Number(m[1]));
  }
  if (!kill) return null;
  const hit = ports.find((p) => ctx.ports.includes(p));
  return hit ? ('פורט ' + hit) : null;
}

function lsofTargetsPort(argv, ctx) {
  const text = argv.join(' ');
  for (const p of ctx.ports) {
    const re = new RegExp('(?:-i\\s*(?:TCP|UDP|tcp|udp)?\\s*:?\\s*|:)\\s*' + p + '\\b', 'i');
    if (re.test(text)) return p;
  }
  return 0;
}

function killPortHits(argv, ctx) {
  let args = argv.slice(1);
  const b = binName(argv[0] || '');
  if (b === 'npx' || b === 'npm' || b === 'pnpm' || b === 'yarn') {
    let i = 0;
    while (args[i] && args[i].startsWith('-')) i += 1;
    if (binName(args[i] || '') !== 'kill-port') return null;
    args = args.slice(i + 1);
  } else if (b !== 'kill-port') return null;
  for (const a of args) {
    const n = Number(String(a).replace(/\/(?:tcp|udp)$/i, ''));
    if (ctx.ports.includes(n)) return 'פורט ' + n;
  }
  return null;
}

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let s = p.trim();
  if (!s.startsWith('/') && !s.startsWith('~')) return '';
  s = s.replace(/\/+\.?$/, '');
  s = s.replace(/\/\*$/, '');
  const home = s.startsWith('~/') || s === '~';
  const body = home ? s.slice(1) : s;
  const parts = [];
  for (const seg of body.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const out = (body.startsWith('/') || !home ? '/' : '') + parts.join('/');
  return home ? '~' + (out === '/' ? '' : out) : (out || '/');
}

function rmHits(argv, ctx) {
  let recursive = false;
  let force = false;
  const paths = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { paths.push(...argv.slice(i + 1)); break; }
    if (a === '--recursive') { recursive = true; continue; }
    if (a === '--force') { force = true; continue; }
    if (a.startsWith('-') && !a.startsWith('--')) {
      if (/[rR]/.test(a)) recursive = true;
      if (a.includes('f')) force = true;
      continue;
    }
    if (a.startsWith('--')) continue;
    paths.push(a);
  }
  if (!recursive && !force) return null;
  const pathOf = (raw) => normalizePath(expandUser(String(raw).trim().replace(/\/\*$/, ''), ctx.home));
  for (const raw of paths) {
    const p = pathOf(raw);
    if (!p) continue;
    if (ctx.root && p === ctx.root) return 'rm של תיקיית Sol';
    if (ctx.script && p === ctx.script) return 'rm של server.js';
  }
  return null;
}

function unwrapOne(argv) {
  if (!argv.length) return { argv, wrapped: false };
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) && argv[0].indexOf('=') > 0) {
    return { argv: argv.slice(1), wrapped: true };
  }
  const b = binName(argv[0]);
  if (b === 'eval') {
    const script = argv.slice(1).join(' ');
    return script ? { script, wrapped: true } : { argv, wrapped: false };
  }
  if (SHELLS.has(b)) {
    let i = 1;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { i += 1; break; }
      if (a === '-c') return { script: argv[i + 1] != null ? argv[i + 1] : '', wrapped: true };
      if (a.startsWith('-') && !a.startsWith('--') && a.includes('c')) {
        return { script: argv[i + 1] != null ? argv[i + 1] : '', wrapped: true };
      }
      if (!a.startsWith('-')) break;
    }
    return { argv, wrapped: false };
  }
  if (!WRAPPERS.has(b)) return { argv, wrapped: false };
  const rest = argv.slice(1);
  let i = 0;
  // ‎sudo -n‎ הוא דגל בוליאני; ‎nice -n 5‎ כן צורך ארגומנט. אסור לערבב.
  const takes = new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-k', '-o', '-U', '-G']);
  if (b === 'nice' || b === 'stdbuf') takes.add('-n');
  if (b === 'env') takes.add('-u');
  while (i < rest.length) {
    const a = rest[i];
    if (a === '--') { i += 1; break; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { i += 1; continue; }
    if (!a.startsWith('-')) break;
    i += 1;
    if (takes.has(a) || (a.startsWith('--') && FLAG_TAKES_ARG.has(a))) i += 1;
  }
  if (b === 'timeout' && rest[i] && /^[\d.]+([smhd]|ms)?$/.test(rest[i])) i += 1;
  return { argv: rest.slice(i), wrapped: true };
}

function scanArgv(argv, ctx, depth) {
  let cur = argv.slice();
  for (let n = 0; n < 8 && cur.length; n++) {
    const un = unwrapOne(cur);
    if (un.script != null) return scanScript(un.script, ctx, depth + 1);
    cur = un.argv;
    if (!un.wrapped) break;
  }
  if (!cur.length) return null;
  const b = binName(cur[0]);
  if (b === 'pkill' || b === 'killall') {
    const hit = procTargetsSol(cur, ctx, b);
    if (hit) return deny(b + ' ' + hit);
  }
  if (b === 'kill') {
    const hit = killHits(cur, ctx);
    if (hit) return deny(hit);
  }
  if (b === 'fuser') {
    const hit = fuserHits(cur, ctx);
    if (hit) return deny('fuser על ' + hit);
  }
  const port = killPortHits(cur, ctx);
  if (port) return deny('kill-port על ' + port);
  const rm = b === 'rm' ? rmHits(cur, ctx) : null;
  if (rm) return deny(rm);
  return null;
}

/** מפצל פקודות על ‎;‎ ‎&&‎ ‎||‎ ושורה חדשה, בלי לקרוע מרכאות. */
function splitStatements(s) {
  return splitTop(s, 'stmt');
}
function splitPipes(s) {
  return splitTop(s, 'pipe');
}
function splitTop(s, mode) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (mode === 'stmt' && (c === '\n' || c === ';')) { parts.push(cur); cur = ''; continue; }
    if (mode === 'stmt' && ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|'))) {
      parts.push(cur); cur = ''; i += 1; continue;
    }
    if (mode === 'pipe' && c === '|') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function tokenize(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < s.length) { cur += s[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function extractSubs(s) {
  const subs = [];
  let i = 0;
  let quote = null;
  while (i < s.length) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      i += 1; continue;
    }
    if (quote === '"') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { quote = null; i += 1; continue; }
    } else if (c === '"' || c === "'") { quote = c; i += 1; continue; }
    if (!quote && c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i + 1;
      let q = null;
      for (; j < s.length; j++) {
        if (q) { if (s[j] === q) q = null; else if (s[j] === '\\' && q === '"') j += 1; continue; }
        if (s[j] === '"' || s[j] === "'") { q = s[j]; continue; }
        if (s[j] === '`') break;
      }
      if (j >= s.length) break;
      subs.push(s.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let q = null;
      for (; j < s.length && depth; j++) {
        const d = s[j];
        if (q) {
          if (d === q) q = null;
          else if (d === '\\' && q === '"') j += 1;
          continue;
        }
        if (d === '"' || d === "'") { q = d; continue; }
        if (d === '(') depth += 1;
        else if (d === ')') depth -= 1;
      }
      subs.push(s.slice(i + 2, j - 1));
      i = j;
      continue;
    }
    i += 1;
  }
  return subs;
}

function blankSubs(s) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < s.length) {
    const c = s[i];
    if (quote === "'") {
      out += c;
      if (c === "'") quote = null;
      i += 1; continue;
    }
    if (quote === '"') {
      if (c === '\\' && i + 1 < s.length) { out += c + s[i + 1]; i += 2; continue; }
      if (c === '"') { quote = null; out += c; i += 1; continue; }
    } else if (c === '"' || c === "'") { quote = c; out += c; i += 1; continue; }
    if (c === '`') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '`'; j++) { /* דילוג */ }
      out += ' ';
      i = j + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let q = null;
      for (; j < s.length && depth; j++) {
        const d = s[j];
        if (q) { if (d === q) q = null; else if (d === '\\' && q === '"') j += 1; continue; }
        if (d === '"' || d === "'") { q = d; continue; }
        if (d === '(') depth += 1;
        else if (d === ')') depth -= 1;
      }
      out += ' ';
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function stageBin(stage) {
  const argv = tokenize(stage);
  return { argv, bin: binName(argv[0] || '') };
}

function portKillDetail(statement, ctx) {
  const stages = splitPipes(statement);
  let lsofPort = 0;
  let killer = false;
  for (const stage of stages) {
    const { argv, bin } = stageBin(stage);
    if (!argv.length) continue;
    if (bin === 'fuser') {
      const hit = fuserHits(argv, ctx);
      if (hit) return 'fuser על ' + hit;
    }
    const kp = killPortHits(argv, ctx);
    if (kp) return 'kill-port על ' + kp;
    if (bin === 'lsof') {
      const p = lsofTargetsPort(argv, ctx);
      if (p) lsofPort = p;
    }
    if (bin === 'kill' || bin === 'pkill' || bin === 'killall' || bin === 'xargs') killer = true;
    if (bin === 'ss' && argv.some((a) => a === '-K' || a === '--kill')) {
      const text = argv.join(' ');
      for (const p of ctx.ports) {
        if (new RegExp(':' + p + '\\b').test(text)) return 'ss על פורט ' + p;
      }
    }
  }
  if (lsofPort && killer) return 'lsof על פורט ' + lsofPort;
  return null;
}

function pidofPiped(statement, ctx) {
  const stages = splitPipes(blankSubs(statement));
  if (stages.length < 2) return null;
  const killer = stages.some((s) => {
    const b = stageBin(s).bin;
    return b === 'kill' || b === 'xargs' || b === 'pkill' || b === 'killall';
  });
  if (!killer) return null;
  for (const s of stages) {
    const { argv, bin } = stageBin(s);
    if (bin !== 'pidof' && bin !== 'pgrep') continue;
    const hit = procTargetsSol(argv, ctx, bin === 'pidof' ? 'killall' : 'pgrep');
    if (hit) return bin + ' ' + hit;
  }
  return null;
}

function subsFeedKill(statement, ctx) {
  if (!/\b(kill|pkill|killall|xargs)\b/.test(statement)) return null;
  for (const inner of extractSubs(statement)) {
    const stages = splitPipes(inner);
    for (const s of stages) {
      const { argv, bin } = stageBin(s);
      if (bin === 'lsof') {
        const p = lsofTargetsPort(argv, ctx);
        if (p) return 'lsof על פורט ' + p;
      }
      if (bin === 'pidof' || bin === 'pgrep') {
        const hit = procTargetsSol(argv, ctx, bin === 'pidof' ? 'killall' : 'pgrep');
        if (hit) return bin + ' ' + hit;
      }
    }
  }
  return null;
}

function scanStatement(statement, ctx, depth) {
  const port = portKillDetail(statement, ctx);
  if (port) return deny(port);
  const fed = subsFeedKill(statement, ctx);
  if (fed) return deny(fed);
  for (const inner of extractSubs(statement)) {
    const hit = scanScript(inner, ctx, depth + 1);
    if (hit) return hit;
  }
  const piped = pidofPiped(statement, ctx);
  if (piped) return deny(piped);
  const flat = blankSubs(statement);
  for (const stage of splitPipes(flat)) {
    const hit = scanArgv(tokenize(stage), ctx, depth);
    if (hit) return hit;
  }
  return null;
}

function scanScript(script, ctx, depth) {
  if (!script || depth > 8) return null;
  for (const st of splitStatements(script)) {
    const hit = scanStatement(st, ctx, depth);
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {{ toolName?: string, input?: object|string, solPid?: number, solPgid?: number,
 *   solPorts?: number[], solRoot?: string, solScript?: string, commandLine?: string, names?: string[] }} opts
 * @returns {{ allow: boolean, reason?: string }}
 */
function inspectBash(opts) {
  const o = opts || {};
  const tool = String(o.toolName || '');
  if (!SHELL_TOOLS.has(tool.toLowerCase())) return { allow: true };
  const command = commandOf(tool, o.input);
  if (!String(command).trim()) return { allow: true };
  const hit = scanScript(String(command), buildCtx(o), 0);
  return hit || { allow: true };
}

module.exports = { inspectBash };
