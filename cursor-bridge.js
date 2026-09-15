/* ==========================================================================
   גשר ל-cursor-agent
   --------------------------------------------------------------------------
   ה-CLI של Cursor מדבר stream-json משלו, ושונה מ-Claude Code בשלוש נקודות
   שקובעות את כל המבנה כאן:

   1. הוא חד-פעמי. אין ‎--input-format stream-json‎ ואין תהליך שיושב ומחכה
      לתור הבא — כל פרומפט הוא הרצה חדשה, וההקשר נשמר בצד שלו ומשוחזר
      ב---resume <chatId>. לכן מה שמוחזר מכאן אינו תהליך אלא *חיקוי* של
      תהליך: אובייקט שמתנהג כמו child process אחד שחי לאורך כל השיחה, ומתחתיו
      מתחלפים תהליכים לפי תורות. כך כל מה שהשרת כבר יודע לעשות — תור, עצירות,
      מכסה, נוכחות, כתיבה לדיסק — עובד בלי לדעת שמדובר בסוכן אחר.

   2. סכמת האירועים שלו אחרת. במקום לפזר את התרגום על פני השרת והדפדפן,
      הוא נעשה כולו כאן: מה שיוצא מ-stdout של החיקוי הוא סכמת Claude, שורה
      שורה. הדפדפן לא יודע שהוא מרנדר Cursor, ואין בו ולו ענף אחד שמפצל
      ביניהם.

   3. אין לו פרוטוקול הרשאות אינטראקטיבי במצב ‎--print‎. כלי שדורש אישור פשוט
      *נדחה* (result.rejected) והמודל מנסה שוב עד שהוא מוותר. לכן ההרשאות כאן
      נקבעות מראש בדגלי ההרצה ולא בכרטיס על המסך — ראו PERM_MODES.
   ========================================================================== */
'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const https = require('https');
const { PassThrough } = require('stream');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const BIN = process.env.CURSOR_AGENT_BIN || 'cursor-agent';
/** כל מזהי המודלים של Cursor נושאים את הקידומת הזו לאורך כל המערכת: היא מה
 *  שמבדיל אותם ממודל Anthropic ישיר בעל אותו שם, והיא הבסיס ל-transportOf. */
const PREFIX = 'cursor/';

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };

const isCursorModel = (id) => typeof id === 'string' && id.startsWith(PREFIX);
const bareModel = (id) => (isCursorModel(id) ? id.slice(PREFIX.length) : id || '');

/* ==========================================================================
   מצבי הרשאה
   --------------------------------------------------------------------------
   אלה לא אותם מצבים של Claude, ואין טעם להעמיד פנים שכן. 'default' נשאר
   ברשימה כי הוא מה שמכבד את רשימת ההיתר ב-~/.cursor/cli-config.json, אבל הוא
   *לא* ברירת המחדל כאן: בהרצה לא-אינטראקטיבית הוא דוחה בשקט כל כלי שאינו
   ברשימה, והמסך היה מראה מודל שמנסה שוב ושוב בלי להסביר למה. ברירת המחדל היא
   force — זו גם ההתנהגות שמשתמש שבחר להריץ סוכן מתוך הממשק הזה מצפה לה.
   ========================================================================== */
const PERM_MODES = ['force', 'autoReview', 'default', 'plan', 'ask'];
const PERM_DEFAULT = 'force';
const permArgs = (mode) => {
  switch (mode) {
    case 'plan': return ['--mode', 'plan'];
    case 'ask': return ['--mode', 'ask'];
    case 'autoReview': return ['--auto-review'];
    case 'default': return [];
    default: return ['--force'];
  }
};

/* ==========================================================================
   רשימת המודלים
   ========================================================================== */
const MODELS_CACHE = path.join(os.homedir(), '.claude', 'rtl-claude', 'cursor-models.json');

/**
 * המשפחה שאליה שייך מודל של Cursor, לפי מזההו. החלוקה הזו אינה קישוט: גם אחרי
 * הכיווץ יש עשרות מודלים, וקבוצה אחת ארוכה היא רשימה שאי-אפשר לסרוק בעין.
 */
const FAMILIES = [
  ['Claude', /claude|opus|sonnet|haiku|fable/i],
  ['GPT · Codex', /gpt|codex|(^|[-_])o[1-4]($|[-_])/i],
  ['Grok', /grok/i],
  ['Gemini', /gemini|nano-banana/i],
  ['Composer', /composer|cheetah/i],
  ['DeepSeek', /deepseek/i],
  ['Qwen', /qwen/i],
  ['Kimi', /kimi|moonshot/i],
  ['GLM', /glm/i],
];
const CURSOR_GROUP = 'Cursor · סוכן CLI';
function familyOf(id) {
  const leaf = bareModel(id);
  if (/^(auto|default)$/i.test(leaf)) return CURSOR_GROUP;   // 'Auto' הוא הראשון, ולבדו
  for (const [fam, re] of FAMILIES) if (re.test(leaf)) return CURSOR_GROUP + ' · ' + fam;
  return CURSOR_GROUP + ' · נוספים';
}

/** ‎--list-models‎ מדפיס `id - שם מוצג` ותו לא; כותרות ושורות ריקות נופלות מעצמן. */
function parseModels(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const m = raw.match(/^\s*([A-Za-z0-9][\w.\-]*)\s+-\s+(.+?)\s*$/);
    if (!m) continue;
    const id = m[1];
    // "(current, default)" הוא סימון מצב, לא חלק מהשם
    const name = m[2].replace(/\s*\((?:current,?\s*)?default\)\s*$/i, '').trim();
    out.push({ id, name: name || id });
  }
  return out;
}

/* --------------------------------------------------------------------------
   כיווץ הווריאנטים
   --------------------------------------------------------------------------
   ‎--list-models‎ מחזיר 223 שורות, אבל אין שם 223 מודלים: רמת המאמץ ותג ה-fast
   אפויים בתוך המזהה (‎gpt-5.3-codex-low-fast‎). רשימה כזו אי-אפשר לסרוק, והיא
   גם משקרת — היא מציגה כמודלים נפרדים את מה שהוא בורר אחד ועוד בורר.

   לכן הם מכווצים חזרה לשני הצירים שמהם הורכבו: מודל בבורר המודלים, ומאמץ
   בבורר המאמץ — בדיוק אותם חמישה ערכים שהממשק כבר מכיר מ-Claude. ה-fast נשאר
   חלק מזהות המודל (הוא מסלול, לא עוצמה), ולכן הוא נשאר שורה משלו.
   -------------------------------------------------------------------------- */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_RE = new RegExp('-(' + EFFORTS.join('|') + ')$');

/** מפרק מזהה אמיתי לשלושת חלקיו. ‎gpt-5.3-codex-low-fast‎ → codex/low/fast. */
function splitVariant(id) {
  let rest = id;
  const fast = /-fast$/.test(rest);
  if (fast) rest = rest.slice(0, -5);
  const m = rest.match(EFFORT_RE);
  const effort = m ? m[1] : '';
  if (m) rest = rest.slice(0, -(effort.length + 1));
  return { base: rest, effort, fast };
}

/** המזהה שבו הבורר משתמש: הבסיס, ועליו תג ה-fast אם יש. */
const uiIdOf = (base, fast) => PREFIX + base + (fast ? '-fast' : '');

/**
 * השם להצגה לקבוצה. לא נגזר מהטקסט אלא *נבחר*: וריאנט ללא מאמץ נושא את השם
 * הנקי ("Codex 5.3"), ואחריו ‎-high‎ שגם הוא נקי אצל Cursor ("Claude Opus 5 1M",
 * בלי המילה High). רק אם שניהם חסרים נגזר שם מווריאנט אחר בהסרת מילת המאמץ —
 * וגם אז לא בלי ההסתייגות שהיא עלולה לשבת באמצע ("Low Thinking").
 */
const EFFORT_WORD = /\s*\b(Extra High|Very High|Low|Medium|High|Max|Minimal)\b/gi;
function groupName(variants, fast) {
  const pick = variants.find((v) => !v.effort) || variants.find((v) => v.effort === 'high');
  if (pick) return pick.name;
  const any = variants[0];
  const cleaned = String(any.name || '').replace(EFFORT_WORD, ' ').replace(/\s{2,}/g, ' ').trim();
  return cleaned || any.name || any.id;
}

/** ממיר את הרשימה השטוחה לרשימת מודלים לבורר, ולמפת פתרון חזרה למזהה אמיתי. */
function collapse(flat) {
  const groups = new Map();   // uiId → { base, fast, variants[] }
  const real = new Set();
  for (const m of flat) {
    real.add(m.id);
    const { base, effort, fast } = splitVariant(m.id);
    const key = uiIdOf(base, fast);
    if (!groups.has(key)) groups.set(key, { base, fast, variants: [] });
    groups.get(key).variants.push({ ...m, effort });
  }
  const models = [];
  for (const [id, g] of groups) {
    const efforts = EFFORTS.filter((e) => g.variants.some((v) => v.effort === e));
    models.push({
      id,
      name: groupName(g.variants, g.fast),
      group: familyOf(id),
      // מאמץ יחיד אינו בחירה — בורר בן ערך אחד הוא רעש, והמזהה ממילא ייפתר אליו
      efforts: efforts.length > 1 ? efforts : [],
    });
  }
  return { models, real: [...real] };
}

/**
 * מזהה ה-UI ורמת המאמץ → המזהה שבאמת נשלח ל-‎--model‎.
 *
 * הכלל היחיד כאן: לעולם לא להחזיר מזהה שאינו ברשימה האמיתית. ל-45 מתוך 78
 * המודלים אין וריאנט חסר-מאמץ בכלל — ‎cursor-grok-4.6‎ קיים רק כ-‎-low/-medium/
 * -high/-xhigh‎ — ולכן "הבסיס כמו שהוא" הוא שם מומצא, ו-cursor-agent יוצא עליו
 * בקוד 1 עם ‎Cannot use this model‎. הבחירה נופלת לוריאנט שכן קיים.
 */
function resolveModel(uiId, effort, realIds) {
  const bare = bareModel(uiId);
  if (!bare) return '';
  // ‎auto‎ נשלח *במפורש* ולא כהיעדר דגל. בלי ‎--model‎ הרצה עם ‎--resume‎ משחזרת
  // את המודל שהשיחה עבדה איתו קודם, ולכן חזרה ל"Auto" אחרי בחירה ידנית פשוט
  // לא קרתה — הבורר הראה Auto וההרצה המשיכה עם המודל הישן.
  if (bare === 'auto' || bare === 'default') return bare;
  const have = realIds instanceof Set ? realIds : new Set(realIds || []);
  const fast = /-fast$/.test(bare);
  const base = fast ? bare.slice(0, -5) : bare;
  const at = (e) => base + '-' + e + (fast ? '-fast' : '');
  const valid = !!effort && EFFORTS.includes(effort);
  // רשימה ריקה = הגשר עוד לא הספיק לקרוא ל-CLI ואין מטמון. אין מול מה לאמת,
  // ולכן מרכיבים כמיטב היכולת במקום לחסום.
  if (!have.size) return valid ? at(effort) : bare;
  // וריאנט חסר-מאמץ, כשהוא קיים, הוא מה שבחירה ללא מאמץ מתכוונת אליו.
  if (!valid && have.has(bare)) return bare;
  // אחרת יוצאים מ-high — אותה נקודה שממנה groupName גוזר את שם התצוגה, כך
  // שמה שרץ הוא מה שכתוב בבורר — ומחפשים למטה ואז למעלה. מאמץ שנשאר מבחירה
  // קודמת ואינו קיים אצל המודל הזה נפתר באותה הליכה עצמה.
  const want = EFFORTS.indexOf(valid ? effort : 'high');
  if (have.has(at(EFFORTS[want]))) return at(EFFORTS[want]);
  for (let i = want - 1; i >= 0; i--) if (have.has(at(EFFORTS[i]))) return at(EFFORTS[i]);
  for (let i = want + 1; i < EFFORTS.length; i++) if (have.has(at(EFFORTS[i]))) return at(EFFORTS[i]);
  return bare;
}

function loadCache() { try { return JSON.parse(fs.readFileSync(MODELS_CACHE, 'utf8')); } catch { return null; } }
function saveCache(list) {
  try {
    fs.mkdirSync(path.dirname(MODELS_CACHE), { recursive: true });
    fs.writeFileSync(MODELS_CACHE, JSON.stringify(list));
  } catch {}
}

// רשימת המזהים האמיתיים כפי שנקראה לאחרונה — הבסיס ל-resolveModel בכל הרצה
let realIds = new Set((loadCache() || []).map((m) => m.id));

/**
 * מודלי Cursor לבורר. ה-CLI יוצא לרשת כדי לענות, ולכן התשובה נשמרת בדיסק:
 * הבורר מלא גם כשאין רשת, וגם כשהשרת עולה לפני שה-CLI מספיק להתחבר.
 */
function fetchModels() {
  return new Promise((resolve) => {
    execFile(BIN, ['--list-models'], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      let flat = err ? [] : parseModels(stdout);
      if (!flat.length) flat = loadCache() || [];
      else saveCache(flat);
      const { models, real } = collapse(flat);
      realIds = new Set(real);
      resolve(models);
    });
  });
}

/** האם ה-CLI בכלל מותקן ומחובר. נכשל בשקט — היעדרו פשוט מרוקן את הקבוצה בבורר. */
function available() {
  return new Promise((resolve) => {
    execFile(BIN, ['--version'], { timeout: 8000 }, (err) => resolve(!err));
  });
}

/* ==========================================================================
   מכסת החשבון
   --------------------------------------------------------------------------
   ל-cursor-agent אין פקודת usage — לא ב---help ולא בסכמת האירועים. את המספרים
   מחזיק הדשבורד ב-cursor.com, מאחורי עוגיית ‎WorkosCursorSessionToken‎, ואותו
   טוקן בדיוק הוא זה שה-CLI שומר אצלו אחרי ‎cursor-agent login‎. לכן ברוב
   המקרים אין כאן מה להגדיר: אם הסוכן עובד, גם המכסה תגיע. אם החשבון דורש
   עוגייה מהדפדפן (או שה-CLI מחובר לחשבון אחר), מדביקים אותה ב-‎CURSOR_SESSION_TOKEN‎
   והיא גוברת על טוקן ה-CLI.

   מה שמוחזר מכאן הוא *אותה סכמה* של מכסת Claude (‎windows[]‎ עם ‎pct‎ ו-‎resets_at‎),
   בדיוק מאותה סיבה שהגשר מתרגם אירועים: כדי שהדפדפן יצייר מד אחד ולא שניים.
   ========================================================================== */
const AUTH_FILE = path.join(os.homedir(), '.config', 'cursor', 'auth.json');
const DASHBOARD = 'https://cursor.com';

function readCliToken() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).accessToken || null; }
  catch { return null; }
}

/** מזהה ה-WorkOS שהעוגייה נושאת לפני ה-‎::‎ — יושב ב-sub של הטוקן ("auth0|user_01…"). */
function tokenUser(tok) {
  try {
    const claims = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8'));
    const sub = String(claims.sub || '');
    return sub.includes('|') ? sub.split('|').pop() : sub;
  } catch { return ''; }
}

/** ערך העוגייה המלא + מזהה המשתמש, או null כשאין התחברות. */
function sessionCookie() {
  const raw = (process.env.CURSOR_SESSION_TOKEN || '').trim() || readCliToken();
  if (!raw) return null;
  // עוגייה שהודבקה מהדפדפן כבר נושאת את המזהה; טוקן CLI צריך שנרכיב אותו
  if (raw.includes('::')) {
    const user = raw.split('::')[0];
    return user ? { value: raw, user } : null;
  }
  const user = tokenUser(raw);
  return user ? { value: user + '::' + raw, user } : null;
}

/** קריאה בודדת לדשבורד, עם הסטטוס והגוף הגולמי. */
function dashboardRaw(method, route, cookie, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      Cookie: 'WorkosCursorSessionToken=' + cookie,
      Accept: 'application/json',
      'User-Agent': 'rtl-claude',
    };
    // POST לדשבורד דורש Origin של cursor.com — בלעדיו חוזר ‎Invalid origin‎.
    if (method !== 'GET' && method !== 'HEAD') {
      headers.Origin = DASHBOARD;
      headers.Referer = DASHBOARD + '/dashboard';
    }
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request(DASHBOARD + route, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e.message) }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

/** אותה קריאה, מנוקה: כל כישלון — רשת, 401, HTML במקום JSON — מחזיר null. */
async function dashboard(method, route, cookie, body) {
  const r = await dashboardRaw(method, route, cookie, body);
  if (r.status !== 200) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

const CURSOR_PLANS = {
  free: 'Free', free_trial: 'ניסיון', pro: 'Pro', pro_plus: 'Pro+',
  'pro-plus': 'Pro+', ultra: 'Ultra', team: 'Team', enterprise: 'Enterprise',
};
const planName = (p) => (p ? (CURSOR_PLANS[String(p).toLowerCase()] || p) : null);

/** ‎/api/usage‎ הישן לא מחזיר "מתאפס ב" אלא רק את תחילת המחזור. חודש קדימה ממנה. */
function cycleReset(startOfMonth) {
  const t = new Date(startOfMonth);
  if (isNaN(t)) return null;
  const next = new Date(t);
  next.setMonth(next.getMonth() + 1);
  return next.toISOString();
}
const pctOf = (n) => (typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(100, n)) : null);

/**
 * מרכיב את החלונות משתי התשובות, ששייכות לשני דורות של תמחור:
 *
 * ‎summary‎ (‎/api/usage-summary‎) הוא ההווה — מחזור חיוב חודשי עם שני דליים
 *   נפרדים: מודלים כלליים (Claude, GPT, Gemini וכו׳) ומודלים של קרסר
 *   (Auto · Composer). משם מגיע גם מחזור החיוב.
 * ‎legacy‎ (‎/api/usage‎) הוא החשבונות הישנים שנמדדו בבקשות פרימיום. בחשבון
 *   מודרני ‎maxRequestUsage‎ חוזר null, ולכן החלון הזה פשוט לא נוצר.
 * ‎sand‎ (‎/api/dashboard/get-sand-usage-status‎) הוא מכסת Grok Bot השבועית —
 *   דלי נפרד לגמרי מהשימוש הכלול החודשי. נכשל בשקט: בלי זה עדיין יש מדים.
 *
 * האחוזים שמוצגים הם ‎apiPercentUsed‎ ו-‎autoPercentUsed‎ — שני המדים ש-Cursor
 * עצמו מצייר בדשבורד — ולא ‎totalPercentUsed‎ (כותרת מעורבת שאינה תקרה)
 * ולא ‎used/limit‎ (יחידות פנימיות שאין להן שם בממשק שלהם).
 */
function parseCursorUsage(summary, legacy, sand) {
  const windows = [];
  const plan = planName(
    (summary && summary.membershipType) ||
    (legacy && legacy.membershipType) ||
    (sand && sand.cursorPlanName) || null
  );

  const iu = (summary && summary.individualUsage) || {};
  const cycleEnd = (summary && summary.billingCycleEnd) || null;

  if (summary && summary.isUnlimited) {
    windows.push({
      id: 'cursor-included', kind: 'included',
      label: 'שימוש כלול', short: 'כלול',
      pct: 0, detail: 'ללא הגבלה', resets_at: cycleEnd,
    });
  } else if (iu.plan && iu.plan.enabled) {
    /* שני הדליים שהתשובה מודדת בנפרד. הם *אינם* מתחלקים זה בזה: כל אחד
       נמדד מול תקרה משלו, והסה״כ המעורב (‎totalPercentUsed‎) אינו אף אחת
       מהן — לכן הוא לא מוחזר. מודלים כלליים קודמים: זה המד שהמשתמש רואה. */
    const buckets = [
      ['cursor-api', 'מודלים כלליים', 'מודלים כלליים', iu.plan.apiPercentUsed, cycleEnd],
      ['cursor-auto', 'מודלים של קרסר', 'מודלים של קרסר', iu.plan.autoPercentUsed, cycleEnd],
    ];
    for (const [id, label, short, raw, resets] of buckets) {
      const pct = pctOf(raw);
      if (pct == null) continue;
      windows.push({ id, kind: 'included', label, short, pct, resets_at: resets });
    }
  }

  // Grok Bot — מכסה שבועית נפרדת (Sand). רק כשיש תקרה כלולה לאפס.
  if (sand && sand.hasNonZeroIncludedLimit === true && typeof sand.usagePercent === 'number') {
    const pct = pctOf(sand.usagePercent);
    if (pct != null) {
      windows.push({
        id: 'cursor-grok-bot', kind: 'weekly_scoped',
        label: 'גרוק בוט', short: 'גרוק בוט',
        pct, resets_at: sand.nextResetTimestampUtc || null,
      });
    }
  }

  // חיוב לפי שימוש מעבר לכלול — קיים רק כשהמשתמש הדליק אותו, ואז יש גם תקרה
  const od = iu.onDemand;
  if (od && od.enabled && typeof od.used === 'number' && od.limit > 0) {
    windows.push({
      id: 'cursor-ondemand', kind: 'ondemand',
      label: 'חיוב לפי שימוש', short: 'חיוב',
      pct: pctOf((od.used / od.limit) * 100),
      detail: `$${(od.used / 100).toFixed(2)} מתוך תקרה של $${(od.limit / 100).toFixed(2)}`,
      resets_at: cycleEnd,
    });
  }

  const premium = legacy && legacy['gpt-4'];
  if (premium && typeof premium.numRequests === 'number' && premium.maxRequestUsage > 0) {
    windows.push({
      id: 'cursor-requests', kind: 'requests',
      label: 'בקשות פרימיום', short: 'בקשות',
      pct: pctOf((premium.numRequests / premium.maxRequestUsage) * 100),
      detail: `${premium.numRequests} מתוך ${premium.maxRequestUsage} בקשות`,
      resets_at: cycleReset(legacy.startOfMonth),
    });
  }

  if (!windows.length && !plan) return null;
  return { windows, plan, cycle_end: cycleEnd };
}

/**
 * מכסת חשבון Cursor, בסכמת המכסה של הממשק. מחזיר null כשאין התחברות או כשאף
 * קריאה לא החזירה מספרים — המסך מבדיל בין השניים לפי ‎connected‎.
 */
async function fetchUsage() {
  const sess = sessionCookie();
  if (!sess) return null;
  // ‎sand‎ נכשל בשקט (null) — המדים החודשיים נשארים גם בלי Grok Bot.
  const [summary, legacy, sand] = await Promise.all([
    dashboard('GET', '/api/usage-summary', sess.value),
    dashboard('GET', '/api/usage?user=' + encodeURIComponent(sess.user), sess.value),
    dashboard('POST', '/api/dashboard/get-sand-usage-status', sess.value, {}),
  ]);
  return parseCursorUsage(summary, legacy, sand);
}

/** האם יש בכלל ממה למשוך מכסה — מפריד "לא מחובר" מ"אין נתונים". */
function usageConnected() { return !!sessionCookie(); }

/* ==========================================================================
   תרגום כלים
   --------------------------------------------------------------------------
   ב-Cursor כל קריאת כלי עטופה במפתח יחיד ששמו הוא סוג הכלי
   (‎shellToolCall‎, ‎editToolCall‎ …). השמות שנבחרו כאן אינם שרירותיים: הם
   השמות ש-Cursor עצמו משתמש בהם פנימית (‎Shell‎ → ‎Bash‎ הוא היחיד שתורגם),
   והם גם מה שכרטיסי הכלים בדפדפן כבר יודעים לצייר — פקודה, דיף, רשימת משימות.
   ========================================================================== */
const TODO_STATUS = { TODO_STATUS_PENDING: 'pending', TODO_STATUS_IN_PROGRESS: 'in_progress', TODO_STATUS_COMPLETED: 'completed', TODO_STATUS_CANCELLED: 'completed' };
const mapTodos = (todos) => (Array.isArray(todos) ? todos : []).map((t) => ({
  content: t.content || '', status: TODO_STATUS[t.status] || 'pending', activeForm: t.content || '',
}));

const TOOLS = {
  shellToolCall: (a) => ({ name: 'Bash', input: { command: a.command || '', description: a.explanation || '' } }),
  writeShellStdinToolCall: (a) => ({ name: 'BashInput', input: { input: a.stdin || a.input || '' } }),
  awaitToolCall: (a) => ({ name: 'BashOutput', input: { description: 'המתנה לפקודה שרצה ברקע', ...a } }),
  readToolCall: (a) => ({ name: 'Read', input: { file_path: a.path || '', offset: a.offset, limit: a.limit } }),
  editToolCall: (a) => ({ name: 'Edit', input: { file_path: a.path || '', old_string: a.oldString || '', new_string: a.newString || a.streamContent || '' } }),
  applyAgentDiffToolCall: (a) => ({ name: 'Edit', input: { file_path: a.path || '', old_string: '', new_string: a.diff || '' } }),
  deleteToolCall: (a) => ({ name: 'Delete', input: { file_path: a.path || '' } }),
  lsToolCall: (a) => ({ name: 'LS', input: { path: a.path || '' } }),
  globToolCall: (a) => ({ name: 'Glob', input: { pattern: a.globPattern || a.pattern || '', path: a.path || '' } }),
  grepToolCall: (a) => ({ name: 'Grep', input: { pattern: a.pattern || '', path: a.path || '' } }),
  semSearchToolCall: (a) => ({ name: 'CodebaseSearch', input: { query: a.query || '' } }),
  updateTodosToolCall: (a) => ({ name: 'TodoWrite', input: { todos: mapTodos(a.todos) } }),
  readTodosToolCall: () => ({ name: 'TodoRead', input: {} }),
  webSearchToolCall: (a) => ({ name: 'WebSearch', input: { query: a.search_term || a.query || '' } }),
  webFetchToolCall: (a) => ({ name: 'WebFetch', input: { url: a.url || '' } }),
  fetchToolCall: (a) => ({ name: 'WebFetch', input: { url: a.url || '' } }),
  taskToolCall: (a) => ({ name: 'Task', input: { description: a.description || a.prompt || '', ...a } }),
  createPlanToolCall: (a) => ({ name: 'ExitPlanMode', input: { plan: a.plan || a.content || a.markdown || '' } }),
  askQuestionToolCall: (a) => ({ name: 'AskUserQuestion', input: a }),
  readLintsToolCall: (a) => ({ name: 'ReadLints', input: { paths: a.paths || [] } }),
  switchModeToolCall: (a) => ({ name: 'SwitchMode', input: a }),
  mcpToolCall: (a) => ({ name: a.toolName ? 'mcp__' + (a.serverName || 'mcp') + '__' + a.toolName : 'MCP', input: a.args || a }),
  generateImageToolCall: (a) => ({ name: 'GenerateImage', input: a }),
  summarizeToolCall: (a) => ({ name: 'Summarize', input: a }),
};
/**
 * השם שבו Cursor מכיר את הכלי *ברשימת ההיתר* שלו. אלה לא השמות שמוצגים על
 * המסך (שם אנחנו מדברים בשפה של Claude) אלא המחרוזות שהוא עצמו מצפה להן
 * ב-‎permissions.allow‎ — ובלעדיהן כפתור "הוסף לרשימת ההיתר" היה כותב חוק
 * שלא תואם לשום כלי.
 */
const RULE_NAME = {
  shellToolCall: 'Shell', awaitToolCall: 'AwaitShell', writeShellStdinToolCall: 'Shell',
  editToolCall: 'Write', applyAgentDiffToolCall: 'Write', deleteToolCall: 'Delete',
  readToolCall: 'Read', grepToolCall: 'Grep', globToolCall: 'Glob',
  webSearchToolCall: 'WebSearch', webFetchToolCall: 'WebFetch', fetchToolCall: 'WebFetch',
  readLintsToolCall: 'ReadLints', updateTodosToolCall: 'TodoWrite', taskToolCall: 'Task',
};

/**
 * החוק שיתיר את הקריאה הזו בעתיד. לפקודות מעטפת החוק הוא לפי *התוכנית*
 * (‎Shell(npm)‎) ולא לפי שורת הפקודה המלאה — חוק לשורה מדויקת לא היה נתפס
 * שוב לעולם, וזו בדיוק הצורה שבה Cursor עצמו כותב אותם.
 */
function ruleFor(key, args) {
  const name = RULE_NAME[key];
  if (!name) return '';
  if (name === 'Shell' || name === 'AwaitShell') {
    const cmds = Array.isArray(args && args.simpleCommands) ? args.simpleCommands : [];
    const first = cmds[0] || String((args && args.command) || '').trim().split(/\s+/)[0];
    return first ? `Shell(${first})` : 'Shell';
  }
  return name;
}

/** כלי שאיננו מכירים עדיין: שמו נגזר מהמפתח, ומה שנשלח אליו מוצג כפי שהוא.
 *  עדיף כרטיס גנרי נכון על פני כלי שנעלם מהמסך בגלל שדרוג של ה-CLI. */
const fallbackTool = (key, a) => ({
  name: key.replace(/ToolCall$/, '').replace(/^./, (c) => c.toUpperCase()),
  input: a && typeof a === 'object' ? a : {},
});

/** המפתח שאינו מטא-נתונים — הוא סוג הכלי. */
const META_KEYS = new Set(['hookAdditionalContexts', 'toolCallId', 'startedAtMs', 'completedAtMs', 'isBackground']);
const toolKeyOf = (tc) => Object.keys(tc || {}).find((k) => !META_KEYS.has(k)) || '';

/**
 * הופך את הדיף המאוחד ש-Cursor מחזיר לשתי מחרוזות — הישנה והחדשה — שהן מה
 * שכרטיס העריכה בדפדפן יודע לצייר. רק שורות ההאנקים, בלי הכותרות: העברת הקובץ
 * המלא לפני ואחרי הייתה מציגה מאות שורות "נמחקו" ומאות "נוספו" על תיקון של מילה.
 */
function splitDiff(diffString) {
  const del = [], add = [];
  for (const line of String(diffString || '').split('\n')) {
    if (/^(---|\+\+\+|@@|diff |index )/.test(line)) continue;
    if (line.startsWith('-')) del.push(line.slice(1));
    else if (line.startsWith('+')) add.push(line.slice(1));
    else if (line.startsWith(' ')) { del.push(line.slice(1)); add.push(line.slice(1)); }
  }
  return { old_string: del.join('\n'), new_string: add.join('\n') };
}

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '\n…' : s; };

/** טקסט התוצאה שיוצג בכרטיס הכלי, לפי סוג הכלי. */
function resultText(key, payload, ok) {
  if (!ok) {
    const r = payload || {};
    return r.reason || r.message || r.error || (typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  }
  const p = payload || {};
  switch (key) {
    case 'shellToolCall': {
      const body = p.interleavedOutput != null ? p.interleavedOutput : [p.stdout, p.stderr].filter(Boolean).join('\n');
      const code = typeof p.exitCode === 'number' && p.exitCode !== 0 ? `\n[קוד יציאה ${p.exitCode}]` : '';
      return clip(body, 20000) + code;
    }
    case 'readToolCall': return clip(p.content, 20000);
    case 'editToolCall':
    case 'applyAgentDiffToolCall': return p.message || p.diffString || 'הקובץ עודכן';
    case 'grepToolCall': {
      const ws = p.workspaceResults || {};
      const lines = [];
      for (const root of Object.keys(ws)) {
        const matches = ((ws[root] || {}).content || {}).matches || [];
        for (const f of matches) for (const m of (f.matches || [])) lines.push(`${f.file}:${m.lineNumber}: ${m.content}`);
      }
      return lines.length ? clip(lines.join('\n'), 20000) : 'אין התאמות';
    }
    case 'lsToolCall': return clip((p.files || p.entries || []).map((f) => (typeof f === 'string' ? f : f.name || f.path || '')).join('\n') || JSON.stringify(p, null, 2), 20000);
    case 'globToolCall': return clip((p.files || p.paths || []).join('\n') || JSON.stringify(p, null, 2), 20000);
    case 'updateTodosToolCall': return `${p.totalCount || (p.todos || []).length} משימות`;
    default: return clip(JSON.stringify(p, null, 2), 20000);
  }
}

/* ==========================================================================
   חיקוי התהליך
   ========================================================================== */
const LIMIT_RE = /rate limit|quota|usage limit|too many requests|429|out of (?:credits|tokens)|insufficient (?:credits|quota)/i;

class CursorChild extends EventEmitter {
  constructor(opts, hooks) {
    super();
    this.opts = { ...opts };
    this.hooks = hooks || {};
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    // ה-stdin של החיקוי אינו זרם אלא מתג: מה שנכתב אליו הוא הפרוטוקול של
    // Claude, וכאן הוא נקרא ומתורגם לפעולה — הרצת תור, או תשובת בקרה.
    this.stdin = {
      destroyed: false,
      write: (chunk) => { this._onStdin(String(chunk)); return true; },
      end: () => { this.stdin.destroyed = true; },
    };
    this.sessionId = opts.resume || '';
    this.turn = null;        // התהליך של התור שרץ עכשיו
    this.closed = false;
    this.inbuf = '';
    // הנחיית המערכת נשלחת פעם אחת לכל "תהליך" — כלומר בתור הראשון של החיקוי.
    // זו בדיוק הסמנטיקה של ‎--append-system-prompt‎ אצל Claude, שנקבע בהפעלה
    // וחוזר בכל הפעלה מחדש (כולל עם resume). ל-cursor-agent אין דגל מקביל,
    // ולכן ההנחיה נכנסת כפתיח של הפרומפט — ורק בתור שבו היא באמת חדשה.
    this.preambleSent = false;
    // פרומפט שהגיע בזמן שתהליך התור הקודם עדיין נסגר. השרת משגר את הפריט הבא
    // בתור מיד אחרי אירוע ה-result, ואילו אירוע ה-close של התהליך מגיע רק
    // אחריו — בלי ההמתנה הזו כל פרומפט משורשר היה נדחה כ"תור כבר רץ".
    this.pending = null;
  }

  _line(obj) {
    if (this.closed) return;
    try { this.stdout.write(JSON.stringify(obj) + '\n'); } catch {}
  }
  _err(text) { try { this.stderr.write(text); } catch {} }

  _onStdin(chunk) {
    this.inbuf += chunk;
    let nl;
    while ((nl = this.inbuf.indexOf('\n')) >= 0) {
      const line = this.inbuf.slice(0, nl);
      this.inbuf = this.inbuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      this._handle(msg);
    }
  }

  _handle(msg) {
    if (msg.type === 'control_request') {
      const req = msg.request || {};
      // החלפת מודל אינה דורשת כאן הפעלה מחדש: התור הבא ממילא מרים תהליך חדש,
      // והוא ייקח את המודל החדש. זו הסיבה שמעבר בין מודלי Cursor לא מנתק דבר.
      if (req.subtype === 'set_model') {
        this.opts.model = req.model || '';
        // המאמץ מגיע יחד עם המודל כי אצל Cursor הוא *חלק* ממנו (ראו resolveModel).
        if (typeof req.effort === 'string') this.opts.effort = req.effort;
        return this._line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
      }
      // מצב ההרשאות הוא דגל הרצה, ולכן הוא נקלט כאן ונכנס לתוקף בתור הבא —
      // בלי הפעלה מחדש ובלי לגעת בהקשר. בלי הטיפול הזה שינוי הבורר באמצע
      // שיחה פשוט לא הגיע לשום מקום, וההרשאות נשארו של ההרצה הראשונה.
      if (req.subtype === 'set_permission_mode') {
        if (PERM_MODES.includes(req.mode)) this.opts.permissionMode = req.mode;
        return this._line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
      }
      if (req.subtype === 'interrupt') { this.interrupt(); return this._line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); }
      return this._line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    }
    if (msg.type === 'user' && msg.message) this._runTurn(msg.message.content);
  }

  /**
   * הפרומפט כפי ש-Cursor יכול לקבל אותו.
   *
   * תמונות: ל-‎cursor-agent --print‎ אין קלט תמונות כבלוק base64 כמו ל-Claude,
   * אבל *יש* לו כלי קריאה שיודע לפתוח קובץ תמונה ולראות אותו (נבדק: הוא זיהה
   * נכון את הצבעים בקובץ PNG שנכתב לו). לכן במקום להשמיט אותן, הן נכתבות
   * לתיקיית הזמניים של השרת — אותה תיקייה עם אותו ניקוי לפי TTL שכבר משרתת
   * את הצירופים מהדפדפן — והפרומפט מפנה אליהן בנתיב מלא.
   */
  _promptOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    const paths = [];
    for (const b of content) {
      if (b && b.type === 'text' && b.text) parts.push(b.text);
      else if (b && b.type === 'image') {
        const p = this._spillImage(b);
        if (p) paths.push(p);
      }
    }
    if (paths.length) {
      parts.push(paths.length === 1
        ? `[Attached image — open and look at this file: ${paths[0]}]`
        : `[Attached images — open and look at these files:\n${paths.map((x) => '- ' + x).join('\n')}]`);
    }
    return parts.join('\n\n');
  }

  /** כותב בלוק תמונה אחד לדיסק ומחזיר את נתיבו, או null אם לא ניתן. */
  _spillImage(block) {
    try {
      const src = block.source || {};
      if (src.type !== 'base64' || !src.data) return null;
      const dir = this.opts.imageDir || path.join(os.tmpdir(), 'rtl-claude-uploads');
      fs.mkdirSync(dir, { recursive: true });
      const ext = IMG_EXT[src.media_type] || 'png';
      const file = path.join(dir, `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
      fs.writeFileSync(file, Buffer.from(src.data, 'base64'));
      return file;
    } catch (e) {
      this._err('[rtl-claude] כתיבת תמונה זמנית נכשלה: ' + e.message + '\n');
      return null;
    }
  }

  /**
   * הפתיח שנשלח לפני הפרומפט הראשון: הנחיית המערכת של ההרצה, ואם הכלים
   * אמורים להיות כבויים — גם האמירה המפורשת הזו. ל-cursor-agent אין מקבילה
   * ל---tools ''‎, ולכן זו בדיוק אותה שורה שהשרת כבר משתמש בה מול Claude:
   * בלעדיה המודל *ממציא* קריאות-כלי כטקסט, כי הנחיית המערכת שלו מתארת כלים.
   */
  _preamble() {
    const parts = [];
    if (this.opts.systemPrompt) parts.push(this.opts.systemPrompt);
    if (this.opts.noTools) {
      parts.push('No tools are available to you in this run: never call, emit, simulate or narrate a tool call. '
        + 'Answer directly from your own knowledge, and if something would genuinely require reading files, '
        + 'running commands or searching, say so plainly instead of pretending to do it.');
    }
    return parts.join('\n\n');
  }

  _runTurn(content) {
    if (this.turn) { this.pending = content; return; }
    let prompt = this._promptOf(content);
    const o = this.opts;
    if (!this.preambleSent) {
      const pre = this._preamble();
      if (pre) prompt = pre + '\n\n---\n\n' + prompt;
      this.preambleSent = true;
    }
    const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust'];
    // המאמץ אינו דגל נפרד אצל Cursor אלא חלק מהמזהה — כאן שני הבוררים חוזרים
    // להיות המחרוזת האחת שה-CLI מכיר (ראו collapse/resolveModel).
    const model = resolveModel(o.model, o.effort, realIds);
    if (model) args.push('--model', model);
    if (this.sessionId) args.push('--resume', this.sessionId);
    // ריצה בלי כלים: המצב הקרוב ביותר שיש ל-Cursor הוא 'ask' (שאלות ותשובות,
    // קריאה בלבד). הוא מצב פתיחה ולא גדר — ולכן הוא בא *יחד* עם השורה שבפתיח
    // ולא במקומה.
    args.push(...permArgs(o.noTools ? 'ask' : o.permissionMode));

    let child;
    try {
      child = spawn(BIN, args, { cwd: o.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this._err('[rtl-claude] הפעלת cursor-agent נכשלה: ' + e.message + '\n');
      this._syntheticResult(true, 'הפעלת cursor-agent נכשלה: ' + e.message);
      return;
    }
    this.turn = child;
    // הפרומפט נכנס דרך stdin ולא כארגומנט: פרומפט ארוך חורג ממגבלת שורת
    // הפקודה, וגרשיים ותווי בקרה בתוכו היו הופכים לבעיית ציטוט.
    try { child.stdin.write(prompt); child.stdin.end(); } catch {}

    const tr = new Translator(this, o);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) tr.line(line);
      }
    });
    child.stderr.on('data', (d) => this._err(d.toString()));
    child.on('error', (e) => { this._err('[rtl-claude] cursor-agent: ' + e.message + '\n'); });
    child.on('close', (code, signal) => {
      this.turn = null;
      // תהליך שנגמר בלי result הוא תור שנשאר פתוח לנצח מבחינת השרת. כאן הוא
      // נסגר במפורש, עם הסיבה שידועה לנו — קוד היציאה או האות שהרג אותו.
      if (!tr.finished) {
        tr.closeBlocks();
        const why = signal ? `התהליך נהרג באות ${signal}` : `cursor-agent יצא עם קוד ${code}`;
        this._syntheticResult(true, why, signal === 'SIGTERM' || signal === 'SIGINT' ? 'interrupted' : 'error');
      }
      // הפרומפט שהמתין לסגירה יוצא לדרך עכשיו, על אותו סשן ועם אותו הקשר
      if (this.pending != null && !this.closed) {
        const next = this.pending;
        this.pending = null;
        this._runTurn(next);
      }
    });
  }

  _syntheticResult(isError, text, subtype) {
    this._line({
      type: 'result', subtype: subtype || (isError ? 'error' : 'success'),
      is_error: !!isError, result: text || '', session_id: this.sessionId || undefined,
      duration_ms: 0, usage: {},
    });
  }

  /** קטיעת התור הרץ. ההקשר לא נפגע — הוא שמור אצל Cursor, וה-resume הבא ימשיך. */
  interrupt() { if (this.turn) { try { this.turn.kill('SIGTERM'); } catch {} } }

  kill(sig) {
    const signal = sig || 'SIGTERM';
    this.closed = true;
    this.pending = null;
    if (this.turn) { try { this.turn.kill(signal); } catch {} this.turn = null; }
    // היציאה מדווחת עם האות שהרג, ולא כיציאה נקייה. זה מה שמאפשר לשרת להבדיל
    // בין "עצרת" (SIGINT) לבין נפילה — אותה הבחנה בדיוק שהוא עושה ל-Claude,
    // ובלעדיה כל קטיעה ידנית הופיעה על המסך ככרטיס שגיאה.
    process.nextTick(() => this.emit('exit', null, signal));
  }
}

/* ==========================================================================
   המתרגם — אירוע של Cursor נכנס, סכמת Claude יוצאת
   ========================================================================== */
class Translator {
  constructor(child, opts) {
    this.c = child;
    this.opts = opts;
    this.idx = 0;            // אינדקס הבלוק הבא בהודעה
    this.msgOpen = false;
    this.text = null;        // { index, acc } — בלוק הטקסט הפתוח
    this.think = null;       // { index } — בלוק החשיבה הפתוח
    this.tools = new Map();  // callId של Cursor → { id, key }
    this.finished = false;
    this.outChars = 0;
  }

  ev(event) { this.c._line({ type: 'stream_event', event, session_id: this.c.sessionId || undefined }); }

  openMsg() {
    if (this.msgOpen) return;
    this.msgOpen = true;
    this.idx = 0;
    this.ev({ type: 'message_start', message: { role: 'assistant', content: [] } });
  }
  closeText() {
    if (!this.text) return;
    this.ev({ type: 'content_block_stop', index: this.text.index });
    this.text = null;
  }
  closeThink() {
    if (!this.think) return;
    this.ev({ type: 'content_block_stop', index: this.think.index });
    this.think = null;
  }
  closeBlocks() {
    this.closeText(); this.closeThink();
    if (this.msgOpen) { this.ev({ type: 'message_stop' }); this.msgOpen = false; }
  }

  line(raw) {
    let e; try { e = JSON.parse(raw); } catch { return; }
    if (e.session_id && e.session_id !== this.c.sessionId) this.c.sessionId = e.session_id;

    switch (e.type) {
      case 'system': return this.onSystem(e);
      case 'thinking': return this.onThinking(e);
      case 'assistant': return this.onAssistant(e);
      case 'tool_call': return this.onToolCall(e);
      case 'result': return this.onResult(e);
      // 'user' הוא הד של מה ששלחנו — השרת כבר שידר אותו למסכים בעצמו
      default: return;
    }
  }

  onSystem(e) {
    if (e.subtype !== 'init') return;
    this.c._line({
      type: 'system', subtype: 'init', session_id: e.session_id,
      cwd: e.cwd || this.opts.cwd, model: e.model || bareModel(this.opts.model) || 'Auto',
      permissionMode: this.opts.permissionMode || PERM_DEFAULT,
      apiKeySource: e.apiKeySource || 'login', agent: 'cursor',
    });
  }

  onThinking(e) {
    if (e.subtype === 'completed') return this.closeThink();
    if (e.subtype !== 'delta' || !e.text) return;
    this.openMsg();
    this.closeText();
    if (!this.think) {
      this.think = { index: this.idx++ };
      this.ev({ type: 'content_block_start', index: this.think.index, content_block: { type: 'thinking', thinking: '' } });
    }
    this.ev({ type: 'content_block_delta', index: this.think.index, delta: { type: 'thinking_delta', thinking: e.text } });
  }

  /**
   * Cursor שולח גם דלתאות וגם, בסוף כל מקטע, הודעה מצטברת שחוזרת על כולו.
   * ההבחנה נעשית על הטקסט עצמו ולא על שדות מטא (שאינם עקביים בין המקטעים):
   * טקסט שזהה למה שכבר נצבר הוא החזרה וייזרק, טקסט שמתחיל במה שנצבר הוא
   * המשך שיש לקחת ממנו רק את הזנב, וכל השאר הוא דלתא רגילה. כך אותו קוד נכון
   * גם כשמריצים בלי ‎--stream-partial-output‎, שם מגיעה רק ההודעה המלאה.
   */
  onAssistant(e) {
    const blocks = ((e.message || {}).content) || [];
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
    if (!text) return;
    this.openMsg();
    this.closeThink();
    if (!this.text) {
      this.text = { index: this.idx++, acc: '' };
      this.ev({ type: 'content_block_start', index: this.text.index, content_block: { type: 'text', text: '' } });
    }
    let delta;
    if (text === this.text.acc) return;                       // ההודעה המצטברת
    else if (this.text.acc && text.startsWith(this.text.acc)) delta = text.slice(this.text.acc.length);
    else delta = text;
    this.text.acc += delta;
    this.outChars += delta.length;
    this.ev({ type: 'content_block_delta', index: this.text.index, delta: { type: 'text_delta', text: delta } });
    // מונה הטוקנים החי בממשק ניזון מ-message_delta. אין ל-Cursor מונה תוך-כדי,
    // והערכה של ארבעה תווים לטוקן עדיפה על שדה שנשאר ריק עד סוף התור.
    this.ev({ type: 'message_delta', delta: {}, usage: { output_tokens: Math.round(this.outChars / 4) } });
  }

  onToolCall(e) {
    const tc = e.tool_call || {};
    const key = toolKeyOf(tc);
    if (!key) return;
    const body = tc[key] || {};
    const cid = e.call_id || tc.toolCallId || '';

    if (e.subtype === 'started') {
      this.openMsg();
      this.closeText(); this.closeThink();
      const map = TOOLS[key] || ((a) => fallbackTool(key, a));
      const { name, input } = map(body.args || {});
      // מזהה יציב וקצר: ה-call_id של Cursor מכיל תווי שורה חדשה, ובכל מקום
      // שבו הוא מגיע ל-DOM או ל-JSON הוא היה נקרא כשני מזהים שונים. גיבוב ולא
      // קיצוץ — שתי קריאות באותו תור חולקות קידומת ארוכה (אותו model_call_id),
      // וקיצוץ שלה נתן להן מזהה זהה ותוצאת הכלי נחתה בכרטיס הלא נכון.
      const id = 'ct_' + crypto.createHash('sha1').update(cid).digest('hex').slice(0, 24);
      // ה-args נשמרים כי החוק שיתיר את הקריאה נגזר מהם, והם כבר לא יהיו
      // בהישג יד כשתגיע התוצאה שתספר לנו שהיא נדחתה
      this.tools.set(cid, { id, key, name, args: body.args || {} });
      const index = this.idx++;
      this.ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input } });
      this.ev({ type: 'content_block_stop', index });
      return;
    }

    if (e.subtype !== 'completed') return;
    const t = this.tools.get(cid);
    if (!t) return;
    this.tools.delete(cid);
    const res = body.result || {};
    const kind = Object.keys(res)[0] || '';
    const ok = kind === 'success';
    const payload = res[kind] || {};
    // הדיף נולד רק עם התוצאה, אחרי שהכרטיס כבר צויר. ‎input_patch‎ הוא הדרך
    // להשלים אותו לתוך הכרטיס הקיים בלי לצייר אותו מחדש ובלי לשכפל אותו.
    let patch = null;
    if (ok && (t.key === 'editToolCall' || t.key === 'applyAgentDiffToolCall') && payload.diffString) patch = splitDiff(payload.diffString);
    if (ok && t.key === 'updateTodosToolCall' && payload.todos) patch = { todos: mapTodos(payload.todos) };

    // ---- דחיית הרשאה ----
    // זו הנקודה היחידה שבה מתברר שמצב ההרשאות חסם את הכלי. במצב ‎--print‎ אין
    // ל-Cursor כרטיס אישור — הוא פשוט דוחה, והמודל מנסה שוב ושוב עד שהוא
    // מוותר. בלי הסימון הזה זה נראה על המסך כמו כלי שנכשל בלי סיבה.
    const rejected = kind === 'rejected';
    const rule = rejected ? ruleFor(t.key, t.args) : '';

    this.c._line({
      type: 'user',
      session_id: this.c.sessionId || undefined,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: t.id, is_error: !ok,
          content: (rejected ? 'נדחה על-ידי מצב ההרשאות של Cursor' : resultText(t.key, payload, ok)) || (ok ? 'הושלם' : 'נכשל'),
          ...(patch ? { input_patch: patch } : {}),
          ...(rejected ? { cursor_rejected: { tool: t.name || t.key, rule, mode: this.opts.permissionMode || PERM_DEFAULT } } : {}),
        }],
      },
    });
  }

  onResult(e) {
    this.finished = true;
    this.closeBlocks();
    const u = e.usage || {};
    const err = !!e.is_error;
    const text = typeof e.result === 'string' ? e.result : '';
    if (LIMIT_RE.test(text)) this.c._err('[cursor-agent] ' + text.slice(0, 500) + '\n');
    this.c._line({
      type: 'result',
      subtype: e.subtype || (err ? 'error' : 'success'),
      is_error: err,
      result: text,
      session_id: this.c.sessionId || undefined,
      duration_ms: e.duration_ms || 0,
      num_turns: 1,
      usage: {
        input_tokens: u.inputTokens || 0,
        output_tokens: u.outputTokens || 0,
        cache_read_input_tokens: u.cacheReadTokens || 0,
        cache_creation_input_tokens: u.cacheWriteTokens || 0,
      },
    });
  }
}

/** מרים "תהליך" של Cursor לשיחה. החתימה מכוונת ל-spawn כדי שהקורא לא יבחין. */
function spawnCursor(opts) { return new CursorChild(opts); }

/* ==========================================================================
   סשנים קיימים — להמשך שיחה שנפתחה מחוץ לממשק
   --------------------------------------------------------------------------
   Cursor שומר כל שיחה בתיקייה משלה תחת ~/.cursor/chats, עם meta.json קריא
   ו-store.db שהוא SQLite. אין כאן ספריית SQLite (ואין צורך): הפרומפט הראשון
   נשמר בתוך הקובץ כטקסט בתוך ‎<user_query>‎, וזה כל מה שצריך לכותרת. נכשל →
   כותרת לפי תאריך, לא רשימה ריקה.
   ========================================================================== */
const CHATS_DIR = path.join(os.homedir(), '.cursor', 'chats');

function titleFromStore(file) {
  try {
    const st = fs.statSync(file);
    // הפרומפט הראשון יושב בתחילת הקובץ; קריאת 512KB חוסכת טעינת בסיס נתונים שלם
    const len = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const m = text.match(/<user_query>\s*([\s\S]{1,300}?)\s*<\/user_query>/);
    // הטקסט יושב בתוך מחרוזת JSON בתוך ה-blob, ולכן שברי השורה בו הם הרצף
    // ‎\n‎ בן שני התווים ולא תו שורה — ‎\s+‎ לא נוגע בהם, והכותרת יצאה עם
    // "‎\n‎" גלוי בשני קצותיה.
    if (m) return m[1].replace(/\\[nrt]/g, ' ').replace(/\\(["'\\])/g, '$1').replace(/\s+/g, ' ').trim();
  } catch {}
  return '';
}

/**
 * כמה תורות יש בשיחה. ה-store.db הוא SQLite, אבל הבלובים בתוכו טקסט קריא —
 * וכל פרומפט של המשתמש עטוף ב-‎<user_query>‎. ספירת העטיפות היא קירוב טוב
 * מספיק לשורת המטא ברשימה, ובלעדיה היא הציגה תמיד "0 תורות".
 */
function countTurns(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return (buf.toString('utf8').match(/<user_query>/g) || []).length;
  } catch { return 0; }
}

function listSessions(cwd) {
  let hashes;
  try { hashes = fs.readdirSync(CHATS_DIR); } catch { return []; }
  const out = [];
  for (const h of hashes) {
    let chats;
    try { chats = fs.readdirSync(path.join(CHATS_DIR, h)); } catch { continue; }
    for (const id of chats) {
      const dir = path.join(CHATS_DIR, h, id);
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { continue; }
      if (!meta.hasConversation) continue;                     // שיחה שנפתחה ולא נאמר בה דבר
      if (cwd && path.resolve(meta.cwd || '') !== path.resolve(cwd)) continue;
      const mtime = meta.updatedAtMs || meta.createdAtMs || 0;
      const db = path.join(dir, 'store.db');
      out.push({
        id,
        title: (titleFromStore(db) || 'שיחת Cursor').slice(0, 80),
        turns: countTurns(db), mtime, agent: 'cursor',
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 40);
}

/** שרתי ה-MCP שמוגדרים ל-Cursor, באותו מבנה שבו מוצגים אלה של Claude. */
function mcpList() {
  return new Promise((resolve) => {
    execFile(BIN, ['mcp', 'list'], { timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const out = [];
      // "No MCP servers configured (expected in .cursor/mcp.json…)" היא הודעת
      // מצב, לא שורת שרת — בלי הדילוג הזה היא הייתה מופיעה כשרת בשם "No".
      if (/^\s*No MCP servers/i.test(stdout)) return resolve([]);
      for (const line of String(stdout).split('\n')) {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        const m = clean.match(/^([\w.\-]+)\s*[:–-]\s*(.+)$/);
        if (!m) continue;
        const status = /fail|error|disconnect|✗/i.test(m[2]) ? 'failed' : 'connected';
        out.push({ name: m[1], detail: m[2].trim(), status, agent: 'cursor' });
      }
      resolve(out);
    });
  });
}

/* ==========================================================================
   רשימת ההיתר
   --------------------------------------------------------------------------
   זה מה שהופך את הדחייה השקטה של Cursor למשהו שאפשר לענות עליו. אין לו כרטיס
   אישור במצב ‎--print‎, אבל יש לו רשימת היתר קבועה — ולכן "אשר תמיד" כאן הוא
   כתיבה לקובץ ההגדרות שלו, בדיוק כמו שהמשתמש היה עושה ידנית.
   ========================================================================== */
const CLI_CONFIG = path.join(os.homedir(), '.cursor', 'cli-config.json');

function allowRule(rule) {
  const clean = String(rule || '').trim();
  if (!clean || clean.length > 200 || /[\n\r]/.test(clean)) return { ok: false, error: 'חוק לא תקין' };
  let cfg;
  // הקובץ הזה שייך ל-Cursor ולא לנו. קריאה שנכשלת פירושה שהוא נעול או פגום,
  // ואז עדיף להיכשל בקול מאשר לדרוס אותו בגרסה מינימלית שלנו.
  try { cfg = JSON.parse(fs.readFileSync(CLI_CONFIG, 'utf8')); }
  catch (e) { return { ok: false, error: 'לא ניתן לקרוא את cli-config.json של Cursor: ' + e.message }; }
  if (!cfg.permissions || typeof cfg.permissions !== 'object') cfg.permissions = { allow: [], deny: [] };
  if (!Array.isArray(cfg.permissions.allow)) cfg.permissions.allow = [];
  if (cfg.permissions.allow.includes(clean)) return { ok: true, already: true, rule: clean };
  // חוק שנמצא ברשימת האיסור לא יעבוד גם אם יתווסף להיתר — אומרים את זה מיד
  if (Array.isArray(cfg.permissions.deny) && cfg.permissions.deny.includes(clean)) {
    return { ok: false, error: 'החוק נמצא ברשימת האיסור של Cursor — הסר אותו משם קודם' };
  }
  cfg.permissions.allow.push(clean);
  try {
    // כתיבה אטומית: קובץ זמני ואז rename. נפילה באמצע כתיבה ישירה הייתה
    // משאירה את Cursor בלי קובץ הגדרות תקין בכלל.
    const tmp = CLI_CONFIG + '.rtl-tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, CLI_CONFIG);
  } catch (e) { return { ok: false, error: 'הכתיבה נכשלה: ' + e.message }; }
  return { ok: true, rule: clean };
}

/* ==========================================================================
   מיומנויות (Skills) — הן פקודות ה-'/' של Cursor
   --------------------------------------------------------------------------
   ל-Cursor אין תיקיית commands כמו ל-Claude; מה שממלא את התפקיד הוא skills:
   תיקייה עם SKILL.md ובו חזית YAML ובה name ו-description. זה בדיוק המידע
   שתפריט ה-'/' כבר יודע להציג, ולכן הוא נקרא לאותו מבנה.
   ========================================================================== */
function readSkill(dir, scope) {
  let head;
  try { head = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 2000); } catch { return null; }
  const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = fm ? fm[1] : '';
  // ‎description‎ אצל Cursor כתוב לרוב כ-block scalar של YAML (‎>-‎, ‎|‎), כלומר
  // הערך הוא השורות המוזחות שאחריו ולא מה שעל אותה שורה. קריאה תמימה החזירה
  // "‎>-‎" כתיאור לכל מיומנות שנייה.
  const lines = body.split(/\r?\n/);
  const pick = (k) => {
    const i = lines.findIndex((l) => l.startsWith(k + ':'));
    if (i < 0) return '';
    const head = lines[i].slice(k.length + 1).trim();
    if (!/^[>|][-+]?$/.test(head)) return head.replace(/^["']|["']$/g, '');
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^\s/.test(lines[j])) break;          // נגמרה ההזחה = נגמר הערך
      out.push(lines[j].trim());
    }
    return out.join(' ').trim();
  };
  const name = pick('name') || path.basename(dir);
  return { name: '/' + name, desc: pick('description') || '', scope, agent: 'cursor' };
}

function listCommands(cwd) {
  const out = [];
  const seen = new Set();
  const scan = (root, scope) => {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const sk = readSkill(path.join(root, e.name), scope);
      if (sk && !seen.has(sk.name)) { seen.add(sk.name); out.push(sk); }
    }
  };
  if (cwd) {
    scan(path.join(cwd, '.cursor', 'skills'), 'פרויקט');
    scan(path.join(cwd, '.cursor', 'commands'), 'פרויקט');
  }
  scan(path.join(os.homedir(), '.cursor', 'skills-cursor'), 'Cursor');
  scan(path.join(os.homedir(), '.cursor', 'skills'), 'אישי');
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = {
  PREFIX, CURSOR_GROUP, PERM_MODES, PERM_DEFAULT,
  isCursorModel, bareModel,
  fetchModels, available, spawnCursor, resolveModel,
  fetchUsage, usageConnected,
  listSessions, mcpList, listCommands, allowRule,
  // ליחידות בדיקה
  _internal: { parseModels, parseCursorUsage, sessionCookie, splitDiff, Translator, CursorChild, TOOLS, resultText, collapse, splitVariant, resolveModel, realIds: () => realIds },
};
