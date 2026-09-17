'use strict';
/* ==========================================================================
   מה הסוכן יודע לעשות — שרתי MCP ופקודות סלאש
   --------------------------------------------------------------------------
   שתי רשימות שהממשק שואל עליהן, ושתיהן נקראות מבחוץ ולא מוגדרות כאן: שרתי
   ה-MCP מגיעים מ-‎claude mcp list‎ (ומ-‎.cursor/mcp.json‎ לסוכן השני), ופקודות
   הסלאש הן קבצי ‎.md‎ שמפוזרים בתיקיות.

   מה שהצדיק את החילוץ אינו האורך אלא זה: **שתיהן קוראות מהדיסק ומהתהליכים
   של המשתמש ולא הייתה להן אף בדיקה.** הסריקה יורדת לעומק שמונה רמות, עוקבת
   אחרי קישורים סימבוליים, ומפענחת frontmatter — שלושה מקומות שבהם תקלה
   נראית כמו "התפריט ריק" ולא כמו שגיאה.

   שלוש התכונות שהמודול קיים כדי לשמור, וכולן נבדקות ב-
   ‎test/agent-capabilities.test.mjs‎:

     • **לולאת קישורים סימבוליים אינה תולה.** ‎realpath‎ ורשימת ביקורים,
       ולא רק תקרת עומק: תיקייה שמצביעה על עצמה היא ספרייה אחת למעלה מכל
       תקרה שנבחר.
     • **קריאה אחת ל-CLI גם כשנשאלים במקביל.** ‎claude mcp list‎ הוא תהליך
       שעולה 15 שניות בגבול; חמישה מכשירים שמרעננים יחד לא אמורים להריץ
       חמישה כאלה.
     • **תיאור שנקרא גם בלי frontmatter.** קובץ פקודה שנכתב ביד לרוב אינו
       מתחיל ב-‎---‎, והנפילה לשורה הראשונה היא מה שמונע תפריט של שמות בלי
       שום הסבר.
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');

/* הפקודות שה-CLI מכיר מעצמו. ‎client: true‎ = הממשק מטפל בה בעצמו ולא שולח
   אותה הלאה. */
const BUILTIN_COMMANDS = [
  { name: '/clear', desc: 'שיחה חדשה (מנקה הקשר)', client: true },
  { name: '/compact', desc: 'דחיסת ההקשר לסיכום קצר' },
  { name: '/init', desc: 'יצירת קובץ CLAUDE.md לפרויקט' },
  { name: '/review', desc: 'סקירת קוד של השינויים' },
  { name: '/security-review', desc: 'סקירת אבטחה של השינויים' },
  { name: '/pr-comments', desc: 'קריאת תגובות על ה-PR' },
  { name: '/rc', desc: 'Remote Control — שליטה במחשב מ-claude.ai/code ומהנייד', client: true },
];

const MAX_DEPTH = 8;

/**
 * הפלט של ‎claude mcp list‎ → רשימת שרתים. שורה שאינה מתאימה נבלעת.
 *
 * הכישלון נבדק **לפני** ההצלחה, וזה לא סגנון: ‎Disconnected‎ *מכיל* את
 * ‎connected‎, ולכן ‎/✔|connected/i‎ לבדו סימן שרת מנותק כמחובר — בדיוק
 * ההפך ממה שהמסך נועד להראות.
 */
function parseMcpList(stdout) {
  const servers = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^([^:]+):\s*(.*?)\s*-\s*(✔|✗|.*?(?:Connected|Failed|Disconnected|error).*)$/i);
    if (!m) continue;
    const status = m[3];
    const failed = /✗|disconnected|failed|error|timeout/i.test(status);
    servers.push({
      name: m[1].trim(),
      url: m[2].trim(),
      connected: !failed && /✔|connected/i.test(status),
    });
  }
  return servers;
}

/** התיאור של קובץ פקודה: ‎description:‎ מה-frontmatter, ואם אין — השורה הראשונה. */
function describeCommandFile(text) {
  const fm = String(text).match(/^---[\s\S]*?description:\s*(.+)$[\s\S]*?---/m);
  if (fm) return fm[1].trim();
  return (String(text).split('\n').find((l) => l.trim() && !l.startsWith('---')) || '').slice(0, 80);
}

/**
 * אוסף קובצי ‎.md‎ מתוך תיקייה, רקורסיבית, אל ‎out‎.
 * ‎visited‎ מחזיק נתיבים *אמיתיים* (‎realpath‎) ולא את מה שנמסר: בלי זה
 * קישור סימבולי שמצביע על אב הוא לולאה אינסופית, ותקרת העומק לבדה רק
 * הופכת אותה לאיטית במקום לאינסופית.
 */
function scanCommands(dir, scope, out, visited = new Set(), depth = 0) {
  if (depth > MAX_DEPTH) return out;
  let real;
  try { real = fs.realpathSync(dir); } catch { return out; }
  if (visited.has(real)) return out;
  visited.add(real);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) scanCommands(path.join(dir, e.name), scope, out, visited, depth + 1);
    else if (e.name.endsWith('.md')) {
      let desc = '';
      try { desc = describeCommandFile(fs.readFileSync(path.join(dir, e.name), 'utf8')); } catch {}
      out.push({ name: '/' + e.name.replace(/\.md$/, ''), desc, scope, custom: true });
    }
  }
  return out;
}

/**
 * execFile — מוזרק כדי שהבדיקה לא תריץ ‎claude‎ אמיתי.
 * cursor   — הגשר ל-Cursor; ‎mcpList‎/‎listCommands‎ ממנו.
 * home     — ‎os.homedir()‎ בפועל, מוזרק לבידוד.
 * now      — שעון מוזרק, לבדיקת תוקף המטמון.
 */
module.exports = function createAgentCapabilities({
  execFile, cursor = null, home, ttlMs = 30000, now = Date.now, timeoutMs = 15000,
} = {}) {
  let cache = { t: 0, data: null };
  let inflight = null;

  /**
   * רשימת שרתי ה-MCP של שני הסוכנים. ממוזגת, ממוטמנת, ומאוחדת: קריאה
   * בזמן שקריאה אחרת באוויר מקבלת את אותה תשובה ולא מריצה תהליך שני.
   */
  function mcpList() {
    if (cache.data && now() - cache.t < ttlMs) return Promise.resolve(cache.data);
    if (inflight) return inflight;
    inflight = new Promise((resolve) => {
      execFile('claude', ['mcp', 'list'], { timeout: timeoutMs }, async (err, stdout) => {
        const servers = parseMcpList(stdout);
        // שרתי ה-MCP של Cursor הם רשימה נפרדת לגמרי (‎.cursor/mcp.json‎). הם
        // מוצגים באותו מסך ומסומנים בשם הסוכן, כדי שיהיה ברור למי כל שרת זמין.
        let cur = [];
        try { cur = cursor ? await cursor.mcpList() : []; } catch {}
        for (const c of cur) {
          servers.push({ name: c.name, url: c.detail || '', connected: c.status === 'connected', agent: 'cursor' });
        }
        const data = { servers, raw: String(stdout || '').trim() };
        cache = { t: now(), data };
        inflight = null;
        resolve(data);
      });
    });
    return inflight;
  }

  /**
   * תפריט ה-'/'. ‎agent‎ קובע איזה תפריט — ל-Cursor אין את הפקודות המובנות
   * של Claude (‎/compact‎, ‎/rc‎…) ואין לו ‎.claude/commands‎; מה שממלא שם את
   * התפקיד הוא skills. הצגת התפריט הלא-נכון מציעה פקודות שפשוט לא יקרו.
   */
  function listCommands(root, agent) {
    if (agent === 'cursor') {
      try { return { commands: cursor ? cursor.listCommands(root) : [], agent: 'cursor' }; }
      catch { return { commands: [], agent: 'cursor' }; }
    }
    const out = [];
    scanCommands(path.join(root, '.claude', 'commands'), 'פרויקט', out);
    scanCommands(path.join(home, '.claude', 'commands'), 'אישי', out);
    return { commands: [...BUILTIN_COMMANDS, ...out] };
  }

  return { mcpList, listCommands, BUILTIN_COMMANDS, _peek: () => ({ cached: !!cache.data, inflight: !!inflight }) };
};

module.exports.BUILTIN_COMMANDS = BUILTIN_COMMANDS;
module.exports.parseMcpList = parseMcpList;
module.exports.describeCommandFile = describeCommandFile;
module.exports.scanCommands = scanCommands;
module.exports.MAX_DEPTH = MAX_DEPTH;
