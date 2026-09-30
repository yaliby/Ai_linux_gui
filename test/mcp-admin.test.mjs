/**
 * רישום שרת MCP לשני הסוכנים (`lib/mcp-admin.js`).
 *   node test/mcp-admin.test.mjs
 *
 * מה שנשמר כאן: הפקודה לא עוברת דרך מעטפת, קובץ Cursor לא מאבד שרתים
 * אחרים, וכישלון של סוכן אחד לא מוחק רישום שכבר הצליח אצל השני.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const createMcpAdmin = require('../lib/mcp-admin.js');
const {
  splitCommand, parseAdd, claudeAddArgs, upsertCursorConfig, removeCursorConfig,
} = createMcpAdmin;

const t = runner('רישום שרתי MCP');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-mcp-'));
const FILE = path.join(DIR, 'mcp.json');
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

t.section('פיצול פקודה');
{
  t.eq('רווחים', splitCommand('npx -y pkg'), ['npx', '-y', 'pkg']);
  t.eq('מרכאות שומרות רווח', splitCommand('cmd "a b" \'c d\''), ['cmd', 'a b', 'c d']);
  t.eq('מרכאה פתוחה', splitCommand('cmd "לא נסגר'), null);
  t.eq('ריק', splitCommand('   '), []);
}

t.section('מה מותר לרשום');
{
  const both = parseAdd({ name: 'blender', command: 'blender-mcp', agents: ['claude', 'cursor'] });
  t.eq('stdio לשניהם', [both.ok, both.spec.command, both.spec.agents], [true, 'blender-mcp', ['claude', 'cursor']]);
  t.eq('הארגומנטים של Claude', claudeAddArgs(both.spec),
    ['mcp', 'add', '--scope', 'user', 'blender', '--', 'blender-mcp']);

  const http = parseAdd({ name: 'remote', transport: 'http', url: 'https://example.com/mcp', agents: ['claude'] });
  t.eq('http', claudeAddArgs(http.spec),
    ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'remote', 'https://example.com/mcp']);

  t.eq('בלי סוכן', parseAdd({ name: 'a', command: 'b', agents: [] }).ok, false);
  t.eq('שם עם רווח', parseAdd({ name: 'my server', command: 'b', agents: ['claude'] }).ok, false);
  t.eq('כתובת שהיא לא http', parseAdd({ name: 'a', transport: 'http', url: 'file:///tmp/x', agents: ['cursor'] }).ok, false);
  t.eq('פקודה שמתחילה בדגל', parseAdd({ name: 'a', command: '-rf /', agents: ['claude'] }).ok, false);
  t.eq('שורה חדשה בפקודה', parseAdd({ name: 'a', command: 'ok\nrm', agents: ['claude'] }).ok, false);
}

t.section('קובץ Cursor לא נדרס');
{
  const { cfg, updated } = upsertCursorConfig(
    { mcpServers: { other: { command: 'keep' } }, extra: 1 },
    { name: 'blender', transport: 'stdio', command: 'blender-mcp', args: [] },
  );
  t.eq('השרת הישן נשאר', cfg.mcpServers.other.command, 'keep');
  t.eq('החדש נוסף', cfg.mcpServers.blender.command, 'blender-mcp');
  t.eq('מפתח זר נשאר', cfg.extra, 1);
  t.eq('זאת הוספה', updated, false);
  const again = upsertCursorConfig(cfg, { name: 'blender', transport: 'stdio', command: 'other-bin', args: ['--x'] });
  t.eq('אותו שם מתעדכן', again.updated, true);
  t.eq('עם ארגומנטים', again.cfg.mcpServers.blender.args, ['--x']);
  const gone = removeCursorConfig(again.cfg, 'blender');
  t.eq('הסרה משאירה את השכן', Object.keys(gone.cfg.mcpServers), ['other']);
  t.eq('שם שאינו שם', removeCursorConfig(gone.cfg, 'אין').ok, false);
}

t.section('רישום בפועל, בלי ה-CLI האמיתי');
{
  const calls = [];
  const admin = createMcpAdmin({
    cursorConfigPath: FILE,
    execFile: (cmd, args, opts, cb) => { calls.push([cmd, args]); cb(null, '', ''); },
  });
  const r = await admin.add({
    name: 'blender', command: 'npx -y blender-mcp', agents: ['claude', 'cursor'],
  });
  t.eq('שניהם הצליחו', r.ok, true);
  t.eq('Claude קיבל מערך, לא מחרוזת למעטפת', calls[0],
    ['claude', ['mcp', 'add', '--scope', 'user', 'blender', '--', 'npx', '-y', 'blender-mcp']]);
  const disk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  t.eq('Cursor נכתב לדיסק', disk.mcpServers.blender, { command: 'npx', args: ['-y', 'blender-mcp'] });

  calls.length = 0;
  const fail = createMcpAdmin({
    cursorConfigPath: FILE,
    execFile: (cmd, args, opts, cb) => cb(new Error('קיים'), '', 'already exists'),
  });
  const part = await fail.add({ name: 'other', command: 'true', agents: ['claude', 'cursor'] });
  t.eq('Claude נכשל', part.results.claude.ok, false);
  t.eq('ו-Cursor עדיין נרשם', part.results.cursor.ok, true);
  t.eq('התשובה כולה לא ירוקה', part.ok, false);
  t.ok('השגיאה מזכירה את Claude', /Claude/.test(part.error), part.error);
  t.eq('השרת השני על הדיסק', JSON.parse(fs.readFileSync(FILE, 'utf8')).mcpServers.other.command, 'true');

  const rm = await admin.remove({ name: 'blender', agent: 'cursor' });
  t.eq('הסרה מ-Cursor', rm.ok, true);
  t.eq('בלי לקרוא ל-claude', calls.length, 0);
  t.eq('השכן נשאר', Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).mcpServers), ['other']);

  const broken = path.join(DIR, 'bad.json');
  fs.writeFileSync(broken, '{');
  const bad = createMcpAdmin({
    cursorConfigPath: broken,
    execFile: (cmd, args, opts, cb) => cb(null, '', ''),
  });
  const refused = await bad.add({ name: 'x', command: 'y', agents: ['cursor'] });
  t.eq('JSON שבור לא נדרס', refused.ok, false);
  t.eq('הקובץ נשאר שבור', fs.readFileSync(broken, 'utf8'), '{');
}

t.section('הממשק מציע את שני הסוכנים');
{
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  t.ok('מתג לכל אחד משני הסוכנים', /for \(const agent of \['claude', 'cursor'\]\)/.test(app));
  t.ok('המתג נרשם על הכפתור', /b\.dataset\.agent = agent/.test(app));
  t.ok('שניהם דולקים בהתחלה', /aria-pressed', 'true'/.test(app));
  t.ok('הטופס שולח אל /api/mcp', app.includes("fetch('/api/mcp'"));
  t.ok('ההסרה שולחת את הסוכן', app.includes("fetch('/api/mcp/remove'"));
  t.ok('השרת רושם', srv.includes("app.post('/api/mcp'"));
  t.ok('והוא מוחק לפי סוכן', srv.includes("app.post('/api/mcp/remove'"));
}

t.done();
