/**
 * שרתי MCP ופקודות סלאש (`lib/agent-capabilities.js`).
 *   node test/agent-capabilities.test.mjs
 *
 * שתי הרשימות האלה נקראות מהדיסק ומהתהליכים של המשתמש, ולא הייתה להן אף
 * בדיקה. מה שנבדק כאן הוא בדיוק המקומות שבהם תקלה נראית כמו "התפריט ריק"
 * ולא כמו שגיאה:
 *
 *   • לולאת קישורים סימבוליים — ‎realpath‎ ורשימת ביקורים, ולא רק תקרת עומק.
 *   • ‎claude mcp list‎ נקרא פעם אחת גם כששואלים במקביל, וממוטמן אחר כך.
 *   • תיאור פקודה נקרא גם בלי frontmatter, אחרת התפריט הוא שמות בלי הסבר.
 *
 * בסוף יש מעבר דרך המסלול האמיתי (‎/api/commands‎ על השרת), כי מודול שנבדק
 * לבדו ואינו מחובר אינו שדרוג.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const createAgentCaps = require('../lib/agent-capabilities.js');
const { parseMcpList, describeCommandFile, scanCommands, BUILTIN_COMMANDS, MAX_DEPTH } = createAgentCaps;

const t = runner('שרתי MCP ופקודות סלאש');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-caps-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-caps-home-'));
process.on('exit', () => {
  for (const d of [ROOT, HOME]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ---------------------------------------------------------------------------
t.section('פענוח הפלט של claude mcp list');
{
  const out = parseMcpList([
    'playwright: https://mcp.example/sse - ✔ Connected',
    'github: npx -y @gh/mcp - ✗ Failed to connect',
    'linear: https://linear.app/sse - Disconnected',
    '',
    'Checking MCP server health...',
  ].join('\n'));
  t.eq('שלושה שרתים', out.length, 3);
  t.eq('הראשון מחובר', [out[0].name, out[0].url, out[0].connected], ['playwright', 'https://mcp.example/sse', true]);
  t.eq('השני לא', [out[1].name, out[1].connected], ['github', false]);
  // ‎Disconnected‎ *מכיל* את ‎connected‎ — הבדיקה הזאת תפסה שרת מנותק שהוצג כמחובר
  t.eq('גם Disconnected אינו מחובר', out[2].connected, false);
  t.eq('גם error אינו מחובר', parseMcpList('x: u - connection error')[0].connected, false);
  // סטטוס שאינו באוצר המילים של הביטוי — השורה נבלעת ולא הופכת לשרת מדומה
  t.eq('סטטוס לא מוכר נבלע', parseMcpList('x: u - Pending').length, 0);
  t.eq('ו-✔ לבדו כן', parseMcpList('x: u - ✔')[0].connected, true);
  // שורת כותרת ושורה ריקה אינן שרת, וחשוב שלא ייכנסו כשרת בשם מוזר
  t.eq('רעש נבלע', parseMcpList('Checking MCP server health...\n\n').length, 0);
  t.eq('פלט ריק', parseMcpList('').length, 0);
  t.eq('undefined לא מפיל', parseMcpList(undefined).length, 0);
}

// ---------------------------------------------------------------------------
t.section('תיאור של קובץ פקודה');
{
  t.eq('מתוך frontmatter',
    describeCommandFile('---\nname: x\ndescription: סוקר את הדיף\n---\n\n# כותרת\nגוף'), 'סוקר את הדיף');
  // קובץ שנכתב ביד לרוב אינו מתחיל ב-‎---‎; בלי הנפילה הזאת התפריט הוא שמות בלבד
  t.eq('בלי frontmatter — השורה הראשונה', describeCommandFile('תריץ את הבדיקות\nושורה שנייה'), 'תריץ את הבדיקות');
  t.eq('שורות ריקות בהתחלה מדולגות', describeCommandFile('\n\n  \nהשורה האמיתית'), 'השורה האמיתית');
  t.eq('קובץ ריק', describeCommandFile(''), '');
  t.ok('שורה ארוכה נקטמת ל-80', describeCommandFile('א'.repeat(300)).length === 80);
}

// ---------------------------------------------------------------------------
t.section('סריקת תיקיות הפקודות');
{
  write(path.join(ROOT, '.claude/commands/deploy.md'), '---\ndescription: מעלה לייצור\n---\nגוף');
  write(path.join(ROOT, '.claude/commands/test.md'), 'מריץ את כל הבדיקות');
  write(path.join(ROOT, '.claude/commands/nested/deep.md'), 'פקודה מקוננת');
  write(path.join(ROOT, '.claude/commands/README.txt'), 'לא פקודה');
  write(path.join(HOME, '.claude/commands/mine.md'), '---\ndescription: אישית\n---');

  const out = scanCommands(path.join(ROOT, '.claude/commands'), 'פרויקט', []);
  const names = out.map((c) => c.name).sort();
  t.eq('רק קובצי md', names, ['/deep', '/deploy', '/test']);
  t.eq('תיאור מה-frontmatter', out.find((c) => c.name === '/deploy').desc, 'מעלה לייצור');
  t.eq('ותיאור מהשורה הראשונה', out.find((c) => c.name === '/test').desc, 'מריץ את כל הבדיקות');
  t.eq('כולן מסומנות בהיקף', [...new Set(out.map((c) => c.scope))], ['פרויקט']);
  t.eq('וכמותאמות אישית', out.every((c) => c.custom === true), true);

  t.eq('תיקייה שאינה קיימת מחזירה ריק', scanCommands(path.join(ROOT, 'אין-כזו'), 'פרויקט', []).length, 0);
}

// ---------------------------------------------------------------------------
/* תיקייה שמצביעה על אב היא לולאה אינסופית; תקרת עומק לבדה רק הופכת אותה
   מאינסופית לאיטית, ועדיין מייצרת את אותה פקודה שוב ושוב בתפריט. */
t.section('לולאת קישורים סימבוליים');
{
  const loop = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-caps-loop-'));
  process.on('exit', () => { try { fs.rmSync(loop, { recursive: true, force: true }); } catch {} });
  write(path.join(loop, 'a.md'), 'פקודה');
  fs.mkdirSync(path.join(loop, 'sub'));
  write(path.join(loop, 'sub/b.md'), 'עוד אחת');
  let linked = true;
  try { fs.symlinkSync(loop, path.join(loop, 'sub', 'back'), 'dir'); } catch { linked = false; }

  if (!linked) { t.ok('אין הרשאה לקישור סימבולי — מדולג', true); }
  else {
    const started = Date.now();
    const out = scanCommands(loop, 'פרויקט', []);
    t.ok('הסריקה הסתיימה ולא נתלתה', Date.now() - started < 4000, Date.now() - started);
    // כל קובץ בדיוק פעם אחת: ‎visited‎ על ה-realpath הוא מה שמבטיח את זה
    const names = out.map((c) => c.name).sort();
    t.eq('כל פקודה פעם אחת בלבד', names, ['/a', '/b']);
  }

  // ותקרת העומק קיימת בנוסף, בשביל היררכיה עמוקה אמיתית
  let deep = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-caps-deep-'));
  const deepRoot = deep;
  process.on('exit', () => { try { fs.rmSync(deepRoot, { recursive: true, force: true }); } catch {} });
  for (let i = 0; i <= MAX_DEPTH + 3; i++) {
    deep = path.join(deep, 'd' + i);
    fs.mkdirSync(deep);
    fs.writeFileSync(path.join(deep, 'c' + i + '.md'), 'עומק ' + i);
  }
  const found = scanCommands(deepRoot, 'פרויקט', []).map((c) => c.name);
  // השורש הוא עומק 0 ואין בו ‎.md‎; ‎d0‎ יושב בעומק 1, ולכן נסרקים ‎MAX_DEPTH‎ קבצים
  t.eq('נעצר בתקרת העומק', found.length, MAX_DEPTH);
  t.ok('ומה שנמצא הוא הרמות העליונות', found.includes('/c0') && !found.includes('/c' + (MAX_DEPTH + 3)), found);
}

// ---------------------------------------------------------------------------
t.section('התפריט המלא');
{
  const caps = createAgentCaps({ execFile: () => {}, home: HOME, cursor: null });
  const { commands } = caps.listCommands(ROOT);
  t.ok('כולל את המובנות', commands.slice(0, BUILTIN_COMMANDS.length).every((c, i) => c.name === BUILTIN_COMMANDS[i].name));
  t.ok('ואת של הפרויקט', commands.some((c) => c.name === '/deploy' && c.scope === 'פרויקט'));
  t.ok('ואת האישיות', commands.some((c) => c.name === '/mine' && c.scope === 'אישי'));
  t.eq('‎/clear‎ מסומנת כמטופלת בלקוח', commands.find((c) => c.name === '/clear').client, true);

  // Cursor הוא תפריט אחר לגמרי — פקודות Claude שם פשוט לא יקרו
  const withCursor = createAgentCaps({
    execFile: () => {}, home: HOME,
    cursor: { listCommands: () => [{ name: '/cursor-thing', desc: 'skill' }] },
  });
  const cur = withCursor.listCommands(ROOT, 'cursor');
  t.eq('מסומן כסוכן אחר', cur.agent, 'cursor');
  t.eq('ובלי המובנות של Claude', cur.commands.map((c) => c.name), ['/cursor-thing']);

  const broken = createAgentCaps({
    execFile: () => {}, home: HOME,
    cursor: { listCommands: () => { throw new Error('אין קובץ'); } },
  });
  t.eq('גשר שנופל מחזיר ריק ולא מפיל', broken.listCommands(ROOT, 'cursor').commands, []);
}

// ---------------------------------------------------------------------------
/* ‎claude mcp list‎ הוא תהליך שעולה עד 15 שניות. חמישה מכשירים שמרעננים
   יחד לא אמורים להריץ חמישה כאלה. */
t.section('קריאה אחת ל-CLI, גם במקביל');
{
  let calls = 0;
  let clock = 1_000_000;
  const caps = createAgentCaps({
    home: HOME, now: () => clock, ttlMs: 30000,
    execFile: (cmd, args, opts, cb) => { calls++; setTimeout(() => cb(null, 'a: u - ✔ Connected'), 30); },
    cursor: { mcpList: async () => [{ name: 'cur', detail: 'd', status: 'connected' }] },
  });

  const [a, b, c] = await Promise.all([caps.mcpList(), caps.mcpList(), caps.mcpList()]);
  t.eq('שלוש קריאות במקביל → תהליך אחד', calls, 1);
  t.eq('וכולן קיבלו את אותה תשובה', [a === b, b === c], [true, true]);
  t.eq('שני השרתים מוזגו', a.servers.map((s) => s.name), ['a', 'cur']);
  t.eq('ושל Cursor מסומן', a.servers[1].agent, 'cursor');
  t.eq('הפלט הגולמי נשמר', a.raw, 'a: u - ✔ Connected');

  await caps.mcpList();
  t.eq('בתוך התוקף — מהמטמון', calls, 1);
  clock += 31000;
  await caps.mcpList();
  t.eq('אחרי שפג — קריאה חדשה', calls, 2);

  // ה-CLI שאינו מותקן: ‎err‎ מלא ו-stdout ריק. עדיין רוצים את שרתי Cursor.
  const noCli = createAgentCaps({
    home: HOME,
    execFile: (cmd, args, opts, cb) => cb(new Error('ENOENT'), ''),
    cursor: { mcpList: async () => [{ name: 'רק-cursor', detail: '', status: 'connected' }] },
  });
  const r = await noCli.mcpList();
  t.eq('בלי claude — עדיין מקבלים את Cursor', r.servers.map((s) => s.name), ['רק-cursor']);

  const bothDown = createAgentCaps({
    home: HOME,
    execFile: (cmd, args, opts, cb) => cb(new Error('ENOENT'), ''),
    cursor: { mcpList: async () => { throw new Error('אין'); } },
  });
  t.eq('שניהם נופלים — רשימה ריקה ולא חריגה', (await bothDown.mcpList()).servers, []);
}

// ---------------------------------------------------------------------------
/* מודול שנבדק לבדו ואינו מחובר אינו שדרוג. זה המעבר דרך המסלול האמיתי. */
t.section('דרך השרת עצמו');
{
  const { startServer, freePort } = await import('./browser.mjs');
  const PORT = freePort();
  const srv = await startServer({ port: PORT, conversations: [] });
  try {
    // ‎.claude/commands‎ בתוך תיקיית העבודה שנשלחת ב-cwd
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-caps-proj-'));
    write(path.join(proj, '.claude/commands/via-http.md'), '---\ndescription: דרך הרשת\n---');

    const url = srv.url.replace(/\/$/, '');
    const agent = url.startsWith('https')
      ? new (await import('node:https')).Agent({ rejectUnauthorized: false })
      : undefined;
    const get = async (p) => {
      const r = await fetch(url + p, agent ? { dispatcher: undefined, agent } : undefined)
        .catch(async () => {
          // ‎fetch‎ של node לא מקבל ‎agent‎; ליפול ל-https הגולמי
          const https = await import('node:https');
          return new Promise((res, rej) => {
            https.get(url + p, { rejectUnauthorized: false }, (x) => {
              const c = []; x.on('data', (d) => c.push(d));
              x.on('end', () => res({ ok: x.statusCode < 400, json: async () => JSON.parse(Buffer.concat(c).toString('utf8')) }));
            }).on('error', rej);
          });
        });
      return r.json();
    };

    const j = await get('/api/commands?cwd=' + encodeURIComponent(proj));
    t.ok('המסלול עונה', Array.isArray(j.commands), j);
    t.ok('עם המובנות', j.commands.some((c) => c.name === '/compact'), j.commands.slice(0, 3));
    t.ok('ועם הפקודה שעל הדיסק', j.commands.some((c) => c.name === '/via-http' && c.desc === 'דרך הרשת'), j.commands.filter((c) => c.custom));

    const cur = await get('/api/commands?agent=cursor&cwd=' + encodeURIComponent(proj));
    t.eq('ותפריט Cursor מסומן ככזה', cur.agent, 'cursor');

    const mcp = await get('/api/mcp');
    t.ok('‎/api/mcp‎ מחזיר מבנה תקין', Array.isArray(mcp.servers) && typeof mcp.raw === 'string', mcp);

    fs.rmSync(proj, { recursive: true, force: true });
  } finally {
    srv.stop();
  }
}

t.done();
