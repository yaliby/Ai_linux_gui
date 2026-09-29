'use strict';
/* ==========================================================================
   רישום שרת MCP — Claude ו-Cursor
   --------------------------------------------------------------------------
   שני הסוכנים לא חולקים רשימה. Claude Code קורא את מה ש-‎claude mcp add
   כתב (כאן תמיד בהיקף המשתמש, כדי שכל תיקיית עבודה תראה את השרת), ו-Cursor
   קורא את ‎~/.cursor/mcp.json‎. שרת ברמת המשתמש של Cursor נטען בכל פרויקט
   בלי אישור נפרד לכל תיקייה; אישור ‎mcp enable‎ חל רק על קובץ של פרויקט.

   המודול הזה לא מריץ את הפקודה שהמשתמש הקליד דרך מעטפת. ‎execFile‎ מקבל
   מערך ארגומנטים, והמחרוזת מתפצלת כאן — כולל מרכאות — לפני שהיא יוצאת.
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');

const AGENTS = ['claude', 'cursor'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * פיצול שורת פקודה בלי מעטפת. מרכאות כפולות ובודדות שומרות על רווחים;
 * מרכאה שלא נסגרה מחזירה null, כדי שלא נירשום חצי פקודה.
 */
function splitCommand(line) {
  const s = String(line || '').trim();
  if (!s) return [];
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
    } else cur += c;
  }
  if (quote) return null;
  if (cur) out.push(cur);
  return out;
}

function agentsOf(body) {
  const raw = Array.isArray(body && body.agents) ? body.agents : [];
  return [...new Set(raw.filter((a) => AGENTS.includes(a)))];
}

/** גוף הבקשה מהממשק → מפרט שאפשר לרשום, או שגיאה בעברית. */
function parseAdd(body) {
  const b = body && typeof body === 'object' ? body : {};
  const agents = agentsOf(b);
  if (!agents.length) return { ok: false, error: 'בחרו Claude, Cursor, או את שניהם' };
  const name = String(b.name || '').trim();
  if (!NAME_RE.test(name)) {
    return { ok: false, error: 'השם: אות או ספרה בהתחלה, ואחר כך אותיות, ספרות, נקודה, מקף או קו תחתון' };
  }
  const transport = b.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'http') {
    const url = String(b.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
      return { ok: false, error: 'כתובת השרת צריכה להתחיל ב-http:// או ב-https://' };
    }
    if (url.length > 500) return { ok: false, error: 'הכתובת ארוכה מדי' };
    return { ok: true, spec: { name, agents, transport, url } };
  }
  if (/[\n\r\0]/.test(String(b.command || ''))) return { ok: false, error: 'הפקודה חייבת להיות שורה אחת' };
  const argv = splitCommand(b.command);
  if (argv == null) return { ok: false, error: 'מרכאה בפקודה לא נסגרה' };
  if (!argv.length) return { ok: false, error: 'חסרה פקודה' };
  if (argv.length > 24) return { ok: false, error: 'יותר מדי ארגומנטים בפקודה' };
  if (argv.some((a) => a.length > 300)) return { ok: false, error: 'ארגומנט בפקודה ארוך מדי' };
  if (argv[0].startsWith('-')) return { ok: false, error: 'הפקודה צריכה להתחיל בשם תוכנית, לא בדגל' };
  return { ok: true, spec: { name, agents, transport, command: argv[0], args: argv.slice(1) } };
}

function parseRemove(body) {
  const b = body && typeof body === 'object' ? body : {};
  const agent = b.agent === 'cursor' ? 'cursor' : b.agent === 'claude' ? 'claude' : '';
  const name = String(b.name || '').trim();
  if (!agent) return { ok: false, error: 'חסר סוכן' };
  if (!name || name.length > 80 || /[\n\r\0]/.test(name) || name.startsWith('-')) {
    return { ok: false, error: 'שם לא תקין' };
  }
  return { ok: true, name, agent };
}

function claudeAddArgs(spec) {
  if (spec.transport === 'http') {
    return ['mcp', 'add', '--scope', 'user', '--transport', 'http', spec.name, spec.url];
  }
  return ['mcp', 'add', '--scope', 'user', spec.name, '--', spec.command, ...spec.args];
}

function cursorEntry(spec) {
  if (spec.transport === 'http') return { url: spec.url };
  const entry = { command: spec.command };
  if (spec.args.length) entry.args = spec.args;
  return entry;
}

/**
 * מעדכן עותק של קובץ ההגדרות. שרתים אחרים ומפתחות ברמת הקובץ נשארים.
 * מחזיר ‎updated‎ כשהשם כבר היה שם — הרישום החדש מחליף את הפקודה.
 */
function upsertCursorConfig(cfg, spec) {
  const base = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? { ...cfg } : {};
  const prev = base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
    ? base.mcpServers : {};
  const updated = Object.prototype.hasOwnProperty.call(prev, spec.name);
  base.mcpServers = { ...prev, [spec.name]: cursorEntry(spec) };
  return { cfg: base, updated };
}

function removeCursorConfig(cfg, name) {
  const base = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? { ...cfg } : {};
  const prev = base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
    ? { ...base.mcpServers } : {};
  if (!Object.prototype.hasOwnProperty.call(prev, name)) return { ok: false, error: 'השרת לא רשום ב-Cursor ברמת המשתמש' };
  delete prev[name];
  base.mcpServers = prev;
  return { ok: true, cfg: base };
}

function runClaude(execFile, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const msg = String(stderr || stdout || (err && err.message) || '').trim().slice(0, 500);
      if (err) resolve({ ok: false, error: msg || 'הפקודה נכשלה' });
      else resolve({ ok: true });
    });
  });
}

function readCursorFile(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return { ok: false, error: 'קובץ mcp.json של Cursor אינו אובייקט' };
    }
    return { ok: true, cfg };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, cfg: {} };
    return { ok: false, error: 'לא ניתן לקרוא את ~/.cursor/mcp.json: ' + e.message };
  }
}

function writeCursorFile(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.rtl-tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function summarize(results) {
  const bits = [];
  for (const agent of AGENTS) {
    const r = results[agent];
    if (!r) continue;
    const label = agent === 'cursor' ? 'Cursor' : 'Claude';
    if (r.ok) bits.push(label + (r.updated ? ' עודכן' : ' נרשם'));
    else bits.push(label + ': ' + (r.error || 'נכשל'));
  }
  const ok = AGENTS.every((a) => !results[a] || results[a].ok);
  return { ok, message: bits.join(' · '), ...(ok ? {} : { error: bits.filter((b) => b.includes(':')).join(' · ') || bits.join(' · ') }) };
}

/**
 * execFile          — מוזרק, כדי שבדיקה לא תריץ ‎claude‎ אמיתי.
 * cursorConfigPath  — ‎~/.cursor/mcp.json‎ בפועל, תיקייה זמנית בבדיקה.
 */
function createMcpAdmin({ execFile, cursorConfigPath, timeoutMs = 20000 } = {}) {
  async function addClaude(spec) {
    return runClaude(execFile, claudeAddArgs(spec), timeoutMs);
  }

  async function addCursor(spec) {
    const read = readCursorFile(cursorConfigPath);
    if (!read.ok) return read;
    const next = upsertCursorConfig(read.cfg, spec);
    try { writeCursorFile(cursorConfigPath, next.cfg); }
    catch (e) { return { ok: false, error: 'הכתיבה ל-Cursor נכשלה: ' + e.message }; }
    return { ok: true, updated: next.updated };
  }

  async function add(body) {
    const parsed = parseAdd(body);
    if (!parsed.ok) return parsed;
    const spec = parsed.spec;
    const results = {};
    if (spec.agents.includes('claude')) results.claude = await addClaude(spec);
    if (spec.agents.includes('cursor')) results.cursor = await addCursor(spec);
    return { ...summarize(results), results };
  }

  async function remove(body) {
    const parsed = parseRemove(body);
    if (!parsed.ok) return parsed;
    if (parsed.agent === 'cursor') {
      const read = readCursorFile(cursorConfigPath);
      if (!read.ok) return read;
      const next = removeCursorConfig(read.cfg, parsed.name);
      if (!next.ok) return next;
      try { writeCursorFile(cursorConfigPath, next.cfg); }
      catch (e) { return { ok: false, error: 'הכתיבה ל-Cursor נכשלה: ' + e.message }; }
      return { ok: true, message: 'Cursor הוסר' };
    }
    const r = await runClaude(execFile, ['mcp', 'remove', parsed.name], timeoutMs);
    return r.ok ? { ok: true, message: 'Claude הוסר' } : r;
  }

  return { add, remove };
}

module.exports = createMcpAdmin;
module.exports.splitCommand = splitCommand;
module.exports.parseAdd = parseAdd;
module.exports.parseRemove = parseRemove;
module.exports.claudeAddArgs = claudeAddArgs;
module.exports.upsertCursorConfig = upsertCursorConfig;
module.exports.removeCursorConfig = removeCursorConfig;
