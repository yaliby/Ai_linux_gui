// ממשק גרפי RTL ל-Claude Code — שרת גשר
// מריץ את `claude` במצב stream-json ומזרים אירועים לדפדפן דרך WebSocket.
// תומך: סטרימינג בזמן אמת, בחירת מודל/מאמץ/הרשאות (גם באמצע שיחה, בלי לאבד
// הקשר — ראו applyModelChange), ריבוי שיחות עם --resume.
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const qrcode = require('qrcode');

// קובץ .env מקומי (אופציונלי) — נטען לפני כל קריאה ל-process.env. בלי זה
// .env.example היה תיעוד בלבד, ומשתני הספקים היו חייבים להיות מיוצאים בשל.
// ערך שכבר קיים בסביבה תמיד מנצח, כדי ש-`OMNIROUTE_BASE_URL=... npm start` יעבוד.
(function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || line.trim().startsWith('#')) continue;
      const val = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* אין .env — התנהגות רגילה */ }
})();

const { loadProviders } = require('./openai-bridge');
const cursor = require('./cursor-bridge');

// ספקים תואמי-OpenAI (OmniRoute, שרת מודלים מקומי ברשת). נבנים מהסביבה אחרי
// טעינת .env, כדי שכתובות הבסיס שבקובץ ייתפסו.
const oaiProviders = loadProviders();

const PORT = process.env.PORT || 4173;
const app = express();

app.use(express.static(path.join(__dirname, 'public')));
// ספריות צד-לקוח (אפליקציה מקומית — אין הגבלת CSP)
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules/marked')));
app.use('/vendor/dompurify', express.static(path.join(__dirname, 'node_modules/dompurify/dist')));
app.use('/vendor/highlight', express.static(path.join(__dirname, 'node_modules/@highlightjs/cdn-assets')));
app.use('/vendor/mermaid', express.static(path.join(__dirname, 'node_modules/mermaid/dist')));

// בדיקת קיום תיקייה (לוולידציה של שדה "תיקיית עבודה")
app.get('/api/check-dir', (req, res) => {
  const d = (req.query.path || '').toString();
  if (isNoDir(d)) return res.json({ ok: true, path: NO_DIR, noDir: true });
  if (!d) return res.json({ ok: true, path: os.homedir() });
  try {
    const resolved = d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d;
    const st = fs.statSync(resolved);
    res.json({ ok: st.isDirectory(), path: resolved });
  } catch { res.json({ ok: false }); }
});

// בחירת תיקייה דרך דיאלוג "מנהל הקבצים" המקומי (zenity/kdialog).
// השרת רץ מקומית כאותו משתמש, לכן הוא יכול לפתוח את בורר התיקיות של שולחן העבודה.
function pickDirDialog(startDir) {
  return new Promise((resolve) => {
    const start = startDir && fs.existsSync(startDir) ? startDir : os.homedir();
    const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
    // מעדיפים את הבורר שתואם לשולחן העבודה, עם נפילה לשני.
    const candidates = desktop.includes('kde')
      ? [['kdialog', ['--getexistingdirectory', start]],
         ['zenity', ['--file-selection', '--directory', '--title=בחר תיקיית עבודה', '--filename=' + start + '/']]]
      : [['zenity', ['--file-selection', '--directory', '--title=בחר תיקיית עבודה', '--filename=' + start + '/']],
         ['kdialog', ['--getexistingdirectory', start]]];
    const tryNext = (i) => {
      if (i >= candidates.length) {
        console.warn('[pick-dir] אין בורר קבצים זמין (zenity/kdialog לא מותקנים)');
        return resolve({ ok: false, error: 'no-dialog' });
      }
      const [cmd, args] = candidates[i];
      console.log('[pick-dir] מריץ בורר:', cmd, 'התחלה=', start, 'desktop=', desktop || '(ריק)');
      execFile(cmd, args, { timeout: 300000 }, (err, stdout, stderr) => {
        // ENOENT → הכלי לא מותקן, ננסה את הבא. קוד יציאה אחר (1) = המשתמש ביטל.
        if (err && err.code === 'ENOENT') {
          console.log('[pick-dir]', cmd, 'לא מותקן — מנסה את הבא');
          return tryNext(i + 1);
        }
        const dir = (stdout || '').trim();
        if (err) console.warn('[pick-dir]', cmd, 'נכשל/בוטל: code=' + err.code, 'stderr=', (stderr || '').trim());
        if (err || !dir) return resolve({ ok: false, error: err ? 'cancelled' : 'empty' });
        console.log('[pick-dir] נבחרה תיקייה:', dir);
        resolve({ ok: true, path: dir });
      });
    };
    tryNext(0);
  });
}

app.get('/api/pick-dir', async (req, res) => {
  const cur = (req.query.current || '').toString();
  const start = cur.startsWith('~') ? path.join(os.homedir(), cur.slice(1)) : cur;
  console.log('[pick-dir] בקשה התקבלה, current=', cur || '(ריק)');
  const result = await pickDirDialog(start);
  console.log('[pick-dir] תוצאה:', JSON.stringify(result));
  res.json(result);
});

// רשימת תת־תיקיות — הבסיס לבורר התיקיות שרץ בדפדפן. ‎/api/pick-dir‎ פותח חלון
// zenity על המסך של המחשב שמריץ את השרת, ולכן הוא חסר תועלת כשמחוברים מהטלפון.
app.get('/api/list-dirs', (req, res) => {
  const dir = resolveDirGlobal(req.query.path);
  const isDir = (name) => {
    try { return fs.statSync(path.join(dir, name)).isDirectory(); } catch { return false; }
  };
  let dirs = [];
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true })
      // קישורים סימבוליים הם ‎isDirectory()===false‎, ובבית של משתמש הם נפוצים
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && isDir(e.name))))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500);
  } catch { /* תיקייה בלי הרשאת קריאה — מציגים אותה ריקה במקום להיכשל */ }
  const parent = path.dirname(dir);
  res.json({ ok: true, path: dir, home: os.homedir(), parent: parent === dir ? null : parent, dirs });
});

// ---------- קונפיג דינמי: נמשך חי מה-CLI (בלי hard-coding) ----------
// מודלים מגיעים מ-/v1/models דרך אותה הזדהות של Claude Code, מצבי הרשאה מ-`claude --help`.
function readOauthToken() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/.credentials.json'), 'utf8'));
    return (c.claudeAiOauth || c.oauth || {}).accessToken || null;
  } catch { return null; }
}
// רשימת נפילה לבורר המודל: המכסה וה-API יכולים לסרב להריץ תור,
// אבל השמות עצמם חייבים להישאר בתפריט. בלי זה כשל רשת ל-/v1/models
// משאיר רק את מודלי Gemini מהשער, או רק "מודל ברירת מחדל".
const FALLBACK_MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-fable-5', name: 'Claude Fable 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', efforts: [] },
];
const MODELS_CACHE_FILE = path.join(os.homedir(), '.claude', 'rtl-claude', 'models-cache.json');
function loadModelsCache() {
  try {
    const j = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8'));
    return Array.isArray(j) && j.length ? j : null;
  } catch { return null; }
}
function saveModelsCache(models) {
  try { fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(models)); } catch {}
}
function fetchModels() {
  return new Promise((resolve) => {
    const tok = readOauthToken();
    if (!tok) {
      console.warn('[config] אין טוקן OAuth — בורר המודלים ישתמש ברשימת נפילה');
      return resolve(null);
    }
    const req = https.request('https://api.anthropic.com/v1/models?limit=100',
      { headers: { Authorization: 'Bearer ' + tok, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' } },
      (x) => {
        let d = '';
        x.on('data', (c) => d += c);
        x.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (!Array.isArray(j.data)) {
              console.warn('[config] /v1/models לא החזיר data (HTTP ' + x.statusCode + ')');
              return resolve(null);
            }
            resolve(j.data.map((m) => {
              const ef = m.capabilities && m.capabilities.effort;
              const efforts = ef && ef.supported ? Object.keys(ef).filter((k) => ef[k] && typeof ef[k] === 'object' && ef[k].supported) : [];
              return { id: m.id, name: m.display_name || m.id, efforts };
            }));
          } catch {
            console.warn('[config] /v1/models לא היה JSON תקין');
            resolve(null);
          }
        });
      });
    req.on('error', (e) => { console.warn('[config] /v1/models נכשל:', e.message); resolve(null); });
    req.setTimeout(8000, () => { req.destroy(); console.warn('[config] /v1/models timeout'); resolve(null); });
    req.end();
  });
}
function fetchPermissionModes() {
  return new Promise((resolve) => {
    execFile('claude', ['--help'], { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const i = stdout.indexOf('--permission-mode');
      if (i < 0) return resolve(null);
      const m = stdout.slice(i, i + 500).match(/choices:([\s\S]*?)\)/);
      if (!m) return resolve(null);
      const modes = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      resolve(modes.length ? modes : null);
    });
  });
}

/* ==========================================================================
   מצב GOD — אישור אוטומטי לכל בקשה, ויומן של מה שבאמת רץ
   --------------------------------------------------------------------------
   ‎god‎ אינו מצב של ה-CLI אלא של הממשק. ה-CLI מופעל דווקא ב-‎default‎ — המצב
   שבו *כל* כלי שאינו ברשימת ההיתר נעצר ושואל — והשרת עונה "אשר" מיד. זה מה
   שמבדיל אותו מ-‎bypassPermissions‎: שם ה-CLI לא שואל בכלל, ולכן אין מה לרשום
   ואין מה להראות. כאן כל בקשה עוברת דרכנו, נענית בתוך פריים אחד, ונרשמת —
   וסוף התור מקבל כפתור שפותח את הרשימה המלאה.
   ========================================================================== */
const GOD_MODE = 'god';
const GOD_CLI_MODE = 'default';
// AskUserQuestion אינה בקשת רשות לעשות משהו אלא שאלה שהתשובה עליה היא התוכן.
// "אישור" בלי תשובה היה מחזיר למודל שאלה ריקה, ולכן היא נשארת על המסך גם כאן.
const GOD_KEEP_TOOLS = new Set(['AskUserQuestion']);
const isGodMode = (m) => m === GOD_MODE;
/** מה באמת נשלח ל---permission-mode: ‎god‎ הוא שלנו, ה-CLI לא מכיר אותו. */
const cliPermMode = (m) => (isGodMode(m) ? GOD_CLI_MODE : m);
/** ‎god‎ לא יכול להגיע מ---help של ה-CLI, ולכן הוא נוסף לרשימה כאן. */
const withGod = (modes) => (modes.includes(GOD_MODE) ? modes : [...modes, GOD_MODE]);
/** קלט מקוצר ליומן — מה שמוצג בכרטיס, בלי לגרור תוכן קובץ שלם לכל מכשיר. */
function godInput(input) {
  if (!input || typeof input !== 'object') return {};
  const clip = (t) => (t.length > 400 ? t.slice(0, 400) + '…' : t);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = clip(v);
    else if (v && typeof v === 'object') { const t = JSON.stringify(v); out[k] = t.length > 2000 ? clip(t) : v; }
    else out[k] = v;
  }
  return out;
}
// מודלים חינמיים מגיעים משער מקומי של claude-code-router, שמדבר Anthropic ומתרגם ל-Gemini.
// אם השער לא רץ הכל מדלג בשקט והתפריט נשאר בדיוק כפי שהיה.
const CCR_DIR = path.join(os.homedir(), '.claude-code-router');
const CCR_GATEWAY = process.env.CCR_GATEWAY_URL || 'http://127.0.0.1:3456';
let ccrKey = null;
let ccrModelIds = new Set();

function fetchCcrKey() {
  return new Promise((resolve) => {
    let helper;
    try {
      const bin = path.join(CCR_DIR, 'bin');
      const f = fs.readdirSync(bin).find((n) => n.startsWith('ccr-claude-code-api-key-'));
      if (!f) return resolve(null);
      helper = path.join(bin, f);
    } catch { return resolve(null); }
    execFile(helper, [], { timeout: 5000 }, (err, stdout) => resolve(err ? null : (stdout || '').trim() || null));
  });
}
async function fetchGatewayModels() {
  const key = await fetchCcrKey();
  ccrKey = key;
  if (!key) return null;
  return new Promise((resolve) => {
    const req = http.request(new URL('/v1/models', CCR_GATEWAY),
      { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
      (x) => {
        let d = '';
        x.on('data', (c) => d += c);
        x.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (!Array.isArray(j.data)) return resolve(null);
            // המודלים האלה לא תומכים ב---effort, לכן efforts ריק ובורר המאמץ נעלם.
            // גם `short` נושא את הסימון "חינם": בקטגוריית Gemini הם יושבים לצד
            // אותם מודלים משערים בתשלום, וצריך להיות ברור מי מי.
            resolve(j.data.map((m) => ({
              id: m.id,
              name: (m.display_name || m.id) + ' · חינם (CCR)',
              short: (m.display_name || m.id) + ' · חינם (CCR)',
              efforts: [],
            })));
          } catch { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}
function readOauthMeta() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/.credentials.json'), 'utf8'));
    const o = c.claudeAiOauth || c.oauth || {};
    return { subscriptionType: o.subscriptionType || null };
  } catch { return { subscriptionType: null }; }
}

function slugUsage(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scoped';
}
function pickUtilization(o) {
  return o && typeof o.utilization === 'number'
    ? { pct: o.utilization, resets_at: o.resets_at || null }
    : null;
}
/** מפרסר את תשובת /api/oauth/usage — כולל limits[] החדש (Fable וכו׳) וגם מפתחות ישנים. */
function parseUsagePayload(j) {
  if (!j || typeof j !== 'object' || j.error) return null;
  const windows = [];

  if (Array.isArray(j.limits) && j.limits.length) {
    for (const lim of j.limits) {
      const pct = typeof lim.percent === 'number' ? lim.percent
        : (typeof lim.utilization === 'number' ? lim.utilization : null);
      if (pct == null) continue;
      const kind = lim.kind;
      const resets_at = lim.resets_at || null;
      if (kind === 'session') {
        windows.push({ id: 'session', kind, label: 'סשן נוכחי', pct, resets_at });
      } else if (kind === 'weekly_all') {
        windows.push({ id: 'weekly', kind, label: 'כל המודלים', pct, resets_at });
      } else if (kind === 'weekly_scoped') {
        const name = lim.scope && lim.scope.model && lim.scope.model.display_name;
        const label = (typeof name === 'string' && name.trim()) ? name.trim() : 'מודל';
        windows.push({ id: 'scoped-' + slugUsage(label), kind, label, pct, resets_at });
      }
    }
  }

  if (!windows.length) {
    const fh = pickUtilization(j.five_hour);
    const sd = pickUtilization(j.seven_day);
    if (fh) windows.push({ id: 'session', kind: 'session', label: 'סשן נוכחי', pct: fh.pct, resets_at: fh.resets_at });
    if (sd) windows.push({ id: 'weekly', kind: 'weekly_all', label: 'כל המודלים', pct: sd.pct, resets_at: sd.resets_at });
    const known = {
      seven_day_opus: 'Opus',
      seven_day_sonnet: 'Sonnet',
      seven_day_fable: 'Fable',
      seven_day_cowork: 'Cowork',
    };
    for (const [key, label] of Object.entries(known)) {
      const w = pickUtilization(j[key]);
      if (w) windows.push({ id: 'scoped-' + slugUsage(label), kind: 'weekly_scoped', label, pct: w.pct, resets_at: w.resets_at });
    }
    for (const key of Object.keys(j)) {
      if (!key.startsWith('seven_day_') || known[key]) continue;
      const w = pickUtilization(j[key]);
      if (!w) continue;
      const label = key.slice('seven_day_'.length).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      windows.push({ id: 'scoped-' + slugUsage(label), kind: 'weekly_scoped', label, pct: w.pct, resets_at: w.resets_at });
    }
  }

  if (!windows.length) return null;
  const session = windows.find((w) => w.kind === 'session') || null;
  const weekly = windows.find((w) => w.kind === 'weekly_all') || null;
  return {
    windows,
    five_hour: session ? { pct: session.pct, resets_at: session.resets_at } : null,
    seven_day: weekly ? { pct: weekly.pct, resets_at: weekly.resets_at } : null,
    plan: readOauthMeta().subscriptionType,
  };
}

// ניצול מכסת החשבון — נמשך חי מאותו endpoint של Claude Code (כולל Fable / scoped)
function fetchUsage() {
  return new Promise((resolve) => {
    const tok = readOauthToken();
    if (!tok) return resolve(null);
    const req = https.request('https://api.anthropic.com/api/oauth/usage',
      { headers: {
        Authorization: 'Bearer ' + tok,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.0',
        Accept: 'application/json',
      } },
      (x) => {
        let d = '';
        x.on('data', (c) => d += c);
        x.on('end', () => {
          try {
            resolve(parseUsagePayload(JSON.parse(d)));
          } catch { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}
// מטמון מכסה: נשמר גם לדיסק כדי שהחלון יציג נתונים תמיד — גם אחרי הפעלה מחדש
// של השרת וגם כשה-endpoint מחזיר 429/שגיאה (לעולם לא דורסים נתון תקין קיים).
const USAGE_CACHE_FILE = path.join(os.tmpdir(), 'rtl-claude-usage.json');
function loadUsageCache() { try { return JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8')); } catch { return null; } }
function saveUsageCache(data) { try { fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(data)); } catch {} }
let usageCache = { t: 0, lastTry: 0, data: loadUsageCache() };
app.get('/api/usage', async (req, res) => {
  try {
    const now = Date.now();
    const fresh = usageCache.data && now - usageCache.t < 20000;
    // backoff: לא לנסות שוב יותר מפעם ב-15 שנ׳ (מונע הצפה ו-429 כשאין עדיין נתונים)
    const mayTry = now - usageCache.lastTry > 15000;
    if (!fresh && mayTry) {
      usageCache.lastTry = now;
      const u = await fetchUsage();
      if (u) {
        const prev = usageCache.data || {};
        const merged = {
          windows: (u.windows && u.windows.length) ? u.windows : (prev.windows || []),
          five_hour: u.five_hour || prev.five_hour || null,
          seven_day: u.seven_day || prev.seven_day || null,
          plan: u.plan || prev.plan || readOauthMeta().subscriptionType || null,
        };
        usageCache.data = merged; usageCache.t = now; saveUsageCache(merged);
      }
    }
    const data = usageCache.data || { windows: [], five_hour: null, seven_day: null };
    if (!data.plan) data.plan = readOauthMeta().subscriptionType || null;
    res.json(data);
  } catch {
    const data = usageCache.data || { windows: [], five_hour: null, seven_day: null };
    if (!data.plan) data.plan = readOauthMeta().subscriptionType || null;
    res.json(data);
  }
});

/**
 * מצרף למודלים את הקבוצה שאליה הם שייכים בבורר.
 *
 * הקבוצה נקבעת כאן ולא במקור השליפה, כדי שגם מודלים שנטענו ממטמון שנכתב
 * בגרסה ישנה (בלי שדה group) ייכנסו לקבוצה הנכונה במקום ליפול ל"אחר".
 */
const grouped = (list, group) => (list || []).map((m) => ({ ...m, group: m.group || group, short: m.short || m.name }));

/* ---------- קטגוריות בבורר המודלים ----------
   הקטגוריה היא *משפחת המודל*, לא השער שמגיש אותו. קודם הקבוצות היו שמות
   השערים (`OmniRoute · dva`, `· aug`, `· zc`, `· tllm`) — קיצורים שאי אפשר
   לנחש, ואותו Gemini היה מפוזר ביניהם בארבע קבוצות שונות. עכשיו יש קטגוריית
   Gemini אחת (וכך גם Claude, GPT וכו׳), ומזהה השער נשאר גלוי בתוך שם המודל
   עצמו (`gemini/gemini-3.1-pro-preview`) — כך שלא אבד שום מידע.

   משפחה שאינה מזוהה נשארת בקבוצת השער שלה, כדי שמודל חדש לא ייעלם בתוך סל
   "אחר" ענק. */
const DIRECT_GROUP = 'Claude · חיבור ישיר';
// קטגוריות שנקבעות לפי מקור ולא לפי שם: שירות ולא משפחה (ניתוב אוטומטי,
// תמונות, וידאו, חיפוש). הן נבדקות ראשונות, כי שמות המודלים שם חופשיים
// לגמרי — ‎aihorde/Qwen-Image‎ אינו מודל Qwen.
const SOURCE_CATEGORIES = [
  [/^omniroute\/auto\//i, 'ניתוב אוטומטי'],
  [/^omniroute\/aihorde\//i, 'תמונות · AI Horde'],
  [/^omniroute\/(veo-free|veoaifree-web)\//i, 'וידאו · Veo'],
  [/^omniroute\/felo\//i, 'חיפוש ברשת · Felo'],
  [/^local\//i, 'מודלים מקומיים'],
];
// משפחות לפי שם המודל. הסדר כאן הוא סדר הבדיקה — הכלל הראשון שמתאים זוכה.
const MODEL_FAMILIES = [
  ['Gemini · Google', /gemini|nano-banana|lyria|imagen|antigravity|deep-research|(^|[^a-z])aqa([^a-z]|$)/i],
  ['Claude · דרך שערים', /claude|opus|sonnet|haiku|fable/i],
  ['GPT · OpenAI', /gpt|codex|(^|[-_/])o[1-4]($|[-_])/i],
  ['Grok · xAI', /grok/i],
  ['GLM · Z.ai', /glm|(^|[-_/])zai($|[-_])/i],
  ['Kimi · Moonshot', /kimi|moonshot/i],
  ['DeepSeek', /deepseek/i],
  ['Qwen · Alibaba', /qwen|qwq/i],
  ['Llama · Meta', /llama/i],
  ['Gemma · Google', /gemma/i],
  ['Mistral', /mistral|mixtral|magistral|codestral|ministral/i],
  ['Nemotron · NVIDIA', /nemotron/i],
  ['MiniMax', /minimax/i],
  ['Perplexity', /sonar|perplexity/i],
];
// סדר הקטגוריות בתפריט. '*' הוא המקום שאליו נופלת כל קבוצה שאינה ברשימה
// (קבוצות שער של משפחות לא מזוהות), כדי ששירותי התמונה והווידאו יישארו בסוף.
const CATEGORY_ORDER = [
  DIRECT_GROUP,
  cursor.CURSOR_GROUP,
  'Gemini · Google',
  'Claude · דרך שערים',
  'GPT · OpenAI',
  'Grok · xAI',
  'GLM · Z.ai',
  'Kimi · Moonshot',
  'DeepSeek',
  'Qwen · Alibaba',
  'Llama · Meta',
  'Gemma · Google',
  'Mistral',
  'Nemotron · NVIDIA',
  'MiniMax',
  'Perplexity',
  'ניתוב אוטומטי',
  'מודלים מקומיים',
  '*',
  'חיפוש ברשת · Felo',
  'תמונות · AI Horde',
  'וידאו · Veo',
];
const CATEGORY_FALLBACK_RANK = CATEGORY_ORDER.indexOf('*');

function categoryOf(m) {
  // החיבור הישיר מול Anthropic הוא מסלול ולא משפחה: הוא נשאר קטגוריה נפרדת
  // וראשונה, כי זו ברירת המחדל שבה רוב השיחות רצות.
  if (m.group === DIRECT_GROUP) return DIRECT_GROUP;
  // מודלי Cursor מגיעים מקובצים מראש לפי משפחה (ראו familyOf בגשר). מיונם
  // מחדש לפי שם היה מפזר אותם בין מודלי Anthropic הישירים, ואת ההבחנה
  // היחידה שבאמת חשובה כאן — איזה סוכן ירוץ — אי אפשר היה לראות בבורר.
  if (String(m.group || '').startsWith(cursor.CURSOR_GROUP)) return m.group;
  const id = String(m.id || '');
  for (const [re, group] of SOURCE_CATEGORIES) if (re.test(id)) return group;
  // רק החלק האחרון של המזהה: שם השער עצמו (`gemini/`, `aug/`) היה מטה כל מודל
  // שהוא מגיש למשפחה שלו. השם המוצג נבדק גם הוא, לספקים שמזהיהם אטומים.
  const leaf = id.slice(id.lastIndexOf('/') + 1) + ' ' + String(m.name || '');
  for (const [group, re] of MODEL_FAMILIES) if (re.test(leaf)) return group;
  // משפחה שלא זוהתה (מודל חדש, שם פנימי של שער) — קבוצה אחת לכל שער, ולא
  // תת-קבוצה לכל קיצור פנימי שלו (`dva`, `oc`, `cfp`). הקיצור ממילא נשאר
  // גלוי במזהה המודל, וכך הוא לא הופך לכותרת שאי אפשר לנחש מה מאחוריה.
  const src = String(m.group || '').split(' · ')[0].trim();
  return src ? 'מודלים נוספים · ' + src : 'מודלים נוספים';
}

/**
 * ממיין את כל המודלים לקטגוריות ולסדר שבו הן יופיעו בבורר.
 * המיון יציב, ולכן בתוך קטגוריה נשמר סדר ההגעה: קודם החיבור הישיר, אחריו
 * השער החינמי, ובסוף הספקים תואמי-OpenAI לפי סדר טעינתם.
 */
function categorize(list) {
  // קבוצות Cursor הן משפחה של קבוצות ('Cursor · סוכן CLI · Claude' וכו'), ולכן
  // הדירוג שלהן נקבע לפי הקידומת: כולן יושבות יחד, מיד אחרי החיבור הישיר.
  const rank = (g) => {
    if (String(g || '').startsWith(cursor.CURSOR_GROUP)) return CATEGORY_ORDER.indexOf(cursor.CURSOR_GROUP);
    const i = CATEGORY_ORDER.indexOf(g);
    return i < 0 ? CATEGORY_FALLBACK_RANK : i;
  };
  return list
    .map((m) => ({ ...m, group: categoryOf(m) }))
    .sort((a, b) => rank(a.group) - rank(b.group));
}

let cfgCache = { t: 0, models: loadModelsCache() || FALLBACK_MODELS, perms: null, gateway: [], cursor: [] };
async function getConfig() {
  const now = Date.now();
  if (!cfgCache.models || now - cfgCache.t > 300000) {
    const [models, perms, gateway, cur] = await Promise.all([
      fetchModels(), fetchPermissionModes(), fetchGatewayModels(),
      // רשימת Cursor נשלפת מה-CLI שלו ונשמרת בדיסק בתוך הגשר; היעדר ה-CLI
      // מחזיר רשימה ריקה, והקבוצה פשוט לא מופיעה בבורר.
      cursor.fetchModels().catch(() => []),
    ]);
    cfgCache.cursor = cur || [];
    if (models && models.length) {
      cfgCache.models = models;
      saveModelsCache(models);
    } else if (!cfgCache.models || !cfgCache.models.length) {
      cfgCache.models = loadModelsCache() || FALLBACK_MODELS;
    }
    if (perms) cfgCache.perms = perms;
    cfgCache.gateway = gateway || [];
    ccrModelIds = new Set(cfgCache.gateway.map((m) => m.id));
    cfgCache.t = now;
  }
  return {
    // סדר הרשימה הוא סדר הקבוצות בבורר, ולכן הוא נקבע כאן ולא בדפדפן —
    // ראו categorize.
    //
    // מודלי הספקים תואמי-OpenAI נקראים מהמעקב ולא נשלפים כאן: הרשימה תמיד
    // עדכנית, ו-/api/config לא ממתין לרשת כשספק כבוי. כבוי או לא מותקן →
    // רשימה ריקה, והתפריט כרגיל.
    models: categorize([
      ...grouped(cfgCache.models || FALLBACK_MODELS, DIRECT_GROUP),
      ...(cfgCache.cursor || []),
      ...grouped(cfgCache.gateway, 'Gemini · Google'),
      ...oaiProviders.flatMap((p) => p.getModels()),
    ]),
    permissionModes: withGod(cfgCache.perms || ['acceptEdits', 'plan', 'bypassPermissions']),
    // מצבי ההרשאה של Cursor אינם אותם מצבים, והבורר מחליף ביניהם לפי המודל
    // שנבחר. שליחת שתי הרשימות מראש חוסכת סיבוב נוסף בכל החלפת מודל.
    cursorPermissionModes: cursor.PERM_MODES,
    cursorPermissionDefault: cursor.PERM_DEFAULT,
    cursorPrefix: cursor.PREFIX,
  };
}
// חימום מוקדם כדי ש-ccrModelIds יהיה מאוכלס גם אם מריצים לפני שה-UI ביקש /api/config
getConfig().catch(() => {});
// גשר לכל ספק תואם-OpenAI — עולה פעם אחת ומשרת את כל השיחות. ספק שגשרו לא
// עלה נשאר בלי ערך ב-oaiBridges, ובחירת מודל שלו תדווח שגיאה מפורשת במקום להיתקע.
const oaiBridges = new Map();   // id של ספק → { url, token }
for (const p of oaiProviders) {
  p.startBridge().then((b) => { if (b) oaiBridges.set(p.id, b); }).catch(() => {});
  // מעקב זמינות: הבדיקה הראשונה יוצאת מיד ולא חוסמת את העלייה. אם הספק עדיין
  // עולה (docker compose, או מחשב שעוד לא דלוק), המודלים ייכנסו לתפריט מעצמם.
  p.startModelWatcher(() => {});
}
app.get('/api/config', async (req, res) => {
  // anonymous: האם הכפתור "צ׳אט אנונימי" בכלל יכול לעבוד כאן. הבדיקה היא על
  // ה-CLI המותקן, ולכן היא שייכת לשרת — ראו anonCapable.
  try { res.json({ ...(await getConfig()), anonymous: anonCapable }); }
  catch { res.json({ models: FALLBACK_MODELS, permissionModes: withGod(['acceptEdits', 'plan', 'bypassPermissions']), anonymous: anonCapable }); }
});

// ---------- העלאת תמונות (נשמרות זמנית ב-temp ומנוקות אוטומטית) ----------
// תמונה שהודבקה/הועלתה מהדפדפן אין לה נתיב אמיתי על הדיסק, לכן נשמור עותק זמני
// שה-CLI יוכל לקרוא ממנו — והוא יימחק אוטומטית אחרי TTL.
const UPLOAD_DIR = path.join(os.tmpdir(), 'rtl-claude-uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000; // 6 שעות
function cleanupUploads() {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f);
      fs.stat(p, (e, st) => { if (!e && now - st.mtimeMs > UPLOAD_TTL_MS) fs.unlink(p, () => {}); });
    }
  });
}
cleanupUploads();
setInterval(cleanupUploads, 60 * 60 * 1000).unref();

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };
app.post('/api/upload', express.json({ limit: '30mb' }), (req, res) => {
  try {
    const { name, dataUrl } = req.body || {};
    // בצ'אט אנונימי התמונה נשלחת למודל כ-base64 בלבד. עותק זמני בדיסק היה
    // עקבה לכל דבר (ועוד כזו ששורדת שש שעות), ולכן הבקשה נדחית ולא "מטופלת".
    if ((req.body || {}).anon) return res.status(403).json({ ok: false, error: 'anon' });
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
    if (!m) return res.status(400).json({ ok: false, error: 'bad data' });
    const mime = m[1];
    if (!mime.startsWith('image/')) return res.status(400).json({ ok: false, error: 'not image' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 30 * 1024 * 1024) return res.status(413).json({ ok: false });
    const safe = ((name || 'image').replace(/[^\w.\-]+/g, '_')).slice(-40) || 'image';
    const base = safe.replace(/\.[^.]*$/, '') || 'image';
    const ext = EXT_BY_MIME[mime] || ((safe.match(/\.([a-z0-9]+)$/i) || [, 'png'])[1]);
    const fname = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${base}.${ext}`;
    const full = path.join(UPLOAD_DIR, fname);
    fs.writeFileSync(full, buf);
    res.json({ ok: true, path: full, name: `${base}.${ext}` });
  } catch (e) { res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
});

// ---------- עזרי נתיבים ----------
/* ------------------------------------------------------------------------
   "ללא תיקייה" — שיחה פשוטה מול המודל
   ------------------------------------------------------------------------
   הערך הזה נוסע מהלקוח באותו שדה cwd שבו נוסע נתיב רגיל, ולכן כל נקודה שכבר
   קוראת ל-resolveDirGlobal (סשנים, פקודות, חיפוש קבצים, החייאת שיחה) מבינה
   אותו בלי שינוי. הוא אינו נתיב אלא סימן: הוא נפתר לתיקייה ריקה ייעודית,
   שכל תפקידה לתת לתהליך מקום לעמוד בו וכתובת יציבה לקובץ הסשן — כך ש---resume
   עובד גם בשיחה כזו. הכלים כבויים בה (ראו startChild), ולכן התיקייה נשארת
   ריקה בפועל.

   הטקסט עצמו הוא מה שמוצג בשדה בממשק, ולכן הוא עברית ולא סימן טכני. הוא חייב
   להיות זהה לקבוע NO_DIR שבצד הלקוח. */
const NO_DIR = '(ללא תיקייה)';
const NO_DIR_PATH = path.join(os.homedir(), '.rtl-claude', 'chat');
const isNoDir = (d) => typeof d === 'string' && d.trim() === NO_DIR;
function noDirPath() {
  try { fs.mkdirSync(NO_DIR_PATH, { recursive: true }); } catch {}
  return NO_DIR_PATH;
}

function resolveDirGlobal(d) {
  if (isNoDir(d)) return noDirPath();
  if (!d || !d.trim()) return os.homedir();
  d = d.trim();
  const resolved = d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d;
  try { if (fs.statSync(resolved).isDirectory()) return resolved; } catch {}
  return os.homedir();
}
// קידוד תיקייה כפי ש-Claude Code שומר סשנים: כל תו שאינו אות/ספרה → מקף
const encodeProjectDir = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// ---------- @ אזכור קבצים: חיפוש קבצים בתיקיית העבודה ----------
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'target', 'vendor', '.venv', '__pycache__', '.cache', 'coverage']);
app.get('/api/files', (req, res) => {
  const root = resolveDirGlobal(req.query.cwd);
  const q = (req.query.q || '').toString().toLowerCase();
  const out = [];
  const LIMIT = 400, MAX_NODES = 20000;
  let seen = 0;
  (function walk(dir, rel, depth) {
    if (out.length >= LIMIT || seen >= MAX_NODES || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= LIMIT || seen >= MAX_NODES) return;
      seen++;
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const relPath = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), relPath, depth + 1);
      } else if (e.isFile()) {
        if (!q || relPath.toLowerCase().includes(q)) out.push(relPath);
      }
    }
  })(root, '', 0);
  // מיון: התאמות בשם הקובץ קודם, ואז לפי אורך
  out.sort((a, b) => {
    const an = a.slice(a.lastIndexOf('/') + 1).toLowerCase().includes(q) ? 0 : 1;
    const bn = b.slice(b.lastIndexOf('/') + 1).toLowerCase().includes(q) ? 0 : 1;
    return an - bn || a.length - b.length;
  });
  res.json({ files: out.slice(0, 60) });
});

// ---------- סשנים קיימים על הדיסק (להמשך עם --resume) ----------
app.get('/api/sessions', (req, res) => {
  const root = resolveDirGlobal(req.query.cwd);
  // הרשימה היא "מה אפשר להמשיך כאן", והיא תלויה בסוכן: שיחות Cursor שמורות
  // במקום אחר ובמבנה אחר, ומזהה של אחד אינו קביל לשני (ראו cliAgent).
  if (req.query.agent === 'cursor') {
    try { return res.json({ sessions: cursor.listSessions(root), agent: 'cursor' }); }
    catch { return res.json({ sessions: [], agent: 'cursor' }); }
  }
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(root));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return res.json({ sessions: [] }); }
  const sessions = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let st; try { st = fs.statSync(full); } catch { continue; }
    const sid = f.replace(/\.jsonl$/, '');
    let title = '', turns = 0;
    try {
      const head = fs.readFileSync(full, 'utf8').split('\n');
      for (const line of head) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'summary' && j.summary && !title) title = j.summary;
        const msg = j.message;
        if (msg && msg.role === 'user') {
          turns++;
          if (!title) {
            const c = msg.content;
            let t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text : '';
            if (t && !/^<(command|local)/.test(t) && !t.startsWith('Caveat:')) title = t;
          }
        }
        if (title && turns > 30) break;
      }
    } catch {}
    sessions.push({ id: sid, title: (title || 'שיחה ללא כותרת').slice(0, 80), turns, mtime: st.mtimeMs });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  res.json({ sessions: sessions.slice(0, 40) });
});

// ---------- Rewind: פיצול סשן לנקודה קודמת (fork לא-הרסני) ----------
// יוצר עותק חדש של קובץ הסשן החתוך עד לפני ההודעה ה-N של המשתמש, עם session id
// חדש. הקובץ המקורי נשאר שלם. הלקוח ממשיך עם --resume על ה-id החדש.
// חשוב: תוצאות-כלי מגיעות גם הן כרשומות role:'user', לכן חותכים רק לפני הודעת
// משתמש "אמיתית" (content שאינו tool_result) כדי לא לחתוך באמצע תור.
const isRealUserPrompt = (j) => {
  if (!j || j.type !== 'user' || !j.message || j.message.role !== 'user') return false;
  const c = j.message.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return !c.some((b) => b && b.type === 'tool_result');
  return false;
};
app.post('/api/fork', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const { cwd, sessionId, promptOrdinal } = req.body || {};
    if (!sessionId || typeof promptOrdinal !== 'number') return res.status(400).json({ ok: false });
    const root = resolveDirGlobal(cwd);
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(root));
    const src = path.join(dir, path.basename(sessionId) + '.jsonl');
    let raw;
    try { raw = fs.readFileSync(src, 'utf8'); } catch { return res.status(404).json({ ok: false, error: 'session not found' }); }
    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const prompts = [];
    parsed.forEach((j, i) => { if (isRealUserPrompt(j)) prompts.push(i); });
    if (promptOrdinal < 0 || promptOrdinal >= prompts.length) return res.status(400).json({ ok: false, error: 'bad ordinal' });
    const cut = prompts[promptOrdinal];
    const newId = crypto.randomUUID();
    const kept = lines.slice(0, cut).map((l, i) => {
      const j = parsed[i];
      if (j && j.sessionId) { j.sessionId = newId; return JSON.stringify(j); }
      return l;
    });
    fs.writeFileSync(path.join(dir, newId + '.jsonl'), kept.length ? kept.join('\n') + '\n' : '');
    res.json({ ok: true, newSessionId: newId });
  } catch (e) { res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
});

// ---------- התור האחרון כפי שהוא בקובץ הסשן של Claude ----------
// התמליל של rtl-claude נבנה בדפדפן מזרם האירועים, ומשם נכתב לדיסק. כשהזרם
// נקטע באמצע תשובה (השרת ירד, הרשת נפלה, הטלפון נרדם) — מה שנכתב קטוע, ולכן
// השוואה של המסך מול הדיסק של rtl-claude לא מגלה דבר: שניהם קטועים בדיוק
// באותו מקום. ה-CLI לעומת זאת כותב את התור המלא לקובץ הסשן שלו, וזה מקור
// האמת היחיד שלא עבר דרך הדפדפן. עליו נשען הקרוס־צ'ק כשהוא נשאל ידנית.
//
// מוחזרות מספר התורות האחרונות ולא רק האחרון: קטיעה מתגלה בדרך כלל באיחור,
// אחרי שכבר נשלחה הודעה נוספת, ואז התור הפגוע כבר אינו האחרון.
const TAIL_TURNS = 4;
app.get('/api/session-tail', (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return res.status(400).json({ ok: false, error: 'bad-session' });
  const root = resolveDirGlobal(req.query.cwd);
  const src = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(root), sessionId + '.jsonl');
  let raw;
  try { raw = fs.readFileSync(src, 'utf8'); } catch { return res.json({ ok: true, found: false }); }

  const parsed = raw.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  // תור = מפרומפט אמיתי של המשתמש עד הפרומפט הבא. תוצאות-כלי הן גם הן רשומות
  // role:'user', ולכן isRealUserPrompt הוא מה שמבדיל ביניהן.
  const starts = [];
  parsed.forEach((j, i) => { if (j && !j.isSidechain && isRealUserPrompt(j)) starts.push(i); });
  if (!starts.length) return res.json({ ok: true, found: false });

  const promptOf = (j) => {
    const c = j.message.content;
    if (typeof c === 'string') return c;
    return (Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text : '') || '';
  };

  /** בונה את בלוקי התור בפורמט שהממשק מצייר (ראו sanitizeConv). */
  function buildTurn(from, to) {
    const blocks = [];
    const byToolId = new Map();
    for (let i = from + 1; i < to; i++) {
      const j = parsed[i];
      // תת-סוכן כותב לאותו קובץ. הבלוקים שלו שייכים לכרטיס הכלי שהפעיל אותו,
      // לא לתמליל הראשי, ולכן הם מדולגים.
      if (!j || j.isSidechain || j.isMeta) continue;
      const msg = j.message;
      if (!msg || !Array.isArray(msg.content)) continue;

      if (j.type === 'assistant') {
        for (const b of msg.content) {
          if (!b) continue;
          if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: trimText(String(b.text), MAX_BLOCK_TEXT) });
          else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: trimText(String(b.thinking || ''), MAX_BLOCK_TEXT), tokens: 0 });
          else if (b.type === 'tool_use') {
            const t = { type: 'tool', id: b.id, name: b.name, status: 'run', isError: false, input: trimToolInput(b.input || {}), result: null };
            byToolId.set(b.id, t);
            blocks.push(t);
          }
        }
      } else if (j.type === 'user') {
        for (const b of msg.content) {
          if (!b || b.type !== 'tool_result') continue;
          const t = byToolId.get(b.tool_use_id);
          if (!t) continue;
          const c = b.content;
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '';
          t.result = trimText(String(text || ''), MAX_TOOL_TEXT);
          t.isError = !!b.is_error;
          t.status = b.is_error ? 'err' : 'ok';
        }
      }
    }
    return blocks;
  }

  const turns = [];
  for (let k = Math.max(0, starts.length - TAIL_TURNS); k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : parsed.length;
    turns.push({ prompt: promptOf(parsed[from]).slice(0, 4000), blocks: buildTurn(from, to) });
  }

  res.json({ ok: true, found: true, turns });
});

// ---------- אחסון שיחות בדיסק ----------
// עד כה ההיסטוריה נשמרה כמחרוזת אחת ב-localStorage. המכסה (~5MB) התמלאה,
// ה-setItem נכשל בשקט (catch ריק) — ומאותו רגע שום שיחה לא נשמרה יותר.
// עכשיו כל שיחה היא קובץ JSON נפרד תחת ~/.claude/rtl-claude/conversations,
// נכתב אטומית (tmp + rename) כך שקריסה באמצע כתיבה לא משחיתה קובץ קיים.
const STORE_DIR = path.join(os.homedir(), '.claude', 'rtl-claude');
const CONV_DIR = path.join(STORE_DIR, 'conversations');
const SETTINGS_FILE = path.join(STORE_DIR, 'settings.json');
try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch (e) { console.error('[store] יצירת תיקיית האחסון נכשלה:', e.message); }

/* ==========================================================================
   צ'אט אנונימי — שיחה שלא קיימת בשום מקום מלבד הזיכרון
   --------------------------------------------------------------------------
   כל שאר המנגנונים כאן בנויים סביב ההנחה ההפוכה: השיחה נכתבת לדיסק, ה-CLI
   שומר קובץ סשן שאפשר לחזור אליו, והיומן מתעד כל תור כדי שאפשר יהיה לאבחן
   תקלה למחרת. בצ'אט אנונימי כל אחת מההנחות האלה היא דליפה, ולכן כולן מבוטלות
   בבת אחת — ולא דרך "בקשה יפה" מהלקוח אלא ברמת השרת:

     • מזהה השיחה מתחיל ב-`anon-`. זה הסימן היחיד שצריך: כל נתיב כתיבה בשרת
       (קובץ שיחה, קובץ ההמתנה, היומן) בודק אותו ומסרב.
     • ה-CLI מורץ עם ‎--no-session-persistence‎ — הוא לא כותב קובץ סשן, וממילא
       אין ל---resume למה להיאחז. לכן גם התהליך עצמו לא מוחלף באמצע שיחה:
       ההקשר חי בזיכרון התהליך בלבד, ונעלם איתו.
     • אין שורת יומן אחת עם תוכן השיחה — ‎dbg‎ בולע כל רשומה של מזהה אנונימי,
       כולל מה שהדפדפן שולח ל-/api/client-log.

   מה שנשאר מחוץ לשליטתנו נאמר במפורש בממשק: הבקשות עדיין עוברות ל-Anthropic
   (או לספק שנבחר) כמו כל שיחה, וזיכרון התהליך יכול להיכתב ל-swap של מערכת
   ההפעלה. "אנונימי" כאן = לא נשמר אצלנו, לא ב-CLI, ולא ביומן.
   ========================================================================== */
const ANON_PREFIX = 'anon-';
const isAnonId = (id) => typeof id === 'string' && id.startsWith(ANON_PREFIX);

/* ==========================================================================
   יומן ריצה
   התקלות שקשה לתפוס — תור שנתקע, קרוס־צ'ק שלא תיקן, חיבור שמת בשקט — קורות
   כמעט תמיד בטלפון, ושם אין קונסולה לפתוח ואין stderr לקרוא. לכן הכול נאסף
   לקובץ אחד: מה שהשרת רואה, ומה שהדפדפן מדווח דרך /api/client-log, באותו
   סדר זמנים. בלי זה העדות היחידה על בדיקה שנכשלה היא toast שנעלם אחרי שנייה.
   הקובץ נשאר גם אחרי אתחול (בניגוד ל-/tmp/rtl-claude.log של launch.sh), ונקרא
   מהטלפון עצמו דרך /api/logs.
   ========================================================================== */
const LOG_FILE = path.join(STORE_DIR, 'rtl-claude.log');
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
let logBytes = 0;
try { logBytes = fs.statSync(LOG_FILE).size; } catch {}

function logLine(text) {
  const line = text.replace(/\n+$/, '') + '\n';
  try {
    // סיבוב לפני הכתיבה ולא אחריה, כדי שהמידה תיבדק מול הקובץ שאליו כותבים
    if (logBytes > LOG_ROTATE_BYTES) { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); logBytes = 0; }
    fs.appendFileSync(LOG_FILE, line);
    logBytes += Buffer.byteLength(line);
  } catch {}   // יומן שנכשל לעולם לא יפיל את השרת
}

// שעון מקומי ולא UTC: היומן נקרא מול השעון שבפינת המסך ומול הרגע שבו ראית את התקלה
const logStamp = () => {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};
const HHMMSS = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;
const logFmt = (v) => {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

/** שורת יומן מתויגת. לא מודפסת למסך — הקונסולה שמורה להודעות למשתמש. */
function dbg(tag, data) {
  // שיחה אנונימית לא נכנסת ליומן. זה נבדק כאן, בנקודת הכתיבה היחידה, ולא
  // בכל אחד מעשרות אתרי הקריאה — כולל אלה שמגיעים מהדפדפן דרך /api/client-log.
  if (data && typeof data === 'object' && (isAnonId(data.convId) || isAnonId(data.id))) return;
  logLine(logStamp() + ' ' + tag + (data === undefined ? '' : ' ' + logFmt(data)));
}

// כל מה שכבר נכתב לקונסולה נכנס גם ליומן, בלי לגעת באף קריאה קיימת.
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    const text = args.map(logFmt).join(' ').replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (text) logLine(logStamp() + ' [' + level + '] ' + text);
  };
}
logLine('\n=== rtl-claude עלה ' + new Date().toString() + ' pid=' + process.pid + ' ===');
process.on('uncaughtException', (e) => { dbg('fatal.uncaught', e); throw e; });
process.on('unhandledRejection', (e) => dbg('fatal.reject', e));

/* שורות יומן מהדפדפן. הטלפון אוגר אותן ושולח בחבילות; אנחנו רק מתייגים מי
   שלח ומתי הוא עצמו רשם אותן — הזמן שלו, כי חבילה יכולה להתעכב עד שהרשת חוזרת. */
app.post('/api/client-log', express.json({ limit: '256kb' }), (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  const who = deviceLabel(req);
  for (const r of rows.slice(-300)) {
    if (!r || !r.tag) continue;
    // הזמן של הטלפון עצמו — חבילה שנתקעה עד שהרשת חזרה תיכתב עכשיו אבל נרשמה אז
    const at = typeof r.at === 'string' && HHMMSS.test(r.at) ? r.at : '';
    dbg('[' + who + (at ? ' ' + at : '') + '] ' + String(r.tag).slice(0, 40), r.data);
  }
  res.json({ ok: true });
});

/* קריאת היומן מהמכשיר שבו התקלה קרתה, בלי SSH ובלי כבל. */
app.get('/api/logs', (req, res) => {
  const n = Math.min(Math.max(parseInt(req.query.n, 10) || 300, 1), 5000);
  const grep = String(req.query.grep || '');
  let text = '';
  try { text = fs.readFileSync(LOG_FILE, 'utf8'); } catch {}
  let lines = text.split('\n').filter((l) => l.trim());
  if (grep) { try { const re = new RegExp(grep, 'i'); lines = lines.filter((l) => re.test(l)); } catch {} }
  res.type('text/plain; charset=utf-8').send(lines.slice(-n).join('\n') + '\n');
});

const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;
const convPath = (id) => path.join(CONV_DIR, id + '.json');

// גבולות גודל: פלט של Read/Bash יכול להיות מגה-בייטים. שומרים תחילה+סוף
// כדי שהכרטיס יישאר קריא בלי לנפח את הקובץ.
const MAX_TOOL_TEXT = 24000;
const MAX_BLOCK_TEXT = 200000;
function trimText(s, max) {
  if (typeof s !== 'string' || s.length <= max) return s;
  const head = Math.floor(max * 0.7), tail = max - head;
  return s.slice(0, head) + `\n\n… [נחתכו ${s.length - max} תווים] …\n\n` + s.slice(-tail);
}
function trimToolInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = Array.isArray(input) ? [] : {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = trimText(v, MAX_TOOL_TEXT);
    else if (v && typeof v === 'object') out[k] = trimToolInput(v);
    else out[k] = v;
  }
  return out;
}
/** מנרמל וגוזם שיחה נכנסת לפני כתיבה לדיסק. */
function sanitizeConv(c) {
  if (!c || typeof c !== 'object' || !VALID_ID.test(String(c.id || ''))) return null;
  const messages = (Array.isArray(c.messages) ? c.messages : []).map((m) => {
    if (!m || typeof m !== 'object') return null;
    if (m.role === 'user') {
      return {
        role: 'user',
        text: trimText(String(m.text || ''), MAX_BLOCK_TEXT),
        ...(Array.isArray(m.atts) && m.atts.length ? { atts: m.atts.slice(0, 20) } : {}),
      };
    }
    if (m.role !== 'assistant') return null;
    const blocks = (Array.isArray(m.blocks) ? m.blocks : []).map((b) => {
      if (!b || typeof b !== 'object') return null;
      if (b.type === 'text') return { type: 'text', text: trimText(String(b.text || ''), MAX_BLOCK_TEXT) };
      // tokens נשמר כי בחשיבה מוצפנת (תוכן ריק) זה כל מה שיש להציג
      if (b.type === 'thinking') return { type: 'thinking', text: trimText(String(b.text || ''), MAX_BLOCK_TEXT), tokens: Number(b.tokens) || 0 };
      if (b.type === 'tool') {
        return {
          type: 'tool', id: b.id, name: b.name, status: b.status || 'ok', isError: !!b.isError,
          input: trimToolInput(b.input || {}),
          result: b.result == null ? null : trimText(String(b.result), MAX_TOOL_TEXT),
          // דחיית הרשאה של Cursor נשמרת מאותה סיבה שכרטיס שאלה נשמר: היא
          // הסיבה שהכלי לא רץ, והכפתור שמתיר אותו תקף גם מחר. בלעדיה הכרטיס
          // היה חוזר אחרי רענון כ"נדחה" בלי לומר על-ידי מה ובלי מה לעשות.
          ...(b.rejected && typeof b.rejected === 'object' ? {
            rejected: {
              tool: String(b.rejected.tool || '').slice(0, 80),
              rule: String(b.rejected.rule || '').slice(0, 200),
              mode: String(b.rejected.mode || '').slice(0, 40),
            },
          } : {}),
        };
      }
      // כרטיס שאלה/הרשאה — נשמר כדי שהתשובה שנתת תישאר בתמליל
      if (b.type === 'ask') {
        return {
          type: 'ask', id: b.id, tool: b.tool, description: b.description || '',
          input: trimToolInput(b.input || {}),
          decision: b.decision || null, answers: b.answers || null, response: b.response || '',
        };
      }
      // כרטיס עצירה — הסיבה שבגללה התור נקטע. נשמר בתמליל דווקא כי בלעדיו
      // חוזרים לשיחה למחרת ורואים תשובה שנגמרת באמצע משפט בלי שום הסבר.
      if (b.type === 'halt') {
        return {
          type: 'halt',
          reason: String(b.reason || 'error').slice(0, 60),
          title: String(b.title || '').slice(0, 200),
          detail: trimText(String(b.detail || ''), MAX_TOOL_TEXT),
          soft: !!b.soft,
          model: String(b.model || '').slice(0, 100),
          at: Number(b.at) || 0,
        };
      }
      return null;
    }).filter(Boolean);
    return { role: 'assistant', blocks };
  }).filter(Boolean);
  const now = Date.now();
  return {
    id: c.id,
    title: String(c.title || 'שיחה ללא כותרת').slice(0, 200),
    sessionId: c.sessionId || null,
    cwd: typeof c.cwd === 'string' ? c.cwd : '',
    draft: trimText(String(c.draft || ''), 20000),
    cost: typeof c.cost === 'number' ? c.cost : 0,
    ctx: c.ctx && typeof c.ctx === 'object' ? c.ctx : null,
    createdAt: Number(c.createdAt) || now,
    updatedAt: Number(c.updatedAt) || Number(c.createdAt) || now,
    messages,
  };
}
/** תקציר לרשימת השיחות — בלי גוף ההודעות, כדי שהטעינה הראשונה תהיה מיידית. */
function convMeta(c) {
  const { messages, versions, turns, supervisorNotes, userNotes, ...rest } = c;
  const meta = { ...rest, msgCount: Array.isArray(messages) ? messages.length : 0 };
  // ריצת דואט מחזיקה את כל גרסאות התוצר בקובץ. האינדקס נקרא בכל טעינת דף,
  // ולכן הוא מקבל את הכותרת בלבד — הגוף נמשך רק כשנכנסים לריצה עצמה.
  if (c.mode === 'duet') {
    meta.goal = String(c.goal || '').slice(0, 300);
    meta.versionCount = Array.isArray(versions) ? versions.length : 0;
    meta.turnCount = Array.isArray(turns) ? turns.length : 0;
  }
  return meta;
}
// בניית האינדקס דורשת פענוח JSON של כל קובץ. השרת חי לאורך זמן ורענון דף הוא
// פעולה נפוצה, לכן שומרים את התקציר במטמון לפי mtime — רק קובץ שהשתנה נקרא שוב.
const metaCache = new Map();
function convMetaCached(id) {
  let st;
  try { st = fs.statSync(convPath(id)); } catch { metaCache.delete(id); return null; }
  const hit = metaCache.get(id);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.meta;
  const c = readConv(id);
  if (!c || !c.id) return null;
  const meta = convMeta(c);
  metaCache.set(id, { mtimeMs: st.mtimeMs, meta });
  return meta;
}
function readConv(id) {
  try { return JSON.parse(fs.readFileSync(convPath(id), 'utf8')); } catch { return null; }
}
function writeConv(c) {
  // הבדיקה האחרונה לפני הדיסק. כל מסלול כתיבה כבר סינן מזהה אנונימי; אם
  // בכל זאת הגיע לכאן אחד — זה באג, והוא נעצר ברעש ולא בשקט.
  if (isAnonId(c.id)) throw new Error('anon conversation must never reach disk');
  const tmp = convPath(c.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, convPath(c.id));
}
function listConvIds() {
  try { return fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }
  catch { return []; }
}
function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      settings: s.settings && typeof s.settings === 'object' ? s.settings : {},
      history: Array.isArray(s.history) ? s.history.filter((x) => typeof x === 'string').slice(0, 200) : [],
      activeId: s.activeId || null,
    };
  } catch { return { settings: {}, history: [], activeId: null }; }
}
function writeSettings(s) {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, SETTINGS_FILE);
}

const storeJson = express.json({ limit: '64mb' });

// אינדקס: כל השיחות בלי גוף ההודעות + ההגדרות. זו הקריאה היחידה באתחול.
app.get('/api/store', (req, res) => {
  const conversations = [];
  for (const id of listConvIds()) {
    const meta = convMetaCached(id);
    if (meta) conversations.push(meta);
  }
  conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const s = readSettings();
  res.json({ ok: true, conversations, settings: s.settings, history: s.history, activeId: s.activeId, dir: CONV_DIR });
});

// שיחה מלאה — נטענת רק כשעוברים אליה
app.get('/api/conversations/:id', (req, res) => {
  const id = req.params.id;
  if (!VALID_ID.test(id)) return res.status(400).json({ ok: false });
  // שיחה אנונימית לא נמצאת בדיסק מעולם — אין מה לקרוא, וגם אין מה לנסות.
  if (isAnonId(id)) return res.status(404).json({ ok: false, error: 'anon' });
  const c = readConv(id);
  if (!c) return res.status(404).json({ ok: false });
  res.json({ ok: true, conversation: c });
});

// כתיבה עם בדיקת גרסה. שני מכשירים בונים את אותו תמליל מאותו זרם אירועים,
// ולכן כתיבה בו-זמנית בדרך כלל זהה — אבל מכשיר שהיה מנותק ופספס חלק מהזרם
// עלול לכתוב תמליל ישן על החדש. baseRev חוסם בדיוק את המקרה הזה: אם הגרסה
// בדיסק התקדמה מאז הקריאה, הכתיבה נדחית והקליינט קורא מחדש במקום לדרוס.
app.put('/api/conversations/:id', storeJson, (req, res) => {
  try {
    const id = req.params.id;
    if (!VALID_ID.test(id)) return res.status(400).json({ ok: false, error: 'bad id' });
    // לקוח ישן (או תקול) שינסה לשמור שיחה אנונימית — נדחה. הממשק לא שולח
    // אותה מלכתחילה, וזו הערובה שגם באג בצד הלקוח לא יכתוב אותה לדיסק.
    if (isAnonId(id)) return res.status(403).json({ ok: false, error: 'anon' });
    const body = req.body || {};
    const c = sanitizeConv({ ...body, id });
    if (!c) return res.status(400).json({ ok: false, error: 'bad conversation' });
    const cur = readConv(id);
    // ריצת דואט נכתבת על-ידי השרת בלבד — הוא זה שמחזיק אותה. כתיבה בצורת שיחה
    // רגילה עליה הייתה מוחקת את הגרסאות ואת הערות המפקח, ולכן היא נבלעת בשקט
    // ולא מוחזרת כשגיאה: אין כאן כלום לתקן בצד הלקוח.
    if (cur && cur.mode === 'duet' && body.mode !== 'duet') {
      return res.json({ ok: true, rev: Number(cur.rev) || 0, meta: convMeta(cur), skipped: 'duet' });
    }
    const curRev = (cur && Number(cur.rev)) || 0;
    if (body.baseRev !== undefined && Number(body.baseRev) !== curRev) {
      return res.status(409).json({ ok: false, error: 'stale', rev: curRev, conversation: cur });
    }
    /* כתיבה חלקית. בזמן תור חי משתנה רק ההודעה האחרונה, ולכן הלקוח שולח אותה
       בלבד עם ‎fromIndex‎ — כמה הודעות מההתחלה להשאיר כמו שהן. מה שמתיר את זה
       הוא בדיוק ‎baseRev‎ שנבדק שורה למעלה: גרסה זהה פירושה שהקידומת שבדיסק
       היא בדיוק זו שהלקוח מחזיק, ואין מה לשלוח אותה שוב.
       קובץ קצר מהצפוי אינו התנגשות בין מכשירים אלא חוסר התאמה בין השניים,
       ולכן הוא מבקש שמירה מלאה במקום לשלוח את הלקוח לקרוא מחדש. */
    const from = Number(body.fromIndex) || 0;
    if (from > 0) {
      const prefix = (cur && Array.isArray(cur.messages)) ? cur.messages : [];
      if (!Number.isInteger(from) || from > prefix.length) {
        dbg('store.gap', { convId: id, from, have: prefix.length, rev: curRev });
        return res.status(409).json({ ok: false, error: 'gap', needFull: true, rev: curRev });
      }
      c.messages = prefix.slice(0, from).concat(c.messages);
    }
    c.rev = curRev + 1;
    writeConv(c);
    broadcastAll({ kind: 'conv_meta', meta: convMeta(c) });
    res.json({ ok: true, rev: c.rev, meta: convMeta(c) });
  } catch (e) {
    console.error('[store] כתיבת שיחה נכשלה:', e.message);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.delete('/api/conversations/:id', (req, res) => {
  const id = req.params.id;
  if (!VALID_ID.test(id)) return res.status(400).json({ ok: false });
  // אנונימית: אין קובץ למחוק, יש רק תהליך וזיכרון להשמיד.
  if (isAnonId(id)) { destroyAnon(sessions.get(id)); return res.json({ ok: true, anon: true }); }
  try { fs.unlinkSync(convPath(id)); } catch {}
  duet.dispose(id);
  const s = sessions.get(id);
  if (s) { killChild(s); sessions.delete(id); }
  broadcastAll({ kind: 'conv_deleted', id });
  res.json({ ok: true });
});

app.put('/api/settings', storeJson, (req, res) => {
  try {
    const b = req.body || {};
    writeSettings({
      settings: b.settings && typeof b.settings === 'object' ? b.settings : {},
      history: Array.isArray(b.history) ? b.history.filter((x) => typeof x === 'string').slice(0, 200) : [],
      activeId: isAnonId(b.activeId) ? null : (b.activeId || null),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// שמירה אחרונה בעת סגירת החלון — נשלח ב-sendBeacon, לכן POST יחיד לכל המידע.
app.post('/api/flush', storeJson, (req, res) => {
  try {
    const b = req.body || {};
    for (const raw of (Array.isArray(b.conversations) ? b.conversations : [])) {
      const c = sanitizeConv(raw);
      if (!c) continue;
      if (isAnonId(c.id)) continue;   // סגירת חלון לא מדליפה צ'אט אנונימי לדיסק
      // ה-beacon נשלח כשהחלון נסגר, ויכול להגיע אחרי שמכשיר אחר כבר התקדם.
      // כתיבה עיוורת כאן הייתה מחזירה את השיחה אחורה — לכן מדלגים על גרסה ישנה.
      const cur = readConv(c.id);
      const curRev = (cur && Number(cur.rev)) || 0;
      if (raw.baseRev !== undefined && Number(raw.baseRev) !== curRev) continue;
      c.rev = curRev + 1;
      writeConv(c);
      broadcastAll({ kind: 'conv_meta', meta: convMeta(c) });
    }
    if (b.settings || b.history || b.activeId !== undefined) {
      writeSettings({
        settings: b.settings || {},
        history: Array.isArray(b.history) ? b.history.slice(0, 200) : [],
        activeId: isAnonId(b.activeId) ? null : (b.activeId || null),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false }); }
});

// הגירה חד-פעמית מה-localStorage הישן — לא דורסת שיחה שכבר קיימת בדיסק.
app.post('/api/import', storeJson, (req, res) => {
  try {
    const convs = Array.isArray((req.body || {}).convs) ? req.body.convs : [];
    const existing = new Set(listConvIds());
    let imported = 0;
    for (const raw of convs) {
      const c = sanitizeConv(raw);
      if (!c || existing.has(c.id) || isAnonId(c.id)) continue;
      writeConv(c); imported++;
    }
    console.log(`[store] הגירה מ-localStorage: ${imported} שיחות נוספו`);
    res.json({ ok: true, imported });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// חיפוש חופשי בכל השיחות שבדיסק (כולל כאלה שלא נטענו לזיכרון הדפדפן)
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = [];
  for (const id of listConvIds()) {
    const c = readConv(id);
    if (!c) continue;
    let hits = 0, snippet = '';
    const scan = (text) => {
      if (!text) return;
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) return;
      hits++;
      if (!snippet) snippet = text.slice(Math.max(0, i - 40), i + 100).replace(/\s+/g, ' ').trim();
    };
    scan(c.title);
    for (const m of (c.messages || [])) {
      if (m.role === 'user') scan(m.text);
      else for (const b of (m.blocks || [])) if (b.type === 'text' || b.type === 'thinking') scan(b.text);
      if (hits > 8) break;
    }
    if (hits) results.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, hits, snippet });
  }
  results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json({ results: results.slice(0, 50) });
});

// ---------- שרתי MCP ----------
let mcpCache = { t: 0, data: null };
let mcpInflight = null;
app.get('/api/mcp', (req, res) => {
  const now = Date.now();
  if (mcpCache.data && now - mcpCache.t < 30000) return res.json(mcpCache.data);
  if (!mcpInflight) {
    mcpInflight = new Promise((resolve) => {
      execFile('claude', ['mcp', 'list'], { timeout: 15000 }, async (err, stdout) => {
        const servers = [];
        for (const line of (stdout || '').split('\n')) {
          const m = line.match(/^([^:]+):\s*(.*?)\s*-\s*(✔|✗|.*?(?:Connected|Failed|Disconnected|error).*)$/i);
          if (m) servers.push({ name: m[1].trim(), url: m[2].trim(), connected: /✔|connected/i.test(m[3]) });
        }
        // שרתי ה-MCP של Cursor הם רשימה נפרדת לגמרי (‎.cursor/mcp.json‎). הם
        // מוצגים באותו מסך ומסומנים בשם הסוכן, כדי שיהיה ברור למי כל שרת זמין.
        let cur = [];
        try { cur = await cursor.mcpList(); } catch {}
        for (const c of cur) servers.push({ name: c.name, url: c.detail || '', connected: c.status === 'connected', agent: 'cursor' });
        const data = { servers, raw: (stdout || '').trim() };
        mcpCache = { t: Date.now(), data };
        mcpInflight = null;
        resolve(data);
      });
    });
  }
  mcpInflight.then((data) => res.json(data)).catch(() => res.json({ servers: [], raw: '' }));
});

// ---------- פקודות סלאש (מובנות + מותאמות אישית) ----------
const BUILTIN_COMMANDS = [
  { name: '/clear', desc: 'שיחה חדשה (מנקה הקשר)', client: true },
  { name: '/compact', desc: 'דחיסת ההקשר לסיכום קצר' },
  { name: '/init', desc: 'יצירת קובץ CLAUDE.md לפרויקט' },
  { name: '/review', desc: 'סקירת קוד של השינויים' },
  { name: '/security-review', desc: 'סקירת אבטחה של השינויים' },
  { name: '/pr-comments', desc: 'קריאת תגובות על ה-PR' },
  { name: '/rc', desc: 'Remote Control — שליטה במחשב מ-claude.ai/code ומהנייד', client: true },
];
function scanCommands(dir, scope, out, visited = new Set(), depth = 0) {
  if (depth > 8) return;
  let real;
  try { real = fs.realpathSync(dir); } catch { return; }
  if (visited.has(real)) return;
  visited.add(real);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) scanCommands(path.join(dir, e.name), scope, out, visited, depth + 1);
    else if (e.name.endsWith('.md')) {
      let desc = '';
      try {
        const txt = fs.readFileSync(path.join(dir, e.name), 'utf8');
        const fm = txt.match(/^---[\s\S]*?description:\s*(.+)$[\s\S]*?---/m);
        if (fm) desc = fm[1].trim(); else desc = (txt.split('\n').find((l) => l.trim() && !l.startsWith('---')) || '').slice(0, 80);
      } catch {}
      out.push({ name: '/' + e.name.replace(/\.md$/, ''), desc, scope, custom: true });
    }
  }
}
app.get('/api/commands', (req, res) => {
  const root = resolveDirGlobal(req.query.cwd);
  // תפריט ה-'/' הוא של הסוכן שרץ. ל-Cursor אין את הפקודות המובנות של Claude
  // (‎/compact‎, ‎/rc‎…) ואין לו ‎.claude/commands‎ — מה שממלא שם את התפקיד הוא
  // skills. הצגת התפריט הלא-נכון הייתה מציעה פקודות שפשוט לא יקרו.
  if (req.query.agent === 'cursor') {
    try { return res.json({ commands: cursor.listCommands(root), agent: 'cursor' }); }
    catch { return res.json({ commands: [], agent: 'cursor' }); }
  }
  const out = [];
  scanCommands(path.join(root, '.claude', 'commands'), 'פרויקט', out);
  scanCommands(path.join(os.homedir(), '.claude', 'commands'), 'אישי', out);
  res.json({ commands: [...BUILTIN_COMMANDS, ...out] });
});

// ---------- רשימת ההיתר של Cursor ----------
// "אשר תמיד" לכלי שנדחה. אין ל-Cursor ערוץ אישור חי במצב --print, ולכן
// האישור הוא חוק קבוע בקובץ ההגדרות שלו — ומשם הוא תקף גם לתורות הבאים.
app.post('/api/cursor/allow', express.json({ limit: '4kb' }), (req, res) => {
  const r = cursor.allowRule((req.body || {}).rule);
  dbg('cursor.allow', { rule: (req.body || {}).rule, ok: r.ok, already: !!r.already, error: r.error || null });
  res.json(r);
});

/* ==========================================================================
   Remote Control של Claude Code (‎/rc‎)
   --------------------------------------------------------------------------
   ‎/rc‎ אינה פקודת סלאש רגילה של ה-CLI אלא קיצור לתת-פקודה שרצה כתהליך נפרד
   (`claude remote-control`): שרת מתמיד שמחבר את המחשב הזה ל-claude.ai/code
   ולאפליקציה בנייד. לכן אי אפשר לשלוח "/rc" לתוך זרם ה-stream-json של השיחה —
   שם היא הייתה נשלחת כטקסט רגיל למודל. הממשק מפעיל את התהליך כאן, קורא את
   הפלט שלו ומציג מצב + קישור + QR.
   התהליך שייך לממשק כולו ולא לשיחה מסוימת, והוא נסגר יחד עם השרת (למטה,
   באותו מטפל סיגנלים של המאזין ברשת המקומית).
   שימו לב שזו יציאה החוצה: מרגע שהוא מחובר, סשנים שנפתחים מ-claude.ai רצים
   על המחשב הזה. לכן הוא לא עולה מעצמו — רק בלחיצה מפורשת.
   ========================================================================== */
/* -- אמון בתיקיית העבודה --------------------------------------------------
   ה-CLI מסרב לרוץ בתיקייה שלא אושרה בדיאלוג האמון שלו ("Workspace not
   trusted"), והאישור נשמר ב-‎~/.claude.json‎ תחת projects[dir]. בטרמינל מאשרים
   אותו בדיאלוג שעולה בהרצה הראשונה; ל-remote-control אין מסך כזה — הוא פשוט
   נופל. לכן הפאנל בודק מראש, מסביר, ומסמן את הדגל בעצמו — רק בלחיצה מפורשת
   ורק על התיקייה שמוצגת למשתמש.
   ------------------------------------------------------------------------ */
const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');

function readClaudeConfig() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8')); } catch { return null; }
}

function isTrustedDir(dir) {
  const cfg = readClaudeConfig();
  const p = cfg && cfg.projects && cfg.projects[dir];
  return !!(p && p.hasTrustDialogAccepted);
}

/** מסמן תיקייה כמהימנה. הקריאה-שינוי-כתיבה נעשית ברגע האישור ולא לפני כן:
 *  כל סשן claude שרץ במקביל כותב את אותו קובץ ביציאה, וככל שהחלון קצר יותר כך
 *  קטן הסיכוי שהוא ידרוס אותנו. הכתיבה אטומית (tmp + rename) כמו בשאר הקבצים. */
function trustDir(dir) {
  const cfg = readClaudeConfig();
  if (!cfg) throw new Error('לא נמצא ‎~/.claude.json‎ — הריצו ‎claude‎ פעם אחת בטרמינל ונסו שוב');
  cfg.projects = cfg.projects || {};
  cfg.projects[dir] = { ...(cfg.projects[dir] || {}), hasTrustDialogAccepted: true };
  const tmp = CLAUDE_CONFIG_FILE + '.rtl-tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CLAUDE_CONFIG_FILE);
  dbg('rc.trust', { dir });
}

const RC_URL_RE = /https:\/\/claude\.ai\/code\?environment=[\w-]+/;
const RC_LOG_MAX = 40;
const RC_MAX = 6;                        // כמה מופעים מותר להריץ במקביל
const RC_SPAWN = ['same-dir', 'worktree', 'session'];
// הרשימה של תת-הפקודה עצמה (claude remote-control --help), ולא של claude
const RC_PERM = ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'];
// הפלט מצויר מחדש שוב ושוב עם רצפי ANSI (כולל קישורי OSC 8) — מנקים לפני הפענוח
const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

/* -- קריאת המסך של remote-control ----------------------------------------
   ה-CLI לא כותב שורות אלא מצייר מסך: לפני כל ציור הוא עולה n שורות ומוחק
   (ESC[nA ואז ESC[J), ואז כותב הכל מחדש. לכן כל "פריים" הוא תמונת מצב שלמה —
   וזה מה שמאפשר להציג רשימת סשנים שמתעדכנת, כי סשן שנסגר פשוט נעלם מהפריים
   הבא. שורת סשן היא קישור OSC 8 (כותרת → כתובת הסשן ב-claude.ai) ואחריה
   תיאור מה הוא עושה כרגע, ולכן מפענחים את הקישורים לפני ניקוי ה-ANSI.
   ------------------------------------------------------------------------ */
const OSC8_RE = /\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)/g;
const RC_FRAME_SPLIT = /\x1b\[\d*A\x1b\[J/;
// מציין היכן היה קישור בשורה אחרי שהוצא ממנה — צורה שלא מופיעה בפלט עצמו
const RC_LINK_MARK = /\u0000(\d+)\u0000/;

function rcParseFrame(inst, frame, complete) {
  const links = [];
  const flat = frame.replace(OSC8_RE, (_, url, text) => {
    links.push({ url, title: stripAnsi(text).trim() });
    return '\u0000' + (links.length - 1) + '\u0000';
  });
  const clean = stripAnsi(flat);
  const rows = [];
  const lines = clean.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(RC_LINK_MARK);
    if (m) {
      const link = links[Number(m[1])] || {};
      // הקישור לסביבה עצמה מופיע גם הוא ככזה — שורת סשן היא כל השאר
      if (!RC_URL_RE.test(link.url || '')) {
        rows.push({
          title: link.title || 'סשן',
          url: link.url || '',
          activity: line.replace(RC_LINK_MARK, '').trim(),
        });
      }
      continue;
    }
    // בפריים שעדיין נכתב השורה האחרונה חתוכה (קישור חצוי נראה כטקסט) — היא
    // תיכנס ליומן בפעם הבאה, כשתהיה שלמה. ביציאה נשלח \n כדי לשחרר אותה.
    if (!complete && i === lines.length - 1) continue;
    // הציור החוזר מייצר את אותן שורות שוב ושוב — שומרים ביומן רק שינויים
    if (inst.log[inst.log.length - 1] !== line) inst.log.push(line);
    if (inst.log.length > RC_LOG_MAX) inst.log.splice(0, inst.log.length - RC_LOG_MAX);
  }
  const u = clean.match(RC_URL_RE);
  if (u) inst.url = u[0];
  const cap = clean.match(/Capacity:\s*(\d+)\s*\/\s*(\d+)/i);
  if (cap) inst.capacity = { used: Number(cap[1]), max: Number(cap[2]) };
  if (/isolated worktree/i.test(clean)) inst.spawn = 'worktree';
  else if (/Single session/i.test(clean)) inst.spawn = 'session';
  else if (/current directory/i.test(clean)) inst.spawn = 'same-dir';
  if (/\bReconnecting\b/.test(clean)) inst.state = 'reconnecting';
  else if (/\bConnected\b/.test(clean)) inst.state = 'on';
  else if (/\bConnecting\b/.test(clean) && inst.state !== 'on') inst.state = 'starting';
  // אם התיקייה איבדה את האמון בין הבדיקה להרצה (סשן אחר שדרס את הקונפיג)
  if (/Workspace not trusted/i.test(clean)) inst.needsTrust = true;
  // רשימת הסשנים נלקחת רק מפריים שלם: פריים שעדיין נכתב היה מרוקן אותה לרגע
  if (complete) { inst.sessions = rows; inst.sawFrame = true; }
  else if (!inst.sawFrame && rows.length) inst.sessions = rows;
}

function rcAbsorb(inst, chunk) {
  inst.buf += chunk.toString();
  if (inst.buf.length > 64 * 1024) inst.buf = inst.buf.slice(-16 * 1024);
  const parts = inst.buf.split(RC_FRAME_SPLIT);
  inst.buf = parts.pop();
  for (const f of parts) if (f.trim()) rcParseFrame(inst, f, true);
  // גם החלק שעדיין נכתב, אחרת המצב מפגר בפריים שלם אחורה
  if (inst.buf.trim()) rcParseFrame(inst, inst.buf, false);
}

/* מפת המופעים: תיקייה אחת → תהליך אחד. אפשר להריץ כמה במקביל, וכל אחד הוא
   "סביבה" נפרדת ברשימה שב-claude.ai. מופע שנפל נשאר במפה עם הסיבה, כדי
   שהפאנל יוכל להראות למה — הוא יורד ממנה רק בלחיצה. */
const rcs = new Map();

const rcPublic = (inst) => ({
  cwd: inst.cwd, name: inst.name, state: inst.state, url: inst.url,
  capacity: inst.capacity, spawn: inst.spawn, permissionMode: inst.permissionMode,
  error: inst.error, startedAt: inst.startedAt, pid: inst.child ? inst.child.pid : 0,
  sessions: inst.sessions, log: inst.log.slice(-12), needsTrust: !!inst.needsTrust,
});

function rcStart(opts) {
  opts = opts || {};
  const workdir = resolveDirGlobal(opts.cwd);
  const live = rcs.get(workdir);
  if (live && live.child) return rcPublic(live);
  if ([...rcs.values()].filter((x) => x.child).length >= RC_MAX) {
    throw new Error(`אפשר להריץ עד ${RC_MAX} מופעים במקביל — כבו אחד קודם`);
  }
  // בלי הבדיקה הזו התהליך עולה, נופל מיד, והמשתמש רואה רק "נכשל" עם שגיאה באנגלית
  if (!isTrustedDir(workdir)) {
    const err = new Error('התיקייה עדיין לא אושרה כתיקייה מהימנה ב-Claude Code');
    err.needsTrust = true; err.cwd = workdir;
    throw err;
  }
  const label = (opts.name || '').toString().trim().slice(0, 60);
  const spawnMode = RC_SPAWN.includes(opts.spawn) ? opts.spawn : '';
  const perm = RC_PERM.includes(opts.permissionMode) ? opts.permissionMode : '';
  const cap = Math.round(Number(opts.capacity));
  const args = ['remote-control'];
  if (label) args.push('--name', label);
  if (spawnMode) args.push('--spawn', spawnMode);
  if (cap >= 1 && cap <= 32) args.push('--capacity', String(cap));
  if (perm) args.push('--permission-mode', perm);
  // -c מתחבר מחדש לסשן שהתיקייה הזו רשמה בשעות האחרונות במקום לפתוח חדש
  if (opts.continue) args.push('--continue');
  if (opts.createSessionInDir === false) args.push('--no-create-session-in-dir');
  let child;
  try {
    child = spawn('claude', args, { cwd: workdir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error('לא ניתן להפעיל את claude remote-control: ' + err.message);
  }
  const inst = {
    child, cwd: workdir, name: label, state: 'starting', url: null, capacity: null,
    spawn: spawnMode || 'same-dir', permissionMode: perm, error: '', startedAt: Date.now(),
    log: [], sessions: [], buf: '', sawFrame: false, needsTrust: false,
  };
  rcs.set(workdir, inst);
  child.stdout.on('data', (c) => rcAbsorb(inst, c));
  child.stderr.on('data', (c) => rcAbsorb(inst, c));
  child.on('error', (err) => {
    if (inst.child !== child) return;
    inst.child = null; inst.state = 'error'; inst.error = err.message; inst.sessions = [];
    dbg('rc.error', { cwd: workdir, error: err.message });
  });
  child.on('exit', (code, signal) => {
    // כיבוי יזום מוציא את המופע מהמפה, ולכן כאן נשארות רק נפילות
    if (inst.child !== child) return;
    rcAbsorb(inst, '\n');            // שורת שגיאה אחרונה בלי ירידת שורה — לתוך היומן
    inst.child = null; inst.state = 'error'; inst.sessions = [];
    // נפילה אמיתית מסבירה את עצמה בשורות האחרונות; הריגה מבחוץ לא, ושם
    // שורות המסך היו נראות כמו "שגיאה" שלא קרתה
    inst.error = signal
      ? `התהליך נסגר מבחוץ (${signal})`
      : (inst.log.slice(-3).join(' · ') || `התהליך יצא (קוד ${code})`);
    dbg('rc.exit', { cwd: workdir, code, signal });
  });
  dbg('rc.start', { cwd: workdir, name: label, args: args.slice(1) });
  return rcPublic(inst);
}

function rcStop(cwd) {
  const inst = rcs.get(cwd);
  if (!inst) return false;
  rcs.delete(cwd);                 // מכאן המטפלים של התהליך הישן כבר לא נוגעים במצב
  const child = inst.child;
  inst.child = null;
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    // אם הוא לא נסגר יפה הוא ימשיך להופיע כמחובר ב-claude.ai — ולכן גם יד קשה
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 4000);
    child.once('exit', () => clearTimeout(hard));
    dbg('rc.stop', { cwd });
  }
  return true;
}

const rcStopAll = () => { for (const cwd of [...rcs.keys()]) rcStop(cwd); };

/* -- אילו סשנים של claude חיים עכשיו על המחשב ----------------------------
   ה-CLI רושם כל סשן חי ב-~/.claude/sessions/<pid>.json (pid, sessionId, cwd,
   שם, kind, entrypoint). זה המקור היחיד שיודע *באיזו תיקייה* יושב כל סשן —
   מסך ה-remote-control מראה כותרות בלבד, ובמצב worktree כל סשן יושב בתיקייה
   אחרת משלו. קובץ נשאר מאחור כשתהליך נופל, ולכן כל שורה מאומתת מול /proc:
   שהתהליך קיים, ושזמן העלייה שלו זהה — אחרת PID ממוחזר היה מוצג כסשן חי.
   ------------------------------------------------------------------------ */
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

function procStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = s.lastIndexOf(')');       // שם התהליך עלול להכיל רווחים וסוגריים
    const f = s.slice(close + 2).split(' ');
    return { ppid: Number(f[1]), start: f[19] };   // starttime — השדה ה-22 בקובץ
  } catch { return null; }
}

/** מי מבין roots הוא אב-קדמון של pid (ומיהו) — 0 אם אף אחד */
function ancestorIn(pid, roots) {
  let cur = pid;
  for (let i = 0; i < 12 && cur > 1; i++) {
    const st = procStat(cur);
    if (!st) return 0;
    if (roots.has(st.ppid)) return st.ppid;
    cur = st.ppid;
  }
  return 0;
}

function liveClaudeSessions() {
  let files = [];
  try { files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const rcRoots = new Map();                // pid של מופע → התיקייה שהוא רץ בה
  for (const inst of rcs.values()) if (inst.child) rcRoots.set(inst.child.pid, inst.cwd);
  const rootPids = new Set(rcRoots.keys());
  const ownPids = new Set();                // הסשנים של הממשק הזה עצמו
  for (const s of sessions.values()) if (s.child) ownPids.add(s.child.pid);
  const out = [];
  for (const f of files) {
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, f), 'utf8')); } catch { continue; }
    const pid = Number(e.pid);
    if (!pid) continue;
    const st = procStat(pid);
    if (!st) continue;                                               // נפל והשאיר קובץ
    if (e.procStart && String(e.procStart) !== st.start) continue;    // PID ממוחזר
    const root = rootPids.has(pid) ? pid : ancestorIn(pid, rootPids);
    const source = ownPids.has(pid) ? 'ui'
      : (root || /remote[-_]control/i.test(e.entrypoint || '')) ? 'rc'
        : 'terminal';
    out.push({
      pid, sessionId: e.sessionId || '', cwd: e.cwd || '', name: e.name || '',
      kind: e.kind || '', entrypoint: e.entrypoint || '', startedAt: e.startedAt || 0,
      agent: e.agent || '', spare: !!e.spare, source,
      rcCwd: root ? (rcRoots.get(root) || '') : '',
    });
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

app.get('/api/rc/status', (req, res) => res.json({
  instances: [...rcs.values()].map(rcPublic),
  sessions: liveClaudeSessions(),
  max: RC_MAX, spawnModes: RC_SPAWN, permissionModes: RC_PERM,
}));

app.post('/api/rc/start', express.json({ limit: '4kb' }), (req, res) => {
  try { res.json(rcStart(req.body || {})); }
  catch (e) {
    if (e && e.needsTrust) return res.status(409).json({ error: e.message, needsTrust: true, cwd: e.cwd });
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// האם התיקייה מאושרת — כדי שהפאנל יזהיר לפני הלחיצה ולא רק אחריה
app.get('/api/rc/trust', (req, res) => {
  const cwd = resolveDirGlobal(req.query.cwd);
  res.json({ cwd, trusted: isTrustedDir(cwd) });
});

// אישור התיקייה — המקבילה לדיאלוג האמון של ה-CLI, ולכן רק בלחיצה מפורשת
app.post('/api/rc/trust', express.json({ limit: '4kb' }), (req, res) => {
  const cwd = resolveDirGlobal((req.body || {}).cwd);
  try { trustDir(cwd); res.json({ cwd, trusted: true }); }
  catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// בלי cwd — כיבוי הכל, כמו כפתור "נתק הכל" בפאנל
app.post('/api/rc/stop', express.json({ limit: '4kb' }), (req, res) => {
  const body = req.body || {};
  if (body.cwd == null) { rcStopAll(); return res.json({ stopped: 'all' }); }
  const cwd = resolveDirGlobal(body.cwd);
  res.json({ stopped: rcStop(cwd) ? cwd : null });
});

/* סגירת סשן בודד. הרשימה היא מקור האמת: מותר לסגור רק PID שמופיע בה כחי
   ברגע זה, כך שהבקשה לא יכולה להפוך לכלי להריגת תהליך שרירותי במחשב. */
app.post('/api/rc/session/stop', express.json({ limit: '2kb' }), (req, res) => {
  const pid = Number((req.body || {}).pid);
  const hit = liveClaudeSessions().find((s) => s.pid === pid);
  if (!hit) return res.status(404).json({ error: 'הסשן כבר לא רץ' });
  try { process.kill(pid, 'SIGTERM'); }
  catch (e) { return res.status(500).json({ error: 'לא ניתן לסגור: ' + String((e && e.message) || e) }); }
  dbg('rc.session.stop', { pid, cwd: hit.cwd, source: hit.source });
  res.json({ ok: true, pid });
});

// QR לקישור — נוצר בשרת כמו קוד הקישור של המכשירים, בלי לטעון כלום מהאינטרנט
app.get('/api/rc/qr', async (req, res) => {
  const inst = rcs.get(resolveDirGlobal(req.query.cwd));
  const url = inst && inst.url;
  if (!url) return res.status(404).end();
  try {
    const svg = await qrcode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch { res.status(500).end(); }
});

// HTTPS עם self-signed cert. מקבל מרחוק מוגבל ל-LAN בלבד, ולא צריך להסתעף
// ל-localhost כדי להשתמש בתשתית מאובטחת כמו Notification API.
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
let server;
try {
  const options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  server = https.createServer(options, app);
  console.log('🔒 HTTPS מאופשר (self-signed cert)');
} catch (e) {
  // הדפדפן מאמת SAN, לא CN: תעודה בלי subjectAltName נדחית גם אחרי "המשך בכל זאת",
  // ולכן הפקודה כאן מזריקה את כתובת ה-LAN הנוכחית לתוך התעודה.
  console.log('⚠️ לא הצליח לטעון HTTPS:', e.message, `\n→ הרץ: mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 397 -out certs/cert.pem -keyout certs/key.pem -subj "/CN=rtl-claude" -addext "subjectAltName=IP:${lanAddress() || '127.0.0.1'},IP:127.0.0.1,DNS:localhost,DNS:${os.hostname()}" -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature,keyEncipherment" -addext "extendedKeyUsage=serverAuth"`);
  server = http.createServer(app);
}
const wss = new WebSocketServer({ server });
wss.on('connection', handleConnection);

/* ==========================================================================
   חיבור קבוע ממכשיר מקושר (LAN)
   --------------------------------------------------------------------------
   קודם לכן הייתה כאן "גישה מרחוק": מאזין על 0.0.0.0 עם טוקן חד-פעמי שמת
   בכיבוי או בפקיעת תוקף. זה עבד רק ברשת הבתית ודרש להדליק אותו מחדש כל פעם.
   עכשיו המאזין הנוסף עולה על כתובת ה-LAN של המחשב, וזהו: מי שנמצא ברשת
   המקומית — ישירות או דרך VPN שמנתב אליה — מגיע לממשק. השרת לא מנסה לזהות
   שום VPN ולא תלוי באף כלי חיצוני.
   האזנה על כתובת ה-LAN בלבד ולא על 0.0.0.0 היא מכוונת: docker0 והגשרים
   הווירטואליים נשארים בחוץ, כך שקונטיינר שרץ על המחשב לא רואה את הממשק.
   האימות הוא שכבה משלנו: מכשיר מקושר פעם אחת מקבל טוקן קבוע בעוגייה, מופיע
   ברשימה בממשק, וניתן לנתק אותו משם. את הקישור עצמו יכול לפתוח המחשב או כל
   מכשיר שכבר מקושר, עם קוד קצר לסריקה או להקלדה שתקף לעשר דקות.
   `RTL_HOST` כופה כתובת מפורשת, `REMOTE_PORT` כופה פורט.
   ========================================================================== */
const REMOTE_PORT = Number(process.env.REMOTE_PORT) || (Number(PORT) + 1);
const DEVICE_COOKIE = 'rtl_device';
const DEVICES_FILE = path.join(STORE_DIR, 'devices.json');
const PAIR_TTL_MS = 10 * 60 * 1000;      // תוקף קוד הקישור עצמו
const PAIR_MAX_TRIES = 10;               // ניחושים כושלים עד שהקוד נשרף
const DEVICE_TTL_MS = 365 * 24 * 3600 * 1000;

/* הקוד נועד גם להיאמר בקול או להיות מוקלד ביד, ולא רק להיסרק מ-QR: שמונה
   תווים מא״ב בן 30 (בלי 0/O/1/I/L/U שמתבלבלים בקריאה) ≈ 39 ביט. קצר מספיק
   להכתבה בטלפון, ורחוק מלהיות בר-ניחוש — ובלאו הכי תקרת הניסיונות שורפת
   את הקוד הרבה לפני שניחוש אקראי מתקרב. */
const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_LEN = 8;

let remoteSrv = null;   // המאזין על כתובת ה-LAN
let pairCode = null;    // { code, expiresAt, tries, by } — חי בזיכרון בלבד

function newPairCode() {
  let out = '';
  // דגימה עם דחייה: bytes שמעל הכפולה השלמה האחרונה של גודל הא״ב היו מטים
  // את ההגרלה לטובת תחילתו.
  const limit = 256 - (256 % PAIR_ALPHABET.length);
  while (out.length < PAIR_LEN) {
    for (const b of crypto.randomBytes(PAIR_LEN * 2)) {
      if (out.length === PAIR_LEN) break;
      if (b >= limit) continue;
      out += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
    }
  }
  return out;
}
/** מה שהוקלד → הצורה הקנונית: בלי מקפים ורווחים, אותיות גדולות. */
const normPair = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Z]/g, '');
/** הצורה שמוצגת לעין ולהכתבה: XXXX-XXXX. */
const prettyPair = (c) => c.slice(0, 4) + '-' + c.slice(4);

/* ממשקים וירטואליים שאסור להאזין עליהם: הם לא הדרך שבה מכשיר ברשת מגיע,
   ו-docker0 בפרט היה חושף את הממשק לכל קונטיינר שרץ על המחשב. */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|zt|wg)/;

const isPrivate = (a) =>
  a[0] === 192 && a[1] === 168 ||
  a[0] === 10 ||
  a[0] === 172 && a[1] >= 16 && a[1] <= 31;

/**
 * כתובת ה-LAN שעליה עולה המאזין: RTL_HOST אם הוגדר, אחרת כתובת ה-IPv4
 * הפרטית הראשונה על ממשק פיזי. null אם המחשב לא מחובר לשום רשת.
 */
function lanAddress() {
  if (process.env.RTL_HOST) return process.env.RTL_HOST;
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(iface)) continue;
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (isPrivate(ni.address.split('.').map(Number))) return ni.address;
    }
  }
  return null;
}

const isLocalReq = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');

/* מי רשאי לקשר ולנתק מכשירים: המחשב עצמו, או מכשיר שכבר מקושר. קודם לכן זה
   היה המחשב בלבד, וזה הכריח לקום וללכת אליו כדי לצרף מחשב נוסף. למכשיר
   מקושר יש ממילא שליטה מלאה ב-Claude ובכלים שלו כאן, ולכן ההגבלה לא הוסיפה
   ביטחון אמיתי — היא רק הפכה צירוף מכשיר שני למסע. `req.rtlDevice` נקבע
   בשער של המאזין המרוחק, כך שהוא קיים רק לבקשה של מכשיר מאומת. */
const canPair = (req) => isLocalReq(req) || !!req.rtlDevice;
const pairActor = (req) => (req.rtlDevice ? (req.rtlDevice.name || 'מכשיר מקושר') : 'המחשב');

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/* ---------- אחסון המכשירים ----------
   שומרים רק את ה-hash של הטוקן: הקובץ בדיסק אינו מפתח כניסה בפני עצמו. */
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function readDevices() {
  try {
    const j = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    return Array.isArray(j.devices) ? j.devices : [];
  } catch { return []; }
}
function writeDevices(devices) {
  const tmp = DEVICES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DEVICES_FILE);
}
function findDevice(token) {
  if (!token) return null;
  const h = hashToken(token);
  const now = Date.now();
  for (const d of readDevices()) {
    if (d.hash && d.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(h))) {
      if (d.expiresAt && d.expiresAt < now) return null;
      return d;
    }
  }
  return null;
}
/** נגיעה עצלה: מעדכנים "נראה לאחרונה" לכל היותר פעם בשעה, לא בכל בקשה. */
function touchDevice(id) {
  const devices = readDevices();
  const d = devices.find((x) => x.id === id);
  if (!d) return;
  const now = Date.now();
  if (d.lastSeen && now - d.lastSeen < 3600 * 1000) return;
  d.lastSeen = now;
  try { writeDevices(devices); } catch {}
}

/**
 * ממש קוד קישור: מנפיק טוקן קבוע ורושם את המכשיר, או מחזיר null אם הקוד
 * שגוי או פג. הקוד חד-פעמי, ותקרת ניסיונות שורפת אותו — בלעדיה קוד קצר
 * מספיק כדי להכתיב בטלפון היה גם מספיק קצר כדי לתקוף אותו בלולאה.
 */
function consumePairCode(code, req) {
  const given = normPair(code);
  if (!given || !pairCode) return null;
  if (pairCode.expiresAt <= Date.now()) { pairCode = null; return null; }
  const want = Buffer.from(pairCode.code);
  const got = Buffer.from(given);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    if (++pairCode.tries >= PAIR_MAX_TRIES) pairCode = null;
    return null;
  }
  const by = pairCode.by;
  pairCode = null;   // חד-פעמי
  const token = crypto.randomBytes(32).toString('base64url');
  const devices = readDevices();
  devices.push({
    id: crypto.randomBytes(6).toString('hex'),
    name: deviceLabel(req),
    ua: String((req.headers['user-agent'] || '')).slice(0, 200),
    hash: hashToken(token),
    pairedBy: by || null,
    createdAt: Date.now(), lastSeen: Date.now(),
    expiresAt: Date.now() + DEVICE_TTL_MS,
  });
  writeDevices(devices);   // זורק — הקורא מדווח למשתמש
  return token;
}

const deviceCookie = (token) =>
  `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(DEVICE_TTL_MS / 1000)}; HttpOnly; SameSite=Lax`;

const escHtmlMin = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* מסך הדחייה הוא גם מסך הקישור: מי שקיבל את הקוד בהודעה ולא סרק QR מקליד
   אותו כאן. בלי זה קוד שנשלח לצ׳אט היה חסר מקום להזין אותו בו. */
const deniedHtml = (err) => `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>קישור מכשיר</title><body style="font-family:system-ui;background:#f5f4ef;color:#2b2a27;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center;padding:24px;max-width:420px"><h1 style="font-size:19px">המכשיר הזה אינו מקושר</h1>
<p style="font-size:14px;color:#6b6a65;line-height:1.6">בקש קוד קישור ממי שכבר מחובר — מהמחשב או מכל מכשיר מקושר — והקלד אותו כאן. הקישור נעשה פעם אחת ונשאר.</p>
${err ? `<p style="font-size:13px;color:#a3382f;line-height:1.5;margin:0 0 12px">${escHtmlMin(err)}</p>` : ''}
<form method="POST" action="/__pair" style="display:flex;gap:8px;justify-content:center;margin-top:14px">
<input name="code" autofocus autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
 inputmode="latin" maxlength="12" placeholder="XXXX-XXXX" aria-label="קוד קישור"
 style="font:600 17px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;text-align:center;direction:ltr;padding:11px 12px;width:170px;border:1px solid #d8d5cc;border-radius:10px;background:#fff;color:#2b2a27">
<button type="submit" style="font:600 15px system-ui;padding:11px 18px;border:0;border-radius:10px;background:#2b2a27;color:#f5f4ef;cursor:pointer">קשר</button>
</form></div></body></html>`;

/* ---------- המאזין המרוחק ----------
   עוטף את אותה אפליקציה בשער מכשיר, כדי שלא תהיה כפילות לוגיקה בין מקומי
   למרוחק: מה שרואים בטלפון הוא בדיוק אותו ממשק ואותם נתיבים. */
const remoteApp = express();

// הקלדת הקוד ידנית ממסך הדחייה. לפני השער, כי מי שמקליד עדיין אינו מקושר.
remoteApp.post('/__pair', express.urlencoded({ limit: '4kb', extended: false }), (req, res) => {
  let token;
  try { token = consumePairCode((req.body || {}).code, req); }
  catch (e) { return res.status(500).type('html').send(deniedHtml('שמירת המכשיר נכשלה: ' + e.message)); }
  if (!token) {
    return res.status(401).type('html').send(deniedHtml(pairCode
      ? 'הקוד שגוי. בדוק שהעתקת אותו במלואו ונסה שוב.'
      : 'הקוד שגוי, פג תוקפו או כבר נוצל. בקש קוד חדש.'));
  }
  res.setHeader('Set-Cookie', deviceCookie(token));
  res.redirect(302, '/');
});

remoteApp.use((req, res, next) => {
  // כניסה ראשונה עם קוד הקישור בכתובת → טוקן קבוע, והקוד יורד מהכתובת
  const code = req.query && req.query.pair;
  if (code) {
    let token;
    try { token = consumePairCode(code, req); }
    catch (e) { return res.status(500).send('שמירת המכשיר נכשלה: ' + e.message); }
    if (token) {
      res.setHeader('Set-Cookie', deviceCookie(token));
      return res.redirect(302, '/');
    }
  }
  // קוד שגוי לא מפיל מכשיר שכבר מקושר: קודם נבדקת העוגייה שלו
  const d = findDevice(readCookie(req.headers.cookie, DEVICE_COOKIE));
  if (d) { touchDevice(d.id); req.rtlDevice = d; return next(); }
  res.status(401).type('html').send(deniedHtml(code ? 'הקישור שפתחת אינו תקף יותר. בקש קוד חדש.' : ''));
});
remoteApp.use(app);

function remoteStatus() {
  const host = lanAddress();
  const proto = remoteSrv instanceof https.Server ? 'https' : 'http';
  const base = host ? `${proto}://${host}:${REMOTE_PORT}` : null;
  return {
    listening: !!remoteSrv,
    host, port: REMOTE_PORT, url: base,
    pairUrl: base && pairCode ? `${base}/?pair=${pairCode.code}` : null,
    pairCode: pairCode ? prettyPair(pairCode.code) : null,
    pairBy: pairCode ? pairCode.by : null,
    pairExpiresAt: pairCode ? pairCode.expiresAt : null,
    devices: readDevices().map((d) => ({
      id: d.id, name: d.name, ua: d.ua, pairedBy: d.pairedBy || null,
      createdAt: d.createdAt, lastSeen: d.lastSeen, expiresAt: d.expiresAt,
    })),
  };
}

/** מעלה את המאזין על כתובת ה-LAN. נקרא באתחול, ושוב כשהיא מופיעה. */
function startRemote() {
  return new Promise((resolve, reject) => {
    if (remoteSrv) return resolve(remoteStatus());
    const host = lanAddress();
    if (!host) return reject(new Error('לא נמצאה כתובת LAN להאזנה במחשב הזה'));
    // משתמש באותו cert כמו main server כדי להימנע מעותקים וסיבול ניהול
    let srv;
    try {
      const options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
      srv = https.createServer(options, remoteApp);
    } catch (e) {
      srv = http.createServer(remoteApp);
    }
    const rwss = new WebSocketServer({ noServer: true });
    rwss.on('connection', handleConnection);
    srv.on('upgrade', (req, socket, head) => {
      // ה-WebSocket עובר את אותו שער בדיוק — אחרת הממשק היה חסום אבל הזרם פתוח
      if (!findDevice(readCookie(req.headers.cookie, DEVICE_COOKIE))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }
      rwss.handleUpgrade(req, socket, head, (ws) => rwss.emit('connection', ws, req));
    });
    // חצי-פתוח ברמת TCP: בלי keepalive הקרנל מחזיק את החיבור המת שעות
    srv.on('connection', (sock) => { try { sock.setKeepAlive(true, 60000); } catch {} });
    srv.on('error', (e) => { remoteSrv = null; reject(e); });
    srv.listen(REMOTE_PORT, host, () => {
      remoteSrv = srv;
      const proto = srv instanceof https.Server ? 'https' : 'http';
      console.log(`  \x1b[32mזמין מכל מכשיר מקושר ברשת: ${proto}://${host}:${REMOTE_PORT}\x1b[0m\n`);
      resolve(remoteStatus());
    });
  });
}
function stopRemote() {
  if (!remoteSrv) return;
  try { remoteSrv.close(); } catch {}
  remoteSrv = null;
}

app.get('/api/remote/status', (req, res) => {
  const s = remoteStatus();
  // הקוד מוצג רק למי שרשאי לקשר — במחשב, או במכשיר מקושר
  if (!canPair(req)) { s.pairUrl = null; s.pairCode = null; s.pairBy = null; s.pairExpiresAt = null; }
  res.json(s);
});

// קוד QR לקישור — נוצר בשרת ומוגש כ-SVG, בלי לטעון שום דבר מהאינטרנט
app.get('/api/remote/qr', async (req, res) => {
  if (!canPair(req)) return res.status(403).end();
  const s = remoteStatus();
  if (!s.pairUrl) return res.status(404).end();
  try {
    const svg = await qrcode.toString(s.pairUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) { res.status(500).end(); }
});

// יצירת קוד קישור למכשיר חדש — מהמחשב או ממכשיר מקושר, ותקף לעשר דקות
app.post('/api/remote/pair', express.json({ limit: '4kb' }), async (req, res) => {
  if (!canPair(req)) return res.status(403).json({ error: 'אפשר לקשר מכשיר רק מהמחשב או ממכשיר שכבר מקושר' });
  if (!lanAddress()) {
    return res.status(503).json({ error: 'למחשב הזה אין כתובת LAN להאזין עליה. חבר אותו לרשת ונסה שוב.' });
  }
  try {
    if (!remoteSrv) await startRemote();
  } catch (e) {
    return res.status(500).json({ error: e.code === 'EADDRINUSE' ? `פורט ${REMOTE_PORT} תפוס` : (e.message || 'שגיאה בפתיחת המאזין') });
  }
  pairCode = { code: newPairCode(), expiresAt: Date.now() + PAIR_TTL_MS, tries: 0, by: pairActor(req) };
  res.json(remoteStatus());
});

app.post('/api/remote/unpair', express.json({ limit: '4kb' }), (req, res) => {
  if (!canPair(req)) return res.status(403).json({ error: 'אפשר לנתק מכשיר רק מהמחשב או ממכשיר מקושר' });
  const id = (req.body || {}).id;
  const devices = readDevices().filter((d) => d.id !== id);
  try { writeDevices(devices); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json(remoteStatus());
});

// ביטול קוד קישור שנוצר ולא נוצל
app.post('/api/remote/cancel-pair', (req, res) => {
  if (!canPair(req)) return res.status(403).json({ error: 'לא מורשה' });
  pairCode = null;
  res.json(remoteStatus());
});

// אין טעם לחכות ללחיצה: המכשירים המקושרים אמורים למצוא את המחשב ברגע שהוא
// עולה — בדיוק כמו כל שירות ברשת הפרטית.
startRemote().catch((e) => {
  if (e && e.code === 'EADDRINUSE') console.error(`  פורט ${REMOTE_PORT} תפוס — חיבור מרחוק לא עלה`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopRemote(); rcStopAll(); process.exit(0); });

/* ==========================================================================
   מנהל סשנים — השרת הוא מקור האמת
   --------------------------------------------------------------------------
   בעבר כל חיבור WebSocket החזיק תהליך claude משלו, ו-ws.close הרג אותו.
   המשמעות: שני מכשירים = שני תהליכים נפרדים ושני עותקי תמליל שדרסו זה את זה
   בדיסק, וסגירת הטאב בטלפון קטעה תור שרץ באמצע.
   עכשיו התהליך והמצב שייכים ל*שיחה* (conversationId), והחיבורים הם מנויים
   עליה. כל פריים יוצא מקבל seq עולה ונשמר ביומן מחזורי, כך שמכשיר שמתחבר
   באמצע תור מקבל בדיוק את מה שהחמיץ במקום להתחיל מאפס.
   מכאן נובע הסנכרון: שני המכשירים מקבלים את אותו זרם אירועים בדיוק ומריצים
   עליו את אותה לוגיקת בנייה, ולכן מתכנסים לאותו מצב — בלי פתרון קונפליקטים.
   ========================================================================== */

const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;
const STDOUT_MAX = 8 * 1024 * 1024;
const LOG_MAX = 3000;                    // פריימים שנשמרים לצורך השלמה אחרי ניתוק
const IDLE_KILL_MS = 20 * 60 * 1000;     // תהליך של שיחה בלי מנויים ובלי תור פעיל
const MAX_LIVE_SESSIONS = 6;             // תקרת תהליכי claude חיים במקביל
const MAX_QUEUE = 20;                    // פרומפטים משורשרים שממתינים לתורם
const MAX_QUEUE_BYTES = 12 * 1024 * 1024;// תקרת base64 של תמונות בכל התור יחד

// מודלים חדשים (Opus 5 ומעלה) מחזירים חשיבה מוצפנת כברירת מחדל — בלוק thinking
// עם signature ובלי טקסט. --thinking-display summarized מבקש מהמודל תקציר קריא
// של החשיבה, וזה מה שמחזיר את כרטיס החשיבה לחיים. אם ה-CLI המותקן לא מכיר את
// הדגל (גרסה ישנה), מזהים את השגיאה פעם אחת ומפסיקים לשלוח אותו.
let thinkingDisplay = true;
// אותו רעיון לשני הדגלים שהדואט נשען עליהם: מנסים, ואם ה-CLI המותקן לא מכיר
// אותם — מפסיקים לשלוח במקום להיכשל שוב ושוב.
let systemPromptFlag = true;
let toolsFlag = true;

/**
 * צ'אט אנונימי עומד כולו על דגל אחד של ה-CLI: ‎--no-session-persistence‎.
 * בשאר הדגלים כאן מותר "לנסות ואם לא — להמשיך בלעדיו"; כאן בדיוק ההפך —
 * המשך בלעדיו פירושו קובץ סשן מלא על הדיסק, כלומר ההפך הגמור ממה שהובטח.
 * לכן היכולת נבדקת מראש מול ‎--help‎, והכפתור בממשק פשוט לא נדלק בלעדיה.
 */
let anonCapable = false;
execFile('claude', ['--help'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
  anonCapable = !err && /--no-session-persistence/.test(String(stdout || ''));
  if (!anonCapable) console.log('⚠️ ה-CLI המותקן לא מכיר --no-session-persistence — צ׳אט אנונימי לא יהיה זמין');
});

/** conversationId → סשן. חי גם כשאף מכשיר לא מחובר. */
const sessions = new Map();

function newSession(id) {
  const s = {
    id,
    anon: isAnonId(id),   // נקבע מהמזהה בלבד, ולא ממה שהלקוח מצהיר
    anonSeen: 0,          // מתי נראה לאחרונה לקוח שמחזיק בצ'אט הזה (ראו sweepAnon)
    child: null, gen: 0, stdoutBuf: '', stderrBuf: '',
    lastRun: null,
    pendingPerms: new Map(),    // request_id → request — כרטיסי הרשאה פתוחים
    pendingDialogs: new Map(),  // request_id → { req, timer }
    god: false,                 // מצב GOD — כל בקשת הרשאה נענית "אשר" בשרת
    subs: new Set(),
    primary: null,              // החיבור שאחראי לכתוב את השיחה לדיסק
    seq: 0, log: [],
    running: false,
    lastUsed: Date.now(),
    lastFrameAt: 0,             // מתי יצא הפריים האחרון — הבסיס לקרוס־צ'ק מהלקוח
    // ---- החלפת מודל תוך כדי שיחה ----
    cliSessionId: null,   // מזהה הסשן האחרון שה-CLI דיווח עליו — הבסיס ל---resume
    cliAgent: null,       // הסוכן שיצר את המזהה הזה ('claude' / 'cursor'); מזהה של אחד אינו קריא לשני
    liveModel: '',        // המודל שהתהליך הרץ באמת עובד איתו ('' = ברירת המחדל)
    liveEffort: '',       // רמת המאמץ שאיתה הופעל התהליך
    pendingRestart: false,// שינוי שאי-אפשר להחיל חי; יוחל בהפעלה מחדש לפני התור הבא
    modelReq: null,       // request_id של set_model שממתין לתשובה
    // ---- שרשור פרומפטים ----
    queue: [],            // פרומפטים שממתינים; משוגרים אוטומטית בסיום כל תור
    lastTurn: null,       // התור האחרון ששוגר — הבסיס להמשך אוטומטי אחרי חידוש מכסה
    turnProduced: false,  // האם התור הנוכחי הספיק להוציא פלט לפני שנעצר
    haltSent: false,      // כבר דווחה עצירה חריגה בתור הזה — לא מדווחים פעמיים
    retry: null,          // ניסיון חוזר של ה-CLI שנמצא באוויר ברגע זה
    limitHint: '',        // שורת stderr שנראתה כמו מיצוי מכסה; נשקלת בסוף התור
    limitChecking: false, // בדיקת סיווג מול ה-API באוויר — מונע כפילות
    // ---- מכסת סשן ----
    limit: null,          // { kind, resetsAt, at, text } כשהתור נעצר בגלל מכסת הסשן
  };
  sessions.set(id, s);
  return s;
}
const getSession = (id) => sessions.get(id) || newSession(id);

/* ==========================================================================
   מנוי שלא מספיק לנקז
   --------------------------------------------------------------------------
   עם ‎--include-partial-messages‎ כל טוקן הוא פריים נפרד לכל מנוי. טלפון על
   סלולר חלש לא קורא אותם בקצב שבו הם נכתבים, ו-‎ws.send‎ ממשיך לצבור אותם
   בזיכרון של התהליך בלי שום תקרה: תור ארוך אחד מול חיבור גרוע אחד מנפח את
   השרת, ועל הדרך מאט את כל המנויים האחרים שיושבים באותו event loop.
   הפתרון לא צריך באפר משלו, כי כבר יש אחד — ‎s.log‎ מחזיק כל פריים ממוספר
   בדיוק לצורך השלמה אחרי ניתוק. לכן סוקט שעבר את סף ההמתנה פשוט מפסיק לקבל
   ומסומן ב-‎_lagFrom‎ (ה-seq האחרון שהספיק לצאת אליו); כשהוא מתנקז, אותו מסלול
   ‎subscribe‎ שמשרת חיבור שנפל משלים לו את הפער — לפי הסדר, בלי כפילות ובלי
   אובדן. ואם הפיגור ארוך מהיומן, זה בדיוק המצב שבשבילו קיים ‎mode: 'reset'‎.
   ========================================================================== */
const WS_HIGH_WATER = 2 * 1024 * 1024;   // מעבר לכמות הזו בהמתנה — מפסיקים לכתוב לסוקט
const WS_LOW_WATER = 512 * 1024;         // מתחת לזה הוא התנקז מספיק כדי להמשיך
const WS_DRAIN_MS = 25;                  // ראו הערת הקצב ב-sweepLag
const lagging = new Set();
let lagTimer = null;

function startLag(ws, s, seq) {
  if (ws._lagStart == null) {            // תחילת פיגור, ולא המשך של אותו אחד
    ws._lagAt = Date.now();
    ws._lagStart = seq - 1;
    dbg('ws.lag', { convId: s.id, device: ws._device, from: seq - 1, buffered: ws.bufferedAmount });
  }
  ws._lagFrom = seq - 1;                 // מה שיצא בפועל הוא הפריים שלפני זה שנחסם
  ws._lagSess = s;
  lagging.add(ws);
  if (!lagTimer) { lagTimer = setInterval(sweepLag, WS_DRAIN_MS); lagTimer.unref?.(); }
}

function clearLag(ws) {
  if (!ws) return;
  lagging.delete(ws);
  ws._lagFrom = null;
  ws._lagSess = null;
}

/** ניתוק או מעבר לשיחה אחרת — גם הפיגור עצמו מתבטל, ולא רק ההשלמה שלו. */
function dropLag(ws) {
  clearLag(ws);
  if (ws) { ws._lagAt = null; ws._lagStart = null; }
}

/** הפיגור נסגר — הסוקט חזר לקבל בזרם הרגיל. */
function endLag(ws, s) {
  const from = ws._lagStart;
  dbg('ws.drained', { convId: s.id, device: ws._device, from, to: s.seq, ms: Date.now() - ws._lagAt });
  ws._lagAt = null;
  ws._lagStart = null;
}

/*
 * הקצב כאן הוא כל העניין. הסקר הוא היחיד שיודע מתי הסוקט התנקז, ולכן כל
 * תקתוק מעביר לכל היותר ‎HIGH−LOW‎ בייטים: עם חלון של 448KB וסקר של 250ms
 * ההשלמה זחלה ב-1.8MB לשנייה, כלומר הייתה נשארת מאחור מול תור שמזרים מהר
 * יותר מזה. חלון של 1.5MB כל 25ms נותן תקרה של ~60MB לשנייה — הרבה מעבר לכל
 * רשת אמיתית — ומשאיר את הצוואר במקום היחיד שבו הוא שייך: הקו עצמו.
 * הסקר רץ רק כשמישהו בפיגור, ונעצר ברגע שהרשימה מתרוקנת.
 */
function sweepLag() {
  for (const ws of [...lagging]) {
    if (ws.readyState !== ws.OPEN) { clearLag(ws); continue; }
    if (ws.bufferedAmount > WS_LOW_WATER) continue;
    const s = ws._lagSess;
    const from = ws._lagFrom;
    clearLag(ws);
    // בינתיים הוא עבר לשיחה אחרת (או ירד ממנה) — אין לאן להשלים
    if (!s || ws._sess !== s) continue;
    const oldest = s.log.length ? s.log[0].seq : s.seq + 1;
    if (from < oldest - 1) {
      // הפיגור ארך יותר מהיומן. אין ממה להשלים, וזה בדיוק המצב שבשבילו קיים
      // ‎mode: 'reset'‎ — הלקוח קורא את השיחה מהדיסק ומתחיל זרם נקי.
      dbg('ws.lag.reset', { convId: s.id, device: ws._device, from, oldest });
      endLag(ws, s);
      subscribe(ws, s.id, 0);
    } else if (replayLog(ws, s, from)) {
      // המשך ההשלמה הוא אותם פריימים שהיו מגיעים חי, לפי הסדר — ולכן הוא
      // אינו דורש פריים ‎sync‎ משלו. בגרסה קודמת כל תקתוק קרא ל-subscribe,
      // והלקוח קיבל עשרות פריימי sync מיותרים על פיגור אחד.
      endLag(ws, s);
    }
  }
  if (!lagging.size && lagTimer) { clearInterval(lagTimer); lagTimer = null; }
}

/**
 * מנגן ליומן החל מ-since. מחזיר true אם הכל יצא, ו-false אם הסוקט נחסם באמצע
 * וסומן להמשך. גם ההשלמה כפופה לסף ההמתנה: בלעדיה היא הייתה הדרך הקצרה ביותר
 * בדיוק לבעיה שבאה למנוע — אלפי פריימים נשפכים בבת אחת לסוקט שרק עכשיו
 * התנקז, והבאפר מזנק לעשרות מגה-בייט במכה אחת.
 */
function replayLog(ws, s, since) {
  for (const frame of s.log) {
    if (frame.seq <= since) continue;
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > WS_HIGH_WATER) { startLag(ws, s, frame.seq); return false; }
    sendTo(ws, frame);
  }
  return true;
}

/** משדר פריים לכל המנויים ושומר אותו ביומן, כדי שמי שהתנתק יוכל להשלים. */
function emit(s, frame) {
  s.seq += 1;
  s.lastFrameAt = Date.now();
  const out = { ...frame, seq: s.seq, convId: s.id };
  // סשן של שחקן בדואט אין לו מנויים משלו ואין לו יומן להשלים ממנו: הפריימים
  // שלו מגיעים למסך רק דרך הרַכָּז, שמחליט מה מתוכם הוא חלק מהריצה הגלויה.
  if (s.relay) { s.relay(out); return; }
  s.log.push(out);
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  const raw = JSON.stringify(out);
  for (const ws of s.subs) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws._lagFrom != null) continue;                    // בפיגור — יקבל בהשלמה
    if (ws.bufferedAmount > WS_HIGH_WATER) { startLag(ws, s, out.seq); continue; }
    try { ws.send(raw); } catch {}
  }
}
/** הודעת שירות למנוי יחיד — לא נכנסת ליומן ולא תופסת seq. */
function sendTo(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch {} }
}

/**
 * GOD: עונה "אשר" לבקשת הרשאה ומשדר שורה ליומן התור.
 * מחזיר false כשזו בקשה שלא מאשרים אוטומטית — ואז היא ממשיכה במסלול הרגיל
 * ומוצגת ככרטיס.
 */
function godApprove(s, requestId, req) {
  const tool = (req && req.tool_name) || 'כלי';
  if (GOD_KEEP_TOOLS.has(tool)) return false;
  writeStdin(s, {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: (req && req.input) || {} } },
  });
  emit(s, { kind: 'god_allow', entry: { id: requestId, tool, input: godInput(req && req.input), desc: (req && req.description) || '', at: Date.now() } });
  dbg('god.allow', { convId: s.id, tool });
  return true;
}

/**
 * החלטת המשתמש על בקשת הרשאה → control_response חזרה ל-CLI.
 * מי שענה ראשון קובע; הכרטיס נסגר בשאר המכשירים דרך permission_resolved.
 * שני קוראים: הודעת ה-WebSocket מהממשק, והמענה מתוך ההתראה בטלפון
 * (‎/api/permission-answer‎) — שם אין בכלל חלון פתוח שיחזיק socket.
 * מחזיר false כשהבקשה כבר לא פתוחה, כדי שהקורא ידע לומר זאת.
 */
function answerPermission(s, msg, by) {
  if (!s || !msg.requestId || !s.pendingPerms.has(msg.requestId)) return false;
  s.pendingPerms.delete(msg.requestId);
  // label/answers נשלחים כדי שהכרטיס במכשיר השני ייסגר עם *אותה* תשובה
  // שנבחרה כאן, ולא רק עם "אושר/נדחה" גנרי.
  emit(s, {
    kind: 'permission_resolved', id: msg.requestId, decision: msg.decision,
    label: msg.label || null, answers: msg.answers || null, response: msg.response || null,
    by: by || null,
  });
  if (!s.child) return true;
  const inner = msg.decision === 'allow'
    ? { behavior: 'allow', updatedInput: msg.updatedInput || {}, ...(msg.updatedPermissions ? { updatedPermissions: msg.updatedPermissions } : {}) }
    : { behavior: 'deny', message: msg.message || 'נדחה על-ידי המשתמש' };
  writeStdin(s, { type: 'control_response', response: { subtype: 'success', request_id: msg.requestId, response: inner } });
  return true;
}

/** מעבר ל-GOD בזמן שכרטיסים כבר פתוחים — הם נענים כאן ולא נשארים תלויים. */
function godFlushPending(s) {
  for (const [id, req] of [...s.pendingPerms]) {
    if (!godApprove(s, id, req)) continue;
    s.pendingPerms.delete(id);
    emit(s, { kind: 'permission_resolved', id, decision: 'allow', label: 'god', answers: null, response: null, by: 'GOD' });
  }
}

/** הודעה קופצת לכל מי שצופה בשיחה. לא נכנסת ליומן — היא אינה חלק בתמליל. */
function toastSession(s, text, err) {
  const raw = JSON.stringify({ kind: 'toast', convId: s.id, text, err: !!err });
  for (const ws of s.subs) if (ws.readyState === ws.OPEN) { try { ws.send(raw); } catch {} }
}

/**
 * סוף הצ'אט האנונימי: התהליך נהרג, וכל מה שהיה תלוי בו בזיכרון השרת מנוקה
 * ומשוחרר — יומן הפריימים (שהוא התמליל המלא), התור, הבאפרים והתור האחרון.
 * מרגע זה אין בשרת שום ייצוג של השיחה, וגם מנוי שיחזור לא ימצא מה להשלים.
 *
 * מה שאי-אפשר להבטיח ונאמר בגלוי: JavaScript לא נותן לדרוס מחרוזת בזיכרון,
 * ולכן "נמחק" כאן = אין אליו יותר הפניה והוא משוחרר ל-GC.
 */
function destroyAnon(s) {
  if (!s || !s.anon) return;
  const wiped = { kind: 'anon_wiped', convId: s.id };
  const raw = JSON.stringify(wiped);
  for (const ws of s.subs) if (ws.readyState === ws.OPEN) { try { ws.send(raw); } catch {} }
  killChild(s);
  s.log.length = 0;
  s.queue.length = 0;
  s.lastRun = null;
  s.lastTurn = null;
  s.limit = null;
  s.limitHint = '';
  s.stdoutBuf = '';
  s.stderrBuf = '';
  s.cliSessionId = null;
  for (const ws of s.subs) if (ws._sess === s) ws._sess = null;
  s.subs.clear();
  s.primary = null;
  sessions.delete(s.id);
}

/*
 * מתי נגמר צ'אט אנונימי בלי שלחצת "יציאה"? כשאין יותר דפדפן שמחזיק אותו.
 * "מחזיק" נמדד בפינג שהלקוח שולח ממילא כל כמה שניות ושנושא את המזהים
 * האנונימיים הפתוחים אצלו. זה מבחין בין מעבר לשיחה אחרת בתוך האפליקציה (הדף
 * חי, הפינג ממשיך) לבין סגירת החלון או ניתוק (הפינג נפסק) — בלי להסתמך על
 * אירוע סגירה, שבטלפון פשוט לא תמיד נשלח.
 */
const ANON_GRACE_MS = 75 * 1000;
function sweepAnon() {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (!s.anon) continue;
    if (s.subs.size) { s.anonSeen = now; continue; }
    if (!s.anonSeen) s.anonSeen = now;   // נוצר זה עתה ועוד לא הספיק להירשם
    if (now - s.anonSeen > ANON_GRACE_MS) destroyAnon(s);
  }
}
setInterval(sweepAnon, 15 * 1000).unref?.();

/* מצב האמת של השיחה — מעל HTTP רגיל, במכוון.
   הלקוח משתמש בזה כשהמסך נראה תקוע, וזה בדיוק המצב שבו אי-אפשר לסמוך על
   ה-WebSocket: חיבור חצי-פתוח (טלפון שיצא מ-sleep או החליף רשת) נשאר readyState
   OPEN לנצח, לא יורה onclose, ולא מעביר שום פריים. בקשת HTTP פותחת חיבור חדש
   לגמרי ולכן עוקפת בדיוק את התקלה שאותה באנו לאבחן. */
app.get('/api/turn-state', (req, res) => {
  const id = String(req.query.convId || '');
  if (!VALID_ID.test(id)) return res.status(400).json({ ok: false, error: 'bad-id' });
  // sessions.get ולא getSession — בדיקת מצב לא אמורה ליצור סשן יש מאין
  const s = sessions.get(id);
  if (!s) {
    dbg('turn-state', { convId: id, known: false });
    return res.json({ ok: true, known: false, running: false, seq: 0, subs: 0, now: Date.now() });
  }
  // זו התשובה שהקרוס־צ'ק מקבל החלטות לפיה — בלעדיה אי-אפשר לדעת בדיעבד למה החליט מה שהחליט
  dbg('turn-state', { convId: id, running: !!s.running, alive: !!s.child, seq: s.seq, subs: s.subs.size, queued: s.queue.length, since: Date.now() - s.lastFrameAt });
  res.json({
    ok: true,
    known: true,
    running: !!s.running,
    alive: !!s.child,            // האם תהליך claude עצמו עדיין חי
    seq: s.seq,
    // הפריים הישן ביותר שעוד ביומן: מתחת לזה אי-אפשר להשלים, וצריך טעינה מהדיסק
    oldestSeq: s.log.length ? s.log[0].seq : s.seq + 1,
    lastFrameAt: s.lastFrameAt,
    queued: s.queue.length,
    pending: s.pendingPerms.size + s.pendingDialogs.size,
    limited: !!s.limit,
    subs: s.subs.size,
    now: Date.now(),
  });
});

/* מענה לבקשת הרשאה בלי חלון פתוח — הנתיב שמשרת את כפתורי ההתראה בטלפון.
   ההתראה עצמה נורית מה-Service Worker, ולחיצה על "אשר" או "דחה" בתוכה קורית
   כשהאפליקציה סגורה לגמרי: אין שם דף, אין WebSocket, ואין דרך להחזיר החלטה
   דרך הזרם הרגיל. ה-SW חי גם אז, ויכול לעשות fetch — וזה כל מה שצריך.

   ההרשאה: המאזין הראשי קשור ל-127.0.0.1 בלבד, והמאזין של ה-LAN מעביר כל
   בקשה דרך שער עוגיית המכשיר (‎remoteApp.use(app)‎). כלומר הנתיב הזה כבר
   סגור בדיוק כמו כל השאר, בלי שער נוסף משלו. */
app.post('/api/permission-answer', express.json({ limit: '4kb' }), (req, res) => {
  const { convId, requestId, decision } = req.body || {};
  if (!VALID_ID.test(String(convId || ''))) return res.status(400).json({ ok: false, error: 'bad-id' });
  if (decision !== 'allow' && decision !== 'deny') return res.status(400).json({ ok: false, error: 'bad-decision' });
  // sessions.get ולא getSession — מענה לבקשה לא אמור ליצור סשן יש מאין
  const s = sessions.get(String(convId));
  const by = deviceLabel(req) + ' · התראה';
  // הבקשה כבר נענתה במכשיר אחר (או שהתור נגמר) — לא שגיאה, פשוט מאוחר מדי
  const ok = answerPermission(s, { requestId: String(requestId || ''), decision, label: decision }, by);
  dbg('perm.notify', { convId, decision, by: deviceLabel(req), ok });
  res.json({ ok });
});

// כל החיבורים הפתוחים, בלי קשר לשיחה שהם צופים בה — לשידור שינויים ברמת
// רשימת השיחות (שיחה חדשה, שינוי שם, מחיקה) לכל המכשירים.
const allClients = new Set();
function broadcastAll(obj) {
  const raw = JSON.stringify(obj);
  for (const ws of allClients) {
    if (ws.readyState === ws.OPEN) { try { ws.send(raw); } catch {} }
  }
}

function setRunning(s, running) {
  s.lastUsed = Date.now();
  if (s.running === running) return;
  s.running = running;
  dbg('turn.' + (running ? 'start' : 'end'), { convId: s.id, seq: s.seq, subs: s.subs.size, queued: s.queue.length });
  emit(s, { kind: 'busy', running });
}

function writeStdin(s, obj) {
  if (!s.child || !s.child.stdin || s.child.stdin.destroyed) return false;
  try {
    s.child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (e) {
    emit(s, { kind: 'error', text: 'stdin: ' + (e.message || e) });
    return false;
  }
}

/** הספק תואם-OpenAI שמגיש את המודל, אם יש כזה. */
const oaiProviderOf = (model) => oaiProviders.find((p) => p.hasModel(model)) || null;

/**
 * דרך ההרצה של מודל: ישירות מול Anthropic, דרך שער ה-CCR, או דרך גשר של ספק
 * תואם-OpenAI. לכל ספק ערך משלו (`oai:<id>`), כי לכל גשר כתובת וטוקן משלו —
 * מעבר בין שני ספקים כאלה חייב להפעיל מחדש את התהליך, בדיוק כמו מעבר לשער.
 */
function transportOf(model) {
  // Cursor הוא מסלול נפרד לגמרי: לא ה-CLI של Claude, לא משתני סביבה, ולא אותו
  // פרוטוקול. הבדיקה ראשונה כי מזהיו נושאים קידומת משלהם ואינם יכולים להתנגש.
  if (cursor.isCursorModel(model)) return 'cursor';
  const p = oaiProviderOf(model);
  if (p) return 'oai:' + p.id;
  return model && ccrKey && ccrModelIds.has(model) ? 'gateway' : 'native';
}

/**
 * מחיל בחירת מודל/מאמץ חדשה על שיחה שכבר רצה, בלי שהמשתמש ירגיש דבר.
 *
 * שני מסלולים:
 *  1. החלפת מודל בתוך אותו ערוץ — control_request מסוג set_model על אותו תהליך.
 *     ההקשר לא זז בכלל: אותה שיחה, אותו זיכרון, רק המודל שעונה מכאן והלאה.
 *  2. שינוי שהוא ברמת ההפעלה (מאמץ, או מעבר בין השער לחיבור הישיר — שדורש
 *     משתני סביבה אחרים) — מסמנים pendingRestart. ההפעלה מחדש נעשית *עצלה*,
 *     רגע לפני התור הבא, עם --resume על אותו סשן: התהליך מתחלף, ההקשר לא.
 *     עצלה ולא מיידית, כדי לא לקטוע תור שרץ ולא לשלם על החלפה שהמשתמש
 *     יחזור ממנה שנייה אחר כך.
 */
function applyModelChange(s, model, effort) {
  model = model || '';
  effort = effort || '';
  if (model === s.liveModel && effort === s.liveEffort) return;
  const prevModel = s.liveModel;
  const prevEffort = s.liveEffort;
  s.liveModel = model;
  s.liveEffort = effort;
  if (!s.child) return;   // אין תהליך — ההפעלה הבאה ממילא תיקח את הבחירה החדשה

  // ---- Cursor ----
  // אצל Cursor רמת המאמץ אינה דגל נפרד אלא חלק ממזהה המודל, והמזהה נקבע מחדש
  // בכל תור ממילא. לכן שינוי מאמץ בתוך Cursor אינו דורש הפעלה מחדש — הוא נוסע
  // באותו set_model כמו המודל, והשיחה לא זזה בכלל.
  if (transportOf(model) === 'cursor' && transportOf(prevModel) === 'cursor') {
    const rid = 'sm-' + Date.now().toString(36);
    s.modelReq = rid;
    if (!writeStdin(s, { type: 'control_request', request_id: rid, request: { subtype: 'set_model', model, effort } })) s.pendingRestart = true;
    return;
  }
  if (effort !== prevEffort || transportOf(model) !== transportOf(prevModel)) {
    // שינוי כזה מוחל בהפעלה מחדש עם --resume. בשיחה אנונימית אין לְמה לחזור:
    // ההקשר חי רק בתוך התהליך, והפעלה מחדש הייתה מוחקת אותו בלי שביקשת.
    // לכן הבחירה מוחזרת לאחור ונאמר במפורש מה צריך לעשות במקום.
    if (s.anon) {
      s.liveModel = prevModel;
      s.liveEffort = prevEffort;
      toastSession(s, 'בצ׳אט אנונימי אי-אפשר להחליף רמת מאמץ או ספק באמצע — ההקשר חי רק בתהליך הרץ', true);
      return;
    }
    s.pendingRestart = true;
    return;
  }
  const rid = 'sm-' + Date.now().toString(36);
  s.modelReq = rid;
  // בלי שדה model = חזרה למודל ברירת המחדל של ה-CLI, בדיוק כמו הפעלה בלי --model
  const request = model ? { subtype: 'set_model', model } : { subtype: 'set_model' };
  if (!writeStdin(s, { type: 'control_request', request_id: rid, request }) && !s.anon) s.pendingRestart = true;
}

function killChild(s) {
  for (const d of s.pendingDialogs.values()) clearTimeout(d.timer);
  s.pendingDialogs.clear();
  s.pendingPerms.clear();
  if (s.child) {
    s.gen += 1;
    try { s.child.stdin.end(); } catch {}
    try { s.child.kill('SIGTERM'); } catch {}
    s.child = null;
    s.stdoutBuf = '';
  }
  setRunning(s, false);
}

/** סוגר תהליכים של שיחות שאיש כבר לא צופה בהן ושאין בהן תור פעיל. */
function reapIdle(force) {
  const now = Date.now();
  const idle = [...sessions.values()]
    .filter((s) => s.child && !s.running && s.subs.size === 0 && !s.duetRole)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const s of idle) {
    if (force || now - s.lastUsed > IDLE_KILL_MS) killChild(s);
    if (force && [...sessions.values()].filter((x) => x.child).length < MAX_LIVE_SESSIONS) break;
  }
  // סשן בלי תהליך, בלי מנויים ובלי מה להשלים — אין טעם להחזיק אותו בזיכרון.
  // שיחה שממתינה לחידוש מכסה או שיש בה פרומפטים בתור *היא* משהו להשלים.
  for (const [id, s] of sessions) {
    // שחקן בדואט הוא בהגדרה בלי מנויים ובלי תור — הבעלות עליו היא של הרַכָּז,
    // והוא זה שסוגר אותו בסיום הריצה
    if (s.limit || s.queue.length || s.duetRole) continue;
    if (!s.child && !s.subs.size && now - s.lastUsed > IDLE_KILL_MS) sessions.delete(id);
  }
}
setInterval(() => reapIdle(false), 60 * 1000).unref?.();

/* ==========================================================================
   עצירה באמצע תשובה — זיהוי, דיווח ותיעוד
   --------------------------------------------------------------------------
   "התשובה נעצרה באמצע משפט ולא קרה כלום" הוא לא באג בזרם: ה-CLI כן אומר
   בדיוק למה הוא עצר — רק שהוא אומר את זה בשלושה ערוצים נפרדים, ואף אחד
   מהם לא הגיע למסך:

     1. system/api_error — כל כישלון קריאה ל-API, כולל כל ניסיון חוזר
        (error, retryAttempt, maxRetries, retryInMs). נבלע כי הלקוח מטפל
        רק ב-init וב-thinking_tokens ומתעלם משאר תת-הסוגים.

     2. assistant עם isApiErrorMessage — ההודעה הסינתטית "הנה למה עצרתי"
        ("API Error: Response stalled mid-stream", 529 Overloaded, סירוב
        מדיניות). היא כן הגיעה ללקוח ושם נזרקה: המסלול החי מתעלם מכל הודעת
        assistant כי היא כפילות של הסטרימינג — וזו ההודעה היחידה שאיננה
        כפילות, אלא ההסבר עצמו.

     3. result עם terminal_reason ≠ completed (api_error / stalled / refusal
        / max_tokens / max_turns / budget_exhausted …) — נקרא עד כה רק בשביל
        העלות והטוקנים, ושדה השגיאה שבו נזרק.

   שלושתם מסוכמים כאן לפריים אחד — halt — שנכנס ליומן, נכתב לתמליל ושורד
   רענון דף. מה שלא מגיע למסך נכתב בכל מקרה ליומן הריצה.
   ========================================================================== */
const HALT_TITLE = {
  api_error: 'שגיאת API — התשובה נקטעה',
  stalled: 'הזרם נתקע באמצע התשובה',
  refusal: 'המודל סירב להשלים את התשובה',
  max_tokens: 'התשובה נחתכה בתקרת הטוקנים',
  max_turns: 'נגמרו סבבי הכלים המותרים לתור',
  budget_exhausted: 'תקציב הריצה נגמר',
  permission_denied: 'התור נעצר בעקבות דחיית הרשאה',
  structured_output_retry_exhausted: 'נגמרו הניסיונות להפיק פלט מובנה',
  tool_deferred_unavailable: 'כלי שנדרש לא היה זמין',
  max_structured_output_retries: 'נגמרו הניסיונות להפיק פלט מובנה',
  max_budget_usd: 'תקרת העלות של הריצה נגמרה',
  during_execution: 'התור נעצר בשגיאה תוך כדי ריצה',
  cancelled: 'הריצה בוטלה',
  interrupted: 'הריצה הופסקה',
  error: 'התור נעצר בשגיאה',
};
// עצירה שהמשתמש עצמו יזם — הערה שקטה בתמליל, לא כרטיס שגיאה
const HALT_SOFT = new Set(['cancelled', 'interrupted']);

/** הטקסט של הודעת השגיאה הסינתטית של ה-CLI, או '' אם זו הודעה רגילה. */
function apiErrorText(evt) {
  const m = evt.message || {};
  const blocks = Array.isArray(m.content) ? m.content : [];
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n').trim();
  // הדגל הוא הסימן הרשמי; הבדיקה על הטקסט היא גיבוי ל-CLI שלא מסמן אותו
  if (evt.isApiErrorMessage || evt.is_api_error_message) return text || 'API Error';
  return /^API Error\b/i.test(text) ? text : '';
}

/** סיווג עצירה מתוך הטקסט שה-CLI כתב — מה שקובע איזה כותרת תוצג. */
function reasonFromText(t) {
  if (/stalled mid-stream/i.test(t)) return 'stalled';
  if (/usage policy|unable to respond to this request/i.test(t)) return 'refusal';
  return 'api_error';
}

/** סיווג עצירה מתוך אירוע ה-result. מחזיר null כשהתור הסתיים כשורה. */
function haltFromResult(evt) {
  const tr = typeof evt.terminal_reason === 'string' ? evt.terminal_reason : '';
  const sub = typeof evt.subtype === 'string' ? evt.subtype : '';
  const stop = typeof evt.stop_reason === 'string' ? evt.stop_reason : '';
  // חיתוך בתקרת טוקנים או סירוב יכולים להגיע גם על תור ש"הסתיים" כשורה
  const stopBad = stop === 'max_tokens' || stop === 'refusal';
  const clean = (tr ? tr === 'completed' : sub === 'success') && !evt.is_error && !evt.api_error_status;
  if (clean && !stopBad) return null;

  const reason = (tr && tr !== 'completed') ? tr
    : stopBad ? stop
    : sub.startsWith('error_') ? sub.slice(6)
    : evt.api_error_status ? 'api_error'
    : 'error';

  const bits = [];
  if (typeof evt.result === 'string' && evt.result.trim()) bits.push(evt.result.trim());
  if (evt.api_error_status) bits.push('סטטוס HTTP: ' + evt.api_error_status);
  const denials = (Array.isArray(evt.permission_denials) ? evt.permission_denials : [])
    .map((d) => (d && (d.tool_name || d.toolName)) || '').filter(Boolean);
  if (denials.length) bits.push('כלים שנדחו: ' + denials.join(', '));
  return { reason, detail: bits.join('\n'), stop, subtype: sub, terminal: tr };
}

/** מדווח עצירה אחת לכל תור — הראשונה שהתגלתה היא זו שמסבירה בפועל. */
function emitHalt(s, h) {
  if (!h || s.haltSent) return;
  s.haltSent = true;
  const reason = h.reason || 'error';
  const detail = String(h.detail || '').trim().slice(0, 4000);
  dbg('turn.halt', {
    convId: s.id, reason, from: h.from || null, terminal: h.terminal || null,
    subtype: h.subtype || null, stop: h.stop || null,
    model: s.liveModel || '(ברירת מחדל)', produced: !!s.turnProduced,
    detail: detail.slice(0, 500),
  });
  emit(s, {
    kind: 'halt',
    reason,
    title: HALT_TITLE[reason] || HALT_TITLE.error,
    detail,
    soft: HALT_SOFT.has(reason),
    model: s.liveModel || '',
    at: Date.now(),
  });
}

/** הנחיית המערכת של צ'אט אנונימי בלי כלים (ראו ההסבר ליד השימוש). */
const ANON_SYSTEM_PROMPT = [
  'This is an ephemeral, conversation-only session: no tools are available to you at all.',
  'Never emit, simulate, or narrate tool calls — answer directly from your own knowledge,',
  'and if something would genuinely require reading files, running commands or searching,',
  'say so plainly instead of pretending to do it.',
  'Nothing from this conversation is written to disk: no transcript, no session file, no log.',
].join(' ');

/** הנחיית המערכת של שיחה ללא תיקייה (ראו NO_DIR). כמו האנונימית, בלי ההבטחה
 *  שדבר לא נכתב לדיסק — כאן השיחה נשמרת כרגיל, רק בלי פרויקט ובלי כלים. */
const NO_DIR_SYSTEM_PROMPT = [
  'This is a conversation-only session: there is no project directory and no tools are',
  'available to you at all. Never emit, simulate, or narrate tool calls — answer directly',
  'from your own knowledge, and if something would genuinely require reading files, running',
  'commands or searching, say so plainly instead of pretending to do it.',
].join(' ');

function startChild(s, opts) {
  if ([...sessions.values()].filter((x) => x.child).length >= MAX_LIVE_SESSIONS) reapIdle(true);

  // צ'אט אנונימי בלי הדגל שמכבה את שמירת הסשן הוא צ'אט רגיל שקוראים לו
  // אנונימי. עדיף להיכשל בקול מאשר לכתוב סשן לדיסק אחרי שהובטח שלא ייכתב.
  // ל-cursor-agent אין מקבילה ל---no-session-persistence: כל שיחה נכתבת
  // ל-~/.cursor/chats. הבטחה שלא נוכל לקיים עדיף להגיד עליה מראש שאינה קיימת.
  if (s.anon && cursor.isCursorModel(opts.model)) {
    emit(s, { kind: 'error', text: 'צ׳אט אנונימי לא נתמך עם מודלי Cursor — ה-CLI שלו שומר כל שיחה לדיסק' });
    s.child = null;
    return false;
  }
  if (s.anon && !anonCapable) {
    emit(s, { kind: 'error', text: 'ה-CLI המותקן לא תומך ב---no-session-persistence — צ׳אט אנונימי לא יכול לרוץ בלעדיו' });
    s.child = null;
    return false;
  }

  const workdir = resolveDirGlobal(opts.cwd);
  // שיחה ללא תיקייה היא שיחה בלי כלים — זה מה שמבדיל אותה משיחה שסתם רצה
  // בתיקיית הבית. התיקייה שנפתרה היא רק כתובת לתהליך ולקובץ הסשן.
  const noDir = isNoDir(opts.cwd);
  const noTools = !!opts.noTools || noDir;
  // התיקייה נוצרה על ידינו והיא ריקה; בלי סימון האמון ה-CLI היה עוצר בשאלה
  // שאין לה מסך בממשק הזה.
  if (noDir && !isTrustedDir(workdir)) { try { trustDir(workdir); } catch (e) { dbg('nodir.trust.fail', { msg: e.message }); } }
  // מצב GOD חי בשרת ולא ב-CLI: לשם נשלח ‎default‎, שיאלץ אותו לשאול על הכול,
  // והתשובה "אשר" נכתבת כאן (ראו godApprove).
  s.god = isGodMode(opts.permissionMode);
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--replay-user-messages',
    '--verbose',
    '--permission-mode', cliPermMode(opts.permissionMode) || 'acceptEdits',
    // אישור הרשאות אינטראקטיבי בתוך ה-UI — ה-CLI מפנה בקשות הרשאה כ-control_request
    // מסוג can_use_tool דרך אותו ערוץ stream-json, ואנחנו עונים ב-control_response.
    '--permission-prompt-tool', 'stdio',
  ];
  // בלי זה כרטיס החשיבה נשאר ריק במודלים חדשים (ראו ההערה ליד thinkingDisplay)
  if (thinkingDisplay) args.push('--thinking-display', 'summarized');
  if (opts.model) args.push('--model', opts.model);
  // הנחיית מערכת ייעודית להרצה. נדרשת בכל הפעלה מחדש (גם עם --resume), כי היא
  // מה שמחזיק את כללי המשחק גם כשההקשר הישן כבר נגזם.
  if (opts.systemPrompt && systemPromptFlag) args.push('--append-system-prompt', opts.systemPrompt);
  // בלי זה המודל ממציא קריאות-כלי כטקסט: הנחיית המערכת של ה-CLI עדיין מתארת
  // כלים, גם כשהם כובו ב---tools ''. שורה אחת שמיישרת בין מה שנאמר לו לבין מה
  // שבאמת עומד לרשותו — ומספרת לו שהשיחה הזו לא נשמרת בשום מקום.
  else if (s.anon && noTools && systemPromptFlag) args.push('--append-system-prompt', ANON_SYSTEM_PROMPT);
  else if (noDir && systemPromptFlag) args.push('--append-system-prompt', NO_DIR_SYSTEM_PROMPT);
  // ריצה שאין בה מה לעשות עם כלים (דואט: התוצר הוא טקסט במצב הריצה, לא קבצים)
  if (noTools && toolsFlag) args.push('--tools', '');
  const transport = transportOf(opts.model);
  const viaCursor = transport === 'cursor';
  const viaGateway = transport === 'gateway';
  // מזהה סשן שייך לסוכן שיצר אותו, ולכן הוא נבדק כאן — לפני שהוא הופך לדגל.
  // opts.resume נופל בחזרה על s.cliSessionId כשהלקוח לא שלח מזהה, וזה בדיוק
  // המקרה שבו מזהה של Cursor היה מגיע ל---resume של Claude (ולהפך): התשובה
  // הייתה "No conversation found", והתור כולו נפל. השיחה ממשיכה בלי ההקשר
  // שממילא לא היה שייך לה, ולא נופלת.
  const wantAgent = viaCursor ? 'cursor' : 'claude';
  let resumeId = opts.resume || '';
  if (resumeId && s.cliAgent && s.cliAgent !== wantAgent) {
    dbg('resume.agent_mismatch', { convId: s.id, had: s.cliAgent, want: wantAgent });
    resumeId = '';
    s.cliSessionId = null;
  }
  s.cliAgent = wantAgent;
  const oaiProvider = transport.startsWith('oai:') ? oaiProviderOf(opts.model) : null;
  // מודלי השער והספקים תואמי-OpenAI לא מכירים --effort, והעברתו מפילה את ההרצה
  if (opts.effort && !viaGateway && !oaiProvider) args.push('--effort', opts.effort);
  // ---- צ'אט אנונימי ----
  // ‎--no-session-persistence‎: ה-CLI לא כותב קובץ סשן תחת ~/.claude/projects,
  // ולכן אין מה לחדש ואין מה לקרוא. ‎--resume‎ נחסם כאן ולא רק "לא נשלח":
  // המזהה מגיע מהלקוח, ושיחה אנונימית לעולם לא תמשיך סשן קיים.
  if (s.anon) args.push('--no-session-persistence');
  else if (resumeId && !viaCursor) args.push('--resume', resumeId);

  const oaiBridge = oaiProvider ? oaiBridges.get(oaiProvider.id) : null;
  if (oaiProvider && !oaiBridge) {
    emit(s, { kind: 'error', text: `גשר ${oaiProvider.label} לא עלה — בחר מודל אחר או בדוק את ${oaiProvider.envHint}` });
    s.child = null;
    return false;
  }

  // ההפניה היא ברמת ההרצה בלבד — בלי CLAUDE_CONFIG_DIR, כדי שההיסטוריה וה-resume
  // יישארו ב-~/.claude המשותף ולא ייפרדו לפי המודל שנבחר.
  let env = process.env;
  if (viaGateway) {
    env = { ...process.env, ANTHROPIC_BASE_URL: CCR_GATEWAY, ANTHROPIC_API_KEY: ccrKey };
  } else if (oaiBridge) {
    env = { ...process.env, ANTHROPIC_BASE_URL: oaiBridge.url, ANTHROPIC_API_KEY: oaiBridge.token };
    // ANTHROPIC_AUTH_TOKEN שקיים בסביבה גובר על x-api-key ומגיע לגשר כטוקן זר;
    // מחיקתו כאן מונעת 401 שנראה כאילו הספק דחה את הבקשה.
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // בצ'אט אנונימי גם מה שאינו השיחה עצמה נסגר: טלמטריה, דיווח שגיאות, וקריאות
  // מודל נלוות (כותרות, ניחושים) — כל אחת מהן היא בקשה נוספת שיוצאת בגלל
  // השיחה הזו ושלא ביקשת. מה שנשאר יוצא החוצה הוא התור עצמו, ותו לא.
  if (s.anon) {
    env = {
      ...env,
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
  }

  s.gen += 1;
  const gen = s.gen;
  s.stderrBuf = '';
  s.lastRun = { opts, payload: s.lastRun && s.lastRun.opts === opts ? s.lastRun.payload : null };
  // מכאן והלאה זה מה שהתהליך באמת מריץ — הבסיס להשוואה בכל החלפת מודל
  s.liveModel = opts.model || '';
  s.liveEffort = opts.effort || '';
  s.pendingRestart = false;
  s.modelReq = null;

  let child;
  try {
    child = viaCursor
      // החיקוי מתנהג כמו התהליך של Claude לכל דבר — stdin שמקבל את אותו
      // פרוטוקול, stdout שמוציא את אותה סכמה — ולכן כל מה שמתחת לשורה הזו
      // (ניתוח הזרם, עצירות, מכסה, יציאה) משותף לשני הסוכנים בלי ענף אחד.
      ? cursor.spawnCursor({
        cwd: workdir, model: opts.model, effort: opts.effort || '', resume: resumeId,
        // אותה תיקייה זמנית שמשרתת את הצירופים מהדפדפן, ולכן אותו ניקוי לפי
        // TTL חל גם על תמונות שנכתבו עבור Cursor (ראו cleanupUploads)
        imageDir: UPLOAD_DIR,
        permissionMode: cursor.PERM_MODES.includes(opts.permissionMode) ? opts.permissionMode : cursor.PERM_DEFAULT,
        // אין ל-cursor-agent דגלים מקבילים לשני אלה; הגשר מממש אותם בפתיח
        // הפרומפט ובמצב ההרצה (ראו _preamble). בלעדיהם מצב דואט היה מריץ
        // מודל שלא קיבל מעולם את כללי המשחק שלו.
        systemPrompt: opts.systemPrompt || (noTools && s.anon ? ANON_SYSTEM_PROMPT : noDir ? NO_DIR_SYSTEM_PROMPT : ''),
        noTools,
      })
      : spawn('claude', args, { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    emit(s, { kind: 'error', text: `לא ניתן להפעיל את ${viaCursor ? 'cursor-agent' : 'claude'}: ` + err.message });
    s.child = null;
    return false;
  }
  s.child = child;

  // לחיצת יד: מודיעים ל-CLI שהלקוח מטפל בבקשות הרשאה (מפעיל את ערוץ ה-stdio).
  writeStdin(s, { type: 'control_request', request_id: 'init-' + Date.now().toString(36), request: { subtype: 'initialize' } });

  child.stdout.on('data', (data) => {
    if (gen !== s.gen) return;
    s.stdoutBuf += data.toString();
    if (s.stdoutBuf.length > STDOUT_MAX) {
      dbg('cli.stdout.overflow', { convId: s.id, max: STDOUT_MAX });
      s.stdoutBuf = '';
      emit(s, { kind: 'error', text: 'פלט התהליך חרג מהגודל המותר' });
      return;
    }
    let nl;
    while ((nl = s.stdoutBuf.indexOf('\n')) >= 0) {
      const line = s.stdoutBuf.slice(0, nl);
      s.stdoutBuf = s.stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let evt;
      // שורה שאיננה JSON תקין היא כשלעצמה עדות: או ש-CLI כתב טקסט חופשי
      // ל-stdout, או שהזרם נחתך באמצע שורה. עד כה היא נזרקה בשקט משני הצדדים.
      try { evt = JSON.parse(line); } catch { dbg('cli.raw', { convId: s.id, line: line.slice(0, 500) }); emit(s, { kind: 'raw', line }); continue; }

      // מזהה הסשן העדכני של ה-CLI. הוא מה שמאפשר להפעיל מחדש עם --resume
      // ולהמשיך מאותה נקודה גם כשהלקוח לא מחובר כדי לספק אותו.
      // בשיחה אנונימית אין קובץ סשן, ולכן גם המזהה חסר משמעות — ואין סיבה
      // להחזיק אותו בזיכרון או לשדר אותו הלאה.
      if (!s.anon && typeof evt.session_id === 'string' && evt.session_id) s.cliSessionId = evt.session_id;

      // ---- פרוטוקול בקרה (הרשאות) ----
      if (evt.type === 'control_request' && evt.request && evt.request.subtype === 'can_use_tool') {
        // GOD — נענה כאן ומיד, בלי כרטיס ובלי להמתין למכשיר כלשהו
        if (s.god && godApprove(s, evt.request_id, evt.request)) continue;
        // נשמר כדי שמכשיר שמתחבר עכשיו יראה את הכרטיס הפתוח ויוכל לענות עליו
        s.pendingPerms.set(evt.request_id, evt.request);
        emit(s, { kind: 'permission', id: evt.request_id, req: evt.request });
        continue;
      }
      if (evt.type === 'control_cancel_request') {
        s.pendingPerms.delete(evt.request_id);
        emit(s, { kind: 'permission_cancel', id: evt.request_id });
        continue;
      }
      if (evt.type === 'control_response') {
        // תשובת ה-CLI ל-initialize שלנו — נבלעת בשקט. היחידה שמעניינת אותנו
        // היא דחיית set_model: אז נופלים חזרה להפעלה מחדש עם resume, וההחלפה
        // עדיין קורית — רק לפני התור הבא במקום מיד.
        const r = evt.response || {};
        if (s.modelReq && r.request_id === s.modelReq) {
          s.modelReq = null;
          if (r.subtype === 'error') {
            if (s.anon) toastSession(s, 'החלפת המודל לא התקבלה, והשיחה ממשיכה עם הקודם — הפעלה מחדש הייתה מוחקת את ההקשר האנונימי', true);
            else s.pendingRestart = true;
          }
        }
        continue;
      }
      if (evt.type === 'control_request') {
        // תת-סוג שאיננו מכירים (למשל request_user_dialog): קודם מציגים אותו
        // למשתמש כדי שיוכל להשיב. רק אם אין תשובה תוך זמן קצוב עונים בשגיאה,
        // כדי שה-CLI לא ייתקע.
        const rid = evt.request_id;
        const req = evt.request || {};
        const timer = setTimeout(() => {
          if (!s.pendingDialogs.has(rid)) return;
          s.pendingDialogs.delete(rid);
          emit(s, { kind: 'dialog_timeout', id: rid });
          writeStdin(s, { type: 'control_response', response: { subtype: 'error', request_id: rid, error: 'no response from user' } });
        }, DIALOG_TIMEOUT_MS);
        s.pendingDialogs.set(rid, { req, timer });
        emit(s, { kind: 'dialog', id: rid, req });
        continue;
      }

      // כל פלט אמיתי של המודל מסמן שהתור הספיק להתקדם — זה מה שקובע אם המשך
      // אחרי חידוש מכסה צריך להיות "המשך מהנקודה" או שיגור מחדש של הפרומפט.
      if (evt.type === 'assistant' || evt.type === 'stream_event') s.turnProduced = true;

      // ---- אבחון עצירות ----
      // כישלון קריאה ל-API. מגיע גם על ניסיון חוזר שהצליח בסוף, ולכן הוא
      // מתועד ומוצג כחיווי חי — אבל אינו סוגר את התור בעצמו.
      if (evt.type === 'system' && evt.subtype === 'api_error') {
        const info = {
          convId: s.id, model: s.liveModel || '(ברירת מחדל)',
          attempt: evt.retryAttempt || 0, max: evt.maxRetries || 0,
          retryInMs: evt.retryInMs || 0, source: evt.source || null,
          error: logFmt(evt.error).slice(0, 500),
        };
        dbg('cli.api_error', info);
        s.retry = { attempt: info.attempt, max: info.max, at: Date.now() };
        if (LIMIT_RE.test(info.error)) s.limitHint = info.error;
      }
      if (evt.type === 'system' && evt.subtype === 'api_retry') {
        dbg('cli.api_retry', { convId: s.id, evt: logFmt(evt).slice(0, 500) });
      }
      // מצב המכסה כפי שה-CLI עצמו רואה אותו — הראיה הכי ישירה שיש למה תור
      // ייעצר בעוד רגע, וגם למה הוא נעצר בדיעבד.
      if (evt.type === 'rate_limit_event' && evt.rate_limit_info && evt.rate_limit_info.status !== 'allowed') {
        dbg('cli.rate_limit', { convId: s.id, info: evt.rate_limit_info });
      }
      // ההודעה הסינתטית שה-CLI מייצר כשהוא מוותר. זה הטקסט שמסביר למשתמש
      // למה התשובה נפסקה — והמקום היחיד שבו הוא קיים.
      if (evt.type === 'assistant') {
        const err = apiErrorText(evt);
        if (err) {
          dbg('cli.api_error_message', { convId: s.id, model: s.liveModel || '(ברירת מחדל)', text: err.slice(0, 500) });
          // מיצוי מכסה כבר יש לו פס משלו במסך — לא מציפים אותו גם ככרטיס
          if (LIMIT_RE.test(err)) s.limitHint = err;
          else emitHalt(s, { reason: reasonFromText(err), detail: err, from: 'assistant' });
        }
      }

      // ה-halt חייב לצאת לפני אירוע ה-result: הלקוח סוגר עליו את התור החי,
      // וכרטיס שמגיע אחרי הסגירה כבר לא היה לו לאן להיתלות.
      if (evt.type === 'result') {
        dbg('cli.result', {
          convId: s.id, is_error: !!evt.is_error, subtype: evt.subtype || null,
          terminal: evt.terminal_reason || null, stop: evt.stop_reason || null,
          api_error_status: evt.api_error_status || null, turns: evt.num_turns || 0,
          dur: evt.duration_ms || 0, denials: (evt.permission_denials || []).length,
        });
        const errText = evt.is_error || (evt.subtype && evt.subtype !== 'success')
          ? [evt.result, evt.error, evt.message].filter((x) => typeof x === 'string').join(' ')
          : '';
        // הרמז מ-stderr נחשב רק כאן, בסוף התור: ה-CLI מדפיס אזהרת rate limit גם
        // כשהוא מתאושש ממנה לבד, והריגת תהליך בריא באמצע עבודה על סמך שורת
        // stderr הייתה גרועה בהרבה מהבעיה שהיא פותרת.
        const hit = (errText && LIMIT_RE.test(errText)) ? errText : (s.limitHint || '');
        const h = hit ? null : haltFromResult(evt);
        if (h) emitHalt(s, { ...h, from: 'result' });

        // סדר חשוב: קודם האירוע עצמו (הקליינט מסיים את התור עליו), ורק אחריו
        // דגל הסיום. הפוך מזה, הקליינט היה מקבל "לא עסוק" לפני שהתור נסגר.
        emit(s, { kind: 'event', evt });
        const produced = s.turnProduced;
        s.retry = null;
        setRunning(s, false);
        if (hit) {
          onLimitHit(s, hit, produced).catch(() => {});
        } else {
          // setImmediate כדי שהעיבוד של הפריימים שנותרו במאגר יסתיים קודם
          setImmediate(() => drainQueue(s));
        }
        continue;
      }

      emit(s, { kind: 'event', evt });
    }
  });

  child.stderr.on('data', (d) => {
    if (gen !== s.gen) return;
    const text = d.toString();
    if (s.stderrBuf.length < 4096) s.stderrBuf += text;
    // עד כה זה נבלע פעמיים: המסך התעלם מהפריים, והיומן לא ראה אותו בכלל.
    // זה בדיוק המקום שבו ה-CLI מסביר למה הוא נפל בלי להספיק להוציא result.
    dbg('cli.stderr', { convId: s.id, text: text.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 1000) });
    emit(s, { kind: 'stderr', text });
    // ה-CLI מדווח על מיצוי מכסה גם כאן, ולעיתים רק כאן (נפילה לפני result).
    // נרשם כרמז בלבד — ההחלטה נופלת בסוף התור, כשידוע אם הוא התאושש.
    if (LIMIT_RE.test(text)) s.limitHint = text;
  });

  child.on('exit', (code, signal) => {
    if (gen !== s.gen) return;
    const wasRunning = s.running;
    dbg('cli.exit', {
      convId: s.id, code, signal: signal || null, running: wasRunning,
      produced: !!s.turnProduced, model: s.liveModel || '(ברירת מחדל)',
      stderr: s.stderrBuf.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-800),
    });
    s.child = null;
    s.stdoutBuf = '';
    // ה-CLI המותקן לא מכיר את --thinking-display → מנסים שוב בלעדיו, פעם אחת
    // אותה נפילה-לאחור בדיוק גם לשני הדגלים של הדואט: CLI ישן שלא מכיר אותם
    // לא אמור למנוע את המצב כולו, ולכן מזהים פעם אחת ומפסיקים לשלוח.
    let dropped = false;
    if (code !== 0 && systemPromptFlag && /unknown option[^\n]*--append-system-prompt/.test(s.stderrBuf)) { systemPromptFlag = false; dropped = true; }
    if (code !== 0 && toolsFlag && /unknown option[^\n]*--tools/.test(s.stderrBuf)) { toolsFlag = false; dropped = true; }
    if (code !== 0 && thinkingDisplay && /unknown option[^\n]*--thinking-display/.test(s.stderrBuf)) { thinkingDisplay = false; dropped = true; }
    if (dropped) {
      const run = s.lastRun;
      if (run && run.opts && startChild(s, run.opts)) {
        if (run.payload) writeStdin(s, run.payload);
        return;
      }
    }
    // תהליך שמת באמצע תור הוא עצירה לכל דבר, וזו הצורה הכי שקטה שלה: אין
    // result, אין stderr מובן, ו-SIGKILL (למשל מחסל הזיכרון של המערכת) מגיע
    // עם code=null — שהוא falsy, ולכן גם ההודעה על קוד יציאה לא נורתה.
    if (wasRunning && !s.limitHint) {
      const how = signal ? 'התהליך נהרג באות ' + signal : 'התהליך יצא עם קוד ' + code;
      const tail = s.stderrBuf.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-1500);
      emitHalt(s, {
        reason: signal === 'SIGTERM' || signal === 'SIGINT' ? 'interrupted' : 'error',
        detail: [how, tail].filter(Boolean).join('\n\n'),
        from: 'exit',
      });
    }
    s.retry = null;
    setRunning(s, false);
    emit(s, { kind: 'exit', code, signal: signal || null });
    // נפילה בלי result — אם ראינו רמז למכסה, זה המקום היחיד שבו נתפוס אותה
    if ((code || signal) && s.limitHint) onLimitHit(s, s.limitHint, s.turnProduced).catch(() => {});
  });

  child.on('error', (err) => {
    if (gen !== s.gen) return;
    dbg('cli.spawn_error', { convId: s.id, msg: err.message });
    emit(s, { kind: 'error', text: 'שגיאת תהליך: ' + err.message });
  });

  return true;
}

/* ==========================================================================
   שרשור פרומפטים
   --------------------------------------------------------------------------
   התור יושב בשרת ולא בדפדפן, מאותה סיבה שהתהליך יושב בשרת: אפשר לשלוח שלושה
   פרומפטים מהטלפון, לנעול אותו, והם ירוצו אחד אחרי השני. הוא גם משותף לכל
   המכשירים — מה שהוספת במחשב נראה בטלפון ולהפך — ושורד רענון דף וניתוק רשת.
   ========================================================================== */

/** משגר תור אחד ל-CLI. משותף לשליחה ידנית, לשיגור מהתור ולהמשך אחרי מכסה. */
function runTurn(s, msg, ws) {
  // רשת ביטחון: כל הודעה נושאת את הבוררים הנוכחיים, כך שגם אם השינוי לא
  // הגיע כ-set_model (מכשיר שהיה מנותק, לקוח ישן) הוא נתפס כאן.
  if (s.child) applyModelChange(s, msg.model, msg.effort);
  // אותה רשת ביטחון למצב ההרשאות, אצל Cursor בלבד: שם הוא דגל הרצה שנקבע
  // בתור הבא ממילא, והשליחה חינם. ל-Claude זו בקשת בקרה אמיתית ל-CLI, ולכן
  // היא נשארת רק כשהמשתמש באמת שינה את הבורר.
  if (s.child && msg.permissionMode && transportOf(msg.model) === 'cursor') {
    writeStdin(s, { type: 'control_request', request_id: 'spm-' + Date.now().toString(36), request: { subtype: 'set_permission_mode', mode: msg.permissionMode } });
  }
  // שינוי שדורש הפעלה מחדש — הרגע הנכון הוא כאן, כשהתור הקודם כבר הסתיים
  // והתמליל כתוב לדיסק, ולכן ה---resume ימשיך בדיוק מאותה נקודה.
  if (s.child && s.pendingRestart && !s.running && !s.anon) killChild(s);
  if (!s.child) {
    // התהליך של שיחה אנונימית *הוא* הזיכרון שלה. אם הוא כבר לא כאן והיו בה
    // תורות — ההקשר איננו, ואומרים את זה מיד ולא נותנים למודל לענות כאילו
    // הוא זוכר משהו שאינו אצלו.
    if (s.anon && s.seq > 0) toastSession(s, 'התהליך האנונימי נסגר — ההקשר הקודם נמחק, השיחה ממשיכה מכאן', true);
    const ok = startChild(s, {
      cwd: msg.cwd, model: msg.model, effort: msg.effort,
      permissionMode: msg.permissionMode,
      // בצ'אט אנונימי הכלים כבויים כברירת מחדל: Bash ו-Edit משאירים עקבות
      // (קבצים, גיבויי file-history, תמונות shell) שאינן בשליטת המצב הזה.
      noTools: s.anon ? !msg.tools : !!msg.noTools,
      // הלקוח מחזיק את המזהה המעודכן (כולל אחרי חזרה לנקודה קודמת), ומה
      // שנתפס מהזרם הוא הגיבוי למקרה שהוא לא נשלח. באנונימי — לעולם לא.
      resume: s.anon ? null : (msg.resumeSessionId || s.cliSessionId),
    });
    if (!ok) return false;
  }
  // המכשיר שממנו שלחת הוא זה שכותב לדיסק מכאן והלאה
  if (ws) setPrimary(s, ws); else ensurePrimary(s);

  // תור חדש מתחיל: היומן מתאפס כך שהוא מחזיק תמיד את התור הנוכחי מתחילתו.
  // זה מה שמאפשר למכשיר שנכנס באמצע לקבל את התור השלם, ולא רק את סופו.
  //
  // התנאי הוא הכלל שעליו נשענת ההשלמה: היומן = מה שעדיין לא נכתב לדיסק.
  // איפוסו חוקי רק כי מכשיר מחובר כתב את התור הקודם. בשרשרת שרצה כשאף מכשיר
  // לא מחובר אין מי שיכתוב, ולכן היומן ממשיך לצבור — אחרת התור הקודם היה
  // נעלם משני המקומות גם יחד.
  if (s.subs.size) s.log.length = 0;

  // ההודעה משודרת לכל המכשירים לפני שהיא נכנסת ל-CLI, וכל מכשיר מרנדר
  // אותה מהשידור — כולל השולח. מסלול רינדור אחד = אותה תוצאה בכל מסך.
  emit(s, {
    kind: 'user_msg', text: msg.text || '', nonce: msg.nonce || null,
    atts: Array.isArray(msg.atts) ? msg.atts.slice(0, 20) : [],
  });

  // תמונות מצורפות נשלחות כבלוקי image (base64) — המודל רואה אותן ישירות,
  // בלי צורך בכלי Read ובלי הרשאות קריאה לנתיב שמחוץ לתיקיית העבודה.
  const imgs = Array.isArray(msg.images) ? msg.images.filter((i) => i && i.data) : [];
  let content;
  if (imgs.length) {
    content = [];
    if (msg.text) content.push({ type: 'text', text: msg.text });
    for (const im of imgs) content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type || 'image/png', data: im.data } });
  } else {
    content = msg.text;
  }
  const payload = { type: 'user', message: { role: 'user', content } };
  if (s.lastRun) s.lastRun.payload = payload;
  if (!writeStdin(s, payload)) return false;
  setRunning(s, true);
  s.turnProduced = false;
  s.haltSent = false;
  s.retry = null;
  s.limitHint = '';
  // מה שנשמר כאן הוא מה שיאפשר להמשיך את העבודה אחרי שהמכסה תתחדש. בלי
  // התמונות: הן כבדות, והן כבר בהקשר של הסשן שאליו נעשה resume.
  s.lastTurn = { ...stripImages(msg), nonce: null };
  return true;
}

const imgBytes = (msg) =>
  (Array.isArray(msg && msg.images) ? msg.images : []).reduce((n, i) => n + String((i && i.data) || '').length, 0);
const stripImages = (msg) => { const { images, ...rest } = msg || {}; return rest; };

/** תיאור התור ללקוחות — בלי ה-base64 של התמונות, שאין לו מה לעשות על המסך. */
function queueView(s) {
  return s.queue.map((q) => ({
    id: q.id,
    text: q.msg.text || '',
    atts: Array.isArray(q.msg.atts) ? q.msg.atts : [],
    images: (q.msg.images || []).length,
    by: q.by || null,
  }));
}
function broadcastQueue(s) {
  // לא דרך emit: התור אינו חלק מהתמליל, והוא היה נמחק בכל איפוס יומן
  const raw = JSON.stringify({ kind: 'queue', convId: s.id, items: queueView(s) });
  for (const ws of s.subs) if (ws.readyState === ws.OPEN) { try { ws.send(raw); } catch {} }
  saveResumeState();
}

function enqueueTurn(s, msg, ws) {
  if (!(msg.text || '').trim() && !(msg.images || []).length) return;
  if (s.queue.length >= MAX_QUEUE) {
    sendTo(ws, { kind: 'toast', text: `התור מלא (${MAX_QUEUE} פרומפטים)`, err: true });
    return;
  }
  // תמונות בתור יושבות בזיכרון עד השיגור — לכן תקרה על הסך הכולל
  const pending = s.queue.reduce((n, q) => n + imgBytes(q.msg), 0);
  const msgOk = pending + imgBytes(msg) <= MAX_QUEUE_BYTES ? msg : stripImages(msg);
  if (msgOk !== msg) sendTo(ws, { kind: 'toast', text: 'התמונות לא נכנסו לתור — נשלח הטקסט בלבד', err: true });
  s.queue.push({ id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), msg: msgOk, by: ws ? ws._device : null });
  s.lastUsed = Date.now();
  broadcastQueue(s);
  // הגיע פרומפט לתור בזמן שהשיחה כבר פנויה (מירוץ בין סיום התור לשליחה) —
  // מנקזים מיד כדי שהוא לא ייתקע שם עד ההודעה הבאה.
  if (!s.running && !s.limit) drainQueue(s);
}

/** מבטל את כל מה שממתין — התור וגם המתנה לחידוש מכסה. */
function cancelChain(s, why) {
  const n = s.queue.length;
  const hadLimit = !!s.limit;
  if (!n && !hadLimit) return;
  s.queue = [];
  s.limit = null;
  broadcastQueue(s);
  if (hadLimit) broadcastLimit(s);
  if (why && n) {
    const raw = JSON.stringify({ kind: 'toast', text: `${why} (${n} פרומפטים)` });
    for (const c of s.subs) if (c.readyState === c.OPEN) { try { c.send(raw); } catch {} }
  }
}

/** משגר את הפרומפט הבא בתור, אם יש כזה ואם השיחה פנויה. */
function drainQueue(s) {
  // limitChecking הוא הקריטי: בין הרגע שראינו שגיאת מכסה לרגע שהסיווג חוזר
  // מה-API אסור לשגר כלום. בלעדיו הפרומפט הבא היה נורה אל תוך אותו קיר בדיוק,
  // נשרף, וגם היה מבטל את הזיהוי עצמו (התהליך החדש מקדם את gen).
  if (s.running || s.limit || s.limitChecking || !s.queue.length) return;
  const item = s.queue.shift();
  broadcastQueue(s);
  // מזהה הסשן מתקדם עם כל תור; מה שהלקוח שלח כשהפרומפט נכנס לתור כבר לא עדכני
  if (!runTurn(s, { ...item.msg, resumeSessionId: s.cliSessionId || item.msg.resumeSessionId }, null)) {
    emit(s, { kind: 'error', text: 'שיגור הפרומפט מהתור נכשל' });
  }
}

/* ==========================================================================
   מצב דואט
   --------------------------------------------------------------------------
   הרַכָּז יושב ב-duet.js ומקבל מכאן את אותם פרימיטיבים שמריצים שיחה רגילה —
   אותה הפעלת CLI, אותו זרם, אותו אחסון. מה שהוא מוסיף מעליהם הוא סדר התורות
   בין שני המשתתפים והפיקוח שביניהם, ולא ערוץ הרצה שני מקביל.
   ========================================================================== */
const duet = require('./duet')({
  sessions, newSession, startChild, killChild, writeStdin, emit, setRunning,
  readConv, writeConv, convMeta, broadcastAll, dbg,
});

// גוף של גרסה קודמת נמשך רק כשבוחרים בה בבורר הגרסאות — ולא נשלח בכל סנכרון
app.get('/api/duet/:id/version/:v', (req, res) => {
  const id = req.params.id;
  if (!VALID_ID.test(id)) return res.status(400).json({ ok: false });
  const text = duet.versionText(id, req.params.v);
  if (text == null) return res.status(404).json({ ok: false });
  res.json({ ok: true, v: Number(req.params.v), text });
});

/* ==========================================================================
   מכסת סשן: זיהוי עצירה והמשך אוטומטי
   --------------------------------------------------------------------------
   כשתור נעצר באמצע העבודה בגלל שנגמרה מכסת *הסשן* (חלון חמש השעות), אין שום
   סיבה שתשב מול המסך ותחכה. מזהים את העצירה, קוראים מ-/api/oauth/usage מתי
   החלון מתאפס, וברגע שהוא מתאפס מפעילים את התהליך מחדש עם --resume — כלומר
   באותו הקשר בדיוק — ומבקשים להמשיך מהנקודה שבה נעצר.
   שתי הגבלות מכוונות:
   1. רק חלון הסשן. אם מה שנגמר הוא החלון השבועי, המתנה של חמש שעות לא תעזור
      ובוודאי שאין להתחיל לעבוד לבד בעוד שבוע — אז רק מדווחים ולא מתזמנים.
   2. המצב נשמר לדיסק. הפעלה מחדש של השרת באמצע ההמתנה לא מאבדת את ההמשך.
   ========================================================================== */

const LIMIT_PCT = 95;                       // ממנו והלאה החלון נחשב "נגמר"
const RESUME_GRACE_MS = 45 * 1000;          // רגע אחרי האיפוס, לא בדיוק עליו
const RESUME_MAX_WAIT_MS = 6 * 60 * 60 * 1000; // חלון סשן ארוך מזה = לא סשן
const RESUME_FILE = path.join(STORE_DIR, 'pending-resume.json');

// הטקסטים שבהם ה-CLI וה-API מדווחים על מיצוי מכסה. נבדקים *רק* על ערוצי
// שגיאה (stderr, result שנכשל) ולא על תשובת המודל — אחרת תשובה שמסבירה מה זה
// rate limit הייתה מפילה את השיחה להמתנה של חמש שעות.
const LIMIT_RE = /(usage limit reached|rate[_\s-]?limit|limit will reset|exceeded your .{0,30}quota|out of (?:free )?usage|insufficient quota|429)/i;

const toMs = (iso) => { const t = Date.parse(iso || ''); return isNaN(t) ? 0 : t; };

/** חילוץ שעת איפוס מתוך הודעת השגיאה עצמה — גיבוי כשאין נתוני מכסה חיים. */
function parseResetFromText(text) {
  const t = String(text || '');
  // "Claude AI usage limit reached|1754812800" — חותם זמן יוניקס בשניות
  const epoch = t.match(/\b(1[6-9]\d{8})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const iso = t.match(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/);
  if (iso) return toMs(iso[0]);
  return 0;
}

/**
 * האם מה שנגמר הוא חלון הסשן — ומתי הוא מתאפס.
 * נשען על אותו endpoint שמזין את מדדי המכסה בממשק, כדי שההחלטה תתבסס על
 * המספרים האמיתיים ולא רק על ניחוש מתוך טקסט השגיאה.
 */
async function classifyLimit(errText) {
  const u = (await fetchUsage()) || usageCache.data || null;
  const windows = (u && u.windows) || [];
  const session = windows.find((w) => w.kind === 'session') || null;
  const weeklyHot = windows.some((w) => w.kind !== 'session' && typeof w.pct === 'number' && w.pct >= LIMIT_PCT);
  const sessionHot = !!(session && typeof session.pct === 'number' && session.pct >= LIMIT_PCT);
  const fromText = parseResetFromText(errText);

  // חלון שבועי שנגמר גובר: איפוס הסשן לא ישחרר אותו, ולכן אין מה לתזמן
  if (weeklyHot) {
    const weekly = windows.find((w) => w.kind !== 'session' && w.pct >= LIMIT_PCT);
    return { kind: 'weekly', resetsAt: toMs(weekly && weekly.resets_at) || 0 };
  }
  if (sessionHot) {
    return { kind: 'session', resetsAt: toMs(session.resets_at) || fromText || Date.now() + 5 * 3600 * 1000 };
  }
  // אין נתוני מכסה (טוקן שפג, אין רשת): נשענים על שעת האיפוס שבשגיאה. בטווח
  // של חלון סשן — סשן. שעה שכבר עברה היא סשן שבשל, לא מגבלה שבועית.
  if (fromText && fromText - Date.now() <= RESUME_MAX_WAIT_MS) return { kind: 'session', resetsAt: fromText };
  return { kind: fromText ? 'weekly' : 'unknown', resetsAt: fromText };
}

function broadcastLimit(s) {
  const raw = JSON.stringify({
    kind: 'limit', convId: s.id,
    limit: s.limit ? { kind: s.limit.kind, resetsAt: s.limit.resetsAt, at: s.limit.at, text: s.limit.text } : null,
  });
  for (const ws of s.subs) if (ws.readyState === ws.OPEN) { try { ws.send(raw); } catch {} }
}

/**
 * נקרא כשתור נכשל עם טקסט שנראה כמו מיצוי מכסה.
 * produced = האם התור הספיק להוציא פלט; נקבע כאן ולא אחר כך, כי עד שהבדיקה
 * מול ה-API חוזרת התהליך כבר עשוי להיות באמצע תור אחר.
 */
async function onLimitHit(s, text, produced) {
  if (s.limit || s.limitChecking) return;
  // שחקן בדואט לא נכנס למנגנון ההמתנה-והמשך של שיחה רגילה: ההמשך שם משגר את
  // הפרומפט הקודם כטקסט חופשי, וזה בדיוק מה ששובר את פרוטוקול התוצר. במקום זה
  // הריצה נעצרת עם שגיאה גלויה וכפתור "נסה שוב".
  if (s.duetRole) { emit(s, { kind: 'limit_stop', text: String(text || '').slice(0, 300) }); return; }
  s.limitChecking = true;   // מקפיא את התור עד שתיפול החלטה (ראו drainQueue)
  const gen = s.gen;
  let cls = null;
  try { cls = await classifyLimit(text); } catch {}
  s.limitChecking = false;
  // gen לבדו הוא המדד ל"בינתיים התחיל תור אחר": הוא עולה בכל הפעלה והריגה של
  // תהליך. הסתמכות על s.running הפילה את הזיהוי במרוץ — הבדיקה מול ה-API
  // חוזרת מהר יותר מאירוע ה-exit של התהליך, והדגל עוד היה דלוק.
  if (gen !== s.gen || s.limit) return;

  if (cls && cls.kind === 'session') {
    s.limit = { kind: 'session', resetsAt: cls.resetsAt, at: Date.now(), produced: !!produced, text: String(text || '').slice(0, 300) };
    killChild(s);   // אין טעם להחזיק תהליך שממתין חמש שעות; ה---resume יחזיר אותו
    saveResumeState();
    broadcastLimit(s);
    return;
  }

  if (cls && cls.kind === 'weekly') {
    // המתנה לא תעזור כאן, ולכן גם אין המשך אוטומטי — אבל בוודאי שלא נשגר את
    // שאר התור אל תוך אותה מגבלה.
    emit(s, { kind: 'limit_info', scope: 'weekly', resetsAt: cls.resetsAt || null });
    return;
  }

  // נראה כמו מגבלה אבל לא הצלחנו לאשר מול המכסה. עוצרים את השרשרת ומשאירים
  // אותה שלמה: לשגר עכשיו זה לשרוף את כל הפרומפטים על אותה שגיאה בדיוק.
  // שליחת פרומפט חדש תחזיר את השרשרת לתנועה.
  if (s.queue.length) emit(s, { kind: 'limit_info', scope: 'unknown', resetsAt: null });
  else drainQueue(s);
}

/**
 * ההמשך עצמו: מפעילים מחדש על אותו סשן ומבקשים להשלים את מה שנקטע.
 * מבקשים "המשך" ולא שולחים את הפרומפט המקורי שוב, כדי שהעבודה שכבר בוצעה לפני
 * העצירה לא תיעשה פעמיים — היא נמצאת בהקשר שה---resume מחזיר.
 */
function resumeAfterLimit(s, manual) {
  const lim = s.limit;
  if (!lim) return;
  const base = s.lastTurn || {};
  s.limit = null;
  saveResumeState();
  broadcastLimit(s);

  const original = String(base.text || '').slice(0, 800);
  const text = lim.produced === false
    ? original || 'המשך מהנקודה שבה נעצרת.'
    : 'מכסת הסשן התחדשה. המשך בדיוק מהנקודה שבה נעצרת והשלם את המשימה, בלי לחזור על עבודה שכבר ביצעת.'
      + (original ? `\n\nהמשימה המקורית הייתה:\n${original}` : '');

  emit(s, { kind: 'limit_resumed', manual: !!manual });
  const ok = runTurn(s, { ...base, text, images: [], atts: [], resumeSessionId: s.cliSessionId || base.resumeSessionId }, null);
  if (!ok) emit(s, { kind: 'error', text: 'ההמשך האוטומטי נכשל — נסה לשלוח שוב' });
}

/**
 * הדופק של ההמתנה. נבדק גם מול השעון וגם מול המכסה בפועל: אם המונה ירד לפני
 * שעת האיפוס המשוערת (או שהיא הייתה ניחוש), ממשיכים כבר עכשיו.
 */
async function limitTick() {
  const armed = [...sessions.values()].filter((s) => s.limit);
  if (!armed.length) return;
  const now = Date.now();
  // רוב ההמתנה היא שעות שבהן אין מה לבדוק — מושכים את המכסה בפועל רק כשמתקרבים
  // לשעת האיפוס. אחרת זו קריאת API כל דקה במשך חמש שעות, על לא דבר.
  const near = armed.some((s) => now >= s.limit.resetsAt - 10 * 60 * 1000);
  let sessionPct = null;
  if (near) {
    const u = (await fetchUsage()) || usageCache.data || null;
    const w = u && (u.windows || []).find((x) => x.kind === 'session');
    if (w && typeof w.pct === 'number') sessionPct = w.pct;
  }
  for (const s of armed) {
    if (s.running || !s.limit) continue;
    const due = now >= s.limit.resetsAt + RESUME_GRACE_MS;
    const freed = sessionPct != null && sessionPct < 80;
    if (due || freed) resumeAfterLimit(s, false);
  }
}
setInterval(() => { limitTick().catch(() => {}); }, 60 * 1000).unref?.();

/* ---------- שמירת ההמתנה לדיסק ---------- */
// הפעלה מחדש של השרת באמצע המתנה של חמש שעות לא אמורה לאבד את ההמשך ואת
// הפרומפטים שממתינים בתור. התמונות לא נשמרות — הן כבדות מכדי להצדיק זאת.
function saveResumeState() {
  try {
    const out = [];
    for (const s of sessions.values()) {
      // צ'אט אנונימי לא שורד הפעלה מחדש של השרת — זו התכונה, לא התקלה.
      if (s.anon) continue;
      if (!s.limit && !s.queue.length) continue;
      out.push({
        convId: s.id,
        cliSessionId: s.cliSessionId,
        limit: s.limit,
        lastTurn: s.lastTurn,
        queue: s.queue.map((q) => ({ id: q.id, by: q.by, msg: stripImages(q.msg) })),
      });
    }
    if (!out.length) { try { fs.unlinkSync(RESUME_FILE); } catch {} return; }
    fs.writeFileSync(RESUME_FILE, JSON.stringify(out));
  } catch {}
}
function loadResumeState() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(saved)) return;
  for (const rec of saved) {
    if (!rec || !VALID_ID.test(String(rec.convId || '')) || isAnonId(rec.convId)) continue;
    // המתנה שכבר איבדה את הטעם שלה (עבר יותר מחלון סשן שלם) לא מוחזרת
    if (rec.limit && Date.now() > rec.limit.resetsAt + RESUME_MAX_WAIT_MS) continue;
    const s = getSession(rec.convId);
    s.cliSessionId = rec.cliSessionId || null;
    s.limit = rec.limit || null;
    s.lastTurn = rec.lastTurn || null;
    s.queue = Array.isArray(rec.queue) ? rec.queue.filter((q) => q && q.msg) : [];
    s.lastUsed = Date.now();
  }
}

/* ---------- מנויים ---------- */

function unsubscribe(ws) {
  dropLag(ws);
  const s = ws._sess;
  if (!s) return;
  s.subs.delete(ws);
  s.lastUsed = Date.now();
  // מעבר לשיחה אחרת אינו יציאה מהצ'אט האנונימי: הדף עדיין פתוח והפינג שלו
  // ימשיך להחזיק אותו. הספירה לאפס מתחילה כאן ונעצרת בפינג הבא.
  if (s.anon) s.anonSeen = Date.now();
  ws._sess = null;
  if (s.primary === ws) s.primary = null;   // הבא בתור יקבל את תפקיד הכותב
  broadcastPresence(s);
}

/**
 * מחבר קליינט לשיחה. אם היומן עדיין מכיל את מה שהוא החמיץ — שולחים רק את
 * הדלתא (mode: 'catchup'), והמסך שלו ממשיך בדיוק מאיפה שנקטע. אחרת מבקשים
 * ממנו לקרוא את השיחה מהדיסק ולהתחיל זרם נקי (mode: 'reset').
 */
function subscribe(ws, convId, sinceSeq) {
  if (!VALID_ID.test(String(convId || ''))) return;
  if (ws._sess && ws._sess.id === convId) {
    // כבר מנוי — רק השלמה אחרי ניתוק רשת קצר
  } else {
    unsubscribe(ws);
  }
  const s = getSession(convId);
  s.subs.add(ws);
  s.lastUsed = Date.now();
  if (s.anon) s.anonSeen = Date.now();
  ws._sess = s;

  // ‎convMetaCached‎ ולא קריאה ישירה: זה נקרא בכל מנוי, והמטמון לפי mtime מונע
  // פענוח של קובץ שיחה שלם רק כדי לגלות שהיא לא ריצת דואט.
  // שיחה אנונימית אינה בדיסק, ואין טעם (ואין רשות) לחפש אותה שם: לא מטא-נתונים
  // ולא ריצת דואט. קריאה כזו הייתה רק פנייה מיותרת לאחסון בשם שיחה שאינה שם.
  const dmeta = s.anon ? null : convMetaCached(convId);
  const duetState = (!s.anon && (duet.has(convId) || (dmeta && dmeta.mode === 'duet'))) ? duet.snapshot(convId) : null;

  const since = Number(sinceSeq) || 0;
  const oldest = s.log.length ? s.log[0].seq : s.seq + 1;
  const canCatchUp = since > 0 && since >= oldest - 1 && since <= s.seq;
  dbg('subscribe', {
    convId, device: ws._device, since, seq: s.seq, oldest,
    mode: canCatchUp ? 'catchup' : 'reset',
    frames: canCatchUp ? s.log.filter((f) => f.seq > since).length : s.log.length,
    subs: s.subs.size, running: !!s.running,
  });

  sendTo(ws, {
    kind: 'sync',
    convId,
    seq: s.seq,
    mode: canCatchUp ? 'catchup' : 'reset',
    running: s.running,
    // המודל שהשיחה הזו באמת רצה איתו. מכשיר שמתחבר עכשיו מסתנכרן אליו במקום
    // לדחוף את ברירת המחדל שלו — אחרת פתיחת הטלפון הייתה מחליפה בשקט את
    // המודל של תור שרץ במחשב.
    ...(s.child ? { model: s.liveModel || '', effort: s.liveEffort || '' } : {}),
    // כרטיסים פתוחים — כדי שהמכשיר החדש יוכל לענות עליהם מיד
    perms: [...s.pendingPerms].map(([id, req]) => ({ id, req })),
    dialogs: [...s.pendingDialogs].map(([id, d]) => ({ id, req: d.req })),
    // התור וההמתנה למכסה חיים בשרת, ולכן מכשיר שנפתח עכשיו רואה אותם מיד
    queue: queueView(s),
    limit: s.limit ? { kind: s.limit.kind, resetsAt: s.limit.resetsAt, at: s.limit.at, text: s.limit.text } : null,
    // ניסיון חוזר שנמצא באוויר עכשיו. בלעדיו טלפון שמתחבר באמצע ניסיון חוזר
    // רואה תור "עובד" ששותק דקה שלמה, בלי לדעת שיש סיבה ושהיא מוכרת.
    retry: s.running && s.retry ? s.retry : null,
    // ריצת דואט חיה בשרת. מכשיר שנפתח עכשיו מקבל את מצבה המלא ולא מסך ריק,
    // ומיד אחריו את פריימי התור שרץ ברגע זה מהיומן.
    duet: duetState,
  });
  if (canCatchUp) {
    replayLog(ws, s, since);
  } else {
    // מכשיר חדש שנכנס באמצע תור. הדיסק מחזיק את מה שכבר הסתיים, והיומן מחזיק
    // את התור הרץ מתחילתו — יחד זו התמונה המלאה. בלי המשלוח הזה הטלפון היה
    // נפתח באמצע תור ורואה שיחה שנעצרה בתור הקודם.
    replayLog(ws, s, 0);
  }
  broadcastPresence(s);
}

/**
 * מי כותב את השיחה לדיסק.
 * שני המכשירים בונים את אותו תמליל מאותו זרם, ולכן אין טעם ששניהם יכתבו —
 * זה רק היה גורם לכל כתיבה לדחות את זו של השני (409) ולאלץ טעינה מחדש באמצע
 * סטרימינג. לכן כותב אחד בכל רגע: זה שממנו שלחת אחרון, ואם הוא מתנתק —
 * הבא בתור. בדיקת הגרסה נשארת כרשת ביטחון למקרי קצה.
 */
function setPrimary(s, ws) {
  if (s.primary === ws) return;
  s.primary = ws;
  broadcastPresence(s);
}
function ensurePrimary(s) {
  if (s.primary && s.subs.has(s.primary)) return;
  s.primary = s.subs.values().next().value || null;
}

/** כמה מכשירים צופים כרגע — מוצג בסרגל כדי שתדע שהטלפון מחובר. */
function broadcastPresence(s) {
  ensurePrimary(s);
  const devices = [...s.subs].map((c) => c._device || 'מכשיר');
  for (const ws of s.subs) {
    sendTo(ws, { kind: 'presence', convId: s.id, count: s.subs.size, devices, primary: ws === s.primary });
  }
}

/** שדה ממשק (בורר, טיוטה, כותרת) → לשאר המכשירים בלבד; לא נכנס ליומן ההשלמה. */
function relayUi(s, from, field, value) {
  const raw = JSON.stringify({ kind: 'ui', convId: s.id, field, value, by: from._device });
  for (const other of s.subs) if (other !== from && other.readyState === other.OPEN) { try { other.send(raw); } catch {} }
}

/** שם ידידותי למכשיר, לצורך חיווי "מי מחובר" ולא לאבטחה. */
function deviceLabel(req) {
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'מכשיר';
}

function handleConnection(ws, req) {
  ws._sess = null;
  ws._device = deviceLabel(req);
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
  allClients.add(ws);
  dbg('ws.open', { device: ws._device, clients: allClients.size });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'subscribe') { subscribe(ws, msg.conversationId, msg.sinceSeq); return; }
    // בדיקת חיות של ה-socket עצמו. מענה שלא חוזר הוא הראיה שהחיבור מת בשקט,
    // ואז הלקוח סוגר ומתחבר מחדש במקום להמשיך להמתין לפריים שלא יגיע לעולם.
    if (msg.type === 'ping') {
      // הפינג הוא גם "אני עדיין כאן" עבור הצ'אטים האנונימיים הפתוחים בדפדפן
      // הזה — גם כשהמנוי הפעיל הוא שיחה אחרת לגמרי. ראו sweepAnon.
      if (Array.isArray(msg.anon)) {
        const now = Date.now();
        for (const id of msg.anon.slice(0, 8)) {
          const a = isAnonId(id) && sessions.get(id);
          if (a) a.anonSeen = now;
        }
      }
      sendTo(ws, { kind: 'pong', t: msg.t });
      return;
    }

    // יציאה מפורשת מצ'אט אנונימי: הורג את התהליך ומוחק את כל מה שנשאר בשרת.
    // לא דורש להיות מנוי על השיחה — הדפדפן שולח את זה גם ברגע סגירת החלון.
    if (msg.type === 'anon_end') {
      const a = isAnonId(msg.conversationId) && sessions.get(msg.conversationId);
      if (a) destroyAnon(a);
      return;
    }

    const s = ws._sess;
    if (!s) return;

    if (msg.type === 'user') {
      runTurn(s, msg, ws);

    } else if (msg.type === 'queue_add') {
      enqueueTurn(s, msg, ws);

    } else if (msg.type === 'queue_remove') {
      s.queue = s.queue.filter((q) => q.id !== msg.id);
      broadcastQueue(s);

    } else if (msg.type === 'queue_clear') {
      if (!s.queue.length) return;
      s.queue = [];
      broadcastQueue(s);

    } else if (msg.type === 'limit_resume_now') {
      // "המשך עכשיו" — המשתמש לא רוצה לחכות לשעון (למשל אחרי שדרוג תוכנית)
      if (s.limit) resumeAfterLimit(s, true);

    } else if (msg.type === 'limit_cancel') {
      if (!s.limit) return;
      s.limit = null;
      saveResumeState();
      broadcastLimit(s);

    } else if (msg.type === 'permission') {
      answerPermission(s, msg, ws._device);

    } else if (msg.type === 'dialog') {
      // תשובת המשתמש לבקשת control שאיננו מכירים מראש
      if (!msg.requestId) return;
      const d = s.pendingDialogs.get(msg.requestId);
      if (!d) return;
      clearTimeout(d.timer);
      s.pendingDialogs.delete(msg.requestId);
      emit(s, { kind: 'dialog_resolved', id: msg.requestId, by: ws._device });
      if (!s.child) return;
      writeStdin(s, msg.error
        ? { type: 'control_response', response: { subtype: 'error', request_id: msg.requestId, error: msg.error } }
        : { type: 'control_response', response: { subtype: 'success', request_id: msg.requestId, response: msg.response || {} } });

    } else if (msg.type === 'set_permission_mode') {
      if (!msg.mode) return;
      // הדגל נקבע גם בלי תהליך רץ: הוא מה שיקבע איך ייענו הבקשות הבאות.
      s.god = isGodMode(msg.mode);
      if (s.god) godFlushPending(s);
      if (!s.child) return;
      writeStdin(s, { type: 'control_request', request_id: 'spm-' + Date.now().toString(36), request: { subtype: 'set_permission_mode', mode: cliPermMode(msg.mode) } });
      emit(s, { kind: 'ui', field: 'permissionMode', value: msg.mode, by: ws._device });

    } else if (msg.type === 'set_model') {
      // החלפת מודל/מאמץ באמצע שיחה. הבחירה נרשמת גם כשאין תהליך רץ, כדי
      // שההרצה הבאה תיפתח איתה.
      applyModelChange(s, msg.model, msg.effort);
      relayUi(s, ws, 'model', msg.model || '');
      relayUi(s, ws, 'effort', msg.effort || '');

    } else if (msg.type === 'ui') {
      // מצב שאינו חלק מהתמליל (טיוטה, כותרת, תיקיית עבודה, מודל) — נשלח
      // למכשירים האחרים כדי שהמסכים יישארו זהים. לא נכנס ליומן ההשלמה.
      relayUi(s, ws, msg.field, msg.value);

    } else if (msg.type === 'interrupt') {
      // עצירה ידנית מבטלת גם את השרשרת: אחרת "עצור" היה משגר מיד את הפרומפט
      // הבא בתור, וזה ההפך הגמור ממה שלחצת עליו.
      cancelChain(s, 'עצרת — התור בוטל');
      if (s.child) s.child.kill('SIGINT');

    } else if (msg.type === 'duet_start') {
      const r = duet.start(s.id, msg.cfg || {});
      if (!r.ok) sendTo(ws, { kind: 'toast', text: r.error, err: true });

    } else if (msg.type === 'duet_pause') {
      duet.pause(s.id);

    } else if (msg.type === 'duet_resume') {
      duet.resume(s.id);

    } else if (msg.type === 'duet_stop') {
      duet.stop(s.id);

    } else if (msg.type === 'duet_note') {
      duet.note(s.id, msg.text);

    } else if (msg.type === 'duet_retry') {
      duet.retry(s.id);

    } else if (msg.type === 'end') {
      cancelChain(s, null);
      killChild(s);
      s.log.length = 0;
    }
  });

  // סגירת חיבור כבר לא הורגת את התהליך: תור שהתחלת במחשב ממשיך לרוץ גם
  // כשנעלת את הטלפון, ואתה חוזר ומוצא אותו במקום שבו הוא באמת נמצא.
  ws.on('close', (code) => {
    dbg('ws.close', { device: ws._device, code, convId: ws._sess ? ws._sess.id : null, clients: allClients.size - 1 });
    allClients.delete(ws);
    unsubscribe(ws);
  });
  ws.on('error', () => { allClients.delete(ws); unsubscribe(ws); });
}

/* פעימת לב מצד השרת. ה-ping שהלקוח שולח בודק רק את הכיוון שלו, ולכן טלפון
   שה-Wi-Fi שלו נרדם משאיר כאן socket פתוח לנצח: הוא נעלם בלי FIN, השרת לא
   מקבל close, והמכשיר נשאר רשום כמחובר. ping ברמת הפרוטוקול שאין עליו pong
   הוא ההוכחה שהחיבור מת — ואז סוגרים אותו במקום לצבור רפאים. */
const WS_PING_MS = 30000;
setInterval(() => {
  for (const ws of allClients) {
    if (ws._alive === false) {
      dbg('ws.stale', { device: ws._device, clients: allClients.size });
      allClients.delete(ws); unsubscribe(ws);
      try { ws.terminate(); } catch {}
      continue;
    }
    ws._alive = false;
    try { ws.ping(); } catch {}
  }
}, WS_PING_MS).unref?.();

// המתנות להמשך ופרומפטים בתור ששרדו את ההפעלה הקודמת. אם שעת האיפוס כבר
// עברה בזמן שהשרת היה כבוי — ממשיכים מיד ולא בעוד דקה.
loadResumeState();
setTimeout(() => { limitTick().catch(() => {}); }, 4000).unref?.();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  \x1b[1mממשק RTL ל-Claude Code\x1b[0m`);
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`  \x1b[36m${proto}://localhost:${PORT}\x1b[0m\n`);
});
