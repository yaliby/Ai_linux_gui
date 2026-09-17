'use strict';
/* ==========================================================================
   ממשק עברית ל-Claude Code — לוגיקת צד לקוח
   סטרימינג בזמן אמת · כרטיסי כלים · ריבוי שיחות · סרגל סטטוס
   ========================================================================== */

// ---------- כלי עזר ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));
// ארבע ספרות רק כשיש שם משהו לראות: ‎$0.0000‎ בשיחה חדשה נקרא כמו תקלה בפורמט
const fmtCost = (c) => { const n = Number(c) || 0; return '$' + n.toFixed(n > 0 && n < 0.01 ? 4 : 2); };
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n || 0);

/* ==========================================================================
   צ'אט אנונימי — הצד של הדפדפן
   --------------------------------------------------------------------------
   שיחה אנונימית נראית ומתנהגת כמו כל שיחה אחרת, וזה בדיוק הקושי: כל מסלול
   שמירה כאן מופעל אוטומטית (טיוטה, כותרת, היסטוריית פרומפטים, שמירה מושהית,
   sendBeacon בסגירה), ולכן ההגנה איננה "לא לקרוא לשמירה" אלא דחייה בכל אחת
   מנקודות הכתיבה בנפרד — ובגיבוי של דחייה מקבילה בשרת לפי המזהה.

   המזהה מתחיל ב-`anon-`, וזה מה שהשרת בודק. הדגל `anon` על אובייקט השיחה הוא
   מה שנבדק כאן. השניים תמיד נקבעים יחד, ב-newAnonConv בלבד.
   ========================================================================== */
/* שיחה ללא תיקייה: הסימן שנוסע בשדה cwd במקום נתיב. השרת פותר אותו לתיקייה
   ריקה ייעודית ומכבה את הכלים, ולכן כל מה שנשאר הוא שיחה עם המודל. הטקסט הוא
   גם מה שמוצג בשדה, וחייב להיות זהה לקבוע NO_DIR שבשרת. */
const NO_DIR = '(ללא תיקייה)';
const isNoDir = (v) => (v || '').trim() === NO_DIR;

const ANON_PREFIX = 'anon-';
const isAnonId = (id) => typeof id === 'string' && id.startsWith(ANON_PREFIX);
const isAnon = (c) => !!(c && c.anon);
/** השיחה האנונימית הפתוחה (יש לכל היותר אחת בכל רגע), או null. */
const anonConv = () => { try { return store.convs.find((c) => c.anon) || null; } catch { return null; } };

/* ==========================================================================
   יומן צד לקוח
   הקרוס־צ'ק, החיבור והציור קורים כאן — בטלפון, שם אין קונסולה לפתוח. השורות
   נאגרות ונשלחות בחבילות לשרת, שכותב אותן לאותו יומן שאליו הוא כותב את מה
   שהוא עצמו רואה. כך אפשר לקרוא בדיעבד מה בדיוק הבדיקה החליטה ולמה, במקום
   להסיק מ-toast שנעלם. שורה שלא הצליחה להישלח חוזרת לתור: דווקא היא, זו
   שנרשמה כשהרשת נפלה, היא המעניינת ביותר.
   ========================================================================== */
const LOG_Q_MAX = 400;
const logQ = [];
let logTimer = null;

// שעון מקומי בפורמט HH:MM:SS.mmm — זה מה שהשרת רושם בשורה, ליד השעה שבה הוא קיבל
const logNow = () => {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

/**
 * כל עוד יש צ'אט אנונימי פתוח — שום שורה לא נשלחת ליומן שבדיסק. לא רק שורות
 * שנוגעות בו: גם 'ws.close' או 'check.done' שנרשמו לצידו מספרות מתי ישבת מולו
 * וכמה זמן, וזו בדיוק העקבה שהמצב הזה בא למנוע. האבחון חוזר ברגע שיוצאים.
 */
function anonSilent(data) {
  if (data && typeof data === 'object' && (isAnonId(data.convId) || isAnonId(data.id))) return true;
  return !!anonConv();
}

function dlog(tag, data) {
  if (anonSilent(data)) return;
  logQ.push({ at: logNow(), tag, data });
  if (logQ.length > LOG_Q_MAX) logQ.splice(0, logQ.length - LOG_Q_MAX);
  if (!logTimer) logTimer = setTimeout(flushLog, 1500);
}

async function flushLog() {
  logTimer = null;
  if (!logQ.length) return;
  const rows = logQ.splice(0, logQ.length);
  try {
    const r = await fetch('/api/client-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }), keepalive: true,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch {
    logQ.unshift(...rows);
    if (logQ.length > LOG_Q_MAX) logQ.splice(0, logQ.length - LOG_Q_MAX);
  }
}

// הרגע שבו הדף עלול להיסגר או להיכנס ל-bfcache: fetch רגיל כבר לא מובטח שיישלח
addEventListener('pagehide', () => {
  if (!logQ.length) return;
  try {
    const body = new Blob([JSON.stringify({ rows: logQ })], { type: 'application/json' });
    if (navigator.sendBeacon('/api/client-log', body)) logQ.length = 0;
  } catch {}
});
addEventListener('error', (e) => dlog('js.error', {
  msg: String(e.message || e.type || ''), src: String(e.filename || '').split('/').pop(), line: e.lineno,
}));
addEventListener('unhandledrejection', (e) => dlog('js.reject', {
  msg: String((e.reason && (e.reason.stack || e.reason.message)) || e.reason || ''),
}));

// ---------- העתקה ללוח ----------
// navigator.clipboard קיים רק בהקשר מאובטח (https או localhost). בטלפון נכנסים
// לכאן דרך כתובת ה-LAN ב-http, ושם הוא פשוט undefined — כלומר כל כפתורי ההעתקה
// זרקו TypeError בתוך onclick ולא קרה כלום. execCommand מיושן, אבל הוא היחיד
// שעובד בהקשר לא מאובטח, ולכן הוא הנפילה לאחור ולא ההפך.
async function copyText(text) {
  if (!text) return false;
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  return legacyCopy(text);
}
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  // חייב להיות מצויר בפועל (לא display:none / visibility:hidden) כדי שתהיה בחירה
  // להעתיק. ‎16px‎ כדי ש-iOS לא יזנק זום בשבריר השנייה שהוא קיים.
  ta.style.cssText = 'position:fixed;top:50%;inset-inline-start:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;';
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const prev = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  let ok = false;
  // כל שלב בבחירה עטוף בנפרד: ב-iOS ‏select()‎ לבדו לא בוחר כלום ב-textarea וצריך
  // טווח על תוכן שניתן לעריכה, אבל אם דווקא setSelectionRange זורק שם — וזה קורה —
  // אסור שזה יבלע גם את execCommand עצמו, שהוא כל מטרת הפונקציה.
  try { ta.focus(); } catch {}
  try {
    ta.contentEditable = 'true';
    ta.readOnly = true;                    // מונע קפיצת מקלדת ב-iOS
    const range = document.createRange();
    range.selectNodeContents(ta);
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  } catch {}
  try { ta.setSelectionRange(0, text.length); } catch {}
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  if (sel) { sel.removeAllRanges(); if (prev) sel.addRange(prev); }
  return ok;
}

// ---------- שמש Claude ----------
/**
 * קרני השמש כ-path יחיד, בתוך ריבוע ‎size‎.
 *
 * ‎ro‎ הוא 0.442 ולא חצי: עם ‎stroke-linecap: round‎ הקצה המעוגל מוסיף עוד חצי
 * עובי-קו לכל צד, ובלי המרווח הזה הקרניים היו נחתכות על גבול ה-viewBox.
 * זהו הסימן של Claude ב-BRANDS, ולכן הוא חי כאן כגנרטור ולא כמחרוזת קפואה.
 */
function rayPath(size, n = 12, riR = 0.108, roR = 0.442) {
  const c = size / 2, ri = size * riR, ro = size * roR;
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x1 = c + Math.cos(a) * ri, y1 = c + Math.sin(a) * ri;
    const x2 = c + Math.cos(a) * ro, y2 = c + Math.sin(a) * ro;
    d += `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  return d;
}
const NAME = 'yali';
function greeting() {
  const h = new Date().getHours();
  const g = h < 5 ? 'עוד ערים' : h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : h < 21 ? 'ערב טוב' : 'לילה טוב';
  return `${g}, ${NAME}`;
}

/* ==========================================================================
   לוגואים לפי מודל
   --------------------------------------------------------------------------
   עד כאן לכל תשובה היה אותו אייקון — השמש של Claude — גם כשהתשובה נכתבה על-ידי
   Gemini, GPT או Grok. ברשימה של מאות מודלים משבעה שערים זה לא קישוט חסר: אחרי
   חצי שעה בשיחה כבר אי אפשר לזכור עם מי מדברים, והשם לבדו ("‎gemini-3-pro‎")
   נקרא בעין כמו עוד מחרוזת ולא כמו זהות.

   כל משפחת מודלים מקבלת כאן סימן משלה בצבע המותג שלה. הסימנים מצוירים כולם
   באותה שפה — ‎viewBox‎ אחיד של 24, קווים מעוגלים, משקל קו זהה — כדי שהם
   ייראו כמו סדרה אחת ולא כמו אוסף לוגואים מודבקים. בגודל של 20‑24 פיקסלים
   רק הצללית נקראת, ולכן כל סימן מצומצם לצורה המזהה שלו: הניצוץ של Gemini,
   הפריחה של OpenAI, הסהר של Kimi, הקובייה של Cursor. שני סימנים שנקראים אותו
   דבר בגודל הזה הם באג, לא עניין של טעם — לכן כמה מהם צוירו מחדש אחרי שראינו
   אותם מרונדרים זה לצד זה.

   הצבע מגיע כמשתנה CSS על האלמנט (‎--bm-l‎ בהיר, ‎--bm-d‎ כהה) ולא כערך קשיח
   בתוך ה-SVG — כך אותו סימן עובד בשני המצבים בלי לצייר אותו פעמיים. ראו
   ‎.bmark‎ ב-style.css.
   ========================================================================== */

const RAYS_24 = rayPath(24);

const FILL = ' fill="currentColor" stroke="none"';

/** מפתח → { label, fg, fgDark, sw, body }. ‎body‎ הוא תוכן ה-SVG בלבד. */
const BRANDS = {
  anthropic: {
    label: 'Anthropic', fg: '#c2603a', fgDark: '#d97757', sw: 1.75,
    body: `<path d="${RAYS_24}"/>`,
  },
  openai: {
    label: 'OpenAI', fg: '#0f8f72', fgDark: '#4cc5a4', sw: 1.7,
    // הקשר בעל שש-הקפלים. הניסיון הראשון היה משושה עם Y פנימי — והוא נקרא
    // כקובייה, כלומר בדיוק כמו הסימן של Cursor. שש עלים סביב מרכז משאירים את
    // הסימטריה השש-קפלית של הסימן המקורי ואי-אפשר לבלבל אותם עם גוף תלת-ממדי.
    body: [0, 60, 120, 180, 240, 300].map((a) =>
      `<ellipse cx="12" cy="7.9" rx="3" ry="5"${a ? ` transform="rotate(${a} 12 12)"` : ''}/>`).join(''),
  },
  gemini: {
    label: 'Google', fg: '#3a72e8', fgDark: '#7fa8f8', sw: 1.7,
    // הניצוץ ארבע-הקצוות — הסימן של Gemini עצמו
    body: `<path d="M12 2.6C12.92 7.58 16.42 11.08 21.4 12 16.42 12.92 12.92 16.42 12 21.4 11.08 16.42 7.58 12.92 2.6 12 7.58 11.08 11.08 7.58 12 2.6Z"${FILL}/>`,
  },
  gemma: {
    label: 'Gemma', fg: '#0f8f8a', fgDark: '#4fc9c3', sw: 1.7,
    // אבן חן — ‎gemma‎ היא «אבן טובה» בלטינית, וזה גם מה שמפריד אותה מ-Gemini
    body: '<path d="M7.2 4.2h9.6L21 9.6 12 20.4 3 9.6z"/>'
      + '<path d="M3 9.6h18M7.2 4.2 9.6 9.6 12 20.4 14.4 9.6 16.8 4.2"/>',
  },
  xai: {
    label: 'xAI', fg: '#1d1d1f', fgDark: '#e9e7e2', sw: 1.7,
    // ה-X השבור של xAI: אלכסון יורד שלם, ואלכסון עולה חתוך בנקודת החיתוך
    body: `<path d="M3.6 3h4.3l12.5 18h-4.3z"${FILL}/>`
      + `<path d="M20.4 3h-4.3l-2.9 4.2 2.15 3.1z"${FILL}/>`
      + `<path d="M3.6 21h4.3l2.9-4.2-2.15-3.1z"${FILL}/>`,
  },
  zai: {
    label: 'Z.ai', fg: '#4b4ddb', fgDark: '#9698f2', sw: 1.7,
    body: `<path d="M4.8 3.6h14.4v3.6L10.5 16.8h8.7v3.6H4.8v-3.6l8.7-9.6H4.8z"${FILL}/>`,
  },
  moonshot: {
    label: 'Moonshot', fg: '#2f4f9e', fgDark: '#8fb2e8', sw: 1.7,
    // סהר — הסימן של Kimi
    body: `<path d="M13.9 2.3A9.7 9.7 0 1 0 21.7 15.2 7.9 7.9 0 0 1 13.9 2.3Z"${FILL}/>`,
  },
  deepseek: {
    label: 'DeepSeek', fg: '#3c62f5', fgDark: '#8aa2fb', sw: 1.7,
    // לווייתן: גוף בשתי קשתות, סנפיר משולש ומדף זנב מפוצל
    body: `<path d="M3.6 13.4A12 12 0 0 1 17 10.6l4.6-3.8-2.2 4.8 2.2 4.8-4.6-3A11 11 0 0 1 3.6 13.4Z"${FILL}/>`
      + `<path d="M9 15.2h4l-2.8 3.6z"${FILL}/>`,
  },
  qwen: {
    label: 'Qwen', fg: '#7b3fd4', fgDark: '#b18bef', sw: 1.7,
    // Q — עיגול וזנב. הגרסה הקודמת הייתה משושה, וברשימה כבר יש קובייה משושה
    // (Cursor); באות אמיתית אין מה להתבלבל.
    body: '<circle cx="11.6" cy="11.4" r="7.6"/><path d="M14.4 14.2 19.6 19.4"/>',
  },
  meta: {
    label: 'Meta', fg: '#0a66f0', fgDark: '#6ba3fb', sw: 1.9,
    // לולאת האינסוף
    body: '<path d="M7.25 7.5c2.75 0 3.75 4.5 4.75 4.5s2-4.5 4.75-4.5c2.625 0 4.25 2 4.25 4.5s-1.625 4.5-4.25 4.5c-2.75 0-3.75-4.5-4.75-4.5s-2 4.5-4.75 4.5C4.625 16.5 3 14.5 3 12s1.625-4.5 4.25-4.5z"/>',
  },
  mistral: {
    label: 'Mistral', fg: '#e8590c', fgDark: '#ff9147', sw: 1.7,
    // M בנוי מרשת פיקסלים 5×5 — שפת הבלוקים של Mistral. הגרסה הקודמת הייתה
    // קורה עליונה מעל שלוש עמודות, וזה נקרא כשער טוריאי ולא כאות.
    body: [[3, 3, 3.6, 18], [17.4, 3, 3.6, 18], [6.6, 6.6, 3.6, 3.6],
      [13.8, 6.6, 3.6, 3.6], [10.2, 10.2, 3.6, 3.6]]
      .map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"${FILL}/>`).join(''),
  },
  nvidia: {
    label: 'NVIDIA', fg: '#5f9400', fgDark: '#9ed13a', sw: 1.7,
    // ה«עין» — ספירלה שנסגרת פנימה
    body: '<path d="M3.2 12c3-3.8 6.2-5.7 9.8-5.7 4.6 0 7.8 2.6 7.8 6.1 0 3.2-2.6 5.3-6.2 5.3-2.9 0-4.8-1.5-4.8-3.6 0-1.8 1.4-3 3.4-3 1.6 0 2.7.9 2.7 2.1 0 1-.7 1.7-1.7 1.7-.7 0-1.2-.4-1.2-1"/>',
  },
  minimax: {
    label: 'MiniMax', fg: '#d93b45', fgDark: '#f08a90', sw: 1.9,
    // שני שברונים — מינימום ומקסימום
    body: '<path d="M4 13.2 12 5.2l8 8M4 18.8 12 10.8l8 8"/>',
  },
  perplexity: {
    label: 'Perplexity', fg: '#1c7a86', fgDark: '#57c2cd', sw: 1.7,
    // מסך סונאר — על שם משפחת המודלים (Sonar). קשתות מדורגות היו נקראות כסמל
    // ה-Wi-Fi, ומסגרת משושה (הניסיון שלפניה) כמו ה-Q של Qwen; טבעות סגורות עם
    // אלומת סריקה אינן דומות לאף אחד משניהם.
    body: '<circle cx="12" cy="12" r="8.8"/><circle cx="12" cy="12" r="4.6"/>'
      + `<path d="M12 12 18.2 5.8 20.2 9.9Z"${FILL}/><circle cx="12" cy="12" r="1.5"${FILL}/>`,
  },
  cursor: {
    label: 'Cursor', fg: '#1f6f8b', fgDark: '#6bb9d6', sw: 1.7,
    // קובייה איזומטרית
    body: '<path d="M12 2.6 21 7.8v8.4L12 21.4 3 16.2V7.8z"/><path d="M12 12 21 7.8M12 12v9.4M12 12 3 7.8"/>',
  },
  auto: {
    label: 'ניתוב אוטומטי', fg: '#8256d0', fgDark: '#b596ea', sw: 1.7,
    body: '<path d="M2.8 7.8h3.9c1.7 0 2.6.8 3.6 2.3l2.2 3.4c1 1.5 1.9 2.3 3.6 2.3h3.1"/>'
      + '<path d="M2.8 16.2h3.9c1.7 0 2.6-.8 3.6-2.3l2.2-3.4c1-1.5 1.9-2.3 3.6-2.3h3.1"/>'
      + '<path d="M17.6 5.4 20.8 8.2l-3.2 2.8M17.6 13 20.8 15.8l-3.2 2.8"/>',
  },
  horde: {
    label: 'תמונות', fg: '#c07a1e', fgDark: '#e0b165', sw: 1.7,
    body: '<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2.6"/>'
      + '<path d="M4.6 17.4 10.2 11.4l3 3 3-3.6 3.2 3.8"/>'
      + `<circle cx="8.4" cy="9.2" r="1.5"${FILL}/>`,
  },
  veo: {
    label: 'וידאו', fg: '#c93b2c', fgDark: '#ef8f82', sw: 1.7,
    body: '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="3"/>'
      + `<path d="M10.4 9.2 15.6 12l-5.2 2.8z"${FILL}/>`,
  },
  felo: {
    label: 'חיפוש ברשת', fg: '#2a8a5f', fgDark: '#6ec79b', sw: 1.8,
    body: '<circle cx="10.6" cy="10.6" r="6.2"/><path d="M15.2 15.2 20.4 20.4"/>',
  },
  local: {
    label: 'מקומי', fg: '#5f6b78', fgDark: '#a3b0bd', sw: 1.7,
    body: '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2"/>'
      + '<rect x="10.2" y="10.2" width="3.6" height="3.6" rx="1"/>'
      + '<path d="M9.6 6.6V3.4M14.4 6.6V3.4M9.6 17.4v3.2M14.4 17.4v3.2'
      + 'M6.6 9.6H3.4M6.6 14.4H3.4M17.4 9.6h3.2M17.4 14.4h3.2"/>',
  },
  fallback: {
    label: 'מודל', fg: '#7a7468', fgDark: '#a8a294', sw: 1.7,
    body: '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="5.2"/>'
      + `<circle cx="12" cy="12" r="2.6"${FILL}/>`,
  },
};

/* קטגוריות השרת → מותג. הקבוצה שהשרת כבר חישב היא מקור האמת: היא בדיוק
   אותה הכרעה שקבעה איפה המודל יושב בבורר, ולכן הסימן והקטגוריה לעולם לא
   יסתרו זה את זה. */
const GROUP_BRAND = {
  'Claude · חיבור ישיר': 'anthropic',
  'Claude · דרך שערים': 'anthropic',
  'Gemini · Google': 'gemini',
  'GPT · OpenAI': 'openai',
  'Grok · xAI': 'xai',
  'GLM · Z.ai': 'zai',
  'Kimi · Moonshot': 'moonshot',
  DeepSeek: 'deepseek',
  'Qwen · Alibaba': 'qwen',
  'Llama · Meta': 'meta',
  'Gemma · Google': 'gemma',
  Mistral: 'mistral',
  'Nemotron · NVIDIA': 'nvidia',
  MiniMax: 'minimax',
  Perplexity: 'perplexity',
  'ניתוב אוטומטי': 'auto',
  'מודלים מקומיים': 'local',
  'חיפוש ברשת · Felo': 'felo',
  'תמונות · AI Horde': 'horde',
  'וידאו · Veo': 'veo',
};

/* גיבוי לפי שם, לאותם מקרים שבהם אין קבוצה: מודל של Cursor (שם הקבוצה היא
   הסוכן ולא המשפחה), ומודל ששמור בתמליל ישן וכבר לא ברשימה של היום. הסדר
   זהה ל-MODEL_FAMILIES בשרת — קודם Gemini, כדי ש-«gemini-claude-judge» לא
   ייחטף בדרך. */
const BRAND_RULES = [
  ['gemini', /gemini|nano-banana|lyria|imagen|antigravity/i],
  ['anthropic', /claude|opus|sonnet|haiku|fable/i],
  ['openai', /gpt|codex|(^|[-_/])o[1-4]($|[-_])/i],
  ['xai', /grok/i],
  ['zai', /glm|(^|[-_/])zai($|[-_])/i],
  ['moonshot', /kimi|moonshot/i],
  ['deepseek', /deepseek/i],
  ['qwen', /qwen|qwq/i],
  ['meta', /llama/i],
  ['gemma', /gemma/i],
  ['mistral', /mistral|mixtral|magistral|codestral|ministral/i],
  ['nvidia', /nemotron/i],
  ['minimax', /minimax/i],
  ['perplexity', /sonar|perplexity/i],
  ['cursor', /composer|cheetah/i],
];

/** רשומת המודל מהקטלוג של השרת, אם הוא עדיין שם. */
const modelEntry = (id) => (CONFIG.models || []).find((x) => x.id === id) || null;

/**
 * המותג של מודל: ‎{ key, brand, via }‎.
 *
 * ‎via‎ הוא הסוכן שמריץ את המודל כשהוא אינו המותג עצמו — כלומר Cursor. מודל
 * Claude שרץ דרך Cursor מקבל את הסימן של Claude ותג פינתי של Cursor: מה
 * שעונה על השאלה *עם מי אני מדבר* הוא המשפחה, ומה שעונה על *מי מריץ* הוא
 * התג. עד כה שתי התשובות היו מכווצות לקידומת טקסט אחת ("Cursor · ...").
 */
function brandOf(id) {
  const sid = String(id || '');
  // בלי מודל — ברירת המחדל של ה-CLI, שהיא תמיד Claude
  if (!sid) return { key: 'anthropic', brand: BRANDS.anthropic, via: null };
  const m = modelEntry(sid);
  const group = (m && m.group) || '';
  const viaCursor = isCursorModel(sid) || group.startsWith('Cursor');
  if (!viaCursor && GROUP_BRAND[group]) {
    return { key: GROUP_BRAND[group], brand: BRANDS[GROUP_BRAND[group]], via: null };
  }
  const hay = leafId(sid) + ' ' + ((m && (m.short || m.name)) || '');
  let key = '';
  for (const [k, re] of BRAND_RULES) if (re.test(hay)) { key = k; break; }
  if (!key) key = viaCursor ? 'cursor' : (GROUP_BRAND[group] || 'fallback');
  // תג Cursor מיותר כשהסימן עצמו כבר Cursor (Composer, וגם 'Auto' שלו)
  return { key, brand: BRANDS[key] || BRANDS.fallback, via: viaCursor && key !== 'cursor' ? BRANDS.cursor : null };
}

/** השם שמוצג לצד הסימן — קצר ככל שהקטלוג מרשה, ובלי קידומת השער. */
function modelShort(id) {
  if (!id) return 'Claude';
  const m = modelEntry(id);
  return (m && (m.short || m.name)) || leafId(id);
}

/** ‎--bm-l/--bm-d‎ כמחרוזת style — גם לעטיפה שרוצה את צבע המותג בלי הסימן. */
const brandVars = (id) => { const b = brandOf(id).brand; return `--bm-l:${b.fg};--bm-d:${b.fgDark}`; };

const brandSvg = (b, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"`
  + ` stroke="currentColor" stroke-width="${b.sw}" stroke-linecap="round" stroke-linejoin="round"`
  + ` aria-hidden="true">${b.body}</svg>`;

/**
 * ה-HTML של סימן המותג של מודל. הצבע עובר כמשתני CSS ולא כ-attribute, כדי
 * שהמעבר בהיר/כהה יקרה בלי לצייר מחדש שום דבר.
 */
function brandMarkHtml(id, size = 22) {
  const { key, brand, via } = brandOf(id);
  const style = `--bm-l:${brand.fg};--bm-d:${brand.fgDark};--bm-size:${size}px`;
  const badge = via
    ? `<span class="bmark-via" style="--bm-l:${via.fg};--bm-d:${via.fgDark}">${brandSvg(via, Math.round(size * 0.52))}</span>`
    : '';
  // ‎bm-<key>‎ מאפשר ל-CSS לדבר על מותג מסוים: הסיבוב האיטי במסך הפתיחה נכון
  // לשמש של Claude ולא לרשת של Mistral.
  return `<span class="bmark bm-${key}" style="${style}">${brandSvg(brand, size)}${badge}</span>`;
}

/**
 * אותו סימן כאלמנט, לשימוש בקוד שבונה DOM ולא מחרוזות.
 *
 * הסימן מפוענח פעם אחת לכל צירוף של מותג-תג-גודל ואז משוכפל. חלונית המודלים
 * מציירת מחדש את כל התוצאות בכל הקלדה — מעל ארבע מאות שורות ברשימה מלאה —
 * ופענוח ‎innerHTML‎ לכל שורה בכל תו היה הופך את החיפוש למקוטע.
 */
const bmarkProtos = new Map();
function brandMarkEl(id, size = 22) {
  const { key, via } = brandOf(id);
  const ck = key + '|' + (via ? via.label : '') + '|' + size;
  let proto = bmarkProtos.get(ck);
  if (!proto) {
    const span = el('span');
    span.innerHTML = brandMarkHtml(id, size);
    proto = span.firstElementChild;
    bmarkProtos.set(ck, proto);
  }
  return proto.cloneNode(true);
}

/**
 * כותרת התשובה: הסימן של המודל שכתב אותה ושמו לצידו.
 *
 * קודם היה כתוב כאן "Claude" בכל תשובה, בלי קשר למי ענה — גם ב-Gemini וגם
 * ב-Grok. עכשיו זו השורה שעונה על "עם מי אני מדבר עכשיו" בלי לפתוח את הבורר.
 */
function assistantHeadHtml(model) {
  return `<div class="role-tag" title="${escHtml(brandTitle(model))}">`
    + brandMarkHtml(model, 22)
    + `<span class="role-name">${escHtml(modelShort(model))}</span></div>`;
}

/** «Claude Opus 5 · דרך Cursor» — כותרת ה-tooltip לכל מקום שמציג סימן. */
function brandTitle(id) {
  const { brand, via } = brandOf(id);
  const name = id ? (modelName(id) || leafId(id)) : 'ברירת המחדל של ה-CLI';
  const bits = [name];
  if (brand.label && !name.toLowerCase().includes(brand.label.toLowerCase())) bits.push(brand.label);
  if (via) bits.push('דרך ' + via.label);
  return bits.join(' · ');
}

// ---------- Markdown ----------
marked.setOptions({ gfm: true, breaks: true });
const renderMd = (t) => DOMPurify.sanitize(marked.parse(t || ''), { ADD_ATTR: ['target'] });
/** מייצב Markdown חלקי באמצע סטרימינג — סוגר fences פתוחים ו-backticks בודדים */
function stabilizeMd(t) {
  if (!t) return '';
  let s = t;
  let inFence = false;
  for (const line of s.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
  }
  if (inFence) s += '\n```';
  else {
    const ticks = (s.match(/`/g) || []).length;
    if (ticks % 2 === 1) s += '`';
  }
  return s;
}
const renderMdLive = (t) => renderMd(stabilizeMd(t));

// ---------- מצב ----------
// כותרת החלון תמיד מכילה "ממשק עברית" — כלל ה-KWin ב-launch.sh מזהה לפיה את
// החלון ומצמיד לו את האייקון הנכון בשורת המשימות.
const BASE_TITLE = 'Sol · ממשק עברית';
const LS = 'rtlclaude.v2';   // מפתח ישן — נשאר רק לצורך הגירה חד-פעמית
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
let store = { convs: [], activeId: null, settings: {}, history: [] };
let activeId = null;
let storeReady = false;      // נהיה true רק אחרי טעינה מוצלחת מהשרת
let storeDir = '';
let ws = null, busy = false;

// ---------- מנוי על שיחה בשרת ----------
// השרת מחזיק את התהליך ואת זרם האירועים; החלון הזה הוא צופה. subSeq הוא ה-seq
// האחרון שקיבלנו, וזה מה שמאפשר להתחבר מחדש ולהשלים בדיוק את מה שהוחמץ במקום
// להתחיל מאפס — בין אם הרשת נפלה לרגע ובין אם נעלת את הטלפון באמצע תור.
let subId = null;
let subSeq = 0;
/** בזמן קריאת שיחה מהדיסק אחרי reset — פריימים חיים ממתינים בתור */
let syncing = false;
const syncQueue = [];
/** רק מכשיר אחד כותב את השיחה לדיסק בכל רגע — השרת קובע מי (ראו broadcastPresence) */
let isPrimary = true;
/** נשלח עם כל הודעה כדי שנזהה את ההד שלנו ונשמור את התצוגה המקדימה המקומית */
const pendingSends = new Map();

// מצב סטרימינג של התור הנוכחי
let live = null; // { convId, msgObj, contentEl, blocks: Map(index->{type,el,ref}), tools: Map(id->{ref,el}) }
/** שיחה שבבעלותה התור הפעיל — גם אם המשתמש מדפדף לשיחה אחרת */
let streamOwnerId = null;
/**
 * תור הפרומפטים המשורשרים. מקור האמת הוא השרת (הוא זה שמשגר את הבא בתור
 * בסיום כל תור, גם כשהדפדפן סגור); מה שמוחזק כאן הוא רק המראה שלו לתצוגה.
 */
let msgQueue = []; // [{ id, text, atts, images, by }]
/** המתנה לחידוש מכסת הסשן — { kind, resetsAt, at } או null. מגיע מהשרת. */
let limitState = null;
const pendingPerms = new Map();
/** מצב החיפוש בתוך השיחה (Ctrl+F) — מוגדר כאן כי renderConversation נוגע בו */
let findState = { q: '', marks: [], idx: -1 };

// מונה חי של התור הנוכחי (פלט/חשיבה) — מתעדכן תוך כדי הסטרימינג
let turnTok = { out: 0, curOut: 0, think: 0 };
function resetTurnTok() { turnTok = { out: 0, curOut: 0, think: 0 }; }
// ניסיון חוזר של ה-CLI שנמצא באוויר עכשיו (מ-system/api_error), או null
let turnRetry = null;
// מה שמצב GOD אישר אוטומטית בתור הנוכחי. נאסף תוך כדי ריצה, ובסופה נכנס
// לתמליל ככרטיס אחד מקופל בסוף ההודעה (ראו pushGodBlock).
let godTurn = [];

function renderWorking() {
  const t = $('workingText'); if (!t) return;
  const parts = [];
  const out = turnTok.out + turnTok.curOut;
  if (out) parts.push(`פלט ${fmtTok(out)} טוקנים`);
  if (turnTok.think) parts.push(`חשיבה ~${fmtTok(turnTok.think)}`);
  if (godTurn.length) parts.push(`⚡ GOD · ${godTurn.length} אושרו`);
  if (turnRetry) {
    // הסיבה לשקט מוצגת בזמן שהוא נמשך, ולא רק בדיעבד אחרי שהוא הפך לעצירה
    const n = turnRetry.max ? `${turnRetry.attempt}/${turnRetry.max}` : String(turnRetry.attempt || '');
    t.textContent = `שגיאת API — מנסה שוב${n ? ` (${n})` : ''}…`;
    t.classList.add('retrying');
    return;
  }
  t.classList.remove('retrying');
  t.textContent = parts.length ? 'עובד… · ' + parts.join(' · ') : 'חושב…';
}

/* ==========================================================================
   שמירה עמידה — כל שיחה היא קובץ בדיסק (~/.claude/rtl-claude)
   --------------------------------------------------------------------------
   בעבר כל ההיסטוריה נדחסה למחרוזת אחת ב-localStorage. המכסה (~5MB) התמלאה,
   ה-setItem נכשל בשקט, ומאותו רגע שום שיחה חדשה לא נשמרה — היא פשוט נעלמה
   ברענון. עכשיו: אינדקס קל באתחול, טעינה עצלה של שיחה בעת מעבר אליה,
   שמירה מושהית של מה שהשתנה בלבד, ושמירה סופית ב-sendBeacon בסגירת החלון.
   כישלון שמירה כבר לא נבלע — הוא מדליק חיווי ומנסה שוב.
   ========================================================================== */
const activeConv = () => store.convs.find(c => c.id === activeId);
const convById = (id) => (id ? store.convs.find((c) => c.id === id) : null);
const turnConv = () => convById((live && live.convId) || streamOwnerId) || activeConv();

const dirtyConvs = new Set();
let settingsDirty = false;
let flushTimer = null, flushing = false;

/** מסמן שיחה מסוימת כדורשת שמירה. */
function markDirty(conv) {
  if (!conv || !conv.id) return;
  // צ'אט אנונימי: כאן נגמר כל מסלול השמירה. אין קריאה לשרת, אין sendBeacon,
  // ואין חיווי "נשמר" — כי לא נשמר, וזו ההבטחה.
  if (conv.anon) return;
  // ריצת דואט נכתבת לדיסק על-ידי השרת, שהוא זה שמחזיק אותה. כתיבה מכאן הייתה
  // שולחת שיחה ריקה מעל הגרסאות ואת הערות המפקח.
  if (conv.mode === 'duet') return;
  // flush מדלג על שיחה שלא נטענה (כדי לא לדרוס בדיסק גוף שלם בריק), לכן
  // שינוי במטא־נתונים של שיחה סגורה (שינוי-שם) מחייב טעינה קודם.
  if (!conv.loaded) { ensureLoaded(conv.id).then(() => { dirtyConvs.add(conv.id); scheduleFlush(); }); return; }
  dirtyConvs.add(conv.id);
  scheduleFlush();
}
function markSettings() { settingsDirty = true; scheduleFlush(); }
/** נקודת הכניסה הכללית: מסמנת הגדרות + השיחה הפעילה + השיחה שמזרימה כרגע. */
function save() {
  markSettings();
  const a = activeConv(); if (a) markDirty(a);
  const t = convById(streamOwnerId); if (t && t !== a) markDirty(t);
}
function scheduleFlush() {
  if (!storeReady) return;
  setSaveState('pending');
  clearTimeout(flushTimer);
  // בזמן סטרימינג מגיעות בקשות שמירה עשרות פעמים בשנייה — כותבים לדיסק
  // בקצב נמוך יותר. סיום התור קורא ל-save() ומוריד את הכל מיד אחריו.
  flushTimer = setTimeout(flush, busy ? 2500 : 700);
}

/**
 * כתיבה חלקית: כמה הודעות מההתחלה *לא* צריכות להישלח.
 *
 * בזמן תור חי משתנה אך ורק ההודעה האחרונה — הטקסט שנכתב עכשיו, כרטיסי הכלים
 * שלו וכרטיסי ההרשאה שנולדים בתוכו. כל מה שלפניה כבר סגור. בלי זה כל שמירה
 * (כל 2.5 שניות בזמן סטרימינג) סידרה, שלחה, פענחה וכתבה לדיסק את התמליל
 * *כולו*, כלומר עלות שגדלה ליניארית עם אורך השיחה ומשולמת עשרות פעמים בתור.
 *
 * הבסיס לבטיחות הוא baseRev שכבר קיים: אם הגרסה בדיסק זהה לזו שבידינו, אז
 * גם הקידומת שם זהה לשלנו, ואפשר להשאיר אותה במקומה. בסוף התור נשלחת שמירה
 * מלאה אחת — היא גם המקום שבו כל תיקון להודעה ישנה (ראו mergeSessionTail)
 * מגיע לדיסק.
 */
function deltaFrom(c) {
  if (c._forceFull || !c.rev) return 0;          // מעולם לא נשמרה, או שנדרש מלא
  if (!busy || streamOwnerId !== c.id) return 0;  // אין תור חי — שולחים הכל
  return Math.max(0, (c.messages || []).length - 1);
}

/** מייצר את הגוף שנשלח לשרת — בלי שדות עזר פנימיים. */
function serializeConv(c, fromIndex) {
  const msgs = c.messages || [];
  const from = Math.max(0, Math.min(Number(fromIndex) || 0, msgs.length));
  return {
    id: c.id, title: c.title, sessionId: c.sessionId, sessionAgent: c.sessionAgent || '', cwd: c.cwd || '', draft: c.draft || '',
    cost: c.cost || 0, ctx: c.ctx || null, createdAt: c.createdAt, updatedAt: c.updatedAt || c.createdAt,
    messages: from ? msgs.slice(from) : msgs,
    ...(from ? { fromIndex: from } : {}),
    // הגרסה שראינו לאחרונה. אם בדיסק יש כבר גרסה חדשה יותר (מכשיר אחר כתב
    // בינתיים), השרת דוחה את הכתיבה במקום לתת לנו לדרוס — ואנחנו קוראים מחדש.
    baseRev: c.rev || 0,
  };
}
function settingsBody() {
  // activeId נכתב לקובץ ההגדרות ונטען ברענון. מזהה אנונימי שנשמר שם היה
  // עקבה בפני עצמו ("בשעה הזו היה פתוח צ'אט אנונימי") ועוד כזו שמנסה להיפתח
  // מחדש אל שיחה שכבר לא קיימת.
  return { settings: store.settings || {}, history: store.history || [], activeId: isAnonId(activeId) ? null : activeId };
}

async function flush() {
  if (!storeReady) return;
  if (flushing) { scheduleFlush(); return; }
  if (!dirtyConvs.size && !settingsDirty) { setSaveState('saved'); return; }
  flushing = true;
  setSaveState('saving');
  const ids = [...dirtyConvs]; dirtyConvs.clear();
  const wantSettings = settingsDirty; settingsDirty = false;
  let failed = false;
  const retry = () => { ids.forEach((i) => dirtyConvs.add(i)); if (wantSettings) settingsDirty = true; };
  try {
    for (const id of ids) {
      const c = convById(id);
      if (!c || !c.loaded || c.anon) continue;   // שיחה שלא נטענה — מה שבדיסק עדכני יותר
      // מכשיר שאינו הכותב הנוכחי מדלג: המצב שלו זהה ממילא, וכתיבה כפולה רק
      // הייתה נדחית ומאלצת טעינה מחדש באמצע סטרימינג.
      if (!isPrimary && id === subId) continue;
      const from = deltaFrom(c);
      const r = await fetch('/api/conversations/' + encodeURIComponent(id), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serializeConv(c, from)),
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.rev) c.rev = j.rev;
        if (!from) c._forceFull = false;   // השמירה המלאה יצאה — החוב נסגר
      } else if (r.status === 409) {
        const j = await r.json().catch(() => null);
        if (j && j.needFull) {
          // השרת לא יכול להרכיב את הקידומת (קובץ קצר מהצפוי). זו אינה
          // התנגשות בין מכשירים, ולכן אין מה לקרוא מחדש — רק לשלוח הכל.
          c._forceFull = true; dirtyConvs.add(id); failed = true;
        } else {
          // מכשיר אחר התקדם. הדיסק מנצח: קוראים משם ולא כותבים על גביו.
          await reloadConv(id);
        }
      } else {
        failed = true; dirtyConvs.add(id);
      }
    }
    if (wantSettings) {
      const r = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsBody()),
      });
      if (!r.ok) { failed = true; settingsDirty = true; }
    }
  } catch { failed = true; retry(); }
  flushing = false;
  if (failed) { setSaveState('error'); setTimeout(scheduleFlush, 4000); }
  else setSaveState('saved');
}

/** שמירה סופית בסגירת החלון — sendBeacon שורד גם אחרי שהדף כבר נעלם. */
function flushBeacon() {
  if (!storeReady) return;
  stashDraft();   // חייב לקרות לפני קריאת dirtyConvs — אחרת טיוטה שלא נשלחה תאבד
  const convs = [...dirtyConvs].map(convById)
    .filter((c) => c && c.loaded && !c.anon && (isPrimary || c.id !== subId))
    // ‎(c) =>‎ ולא ‎.map(serializeConv)‎: ‎map‎ מעביר את האינדקס כארגומנט שני,
    // כלומר כל שיחה מהשנייה והלאה הייתה נשלחת כדלתא חתוכה באמצע.
    .map((c) => serializeConv(c));
  if (!convs.length && !settingsDirty) return;
  const body = JSON.stringify({ conversations: convs, ...settingsBody() });
  try {
    if (navigator.sendBeacon && navigator.sendBeacon('/api/flush', new Blob([body], { type: 'application/json' }))) {
      dirtyConvs.clear(); settingsDirty = false;
      return;
    }
  } catch {}
  try { fetch('/api/flush', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }); } catch {}
}
addEventListener('pagehide', flushBeacon);
addEventListener('beforeunload', flushBeacon);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushBeacon(); });

// ---------- חיווי שמירה ----------
let saveState = 'idle';
function setSaveState(s) {
  if (saveState === s) return;
  saveState = s;
  const dot = $('saveDot');
  if (!dot) return;
  const label = { pending: 'ממתין לשמירה…', saving: 'שומר…', saved: 'נשמר בדיסק', error: 'השמירה נכשלה — מנסה שוב', idle: '' }[s] || '';
  dot.className = 'save-dot ' + s;
  dot.textContent = s === 'error' ? 'לא נשמר' : s === 'saving' || s === 'pending' ? 'שומר…' : s === 'saved' ? 'נשמר' : '';
  dot.title = storeDir ? label + ' · ' + storeDir : label;
  dot.classList.toggle('hidden', s === 'idle');
}

// ---------- טעינה מהשרת ----------
async function loadStoreFromServer() {
  const r = await fetch('/api/store');
  if (!r.ok) throw new Error('store ' + r.status);
  const d = await r.json();
  // השיחה האנונימית חיה בזיכרון הזה בלבד; טעינה מחדש של האינדקס (הגירה, ייבוא)
  // לא אמורה למחוק אותה מתחת לידיים.
  const keepAnon = (store.convs || []).filter((c) => c.anon);
  store.convs = [...keepAnon, ...(d.conversations || []).map((m) => ({ ...m, messages: [], loaded: false }))];
  store.settings = (d.settings && typeof d.settings === 'object') ? d.settings : {};
  store.history = Array.isArray(d.history) ? d.history : [];
  storeDir = d.dir || '';
  activeId = (d.activeId && store.convs.some((c) => c.id === d.activeId)) ? d.activeId
    : (store.convs[0] ? store.convs[0].id : null);
}

/** טוענת את גוף השיחה מהדיסק בפעם הראשונה שנכנסים אליה. */
function ensureLoaded(id) {
  const c = convById(id);
  if (!c) return Promise.resolve(null);
  if (c.loaded) return Promise.resolve(c);
  if (c._loading) return c._loading;
  c._loading = (async () => {
    try {
      const r = await fetch('/api/conversations/' + encodeURIComponent(id));
      if (r.ok) {
        const d = await r.json();
        const full = d && d.conversation;
        if (full) {
          c.messages = Array.isArray(full.messages) ? full.messages : [];
          c.draft = full.draft || '';
          c.cwd = full.cwd || '';
          c.rev = full.rev || 0;
          if (full.sessionId) c.sessionId = full.sessionId;
        }
      } else if (r.status === 404) {
        c.messages = []; c.rev = 0;   // עדיין לא נכתבה לדיסק (שיחה חדשה וריקה)
      } else {
        throw new Error('load ' + r.status);
      }
    } catch (e) {
      c.messages = [];
      toast('טעינת השיחה נכשלה — ' + (e.message || e), true);
    }
    c.loaded = true;
    c._loading = null;
    return c;
  })();
  return c._loading;
}

/** קורא שיחה מחדש מהדיסק ומצייר אותה שוב — כשמכשיר אחר כתב גרסה חדשה יותר. */
async function reloadConv(id) {
  const c = convById(id);
  if (!c) return null;
  dirtyConvs.delete(id);
  c.loaded = false;
  c._loading = null;
  await ensureLoaded(id);
  if (activeId === id) {
    const keep = $('input').value;   // מה שהוקלד כאן ועוד לא נשלח לא נמחק
    renderConversation();
    if (keep) { $('input').value = keep; autoGrow(); }
  }
  renderConvList();
  return c;
}

/**
 * משווה את מה שמצויר על המסך למה שכתוב בדיסק, ומרענן רק אם יש פער.
 * מחזירה את הפרש ההודעות, או null כשאין מה לתקן.
 *
 * זה החלק של הקרוס־צ'ק שעובד גם כשאין תור פעיל: תור שנקטע כאן והושלם
 * ממכשיר אחר משאיר על המסך תמליל קצר מזה שבדיסק, ואין שום פריים בדרך שיסגור
 * את הפער. משווים גם אורך וגם את ההודעה האחרונה — תשובה שנקטעה באמצע שומרת
 * על מספר ההודעות ומשנה רק את תוכן האחרונה.
 */
async function reconcileFromDisk(id) {
  const c = convById(id);
  // אין לשיחה אנונימית עותק בדיסק להשוות מולו — וגם אין מה לבקש מהשרת.
  if (isAnonId(id)) return null;
  if (!c || !c.loaded || live) { dlog('disk.skip', { id, has: !!c, loaded: !!(c && c.loaded), live: !!live }); return null; }
  // מה שטרם נכתב מכאן נכתב קודם — אחרת ההשוואה היא מול תמונה מיושנת שלנו עצמנו
  if (dirtyConvs.has(id)) await flush();
  const r = await fetch('/api/conversations/' + encodeURIComponent(id), { cache: 'no-store' });
  if (!r.ok) { dlog('disk.fail', { id, status: r.status }); return null; }
  const full = (await r.json()).conversation;
  if (!full || !Array.isArray(full.messages)) { dlog('disk.empty', { id }); return null; }

  const mine = c.messages || [];
  const delta = full.messages.length - mine.length;
  const tail = (a) => JSON.stringify(a[a.length - 1] || null);
  if (!delta && tail(full.messages) === tail(mine)) { dlog('disk.same', { id, msgs: mine.length }); return null; }
  dlog('disk.fix', { id, delta, mine: mine.length, disk: full.messages.length });

  const keep = $('input').value;
  c.messages = full.messages;
  c.cwd = full.cwd || '';
  c.rev = full.rev || 0;
  if (full.sessionId) c.sessionId = full.sessionId;
  dirtyConvs.delete(id);
  if (activeId === id) {
    renderConversation();
    if (keep) { $('input').value = keep; autoGrow(); }
  }
  renderConvList();
  return delta;
}

/**
 * הרובד העמוק של הקרוס־צ'ק: משווה את התשובה האחרונה שעל המסך לזו שבקובץ
 * הסשן של Claude, ומשלים אותה אם היא קטועה. מחזירה כמה תווים נוספו, או null.
 *
 * זה הרובד היחיד שמגלה תשובה שנקטעה: התמליל של rtl-claude נבנה כאן בדפדפן
 * ונכתב מכאן לדיסק, ולכן זרם שנקטע מותיר את שני העותקים קטועים באותו מקום.
 * ה-CLI כותב את התור המלא לקובץ שלו — הוא לא עבר דרכנו, ולכן הוא זה שיודע.
 */
async function reconcileFromSession(id) {
  const c = convById(id);
  if (isAnonId(id)) return null;   // ה-CLI לא כתב קובץ סשן, ואין ממה להשלים
  if (!c || !c.loaded || !c.sessionId || live) {
    dlog('sess.skip', { id, has: !!c, loaded: !!(c && c.loaded), sessionId: !!(c && c.sessionId), live: !!live });
    return null;
  }

  // ההשלמה מהדיסק קוראת את קובץ הסשן של Claude. לשיחת Cursor אין קובץ כזה,
  // והבקשה הייתה חוזרת ריקה בכל פעם מחדש.
  if ((c.sessionAgent || 'claude') === 'cursor') { dlog('sess.skip_cursor', { id }); return null; }
  const r = await fetch('/api/session-tail?sessionId=' + encodeURIComponent(c.sessionId)
    + '&cwd=' + encodeURIComponent(c.cwd || ''), { cache: 'no-store' });
  if (!r.ok) { dlog('sess.fail', { id, status: r.status, sessionId: c.sessionId }); return null; }
  const d = await r.json();
  if (!d.found || !Array.isArray(d.turns) || !d.turns.length) {
    // הסיבה הנפוצה: cwd אחר מזה שבו הקובץ נכתב, ולכן הנתיב שנבנה בשרת לא קיים
    dlog('sess.none', { id, found: !!d.found, sessionId: c.sessionId, cwd: c.cwd || '' });
    return null;
  }
  dlog('sess.tail', { id, turns: d.turns.length, msgs: c.messages.length });

  const chars = (bs) => bs.reduce((n, b) => n + (b && b.type === 'text' ? (b.text || '').length : 0), 0);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let gained = 0, touched = 0;

  for (const turn of d.turns) {
    const key = norm(turn.prompt).slice(0, 60);
    if (!key || !Array.isArray(turn.blocks) || !turn.blocks.length) continue;

    // מוצאים את התור על המסך לפי הפרומפט שפתח אותו. התאמה לפי טקסט ולא לפי
    // מיקום, כי מספר ההודעות בשני הצדדים לא בהכרח זהה — בדיוק זו התקלה.
    let ui = -1;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i];
      if (m && m.role === 'user' && norm(m.text).slice(0, 60) === key) { ui = i; break; }
    }
    const reply = ui >= 0 ? c.messages[ui + 1] : null;
    if (!reply || reply.role !== 'assistant') {
      // אין למי להשוות: הפרומפט לא נמצא על המסך, או שאחריו אין תשובה
      dlog('sess.nomatch', { key: clamp(key, 40), ui, next: reply ? reply.role : null });
      continue;
    }

    // מתקנים רק כשבקובץ הסשן יש יותר. הכיוון ההפוך אינו פער אלא הבדל לגיטימי:
    // כרטיסי הרשאה, למשל, נולדים כאן ולא נכתבים לקובץ הסשן בכלל.
    const mine = reply.blocks || [];
    const diff = chars(turn.blocks) - chars(mine);
    // שתי השורות האלה הן התשובה לשאלה "למה הקרוס־צ'ק לא השלים את התשובה הקטועה":
    // אם diff<=0, קובץ הסשן מכיל בדיוק את מה שכבר על המסך — אין מה להשלים.
    dlog(diff <= 0 && turn.blocks.length <= mine.length ? 'sess.same' : 'sess.fix', {
      key: clamp(key, 40), diff, chars: [chars(mine), chars(turn.blocks)], blocks: [mine.length, turn.blocks.length],
    });
    if (diff <= 0 && turn.blocks.length <= mine.length) continue;

    // כרטיסי הרשאה שנענו כאן קיימים רק בעותק שלנו — נשמרים בסוף, כדי שהתיעוד
    // של מה שאישרת לא ייעלם יחד עם התיקון.
    const asks = mine.filter((b) => b && b.type === 'ask');
    reply.blocks = asks.length ? [...turn.blocks, ...asks] : turn.blocks;
    gained += Math.max(diff, 0);
    touched++;
  }

  if (!touched) return null;
  // התיקון נוגע בהודעה *שאינה* האחרונה, ולכן שמירה חלקית הייתה משאירה את
  // הגרסה הקטועה בדיסק. ראו deltaFrom.
  c._forceFull = true;
  markDirty(c);
  if (activeId === id) {
    const keep = $('input').value;
    renderConversation();
    if (keep) { $('input').value = keep; autoGrow(); }
  }
  return gained;
}

/** הגירה חד-פעמית של ההיסטוריה הישנה מ-localStorage אל הדיסק. */
async function migrateLegacy() {
  let raw = null;
  try { raw = localStorage.getItem(LS); } catch { return; }
  if (!raw) return;
  let s = null;
  try { s = JSON.parse(raw); } catch {}
  if (!s || !Array.isArray(s.convs) || !s.convs.length) {
    try { localStorage.removeItem(LS); } catch {}
    return;
  }
  try {
    const r = await fetch('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convs: s.convs }),
    });
    const j = await r.json();
    if (!j || !j.ok) return;   // נשאיר את הישן ונשוב לנסות בהפעלה הבאה
    // קודם קוראים מחדש את האינדקס (כולל מה שיובא), ורק אחר כך משלימים
    // הגדרות/היסטוריה — אחרת הטעינה מהשרת הייתה דורסת אותן בחזרה לריק.
    if (j.imported) await loadStoreFromServer();
    if (!Object.keys(store.settings || {}).length && s.settings && typeof s.settings === 'object') store.settings = s.settings;
    if (!(store.history || []).length && Array.isArray(s.history)) store.history = s.history.filter((x) => typeof x === 'string');
    settingsDirty = true;   // יירדו לדיסק ברגע ש-storeReady נדלק בסוף init
    try { localStorage.setItem(LS + '.migrated', new Date().toISOString()); localStorage.removeItem(LS); } catch {}
    if (j.imported) toast(`${j.imported} שיחות הועברו מהדפדפן לאחסון קבוע בדיסק`);
  } catch {}
}

function newConv() {
  const c = {
    id: uid(), title: 'שיחה חדשה', sessionId: null, messages: [], cost: 0, ctx: null,
    cwd: (store.settings.cwd || ''), draft: '', createdAt: Date.now(), updatedAt: Date.now(),
    loaded: true, rev: 0,
  };
  store.convs.unshift(c); activeId = c.id;
  subscribeActive();
  markDirty(c); markSettings();
  return c;
}

/* ---------- צ'אט אנונימי: פתיחה, יציאה, מצב תצוגה ---------- */

// null = התשובה מ-/api/config עוד לא הגיעה. לחיצה בשלב הזה לא נחסמת — השרת
// ממילא מסרב להריץ בלי הדגל, ועדיף לנסות מאשר לחסום בגלל מירוץ טעינה.
let anonAvailable = null;

/**
 * שיחה שנולדה מחוץ לכל מנגנון השמירה. המזהה נושא את הסימן `anon-` כי הוא
 * מה שהשרת בודק, והדגל `anon` כי הוא מה שנבדק כאן — שניהם נקבעים רק כאן.
 * שימו לב למה שחסר: אין ‎markDirty‎ ואין ‎markSettings‎. זו לא שכחה.
 */
function newAnonConv() {
  const c = {
    id: ANON_PREFIX + uid(), anon: true, tools: false,
    title: 'צ׳אט אנונימי', sessionId: null, messages: [], cost: 0, ctx: null,
    cwd: (store.settings.cwd || ''), draft: '', createdAt: Date.now(), updatedAt: Date.now(),
    loaded: true, rev: 0,
  };
  store.convs.unshift(c);
  activeId = c.id;
  subscribeActive();
  return c;
}

function startAnonChat() {
  // ההבטחה של צ'אט אנונימי היא ששום דבר לא נכתב לדיסק. ל-cursor-agent אין
  // דגל שמכבה את שמירת השיחה — הוא כותב ל-~/.cursor/chats תמיד. לכן הכפתור
  // נחסם כאן במקום להיכשל אחרי שההבטחה כבר הוצגה על המסך.
  if (activeAgent() === 'cursor') {
    toast('צ׳אט אנונימי אינו אפשרי עם מודלי Cursor — ה-CLI שלו שומר כל שיחה לדיסק. בחר מודל Claude.', true);
    return;
  }
  if (anonAvailable === false) {
    toast('ה-CLI המותקן לא תומך בהרצה בלי שמירת סשן — צ׳אט אנונימי לא יכול לרוץ כאן', true);
    return;
  }
  if (busy) { interruptTurn(); abandonTurn(); }
  stashDraft();
  closeDrawer();
  const open = anonConv();
  if (open) { switchConv(open.id); }
  else {
    newAnonConv();
    renderConversation();
    renderConvList();
  }
  if (drawerMode()) setTimeout(() => $('input').focus(), 260);
  else $('input').focus();
}

/**
 * יציאה = מחיקה. מודיעים לשרת (שהורג את התהליך ומנקה את היומן שלו), ומנתקים
 * כאן כל הפניה לתמליל. מה שאי-אפשר להבטיח ולא נבטיח: אין ב-JavaScript דרך
 * לדרוס מחרוזת בזיכרון — מרגע זה אין אליה גישה והיא משוחררת ל-GC.
 */
function endAnon(opts) {
  const c = anonConv();
  if (!c) return;
  const silent = !!(opts && opts.silent);
  // keepActive = הקורא הוא מסלול מעבר (switchConv / שיחה חדשה / דואט), והוא
  // זה שיקבע לאן עוברים ויצייר. בלעדיו היינו בוחרים כאן יעד זמני, מציירים
  // אותו, ומיד נדרסים — ובמקרה הקצה של רשימה ריקה גם פותחים שיחה מיותרת.
  const keepActive = !!(opts && opts.keepActive);
  const id = c.id;
  if (busy && streamOwnerId === id) { interruptTurn(); abandonTurn(); }
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'anon_end', conversationId: id }));
  } catch {}
  c.messages = []; c.draft = ''; c.title = '';
  store.convs = store.convs.filter((x) => x.id !== id);
  dirtyConvs.delete(id);
  if (subId === id) { subId = null; subSeq = 0; }
  if (streamOwnerId === id) { streamOwnerId = null; live = null; }
  if (activeId === id) {
    clearPendingAtts();
    $('input').value = ''; autoGrow();
    // עוצרים כאן: תיבת הכתיבה כבר רוקנה (הטיוטה היא חלק ממה שנמחק), והקורא
    // הוא שיקבע את היעד ויצייר. activeId=null הוא מצב ביניים של שורה אחת.
    if (keepActive) { activeId = null; return; }
    activeId = store.convs[0] ? store.convs[0].id : null;
    if (!activeId) newConv();
    const next = activeConv();
    subscribeActive();
    if (next && !next.loaded) {
      ensureLoaded(next.id).then(() => { if (activeId === next.id) { renderConversation(); restoreDraft(); syncConvCwd(); } });
    } else { restoreDraft(); syncConvCwd(); }
  }
  renderConversation();
  renderConvList();
  if (!silent) toast('הצ׳אט האנונימי נמחק — לא נשאר ממנו זכר');
}

/* --------------------------------------------------------------------------
   עזיבה = מחיקה, בכל דרך
   --------------------------------------------------------------------------
   "יציאה" מצ'אט אנונימי איננה רק כפתור היציאה. מעבר לשיחה אחרת מהרשימה או
   מלוח הפקודות, פתיחת שיחה חדשה, פתיחת דואט, המשך סשן מהדיסק, קפיצה לשיחה
   שממתינה לאישור — כולן עוזבות אותו, ולכן כולן מוחקות אותו. מה שאין הוא
   מסלול שלישי, שבו עוזבים והשיחה ממתינה ברקע לחזרה: שיחה שאפשר לחזור אליה
   היא שיחה ששרדה, וזו בדיוק ההבטחה שהמצב הזה נותן.
   מכאן שכל שינוי של activeId עובר דרך leaveAnon, והשאלה נשאלת פעם אחת בלבד.
   ----------------------------------------------------------------------- */

/** אישור לפני איבוד. שיחה ריקה אין מה לאשר עליה — אין מה לאבד. */
function anonLeaveOk(c) {
  return !c.messages.length
    || confirm('לצאת ולמחוק את הצ׳אט האנונימי?\nהשיחה לא נשמרה בשום מקום — היא תיעלם, ואין דרך לחזור אליה.');
}

/**
 * שער יחיד לכל מסלול שעוזב את הצ'אט האנונימי. מחזיר false אם המשתמש ביטל,
 * ואז על הקורא לעצור — הוא נשאר בשיחה האנונימית, ולא במצב ביניים שבו עברנו
 * אבל לא מחקנו.
 * @param {string|null} nextId היעד, אם ידוע — כדי לא למחוק בדרך לשיחה עצמה.
 */
function leaveAnon(nextId) {
  const c = anonConv();
  if (!c || activeId !== c.id || nextId === c.id) return true;
  if (!anonLeaveOk(c)) return false;
  endAnon({ silent: true, keepActive: true });
  toast('הצ׳אט האנונימי נמחק — לא נשאר ממנו זכר');
  return true;
}

/** מסנכרן את מראה הממשק למצב הנוכחי: פס אזהרה, סימון גלובלי, מתג הכלים. */
function applyAnonMode() {
  const c = anonConv();
  const on = !!c && activeId === c.id;
  document.body.classList.toggle('anon-mode', on);
  const bar = $('anonBar');
  if (bar) bar.classList.toggle('hidden', !on);
  const tools = $('anonTools');
  if (tools && c) {
    tools.classList.toggle('on', !!c.tools);
    // הכפתור מחזיק שתי תוויות ו-CSS בוחר איזו מהן נראית; כתיבה ל-textContent
    // כאן הייתה מוחקת את שתיהן ומחזירה את הכיתוב הארוך למסך הצר.
    const tl = tools.querySelector('.t-long'), ts = tools.querySelector('.t-short');
    if (tl) tl.textContent = c.tools ? 'כלים: פעילים' : 'כלים: כבויים';
    if (ts) ts.textContent = c.tools ? 'כלים ✓' : 'כלים ✕';
    tools.title = c.tools
      ? 'הכלים פעילים — פעולות על קבצים ובטרמינל משאירות עקבות משל עצמן, מחוץ לשיחה'
      : 'הכלים כבויים — שיחה בלבד, בלי קריאה/כתיבה של קבצים ובלי טרמינל';
  }
  // חיווי השמירה לא שייך כאן: אין מה לשמור, ו"נשמר" היה שקר על המסך
  if (on) setSaveState('idle');
}

function interruptTurn() {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'interrupt' }));
}
function abandonTurn() {
  dlog('abandon', { activeId, streamOwnerId, busy, blocks: live ? (live.blocks || []).length : 0 });
  pushGodBlock();   // תור שנשבר — מה שכבר אושר ב-GOD עדיין מגיע לתמליל
  live = null;
  streamOwnerId = null;
  turnRetry = null;
  clearAllPerms();
  // התור עצמו לא נוגעים בו: הוא חי בשרת, והשרת הוא שמחליט אם לשגר את הבא
  // בתור או לבטל. ניתוק רשת רגעי כאן לא אמור למחוק פרומפטים שהקלדת.
  if (busy) setBusy(false);
}

// ---------- WebSocket ----------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { dlog('ws.open', { activeId, busy }); setStatus(busy ? 'busy' : 'on', 'מחובר'); subscribeActive(true); };
  // ניתוק כבר לא מבטל את התור: התהליך רץ בשרת וממשיך גם כשהחלון סגור.
  // מסמנים "מנותק", מתחברים מחדש, וה-sync משלים בדיוק את מה שהוחמץ.
  ws.onclose = (e) => { dlog('ws.close', { code: e && e.code, clean: !!(e && e.wasClean), busy }); setStatus('', 'מנותק'); setTimeout(connect, 1500); };
  ws.onerror = () => { dlog('ws.error', { state: ws ? ws.readyState : -1 }); setStatus('', 'שגיאת חיבור'); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handleServer(m); };
}
function setStatus(cls, title) {
  const d = $('statusDot');
  d.className = 'dot' + (cls ? ' ' + cls : '');
  d.title = title;
  // הפסיל והנקודה חייבים לומר אותו דבר. קודם הפסיל נשאר על «מוכן» גם אחרי
  // onclose — רק הנקודה האפירה סימנה ניתוק, וזה נסתר בטלפון רחב יחסית.
  const pill = $('statusPill');
  if (!pill) return;
  if (cls === 'busy') pill.textContent = 'מעבד…';
  else if (cls === 'on') pill.textContent = 'מוכן';
  else pill.textContent = title || 'מנותק';
}
function wsConnected() { return !!(ws && ws.readyState === 1); }

/* ==========================================================================
   קרוס־צ'ק — השוואת מצב המסך למצב האמיתי בשרת
   --------------------------------------------------------------------------
   התסמין: המסך תקוע על "חושב…" בזמן שמאחורי הקלעים הכול רץ (או שהתור מזמן
   הסתיים). השורש כמעט תמיד אחד — ה-WebSocket מת בשקט: בטלפון, בכל יציאה
   מ-sleep או מעבר בין Wi-Fi לסלולר, ה-TCP נשאר חצי-פתוח. onclose *לא* נורה,
   readyState עדיין OPEN, ולכן לוגיקת ההתחברות-מחדש הקיימת לא מופעלת אף פעם
   ואף פריים לא מגיע יותר.
   לכן הבדיקה במכוון *לא* עוברת ב-socket אלא ב-HTTP: חיבור TCP חדש לגמרי,
   שמחזיר את מצב האמת של השיחה ועוקף בדיוק את התקלה שאותה באנו לאבחן.
   משם יש סולם תיקון: השלמת הפריימים שהוחמצו מהיומן → טעינה מלאה מהדיסק כשהפער
   גדול מדי → ולבסוף שחרור הדגל, כדי שלא נישאר תקועים בשום מקרה.
   ========================================================================== */
let lastFrameAt = Date.now();   // מתי הגיע משהו — כלשהו — מהשרת
let lastPongAt = 0;
let lastCheckAt = 0;
let checking = false;
const STALE_MS = 15000;         // תור פעיל בלי אף פריים = חשוד
const PONG_DEAD_MS = 25000;     // בלי מענה ping כזמן הזה — ה-socket מת
const RECHECK_MS = 10000;       // מרווח מינימלי בין בדיקות אוטומטיות

/** כמה זמן אין עדכון. רלוונטי רק כשאמורים לקבל עדכונים. */
function staleFor() { return busy ? Date.now() - lastFrameAt : 0; }

function renderStale() {
  const ms = staleFor();
  const stale = ms > STALE_MS;
  document.body.classList.toggle('stale', stale);
  const note = $('staleNote'), btn = $('resyncBtn');
  if (btn) btn.classList.toggle('hidden', !stale);
  if (note) {
    note.classList.toggle('hidden', !stale);
    if (stale) note.textContent = `אין עדכון כבר ${Math.round(ms / 1000)} שנ׳`;
  }
}

function pingSocket() {
  if (!ws || ws.readyState !== ws.OPEN) return;
  // הפינג נושא את הצ'אטים האנונימיים הפתוחים כאן. בשרת זה מה שמבדיל בין
  // "עברתי לשיחה אחרת לרגע" (הדף חי, הפינג ממשיך) לבין "החלון נסגר" — שאז
  // הצ'אט מושמד מעצמו. ראו sweepAnon בשרת.
  const anon = (store.convs || []).filter((c) => c.anon).map((c) => c.id);
  try { ws.send(JSON.stringify({ type: 'ping', t: Date.now(), ...(anon.length ? { anon } : {}) })); } catch {}
}

// הפינג הרגיל יוצא רק כשתור תקוע. הצ'אט האנונימי צריך דופק גם כשלא קורה כלום,
// אחרת מרווח החסד בשרת היה מחסל אותו בזמן שאתה פשוט קורא את התשובה.
setInterval(() => { if (anonConv()) pingSocket(); }, 20000);

// סגירת חלון אמיתית (ולא מעבר לאפליקציה אחרת / bfcache) — מוחקים מיד במקום
// לחכות למרווח החסד. persisted=true פירושו שהדף עוד עשוי לחזור, ואז לא נוגעים.
addEventListener('pagehide', (e) => { if (!e.persisted) endAnon({ silent: true }); });

/** סוגר חיבור מת ומתחבר מיד, בלי להמתין לטיימר של onclose. */
function reconnectNow() {
  dlog('reconnect', { state: ws ? ws.readyState : -1, subId, subSeq });
  try { if (ws) { ws.onclose = null; ws.close(); } } catch {}
  ws = null;
  lastPongAt = 0;
  connect();
}

/** מבקש מהשרת את מה שהוחמץ. full=true מכריח טעינה מהדיסק (mode:'reset'). */
function resync(full) {
  if (full) subSeq = 0;
  subscribeActive(true);
}

/**
 * הבדיקה עצמה. מחזירה תיאור קצר של מה שתוקן (או null אם לא היה מה לתקן),
 * כדי שהמפעיל הידני יוכל לומר למשתמש מה קרה בפועל.
 */
async function crossCheck(reason) {
  const manual = reason === 'manual';
  if (checking) { dlog('check.busy', { reason }); return null; }
  // התור שייך לשיחה שהתחילה אותו, גם אם המשתמש דפדף בינתיים לשיחה אחרת
  const convId = streamOwnerId || subId || activeId;
  if (!convId) { if (manual) toast('אין שיחה לבדוק'); dlog('check.noconv', { reason }); return null; }
  dlog('check.start', {
    reason, convId, activeId, subId, subSeq, busy,
    stale: staleFor(), ws: ws ? ws.readyState : -1, live: !!live,
  });
  checking = true;
  lastCheckAt = Date.now();
  try {
    let st;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch('/api/turn-state?convId=' + encodeURIComponent(convId), { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      st = await r.json();
    } finally { clearTimeout(to); }

    const fixed = [];
    const socketClosed = !ws || ws.readyState !== ws.OPEN;
    // השרת לא רואה אותנו כמנוי, או שהוא הוציא פריימים שמעולם לא קיבלנו —
    // שתי הראיות לכך שהחיבור מת גם אם הדפדפן עדיין מכריז עליו OPEN.
    // ההשוואה מול seq תקפה רק כשהמנוי הוא על אותה שיחה שנבדקה. אחרת מדובר
    // בשני מונים של שתי שיחות שונות, והשוואה ביניהם הייתה מדווחת על פער דמיוני.
    const sameSub = convId === subId;
    const behind = st.known && sameSub && st.seq > subSeq;
    // "יתום" נחשב ראיה רק אם אנחנו *חושבים* שאנחנו מנויים. בלי התנאי הזה כל
    // בדיקה שרצה בחלון שבין פתיחת הדף למנוי הראשון הייתה רואה subs===0,
    // מסיקה שהחיבור מת, וסוגרת socket תקין באמצע ההתחברות.
    const orphaned = st.known && st.subs === 0 && !!subId && !socketClosed;
    const pongDead = lastPongAt > 0 && Date.now() - lastPongAt > PONG_DEAD_MS;
    // כל מה שההחלטות שלמטה נשענות עליו, בשורה אחת — צד השרת וצד המסך זה מול זה
    dlog('check.state', {
      srv: { known: st.known, running: st.running, alive: st.alive, seq: st.seq, oldest: st.oldestSeq, subs: st.subs },
      me: { subSeq, sameSub, busy, socketClosed, behind, orphaned, pongDead },
    });

    if (socketClosed || orphaned || pongDead || (behind && staleFor() > STALE_MS)) {
      reconnectNow();
      fixed.push('החיבור אותחל');
    } else if (behind) {
      // החיבור חי, פשוט פספסנו פריימים — השלמה מהיומן מספיקה
      resync(subSeq < (st.oldestSeq || 0) - 1);
      fixed.push('הושלמו עדכונים שהוחמצו');
    }

    if (st.known && st.running && !busy) {
      onRemoteBusy(true);
      fixed.push('התור מסומן כפעיל');
    }

    // שיחה שהשרת כן מכיר, אבל התור שלה כבר נגמר שם. שיחה שהוא לא מכיר בכלל
    // מטופלת בהמשך — אין לה יומן, ולכן אין ממה להשלים ואין טעם לחכות.
    if (st.known && !st.running && busy) {
      // התור הסתיים בשרת אבל המסך לא יודע. קודם מנסים למשוך את הפריימים
      // שהוחמצו — שם נמצא ה-result עם העלות והטוקנים, ובלעדיו התשובה עצמה
      // עלולה לחסר מהתמליל. רק אם גם אחרי זה שום דבר לא הגיע, משחררים ביד.
      resync(subSeq < (st.oldestSeq || 0) - 1);
      fixed.push('התור כבר הסתיים בשרת');
      setTimeout(() => {
        if (busy && staleFor() > 2500) {
          abandonTurn();
          toast('התור הסתיים בשרת — המסך שוחרר');
        }
      }, 2500);
    }

    // השרת לא מכיר את השיחה: אין תור, אין יומן, אין ממה להשלים. מסך שעדיין
    // מציג "עובד" תקוע על תור שכבר לא קיים (שרת שעלה מחדש, סשן שפונה מהזיכרון).
    if (!st.known && busy) {
      abandonTurn();
      fixed.push('אין תור פעיל בשרת — המסך שוחרר');
    }

    // עד כאן תוקן מה שאפשר לתקן דרך הזרם. נשארת האפשרות שאין בכלל פער בזרם
    // והמסך פשוט מציג תמליל ישן מזה שבדיסק — תור שנקטע כאן והושלם במקום אחר.
    // רק בבדיקה ידנית: זו קריאה של שיחה שלמה, ואין טעם להריץ אותה בלולאה.
    if (manual && !busy && !st.running && !behind) {
      const delta = await reconcileFromDisk(activeId);
      if (delta !== null) fixed.push(delta > 0 ? `נוספו ${delta} הודעות מהדיסק` : 'התמליל תוקן מהדיסק');
      // ואחרי שהתמליל תואם לדיסק — האם הוא תואם למה ש-Claude עצמו רשם
      const gained = await reconcileFromSession(activeId);
      if (gained !== null) fixed.push(gained > 0 ? `הושלמו ${gained} תווים מקובץ הסשן` : 'התמליל הושלם מקובץ הסשן');
    }

    if (manual) {
      if (fixed.length) toast(fixed.join(' · '));
      else if (st.running) toast('הכול מסונכרן — Claude עדיין עובד');
      else toast('הכול מסונכרן');
    }
    dlog('check.done', { reason, fixed });
    renderStale();
    return fixed.length ? fixed.join(' · ') : null;
  } catch (e) {
    // ה-HTTP עצמו נכשל: לא באג בסנכרון אלא שהשרת/הרשת לא זמינים
    dlog('check.fail', { reason, msg: String(e && e.message || e) });
    setStatus('', 'השרת לא מגיב');
    if (manual) toast('השרת לא מגיב (' + (e.message || e) + ')', true);
    return null;
  } finally {
    checking = false;
  }
}

// מנוע הבדיקה. פועם לאט ובודק רק כשיש סיבה, כדי לא להעיר את השרת לחינם.
setInterval(() => {
  renderStale();
  if (!busy) return;
  if (staleFor() > 8000) pingSocket();
  if (staleFor() > STALE_MS && Date.now() - lastCheckAt > RECHECK_MS) crossCheck('auto');
}, 2000);

// הרגעים שבהם החיבור כמעט תמיד כבר מת: חזרה למסך, חזרה לרשת, ושחזור מ-bfcache.
document.addEventListener('visibilitychange', () => { if (!document.hidden) crossCheck('resume'); });
addEventListener('online', () => crossCheck('online'));
addEventListener('pageshow', (e) => { if (e.persisted) crossCheck('bfcache'); });

/** מנוי על השיחה הפעילה. force = אחרי התחברות מחדש (מבקש השלמה מ-subSeq). */
function subscribeActive(force) {
  if (!ws || ws.readyState !== ws.OPEN || !activeId) return;
  const same = subId === activeId;
  if (same && !force) return;
  // שיחה רגילה מתחילה מאפס כי הדיסק הוא הבסיס שלה: קוראים משם ומציירים מחדש.
  // לשיחה אנונימית אין בסיס כזה — התמליל היחיד הוא זה שבזיכרון כאן. לכן היא
  // נשענת על ההשלמה מיומן השרת וממשיכה מהפריים האחרון שראינו; מנוי מאפס היה
  // מצייר את התור הרץ פעם שנייה.
  const target = convById(activeId);
  const resume = (target && target.anon) ? (target._seq || 0) : 0;
  const sinceSeq = same ? subSeq : resume;
  if (!same) subSeq = resume;
  subId = activeId;
  ws.send(JSON.stringify({ type: 'subscribe', conversationId: activeId, sinceSeq }));
}

function handleServer(m) {
  // כל פריים שמגיע מוכיח שהחיבור חי — זה הסימן שהקרוס־צ'ק מודד מולו
  lastFrameAt = Date.now();
  if (m.kind === 'pong') { lastPongAt = Date.now(); return; }
  // פריים של שיחה שכבר עברנו ממנה — מגיע רק בפער שבין החלפה למנוי החדש
  if (m.convId && subId && m.convId !== subId) return;
  // קריאת השיחה מהדיסק היא אסינכרונית, ובינתיים ממשיכים להגיע פריימים חיים.
  // בלי התור הזה הם היו מצוירים ואז נמחקים ברינדור מחדש שמגיע אחריהם.
  if (syncing && m.kind !== 'sync') { syncQueue.push(m); return; }
  if (m.seq) {
    subSeq = m.seq;
    // נשמר על השיחה עצמה ולא רק במנוי, כדי שמעבר לשיחה אחרת וחזרה יֵדע
    // מהיכן להמשיך (ראו subscribeActive).
    const sub = convById(subId);
    if (sub && sub.anon) sub._seq = m.seq;
  }
  switch (m.kind) {
    case 'sync': onSync(m); break;
    case 'busy': onRemoteBusy(m.running); break;
    case 'user_msg': onRemoteUserMsg(m); break;
    case 'presence': renderPresence(m); break;
    case 'ui': applyRemoteUi(m); break;
    case 'event': handleEvent(m.evt); break;
    case 'god_allow': onGodAllow(m.entry); break;
    case 'permission': showPermission(m.id, m.req); break;
    case 'permission_cancel': cancelPermission(m.id); break;
    case 'permission_resolved': onRemoteResolved(m); break;
    case 'dialog': showDialog(m.id, m.req); break;
    case 'dialog_resolved': onRemoteResolved(m); break;
    case 'dialog_timeout': closePermission(m.id, 'cancelled'); toast('פג הזמן למענה על בקשת Claude', true); break;
    case 'conv_meta': onRemoteConvMeta(m.meta); break;
    case 'conv_deleted': onRemoteConvDeleted(m.id); break;
    // השרת השמיד את הצ'אט האנונימי (יציאה ממכשיר אחר, או שהחלון נעלם למשך
    // מרווח החסד). התהליך כבר מת שם — מנקים גם כאן במקום להציג תמליל מת.
    case 'anon_wiped':
      if (anonConv() && anonConv().id === m.convId) { endAnon({ silent: true }); toast('הצ׳אט האנונימי נסגר ונמחק'); }
      break;
    case 'duet': onDuetFrame(m); break;
    case 'queue': onQueueUpdate(m.items); break;
    case 'toast':
      // ‎duet_start‎ שנדחה (מטרה חסרה, תוצר פתיחה גדול מדי) חוזר כ-toast. בלי
      // זה הכפתור בטופס ההגדרה היה נשאר "מתחיל…" על ריצה שלא קיימת.
      if (m.err && duetSetupBusy) { duetSetupBusy.reset(m.text); duetSetupBusy = null; }
      toast(m.text, !!m.err);
      break;
    case 'limit': setLimitState(m.limit); break;
    case 'limit_info': onWeeklyLimit(m); break;
    case 'limit_resumed': onLimitResumed(m); break;
    case 'halt': onHalt(m); break;
    case 'error': addNote(m.text, true); toast(m.text, true); abandonTurn(); break;
    // ה-stderr נכתב ליומן בשרת. על המסך הוא היה רעש — הכרטיס והיומן מכסים אותו.
    case 'stderr': break;
    case 'exit': {
      // code=null הוא תהליך שנהרג באות (SIGKILL של מחסל הזיכרון, למשל).
      // התנאי הישן בדק רק code אמיתי, ולכן דווקא המקרה הזה יצא בשקט מוחלט.
      const { code, signal } = m;
      const wasBusy = busy;
      abandonTurn();
      if (signal) toast(`תהליך ה-CLI נהרג (${signal})`, true);
      else if (code) toast(`התהליך הסתיים (קוד ${code})`, true);
      else if (wasBusy) toast('תהליך ה-CLI נסגר באמצע התור', true);
      break;
    }
    case 'raw': break;
  }
}

/**
 * תשובת השרת למנוי. mode='catchup' — היומן עוד הכיל את מה שהחמצנו והמסך ממשיך
 * מאיפה שנקטע. mode='reset' — הפער גדול מדי, ואז קוראים את השיחה מהדיסק
 * (מקור האמת) ומתחילים זרם נקי, כדי שלא ייווצר תמליל חלקי.
 */
async function onSync(m) {
  dlog('sync', { convId: m.convId, mode: m.mode, seq: m.seq, was: subSeq, running: !!m.running, perms: (m.perms || []).length, queue: (m.queue || []).length });
  subSeq = m.seq || 0;
  // מכשיר שנפתח באמצע ניסיון חוזר מקבל את הסיבה לשקט מיד, ולא רק אם במקרה
  // ייצא עוד api_error אחריו
  turnRetry = m.retry || null;
  // קודם כל מצב הריצה: מסך הדואט נבנה ממנו, ולכן הוא חייב להיות במקום לפני
  // הציור של השיחה — גם בנתיב reset וגם בהתחברות מחדש באמצע תור.
  if (m.duet) duetAdopt(m.duet);
  else if (duetRun) { duetRun = null; duetLive = null; duetDom = null; duetViewV = 0; duetVerCache.clear(); }
  if (m.mode === 'reset') {
    syncing = true;
    try {
      live = null;
      clearAllPerms();
      // התור כולו עומד להתנגן מחדש מהיומן, כולל פריימי GOD שכבר נספרו כאן —
      // בלי האיפוס הזה הם היו נספרים פעמיים בכרטיס הסיכום.
      godTurn = [];
      const c = convById(m.convId);
      // שיחה שמעולם לא נכתבה לדיסק — ‎rev=0‎, בלי סשן ובלי הודעות — אין מה
      // לקרוא ממנו, והקריאה החזירה 404 בכל פתיחה של שיחה חדשה. ‎rev‎ מתעדכן
      // גם מ-conv_meta של מכשיר אחר, ולכן "0" כאן באמת אומר "עוד לא נשמרה".
      // שיחה אנונימית אינה בדיסק בהגדרה: קריאה כזו הייתה מחזירה 404 ומוחקת
      // את התמליל מהמסך — כלומר מאבדת את השיחה בדיוק כשחוזרים אליה.
      const unsaved = c && (c.anon || (!c.rev && !c.sessionId && !(c.messages || []).length));
      if (c && !unsaved) { c.loaded = false; c._loading = null; await ensureLoaded(c.id); if (activeId === c.id) renderConversation(); }
    } finally {
      syncing = false;
    }
    // עכשיו הבסיס מהדיסק על המסך — מריצים את התור הרץ מתחילתו ואת מה שהצטבר
    const q = syncQueue.splice(0);
    for (const f of q) handleServer(f);
  }
  // לשיחה שכבר רצה יש מודל משלה, והוא מנצח את הבורר המקומי: פתיחת השיחה
  // ממכשיר נוסף מסתנכרנת אליו ולא מחליפה אותו בשקט. היוצא מן הכלל הוא בחירה
  // שנעשתה כאן בזמן ניתוק — היא מאוחרת יותר, ולכן היא שנדחפת.
  if (modelDirty && ws && ws.readyState === ws.OPEN && subId) pushModel();
  else if (typeof m.model === 'string') adoptModel(m.model, m.effort);
  // כרטיסים שנפתחו בזמן שלא היינו מחוברים — כדי שאפשר יהיה לענות עליהם מכאן
  for (const p of (m.perms || [])) if (!pendingPerms.has(p.id)) showPermission(p.id, p.req);
  for (const d of (m.dialogs || [])) if (!pendingPerms.has(d.id)) showDialog(d.id, d.req);
  // התור וההמתנה למכסה שייכים לשיחה ולא למכשיר — נטענים מהשרת בכל התחברות
  onQueueUpdate(m.queue || []);
  setLimitState(m.limit || null);
  // רק כאן מותר להוריד "עסוק" לפי השרת: זו התמונה המלאה של מצב השיחה ברגע
  // ההתחברות. בזרם הרגיל הורדת הדגל שייכת לאירוע result, כדי שלא נבטל בטעות
  // תור שכבר שוגר מהתור-הממתין בין שני הפריימים.
  if (m.running) onRemoteBusy(true);
  else if (busy) abandonTurn();
}

/** מצב "עובד" נקבע בשרת, כך ששני המכשירים מראים את אותו דבר. */
function onRemoteBusy(running) {
  if (!running) return;
  if (!streamOwnerId) streamOwnerId = subId;
  if (!busy) setBusy(true);
}

/** הודעת משתמש — מרונדרת מההד של השרת, כך שהיא מופיעה זהה בכל המכשירים. */
function onRemoteUserMsg(m) {
  const local = m.nonce ? pendingSends.get(m.nonce) : null;
  if (m.nonce) pendingSends.delete(m.nonce);
  streamOwnerId = m.convId || subId;
  live = null;
  addUserMessage(m.text || '', local || m.atts || []);
  persist();
}

/** כרטיס הרשאה/שאלה שנענה במכשיר אחר — נסגר גם כאן, עם אותה תשובה. */
function onRemoteResolved(m) {
  const p = pendingPerms.get(m.id);
  if (!p) return;
  if (p.ref) {
    if (m.answers) p.ref.answers = m.answers;
    if (m.response) p.ref.response = m.response;
  }
  closePermission(m.id, m.label || m.decision || 'ended');
  if (m.by) toast(`נענה מ-${m.by}`);
}

/** תגית "גם הטלפון פתוח כאן" — כדי שתדע שהמסך השני באמת מחובר. */
function renderPresence(m) {
  const wasPrimary = isPrimary;
  isPrimary = m.primary !== false;
  // הפכנו לכותב (המכשיר השני נסגר, או ששלחנו מכאן) — משלימים כתיבה לדיסק
  if (isPrimary && !wasPrimary) { const c = activeConv(); if (c) markDirty(c); }
  const el2 = $('presence');
  if (!el2) return;
  const others = Math.max(0, (m.count || 1) - 1);
  el2.classList.toggle('hidden', others < 1);
  if (others < 1) return;
  const names = (m.devices || []).slice(0, 3).join(' · ');
  // מכשיר משני כותב לזיכרון אבל מדלג על flush לדיסק — בלי סימן זה נראה כמו
  // סנכרון מלא, ואז "למה השיחה לא נשמרה מכאן" מגיע רק אחרי רענון.
  if (!isPrimary) {
    el2.textContent = '👁 תצוגה בלבד';
    el2.dataset.n = others;
    el2.title = 'מכשיר זה מציג בלבד — השמירה לדיסק נעשית במכשיר הראשי. מחוברים: ' + names;
    return;
  }
  el2.textContent = others === 1 ? '⛓ מכשיר נוסף' : `⛓ ${others} מכשירים`;
  el2.dataset.n = others;   // במסך צר ה-CSS מציג רק "⛓N" במקום המשפט המלא
  el2.title = 'מחוברים לשיחה הזו: ' + names;
}

/* ---------- מצב שאינו בתמליל (בוררים, תיקייה, טיוטה) ----------
   התמליל מסתנכרן מזרם האירועים, אבל הבוררים בסרגל לא עוברים בזרם הזה.
   בלי השידור הזה היית מחליף מודל בטלפון והמחשב היה ממשיך להראות את הישן —
   שני מסכים שנראים שונה זה בדיוק מה שרצינו למנוע. */
const UI_FIELDS = { cwd: 'cwd', model: 'model', effort: 'effort', permissionMode: 'perm' };

/** בחירה מקומית שטרם הגיעה לשרת (הוחלפה בזמן ניתוק) — נדחפת בהתחברות הבאה. */
let modelDirty = false;

function pushModel() {
  modelDirty = false;
  ws.send(JSON.stringify({ type: 'set_model', model: $('model').value, effort: $('effort').value }));
}

/**
 * מיישר את בורר המודל/המאמץ למה שהשיחה באמת רצה איתו (מגיע ב-sync).
 * בלי חזרה לשרת: זו סנכרון של המסך למצב קיים, לא בקשת החלפה.
 */
function adoptModel(model, effort) {
  const ms = $('model');
  // הרשימה עדיין לא נטענה מ-/api/config — עדיף לא לגעת מאשר ליפול לברירת מחדל
  if (model && ![...ms.options].some(o => o.value === model)) return;
  if (ms.value !== model) { ms.value = model; updateEfforts(); }
  if (typeof effort === 'string') keepValue($('effort'), effort, '');
  store.settings.model = ms.value;
  store.settings.effort = $('effort').value;
  markSettings(); updateStatusbar();
}

function sendUi(field, value) {
  if (!ws || ws.readyState !== ws.OPEN || !subId) return;
  ws.send(JSON.stringify({ type: 'ui', field, value }));
}

function applyRemoteUi(m) {
  const conv = convById(m.convId) || activeConv();
  if (m.field === 'draft') {
    const prev = conv ? (conv.draft || '') : '';
    if (conv) conv.draft = m.value || '';
    /* לא דורסים טקסט שאתה מקליד ברגע זה. שני מצבים כן מתעדכנים: שדה ריק,
       ושדה שמכיל *בדיוק* את הטיוטה הקודמת שהגיעה מהסנכרון — כלומר מה שרואים
       בו אינו שלך אלא הד של המכשיר השני. בלי המקרה השני הודעה שנשלחה מהמחשב
       נשארה תלויה בתיבת הטלפון: השידור המנקה הגיע, אבל התיבה כבר לא הייתה
       ריקה — ומי שהסתכל על הטלפון ראה טקסט שכבר נשלח וחיכה לשליחה. */
    if (conv && conv.id === activeId) {
      const box = $('input').value;
      if (!box || box === prev) { $('input').value = m.value || ''; autoGrow(); }
    }
    return;
  }
  if (m.field === 'title') {
    if (conv) { conv.title = m.value || conv.title; renderConvList(); if (conv.id === activeId) $('convTitle').textContent = conv.title; }
    return;
  }
  const domId = UI_FIELDS[m.field];
  if (!domId) return;
  const node = $(domId);
  if (!node || node.value === m.value) return;
  node.value = m.value || '';
  if (m.field === 'cwd') { if (conv) conv.cwd = m.value || ''; syncConvCwd(); }
  // בחירת מודל מהמכשיר השני כבר הוחלה בשרת; כאן רק מיישרים את המסך — כולל
  // רשימת רמות המאמץ, שתלויה במודל, וכולל שמירה כדי שהיא תשרוד רענון.
  if (m.field === 'model') { updateEfforts(); store.settings.model = node.value; store.settings.effort = $('effort').value; markSettings(); }
  if (m.field === 'effort') { store.settings.effort = node.value; markSettings(); }
  if (m.field === 'permissionMode') markGodPill();
  updateStatusbar();
}

/** רשימת השיחות מתעדכנת בכל המכשירים — שיחה חדשה או שינוי שם מופיעים מיד. */
function onRemoteConvMeta(meta) {
  if (!meta || !meta.id) return;
  const c = convById(meta.id);
  if (!c) {
    store.convs.unshift({ ...meta, messages: [], loaded: false });
    store.convs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    renderConvList();
    return;
  }
  // הכתיבה שלנו עצמה חוזרת כאן גם היא — מעדכנים רק אם באמת התקדמנו
  if ((meta.rev || 0) <= (c.rev || 0)) return;
  c.rev = meta.rev || 0;
  if (meta.mode) c.mode = meta.mode;
  c.title = meta.title || c.title;
  c.updatedAt = meta.updatedAt || c.updatedAt;
  c.cost = meta.cost || c.cost;
  c.ctx = meta.ctx || c.ctx;
  if (c.sessionId !== meta.sessionId && meta.sessionId) c.sessionId = meta.sessionId;
  // הגוף עצמו מגיע מזרם האירועים; קוראים מחדש רק אם השיחה הזו לא פתוחה כאן
  if (c.loaded && c.id !== activeId) c.loaded = false;
  renderConvList();
  if (c.id === activeId) updateStatusbar();
}

function onRemoteConvDeleted(id) {
  if (!convById(id)) return;
  store.convs = store.convs.filter((c) => c.id !== id);
  dirtyConvs.delete(id);
  if (activeId === id) {
    activeId = store.convs[0] ? store.convs[0].id : null;
    if (!activeId) newConv(); else subscribeActive();
    const c = activeConv();
    if (c && !c.loaded) ensureLoaded(c.id).then(() => { if (activeId === c.id) { renderConversation(); restoreDraft(); syncConvCwd(); } });
    renderConversation();
    toast('השיחה נמחקה ממכשיר אחר');
  }
  renderConvList();
}

// ---------- טיפול באירועי claude ----------
function handleEvent(evt) {
  if (!evt || !evt.type) return;
  const conv = turnConv();

  if (evt.type === 'system') {
    if (evt.subtype === 'init' && conv && evt.session_id) {
      conv.sessionId = evt.session_id;
      // מזהה סשן קריא רק לסוכן שיצר אותו, ולכן הוא נשמר יחד איתו (ראו resumeIdFor)
      conv.sessionAgent = evt.agent === 'cursor' ? 'cursor' : 'claude';
      save();
    }
    if (evt.subtype === 'thinking_tokens') { turnTok.think = evt.estimated_tokens || 0; renderWorking(); }
    // ה-CLI מנסה שוב אחרי כישלון קריאה ל-API. עד כה זה נראה על המסך כשקט
    // ארוך שאין לו הסבר — וכשהניסיונות נגמרו, כעצירה פתאומית באמצע משפט.
    if (evt.subtype === 'api_error') {
      turnRetry = { attempt: evt.retryAttempt || 0, max: evt.maxRetries || 0, at: Date.now() };
      dlog('api_error', { attempt: turnRetry.attempt, max: turnRetry.max, retryInMs: evt.retryInMs || 0 });
      renderWorking();
    }
    return;
  }

  // הזרם התאושש — הפעם הבאה שיוצא ממנו תוכן מסירה את חיווי הניסיון החוזר
  if (turnRetry && (evt.type === 'stream_event' || evt.type === 'assistant')) { turnRetry = null; renderWorking(); }

  if (evt.type === 'stream_event') { handleStream(evt.event); return; }

  // הודעת עוזר מלאה — כשאין סטרימינג חלקי (גיבוי)
  if (evt.type === 'assistant' && evt.message && !live) {
    for (const b of (evt.message.content || [])) {
      if (b.type === 'text' && b.text) { if (ensureLive()) addTextBlock(b.text, true); }
      else if (b.type === 'tool_use') { if (ensureLive()) addToolBlock(b); }
    }
    return;
  }

  // תוצאת כלי מגיעה כהודעת "user"
  if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
    for (const b of evt.message.content) if (b && b.type === 'tool_result') fillToolResult(b);
    return;
  }

  if (evt.type === 'result') {
    finalizeTurn(evt);
    return;
  }
}

// ---------- סטרימינג ----------
function handleStream(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case 'message_start': if (!ensureLive()) return; live.blocks = new Map(); turnTok.curOut = 0; break;
    case 'content_block_start': startBlock(ev.index, ev.content_block); break;
    case 'content_block_delta': deltaBlock(ev.index, ev.delta); break;
    case 'content_block_stop': stopBlock(ev.index); break;
    case 'message_delta': if (ev.usage && typeof ev.usage.output_tokens === 'number') { turnTok.curOut = ev.usage.output_tokens; renderWorking(); } break;
    case 'message_stop': turnTok.out += turnTok.curOut; turnTok.curOut = 0; persist(); break;
  }
}

function detachLiveDom() {
  if (!live) return;
  live.contentEl = null;
  for (const b of live.blocks.values()) b.el = null;
  for (const t of live.tools.values()) t.el = null;
}

function rebindLiveDom() {
  if (!live || live.convId !== activeId) return false;
  const conv = convById(live.convId);
  if (!conv) return false;
  const msgIdx = conv.messages.indexOf(live.msgObj);
  if (msgIdx < 0) return false;
  let aIdx = -1;
  for (let i = 0; i <= msgIdx; i++) if (conv.messages[i].role === 'assistant') aIdx++;
  const row = $('log').querySelectorAll('.row.assistant')[aIdx];
  if (!row) return false;
  const content = row.querySelector('.content');
  if (!content) return false;
  live.contentEl = content;
  const kids = [...content.children];
  const byRef = new Map();
  (live.msgObj.blocks || []).forEach((ref, i) => { if (kids[i]) byRef.set(ref, kids[i]); });
  for (const b of live.blocks.values()) b.el = byRef.get(b.ref) || null;
  for (const t of live.tools.values()) t.el = byRef.get(t.ref) || null;
  live.actionsEl = row.querySelector('.msg-actions');
  if (live.actionsEl) live.actionsEl.hidden = !assistantText(live.msgObj);
  watchStickHeight(content);
  return true;
}

function mountLiveDom() {
  if (!live) return;
  if (live.msgObj.blocks && live.msgObj.blocks.length && rebindLiveDom()) return;
  hideWelcome();
  const row = el('div', 'row assistant');
  const wrap = el('div', 'wrap');
  const msgObj = live.msgObj;
  wrap.innerHTML = assistantHeadHtml(msgObj.model) + '<div class="content"></div>';
  row.appendChild(wrap); $('log').appendChild(row);
  // "העתק" נחשף רק כשיש טקסט להעתיק. תור שהוא כולו כרטיס כלי או כרטיס אישור
  // הציג כפתור העתקה שלחיצה עליו לא עושה כלום. (הרינדור מהתמליל השמור כבר
  // עשה את זה נכון — רק המסלול החי לא.)
  live.actionsEl = attachMsgActions(wrap, 'assistant', () => assistantText(msgObj));
  live.actionsEl.hidden = !assistantText(msgObj);
  live.contentEl = wrap.querySelector('.content');
  watchStickHeight(live.contentEl);
  autoScroll();
}

function ensureLive() {
  const conv = turnConv();
  if (!conv) return null;
  if (!Array.isArray(conv.messages)) conv.messages = [];

  if (live && live.convId === conv.id) {
    if (activeId === conv.id && (!live.contentEl || !document.body.contains(live.contentEl))) {
      if (!rebindLiveDom()) mountLiveDom();
    }
    return live;
  }

  hideWelcome();
  // המודל נצרב בהודעה ברגע שהיא נולדת, ולא נקרא מהבורר בזמן הציור: שיחה
  // שעברה בין מודלים באמצע צריכה להראות ליד כל תשובה את מי שבאמת כתב אותה.
  const msgObj = { role: 'assistant', blocks: [], model: $('model').value || '' };
  conv.messages.push(msgObj);
  live = { convId: conv.id, msgObj, contentEl: null, blocks: new Map(), tools: new Map() };
  if (activeId === conv.id) mountLiveDom();
  persist();
  return live;
}

// חשיבה מוצפנת: חלק מהמודלים (בהם Opus 5) מחזירים בלוק thinking עם signature בלבד
// ותוכן ריק — ה-CLI לא מקבל את הטקסט, ולכן במקום כרטיס ריק מציגים כמה טוקני חשיבה הוקדשו.
function fillThink(d, ref, streaming) {
  if (!d) return;
  const has = !!(ref.text && ref.text.trim());
  const tok = ref.tokens ? `~${Number(ref.tokens).toLocaleString('he-IL')} טוקנים` : '';
  const think = d.querySelector('.think');
  if (think) {
    if (has) { think.innerHTML = streaming ? renderMdLive(ref.text) : renderMd(ref.text); if (!streaming) enhance(think); }
    else think.innerHTML = `<p class="think-empty">המודל הזה לא חושף את תוכן החשיבה${tok ? ' · ' + tok : ''}</p>`;
  }
  const prev = d.querySelector('.tprev');
  if (prev) prev.textContent = has ? clamp(ref.text.split('\n').pop(), 80) : (tok || 'ללא תוכן גלוי');
}

function startBlock(index, cb) {
  if (!ensureLive() || !cb) return;
  const canDom = !!(live.contentEl && document.body.contains(live.contentEl));
  if (cb.type === 'text') {
    const ref = { type: 'text', text: '' }; live.msgObj.blocks.push(ref);
    let box = null;
    if (canDom) { box = el('div', 'md'); live.contentEl.appendChild(box); }
    live.blocks.set(index, { type: 'text', el: box, ref });
    if (live.actionsEl) live.actionsEl.hidden = false;   // עכשיו יש מה להעתיק
  } else if (cb.type === 'thinking') {
    const ref = { type: 'thinking', text: '', tokens: 0 }; live.msgObj.blocks.push(ref);
    let d = null;
    if (canDom) {
      d = el('details', 'tool'); d.innerHTML = `<summary><span class="ticon">⋯</span><span class="tname">חשיבה</span><span class="tprev"></span><span class="chev">▸</span></summary><div class="tbody"><div class="md think"></div></div>`;
      fillThink(d, ref, true);
      live.contentEl.appendChild(d);
    }
    live.blocks.set(index, { type: 'thinking', el: d, ref });
  } else if (cb.type === 'tool_use') {
    const ref = { type: 'tool', id: cb.id, name: cb.name, input: cb.input || {}, json: '', result: null, isError: false, status: 'run' };
    live.msgObj.blocks.push(ref);
    let card = null;
    if (canDom) { card = renderToolCard(ref); live.contentEl.appendChild(card); }
    live.blocks.set(index, { type: 'tool', el: card, ref });
    if (cb.id) live.tools.set(cb.id, { ref, el: card });
  }
}

function deltaBlock(index, delta) {
  const b = live && live.blocks.get(index);
  if (!b || !delta) return;
  if (delta.type === 'text_delta') {
    b.ref.text += delta.text;
    if (b.el) { b.el.innerHTML = renderMdLive(b.ref.text); autoScroll(); }
  } else if (delta.type === 'thinking_delta') {
    b.ref.text += delta.thinking || '';
    if (typeof delta.estimated_tokens === 'number') b.ref.tokens = delta.estimated_tokens;
    if (b.el) { fillThink(b.el, b.ref, true); autoScroll(); }
  } else if (delta.type === 'input_json_delta') {
    b.ref.json += delta.partial_json || '';
  }
}

function stopBlock(index) {
  const b = live && live.blocks.get(index);
  if (!b) return;
  if (b.type === 'text') {
    if (b.el) { b.el.innerHTML = renderMd(b.ref.text); enhance(b.el); }
  } else if (b.type === 'thinking') {
    fillThink(b.el, b.ref, false);
  } else if (b.type === 'tool') {
    if (b.ref.json) { try { b.ref.input = JSON.parse(b.ref.json); } catch {} }
    if (b.el) updateToolCard(b.el, b.ref);
  }
  persist();
}

// גיבוי: הוספת בלוק טקסט מלא (ללא סטרימינג)
function addTextBlock(text, final) {
  if (!live) return;
  const ref = { type: 'text', text };
  live.msgObj.blocks.push(ref);
  if (live.contentEl) {
    const box = el('div', 'md'); box.innerHTML = renderMd(text); live.contentEl.appendChild(box);
    if (final) enhance(box);
    autoScroll();
  }
}
function addToolBlock(cb) {
  if (!live) return;
  const ref = { type: 'tool', id: cb.id, name: cb.name, input: cb.input || {}, result: null, isError: false, status: 'run' };
  live.msgObj.blocks.push(ref);
  let card = null;
  if (live.contentEl) {
    card = renderToolCard(ref); updateToolCard(card, ref); live.contentEl.appendChild(card);
    autoScroll();
  }
  if (cb.id) live.tools.set(cb.id, { ref, el: card });
}

function fillToolResult(block) {
  const t = live && live.tools.get(block.tool_use_id);
  if (!t) return;
  // השלמת הקלט מתוך התוצאה. יש כלים שהפרט המעניין בהם נולד רק כשהם מסתיימים —
  // הדיף של עריכה, למשל, אינו קיים בזמן שהכלי מתחיל לרוץ. במקום לצייר כרטיס
  // שני, הכרטיס הקיים מתעדכן במקומו.
  if (block.input_patch && typeof block.input_patch === 'object') Object.assign(t.ref.input, block.input_patch);
  // דחיית הרשאה של Cursor. היא אינה "שגיאה" אלא החלטה של מצב ההרשאות, ויש
  // עליה מה לעשות — ולכן היא מסומנת בנפרד ומקבלת כפתור ולא רק צבע אדום.
  if (block.cursor_rejected) { t.ref.rejected = block.cursor_rejected; t.ref.status = 'rej'; }
  t.ref.result = extractResult(block.content);
  t.ref.isError = !!block.is_error;
  if (!t.ref.rejected) t.ref.status = block.is_error ? 'err' : 'ok';
  if (t.el) updateToolCard(t.el, t.ref);
  persist();
}

// ---------- כרטיסי כלים ----------
const TOOL_ICON = {
  Bash: '⌘', Read: '◇', Write: '✎', Edit: '✎', MultiEdit: '✎', Glob: '◎', Grep: '◎',
  WebFetch: '◈', WebSearch: '◈', Task: '▹', TodoWrite: '☑', NotebookEdit: '▤',
  // כלים שמגיעים מ-cursor-agent ואין להם מקבילה בשם ב-Claude Code
  LS: '▤', Delete: '✕', CodebaseSearch: '◎', ReadLints: '⚑', TodoRead: '☑',
  BashInput: '⌘', BashOutput: '⌘', SwitchMode: '⇄', GenerateImage: '◨', Summarize: '▤',
};
function toolIcon(n) { return TOOL_ICON[n] || '·'; }
function toolPreview(name, i) {
  if (!i) return '';
  if (name === 'Bash') return i.command || '';
  if (i.file_path) return i.file_path;
  if (i.path) return i.path;
  if (i.pattern) return i.pattern + (i.path ? ' · ' + i.path : '');
  if (i.query) return i.query;
  if (i.url) return i.url;
  if (i.description) return i.description;
  const s = JSON.stringify(i); return s === '{}' ? '' : clamp(s, 110);
}
// כלים שהתוכן שלהם מוצג ממילא ככרטיס שאלה/תוכנית — כרטיס הכלי מיותר ורק
// מכפיל. הוא עדיין נוצר (כדי שסדר הבלוקים והצמתים יישאר זהה ל-rebindLiveDom)
// אבל מוסתר בעזרת CSS.
const SUPPRESSED_TOOL_CARDS = new Set(['AskUserQuestion', 'ExitPlanMode']);
function renderToolCard(ref) {
  const d = el('details', 'tool' + (SUPPRESSED_TOOL_CARDS.has(ref.name) ? ' tool-suppressed' : ''));
  d.innerHTML = `<summary><span class="ticon"></span><span class="tname"></span><span class="tprev"></span><span class="tstatus"></span><span class="chev">▸</span></summary><div class="tbody"></div>`;
  d.querySelector('.ticon').textContent = toolIcon(ref.name);
  d.querySelector('.tname').textContent = ref.name || 'כלי';
  updateToolCard(d, ref);
  return d;
}
function updateToolCard(d, ref) {
  if (!d || !ref) return;
  d.querySelector('.tprev').textContent = toolPreview(ref.name, ref.input);
  const st = d.querySelector('.tstatus');
  st.className = 'tstatus ' + ref.status;
  st.textContent = ref.status === 'ok' ? 'הושלם' : ref.status === 'rej' ? 'נדחה' : ref.status === 'err' ? 'שגיאה' : 'רץ…';
  const body = d.querySelector('.tbody'); body.innerHTML = '';
  renderToolBody(body, ref);
}
function renderToolBody(body, ref) {
  const i = ref.input || {};
  const label = (t) => body.appendChild(el('div', 'tlabel', t));
  const pre = (t, cls) => { const p = el('pre', cls); p.textContent = t; body.appendChild(p); return p; };

  if (ref.rejected) renderRejection(body, ref);

  if (ref.name === 'Bash') {
    label('פקודה'); pre(i.command || '', 'term');
    if (ref.result != null) { label('פלט'); pre(ref.result, 'term'); }
  } else if (ref.name === 'Edit') {
    label(i.file_path || 'עריכה'); renderDiff(body, i.old_string, i.new_string);
    if (ref.result != null && ref.isError) { label('שגיאה'); pre(ref.result); }
  } else if (ref.name === 'MultiEdit' && Array.isArray(i.edits)) {
    label(i.file_path || 'עריכות'); i.edits.forEach(e => renderDiff(body, e.old_string, e.new_string));
  } else if (ref.name === 'Write') {
    label(i.file_path || 'כתיבת קובץ'); pre(clamp(i.content || '', 4000));
  } else if (ref.name === 'TodoWrite' && Array.isArray(i.todos)) {
    renderTodos(body, i.todos);
  } else if (ref.name === 'Read') {
    label(i.file_path || 'קריאה'); if (ref.result != null) pre(clamp(ref.result, 4000));
  } else {
    if (Object.keys(i).length) { label('קלט'); pre(prettyInput(i)); }
    if (ref.result != null) { label('תוצאה'); pre(clamp(ref.result, 4000)); }
  }
}
/**
 * מה שמוצג כשמצב ההרשאות של Cursor דחה כלי.
 *
 * ב-‎--print‎ אין ל-Cursor ערוץ אישור חי: הוא דוחה, והמודל מנסה שוב עד שהוא
 * מוותר. לכן במקום כרטיס "אשר/דחה" שאין לו למי לענות, מוצג כאן מה קרה, ומה
 * שאפשר לעשות בפועל — להוסיף חוק קבוע לרשימת ההיתר של Cursor. החוק תקף מהתור
 * הבא והלאה, ולכן הכפתור מציע גם לשלוח מחדש.
 */
function renderRejection(body, ref) {
  const r = ref.rejected || {};
  const box = el('div', 'tool-rej');
  box.appendChild(el('div', 'tool-rej-head', 'מצב ההרשאות של Cursor חסם את הכלי'));
  box.appendChild(el('div', 'tool-rej-note',
    `המצב הנוכחי הוא "${(CURSOR_PERM_LABEL[r.mode] || PERM_LABEL[r.mode] || r.mode || '—')}". `
    + 'ל-cursor-agent אין כרטיס אישור חי, ולכן אישור כאן הוא חוק קבוע בהגדרות שלו.'));
  const row = el('div', 'tool-rej-row');
  if (r.rule) {
    const btn = el('button', 'tool-rej-btn', `אשר תמיד · ${r.rule}`);
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'מוסיף…';
      let res;
      try {
        const q = await fetch('/api/cursor/allow', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rule: r.rule }),
        });
        res = await q.json();
      } catch { res = null; }
      if (res && res.ok) {
        btn.textContent = res.already ? `כבר ברשימה · ${r.rule}` : `נוסף · ${r.rule}`;
        toast(`${r.rule} נוסף לרשימת ההיתר של Cursor — יחול מהתור הבא`);
      } else {
        btn.disabled = false; btn.textContent = `אשר תמיד · ${r.rule}`;
        toast((res && res.error) || 'ההוספה נכשלה', true);
      }
    };
    row.appendChild(btn);
  }
  const alt = el('button', 'tool-rej-btn ghost', 'עבור ל"הרץ הכול"');
  alt.onclick = () => {
    const sel = $('perm');
    if (![...sel.options].some((o) => o.value === 'force')) { toast('בחר מודל Cursor כדי לשנות את המצב', true); return; }
    sel.value = 'force';
    sel.dispatchEvent(new Event('change'));
    toast('מצב ההרשאות שונה ל"הרץ הכול" — שלח שוב');
  };
  row.appendChild(alt);
  box.appendChild(row);
  body.appendChild(box);
}

function renderDiff(body, oldS, newS) {
  const wrap = el('div', 'diff'); const p = el('pre');
  (oldS || '').split('\n').forEach(l => { const d = el('span', 'dl del'); d.textContent = l; p.appendChild(d); });
  (newS || '').split('\n').forEach(l => { const a = el('span', 'dl add'); a.textContent = l; p.appendChild(a); });
  wrap.appendChild(p); body.appendChild(wrap);
}
function renderTodos(body, todos) {
  const ul = el('ul', 'todo');
  todos.forEach(t => {
    const li = el('li');
    const box = el('span', 'box', t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐');
    const tx = el('span', 'st-' + (t.status || 'pending'), t.content || t.activeForm || '');
    li.appendChild(box); li.appendChild(tx); ul.appendChild(li);
  });
  body.appendChild(ul);
}
function extractResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => typeof c === 'string' ? c : (c && c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  return content == null ? '' : JSON.stringify(content, null, 2);
}
function prettyInput(i) { try { return JSON.stringify(i, null, 2); } catch { return String(i); } }

// ---------- שיפור קוד: הדגשה, העתקה, mermaid ----------
function enhance(container) {
  if (!container) return;
  container.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    if (pre.dataset.enhanced) return;
    const lang = [...code.classList].map(c => c.startsWith('language-') && c.slice(9)).find(Boolean);
    if (lang === 'mermaid') { pre.dataset.enhanced = '1'; renderMermaid(pre, code.textContent); return; }
    pre.dataset.enhanced = '1';
    try { hljs.highlightElement(code); } catch {}
    const wrap = el('div', 'code-wrap');
    pre.parentNode.insertBefore(wrap, pre); wrap.appendChild(pre);
    const btn = el('button', 'copy-btn', 'העתק');
    btn.onclick = async () => {
      const ok = await copyText(code.textContent);
      btn.textContent = ok ? 'הועתק ✓' : 'ההעתקה נכשלה';
      btn.classList.toggle('done', ok);
      setTimeout(() => { btn.textContent = 'העתק'; btn.classList.remove('done'); }, 1400);
    };
    wrap.appendChild(btn);
  });
  container.querySelectorAll('table').forEach(t => { if (!t.parentElement.classList.contains('table-wrap')) { const w = el('div', 'table-wrap'); t.parentNode.insertBefore(w, t); w.appendChild(t); } });
  container.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
}
let mermaidMod = null, mermaidTry = false;
async function renderMermaid(pre, code) {
  const box = el('div', 'mermaid-box'); pre.replaceWith(box);
  try {
    if (!mermaidMod && !mermaidTry) { mermaidTry = true; mermaidMod = (await import('/vendor/mermaid/mermaid.esm.min.mjs')).default; mermaidMod.initialize({ startOnLoad: false, theme: isDark() ? 'dark' : 'default' }); }
    if (!mermaidMod) throw 0;
    const { svg } = await mermaidMod.render('mm' + uid(), code);
    box.innerHTML = svg;
  } catch { box.innerHTML = ''; const p = el('pre'); p.textContent = code; box.appendChild(p); }
  autoScroll(); // גובה הדיאגרמה משתנה אחרי await — לשמור על מעקב אם stick פעיל
}

// ---------- סיום תור ----------
function finalizeTurn(result) {
  const conv = turnConv();
  // לפני ש-live מתאפס: מה ש-GOD אישר בתור הזה הופך לכרטיס בסוף ההודעה
  pushGodBlock();
  if (conv) {
    if (result.session_id) conv.sessionId = result.session_id;
    if (typeof result.total_cost_usd === 'number') conv.cost = (conv.cost || 0) + result.total_cost_usd;
    const u = result.usage || {};
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    let win = 200000;
    for (const k in (result.modelUsage || {})) win = Math.max(win, result.modelUsage[k].contextWindow || 0);
    conv.ctx = { used, win, dur: result.duration_ms || 0 };
    save();
  }
  live = null;
  streamOwnerId = null;
  turnRetry = null;
  setBusy(false);
  updateStatusbar();
  renderConvList();
  refreshUsage(); // התור צרך מכסה — נרענן את המונים
  // סיום תור כשהחלון ברקע — קל מאוד לפספס. מסמנים בכותרת ובהתראה. כשיש עוד
  // פרומפטים בתור העבודה לא באמת נגמרה, ולכן אין על מה להתריע.
  if (!document.hasFocus() && !msgQueue.length) {
    const who = AGENT_LABEL[(conv && conv.sessionAgent) || activeAgent()] || 'Claude';
    setTitleBadge(who + ' סיים');
    desktopNotify(who + ' סיים לעבוד', clamp((conv && conv.title) || '', 60), { vibrate: HAPTIC_DONE });
  }
  // השיגור של הפריט הבא בתור נעשה בשרת — כאן רק מחכים לפריים user_msg שלו
}

// ---------- שרשור פרומפטים ----------
// שולחים פרומפט בזמן שהמודל עובד → הוא נכנס לתור בשרת ומשוגר מיד כשהתור
// הנוכחי מסתיים. אפשר לשרשר כמה שרוצים, לנעול את הטלפון וללכת.
function sendQueueCmd(type, extra) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify({ type, ...(extra || {}) }));
  return true;
}
function clearQueue() {
  if (!msgQueue.length) return;
  msgQueue = [];
  renderQueue();
  sendQueueCmd('queue_clear');
}
/** עדכון מהשרת — התור השתנה (כאן, במכשיר אחר, או ששוגר הפריט הבא) */
function onQueueUpdate(items) {
  msgQueue = Array.isArray(items) ? items : [];
  renderQueue();
  renderLimitBar();   // הפס מונה כמה פרומפטים ימשיכו אחרי ההמשך
}
function renderQueue() {
  const strip = $('queueStrip');
  if (!strip) return;
  strip.innerHTML = '';
  strip.classList.toggle('hidden', msgQueue.length === 0);
  if (!msgQueue.length) return;
  // כותרת קצרה עם המניין — בטלפון הרצועה נגללת ולא תמיד רואים את כולה
  const head = el('div', 'q-head');
  head.appendChild(el('span', 'q-count', `${msgQueue.length} בתור`));
  const clr = el('button', 'q-clear', 'נקה');
  clr.type = 'button'; clr.title = 'בטל את כל הפרומפטים הממתינים';
  clr.onclick = () => clearQueue();
  head.appendChild(clr);
  strip.appendChild(head);
  msgQueue.forEach((q, i) => {
    const chip = el('div', 'q-chip');
    chip.appendChild(el('span', 'q-ic', String(i + 1)));
    const label = q.text ? clamp(q.text, 60)
      : (q.images ? `${q.images} תמונות` : (q.atts && q.atts.length ? `${q.atts.length} קבצים מצורפים` : 'פרומפט'));
    const txt = el('span', 'q-text', label);
    txt.title = q.text || label;
    chip.appendChild(txt);
    const rm = el('button', 'q-rm', '×');
    rm.type = 'button'; rm.title = 'הסר מהתור'; rm.setAttribute('aria-label', 'הסר מהתור');
    rm.onclick = () => sendQueueCmd('queue_remove', { id: q.id });
    chip.appendChild(rm);
    strip.appendChild(chip);
  });
}

// ---------- פעולות על הודעה (העתקה / עריכה) ----------
function assistantText(msg) {
  return (msg && msg.blocks || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim();
}
function attachMsgActions(container, kind, getText, msg) {
  const bar = el('div', 'msg-actions');
  const copy = el('button', 'ma-btn'); copy.title = 'העתק'; copy.innerHTML = '<span>⧉</span> העתק';
  copy.onclick = async () => {
    const t = getText(); if (!t) return;
    const ok = await copyText(t);
    copy.innerHTML = ok ? '<span>✓</span> הועתק' : '<span>✕</span> נכשל';
    copy.classList.toggle('done', ok);
    setTimeout(() => { copy.innerHTML = '<span>⧉</span> העתק'; copy.classList.remove('done'); }, 1400);
  };
  bar.appendChild(copy);
  if (kind === 'user') {
    // עריכה = חזרה אמיתית לנקודה זו (fork של הסשן): מוחקים את ההודעה ומה שאחריה,
    // טוענים אותה לעריכה, וה-CLI ממשיך מהסשן החתוך — כאילו התור לא קרה.
    const ed = el('button', 'ma-btn'); ed.title = 'חזור לנקודה זו וערוך מחדש'; ed.innerHTML = '<span>↩</span> ערוך';
    ed.onclick = () => rewindToMessage(msg, getText);
    bar.appendChild(ed);
  }
  container.appendChild(bar);
  return bar;
}

// חזרה לנקודה קודמת בשיחה: fork בצד השרת → המשך עם --resume על הסשן החתוך
async function rewindToMessage(msg, getText) {
  const conv = activeConv();
  if (!conv) return;
  if (busy) { toast('עצור את התשובה הפעילה לפני חזרה', true); return; }
  // החזרה לנקודה קודמת עובדת בכך שהשרת מפצל את קובץ הסשן של ה-CLI. בצ'אט
  // אנונימי אין קובץ כזה — וזו הנקודה, לא מגבלה שכדאי לעקוף.
  if (conv.anon) { toast('בצ׳אט אנונימי אין קובץ סשן לחזור אליו — ההקשר חי רק בתהליך הרץ', true); return; }
  if (!conv.sessionId) { toast('אפשר לחזור רק אחרי שהתחילה שיחה', true); return; }
  // הפיצול נעשה על קובץ ה-JSONL של Claude. Cursor שומר את השיחה ב-SQLite
  // משלו ואין לו מקבילה לחיתוך לא-הרסני, ולכן כאן זו פעולה *אחרת*: התמליל
  // נחתך כרגיל, אבל ההקשר של Cursor לא נחתך איתו — הוא ננטש, והשיחה ממשיכה
  // בסשן חדש. זה הפרש שהמשתמש חייב לדעת עליו מראש ולא לגלות אחרי.
  if ((conv.sessionAgent || 'claude') === 'cursor') {
    const ok = confirm(
      'ל-Cursor אין פיצול סשן לא-הרסני.\n\n'
      + 'אפשר לחתוך את התמליל כאן ולהתחיל סשן Cursor חדש מהנקודה הזו — '
      + 'אבל ההקשר הקודם של המודל לא יעבור איתו, והוא יתחיל מאפס.\n\n'
      + 'להמשיך?');
    if (!ok) return;
    let idx2 = msg ? conv.messages.indexOf(msg) : -1;
    if (idx2 < 0) { toast('לא נמצאה ההודעה', true); return; }
    conv.messages = conv.messages.slice(0, idx2);
    conv.sessionId = null;          // סשן חדש ייווצר בהודעה הבאה
    conv.sessionAgent = 'cursor';
    save(); renderConversation(); renderConvList();
    $('input').value = (getText && getText()) || (msg && msg.text) || '';
    autoGrow(); $('input').focus();
    addNote('התמליל נחתך וסשן Cursor חדש יתחיל מכאן — בלי ההקשר הקודם.');
    return;
  }
  // סדר ההודעה בין הודעות המשתמש = ה-ordinal שהשרת סופר בקובץ הסשן
  let idx = msg ? conv.messages.indexOf(msg) : -1;
  if (idx < 0) { toast('לא נמצאה ההודעה', true); return; }
  const ordinal = conv.messages.slice(0, idx).filter((m) => m.role === 'user').length;
  const text = (getText && getText()) || (msg && msg.text) || '';
  let res;
  try {
    const r = await fetch('/api/fork', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: $('cwd').value, sessionId: conv.sessionId, promptOrdinal: ordinal }),
    });
    res = await r.json();
  } catch { res = null; }
  if (!res || !res.ok || !res.newSessionId) { toast('החזרה נכשלה', true); return; }
  conv.messages = conv.messages.slice(0, idx); // מוחקים את ההודעה ואת כל מה שאחריה
  conv.sessionId = res.newSessionId;
  conv.ctx = null;
  // משחררים את התהליך הנוכחי — השליחה הבאה תפעיל --resume על הסשן החתוך
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'end' }));
  clearQueue();
  conv.draft = text;
  save(); renderConversation(); renderConvList();
  const i = $('input'); i.value = text; autoGrow(); i.focus(); i.setSelectionRange(i.value.length, i.value.length);
  toast('חזרת לנקודה זו — ערוך ושלח מחדש');
}

// ---------- הודעות משתמש / הערות ----------
function addUserMessage(text, atts) {
  const conv = convById(streamOwnerId) || activeConv();
  if (!conv) return;
  if (!Array.isArray(conv.messages)) conv.messages = [];
  const msg = { role: 'user', text };
  if (atts && atts.length) msg.atts = atts.map(a => ({ kind: a.kind, name: a.name, path: a.path })); // אחסון קל — בלי ה-blob
  conv.messages.push(msg);
  if (activeId !== conv.id) { persist(); return; } // מדפדפים בשיחה אחרת — רק store
  hideWelcome();
  const row = el('div', 'row user'); const wrap = el('div', 'wrap'); const col = el('div', 'u-col');
  const b = el('div', 'bubble');
  if (text) b.appendChild(document.createTextNode(text));
  if (atts && atts.length) b.appendChild(renderMsgAtts(atts));
  col.appendChild(b); attachMsgActions(col, 'user', () => msg.text || '', msg);
  wrap.appendChild(col); row.appendChild(wrap); $('log').appendChild(row);
  watchStickHeight(row);
  autoScroll(true);
}
function addNote(text, err) {
  const n = el('div', 'note' + (err ? ' err' : ''), text); $('log').appendChild(n); autoScroll();
}

/* ==========================================================================
   כרטיס עצירה
   --------------------------------------------------------------------------
   התשובה שנקטעת באמצע משפט בלי מילה אחת של הסבר הייתה התקלה הכי מבלבלת
   בממשק — לא בגלל שה-CLI שתק, אלא בגלל שהמסך זרק בדיוק את מה שהוא אמר.
   מכאן והלאה כל עצירה שאיננה סיום תקין נכנסת לתמליל ככרטיס: כותרת בעברית,
   הטקסט המקורי של ה-CLI, וקישור ליומן. הכרטיס נשמר בקובץ השיחה, ולכן הוא
   עדיין שם כשחוזרים לשיחה למחרת.
   ========================================================================== */
const HALT_HINT = {
  stalled: 'הזרם מהשרת נפסק באמצע. התוכן שנכתב עד כאן שלם — שליחת "המשך" תמשיך מאותה נקודה.',
  api_error: 'תקלה זמנית בצד השרת. בדרך כלל מספיק לשלוח שוב.',
  refusal: 'המודל סירב להשלים את הבקשה. ניסוח אחר או מודל אחר יעקפו את זה.',
  max_tokens: 'התשובה הגיעה לתקרת האורך של תור בודד. בקשה להמשיך תשלים אותה.',
  max_turns: 'התור מיצה את מספר סבבי הכלים המותר. שליחת "המשך" פותחת תור חדש.',
  budget_exhausted: 'תקציב הריצה שהוגדר ל-CLI נגמר.',
  permission_denied: 'כלי נדחה, והמודל לא יכול היה להמשיך בלעדיו.',
  interrupted: 'התור הופסק — כאן, ממכשיר אחר, או בסגירת התהליך.',
  cancelled: 'התור בוטל לפני שהסתיים.',
};

function renderHaltCard(ref) {
  const card = el('div', 'halt' + (ref.soft ? ' soft' : ''));
  const head = el('div', 'halt-head');
  head.innerHTML = `<span class="halt-ic" aria-hidden="true">${ref.soft ? '⏸' : '⚠'}</span><b></b>`;
  head.querySelector('b').textContent = ref.title || 'התור נעצר';
  card.appendChild(head);

  const hint = HALT_HINT[ref.reason];
  if (hint) card.appendChild(el('div', 'halt-hint', hint));

  if (ref.detail) {
    const d = el('details', 'halt-more');
    d.innerHTML = '<summary>מה ה-CLI אמר</summary>';
    const pre = el('pre', 'halt-detail'); pre.dir = 'ltr'; pre.textContent = ref.detail;
    d.appendChild(pre);
    card.appendChild(d);
  }

  const foot = el('div', 'halt-foot');
  const meta = [ref.reason, ref.model || null, ref.at ? new Date(ref.at).toLocaleTimeString('he-IL') : null]
    .filter(Boolean).join(' · ');
  foot.appendChild(el('span', 'halt-meta', meta));
  const logs = el('button', 'halt-btn', 'פתח יומן');
  logs.type = 'button';
  logs.title = 'היומן המלא של הרגע שבו התור נעצר';
  logs.onclick = () => openLogs('turn.halt|cli.');
  foot.appendChild(logs);
  card.appendChild(foot);
  return card;
}

/** פריים halt מהשרת — נכנס לתמליל של התור שנעצר, לא רק כהודעה חולפת. */
function onHalt(m) {
  const ref = {
    type: 'halt', reason: m.reason || 'error', title: m.title || 'התור נעצר',
    detail: m.detail || '', soft: !!m.soft, model: m.model || '', at: m.at || Date.now(),
  };
  dlog('halt', { reason: ref.reason, soft: ref.soft, model: ref.model });
  // ensureLive מבטיח שיש הודעת עוזר לתלות עליה — גם לתור שנפל לפני מילה אחת
  if (!ensureLive()) { addNote(ref.title, !ref.soft); return; }
  live.msgObj.blocks.push(ref);
  if (live.contentEl && document.body.contains(live.contentEl)) {
    live.contentEl.appendChild(renderHaltCard(ref));
    autoScroll();
  }
  persist();
  if (!ref.soft) toast(ref.title, true);
}

// ---------- שליחה ----------
// שיגור מהתור נעשה בשרת, ולכן כאן נשארה רק הדרך האחת: מה שהוקלד בתיבה
async function sendMessage(text) {
  // ההודעה יוצאת — אין למי להכתיב. חשוב שזה יקרה *לפני* קריאת התיבה, כדי
  // שתוצאת ביניים שעדיין לא נסגרה תיכנס לטקסט הנשלח ולא תיזרק.
  if (dictOn) dictStop();
  text = (text != null ? text : $('input').value).trim();
  const atts = pendingAtts.slice();
  if (!text && !atts.length) { toast('כתוב הודעה או צרף תמונה'); return; }
  // פקודת-לקוח שנכתבה ביד (בלי תפריט ההשלמה) נתפסת גם כאן, אחרת היא הייתה
  // נשלחת למודל כטקסט
  const cc = !atts.length && text.match(/^(\/[\w-]+)(?:\s+([\s\S]*))?$/);
  if (cc && CLIENT_CMDS[cc[1]]) {
    clearComposer();
    CLIENT_CMDS[cc[1]]((cc[2] || '').trim());
    return;
  }
  if (!ws || ws.readyState !== ws.OPEN) { toast('אין חיבור לשרת', true); return; }
  let conv = activeConv(); if (!conv) conv = newConv();
  // אם גוף השיחה עדיין נקרא מהדיסק, הטעינה שתסתיים אחר כך תדרוס את ההודעה
  // שנוסיף כאן — לכן מחכים לה קודם.
  if (!conv.loaded) { await ensureLoaded(conv.id); if (activeConv() !== conv) return; }
  // עסוק, או ממתין לחידוש מכסה — לשרשר במקום לשגר. השרת ישגר את הפרומפט
  // ברגע שהתור הנוכחי יסתיים (או שהמכסה תתחדש), גם אם החלון כאן סגור.
  if (busy || limitState) {
    if (busy && streamOwnerId && conv.id !== streamOwnerId) {
      toast('עצור את התשובה בשיחה הפעילה לפני שליחה', true);
      return;
    }
    // התמונות עולות לפני הכניסה לתור, כדי שהפריט שממתין יהיה שלם ולא תלוי
    // בכך שהחלון הזה יישאר פתוח עד שיגיע תורו
    if (atts.length) {
      try { await Promise.all(atts.map(a => a.ready)); } catch {}
      if (atts.some(a => a.status === 'err')) { toast('חלק מהתמונות לא הועלו — נסה שוב', true); return; }
    }
    const images = atts.filter(a => a.data).map(a => ({ media_type: a.media, data: a.data }));
    subscribeActive();   // התור נשמר על הסשן בשרת, ולכן חייב מנוי פעיל
    const ok = sendQueueCmd('queue_add', {
      text, images,
      atts: atts.map((a) => ({ kind: a.kind, name: a.name, path: a.path })),
      cwd: $('cwd').value, model: $('model').value, effort: $('effort').value,
      permissionMode: $('perm').value, resumeSessionId: resumeIdFor(conv),
      tools: !!conv.tools,   // בצ'אט אנונימי: האם הכלים הופעלו במפורש
    });
    if (!ok) { toast('אין חיבור לשרת', true); return; }
    // היסטוריית הפרומפטים (חץ למעלה) נשמרת בקובץ ההגדרות שבדיסק — כלומר היא
    // עקבה לכל דבר. מה שנכתב בצ'אט אנונימי לא נכנס אליה.
    if (text && !conv.anon) { if (!Array.isArray(store.history)) store.history = []; store.history.unshift(text); store.history = store.history.slice(0, 50); histIdx = -1; }
    clearPendingAtts();
    clearComposer();
    return;
  }
  // כותרת נגזרת מההודעה הראשונה. בצ'אט אנונימי היא הייתה מציגה את תוכן השיחה
  // ברשימה הצדדית ובכותרת החלון — ולכן הכותרת שם נשארת קבועה וחסרת תוכן.
  if (!conv.anon && conv.title === 'שיחה חדשה' && conv.messages.filter(m => m.role === 'user').length === 0) { conv.title = clamp(text || 'תמונה מצורפת', 42); }
  conv.updatedAt = Date.now();
  conv.cwd = $('cwd').value;
  conv.draft = '';
  streamOwnerId = conv.id;

  // המתנה לסיום העלאת התמונות (אם יש)
  if (atts.length) {
    setBusy(true); const wt = $('workingText'); if (wt) wt.textContent = 'מעלה תמונות…';
    try { await Promise.all(atts.map(a => a.ready)); } catch {}
    if (atts.some(a => a.status === 'err')) {
      streamOwnerId = null; setBusy(false);
      toast('חלק מהתמונות לא הועלו — נסה שוב', true);
      return;
    }
  }

  live = null;
  // התמונות נשלחות כבלוקי base64 שהמודל רואה ישירות (הנתיב בצ'יפ הוא לתצוגה בלבד)
  const images = atts.filter(a => a.data).map(a => ({ media_type: a.media, data: a.data }));
  // ההודעה לא מצוירת כאן אלא כשההד חוזר מהשרת. מסלול רינדור אחד לכל המכשירים
  // מבטיח שהמסך בטלפון ובמחשב זהה; ה-nonce מחזיר לנו את הקבצים המקומיים כדי
  // שהתצוגה המקדימה של התמונות לא תאבד בדרך.
  const nonce = uid();
  pendingSends.set(nonce, atts);
  setTimeout(() => pendingSends.delete(nonce), 30000);
  subscribeActive();
  ws.send(JSON.stringify({
    type: 'user', text, images, nonce,
    atts: atts.map((a) => ({ kind: a.kind, name: a.name, path: a.path })),
    conversationId: conv.id, resumeSessionId: resumeIdFor(conv),
    cwd: $('cwd').value, model: $('model').value, effort: $('effort').value, permissionMode: $('perm').value,
    tools: !!conv.tools,   // בצ'אט אנונימי: האם הכלים הופעלו במפורש
  }));
  if (text && !conv.anon) {
    if (!Array.isArray(store.history)) store.history = [];
    store.history.unshift(text); store.history = store.history.slice(0, 50); histIdx = -1;
  }
  clearComposer();
  clearPendingAtts();
  ensureNotifyPermission();
  setBusy(true); save(); renderConvList();
}

/**
 * כפתור השליחה נשאר פעיל גם בזמן עבודה — אז לחיצה מוסיפה לשרשרת במקום לשגר.
 * אותו דבר בזמן המתנה לחידוש מכסה: מה שתשלח ירוץ כשהעבודה תתחדש.
 */
function syncSendAffordance() {
  const chaining = busy || !!limitState;
  const btn = $('sendBtn');
  btn.classList.toggle('queueing', chaining);
  // title ו-aria-label יחד: בטלפון אין hover, וקורא מסך חייב לשמוע את מצב התור
  // ולא להישאר על «שלח» הסטטי מ-index.html.
  btn.title = limitState ? 'הוסף לתור — ירוץ כשהמכסה תתחדש' : chaining ? 'הוסף לתור' : 'שלח';
  btn.setAttribute('aria-label', btn.title);
}

function setBusy(state) {
  const was = busy;
  busy = state;
  syncSendAffordance();
  $('working').classList.toggle('hidden', !state);
  // מחלקה גלובלית שמפעילה את כל האינדיקטורים הבולטים (פס עליון, זוהר, תווית)
  document.body.classList.toggle('busy', state);
  // הפסיל עובר דרך setStatus — כך סיום תור בזמן ניתוק לא יכתוב «מוכן»/«מחובר» בשקר
  if (state) setStatus('busy', 'עובד…');
  else if (wsConnected()) setStatus('on', 'מחובר');
  else setStatus('', 'מנותק');
  if (state) { resetTurnTok(); godTurn = []; renderWorking(); }
  // מעבר busy→פנוי = התור הסתיים: הבזק "הסתיים" בולט
  if (was && !state) { flashDone(); haptic(HAPTIC_DONE); }
  syncWakeLock();
}

/* ==========================================================================
   נעילת מסך בזמן תור
   --------------------------------------------------------------------------
   בטלפון, תור ארוך פירושו לרוב לשים את המכשיר בצד ולחכות. המסך נכבה, ובאנדרואיד
   ואייפון זה גם הרגע שבו הדף מושהה: ה-WebSocket נסגר, ומה שחוזר אליו כשפותחים
   שוב הוא מסלול ההתחברות-מחדש וההשלמה — שעובד, אבל הצפייה החיה בעבודה פשוט
   אבדה באמצע. הנעילה מבקשת מהמערכת לא לכבות את המסך כל עוד יש תור *וכל עוד
   מסתכלים*: הדפדפן משחרר אותה מעצמו ברגע שהלשונית מוסתרת, ולכן אין כאן שום
   סכנה של מסך שנשאר דלוק בכיס. היא נלקחת שוב בחזרה ללשונית, אם התור עוד רץ.

   רק במגע: במחשב כיבוי המסך אינו משהה את הדף, ואין שום תקלה שהנעילה פותרת —
   רק שומר מסך שמפסיק לעבוד בלי שביקשו.
   ========================================================================== */
let wakeLock = null;
const wakeLockWanted = () => busy && !document.hidden
  && 'wakeLock' in navigator && matchMedia('(pointer: coarse)').matches;

async function syncWakeLock() {
  if (!wakeLockWanted()) {
    if (wakeLock) { const w = wakeLock; wakeLock = null; try { await w.release(); } catch {} }
    return;
  }
  if (wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // המערכת משחררת בעצמה (מסך שנכבה בכל זאת, סוללה חלשה) — בלי הניקוי הזה
    // ‎wakeLock‎ היה נשאר מלא ומונע כל ניסיון לקחת אותה שוב.
    wakeLock.addEventListener('release', () => { wakeLock = null; }, { once: true });
    dlog('wakelock', { on: true });
  } catch (e) {
    // סירוב אינו תקלה: אין הרשאה, הסוללה נמוכה, או שהמשתמש כיבה את זה במערכת
    wakeLock = null;
    dlog('wakelock.fail', { err: String((e && e.message) || e) });
  }
}
document.addEventListener('visibilitychange', syncWakeLock);

/** הבזק ירוק גדול "✓ הסתיים" כשהמודל מסיים תור — סימן חיובי חד־משמעי */
let doneFlashT = null;
function flashDone() {
  const b = document.body;
  b.classList.remove('just-done');
  void b.offsetWidth; // אתחול אנימציה
  b.classList.add('just-done');
  clearTimeout(doneFlashT);
  doneFlashT = setTimeout(() => b.classList.remove('just-done'), 2600);
}

// ---------- שמירה/רינדור טרנסקריפט ----------
function persist() { save(); }

function renderConversation() {
  stickRo.disconnect();
  findState = { q: '', marks: [], idx: -1 };   // ה-DOM נבנה מחדש — הסימונים כבר לא תקפים
  updateFindCount();
  const keepLive = !!(busy && live && streamOwnerId);
  if (keepLive) detachLiveDom();
  else live = null;

  const log = $('log'); log.innerHTML = '';
  const conv = activeConv();
  applyAnonMode();   // הפס והסימון הגלובלי נגזרים מהשיחה שמצוירת עכשיו
  $('convTitle').textContent = conv ? conv.title : 'שיחה חדשה';
  updateCwdChip();
  // דואט הוא מסך אחר לגמרי: תוצר למעלה, מהלך עבודה למטה, ובלי תיבת כתיבה —
  // מה שנשלח שם נשלח בכפתורים של הריצה ולא כהודעה חופשית.
  log.classList.toggle('duet', isDuet(conv));
  document.body.classList.toggle('duet-mode', isDuet(conv));
  if (isDuet(conv)) { renderDuet(conv, log); updateStatusbar(); return; }
  if (conv && !conv.loaded) {
    // גוף השיחה עדיין נקרא מהדיסק — שלד קצר במקום קפיצה לברכת הפתיחה
    const sk = el('div', 'conv-loading');
    sk.appendChild(el('span', 'spinner sm'));
    sk.appendChild(el('span', null, 'טוען את השיחה…'));
    log.appendChild(sk);
    updateStatusbar();
    return;
  }
  if (!conv || conv.messages.length === 0) {
    showWelcome();
    if (keepLive && activeId === streamOwnerId && live) rebindLiveDom();
    updateStatusbar();
    return;
  }
  for (const m of conv.messages) {
    if (m.role === 'user') {
      const row = el('div', 'row user'); const wrap = el('div', 'wrap'); const col = el('div', 'u-col');
      const b = el('div', 'bubble');
      if (m.text) b.appendChild(document.createTextNode(m.text));
      if (m.atts && m.atts.length) b.appendChild(renderMsgAtts(m.atts));
      col.appendChild(b); attachMsgActions(col, 'user', () => m.text || '', m);
      wrap.appendChild(col); row.appendChild(wrap); log.appendChild(row);
    } else if (m.role === 'assistant') {
      const row = el('div', 'row assistant'); const wrap = el('div', 'wrap');
      wrap.innerHTML = assistantHeadHtml(m.model) + '<div class="content"></div>';
      const content = wrap.querySelector('.content');
      for (const b of (m.blocks || [])) {
        if (b.type === 'text') { const box = el('div', 'md'); box.innerHTML = renderMd(b.text); content.appendChild(box); enhance(box); }
        else if (b.type === 'thinking') { const d = el('details', 'tool'); d.innerHTML = `<summary><span class="ticon">⋯</span><span class="tname">חשיבה</span><span class="tprev"></span><span class="chev">▸</span></summary><div class="tbody"><div class="md think"></div></div>`; fillThink(d, b, false); content.appendChild(d); }
        else if (b.type === 'tool') { content.appendChild(renderToolCard(b)); }
        else if (b.type === 'ask') { content.appendChild(renderAskCard(b)); }
        else if (b.type === 'halt') { content.appendChild(renderHaltCard(b)); }
        else if (b.type === 'god') { content.appendChild(renderGodCard(b)); }
      }
      if (assistantText(m)) attachMsgActions(wrap, 'assistant', () => assistantText(m));
      row.appendChild(wrap); log.appendChild(row);
    }
  }
  hideWelcome();
  if (keepLive && activeId === streamOwnerId && live) rebindLiveDom();
  updateStatusbar(); requestAnimationFrame(() => autoScroll(true));
}

// ---------- סרגל שיחות: חיפוש · קיבוץ לפי זמן · חותמת זמן · שינוי-שם ----------
let convQuery = '';
const convTime = (c) => c.updatedAt || c.createdAt || 0;
function convBucket(ts) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  if (ts >= startToday) return 0;
  if (ts >= startToday - day) return 1;
  if (ts >= startToday - 6 * day) return 2;
  return 3;
}
const BUCKET_LABEL = ['היום', 'אתמול', '7 הימים האחרונים', 'קודם'];
function shortAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts; if (d < 0) return 'עכשיו';
  const m = Math.floor(d / 60000), h = Math.floor(m / 60), day = Math.floor(h / 24);
  if (day >= 1) return day + 'ימ׳';
  if (h >= 1) return h + 'ש׳';
  if (m >= 1) return m + 'ד׳';
  return 'עכשיו';
}
// חיפוש: כותרות נבדקות מיד מהאינדקס שבזיכרון, ובמקביל השרת סורק את גוף כל
// השיחות שבדיסק (כולל כאלה שמעולם לא נטענו לדפדפן) ומחזיר התאמות + קטע הקשר.
let searchHits = null;   // Map(convId → snippet) או null כשאין חיפוש פעיל
const runServerSearch = debounce(async (q) => {
  if (!q || q.length < 2) { searchHits = null; renderConvList(); return; }
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q));
    const d = await r.json();
    if (convQuery.trim().toLowerCase() !== q) return;   // התוצאה כבר לא רלוונטית
    searchHits = new Map((d.results || []).map((x) => [x.id, x.snippet || '']));
  } catch { searchHits = null; }
  renderConvList();
}, 220);
function onConvSearch() {
  renderConvList();
  runServerSearch(convQuery.trim().toLowerCase());
}
function convMatches(c, q) {
  if (!q) return true;
  if ((c.title || '').toLowerCase().includes(q)) return true;
  if (searchHits && searchHits.has(c.id)) return true;
  return (c.messages || []).some(m => (m.text || '').toLowerCase().includes(q) ||
    (m.blocks || []).some(b => (b.text || '').toLowerCase().includes(q)));
}
function startRename(c, item, titleEl) {
  const inp = el('input', 'c-rename'); inp.value = c.title || '';
  item.replaceChild(inp, titleEl); inp.focus(); inp.select();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const v = inp.value.trim();
    // כותרת של 400 תווים הופכת את הסרגל העליון ל־2–3 גליפים ב־360px.
    // השרת גוזר ל־200; כאן גוזרים קודם כדי שהמסך והדיסק לא יסתרו.
    if (v) c.title = clamp(v, 80);
    markDirty(c); renderConvList();
    if (c.id === activeId) $('convTitle').textContent = c.title;
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; renderConvList(); } };
  inp.onblur = commit;
  inp.onclick = (e) => e.stopPropagation();
}
function renderConvList() {
  const list = $('convList'); list.innerHTML = '';
  const q = convQuery.trim().toLowerCase();
  const convs = store.convs.filter(c => convMatches(c, q)).sort((a, b) => convTime(b) - convTime(a));
  if (!convs.length) { list.appendChild(el('div', 'conv-empty', q ? 'לא נמצאו שיחות' : 'אין שיחות עדיין')); return; }
  let lastBucket = -1;
  for (const c of convs) {
    const bucket = convBucket(convTime(c));
    if (bucket !== lastBucket) { list.appendChild(el('div', 'conv-group', BUCKET_LABEL[bucket])); lastBucket = bucket; }
    const item = el('div', 'conv' + (c.id === activeId ? ' active' : '') + (c.anon ? ' anon' : ''));
    const t = el('span', 'c-title', c.title || 'שיחה'); item.appendChild(t);
    if (c.anon) { const b = el('span', 'c-anon', 'לא נשמר'); b.title = 'צ׳אט אנונימי — קיים רק בזיכרון. כל מעבר ממנו מוחק אותו, בלי דרך לחזור'; item.appendChild(b); }
    // הסוכן מסומן רק כשהוא אינו ברירת המחדל: כך הסימון אומר משהו, במקום
    // להופיע על כל שורה ולהפוך לרקע. הוא גם מסביר מראש למה "המשך" בשיחה הזו
    // ידרוש מודל Cursor — מזהה סשן אינו קביל אצל הסוכן השני.
    if (c.sessionAgent === 'cursor') {
      const b = el('span', 'c-agent', 'Cursor');
      b.title = 'שיחה של cursor-agent — המשך שלה דורש מודל Cursor';
      item.appendChild(b);
    }
    item.appendChild(el('span', 'c-time', shortAgo(convTime(c))));
    const del = el('button', 'c-del', '×'); del.title = 'מחק שיחה';
    del.onclick = (e) => { e.stopPropagation(); deleteConv(c.id); };
    item.appendChild(del);
    // closeDrawer לפני switchConv ולא בתוכו: בחירה בשיחה שכבר פעילה יוצאת
    // מ-switchConv מיד, והמגירה נשארה פתוחה בדיוק כשהתכוונת לחזור אל השיחה.
    item.onclick = () => { closeDrawer(); switchConv(c.id); };
    if (!c.anon) {
      t.ondblclick = (e) => { e.stopPropagation(); startRename(c, item, t); };
      t.title = 'לחיצה כפולה לשינוי שם';
    } else {
      t.title = 'צ׳אט אנונימי — הכותרת קבועה, כדי שתוכן השיחה לא יופיע ברשימה';
    }
    list.appendChild(item);
    // קטע ההקשר שהשרת מצא בגוף השיחה — מראה למה השיחה הזו תואמת
    const snip = searchHits && searchHits.get(c.id);
    if (q && snip) {
      const s = el('div', 'conv-snip', snip);
      s.onclick = () => { closeDrawer(); switchConv(c.id); };
      list.appendChild(s);
    }
  }
}
async function switchConv(id) {
  if (id === activeId) return;
  if (dictOn) dictStop();             // העוגן שייך לטיוטה של השיחה שעוזבים
  if (!leaveAnon(id)) return;         // עזיבת צ'אט אנונימי מוחקת אותו; ביטול = נשארים
  stashDraft();                       // הטיוטה של השיחה הנוכחית נשמרת לפני המעבר
  // תור רץ בשיחה אחרת: ה־UI של busy נשאר, אבל התמליל כבר של השיחה החדשה —
  // בלי משוב זה נראה כמו מסך שבור. לא חוסמים את המעבר (לגיטימי לבדוק שיחה
  // אחרת), רק אומרים איפה העבודה ממשיכה.
  if (busy && streamOwnerId && streamOwnerId !== id) {
    const owner = convById(streamOwnerId);
    const name = owner && owner.title ? clamp(owner.title, 40) : 'שיחה אחרת';
    const n = msgQueue.length;
    toast(n ? `עדיין רץ ב«${name}» · ${n} בתור` : `עדיין רץ ב«${name}»`);
  }
  // התור וההמתנה למכסה שייכים לשיחה שעזבנו. מנקים מיד ולא מחכים ל-sync,
  // אחרת הצ'יפים של השיחה הקודמת נראים לרגע כאילו הם של החדשה.
  if (limitState) {
    const owner = streamOwnerId && convById(streamOwnerId);
    const name = owner && owner.title ? clamp(owner.title, 40) : '';
    toast(name ? `המתנה למכסה ממשיכה ב«${name}»` : 'המתנה למכסה ממשיכה בשיחה הקודמת');
  }
  onQueueUpdate([]);
  setLimitState(null);
  duetRun = null; duetLive = null; duetDom = null; duetViewV = 0; duetVerCache.clear();
  activeId = id;
  subscribeActive();                  // מנוי על זרם השיחה החדשה בשרת
  markSettings();
  renderConvList();
  renderConversation();               // מציג שלד אם השיחה עוד לא נטענה מהדיסק
  const c = convById(id);
  if (c && !c.loaded) { await ensureLoaded(id); if (activeId === id) renderConversation(); }
  if (activeId === id) { restoreDraft(); syncConvCwd(); renderQueue(); }
  closeDrawer();
}
function deleteConv(id) {
  // אנונימית: אין קובץ למחוק, ויש מסלול ניקוי משלה (תהליך + זיכרון בשני הצדדים)
  const anon = convById(id);
  if (anon && anon.anon) { endAnon(); return; }
  if (busy && id === streamOwnerId) {
    interruptTurn();
    abandonTurn();
  }
  store.convs = store.convs.filter(c => c.id !== id);
  dirtyConvs.delete(id);
  fetch('/api/conversations/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
  if (activeId === id) activeId = store.convs[0] ? store.convs[0].id : null;
  if (!activeId) newConv();
  const c = activeConv();
  if (c && !c.loaded) ensureLoaded(c.id).then(() => { if (activeId === c.id) { renderConversation(); restoreDraft(); syncConvCwd(); } });
  markSettings(); renderConversation(); renderConvList();
}

// ---------- סרגל סטטוס ----------
function updateStatusbar() {
  const conv = activeConv();
  const model = $('model').value;
  const mName = modelName(model) || ($('model').selectedOptions[0] && $('model').selectedOptions[0].textContent) || 'מודל ברירת מחדל';
  // שם המודל לבדו אינו אומר איזה סוכן רץ — 'Claude Opus 5' קיים בשתי הרשימות.
  // עד כה זה נאמר בקידומת "Cursor · " שאכלה מרוחב השורה; עכשיו זה התג הפינתי
  // שעל הסימן, והשם נשאר השם.
  //
  // הפריט נבנה מחדש רק כשהמודל באמת התחלף: שורת המצב מתרעננת גם על כל עדכון
  // עלות והקשר שמגיע בזמן תור, ואין טעם לפרסר SVG מחדש בכל אחד מהם.
  const sb = $('sbModel');
  const label = model ? mName : 'מודל ברירת מחדל';
  if (sb._bmModel !== model || sb._bmLabel !== label) {
    sb._bmModel = model; sb._bmLabel = label;
    sb.innerHTML = brandMarkHtml(model, 15) + `<span class="sb-model-name">${escHtml(label)}</span>`;
    sb.title = brandTitle(model);
  }
  // בחירה שהגיעה ממכשיר אחר או מסנכרון שיחה משנה את הבורר ישירות, בלי אירוע
  // change — הנקודה הזו היא המקום שדרכו כולן עוברות, ולכן התווית מתיישרת כאן.
  if ($('model')._mpSync) $('model')._mpSync();
  $('sbCost').textContent = fmtCost(conv ? conv.cost : 0);
  // פריט בלי נתון נעלם לגמרי במקום להציג "—", שנקרא כמו תקלה ולא כמו מצב ריק
  const ctxEl = $('sbContext'), turnEl = $('sbTurn');
  const hasCtx = !!(conv && conv.ctx && conv.ctx.win);
  if (hasCtx) {
    const pct = Math.min(100, Math.round(conv.ctx.used / conv.ctx.win * 100));
    ctxEl.textContent = `הקשר ${pct}% · ${fmtTok(conv.ctx.used)}/${fmtTok(conv.ctx.win)}`;
    ctxEl.className = 'sb-item' + (pct >= 85 ? ' hot' : pct >= 65 ? ' warn' : '');
  }
  ctxEl.classList.toggle('hidden', !hasCtx);
  const dur = hasCtx && conv.ctx.dur;
  if (dur) turnEl.textContent = (conv.ctx.dur / 1000).toFixed(1) + ' שנ׳';
  turnEl.classList.toggle('hidden', !dur);
  markStatusSeparators();
}

/* המפריד "·" שייך לפריט שיש לפניו פריט *נראה*. ב-CSS אי אפשר לשאול "מי האח
   הנראה הקודם", ובטלפון #sbModel ו-#sbTurn מוסתרים ב-media query ולא במחלקה —
   ולכן הכלל הקודם השאיר "·" יתום לפני העלות. getComputedStyle תופס את שניהם. */
function markStatusSeparators() {
  const bar = $('statusbar');
  if (!bar) return;
  let seenVisible = false;
  for (const el of bar.children) {
    const shown = getComputedStyle(el).display !== 'none';
    el.classList.toggle('sep', shown && seenVisible);
    if (shown) seenVisible = true;
  }
}

// ---------- ניצול מכסת החשבון (סשן · שבועי · Fable/scoped) ----------
function fmtReset(iso) {
  if (!iso) return '';
  const ms = new Date(iso) - Date.now();
  if (isNaN(ms)) return '';
  if (ms <= 0) return 'מתאפס עכשיו';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `מתאפס בעוד ${d} ימים ו־${h % 24} שע׳`;
  if (h >= 1) return `מתאפס בעוד ${h} שע׳ ${m} דק׳`;
  return `מתאפס בעוד ${m} דק׳`;
}
function fmtResetAbsolute(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return '';
  // מחזור החיוב של Cursor חודשי: "מתאפס יום ג׳ 00:00" על תאריך שבעוד שלושה
  // שבועות אינו מזהה שום דבר. מעבר לשבוע עוברים לתאריך.
  const far = t - Date.now() > 6 * 864e5;
  try {
    return 'מתאפס ' + t.toLocaleString('he-IL', far
      ? { day: 'numeric', month: 'long' }
      : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return fmtReset(iso);
  }
}
function usageLevel(pct) {
  if (typeof pct !== 'number') return 0;
  return pct >= 90 ? 2 : pct >= 70 ? 1 : 0;
}
function planLabel(p) {
  if (!p) return '';
  const map = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return map[String(p).toLowerCase()] || p;
}
function usageWindowsFromPayload(u) {
  if (Array.isArray(u.windows) && u.windows.length) return u.windows;
  const out = [];
  if (u.five_hour && typeof u.five_hour.pct === 'number') {
    out.push({ id: 'session', kind: 'session', label: 'סשן נוכחי', pct: u.five_hour.pct, resets_at: u.five_hour.resets_at || null });
  }
  if (u.seven_day && typeof u.seven_day.pct === 'number') {
    out.push({ id: 'weekly', kind: 'weekly_all', label: 'כל המודלים', pct: u.seven_day.pct, resets_at: u.seven_day.resets_at || null });
  }
  return out;
}
/* ‎Cursor‎ מדווח אחוזים קטנים מאוד (0.14%, 3.63%), ועיגול לשלם הופך אותם
   ל‎"0%"‎ ול‎"4%"‎ — הראשון שקר גמור והשני מנפח. מתחת ל-10% מציגים ספרה אחת. */
function fmtUsagePct(raw, precise) {
  const v = Math.max(0, typeof raw === 'number' && isFinite(raw) ? raw : 0);
  if (!precise || v === 0 || v >= 10) return Math.round(v) + '%';
  return (Math.round(v * 10) / 10) + '%';
}
/**
 * מד אחד. ‎opts.precise‎ — אחוז עם ספרה עשרונית בערכים קטנים,
 * ‎opts.sliver‎ — רוחב מזערי לפס כשיש שימוש שקטן מכדי להיראות,
 * ‎opts.sub‎ — שורת משנה תחת מד אחר (קטן יותר, מודגש פחות).
 */
function renderUsageMeter(w, absoluteReset, opts = {}) {
  const raw = Math.max(0, typeof w.pct === 'number' && isFinite(w.pct) ? w.pct : 0);
  const level = usageLevel(raw);
  const row = el('div', 'um-meter' + (level === 2 ? ' hot' : level === 1 ? ' warn' : '') + (opts.sub ? ' um-sm' : ''));
  const meta = el('div', 'um-meta');
  const shown = CURSOR_WINDOW_NAMES[w.id] || w.label || '—';
  meta.appendChild(el('div', 'um-label', shown));
  let sub = '';
  // התנאי על הערך הגולמי ולא על המעוגל: 0.14% הוא שימוש, גם אם הוא מציג 0%.
  if (w.kind === 'weekly_scoped' && raw === 0) sub = `עדיין לא השתמשת ב־${shown}`;
  else if (w.resets_at) sub = absoluteReset ? fmtResetAbsolute(w.resets_at) : fmtReset(w.resets_at);
  // ‎detail‎ מגיע רק ממכסת Cursor: שם האחוז לבדו חסר משמעות ("47%" ממה?)
  if (w.detail) sub = sub ? `${w.detail} · ${sub}` : w.detail;
  meta.appendChild(el('div', 'um-sub', sub));
  const track = el('div', 'um-track');
  const fill = el('span', 'um-fill' + (opts.sliver && raw > 0 ? ' on' : ''));
  fill.style.width = Math.min(100, raw) + '%';
  track.appendChild(fill);
  row.appendChild(meta);
  row.appendChild(track);
  row.appendChild(el('div', 'um-pct', fmtUsagePct(raw, opts.precise) + ' בשימוש'));
  return row;
}
/* ==========================================================================
   מכסה: שני סוכנים, מד אחד
   --------------------------------------------------------------------------
   Claude ו-Cursor מדווחים על מכסה בסכמות שונות לגמרי — חלונות של חמש שעות
   ושבוע מול מחזור חיוב חודשי — אבל השרת כבר משטח את שניהם לאותו ‎windows[]‎,
   ולכן כאן אין ולו פונקציית ציור אחת שיודעת במי מדובר. מה שכן מחזיק את ההבדל
   הוא הצבע: ‎--src‎ נקבע פעם אחת על הרצועה ועל כל קטע בחלון, וכל השאר יורש.

   הרצועה הקומפקטית מציגה סוכן אחד (השבב מחליף ביניהם, והבחירה נשמרת), והחלון
   הצף מציג תמיד את שניהם — שם יש מקום, ושם משווים.
   ========================================================================== */
const USAGE_SOURCES = ['claude', 'cursor'];
/* המספרים ש‎Cursor‎ מחזיר חיים בקצה התחתון של הסולם — אחוזים בודדים של
   מחזור חיוב שלם — ולכן המדים שלו מקבלים דיוק עשרוני ופס נראה גם בשבריר אחוז. */
const CURSOR_METER = { precise: true, sliver: true };
const CURSOR_TOTAL_ID = 'cursor-included';
const CURSOR_PART_IDS = ['cursor-api', 'cursor-auto'];
/* שמות התצוגה לפי מזהה — לא לפי ‎short‎ שבמטמון. כך שינוי השם חל מיד,
   גם אם הרצועה עדיין מחזיקה «כללי» / «אוטו» / «גרוק» מתשובה ישנה. */
const CURSOR_WINDOW_NAMES = {
  'cursor-api': 'מודלים כלליים',
  'cursor-auto': 'מודלים של קרסר',
  'cursor-grok-bot': 'גרוק בוט',
};
let usageData = { claude: null, cursor: null };

function usageSource() {
  const s = store.settings && store.settings.usageSource;
  return USAGE_SOURCES.includes(s) ? s : 'claude';
}
const usageSourceName = (s) => (s === 'cursor' ? 'Cursor' : 'Claude');

function setUsageSource(src) {
  if (!USAGE_SOURCES.includes(src)) src = 'claude';
  store.settings.usageSource = src;
  save();
  renderComposerUsage();
}

/** החלונות של סוכן אחד, מכל צורת תשובה שהיא. */
function usageWindowsOf(src, u) {
  if (!u) return [];
  if (src === 'cursor') return Array.isArray(u.windows) ? u.windows : [];
  return usageWindowsFromPayload(u);
}

/** מה שנכנס לרצועה: סשן קודם, ואז שבועי כללי + מודלים בניצול משמעותי (לא להציף). */
function stripWindows(src, u) {
  const windows = usageWindowsOf(src, u);
  if (src === 'cursor') {
    // מודלים כלליים קודמים — זה המד שהמשתמש ביקש לראות במקום הסה״כ המעורב.
    // הסה״כ (‎cursor-included‎ בלי ‎detail‎) מוסתר גם אם המטמון הישן עוד נושא אותו.
    const general = windows.filter((w) => w.id === 'cursor-api');
    const auto = windows.filter((w) => w.id === 'cursor-auto');
    const bot = windows.filter((w) => w.id === 'cursor-grok-bot');
    const unlimited = windows.filter((w) => w.id === CURSOR_TOTAL_ID && w.detail);
    const rest = windows.filter((w) =>
      w.id !== 'cursor-api' && w.id !== 'cursor-auto' && w.id !== 'cursor-grok-bot' && w.id !== CURSOR_TOTAL_ID);
    // מודלים של קרסר אחרונים: השם ארוך, והוא מקבל שורה שלמה בתחתית התיבה.
    return [...general, ...bot, ...auto, ...unlimited, ...rest].slice(0, 3);
  }
  const session = windows.filter((w) => w.kind === 'session');
  const weekly = windows.filter((w) => w.kind === 'weekly_all');
  const scoped = windows
    .filter((w) => w.kind === 'weekly_scoped' && typeof w.pct === 'number' && w.pct > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 2);
  return [...session, ...weekly, ...scoped];
}

function compactUsageLabel(w) {
  if (!w) return '—';
  if (CURSOR_WINDOW_NAMES[w.id]) return CURSOR_WINDOW_NAMES[w.id];
  if (w.short) return w.short;
  if (w.kind === 'session') return 'סשן';
  if (w.kind === 'weekly_all') return 'שבועי';
  return w.label || 'מודל';
}
function renderComposerUsageMeter(w, opts = {}) {
  const raw = Math.max(0, typeof w.pct === 'number' && isFinite(w.pct) ? w.pct : 0);
  const level = usageLevel(raw);
  const row = el('div', 'cu-row'
    + (level === 2 ? ' hot' : level === 1 ? ' warn' : '')
    + (w.id === 'cursor-auto' ? ' cu-span' : ''));
  const top = el('div', 'cu-top');
  top.appendChild(el('div', 'cu-label', compactUsageLabel(w)));
  top.appendChild(el('div', 'cu-pct', fmtUsagePct(raw, opts.precise)));
  row.appendChild(top);
  const track = el('div', 'cu-track');
  const fill = el('span', 'cu-fill' + (opts.sliver && raw > 0 ? ' on' : ''));
  fill.style.width = Math.min(100, raw) + '%';
  track.appendChild(fill);
  row.appendChild(track);
  let sub = '';
  if (w.detail) sub = w.detail;
  else if (w.kind === 'session' && w.resets_at) sub = fmtReset(w.resets_at);
  else if (w.resets_at) sub = fmtResetAbsolute(w.resets_at);
  if (sub) row.appendChild(el('div', 'cu-sub', sub));
  return row;
}

/** הרצועה שמתחת לתיבה — הסוכן שנבחר בלבד. */
function renderComposerUsage() {
  const host = $('composerUsageMeters');
  const strip = $('composerUsage');
  const chip = $('usageSrcToggle');
  const open = $('usageOpen');
  if (!host || !strip || !chip || !open) return;

  const src = usageSource();
  const other = src === 'claude' ? 'cursor' : 'claude';
  const shown = stripWindows(src, usageData[src]);

  const mopts = src === 'cursor' ? CURSOR_METER : {};
  host.innerHTML = '';
  for (const w of shown) host.appendChild(renderComposerUsageMeter(w, mopts));
  if (!shown.length) host.appendChild(el('div', 'cu-empty', `אין נתוני מכסה מ-${usageSourceName(src)}`));

  const maxLevel = shown.reduce((m, w) => Math.max(m, usageLevel(w.pct)), 0);
  strip.classList.remove('src-claude', 'src-cursor');
  strip.classList.add('src-' + src);
  strip.classList.toggle('warn', maxLevel === 1);
  strip.classList.toggle('hot', maxLevel === 2);
  // הרצועה נעלמת רק כששני הסוכנים ריקים: אם הסתרנו אותה בגלל צד ריק, השבב —
  // הדרך היחידה לחזור לצד המלא — היה נעלם איתה.
  strip.classList.toggle('hidden', !USAGE_SOURCES.some((s) => stripWindows(s, usageData[s]).length));

  chip.dataset.src = src;
  chip.textContent = usageSourceName(src);
  chip.title = `החלף לתצוגת המכסה של ${usageSourceName(other)}`;
  chip.setAttribute('aria-label', chip.title);

  const tip = shown.map((w) => `${compactUsageLabel(w)} ${fmtUsagePct(w.pct, mopts.precise)}`).join(' · ');
  open.title = tip ? `לחץ לפירוט שתי המכסות · ${tip}` : 'לחץ לפירוט מגבלות הניצול';
}

function renderClaudeUsage(u) {
  const sessionHost = $('usageSessionBlock');
  const weeklyBlock = $('usageWeeklyBlock');
  const weeklyHost = $('usageWeeklyMeters');
  if (!sessionHost || !weeklyHost || !weeklyBlock) return;

  const windows = usageWindowsOf('claude', u);
  const session = windows.filter((w) => w.kind === 'session');
  const weekly = windows.filter((w) => w.kind !== 'session');

  sessionHost.innerHTML = '';
  for (const w of session) sessionHost.appendChild(renderUsageMeter(w, false));

  weeklyHost.innerHTML = '';
  for (const w of weekly) weeklyHost.appendChild(renderUsageMeter(w, true));
  weeklyBlock.hidden = weekly.length === 0;

  const empty = $('usageClaudeEmpty');
  if (empty) empty.hidden = windows.length > 0;

  const planEl = $('usagePlan');
  const label = planLabel(u && u.plan);
  if (planEl) { planEl.textContent = label || ''; planEl.hidden = !label; }
}

/* ---------- קטע Cursor בחלון הצף ----------
   Cursor מודד שני דליים נפרדים באותו מחזור חודשי: מודלים כלליים ומודלים
   של קרסר. הסה״כ המעורב
   אינו מוצג — הוא אינו תקרה. מה שנמדד במחזור אחר לגמרי (Grok Bot השבועי,
   חיוב לפי שימוש) מקבל כותרת משלו. תאריך האיפוס של המחזור עולה אל הכותרת:
   הוא נכון לקבוצה ולא לשורה אחת. */
function renderCursorUsage(u) {
  const host = $('usageCursorMeters');
  if (!host) return;
  const windows = usageWindowsOf('cursor', u);

  host.innerHTML = '';
  const pools = CURSOR_PART_IDS.map((id) => windows.find((w) => w.id === id)).filter(Boolean);
  const unlimited = windows.find((w) => w.id === CURSOR_TOTAL_ID && w.detail) || null;
  const rest = windows.filter((w) => !CURSOR_PART_IDS.includes(w.id) && w.id !== CURSOR_TOTAL_ID);

  if (unlimited || pools.length) {
    const group = el('section', 'ug');
    const head = el('h4', 'usage-sec', 'שימוש כלול');
    const resetAt = (unlimited && unlimited.resets_at) || (pools.find((w) => w.resets_at) || {}).resets_at || '';
    const when = resetAt ? fmtResetAbsolute(resetAt) : '';
    if (when) head.appendChild(el('span', 'ug-when', when));
    group.appendChild(head);

    if (unlimited) {
      const lead = { ...unlimited };
      if (when) lead.resets_at = null;
      group.appendChild(renderUsageMeter(lead, true, CURSOR_METER));
    }
    for (const w of pools) {
      const row = { ...w };
      if (when) row.resets_at = null;
      group.appendChild(renderUsageMeter(row, true, CURSOR_METER));
    }
    if (pools.length > 1) {
      group.appendChild(el('p', 'ug-note', 'כל דלי נמדד מול תקרה משלו — האחוזים לא מסתכמים זה בזה.'));
    }
    host.appendChild(group);
  }

  if (rest.length) {
    const group = el('section', 'ug');
    // כותרת רק כשיש ממה להבדיל — אחרת זו כותרת מעל כל מה שיש.
    if (host.childElementCount) group.appendChild(el('h4', 'usage-sec', 'מכסות נפרדות'));
    for (const w of rest) group.appendChild(renderUsageMeter(w, true, CURSOR_METER));
    host.appendChild(group);
  }

  const empty = $('usageCursorEmpty');
  if (empty) {
    empty.hidden = !!(unlimited || pools.length || rest.length);
    empty.textContent = !u
      ? 'לא הצלחנו לקרוא את המכסה מ-Cursor.'
      : u.connected
        ? 'אין כרגע מספרים להצגה — ייתכן שהתוכנית לא מונה בקשות, או שהדשבורד לא ענה.'
        : 'לא מחובר ל-Cursor. הריצו cursor-agent login, או הדביקו את עוגיית WorkosCursorSessionToken אל CURSOR_SESSION_TOKEN בקובץ .env.';
  }

  const planEl = $('usageCursorPlan');
  const label = (u && u.plan) || '';
  if (planEl) { planEl.textContent = label; planEl.hidden = !label; }
}

function paintUsage() {
  renderClaudeUsage(usageData.claude);
  renderCursorUsage(usageData.cursor);
  renderComposerUsage();
}

const getJSON = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

async function refreshUsage() {
  const [claude, cursor] = await Promise.all([getJSON('/api/usage'), getJSON('/api/usage/cursor')]);
  usageData = { claude, cursor };
  paintUsage();
}

/* ---------- המתנה לחידוש מכסת הסשן ----------
   השרת מזהה שהתור נעצר בגלל חלון חמש השעות (ולא בגלל החלון השבועי — שם המתנה
   לא תעזור), ומחזיק את ההמשך. כאן רק מציגים את ההמתנה ומאפשרים לקצר או לבטל
   אותה. הספירה לאחור מתעדכנת מקומית כדי שהפס לא ייראה תקוע. */
let limitTicker = null;

function fmtCountdown(ms) {
  if (ms <= 0) return 'עוד רגע';
  const total = Math.ceil(ms / 60000);
  const h = Math.floor(total / 60), m = total % 60;
  if (h >= 1) return `בעוד ${h} שע׳${m ? ` ו־${m} דק׳` : ''}`;
  return `בעוד ${m} דק׳`;
}

function renderLimitBar() {
  const bar = $('limitBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !limitState);
  if (!limitState) return;
  const left = (limitState.resetsAt || 0) - Date.now();
  $('limitBarTitle').textContent = 'מכסת הסשן נגמרה — העבודה תימשך לבד';
  const when = limitState.resetsAt ? fmtCountdown(left) : 'ברגע שהמכסה תתחדש';
  const queued = msgQueue.length ? ` · ${msgQueue.length} פרומפטים ממתינים אחריו` : '';
  $('limitBarSub').textContent = `ממשיכים מהנקודה שבה נעצרנו ${when}${queued}`;
}

function setLimitState(limit) {
  const had = !!limitState;
  limitState = limit || null;
  renderLimitBar();
  syncSendAffordance();
  if (limitState && !limitTicker) limitTicker = setInterval(renderLimitBar, 30000);
  if (!limitState && limitTicker) { clearInterval(limitTicker); limitTicker = null; }
  // מתריעים רק על עצירה *טרייה*. אותו מצב מגיע שוב בכל sync — רענון דף או
  // פתיחת הטלפון לא אמורים לצלצל על משהו שקרה לפני שעתיים.
  const fresh = limitState && !had && Date.now() - (limitState.at || 0) < 2 * 60 * 1000;
  if (fresh) {
    // עצירה כזו קורית בדרך כלל כשלא מסתכלים על המסך — לכן גם התראה
    toast('מכסת הסשן נגמרה — נמשיך אוטומטית כשהיא תתחדש');
    setTitleBadge('ממתין למכסה');
    desktopNotify('Claude נעצר — מכסת הסשן נגמרה', 'העבודה תימשך אוטומטית כשהמכסה תתחדש');
  }
}

/** מגבלה שאין עליה המשך אוטומטי — שבועית, או כזו שלא הצלחנו לאשר */
function onWeeklyLimit(m) {
  if (m.scope === 'weekly') {
    const when = m.resetsAt ? ' ' + fmtResetAbsolute(new Date(m.resetsAt).toISOString()) : '';
    addNote(`המכסה השבועית נגמרה${when}. אין המשך אוטומטי — חלון הסשן לא ישחרר אותה.`, true);
    toast('המכסה השבועית נגמרה', true);
    return;
  }
  addNote('התור נעצר בשגיאה שנראית כמו מגבלת מכסה, אבל לא הצלחנו לאמת אותה. השרשרת מוקפאת כדי לא לשרוף את שאר הפרומפטים — שליחת פרומפט חדש תחזיר אותה לתנועה.', true);
  toast('השרשרת הוקפאה — מגבלה לא מאומתת', true);
}

function onLimitResumed(m) {
  addNote(m.manual ? 'ממשיכים לפי בקשתך…' : 'המכסה התחדשה — ממשיכים מהנקודה שבה נעצרנו.');
  toast(m.manual ? 'ממשיכים' : 'המכסה התחדשה — ממשיכים');
  clearTitleBadge();
}

function isUsageModalOpen() { return $('usageModal') && !$('usageModal').classList.contains('hidden'); }
function setUsageModalOpen(open) {
  const modal = $('usageModal');
  const strip = $('composerUsage');
  const btn = $('usageOpen');
  if (!modal) return;
  modal.classList.toggle('hidden', !open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (strip) strip.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) {
    refreshUsage();
    const close = $('usageModalClose');
    if (close) close.focus();
  }
}
function toggleUsageModal() { setUsageModalOpen(!isUsageModalOpen()); }

// ---------- גלילה חכמה (stick-to-bottom) ----------
// עוקבים אחרי הכתיבה כל עוד המשתמש בתחתית.
// התערבות ידנית (גלגלת למעלה / מגע / פס גלילה) מנתקת — עד חזרה לתחתית או לחיצה על ↓.
// היסטרזיס: שחרור ב־RELEASE, חיבור מחדש רק ב־ATTACH (מונע נעילה כשמנסים לברוח).
const STICK_RELEASE = 80;
const STICK_ATTACH = 8;
let stick = true;
let scrollProg = false;   // גלילה שלנו — לא לפרש כהתערבות משתמש
let scrollRaf = 0;
let stickCheckRaf = 0;

function logEl() { return $('log'); }
function distFromBottom(log) {
  return log.scrollHeight - log.scrollTop - log.clientHeight;
}
function syncJumpBtn() {
  $('jumpBtn').classList.toggle('hidden', stick);
}

/** מעדכן stick לפי מרחק מהתחתית (עם היסטרזיס). */
function applyStickDistance(d) {
  if (stick) {
    if (d > STICK_RELEASE) stick = false;
  } else if (d <= STICK_ATTACH) {
    stick = true;
  }
}

/** גלילה לתחתית אם stick פעיל. force=true מאפשר מחדש (הודעת משתמש / קפיצה). */
function autoScroll(force) {
  if (force) stick = true;
  if (!stick) { syncJumpBtn(); return; }
  if (scrollRaf) return; // מאחדים עשרות text_delta לפריים אחד
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!stick) { syncJumpBtn(); return; }
    const log = logEl();
    scrollProg = true;
    log.scrollTop = log.scrollHeight;
    // משחררים אחרי שאירועי scroll הפרוגרמטיים הסתדרו
    requestAnimationFrame(() => { scrollProg = false; });
    syncJumpBtn();
  });
}

function reevaluateStick() {
  if (stickCheckRaf) return;
  stickCheckRaf = requestAnimationFrame(() => {
    stickCheckRaf = 0;
    if (scrollProg) return;
    applyStickDistance(distFromBottom(logEl()));
    syncJumpBtn();
  });
}

const logNode = logEl();

// גלילה פרוגרמטית לא משנה stick; גלילת משתמש כן
logNode.addEventListener('scroll', () => {
  if (scrollProg) return;
  applyStickDistance(distFromBottom(logNode));
  syncJumpBtn();
}, { passive: true });

// ניתוק מיידי בגלילה למעלה — בלי חיבור מחדש אוטומטי באותה תנועה
logNode.addEventListener('wheel', (e) => {
  if (e.deltaY < 0) {
    stick = false;
    syncJumpBtn();
    return;
  }
  reevaluateStick();
}, { passive: true });

// מגע: מעקב אחרי כיוון ההחלקה
let touchY0 = null;
logNode.addEventListener('touchstart', (e) => {
  touchY0 = e.touches[0] ? e.touches[0].clientY : null;
}, { passive: true });
logNode.addEventListener('touchmove', (e) => {
  if (touchY0 == null || !e.touches[0]) return;
  // אצבע למטה ⇒ התוכן עולה ⇒ המשתמש בורח מהתחתית
  if (e.touches[0].clientY - touchY0 > 8) {
    stick = false;
    syncJumpBtn();
    return;
  }
  reevaluateStick();
}, { passive: true });
logNode.addEventListener('touchend', () => { touchY0 = null; }, { passive: true });

// מקלדת בתוך אזור השיחה
logNode.addEventListener('keydown', (e) => {
  if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
    stick = false;
    syncJumpBtn();
    return;
  }
  if (e.key === 'PageDown' || e.key === 'End' || e.key === 'ArrowDown') reevaluateStick();
}, { passive: true });

// גובה משתנה אחרי סטרימינג/mermaid/כרטיסים — ממשיכים לעקוב רק אם stick
const stickRo = new ResizeObserver(() => {
  if (stick) autoScroll();
  else syncJumpBtn();
});
function watchStickHeight(node) {
  if (node) stickRo.observe(node);
}

$('jumpBtn').onclick = () => {
  stick = true;
  const log = logEl();
  scrollProg = true;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    scrollProg = false;
    syncJumpBtn();
  };
  if (reduce) {
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(done);
  } else {
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    log.addEventListener('scrollend', done, { once: true });
    setTimeout(done, 700); // רשת ביטחון אם scrollend לא נתמך
  }
  $('jumpBtn').classList.add('hidden');
};

// ---------- welcome ----------
const svgIc = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const SUGGESTS = [
  { ic: svgIc('<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>'), text: 'סקור את הקוד', insert: 'סקור את הקוד ב-@' },
  { ic: svgIc('<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.5"/><path d="M12 17.2h.01"/>'), text: 'מצא ותקן באג', insert: 'מצא ותקן באגים בפרויקט. התחל מ-' },
  { ic: svgIc('<circle cx="12" cy="12" r="7.5"/><path d="M8.5 12.3l2.4 2.4 4.6-5"/>'), text: 'כתוב בדיקות', insert: 'כתוב בדיקות ל-@' },
  { ic: svgIc('<circle cx="12" cy="12" r="7.5"/><path d="M9.8 9.6a2.3 2.3 0 1 1 2.9 2.6v1.3"/><path d="M12.7 16.6h.01"/>'), text: 'הסבר איך זה עובד', insert: 'הסבר לי איך עובד ' },
];
function showWelcome() {
  const log = $('log');
  if (log.querySelector('.welcome')) return;
  const w = el('div', 'welcome');
  // הסימן במסך הפתיחה הוא של המודל שהשיחה תיפתח איתו — עוד לפני המילה
  // הראשונה כבר רואים עם מי מתחילים.
  const hm = $('model').value;
  w.innerHTML = `<div class="hero"><div class="sun bmark-tint" style="${brandVars(hm)}">`
    + `${brandMarkHtml(hm, 60)}</div><h1></h1></div>`;
  w.querySelector('.hero .sun').title = brandTitle(hm);
  w.querySelector('h1').textContent = greeting();
  const sg = el('div', 'suggests');
  for (const s of SUGGESTS) {
    const b = el('button', 'suggest');
    b.innerHTML = `<span class="s-ic">${s.ic}</span>${escHtml(s.text)}`;
    b.onclick = () => {
      const i = $('input'); i.value = s.insert; autoGrow(); i.focus();
      i.setSelectionRange(i.value.length, i.value.length);
      if (/@$/.test(s.insert)) updateAc(); // פתיחת בורר הקבצים מיד אם ההמלצה מסתיימת ב-@
    };
    sg.appendChild(b);
  }
  w.querySelector('.hero').appendChild(sg);
  log.appendChild(w);
}
function hideWelcome() { const w = $('log').querySelector('.welcome'); if (w) w.remove(); }

// ---------- toasts ----------
function toast(text, err) {
  const t = el('div', 'toast' + (err ? ' err' : ''), text); $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 4200);
}

// ---------- קלט ----------
let histIdx = -1;

/**
 * האם הטקסט דורש ‎compose-tall‎.
 *
 * חשוב: ההחלטה לפי רוחב החריץ *הצר* (שורה אחת בין כפתורים), לא לפי
 * ‎scrollHeight‎ הנוכחי. אחרת: ברוחב הצר הטקסט נשבר → tall → ברוחב המלא
 * הוא שוב שורה אחת → יורדים מ-tall → שוב צר → לולאה אינסופית.
 *
 * ‎textW‎ / ‎narrowSlot‎ בפיקסלים של תוכן (בלי ריפוד). ‎currentlyTall‎ נותן
 * היסטרזיס קטן כדי לא לרפרף על סף המדידה.
 *
 * הסף לכניסה הוא ‎narrowSlot - 2‎ ולא ‎narrowSlot + 4‎: מרווח לכיוון החיובי
 * פירושו טקסט שכבר חורג מהחריץ ועדיין מוצג בו — כלומר נשבר לשתי שורות בין
 * הכפתורים, שזה בדיוק המראה שהמצב הזה בא למנוע. שגיאת מדידה קיימת (מדידת
 * קנבס מול פריסה אמיתית), ולכן המרווח נשאר — רק בכיוון הבטוח: להקדים
 * בשני פיקסלים זה בלתי נראה, לאחר בפיקסל אחד זה שורה שבורה.
 */
function composeTallDecision(textW, narrowSlot, currentlyTall, hasNewline) {
  if (hasNewline) return true;
  if (!(textW > 0) || !(narrowSlot > 0)) return false;
  if (currentlyTall) return textW > narrowSlot - 16;
  return textW > narrowSlot - 2;
}

/** רוחב החריץ הצר לתיבה בשורת compact — card פחות כפתורים ורווחים. */
function composeNarrowSlotPx(input) {
  const card = input.closest('.composer-card');
  if (!card) return Math.max(0, input.clientWidth);
  const gap = 6;
  const pad = (() => {
    const s = getComputedStyle(card);
    return (parseFloat(s.paddingLeft) || 0) + (parseFloat(s.paddingRight) || 0);
  })();
  let btn = 0, n = 0;
  for (const id of ['micBtn', 'attachBtn', 'sendBtn']) {
    const el = $(id);
    if (!el || el.classList.contains('hidden')) continue;
    const w = el.getBoundingClientRect().width;
    btn += w > 0 ? w : (id === 'sendBtn' ? 38 : 34);
    n++;
  }
  // mic · attach · [חריץ] · send — n כפתורים ⇒ n רווחים סביב החריץ ביניהם
  return Math.max(48, card.clientWidth - pad - btn - gap * Math.max(n, 1));
}

function inputTextWidthPx(input) {
  const raw = input.value;
  if (!raw) return 0;
  // שורה אחת לוגית למדידה: רווחים מנורמלים; \n מטופל בנפרד ב-shouldComposeTall
  const v = raw.replace(/\s+/g, ' ').trim();
  if (!v) return 0;
  const cs = getComputedStyle(input);
  const ctx = inputTextWidthPx._ctx
    || (inputTextWidthPx._ctx = document.createElement('canvas').getContext('2d'));
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`.trim();
  return ctx.measureText(v).width;
}

function shouldComposeTall(input) {
  const v = input.value;
  if (!v) return false;
  const hasNewline = v.includes('\n');
  const cs = getComputedStyle(input);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const slot = composeNarrowSlotPx(input) - padX;
  const tw = hasNewline ? 0 : inputTextWidthPx(input);
  return composeTallDecision(tw, slot, document.body.classList.contains('compose-tall'), hasNewline);
}

const TALL_MS = 340;
const TALL_EASE = 'cubic-bezier(.22, .72, .18, 1)';

function visibleBox(el) {
  if (!el || el.classList.contains('hidden')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function ghostAt(el, rect) {
  const g = el.cloneNode(true);
  g.classList.add('cc-ghost');
  g.removeAttribute('id');
  g.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  Object.assign(g.style, {
    position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    margin: '0', zIndex: '25', pointerEvents: 'none',
    boxSizing: 'border-box', overflow: 'hidden',
  });
  document.body.appendChild(g);
  return g;
}

function flipTo(el, first, last, origin) {
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = last.width ? first.width / last.width : 1;
  const sy = last.height ? first.height / last.height : 1;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02) return;
  el.getAnimations().forEach((a) => a.cancel());
  const anim = el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: origin },
      { transform: 'translate(0, 0) scale(1, 1)', transformOrigin: origin },
    ],
    { duration: TALL_MS, easing: TALL_EASE, fill: 'both' },
  );
  anim.finished.then(() => anim.cancel()).catch(() => {});
}

/**
 * מעבר ‎compose-tall‎ באנימציית FLIP: התיבה נמתחת מהחריץ בין הכפתורים
 * לרוחב מלא, והכפתורים יורדים לשורה מתחת. רק כאן — לא בפתיחת המקלדת.
 */
function setComposeTall(on) {
  const body = document.body;
  if (body.classList.contains('compose-tall') === on) return;
  const compact = body.classList.contains('compose-compact');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const input = $('input');
  if (!compact || reduce || typeof body.animate !== 'function') {
    body.classList.toggle('compose-tall', on);
    growInput(input);
    return;
  }

  const movers = ['#input', '#micBtn', '#attachBtn', '#sendBtn']
    .map((s) => document.querySelector(s)).filter(visibleBox);
  const pills = document.querySelector('.pill-row');
  const first = new Map();
  for (const el of movers) first.set(el, el.getBoundingClientRect());
  let pillGhost = null;
  if (!on && visibleBox(pills)) pillGhost = ghostAt(pills, pills.getBoundingClientRect());

  body.classList.toggle('compose-tall', on);
  growInput(input);
  void body.offsetWidth;

  const origin = 'top right';
  for (const el of movers) {
    const f = first.get(el);
    const l = el.getBoundingClientRect();
    if (f && l.width) flipTo(el, f, l, origin);
  }

  if (on && visibleBox(pills)) {
    pills.getAnimations().forEach((a) => a.cancel());
    const anim = pills.animate(
      [
        { opacity: 0, transform: 'translateY(10px) scale(.96)', transformOrigin: origin },
        { opacity: 1, transform: 'translateY(0) scale(1)', transformOrigin: origin },
      ],
      { duration: TALL_MS * 0.85, delay: 40, easing: TALL_EASE, fill: 'both' },
    );
    anim.finished.then(() => anim.cancel()).catch(() => {});
  } else if (pillGhost) {
    const anim = pillGhost.animate(
      [
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: 'translateY(8px) scale(.96)' },
      ],
      { duration: TALL_MS * 0.65, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
    );
    anim.finished.then(() => pillGhost.remove()).catch(() => pillGhost.remove());
  }
}

function growInput(i) {
  // גובה החלון *החזותי*, לא ‎innerHeight‎: ב-iOS המקלדת אינה מקטינה את
  // ‎innerHeight‎ (וגם לא את ‎dvh‎), ולכן 42% ממנו הם תיבה שדוחפת את שורת
  // הכפתורים אל מתחת למקלדת בדיוק כשהיא ארוכה — כלומר כשצריך אותה.
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  i.style.height = 'auto';
  i.style.height = Math.min(i.scrollHeight, vh * 0.42) + 'px';
}

function autoGrow() {
  const i = $('input');
  const want = shouldComposeTall(i);
  if (document.body.classList.contains('compose-tall') === want) growInput(i);
  else setComposeTall(want);
}
$('input').addEventListener('input', autoGrow);
$('input').addEventListener('input', () => stashDraftSoon());
$('input').addEventListener('keydown', (e) => {
  // Esc בזמן הכתבה עוצר אותה ולא סוגר חלונית — זה המצב הפעיל ביותר במסך
  if (e.key === 'Escape' && dictOn) { e.preventDefault(); e.stopPropagation(); dictStop(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); return; }
  const i = $('input');
  if (e.key === 'ArrowUp' && i.selectionStart === 0 && store.history && store.history.length) { e.preventDefault(); histIdx = Math.min(histIdx + 1, store.history.length - 1); i.value = store.history[histIdx]; autoGrow(); }
  else if (e.key === 'ArrowDown' && histIdx >= 0) { e.preventDefault(); histIdx--; i.value = histIdx < 0 ? '' : store.history[histIdx]; autoGrow(); }
});
$('sendBtn').onclick = () => sendMessage();

/* ==========================================================================
   הכתבה קולית — מיקרופון בשורת הקלט
   --------------------------------------------------------------------------
   הקלדת עברית באצבע אחת בטלפון היא הצוואר הצר של הממשק הזה: כל שאר הדרכים
   להזין תוכן כבר קיימות (הדבקה, גרירה, שיתוף מאפליקציה אחרת), רק המהירה
   מכולן חסרה. `SpeechRecognition` של הדפדפן נותן אותה בלי שרת ובלי מפתח.

   שלוש החלטות שמחזיקות את המימוש:

   1. **הטקסט נכנס לתיבה, לא לרצועה נפרדת.** מה שנאמר הוא טיוטה ככל טיוטה
      אחרת — אפשר לערוך אותו באמצע, למחוק מילה, להוסיף `@קובץ` ולשלוח. רצועה
      שמחזיקה את הטקסט בנפרד הייתה דורשת "העבר לתיבה" נוסף, וכל מה שנאמר עד
      שלא נלחץ היה אבוד.

   2. **עוגן במקום append.** בתחילת ההכתבה נרשם היכן עמד הסמן: מה שלפניו הוא
      `head` ומה שאחריו `suffix`. הדיבור מצטרף ל-`head`, כך שאפשר להכתיב
      *לתוך* אמצע טקסט קיים ולא רק בסופו. בחירה מסומנת מוחלפת במה שנאמר,
      בדיוק כמו הקלדה.

   3. **`interim` הוא טקסט לכל דבר.** תוצאת ביניים נכתבת לתיבה ונדרסת בכל
      עדכון — כך רואים את המשפט נבנה. `mirror` הוא מה שכתבנו לאחרונה: אם
      התיבה שונה ממנו, המשתמש נגע בה בזמן שדיברנו, ואז נלקח עוגן חדש מהסמן
      במקום לדרוס את מה שהוא הקליד.

   המנוע של Chrome מסיים את ההכרה מעצמו אחרי שקט, גם עם `continuous = true`
   (ובאנדרואיד תוך שניות). לכן ההקשבה כאן היא לולאה: `onend` מפעיל מחדש כל
   עוד `dictOn`, והדבר היחיד שעוצר אותה הוא בקשה מפורשת או שגיאה. `dictOn`
   הוא הרצון של המשתמש, לא מצב המנוע — וזו ההפרדה שמונעת גם את הלולאה
   ההפוכה, שבה `stop()` מפעיל `onend` שמפעיל `start()` מחדש.
   ========================================================================== */

const DICT_LANGS = [
  { id: 'he-IL', short: 'עב', name: 'עברית' },
  { id: 'en-US', short: 'EN', name: 'English' },
];
const DICT_DEFAULT = 'he-IL';

let dictRec = null;            // מופע ה-SpeechRecognition החי, או null
let dictOn = false;        // המשתמש מקשיב עכשיו (רצון, לא מצב מנוע)
let dictAnchor = null;     // { head, suffix, interim, mirror }
let dictLoops = 0;         // הפעלות-מחדש רצופות שנגמרו מיד — הגנה מלולאה
let dictStartedAt = 0;

const SpeechRec = () => window.SpeechRecognition || window.webkitSpeechRecognition;
/**
 * הכתבה דורשת הקשר מאובטח: ב-http רגיל Chrome לא ייתן הרשאת מיקרופון גם אם
 * האובייקט קיים. הממשק מוגש ב-https או מ-localhost, ולכן זה בדרך כלל מתקיים —
 * אבל מאזין ה-LAN יכול לרוץ בלי תעודה, ושם עדיף כפתור מושבת עם הסבר מאשר
 * כפתור שנכשל בלחיצה. Firefox פשוט אינו מממש את ה-API, ושם אין מה להציג.
 */
const dictSupported = () => !!SpeechRec();
const dictSecure = () => window.isSecureContext !== false;

function dictLang() {
  const v = store.settings && store.settings.dictLang;
  return DICT_LANGS.some(l => l.id === v) ? v : DICT_DEFAULT;
}
const dictLangInfo = () => DICT_LANGS.find(l => l.id === dictLang()) || DICT_LANGS[0];

/**
 * חיבור מקטע שנשמע אל הטקסט שלפניו. המנוע מחזיר את המילים בלי רווח מוביל
 * בעברית ועם רווח מוביל באנגלית, ובלי שום הבטחה לגבי רווחים כפולים — לכן
 * הנרמול כאן ולא שם. הרווח נוסף גם כשהסמן עמד באמצע מילה: מי שמתחיל להכתיב
 * שם מתכוון למילה חדשה.
 */
function dictJoin(left, chunk) {
  chunk = String(chunk || '').replace(/\s+/g, ' ').trim();
  if (!chunk) return left;
  if (!left) return chunk;
  return /\s$/.test(left) ? left + chunk : left + ' ' + chunk;
}

/**
 * עוגן חדש מהסמן הנוכחי. טווח מסומן נבלע — מה שיוכתב יחליף אותו, כמו הקלדה.
 * כשהתיבה איננה בפוקוס אין באמת סמן: `selectionStart` מחזיר שם 0 בדפדפנים
 * מסוימים, ואז הכתבה על טיוטה קיימת הייתה נדחפת *לפני* מה שכבר כתוב. בלי
 * פוקוס העוגן הוא הסוף, שהוא גם מה שמתכוונים אליו כשמפעילים מקיצור מקלדת.
 * `mirror` נקבע כאן ולא נשאר ריק, אחרת הבדיקה הראשונה ב-dictReanchor הייתה
 * מזהה "המשתמש נגע" ומוחקת את העוגן שהרגע נקבע.
 */
function dictAnchorAtCaret() {
  const i = $('input');
  const end = i.value.length;
  const live = document.activeElement === i && i.selectionStart != null;
  const a = live ? i.selectionStart : end;
  const b = live && i.selectionEnd != null ? i.selectionEnd : a;
  const head = i.value.slice(0, Math.min(a, b));
  // `base` הוא אורך ה-head ברגע העיגון. `head` עצמו גדל עם כל מקטע שנסגר,
  // ולכן הוא לא יכול לשמש כדי לענות על "האם נאמר כבר משהו".
  return { head, base: head.length, suffix: i.value.slice(Math.max(a, b)), interim: '', mirror: i.value };
}

/**
 * סימנים שאין לפניהם רווח בעברית ובאנגלית. מי שמעמיד את הסמן לפני נקודה
 * ומכתיב עוד מילה מתכוון להוסיף אותה למשפט, לא לרחק את הנקודה ממנו.
 */
const DICT_TIGHT = /^[\s.,;:!?)\]}»"'׳״]/;

/**
 * כותב `head + interim + suffix` לתיבה ומשאיר את הסמן בין הדיבור לשארית.
 * `dictJoin` מטפל ברווח שמשמאל לדיבור; הרווח שמימין לו הוא עניין נפרד, כי שם
 * יושב טקסט שהיה בתיבה מלכתחילה — בלעדיו הכתבה לאמצע משפט הייתה מדביקה את
 * המילה החדשה למילה שאחריה.
 */
function dictRender() {
  const a = dictAnchor; if (!a) return;
  const i = $('input');
  const spoken = dictJoin(a.head, a.interim);
  const gap = (spoken.length > a.base && a.suffix && !DICT_TIGHT.test(a.suffix)) ? ' ' : '';
  const val = spoken + gap + a.suffix;
  i.value = val;
  a.mirror = val;
  try { i.setSelectionRange(spoken.length, spoken.length); } catch {}
  autoGrow();
  stashDraftSoon();
}

/**
 * לפני כל עדכון: האם התיבה עדיין מה שכתבנו? אם לא — המשתמש הקליד או מחק בזמן
 * שדיברנו, ועוגן ישן היה מוחק את העריכה שלו ברגע שתגיע המילה הבאה. עוגן חדש
 * מהסמן שומר את שני הצדדים: מה שהוא כתב נשאר, וההמשך נכנס במקום שבו הוא עומד.
 */
function dictReanchor() {
  if (!dictAnchor || $('input').value !== dictAnchor.mirror) dictAnchor = dictAnchorAtCaret();
}

/** מכבה את המנוע בלי לגעת ב-dictOn וב-dictAnchor (שימושי גם להחלפת שפה). */
function dictKillEngine() {
  if (!dictRec) return;
  try { dictRec.onresult = dictRec.onerror = dictRec.onend = dictRec.onstart = null; dictRec.abort(); } catch {}
  dictRec = null;
}

/**
 * מרים מנוע חדש בשפה הנוכחית. `abort` (ולא `stop`) בכיבוי זורק תוצאות ביניים
 * שלא הספיקו להסתיים — וזה בסדר בדיוק כאן, כי הן כבר כתובות בתיבה: מה שנראה
 * על המסך הוא מה שנשאר, ואין רגע שבו טקסט נעלם מתחת ליד.
 */
function dictSpin() {
  const R = SpeechRec();
  let r;
  try { r = new R(); } catch { dictStop('ההכתבה לא נתמכת בדפדפן הזה'); return; }
  r.lang = dictLang();
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onstart = () => { dictStartedAt = Date.now(); dictPaint(); };

  r.onresult = (e) => {
    if (!dictOn) return;
    dictReanchor();
    let interim = '';
    for (let k = e.resultIndex; k < e.results.length; k++) {
      const res = e.results[k];
      const t = (res[0] && res[0].transcript) || '';
      if (res.isFinal) dictAnchor.head = dictJoin(dictAnchor.head, t);
      else interim += t;
    }
    dictAnchor.interim = interim.replace(/\s+/g, ' ').trim();
    dictRender();
    dictLoops = 0;                    // נשמע דיבור — המנוע חי, לא בלולאה
  };

  r.onerror = (e) => {
    const err = (e && e.error) || '';
    // שקט הוא לא שגיאה, וביטול הוא אנחנו. בשניהם onend יחליט מה הלאה.
    if (err === 'no-speech' || err === 'aborted') return;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      dictStop('אין הרשאת מיקרופון — צריך לאשר אותה בהגדרות האתר בדפדפן');
      return;
    }
    if (err === 'network') { dictStop('שירות ההכתבה של הדפדפן לא זמין (נדרשת רשת)'); return; }
    if (err === 'language-not-supported') { dictStop(`הדפדפן לא יודע להכתיב ב${dictLangInfo().name}`); return; }
    if (err === 'audio-capture') { dictStop('לא נמצא מיקרופון'); return; }
    dictStop('ההכתבה נעצרה' + (err ? ` (${err})` : ''));
  };

  r.onend = () => {
    if (!dictOn) { dictPaint(); return; }
    // סיום מיידי וחוזר אינו שקט אלא מנוע שמסרב לעלות (הרשאה שנשללה בלי
    // אירוע שגיאה, מיקרופון תפוס). ארבעה כאלה ברצף = עוצרים ואומרים.
    dictLoops = (Date.now() - dictStartedAt < 500) ? dictLoops + 1 : 0;
    if (dictLoops >= 4) { dictStop('לא הצלחתי להחזיק את המיקרופון פתוח'); return; }
    dictRestart(r, 0);
  };

  dictRec = r;
  try { dictStartedAt = Date.now(); r.start(); }
  catch { dictKillEngine(); dictStop('לא הצלחתי להפעיל את המיקרופון'); }
}

/**
 * הפעלה מחדש אחרי שהמנוע סיים מעצמו (שקט). ‎start()‎ בתוך ‎onend‎ זורק
 * ‎InvalidStateError‎ כשהמנוע עוד לא שחרר את ההתקן — וזה קורה דווקא
 * באנדרואיד, שם הוא מסיים כל כמה שניות. לכן ניסיון נוסף אחרי רבע שנייה
 * במקום לוותר: מיקרופון שנכבה באמצע משפט בלי מילה אחת הוא בדיוק מה שנראה
 * כמו תקלה אקראית. גם הוויתור, כשהוא מגיע, נאמר בקול.
 */
function dictRestart(r, tries) {
  if (!dictOn || dictRec !== r) return;      // נעצר או הוחלף בינתיים
  try { dictStartedAt = Date.now(); r.start(); }
  catch {
    if (tries >= 2) { dictStop('ההכתבה נעצרה — אפשר להפעיל שוב'); return; }
    setTimeout(() => dictRestart(r, tries + 1), 250);
  }
}

function dictStart() {
  if (dictOn) return;
  if (!dictSupported()) { toast('הדפדפן הזה לא תומך בהכתבה קולית', true); return; }
  if (!dictSecure()) { toast('הכתבה קולית דורשת חיבור מאובטח (https)', true); return; }
  dictOn = true;
  dictLoops = 0;
  dictAnchor = dictAnchorAtCaret();
  dictSpin();
  dictPaint();
  dlog('dict.start', { lang: dictLang() });
}

/** עצירה מכל סיבה. `msg` נאמר רק כשהעצירה לא נתבקשה. */
function dictStop(msg) {
  if (!dictOn && !dictRec) { dictPaint(); return; }
  dictOn = false;
  dictKillEngine();
  dictAnchor = null;                  // מה שנכתב לתיבה נשאר בה כטקסט רגיל
  dictPaint();
  if (msg) toast(msg, true);
  stashDraft();
  dlog('dict.stop', { reason: msg || 'user' });
}

const dictToggle = () => (dictOn ? dictStop() : dictStart());

/** החלפת שפה תוך כדי הקשבה מרימה מנוע חדש ומשאירה את העוגן — מה שכבר הוכתב נשאר. */
function dictSetLang(id) {
  if (!DICT_LANGS.some(l => l.id === id)) return;
  store.settings.dictLang = id;
  save();
  if (dictOn) { const a = dictAnchor; dictKillEngine(); dictAnchor = a; dictLoops = 0; dictSpin(); }
  dictPaint();
}
const dictNextLang = () => DICT_LANGS[(DICT_LANGS.findIndex(l => l.id === dictLang()) + 1) % DICT_LANGS.length];

function dictPaint() {
  const btn = $('micBtn'); if (!btn) return;
  const usable = dictSupported();
  btn.classList.toggle('hidden', !usable);
  if (!usable) return;
  // לא ‎disabled‎: כפתור מושבת בולע לחיצות, ואז אין דרך להסביר למה אין הכתבה
  // ב-http. ‎aria-disabled‎ + שמירה ב-dictStart (toast) משאירים את הלחיצה חיה.
  const secure = dictSecure();
  btn.disabled = false;
  btn.setAttribute('aria-disabled', secure ? 'false' : 'true');
  btn.classList.toggle('on', dictOn);
  btn.setAttribute('aria-pressed', dictOn ? 'true' : 'false');
  btn.title = !secure ? 'הכתבה קולית דורשת חיבור מאובטח (https)'
    : dictOn ? 'עצור הכתבה (Esc)'
    : `הכתבה קולית · ${dictLangInfo().name} · Ctrl/⌘+Shift+M`;
  const strip = $('dictStrip');
  if (strip) {
    strip.classList.toggle('hidden', !dictOn);
    if (dictOn) {
      const lang = $('dictLang');
      lang.textContent = dictLangInfo().short;
      lang.title = `החלף ל${dictNextLang().name}`;
    }
  }
  document.body.classList.toggle('dictating', dictOn);
}

if (dictSupported()) {
  // אף כפתור של ההכתבה לא גונב פוקוס: הסמן שבתיבה הוא נקודת העיגון, וכפתור
  // שמאפס אותו היה שולח את המשפט הבא לסוף הטיוטה במקום למקום שבו עמדת.
  for (const id of ['micBtn', 'dictDone', 'dictLang']) {
    $(id).addEventListener('mousedown', (e) => e.preventDefault());
  }
  $('micBtn').onclick = dictToggle;
  $('dictDone').onclick = () => dictStop();
  $('dictLang').onclick = () => dictSetLang(dictNextLang().id);
  // הלשונית ברקע = המיקרופון נשאר פתוח בכיס. משחררים אותו; מה שנאמר עד כה
  // כבר בתיבה, וההכתבה מתחדשת בלחיצה אחת בחזרה.
  document.addEventListener('visibilitychange', () => { if (document.hidden && dictOn) dictStop(); });
  addEventListener('pagehide', () => dictStop());
}
$('stopBtn').onclick = () => { interruptTurn(); };
/**
 * הבדיקה הידנית, מכל נקודת כניסה: הכפתור הקבוע בסרגל, הכפתור שצץ כשהתור
 * נראה תקוע, ולוח הפקודות. הכפתור בסרגל מסתובב תמיד — גם כשהלחיצה הגיעה
 * ממקום אחר — כדי שתמיד יהיה חיווי אחד ויחיד לכך שבדיקה רצה עכשיו.
 */
async function manualCheck(from) {
  if (checking) { toast('בדיקה כבר רצה'); return; }
  const sync = $('syncBtn');
  const stale = $('resyncBtn');
  if (sync) sync.classList.add('checking');
  if (from === stale && stale) { stale.disabled = true; stale.textContent = '⟳ בודק…'; }
  try { await crossCheck('manual'); }
  finally {
    if (sync) sync.classList.remove('checking');
    if (from === stale && stale) { stale.disabled = false; stale.textContent = '⟳ סנכרן'; }
  }
}
$('syncBtn').onclick = () => manualCheck($('syncBtn'));
$('resyncBtn').onclick = () => manualCheck($('resyncBtn'));
$('newDuet').onclick = () => {
  if (!leaveAnon(null)) return;
  if (busy) { interruptTurn(); abandonTurn(); }
  stashDraft();
  closeDrawer();
  newDuetConv();
};
function startNewChat() {
  if (!leaveAnon(null)) return;       // לפני כל שאר הפעולות: ביטול חייב להשאיר הכול כשהיה
  if (busy) { interruptTurn(); abandonTurn(); }
  stashDraft();
  closeDrawer();   // אם נלחץ מתוך המגירה — היעד הוא תיבת הכתיבה, לא הרשימה
  const empty = store.convs.find(c => c.loaded && !isDuet(c) && !c.anon && c.messages.length === 0 && !(c.draft || '').trim());
  if (empty) { switchConv(empty.id); }
  else { newConv(); restoreDraft(); syncConvCwd(); renderConversation(); renderConvList(); }
  // focus מיידי בטלפון פותח מקלדת בזמן שהמגירה עוד מחליקה; ממתינים לסיום
  if (drawerMode()) setTimeout(() => $('input').focus(), 260);
  else $('input').focus();
}
$('newChat').onclick = startNewChat;
// אותו כפתור בסרגל העליון — זמין בלי לפתוח את המגירה
$('newChatTop').onclick = startNewChat;
$('newAnon').onclick = startAnonChat;
$('anonExit').onclick = () => {
  const c = anonConv();
  // אותו אישור בדיוק כמו בכל שאר מסלולי העזיבה — הכפתור אינו מקרה מיוחד,
  // הוא רק הדרך המפורשת ביותר לעשות את מה שכל יציאה עושה ממילא.
  if (c && !anonLeaveOk(c)) return;
  endAnon();
};
$('anonTools').onclick = () => {
  const c = anonConv();
  if (!c) return;
  // הדגל נקבע בשורת הפקודה של התהליך, והתהליך *הוא* ההקשר של השיחה. שינוי
  // באמצע היה מחייב הפעלה מחדש — כלומר למחוק את מה שנאמר עד כה.
  if (c.messages.length) {
    toast('אפשר לשנות את מצב הכלים רק לפני ההודעה הראשונה — התהליך כבר רץ עם הבחירה הנוכחית', true);
    return;
  }
  // "ללא תיקייה" מכבה את הכלים בשרת בכל מקרה — הדלקה כאן הייתה מתג שלא עושה
  // כלום, ולכן אומרים את זה במקום להעמיד פנים.
  if (!c.tools && isNoDir(c.cwd)) {
    toast('השיחה מוגדרת "ללא תיקייה" — כדי להפעיל כלים בחרו תיקיית עבודה בהגדרות', true);
    return;
  }
  c.tools = !c.tools;
  applyAnonMode();
  toast(c.tools
    ? 'כלים פעילים — שימו לב: קריאה/כתיבה של קבצים וטרמינל משאירים עקבות משל עצמם, מחוץ לשיחה'
    : 'כלים כבויים — שיחה בלבד');
};

// ---------- הגדרות + עיצוב ----------
let settingsOpenedAt = 0;
function openSettings() { $('settings').classList.remove('hidden'); settingsOpenedAt = Date.now(); renderNotifyRow(); renderInstallRow(); }

// ---------- מתג ההתרעות ----------
$('notifyOn').onchange = (e) => { store.settings.notify = e.target.checked; save(); renderNotifyRow(); };
$('notifyActionsOn').onchange = (e) => { store.settings.notifyActions = e.target.checked; save(); renderNotifyRow(); };
$('notifyAsk').onclick = () => notifyChipClick(); // באותו כפתור יושבות "בקש" ו"למה חסום"
$('notifyChip').onclick = () => notifyChipClick();
$('notifyTest').onclick = () => {
  // בדיקה אמיתית: אותו מסלול בדיוק שההתרעות האמיתיות עוברות בו
  desktopNotify('בדיקת התרעה', 'ככה תיראה התרעה על סיום משימה');
  toast('נשלחה התרעת בדיקה');
};
$('settingsToggle').onclick = (e) => {
  e.stopPropagation();
  if ($('settings').classList.contains('hidden')) openSettings();
  else $('settings').classList.add('hidden');
};
document.addEventListener('click', (e) => {
  const s = $('settings');
  if (s.classList.contains('hidden')) return;
  // הקליק *שפתח* את החלונית ממשיך לבעבע לכאן ומיד סגר אותה — כך "הגדרות"
  // בלוח הפקודות (הדרך היחידה אליהן בטלפון) פשוט לא עשה כלום.
  if (Date.now() - settingsOpenedAt < 300) return;
  if (!s.contains(e.target) && e.target !== $('settingsToggle')) s.classList.add('hidden');
});
// matchMedia ולא innerWidth: זו בדיוק אותה נקודת שבירה שבה ה-CSS הופך את
// הסרגל למגירה צפה. שתי הגדרות נפרדות של "760" נוטות להיפרד זו מזו — ולכן
// המחרוזת מוגדרת פעם אחת, מילה במילה כמו ב-style.css (כולל תנאי השכיבה:
// טלפון ב-844×390 רחב מ-760 אבל עדיין צריך מגירה ולא עמודה).
const NARROW_MQ = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';
const isNarrow = () => matchMedia(NARROW_MQ).matches;
const drawerMode = isNarrow;
/** סוגר את מגירת השיחות בטלפון. בדסקטופ הסרגל הוא עמודה ולא מסתיר כלום. */
function closeDrawer() {
  if (!drawerMode()) return;
  document.querySelector('.app').classList.remove('side-open');
}
function toggleSide() { const app = document.querySelector('.app'); if (drawerMode()) app.classList.toggle('side-open'); else app.classList.toggle('side-collapsed'); }
$('sideToggle').onclick = toggleSide;
$('sideCollapse').onclick = toggleSide;
// המגירה בטלפון נסגרת בהקשה על העמעום — הדרך שבה סוגרים מגירה בכל אפליקציה
$('sideBackdrop').onclick = () => document.querySelector('.app').classList.remove('side-open');

/* ---------- סגירת המגירה בהחלקה ----------
   שלוש הדרכים שהיו לסגור אותה בטלפון: ה-‹ בפינה, רצועת עמעום של ~55px
   (המגירה היא ‎min(86vw,340px)‎ — במסך 390 נשארים 55), והכפתור בסרגל העליון —
   שחסום מאחורי העמעום כל עוד היא פתוחה. ההחלקה היא מה שהאצבע מנסה קודם.
   ‎touch-action: pan-y‎ ב-CSS משאיר את הגלילה האנכית לדפדפן ומעביר אלינו רק
   את הגרירה האופקית, ולכן אין כאן preventDefault שנלחם בגלילה. */
(function drawerSwipe() {
  const app = document.querySelector('.app');
  const side = $('sidebar');
  if (!side || !app) return;
  const CLOSE_RATIO = 0.32;      // כמעט שליש מהרוחב
  const CLOSE_VELOCITY = 0.45;   // px/ms — החלקה קצרה ומהירה נחשבת גם היא
  let id = null, x0 = 0, y0 = 0, t0 = 0, dx = 0, axis = null, swallowClick = false;

  side.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !drawerMode() || !app.classList.contains('side-open')) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); dx = 0; axis = null;
  });

  side.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      // ההכרעה נעשית פעם אחת: גרירה שהתחילה אנכית נשארת גלילה עד סוף המחווה
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (axis === 'x') {
        side.style.transition = 'none';
        try { side.setPointerCapture(id); } catch {}
      }
    }
    if (axis !== 'x') return;
    dx = Math.max(0, mx);        // ב-RTL המגירה יוצאת ימינה, ולכן רק ימינה נספר
    side.style.transform = 'translateX(' + dx + 'px)';
  });

  const finish = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    if (axis !== 'x') { axis = null; return; }
    const width = side.getBoundingClientRect().width || 300;
    const velocity = dx / Math.max(1, performance.now() - t0);
    // המעבר וה-transform מוחזרים ל-CSS באותו חישוב סגנון, כך שהאנימציה
    // ממשיכה מהמקום שהאצבע עזבה בו במקום לקפוץ אחורה ואז לצאת
    side.style.transition = '';
    if (dx > width * CLOSE_RATIO || velocity > CLOSE_VELOCITY) app.classList.remove('side-open');
    side.style.transform = '';
    swallowClick = dx > 8;       // גרירה שהתחילה על שורת שיחה לא תפתח אותה
    axis = null;
  };
  side.addEventListener('pointerup', finish);
  side.addEventListener('pointercancel', finish);
  side.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation(); e.preventDefault();
  }, true);
})();

// כפתור "עוד" בסרגל העליון פותח את לוח הפקודות כתפריט פעולות
$('moreBtn').onclick = () => {
  const p = $('palette');
  p.classList.contains('hidden') ? openPalette(false) : closePalette();
};

// ---------- רוחב סרגל צד — גרירה קלאסית ----------
const SIDE_MIN = 200;
const SIDE_MAX = 480;
const SIDE_DEFAULT = 272;

function sideWidthFromPointer(clientX) {
  const app = document.querySelector('.app');
  const rect = app.getBoundingClientRect();
  const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
  // ב-RTL הסרגל מימין: הרוחב = מרחק מהקצה הימני של האפליקציה עד הסמן
  const raw = rtl ? (rect.right - clientX) : (clientX - rect.left);
  const max = Math.min(SIDE_MAX, Math.floor(window.innerWidth * 0.55));
  return Math.round(Math.min(max, Math.max(SIDE_MIN, raw)));
}
function applySideWidth(px) {
  document.querySelector('.app').style.setProperty('--side-w', px + 'px');
}
function initSideResize() {
  const app = document.querySelector('.app');
  const handle = $('sideResizer');
  if (!handle) return;
  const saved = Number(store.settings.sideWidth);
  applySideWidth(Number.isFinite(saved) && saved >= SIDE_MIN ? saved : SIDE_DEFAULT);

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    applySideWidth(sideWidthFromPointer(x));
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    app.classList.remove('side-resizing');
    const x = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX : e.clientX;
    if (typeof x === 'number') {
      const w = sideWidthFromPointer(x);
      applySideWidth(w);
      store.settings.sideWidth = w;
      save();
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  handle.addEventListener('pointerdown', (e) => {
    if (isNarrow()) return;   // במגירה אין מה לגרור — הסרגל צף מעל התוכן
    if (app.classList.contains('side-collapsed')) return;
    e.preventDefault();
    dragging = true;
    app.classList.add('side-resizing');
    try { handle.setPointerCapture(e.pointerId); } catch {}
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  // דאבל־קליק על הידית — איפוס לרוחב ברירת המחדל
  handle.addEventListener('dblclick', () => {
    applySideWidth(SIDE_DEFAULT);
    store.settings.sideWidth = SIDE_DEFAULT;
    save();
  });
}

// ---------- חלונית ניצול מכסה (כפתור בסטטוסבר → מודאל מרכזי) ----------
$('usageOpen').onclick = (e) => { e.stopPropagation(); toggleUsageModal(); };
$('usageSrcToggle').onclick = (e) => {
  e.stopPropagation();
  setUsageSource(usageSource() === 'claude' ? 'cursor' : 'claude');
};
$('usageModalClose').onclick = () => setUsageModalOpen(false);
$('usageModal').addEventListener('click', (e) => { if (e.target === $('usageModal')) setUsageModalOpen(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isUsageModalOpen()) {
    e.stopPropagation();
    setUsageModalOpen(false);
  }
});

// ---------- צירוף תמונות ----------
// תמונה עם נתיב אמיתי על הדיסק (זמין בעטיפת דסקטופ) מצורפת לפי הנתיב שלה בלבד — בלי העתקה.
// תמונה שהודבקה או הועלתה מהדפדפן נשמרת זמנית בשרת (temp) ותימחק אוטומטית בעתיד.
let pendingAtts = [];

function revokeAtt(a) {
  if (a && a.url) { URL.revokeObjectURL(a.url); a.url = ''; }
}
function clearPendingAtts() {
  pendingAtts.forEach(revokeAtt);
  pendingAtts = [];
  renderAttStrip();
}

function renderMsgAtts(atts) {
  const box = el('div', 'msg-atts');
  for (const a of atts) {
    const chip = el('div', 'm-att');
    const thumb = el('div', 'thumb');
    if (a.url) { const im = el('img'); im.src = a.url; im.alt = ''; thumb.appendChild(im); }
    else thumb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="13" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="M5.5 16.5l4-4 2.5 2.5 2.2-2.2 4.3 3.7"/></svg>';
    const info = el('div', 'ma-info');
    info.appendChild(el('div', 'ma-name', a.name));
    info.appendChild(el('div', 'ma-path ' + (a.kind === 'disk' ? 'disk' : 'temp'), a.path));
    chip.appendChild(thumb); chip.appendChild(info);
    box.appendChild(chip);
  }
  return box;
}
function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
async function addAttachment(file, forceTemp) {
  if (!file || !(file.type || '').startsWith('image/')) return;
  if (file.size > MAX_IMAGE_BYTES) {
    toast('התמונה גדולה מדי (מקסימום 30MB)', true);
    return;
  }
  const url = URL.createObjectURL(file);
  const att = { name: file.name || 'הדבקה.png', url, kind: 'temp', path: '', status: 'up', data: '', media: file.type || 'image/png', file, forceTemp: !!forceTemp };
  pendingAtts.push(att); renderAttStrip();
  att.ready = uploadAttachment(att);
}
/** העלאה / קריאת base64 לצירוף קיים — משמש גם לניסיון חוזר אחרי כשל. */
async function uploadAttachment(att) {
  const file = att.file;
  if (!file) { att.status = 'err'; renderAttStrip(); return; }
  att.status = 'up';
  renderAttStrip();
  try {
    // התמונה נשלחת ל-Claude ישירות כ-base64 (בלוק image) — עובד תמיד, בלי הרשאות קבצים
    const dataUrl = await readAsDataURL(file);
    att.data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const mm = /^data:([^;]+)/.exec(dataUrl); if (mm) att.media = mm[1];
    att.status = 'ready';
    // נתיב לתצוגה (best-effort): נתיב-דיסק אמיתי אם קיים, אחרת עותק זמני שיימחק אוטומטית
    if (!att.forceTemp && file.path) { att.kind = 'disk'; att.path = file.path; }
    else if (isAnon(activeConv())) {
      // בצ'אט אנונימי לא נכתב עותק: התמונה מגיעה למודל כ-base64 ישירות,
      // והעותק הזמני היה נשאר בדיסק שש שעות אחרי שהשיחה כבר "נמחקה".
      att.kind = 'temp';
      att.path = '(בזיכרון בלבד · לא נכתב לדיסק)';
    }
    else {
      try {
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: att.name, dataUrl }) });
        const j = await r.json();
        if (j && j.ok) { att.path = j.path; att.name = j.name || att.name; }
        else att.path = '(בזיכרון · זמני)';
      } catch { att.path = '(בזיכרון · זמני)'; }
      att.kind = 'temp';
    }
  } catch { att.status = 'err'; }
  renderAttStrip();
}

function renderAttStrip() {
  const strip = $('attStrip');
  strip.innerHTML = '';
  strip.classList.toggle('hidden', pendingAtts.length === 0);
  for (const a of pendingAtts) {
    const chip = el('div', 'att-chip' + (a.status === 'err' ? ' err' : ''));
    const thumb = el('div', 'thumb');
    if (a.url) { const im = el('img'); im.src = a.url; im.alt = ''; thumb.appendChild(im); }
    else thumb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="13" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="M5.5 16.5l4-4 2.5 2.5 2.2-2.2 4.3 3.7"/></svg>';
    const info = el('div', 'ac-info');
    info.appendChild(el('div', 'ac-name', a.name));
    const cls = a.status === 'up' ? 'up' : a.status === 'err' ? 'err' : a.kind;
    info.appendChild(el('div', 'ac-path ' + cls,
      a.status === 'up' ? 'מעלה…'
        : a.status === 'err' ? 'העלאה נכשלה · לחץ לניסיון חוזר'
        : a.path));
    const rm = el('button', 'ac-rm', '×'); rm.title = 'הסר';
    rm.onclick = (e) => { e.stopPropagation(); pendingAtts = pendingAtts.filter(x => x !== a); revokeAtt(a); renderAttStrip(); };
    chip.appendChild(thumb); chip.appendChild(info); chip.appendChild(rm);
    if (a.status === 'err' && a.file) {
      chip.title = 'לחץ לניסיון חוזר';
      chip.style.cursor = 'pointer';
      chip.onclick = () => { a.ready = uploadAttachment(a); };
    }
    strip.appendChild(chip);
  }
}

$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { [...e.target.files].forEach(f => addAttachment(f)); e.target.value = ''; };

// הדבקה — תמונה מהלוח נשמרת זמנית
$('input').addEventListener('paste', (e) => {
  const items = [...((e.clipboardData && e.clipboardData.items) || [])];
  const imgs = items.filter(it => it.type.startsWith('image/'));
  if (imgs.length) { e.preventDefault(); imgs.forEach(it => { const f = it.getAsFile(); if (f) addAttachment(f, true); }); }
});

// גרירה ושחרור מכל מקום בחלון
let dragN = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragN++; $('dropzone').classList.remove('hidden'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragN--; if (dragN <= 0) { dragN = 0; $('dropzone').classList.add('hidden'); } });
window.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragN = 0; $('dropzone').classList.add('hidden'); [...e.dataTransfer.files].forEach(f => addAttachment(f)); });
['cwd', 'model', 'effort', 'perm'].forEach(id => $(id).addEventListener('change', () => {
  store.settings[id] = $(id).value;
  // בחירת ההרשאות נזכרת תחת הסוכן שאליו היא שייכת — ראו populatePerms
  if (id === 'perm') store.settings[activeAgent() === 'cursor' ? 'cursorPerm' : 'perm'] = $('perm').value;
  if (id === 'model') {
    updateEfforts();
    // החלפת סוכן מחליפה את רשימת מצבי ההרשאה כולה; בלי הבנייה מחדש הבורר היה
    // נשאר עם מצב של הסוכן הקודם, ונשלח לסוכן שלא מכיר אותו.
    populatePerms();
    store.settings.effort = $('effort').value;
  }
  // תיקיית העבודה נזכרת גם ברמת השיחה (וברמת ההגדרות כברירת מחדל לשיחה הבאה)
  if (id === 'cwd') { const c = activeConv(); if (c) c.cwd = $('cwd').value; updateCwdChip(); }
  // החלפת מצב הרשאות תוך כדי שיחה — נשלחת חיה ל-CLI (set_permission_mode)
  if (id === 'perm') markGodPill();
  if (id === 'perm' && ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'set_permission_mode', mode: $('perm').value }));
  // החלפת מודל/מאמץ תוך כדי שיחה — השרת מחיל אותה על השיחה הרצה (set_model,
  // ואם צריך גם הפעלה מחדש עם resume) ומשדר את הבוררים למסכים האחרים.
  // שניהם נשלחים יחד כי בחירת מודל עשויה לשנות את רשימת המאמצים.
  else if (id === 'model' || id === 'effort') {
    if (ws && ws.readyState === ws.OPEN && subId) pushModel();
    else modelDirty = true;   // ניסלח בהתחברות הבאה, במקום שהשרת ידרוס את הבחירה
  }
  // הבורר מתעדכן גם במסך השני, כדי ששני המכשירים יראו את אותן הגדרות
  else sendUi(id === 'perm' ? 'permissionMode' : id, $(id).value);
  save(); updateStatusbar();
}));
$('convSearch').addEventListener('input', (e) => { convQuery = e.target.value; onConvSearch(); });
$('cwd').addEventListener('input', debounce(() => { checkCwd(); updateCwdChip(); }, 400));
const isTouch = () => matchMedia('(pointer: coarse)').matches || isNarrow();
// stopPropagation חובה: המאזין על document סוגר את חלונית ההגדרות בכל קליק
// שאינו בתוכה — בלעדיו הפאנל היה נפתח ונסגר מיד באותה לחיצה.
$('cwdChip').onclick = (e) => {
  e.stopPropagation();
  openSettings();
  // בטלפון פוקוס אוטומטי מקפיץ מקלדת שמכסה מיד את "עיין…" — הכפתור שהכי סביר
  // שרוצים שם, כי הקלדת נתיב מלא באצבע היא לא באמת אופציה.
  if (!isTouch()) $('cwd').focus();
};

/** נקודת השינוי היחידה של תיקיית העבודה: השדה, השיחה, ההגדרות והמסך השני. */
function setCwd(p) {
  const v = (p || '').trim();
  $('cwd').value = v;
  store.settings.cwd = v;
  const c = activeConv();
  if (c) c.cwd = v;
  syncNoDirUi();
  updateCwdChip(); checkCwd(); updateStatusbar();
  sendUi('cwd', v);
  save();
}

/** מיישר את מתג "ללא תיקייה" ואת שדה הנתיב למה שכתוב בשדה עצמו. */
function syncNoDirUi() {
  const on = isNoDir($('cwd').value);
  const box = $('noDirOn');
  if (box) box.checked = on;
  // השדה נשאר גלוי (הוא מה שמסביר מה נבחר) אבל לא ניתן לעריכה: הסימן אינו
  // נתיב, וכל תו שיתווסף לו היה הופך אותו לתיקייה שלא קיימת.
  $('cwd').disabled = on;
  $('cwd').dir = on ? 'rtl' : 'ltr';
  $('cwdBrowse').disabled = on;
}

/** הדלקה/כיבוי של מצב "ללא תיקייה". הנתיב הקודם נשמר כדי שהכיבוי יחזיר אליו. */
function setNoDir(on) {
  if (on) {
    const cur = ($('cwd').value || '').trim();
    if (cur && !isNoDir(cur)) store.settings.prevCwd = cur;
    setCwd(NO_DIR);
    toast('שיחה ללא תיקייה — בלי כלים ובלי גישה לקבצים');
  } else {
    const back = store.settings.prevCwd || '';
    setCwd(isNoDir(back) ? '' : back);
  }
}
$('noDirOn').addEventListener('change', (e) => setNoDir(e.target.checked));

// חיבור שאינו מ-localhost = הדפדפן רץ על מכשיר אחר, גם אם הוא מחשב שולחני.
const isRemote = () => !['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);

$('cwdBrowse').addEventListener('click', async () => {
  // דיאלוג המערכת (zenity/kdialog) נפתח על המסך של המחשב שמריץ את השרת. מהטלפון
  // — או מכל מכשיר אחר ברשת — הוא ייפתח במקום שאף אחד לא רואה, ולכן שם הבורר
  // שרץ בדפדפן הוא הבורר היחיד שיש.
  if (isTouch() || isRemote()) { openDirPicker($('cwd').value.trim()); return; }
  const btn = $('cwdBrowse'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'פותח…';
  try {
    console.log('[cwdBrowse] פותח בורר תיקיות, current=', $('cwd').value.trim());
    const r = await fetch('/api/pick-dir?current=' + encodeURIComponent($('cwd').value.trim()));
    if (!r.ok) {
      // למשל 404 — השרת ישן/לא כולל את הנתיב, או שהוא לא רץ
      console.error('[cwdBrowse] השרת החזיר סטטוס', r.status, '— ייתכן ששרת ישן שלא כולל /api/pick-dir. יש להפעיל מחדש.');
      openDirPicker($('cwd').value.trim());
      return;
    }
    const d = await r.json();
    console.log('[cwdBrowse] תגובת השרת:', d);
    if (d.ok && d.path) setCwd(d.path);
    else if (d.error === 'no-dialog') openDirPicker($('cwd').value.trim());
    else {
      // 'cancelled'/'empty' = המשתמש סגר את הדיאלוג — לא עושים כלום
      console.log('[cwdBrowse] לא נבחרה תיקייה:', d.error || '(ללא)');
    }
  } catch (e) {
    console.error('[cwdBrowse] הבקשה נכשלה:', e);
    const h = $('cwdHint'); h.textContent = '✗ הבורר נכשל — בדקו שהשרת רץ'; h.className = 'hint bad';
  }
  finally { btn.disabled = false; btn.textContent = old; }
});

// ---------- בורר תיקיות שרץ בדפדפן ----------
// עובד מכל מכשיר ברשת, בניגוד ל-/api/pick-dir שפותח חלון על מסך השרת.
let dirPickAt = '';
function openDirPicker(start) {
  const wrap = el('div', 'dirpick');
  const cur = el('div', 'dp-cur');
  const list = el('div', 'dp-list');
  const actions = el('div', 'dp-actions');
  const pick = el('button', 'rm-btn primary', 'בחר תיקייה זו');
  pick.onclick = () => { setCwd(dirPickAt); closeModal(); toast('תיקיית העבודה: ' + dirPickAt); };
  actions.appendChild(pick);
  wrap.appendChild(cur); wrap.appendChild(list); wrap.appendChild(actions);
  openModal('בחירת תיקיית עבודה', wrap);
  loadDirs(start, cur, list);
}
async function loadDirs(p, cur, list) {
  list.innerHTML = '';
  list.appendChild(el('div', 'modal-empty', 'טוען…'));
  let d;
  try {
    const r = await fetch('/api/list-dirs?path=' + encodeURIComponent(p || ''));
    if (!r.ok) throw new Error(r.status);
    d = await r.json();
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', 'modal-empty', 'לא ניתן לקרוא את התיקייה (' + (e.message || e) + ')'));
    return;
  }
  dirPickAt = d.path;
  cur.textContent = d.path;
  list.innerHTML = '';
  if (d.parent) {
    const up = el('button', 'dp-row up', '‹‹  ' + d.parent);
    up.onclick = () => loadDirs(d.parent, cur, list);
    list.appendChild(up);
  }
  if (!d.dirs.length) list.appendChild(el('div', 'modal-empty', 'אין תת־תיקיות'));
  for (const name of d.dirs) {
    const row = el('button', 'dp-row', name + '/');
    row.onclick = () => loadDirs(d.path.replace(/\/$/, '') + '/' + name, cur, list);
    list.appendChild(row);
  }
}
function checkCwd() {
  const v = $('cwd').value.trim(); const h = $('cwdHint');
  if (isNoDir(v)) { h.textContent = '✓ שיחה בלבד — הכלים כבויים, אין גישה לקבצים'; h.className = 'hint ok'; return; }
  if (!v) { h.textContent = ''; h.className = 'hint'; return; }
  fetch('/api/check-dir?path=' + encodeURIComponent(v)).then(r => r.json()).then(d => { h.textContent = d.ok ? '✓ תיקייה קיימת' : '✗ לא נמצאה'; h.className = 'hint ' + (d.ok ? 'ok' : 'bad'); }).catch(() => {});
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function isDark() { const t = document.documentElement.getAttribute('data-theme'); if (t) return t === 'dark'; return matchMedia('(prefers-color-scheme: dark)').matches; }

/* ערכת הדגשת התחביר הולכת אחרי המתג של האפליקציה, לא אחרי מערכת ההפעלה.
   שתי הערכות של highlight.js נטענות ב-index.html עם ‎media‎ של
   ‎prefers-color-scheme‎, וזה נכון כל עוד אין באפליקציה מתג משלה — אבל יש.
   טלפון שמערכת ההפעלה שלו בהירה ושהאפליקציה בו הוחלפה לכהה קיבל את הערכה
   *הבהירה*: דיו כהה על ‎--code-bg‎ כהה, כלומר בלוק קוד שלא ניתן לקרוא בכלל.

   ‎media="not all"‎ ולא ‎disabled‎: הוא מנטרל את הגיליון בלי לגרום לדפדפן
   למשוך אותו מחדש בכל החלפה. */
function syncHljsTheme() {
  const dark = isDark();
  const light = document.getElementById('hlLight');
  const night = document.getElementById('hlDark');
  if (light) light.media = dark ? 'not all' : 'all';
  if (night) night.media = dark ? 'all' : 'not all';
}

$('themeToggle').onclick = () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  store.settings.theme = next;
  syncHljsTheme();
  save();
  const btn = $('themeToggle');
  const label = next === 'dark' ? 'מצב כהה · לחץ לבהיר' : 'מצב בהיר · לחץ לכהה';
  if (btn) { btn.title = label; btn.setAttribute('aria-label', label); }
  toast(next === 'dark' ? 'מצב כהה' : 'מצב בהיר');
};

// בלי העדפה מפורשת הערכה עדיין הולכת אחרי מערכת ההפעלה, ולכן שינוי שם
// חייב להגיע גם לערכת הקוד. ‎isDark‎ מכריע מי גובר, ולכן הקריאה בטוחה תמיד.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncHljsTheme);

// ---------- קונפיג דינמי (נמשך מה-CLI) ----------
let CONFIG = { models: [], permissionModes: [], cursorPermissionModes: [], cursorPrefix: 'cursor/' };
/* ==========================================================================
   שני סוכנים, מסך אחד
   --------------------------------------------------------------------------
   הבחירה בין Claude Code לבין cursor-agent נעשית בבורר המודלים ותו לא: מודל
   שמזההו נושא את הקידומת של Cursor מריץ את הסוכן שלו. כל השאר — סטרימינג,
   כרטיסי כלים, תור, שמירה — משותף, כי השרת מתרגם את שני הפרוטוקולים לאותה
   סכמה (ראו cursor-bridge.js). מה שנשאר כאן הוא רק מה שבאמת שונה בין השניים:
   רשימת מצבי ההרשאה, ומזהי הסשן שאינם קבילים זה אצל זה.
   ========================================================================== */
const isCursorModel = (id) => typeof id === 'string' && id.startsWith(CONFIG.cursorPrefix || 'cursor/');
const activeAgent = () => (isCursorModel($('model').value) ? 'cursor' : 'claude');
const AGENT_LABEL = { claude: 'Claude', cursor: 'Cursor' };
/** מזהה הסשן להמשך — רק אם הוא נוצר בידי הסוכן שעומד לרוץ עכשיו. */
function resumeIdFor(conv) {
  if (!conv || !conv.sessionId) return null;
  return (conv.sessionAgent || 'claude') === activeAgent() ? conv.sessionId : null;
}
const EFFORT_LABEL = { low: 'מאמץ נמוך', medium: 'מאמץ בינוני', high: 'מאמץ גבוה', xhigh: 'מאמץ גבוה מאוד', max: 'מאמץ מקסימלי' };
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERM_LABEL = {
  acceptEdits: 'אישור עריכות', plan: 'תכנון בלבד', bypassPermissions: 'ללא בקשות', god: '⚡ GOD',
  auto: 'אוטומטי', manual: 'ידני', dontAsk: 'ללא שאלות', default: 'רגיל',
  // Cursor. 'default' שם פירושו "רק מה שברשימת ההיתר", ובהרצה לא-אינטראקטיבית
  // כל השאר נדחה בשקט — ולכן הוא מסומן במפורש ואינו ברירת המחדל.
  force: 'הרץ הכול', autoReview: 'אישור חכם', ask: 'שאלות בלבד',
};
/**
 * התוויות של Cursor, ומה שעומד מאחוריהן.
 *
 * ‎plan‎ ו-‎ask‎ הם *מצבי פתיחה*, לא גדרות: לסוכן יש כלי ‎SwitchMode‎ והוא משתמש
 * בו — בבדיקה הוא יצא ממצב תכנון וכתב את הקובץ שהתבקש. תווית "תכנון בלבד"
 * הייתה מבטיחה כאן משהו שלא מתקיים, ולכן היא נוסחה מחדש. מה שבאמת חוסם כלים
 * הוא ‎default‎ (רשימת ההיתר ב-‎~/.cursor/cli-config.json‎) — ושם כל מה שאינו
 * ברשימה נדחה בשקט, בלי כרטיס אישור, כי במצב ‎--print‎ אין למי להציג אותו.
 */
const CURSOR_PERM_LABEL = { default: 'רשימת היתר בלבד', plan: 'פתיחה בתכנון', ask: 'פתיחה בשאלות' };
/* ==========================================================================
   GOD
   --------------------------------------------------------------------------
   מצב של הממשק, לא של ה-CLI: השרת מריץ את ה-CLI במצב שבו הוא שואל על *כל*
   כלי, ועונה "אשר" בעצמו. בניגוד ל"ללא בקשות" — שם ה-CLI לא שואל בכלל, ולכן
   אין מה לרשום — כאן כל בקשה עוברת דרך השרת ונרשמת, ובסוף התור נפתח כרטיס
   עם הרשימה המלאה של מה שאושר. השאלה היחידה שעדיין מגיעה למסך היא
   AskUserQuestion: אין לה "אישור", יש לה תשובה, ורק המשתמש יכול לתת אותה.
   ========================================================================== */
const GOD_HINT = 'כל בקשת הרשאה מאושרת אוטומטית · בסוף התור יוצג כפתור עם כל מה שרץ';
const CURSOR_PERM_HINT = {
  force: 'מריץ כל כלי בלי לשאול',
  autoReview: 'מסווג בשרת מריץ אוטומטית קריאות בטוחות; השאר נדחה (אין כרטיס אישור ב---print)',
  default: 'רק כלים שברשימת ההיתר של Cursor; כל השאר נדחה בשקט',
  plan: 'מתחיל במצב תכנון — הסוכן רשאי לצאת ממנו בעצמו ולערוך קבצים',
  ask: 'מתחיל במצב שאלות — הסוכן רשאי לצאת ממנו בעצמו',
};
function opt(v, t) { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; }
/**
 * ממלא בורר מודלים בקבוצות (`optgroup`) לפי השדה `group` שהשרת שולח.
 *
 * הרשימה מונה יותר ממאה מודלים משלושה-ארבעה מקורות, ובלי חלוקה אי אפשר
 * לסרוק אותה. הסדר הוא סדר המערך מהשרת — הוא זה שקובע מה ראשון — ולכן כאן
 * רק נשמרת החלוקה. המונה בכותרת מראה מראש כמה עומק יש בקבוצה.
 */
function fillModelOptions(sel) {
  const groups = new Map();
  for (const m of CONFIG.models) {
    const g = m.group || 'מודלים';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  for (const [label, list] of groups) {
    const og = document.createElement('optgroup');
    og.label = `${label} · ${list.length}`;
    for (const m of list) og.appendChild(opt(m.id, m.short || m.name));
    sel.appendChild(og);
  }
}
/** שם מלא של מודל להצגה מחוץ לבורר, שם כותרת הקבוצה כבר לא נמצאת לידו. */
const modelName = (id) => { const m = CONFIG.models.find((x) => x.id === id); return m ? m.name : ''; };
function keepValue(sel, want, fallback) { sel.value = [...sel.options].some(o => o.value === want) ? want : fallback; }

/* ==========================================================================
   בורר מודלים עם חיפוש
   --------------------------------------------------------------------------
   ברשימה של מאות מודלים מעשרות שערים, תפריט נפתח הוא לא דרך למצוא מודל.
   הכפתור פותח חלונית עם שדה הקלדה: כל מילה שמוקלדת מסננת לפי שם המודל,
   המזהה המלא והקטגוריה (‎"gemini flash"‎, ‎"opus"‎, ‎"חינם"‎).

   ה-<select> המקורי נשאר בעץ ונשאר מקור האמת — ‎.value‎, אירוע ‎change‎,
   השידור בין מכשירים ושמירת ההעדפה כולם ממשיכים לעבוד בדיוק כמו קודם, והוא
   רק מוסתר (‎.mp-native‎). לכן אין כאן שכפול של רשימת המודלים: החלונית נבנית
   מה-options של אותו בורר.
   ========================================================================== */
let mpState = null;   // { sel, cur, items, idx } — null כשהחלונית סגורה

/** החלק האחרון של המזהה — ‎omniroute/gemini/gemini-3-pro‎ → ‎gemini-3-pro‎. */
const leafId = (v) => String(v || '').slice(String(v || '').lastIndexOf('/') + 1);

/** מזהי מודלים שסומנו כמועדפים — נשמרים ב־settings ומופיעים בראש החלונית. */
function favoriteModels() {
  const a = store.settings && store.settings.favoriteModels;
  return Array.isArray(a) ? a.filter((id) => typeof id === 'string' && id) : [];
}
function isFavoriteModel(id) { return !!(id && favoriteModels().includes(id)); }
function toggleFavoriteModel(id) {
  if (!id) return;
  if (!store.settings) store.settings = {};
  const cur = favoriteModels().slice();
  const i = cur.indexOf(id);
  if (i >= 0) cur.splice(i, 1); else cur.push(id);
  store.settings.favoriteModels = cur;
  markSettings();
}

/**
 * מחליף את התפריט הנפתח של בורר מודלים בכפתור שפותח את חלונית החיפוש.
 * מחזיר את הכפתור; אם הבורר כבר בעץ, הכפתור נשתל לפניו.
 * קריאה חוזרת רק מרעננת את התווית — כך אפשר לקרוא אחרי כל מילוי מחדש.
 */
function attachModelSearch(sel) {
  if (sel._mpSync) { sel._mpSync(); return sel._mpBtn; }
  const btn = el('button', 'pill mp-btn');
  btn.type = 'button';
  btn.onclick = () => openModelPicker(sel);
  sel.classList.add('mp-native');
  sel._mpBtn = btn;
  sel._mpSync = () => {
    const o = sel.selectedOptions[0];
    const label = o ? o.textContent : 'מודל ברירת מחדל';
    btn.innerHTML = brandMarkHtml(sel.value, 16) + `<span class="mp-btn-name">${escHtml(label)}</span>`;
    btn.title = brandTitle(sel.value) + ' — לחץ לחיפוש מודל';
  };
  sel._mpSync();
  if (sel.parentElement) sel.parentElement.insertBefore(btn, sel);
  return btn;
}

function openModelPicker(sel) {
  mpState = { sel, cur: sel.value, items: [], idx: 0 };
  $('modelPicker').classList.remove('hidden');
  const inp = $('modelPickerInput');
  inp.value = '';
  buildModelPicker('');
  // בטלפון מקלדת שקופצת בולעת חצי מסך; שם עדיף להתחיל ברשימה גלויה, וההקלדה
  // זמינה בנגיעה אחת בשדה.
  if (!isTouch()) inp.focus();
}
function closeModelPicker() { $('modelPicker').classList.add('hidden'); mpState = null; }

/** תוצאות החיפוש: כל מילה חייבת להימצא בשם, במזהה או בקטגוריה.
 *  מועדפים עולים לקבוצה «מועדפים» בראש הרשימה (לפי סדר הסימון), בלי כפילות
 *  בקטגוריה המקורית. */
function modelPickerItems(sel, q) {
  const toks = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = [];
  for (const o of sel.options) {
    const group = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '';
    const hay = (o.textContent + ' ' + o.value + ' ' + group).toLowerCase();
    if (toks.length && !toks.every((t) => hay.includes(t))) continue;
    items.push({ value: o.value, label: o.textContent, group });
  }
  const favOrder = favoriteModels();
  if (!favOrder.length) return items;
  const favSet = new Set(favOrder);
  const byVal = new Map(items.map((it) => [it.value, it]));
  const top = [];
  for (const id of favOrder) {
    const it = byVal.get(id);
    if (it) top.push({ value: it.value, label: it.label, group: 'מועדפים' });
  }
  const rest = items.filter((it) => !it.value || !favSet.has(it.value));
  return top.concat(rest);
}
function buildModelPicker(q) {
  if (!mpState) return;
  mpState.items = modelPickerItems(mpState.sel, q);
  // בפתיחה הסימון יושב על המודל הנוכחי; בחיפוש — על התוצאה הראשונה
  const at = mpState.items.findIndex((x) => x.value === mpState.cur);
  mpState.idx = q.trim() ? 0 : Math.max(0, at);
  renderModelPicker();
}
function renderModelPicker() {
  const list = $('modelPickerList'); const st = mpState;
  list.innerHTML = '';
  if (!st.items.length) {
    list.appendChild(el('div', 'pl-empty', 'אין מודל שמתאים לחיפוש'));
    $('modelPickerFoot').textContent = '';
    return;
  }
  // המונה שבכותרת הוא מספר *התוצאות* בקטגוריה, לא גודל הקטגוריה: בחיפוש
  // "52" לצד שלוש שורות היה נראה כמו רשימה שנחתכה.
  const hits = {};
  for (const it of st.items) hits[it.group] = (hits[it.group] || 0) + 1;
  // מועדפים בשורה אופקית לכל רוחב החלונית; שאר הקטגוריות נשפכות לעמודות
  // (‎.mp-cols‎). הסדר במערך נשאר רציף — ניווט מקלדת והחיפוש לא משתנים.
  const favs = el('div', 'mp-favs');
  const cols = el('div', 'mp-cols');
  let lastGroup = null;
  let favMounted = false;
  st.items.forEach((it, i) => {
    const isFav = it.group === 'מועדפים';
    if (it.group !== lastGroup) {
      lastGroup = it.group;
      if (it.group) {
        const host = isFav ? favs : cols;
        if (isFav && !favMounted) { list.appendChild(favs); favMounted = true; }
        host.appendChild(el('div', 'pl-group' + (isFav ? ' mp-favs-label' : ''),
          it.group.replace(/\s·\s\d+\s*$/, '') + ' · ' + hits[it.group]));
        if (isFav) host.appendChild(el('div', 'mp-favs-row'));
      }
    }
    const row = el('div', 'pl-item mp-item' + (isFav ? ' mp-fav-chip' : '')
      + (i === st.idx ? ' sel' : '') + (it.value === st.cur ? ' mp-cur' : ''));
    // הסימן תופס את מקומו של החץ: באותו רוחב, ועם מידע שהחץ לא נשא. המודל
    // הנבחר מסומן בפס האקצנט של ‎.mp-cur‎ ולא ב-✓, כדי לא להחליף את הסימן
    // בדיוק בשורה שבה חשוב לראות אותו.
    const ic = el('span', 'pl-ic');
    ic.appendChild(brandMarkEl(it.value, 17));
    row.appendChild(ic);
    row.appendChild(el('span', 'mp-name', it.label));
    // המזהה מוצג רק כשהוא מוסיף מידע: אצל רוב השערים שם המודל *הוא* המזהה,
    // ושורה שכתוב בה אותו דבר פעמיים רק מקשה על הסריקה.
    if (!isFav && it.value && !it.label.toLowerCase().includes(leafId(it.value).toLowerCase())) {
      row.appendChild(el('span', 'pl-sub', it.value));
    }
    if (it.value) {
      const on = isFavoriteModel(it.value);
      const fav = el('button', 'mp-fav' + (on ? ' on' : ''));
      fav.type = 'button';
      fav.title = on ? 'הסר ממועדפים' : 'הוסף למועדפים';
      fav.setAttribute('aria-label', fav.title);
      fav.setAttribute('aria-pressed', on ? 'true' : 'false');
      fav.textContent = on ? '★' : '☆';
      fav.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFavoriteModel(it.value);
        buildModelPicker($('modelPickerInput').value);
      };
      row.appendChild(fav);
    }
    row.onmousedown = (e) => { e.preventDefault(); pickModel(i); };
    if (isFav) {
      const strip = favs.querySelector('.mp-favs-row');
      if (strip) strip.appendChild(row);
    } else {
      cols.appendChild(row);
    }
  });
  if (cols.childNodes.length) list.appendChild(cols);
  $('modelPickerFoot').textContent = st.items.length + ' מודלים · ★ מועדף · ↑↓ לניווט · Enter לבחירה';
  const sel = list.querySelector('.pl-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function pickModel(i) {
  const st = mpState;
  if (!st) return;
  const it = st.items[i == null ? st.idx : i];
  closeModelPicker();
  if (!it) return;
  // change הוא מה שמפעיל את כל השרשרת הקיימת: שמירה, שליחה לשרת, עדכון המאמץ
  if (st.sel.value !== it.value) {
    st.sel.value = it.value;
    st.sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (st.sel._mpSync) st.sel._mpSync();
}
$('modelPickerInput').addEventListener('input', (e) => buildModelPicker(e.target.value));
$('modelPickerInput').addEventListener('keydown', (e) => {
  if (!mpState) return;
  if (e.key === 'Escape') { e.preventDefault(); closeModelPicker(); return; }
  const n = mpState.items.length;
  if (!n) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); mpState.idx = (mpState.idx + 1) % n; renderModelPicker(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); mpState.idx = (mpState.idx - 1 + n) % n; renderModelPicker(); }
  else if (e.key === 'Enter') { e.preventDefault(); pickModel(); }
});
$('modelPicker').addEventListener('click', (e) => { if (e.target === $('modelPicker')) closeModelPicker(); });

async function loadConfig() {
  try { const r = await fetch('/api/config'); if (r.ok) CONFIG = await r.json(); } catch {}
  // הכפתור נדלק רק כשה-CLI שמותקן כאן באמת יודע לרוץ בלי לשמור סשן
  anonAvailable = !!(CONFIG && CONFIG.anonymous);
  const nav = $('newAnon');
  if (nav) {
    nav.classList.toggle('disabled', !anonAvailable);
    nav.title = anonAvailable
      ? 'שיחה שלא נשמרת בשום מקום — נמחקת ביציאה'
      : 'לא זמין: ה-CLI המותקן לא מכיר --no-session-persistence';
  }
  populateModels(); populatePerms(); updateEfforts(); updateStatusbar();
}
function populateModels() {
  const sel = $('model'); const cur = store.settings.model || '';
  sel.innerHTML = ''; sel.appendChild(opt('', 'מודל ברירת מחדל'));
  fillModelOptions(sel);
  keepValue(sel, cur, '');
  attachModelSearch(sel);   // גם משתיל את כפתור החיפוש וגם מרענן את התווית
}
function modelEfforts() {
  const m = CONFIG.models.find(x => x.id === $('model').value);
  if (m) return m.efforts || [];
  const s = new Set(); CONFIG.models.forEach(x => (x.efforts || []).forEach(e => s.add(e))); return [...s];
}
function updateEfforts() {
  const sel = $('effort'); const cur = sel.value || store.settings.effort || '';
  const efforts = modelEfforts(); const has = efforts.length > 0;
  sel.innerHTML = ''; sel.appendChild(opt('', 'מאמץ רגיל'));
  EFFORT_ORDER.filter(e => efforts.includes(e)).forEach(e => sel.appendChild(opt(e, EFFORT_LABEL[e] || e)));
  sel.disabled = !has;
  if (sel.parentElement) sel.parentElement.style.display = has ? '' : 'none';
  keepValue(sel, cur, '');
  if (!has) sel.value = '';
}
/**
 * מצבי ההרשאה משתנים עם הסוכן, ולכן הבורר נבנה מחדש בכל החלפת מודל. הבחירה
 * נזכרת *לכל סוכן בנפרד*: מי שעבד ב'תכנון בלבד' מול Claude וחזר אליו אחרי
 * סיבוב ב-Cursor מוצא את מה שהשאיר, ולא ערך שנפל לברירת מחדל בדרך.
 */
const withGodMode = (modes) => (modes.includes('god') ? modes : [...modes, 'god']);
/** הבורר עצמו נצבע כשהמצב הנבחר הוא GOD — אי אפשר להיות בו בלי לראות את זה. */
function markGodPill() {
  const sel = $('perm');
  if (!sel) return;
  const god = sel.value === 'god';
  sel.classList.toggle('god-on', god);
  // title על ה־<select> עצמו (לא רק על ה־<option>): בטלפון אין hover על אפשרות
  // ברשימה לפני הבחירה, ואחריה חייבים הסבר גלוי בלי לפתוח את התפריט שוב.
  sel.title = god ? GOD_HINT
    : (activeAgent() === 'cursor' ? 'מצב הרשאות · cursor-agent' : 'מצב הרשאות · Claude Code');
}
function populatePerms() {
  const sel = $('perm');
  const cursorMode = activeAgent() === 'cursor';
  const modes = cursorMode
    ? ((CONFIG.cursorPermissionModes || []).length ? CONFIG.cursorPermissionModes : ['force', 'default', 'plan', 'ask'])
    // GOD הוא מצב של הממשק ולא של ה-CLI, ולכן הוא מובטח כאן גם מול שרת
    // שהרשימה שלו הגיעה מ---help בלבד.
    : withGodMode((CONFIG.permissionModes || []).length ? CONFIG.permissionModes : ['acceptEdits', 'plan', 'bypassPermissions']);
  const fallback = cursorMode
    ? (CONFIG.cursorPermissionDefault || 'force')
    : (modes.includes('acceptEdits') ? 'acceptEdits' : modes[0]);
  const remembered = cursorMode ? store.settings.cursorPerm : store.settings.perm;
  sel.innerHTML = '';
  for (const md of modes) {
    const o = opt(md, (cursorMode && CURSOR_PERM_LABEL[md]) || PERM_LABEL[md] || md);
    if (cursorMode && CURSOR_PERM_HINT[md]) o.title = CURSOR_PERM_HINT[md];
    if (md === 'god') { o.className = 'opt-god'; o.title = GOD_HINT; }
    sel.appendChild(o);
  }
  keepValue(sel, remembered, fallback);
  markGodPill();
}

// ---------- טיוטות ותיקיית עבודה לכל שיחה ----------
// טיוטה: מה שהוקלד ולא נשלח נשמר עם השיחה — יציאה וכניסה לא מוחקות אותו.
function stashDraft() {
  const c = activeConv();
  if (!c || !c.loaded) return;
  const v = $('input').value;
  if ((c.draft || '') === v) return;
  c.draft = v;
  markDirty(c);
  // טיוטה שהתחלת להקליד במחשב ממשיכה בטלפון — היא מגיעה רק לשדה ריק בצד השני,
  // כדי שלא נמחק לך טקסט שאתה מקליד באותו רגע.
  sendUi('draft', v);
}
function restoreDraft() {
  const c = activeConv();
  const i = $('input');
  i.value = (c && c.draft) || '';
  autoGrow();
}
const stashDraftSoon = debounce(stashDraft, 500);

/**
 * ניקוי התיבה אחרי שליחה — כולל ביטול הטיוטה במכשיר השני.
 *
 * ‎stashDraft‎ לא מספיק כאן משתי סיבות: השמה ל-‎value‎ אינה מייצרת אירוע
 * ‎input‎, ובמסלול שכבר אפס את ‎conv.draft‎ הוא יוצא מוקדם כי אין מה לשמור.
 * בלי השידור המפורש, המכשיר השני נשאר עם הטקסט *שכבר נשלח* בתיבת הכתיבה
 * שלו — ומאחר שטיוטה מרחוק נכנסת רק לשדה ריק, היא גם לא תנוקה משם לבד.
 */
function clearComposer() {
  const i = $('input');
  if (i.value) { i.value = ''; autoGrow(); }
  const c = activeConv();
  if (c && c.draft) { c.draft = ''; markDirty(c); }
  sendUi('draft', '');
}

/** תיקיית העבודה נזכרת לכל שיחה בנפרד — לא מריצים פקודות בפרויקט הלא נכון. */
function syncConvCwd() {
  const c = activeConv();
  $('cwd').value = (c && c.cwd) || store.settings.cwd || '';
  syncNoDirUi();
  updateCwdChip();
  checkCwd();
}
function updateCwdChip() {
  const chip = $('cwdChip');
  if (!chip) return;
  const v = ($('cwd').value || '').trim();
  if (isNoDir(v)) {
    $('cwdChipText').textContent = isNarrow() ? 'שיחה' : 'ללא תיקייה';
    chip.title = 'שיחה ללא תיקייה — בלי כלים ובלי גישה לקבצים · לחץ לשינוי';
    chip.classList.remove('icon-only');
    return;
  }
  const short = v ? v.replace(/^\/home\/[^/]+/, '~') : '~';
  // בטלפון אין מקום לנתיב מלא בסרגל העליון. קודם נחתכו כאן 14 תווים מהסוף,
  // וה-CSS חתך שוב את מה שנשאר — כך "‎~/Downloads/Progects/rtl-claude‎" הגיע
  // למסך כ-"‎…ts…‎", שהיא בדיוק כמות המידע של כלום. בצר מציגים את שם התיקייה
  // עצמה: זה מה שעונה על "באיזה פרויקט אני". הנתיב המלא נשאר ב-title ובהגדרות.
  const narrow = isNarrow();
  const name = short.split('/').filter(Boolean).pop() || short;
  const text = narrow ? name : (short.length > 34 ? '…' + short.slice(-33) : short);
  const label = $('cwdChipText');
  label.textContent = text;
  chip.title = 'תיקיית העבודה של השיחה: ' + (v || '~') + ' · לחץ לשינוי';
  // הצ׳יפ מתחרה על הרוחב עם כותרת השיחה, ובמסך צר הוא יכול לקבל פחות מרוחב
  // של אות. "o" חתוך מתוך "overflow" הוא לא פחות מידע מאייקון — הוא פחות
  // *ו*נראה שבור. לכן מודדים אחרי הכתיבה, וכשלא נשאר מספיק מוותרים על
  // הכיתוב לגמרי: אייקון תיקייה שהוא יעד מגע שלם, והנתיב ב-title ובהגדרות.
  chip.classList.remove('icon-only');
  const visible = label.clientWidth, needed = label.scrollWidth;
  if (needed > 0 && visible < Math.min(needed, 34)) chip.classList.add('icon-only');
}
// גם המפרידים בשורת המצב תלויים ברוחב: מעבר מעל/מתחת ל-760px מסתיר או מחזיר
// פריטים ב-media query, ובלי חישוב מחדש נשאר "·" יתום עד העדכון הבא.
addEventListener('resize', () => { updateCwdChip(); markStatusSeparators(); });

/* ---------- הסרגל העליון לפי הרוחב שלו, לא של החלון ----------
   בדסקטופ סרגל השיחות הוא עמודה בגריד, ולכן ‎max-width‎ על החלון לא יודע כמה
   נשאר לסרגל העליון: חלון 800px עם סרגל פתוח משאיר לו ~520px, ושם שבעת
   הכפתורים + "נשמר" + תגית הנוכחות דחסו את כותרת השיחה לרוחב אפס. כאן מודדים
   את האלמנט עצמו — כך זה נכון גם אחרי כיווץ הסרגל או גרירת רוחבו.
   שני ספים (לא אחד) כדי שגרירה סביב הגבול לא תבהב הלוך ושוב. */
(function fitTopbar() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const TIGHT_BELOW = 640, WIDE_ABOVE = 700;
  const apply = () => {
    const w = bar.clientWidth;
    if (!w) return;
    if (w < TIGHT_BELOW) bar.classList.add('tight');
    else if (w > WIDE_ABOVE) bar.classList.remove('tight');
  };
  new ResizeObserver(apply).observe(bar);
  apply();
})();

/* ---------- רצועת הבוררים: רמז גלילה ----------
   כשהרצועה צרה מתוכנה, בורר נחתך באמצע מילה — וזה נראה כמו פריסה שבורה ולא
   כמו "יש עוד, גלול". הדהוי בקצה הוא ההבדל. הצד שממנו נשאר תוכן נקבע לפי
   המיקום בפועל של הילדים ולא לפי scrollLeft, כי הסימן שלו ב-RTL שונה
   בין דפדפנים. */
(function pillRowScrollHint() {
  const row = document.querySelector('.pill-row');
  if (!row) return;
  const apply = () => {
    const box = row.getBoundingClientRect();
    let left = Infinity, right = -Infinity;
    for (const kid of row.children) {
      const r = kid.getBoundingClientRect();
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
    }
    if (!isFinite(left)) return;
    row.classList.toggle('ovf-left', box.left - left > 1);
    row.classList.toggle('ovf-right', right - box.right > 1);
  };
  row.addEventListener('scroll', apply, { passive: true });
  new ResizeObserver(apply).observe(row);
  addEventListener('resize', apply);
  apply();
})();

// ---------- אתחול ----------
async function init() {
  // כותרת חלון קבועה — KWin משייך לפיה את החלון לאייקון rtl-claude (לא Brave)
  document.title = BASE_TITLE;
  connect(); $('input').focus();

  try {
    await loadStoreFromServer();
    await migrateLegacy();
    storeReady = true;
  } catch (e) {
    // בלי אחסון אין טעם להעמיד פנים שנשמר — אומרים את זה במפורש.
    addNote('לא ניתן לטעון את היסטוריית השיחות מהשרת (' + (e.message || e) + '). שיחות בסשן הזה לא יישמרו.', true);
    toast('אחסון השיחות אינו זמין', true);
  }

  // כל מה שתלוי בהגדרות חייב לרוץ רק אחרי שהן הגיעו מהשרת
  if (store.settings.theme) document.documentElement.setAttribute('data-theme', store.settings.theme);
  syncHljsTheme();   // אחרי החלת הערכה השמורה, ולא לפניה
  initSideResize();
  applyWide();
  dictPaint();        // חושף את המיקרופון ומציג את השפה שנשמרה בהגדרות
  renderNotifyChip(); // תלוי ב-settings.notify, לכן רק אחרי שההגדרות הגיעו
  if (!activeId) newConv();
  const cur = activeConv();
  if (cur && !cur.loaded) await ensureLoaded(cur.id);
  syncConvCwd(); restoreDraft();
  renderConvList(); renderConversation();
  // מנוי על השיחה הפעילה. אם התור שלה עדיין רץ בשרת (סגרת את החלון באמצע,
  // או שהתחלת אותו מהטלפון) — ה-sync יחזיר אותנו בדיוק לאמצע התור.
  subscribeActive(true);
  loadConfig();
  refreshUsage(); setInterval(refreshUsage, 30000); // ניצול מכסה — רענון חי כל 30 שנ׳
  if (storeReady) { setSaveState('saved'); scheduleFlush(); } else setSaveState('error');
  takeSharedInput();
  runLaunchShortcut();
}

/* לחיצה ארוכה על האייקון במסך הבית פותחת את הקיצורים שבמניפסט, וכל אחד מהם
   הוא בסך הכול כתובת. הפעולה נעשית *אחרי* ‎init‎ בכוונה: "שיחה חדשה" לפני
   שההגדרות והשיחות הגיעו מהשרת הייתה נמחקת ברגע שהן מגיעות. */
function runLaunchShortcut() {
  const go = new URLSearchParams(location.search).get('go');
  if (!go) return;
  history.replaceState(null, '', location.pathname);
  if (go === 'new') newConv();
  else if (go === 'duet') $('newDuet').click();
}
init();

/* ==========================================================================
   שיתוף מאפליקציה אחרת בטלפון
   --------------------------------------------------------------------------
   ‎share_target‎ שבמניפסט מוסיף את האפליקציה לתפריט השיתוף של המערכת. ה-POST
   נקלט ב-Service Worker (ראו takeShare שם), מה שהתקבל מחכה ב-Cache Storage,
   והדף נפתח עם ‎?share=1‎. כאן אוספים אותו: הטקסט נכנס לשדה הכתיבה, והתמונות
   נכנסות כצירופים באותו מסלול בדיוק שמשרת הדבקה וגרירה — כלומר הן נשלחות
   למודל כ-base64 ולא כקובץ, וכל מה שנאמר על צירופים תקף גם כאן.
   מה שנאסף נמחק מיד: התיבה הזו היא מעבר, לא אחסון.
   ========================================================================== */
async function takeSharedInput() {
  if (new URLSearchParams(location.search).get('share') !== '1') return;
  // הכתובת מתנקה מיד, כדי שרענון לא ינסה לאסוף שיתוף שכבר נאסף
  history.replaceState(null, '', location.pathname);
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('rtl-claude-share');
    const keys = await cache.keys();
    if (!keys.length) return;
    let text = '';
    const files = [];
    for (const k of keys) {
      const res = await cache.match(k);
      if (!res) continue;
      if (new URL(k.url).pathname === '/__share/text') { text = await res.text(); continue; }
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Share-Name') || 'שיתוף.png');
      files.push(new File([blob], name, { type: blob.type || 'image/png' }));
    }
    for (const k of keys) await cache.delete(k);

    if (text) {
      const input = $('input');
      // לא דורסים טיוטה שכבר הייתה שם — השיתוף מצטרף לסופה
      input.value = input.value ? input.value.replace(/\s*$/, '') + '\n' + text : text;
      autoGrow(); stashDraft();
    }
    for (const f of files) await addAttachment(f, true);
    $('input').focus();
    dlog('share.in', { chars: text.length, files: files.length });
    if (files.length) toast(files.length === 1 ? 'תמונה צורפה מהשיתוף' : files.length + ' תמונות צורפו מהשיתוף');
  } catch (e) {
    dlog('share.fail', { err: String((e && e.message) || e) });
  }
}

/* ==========================================================================
   פיצ'רים חזקים — הנגשת פונקציות הטרמינל ב-GUI
   אישור הרשאות אינטראקטיבי · פקודות סלאש · אזכור קבצים @ · סשנים על הדיסק · MCP
   ========================================================================== */

/* ==========================================================================
   שאלות ובקשות הרשאה
   --------------------------------------------------------------------------
   ה-CLI (עם --permission-prompt-tool stdio) מפנה כל בקשת הרשאה כ-can_use_tool.
   שאלה אמיתית של Claude עוברת באותו ערוץ ככלי AskUserQuestion — ועד היום היא
   הוצגה ככרטיס "אשר / דחה" עם ה-JSON הגולמי, כלומר נשאלת שאלה בלי שום דרך
   לענות עליה. עכשיו מרנדרים את השאלות והאפשרויות, והתשובה חוזרת ל-CLI בתוך
   updatedInput.answers (המקום שבו הוא מצפה לקבל תשובות מרכיב ההרשאות).

   בנוסף: הכרטיס נשמר כבלוק בתמליל, ולכן שורד רינדור מחדש, מעבר בין שיחות
   ורענון — במקום להיעלם ולהשאיר את ה-CLI תקוע בהמתנה.
   ========================================================================== */

function permWaiting() {
  const t = $('workingText');
  if (t && pendingPerms.size) t.textContent = pendingAskCount() ? 'ממתין לתשובה שלך…' : 'ממתין לאישור הרשאה…';
}
function pendingAskCount() {
  let n = 0;
  for (const [, p] of pendingPerms) if (p.ref && p.ref.tool === 'AskUserQuestion') n++;
  return n;
}

/** מוסיפה בלוק שאלה/הרשאה לתמליל, כדי שהכרטיס ישרוד כל רינדור מחדש. */
function pushAskBlock(ref) {
  if (!ensureLive()) return null;
  live.msgObj.blocks.push(ref);
  pendingPerms.set(ref.id, { ref });   // לפני הציור — אחרת הכרטיס ייצא בלי כפתורים
  let node = null;
  if (live.contentEl && document.body.contains(live.contentEl)) {
    node = renderAskCard(ref);
    live.contentEl.appendChild(node);
  }
  // נרשם ב-tools כדי ש-rebindLiveDom ישחזר את ה-DOM אחרי מעבר בין שיחות
  live.tools.set('ask:' + ref.id, { ref, el: node });
  persist();
  return ref;
}
function askHolder(id) { return live && live.tools.get('ask:' + id); }
/** מציירת מחדש כרטיס קיים במקומו (אחרי מענה/ביטול). */
function refreshAskCard(ref) {
  const h = askHolder(ref.id);
  if (!h || !h.el || !h.el.parentNode) return;
  const fresh = renderAskCard(ref);
  h.el.parentNode.replaceChild(fresh, h.el);
  h.el = fresh;
}

function newAskRef(id, tool, input, description) {
  return { type: 'ask', id, tool, input: input || {}, description: description || '', decision: null, answers: null, response: '' };
}

function showPermission(id, req) {
  req = req || {};
  const ref = newAskRef(id, req.tool_name || 'כלי', req.input || {}, req.description || '');
  ref.suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
  if (!pushAskBlock(ref)) return;
  permWaiting();
  renderAskBar();
  notifyQuestion(ref);
  // לא קופצים בכוח לשיחה אחרת — הפס העליון "ממתין לתשובה" מוביל לשם בלחיצה
  if (streamOwnerId && activeId !== streamOwnerId) toast('Claude ממתין לתשובה בשיחה אחרת');
  else autoScroll();
}

function decidePermission(id, decision, extra, ref) {
  const pre = ref || (pendingPerms.get(id) || {}).ref;
  if (ws && ws.readyState === ws.OPEN) {
    // label/answers נוסעים יחד עם ההחלטה כדי שהכרטיס במכשיר השני ייסגר עם
    // הניסוח המדויק ("נענה" / "התוכנית אושרה") ועם התשובה שנבחרה בפועל.
    ws.send(JSON.stringify({
      type: 'permission', requestId: id, decision, ...extra,
      label: (pre && pre.decision) || decision,
      answers: (pre && pre.answers) || null,
      response: (pre && pre.response) || null,
    }));
  }
  closeAskNotification(id);
  const p = pendingPerms.get(id);
  const r = ref || (p && p.ref);
  pendingPerms.delete(id);
  // הקורא כבר יכול היה לקבוע ניסוח מדויק יותר ("נענה" / "דולג") — לא דורסים אותו
  if (r) { if (!r.decision) r.decision = decision; refreshAskCard(r); persist(); }
  renderAskBar();
  if (!pendingPerms.size) renderWorking();
}

/**
 * ההתראה של בקשה שכבר נענתה חייבת לרדת מהמגירה. עם requireInteraction היא
 * נשארת שם עד שנוגעים בה, וכפתור "אשר" שמצביע על בקשה סגורה הוא בדיוק סוג
 * ההתראה שמלמדת להתעלם מהתראות.
 */
function closeAskNotification(id) {
  navigator.serviceWorker?.ready
    .then((reg) => reg.getNotifications({ tag: 'ask-' + id }))
    .then((list) => { for (const n of list) n.close(); })
    .catch(() => {});
}

function closePermission(id, note) {
  closeAskNotification(id);
  const p = pendingPerms.get(id);
  pendingPerms.delete(id);
  if (p && p.ref) { p.ref.decision = note; refreshAskCard(p.ref); persist(); }
  renderAskBar();
  if (!pendingPerms.size) renderWorking();
}
function cancelPermission(id) { closePermission(id, 'cancelled'); }
function clearAllPerms() {
  for (const id of [...pendingPerms.keys()]) closePermission(id, 'ended');
  renderAskBar();
}

/* ==========================================================================
   יומן GOD
   --------------------------------------------------------------------------
   במצב GOD אין כרטיסי אישור — השרת עונה "אשר" ומשדר לכאן שורה על כל בקשה.
   הן נאספות לאורך התור, וכשהוא נגמר נכנסות ככרטיס אחד מקופל בסוף ההודעה:
   כפתור שאומר כמה בקשות אושרו, ומתחתיו כל אחת מהן עם הקלט המלא שלה — אותה
   תצוגה בדיוק שהייתה בכרטיס האישור, רק בדיעבד. הכרטיס נשמר בתמליל, ולכן הוא
   שם גם אחרי רענון דף ובמכשיר השני.
   ========================================================================== */
function onGodAllow(entry) {
  if (!entry || !entry.tool) return;
  godTurn.push(entry);
  dlog('god.allow', { tool: entry.tool, n: godTurn.length });
  renderWorking();   // בפס "עובד…" רואים שהאישורים נמשכים, ולא רק בסוף
}

/** סוגר את יומן התור לכרטיס בתמליל. נקרא בסיום תור וגם כשהוא נשבר באמצע. */
function pushGodBlock() {
  if (!godTurn.length) return;
  const ref = { type: 'god', items: godTurn, at: Date.now() };
  godTurn = [];
  if (!ensureLive()) return;
  live.msgObj.blocks.push(ref);
  if (live.contentEl && document.body.contains(live.contentEl)) {
    live.contentEl.appendChild(renderGodCard(ref));
    autoScroll();
  }
  persist();
}

/** שורה אחת ביומן — אותו כרטיס כלי המוכר, עם שעת האישור במקום הסטטוס. */
function godRow(it) {
  const d = el('details', 'tool god-row');
  d.innerHTML = '<summary><span class="ticon"></span><span class="tname"></span><span class="tprev"></span><span class="god-time"></span><span class="chev">▸</span></summary><div class="tbody"></div>';
  d.querySelector('.ticon').textContent = toolIcon(it.tool);
  d.querySelector('.tname').textContent = it.tool || 'כלי';
  d.querySelector('.tprev').textContent = it.desc || toolPreview(it.tool, it.input);
  d.querySelector('.god-time').textContent = it.at ? new Date(it.at).toLocaleTimeString('he-IL') : '';
  renderToolBody(d.querySelector('.tbody'), { name: it.tool, input: it.input || {}, result: null, status: 'ok' });
  return d;
}

function renderGodCard(ref) {
  const items = Array.isArray(ref.items) ? ref.items : [];
  const card = el('div', 'godlog');
  const btn = el('button', 'god-btn');
  btn.type = 'button';
  btn.title = 'מה מצב GOD אישר אוטומטית בתור הזה';
  btn.appendChild(el('span', 'god-ic', '⚡'));
  btn.appendChild(el('span', 'god-btn-txt', items.length === 1
    ? 'GOD · בקשה אחת אושרה אוטומטית'
    : `GOD · ${items.length} בקשות אושרו אוטומטית`));
  btn.appendChild(el('span', 'god-chev', '▾'));
  const body = el('div', 'god-body hidden');
  items.forEach((it) => body.appendChild(godRow(it)));
  btn.onclick = () => {
    const closed = body.classList.toggle('hidden');
    card.classList.toggle('open', !closed);
  };
  card.appendChild(btn);
  card.appendChild(body);
  return card;
}

// ---------- ציור הכרטיסים ----------
const DECISION_LABEL = {
  allow: '✓ אושר', deny: '✕ נדחה', cancelled: 'בוטל', ended: 'הסתיים',
  answered: '✓ נענה', skipped: 'דולג', approved: '✓ התוכנית אושרה', replan: '✎ חוזרים לתכנון',
  god: '⚡ אושר ב-GOD',
};

function renderAskCard(ref) {
  const isLive = pendingPerms.has(ref.id) && !ref.decision;
  if (ref.tool === 'AskUserQuestion') return renderQuestionCard(ref, isLive);
  if (ref.tool === 'ExitPlanMode') return renderPlanCard(ref, isLive);
  if (ref.tool === '__dialog__') return renderDialogCard(ref, isLive);
  return renderPermCard(ref, isLive);
}

function askVerdict(ref) {
  const bar = el('div', 'perm-actions');
  bar.appendChild(el('span', 'perm-verdict', DECISION_LABEL[ref.decision] || 'הסתיים'));
  return bar;
}
function decidedClass(ref) {
  if (!ref.decision) return ' stale';
  return ['allow', 'answered', 'approved'].includes(ref.decision) ? ' decided-allow' : ' decided-deny';
}

/** כרטיס שאלה אמיתי: כותרת, אפשרויות לבחירה, ריבוי-בחירה ותשובה חופשית. */
function renderQuestionCard(ref, isLive) {
  const card = el('div', 'perm ask' + (isLive ? '' : decidedClass(ref)));
  card.dataset.askId = ref.id;
  const head = el('div', 'perm-head');
  head.innerHTML = `<span class="perm-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M9.8 9.6a2.3 2.3 0 1 1 2.9 2.6v1.2"/><path d="M12.7 16.6h.01"/></svg></span><b>Claude שואל אותך</b><span class="perm-tool">שאלה</span>`;
  card.appendChild(head);

  const questions = Array.isArray(ref.input && ref.input.questions) ? ref.input.questions : [];
  const state = new Map();   // שאלה → { labels:Set, other:string }
  for (const q of questions) state.set(q.question, { labels: new Set(), other: '' });

  // שחזור תשובה שכבר ניתנה (כרטיס היסטורי)
  if (ref.answers) {
    for (const [qt, val] of Object.entries(ref.answers)) {
      const st = state.get(qt); if (!st) continue;
      const known = new Set(((questions.find((q) => q.question === qt) || {}).options || []).map((o) => o.label));
      for (const part of String(val).split(',').map((s) => s.trim()).filter(Boolean)) {
        if (known.has(part)) st.labels.add(part); else st.other = st.other ? st.other + ', ' + part : part;
      }
    }
  }

  const body = el('div', 'ask-body');
  const submitRefs = [];

  questions.forEach((q) => {
    const st = state.get(q.question);
    const block = el('div', 'ask-q');
    if (q.header) block.appendChild(el('span', 'ask-chip', q.header));
    block.appendChild(el('div', 'ask-title', q.question));
    if (q.multiSelect) block.appendChild(el('div', 'ask-hint', 'אפשר לבחור כמה תשובות'));

    const opts = el('div', 'ask-opts');
    const otherWrap = el('div', 'ask-other' + (st.other ? '' : ' hidden'));
    const otherInput = el('input', 'ask-other-input');
    otherInput.type = 'text';
    otherInput.placeholder = 'תשובה משלך…';
    otherInput.value = st.other;
    otherInput.disabled = !isLive;
    otherInput.oninput = () => { st.other = otherInput.value; syncValid(); };
    otherWrap.appendChild(otherInput);

    const rows = [];
    const on = q.multiSelect ? '☑' : '●', off = q.multiSelect ? '☐' : '○';
    const syncRows = () => {
      rows.forEach(({ node, label, mark }) => {
        const sel = st.labels.has(label);
        node.classList.toggle('on', sel);
        mark.textContent = sel ? on : off;
      });
      otherWrap.classList.toggle('hidden', !st.labels.has('__other__') && !st.other);
    };

    (q.options || []).forEach((o) => {
      const row = el('button', 'ask-opt');
      row.type = 'button';
      row.disabled = !isLive;
      const mark = el('span', 'ask-mark', off);
      const txt = el('span', 'ask-opt-txt');
      txt.appendChild(el('span', 'ask-label', o.label));
      if (o.description) txt.appendChild(el('span', 'ask-desc', o.description));
      row.appendChild(mark); row.appendChild(txt);
      row.onclick = () => {
        if (!isLive) return;
        if (q.multiSelect) { st.labels.has(o.label) ? st.labels.delete(o.label) : st.labels.add(o.label); }
        else { st.labels.clear(); st.labels.add(o.label); st.other = ''; otherInput.value = ''; }
        syncRows(); syncValid();
      };
      rows.push({ node: row, label: o.label, mark });
      opts.appendChild(row);
      // התצוגה המקדימה יושבת אחרי הכפתור ולא בתוכו — details בתוך button
      // הוא HTML לא חוקי ומתנהג באופן בלתי צפוי.
      if (o.preview) {
        const pv = el('details', 'ask-preview');
        pv.appendChild(el('summary', null, 'תצוגה מקדימה · ' + o.label));
        const pre = el('pre'); pre.textContent = o.preview;
        pv.appendChild(pre);
        opts.appendChild(pv);
      }
    });

    // "אחר" — התיאור של הכלי מבטיח שהאפשרות הזו תמיד קיימת עבור המשתמש
    const otherRow = el('button', 'ask-opt other');
    otherRow.type = 'button';
    otherRow.disabled = !isLive;
    const otherMark = el('span', 'ask-mark', off);
    otherRow.appendChild(otherMark);
    const ot = el('span', 'ask-opt-txt');
    ot.appendChild(el('span', 'ask-label', 'אחר…'));
    ot.appendChild(el('span', 'ask-desc', 'ניסוח חופשי משלך'));
    otherRow.appendChild(ot);
    otherRow.onclick = () => {
      if (!isLive) return;
      if (!q.multiSelect) st.labels.clear();
      st.labels.has('__other__') ? st.labels.delete('__other__') : st.labels.add('__other__');
      syncRows(); syncValid();
      if (st.labels.has('__other__')) otherInput.focus();
    };
    rows.push({ node: otherRow, label: '__other__', mark: otherMark });
    opts.appendChild(otherRow);

    block.appendChild(opts);
    block.appendChild(otherWrap);
    body.appendChild(block);
    submitRefs.push({ q, st, syncRows });
    syncRows();
  });

  card.appendChild(body);

  /** אוסף את התשובות לפורמט שה-CLI מצפה לו: {טקסט השאלה: תשובה}. */
  const collect = () => {
    const answers = {}, annotations = {};
    for (const { q, st } of submitRefs) {
      const labels = [...st.labels].filter((l) => l !== '__other__');
      const parts = labels.slice();
      if (st.other.trim()) parts.push(st.other.trim());
      if (!parts.length) return null;                       // חייבים לענות על כל שאלה
      answers[q.question] = parts.join(', ');               // ריבוי-בחירה מופרד בפסיקים
      const withPreview = (q.options || []).find((o) => labels.includes(o.label) && o.preview);
      if (withPreview) annotations[q.question] = { preview: withPreview.preview };
    }
    return { answers, annotations };
  };

  let syncValid = () => {};
  if (isLive) {
    const actions = el('div', 'perm-actions');
    const send = el('button', 'pbtn allow', '✓ שלח תשובה');
    send.onclick = () => {
      const got = collect();
      if (!got) { toast('צריך לבחור תשובה לכל שאלה', true); return; }
      ref.answers = got.answers;
      ref.decision = 'answered';
      decidePermission(ref.id, 'allow', {
        updatedInput: {
          ...ref.input,
          answers: got.answers,
          ...(Object.keys(got.annotations).length ? { annotations: got.annotations } : {}),
        },
      }, ref);
    };
    const skip = el('button', 'pbtn deny', 'דלג');
    skip.title = 'לא לענות — Claude ימשיך בלי התשובה';
    skip.onclick = () => { ref.decision = 'skipped'; decidePermission(ref.id, 'deny', { message: 'המשתמש בחר לא לענות על השאלה' }, ref); };
    actions.appendChild(send); actions.appendChild(skip);
    card.appendChild(actions);
    syncValid = () => { send.disabled = !collect(); };
    syncValid();
  } else {
    if (ref.answers && Object.keys(ref.answers).length) {
      const sum = el('div', 'ask-answered');
      for (const [qt, val] of Object.entries(ref.answers)) {
        const line = el('div', 'ask-answer-line');
        line.appendChild(el('span', 'ask-a-q', clamp(qt, 70)));
        line.appendChild(el('span', 'ask-a-v', val));
        sum.appendChild(line);
      }
      card.appendChild(sum);
    }
    card.appendChild(askVerdict(ref));
  }
  return card;
}

/** אישור תוכנית (ExitPlanMode) — התוכנית עצמה מוצגת כ-Markdown, לא כ-JSON. */
function renderPlanCard(ref, isLive) {
  const card = el('div', 'perm plan' + (isLive ? '' : decidedClass(ref)));
  card.dataset.askId = ref.id;
  const head = el('div', 'perm-head');
  head.innerHTML = `<span class="perm-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="6" y="4" width="12" height="16" rx="1.5"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/></svg></span><b>Claude מציג תוכנית לאישור</b><span class="perm-tool">תוכנית</span>`;
  card.appendChild(head);
  const planText = (ref.input && (ref.input.plan || ref.input.description)) || '';
  const box = el('div', 'md plan-md');
  box.innerHTML = renderMd(planText || '_(ללא פירוט)_');
  card.appendChild(box);
  enhance(box);
  if (isLive) {
    const actions = el('div', 'perm-actions');
    const go = el('button', 'pbtn allow', '✓ אשר והתחל לעבוד');
    go.onclick = () => { ref.decision = 'approved'; decidePermission(ref.id, 'allow', { updatedInput: ref.input || {} }, ref); };
    const keep = el('button', 'pbtn deny', '✎ המשך לתכנן');
    keep.title = 'לא מתחילים לבצע — אפשר להעיר ולתקן את התוכנית';
    keep.onclick = () => { ref.decision = 'replan'; decidePermission(ref.id, 'deny', { message: 'המשתמש מבקש להמשיך בתכנון' }, ref); };
    actions.appendChild(go); actions.appendChild(keep);
    card.appendChild(actions);
  } else card.appendChild(askVerdict(ref));
  return card;
}

/** בקשת הרשאה רגילה לכלי (Bash / Edit / …). */
function renderPermCard(ref, isLive) {
  const card = el('div', 'perm' + (isLive ? '' : decidedClass(ref)));
  card.dataset.askId = ref.id;
  const tname = ref.tool || 'כלי';
  const head = el('div', 'perm-head');
  head.innerHTML = `<span class="perm-ic">${toolIcon(tname)}</span><b>Claude מבקש אישור</b><span class="perm-tool">${escHtml(tname)}</span>`;
  card.appendChild(head);
  if (ref.description) card.appendChild(el('div', 'perm-desc', ref.description));
  const body = el('div', 'perm-body');
  renderToolBody(body, { name: tname, input: ref.input || {}, result: null, status: 'run' });
  card.appendChild(body);
  if (isLive) {
    const actions = el('div', 'perm-actions');
    const allow = el('button', 'pbtn allow', '✓ אשר');
    allow.onclick = () => decidePermission(ref.id, 'allow', { updatedInput: ref.input || {} }, ref);
    actions.appendChild(allow);
    const rule = (ref.suggestions || []).find((s) => s && s.type === 'addRules');
    if (rule) {
      const always = el('button', 'pbtn always', '✓ אשר תמיד');
      always.title = 'מוסיף חוק הרשאה קבוע';
      always.onclick = () => decidePermission(ref.id, 'allow', { updatedInput: ref.input || {}, updatedPermissions: [rule] }, ref);
      actions.appendChild(always);
    }
    const deny = el('button', 'pbtn deny', '✕ דחה');
    deny.onclick = () => decidePermission(ref.id, 'deny', {}, ref);
    actions.appendChild(deny);
    card.appendChild(actions);
  } else card.appendChild(askVerdict(ref));
  return card;
}

/* ---------- בקשת control שאיננו מכירים (למשל request_user_dialog) ----------
   עד היום השרת ענה עליה מיד בשגיאה והמשתמש לא ידע שנשאל משהו. עכשיו מציגים
   את הבקשה, ואם לא נענתה — השרת עונה בשגיאה מעצמו אחרי חמש דקות. */
function showDialog(id, req) {
  const ref = newAskRef(id, '__dialog__', req || {}, '');
  if (!pushAskBlock(ref)) return;
  permWaiting(); renderAskBar(); notifyQuestion(ref); autoScroll();
}
function renderDialogCard(ref, isLive) {
  const card = el('div', 'perm' + (isLive ? '' : decidedClass(ref)));
  card.dataset.askId = ref.id;
  const head = el('div', 'perm-head');
  head.innerHTML = `<span class="perm-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 7.5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H7a2 2 0 0 1-2-2z"/></svg></span><b>Claude מבקש ממך משהו</b><span class="perm-tool">${escHtml((ref.input && ref.input.subtype) || 'בקשה')}</span>`;
  card.appendChild(head);
  card.appendChild(el('div', 'perm-desc', 'סוג בקשה שהממשק עדיין לא יודע להציג ככרטיס. זה התוכן המלא שלה:'));
  const pre = el('pre'); pre.textContent = prettyInput(ref.input || {});
  const body = el('div', 'perm-body'); body.appendChild(pre); card.appendChild(body);
  if (isLive) {
    // בלי סכמה ידועה, תשובת "הצלחה" מומצאת עלולה לבלבל את ה-CLI יותר משגיאה.
    // לכן: מציגים את הבקשה (הערך העיקרי — שתדע שנשאלת), ועונים בשגיאה מסודרת.
    const actions = el('div', 'perm-actions');
    const go = el('button', 'pbtn deny', 'הבנתי — המשך');
    go.onclick = () => { ref.decision = 'ended'; sendDialog(ref.id, null, 'הממשק אינו תומך בסוג הבקשה הזה'); };
    actions.appendChild(go);
    card.appendChild(actions);
  } else card.appendChild(askVerdict(ref));
  return card;
}
function sendDialog(id, response, error) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'dialog', requestId: id, response, error }));
  const p = pendingPerms.get(id);
  pendingPerms.delete(id);
  if (p && p.ref) { refreshAskCard(p.ref); persist(); }
  renderAskBar();
  if (!pendingPerms.size) renderWorking();
}

/* ---------- פס "ממתין לתשובה" — שאלה לא יכולה להיעלם מהעין ---------- */
function renderAskBar() {
  const bar = $('askBar');
  if (!bar) return;
  const n = pendingPerms.size;
  bar.classList.toggle('hidden', n === 0);
  document.body.classList.toggle('awaiting', n > 0);
  if (!n) return;
  const asks = pendingAskCount();
  $('askBarText').textContent = asks
    ? (asks > 1 ? `Claude ממתין ל-${asks} תשובות ממך` : 'Claude שאל אותך שאלה וממתין לתשובה')
    : (n > 1 ? `${n} בקשות אישור ממתינות` : 'Claude ממתין לאישור שלך');
}
async function jumpToPendingAsk() {
  const first = pendingPerms.values().next().value;
  if (!first || !first.ref) return;
  if (streamOwnerId && activeId !== streamOwnerId) await switchConv(streamOwnerId);
  const node = document.querySelector(`[data-ask-id="${CSS.escape(first.ref.id)}"]`);
  if (!node) { toast('הכרטיס אינו זמין — נסה לגלול לתחתית השיחה', true); return; }
  stick = false;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
  const btn = node.querySelector('.pbtn');
  if (btn) setTimeout(() => btn.focus(), 350);
}

/**
 * התראה כשהשאלה מגיעה והחלון לא בפוקוס — אחרת היא פשוט לא נראית.
 *
 * בקשת אישור רגילה מקבלת שני כפתורים בתוך ההתראה עצמה, כך שאפשר לענות עליה
 * מהטלפון בלי לפתוח את האפליקציה — וזה בדיוק הרגע שבו זה משנה, כי התור עומד
 * וממתין. הכפתורים עוברים דרך ה-Service Worker אל ‎/api/permission-answer‎.
 *
 * שתי בקשות שלא מקבלות כפתורים, במכוון:
 * · ‎AskUserQuestion‎ — התשובה שלה היא בחירה מתוך אפשרויות, ו"אשר/דחה"
 *   פשוט אינם התשובה.
 * · מצב שבו הכיתוב אינו אומר *מה* מאשרים. גוף ההתראה נושא את שם הכלי ואת
 *   הפקודה/הקובץ, כי כפתור אישור בלי זה הוא בקשה לאשר משהו לא ידוע.
 */
function notifyQuestion(ref) {
  const isQ = ref.tool === 'AskUserQuestion';
  const text = isQ ? 'Claude שאל אותך שאלה' : 'Claude ממתין לאישור שלך';
  // לפני היציאה על פוקוס: מי שכן מסתכל על המסך לא מקבל התראה בכלל, ורטט הוא
  // הדרך היחידה שנשארה לסמן לו שנפתח כרטיס שממתין לו.
  haptic(HAPTIC_ASK);
  if (document.hasFocus()) return;
  setTitleBadge(text);
  if (isQ) { desktopNotify(text, 'לחץ כדי לענות', { vibrate: HAPTIC_ASK }); return; }
  const what = clamp(toolPreview(ref.tool, ref.input) || ref.description || '', 120);
  desktopNotify(text, ref.tool + (what ? ' · ' + what : ''), {
    // חייב להישאר גלוי עד שעונים: בקשה שנעלמת מהמגירה משאירה את התור תקוע
    requireInteraction: true,
    vibrate: HAPTIC_ASK,
    // תג ייחודי לבקשה. עם ה-tag המשותף 'rtl-claude' בקשה שנייה הייתה דורסת
    // את הראשונה, ואיתה את הכפתורים שמצביעים על ה-requestId שלה.
    tag: 'ask-' + ref.id,
    actions: notifyActionsOn() ? [
      { action: 'allow', title: 'אשר' },
      { action: 'deny', title: 'דחה' },
    ] : [],
    data: { convId: streamOwnerId || subId, requestId: ref.id },
  });
}

/** כפתורי אישור בהתראה — ניתנים לכיבוי, כי במגירת ההתראות הם נגישים גם נעול. */
function notifyActionsOn() { return store.settings.notifyActions !== false; }
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---------- תפריט השלמה: פקודות סלאש (/) ואזכור קבצים (@) ----------
let ac = null;            // { mode, items, sel, token: {start,end,q} }
let cmdCache = null;
const acMenu = () => $('acMenu');

/* פקודות שרצות כאן ולא נשלחות ל-CLI. ב-CLI הן פותחות מסך משלהן ואין להן שום
   משמעות בזרם stream-json — אם היו נשלחות, המודל היה מקבל אותן כטקסט רגיל.
   הארגומנט הוא כל מה שנכתב אחרי שם הפקודה. */
const CLIENT_CMDS = {
  '/clear': () => $('newChat').click(),
  '/anon': () => startAnonChat(),
  '/rc': (arg) => openRc(arg),
};

// המטמון מפתוח לפי סוכן *ולפי תיקייה*: שני התפריטים שונים לגמרי, והחלפה
// ביניהם בלי מפתח הייתה מגישה את הפקודות של הסוכן הקודם.
let cmdCacheKey = '';
async function getCommands() {
  const key = activeAgent() + '|' + ($('cwd').value || '');
  if (cmdCache && cmdCacheKey === key) return cmdCache;
  cmdCacheKey = key;
  try {
    const r = await fetch('/api/commands?cwd=' + encodeURIComponent($('cwd').value || '') + '&agent=' + activeAgent());
    cmdCache = (await r.json()).commands || [];
  }
  catch { cmdCache = []; }
  return cmdCache;
}
const fileFetch = debounce(async (q) => {
  try {
    const r = await fetch('/api/files?cwd=' + encodeURIComponent($('cwd').value || '') + '&q=' + encodeURIComponent(q));
    const files = (await r.json()).files || [];
    if (ac && ac.mode === 'file') { ac.items = files.map(f => ({ name: f })); ac.sel = 0; renderAc(); }
  } catch {}
}, 160);

function tokenAtCaret() {
  const i = $('input'); const val = i.value; const pos = i.selectionStart;
  const before = val.slice(0, pos);
  // פקודת סלאש — רק בתחילת ההודעה
  const sl = before.match(/^\/([\w-]*)$/);
  if (sl) return { mode: 'slash', start: 0, end: pos, q: sl[1] };
  // אזכור קובץ — @ עם רווח/תחילה לפניו
  const fm = before.match(/(^|\s)@([^\s]*)$/);
  if (fm) return { mode: 'file', start: pos - fm[2].length - 1, end: pos, q: fm[2] };
  return null;
}

async function updateAc() {
  const tk = tokenAtCaret();
  if (!tk) return closeAc();
  if (tk.mode === 'slash') {
    const cmds = await getCommands();
    const q = tk.q.toLowerCase();
    ac = { mode: 'slash', token: tk, items: cmds.filter(c => c.name.slice(1).toLowerCase().includes(q)), sel: 0 };
    renderAc();
  } else {
    ac = { mode: 'file', token: tk, items: [], sel: 0 };
    renderAc();
    fileFetch(tk.q);
  }
}

function renderAc() {
  const m = acMenu();
  if (!ac || !ac.items.length) { m.classList.add('hidden'); m.innerHTML = ''; return; }
  m.innerHTML = '';
  const head = el('div', 'ac-head', ac.mode === 'slash' ? 'פקודות' : 'קבצים בתיקיית העבודה');
  m.appendChild(head);
  ac.items.slice(0, 40).forEach((it, idx) => {
    const row = el('div', 'ac-item' + (idx === ac.sel ? ' sel' : ''));
    if (ac.mode === 'slash') {
      row.innerHTML = `<span class="ac-name">${escHtml(it.name)}</span><span class="ac-desc">${escHtml(it.desc || '')}</span>` +
        (it.scope ? `<span class="ac-badge">${escHtml(it.scope)}</span>` : it.custom ? '' : `<span class="ac-badge">מובנה</span>`);
    } else {
      row.innerHTML = `<span class="ac-name mono">@${escHtml(it.name)}</span>`;
    }
    row.onmousedown = (e) => { e.preventDefault(); acceptAc(idx); };
    m.appendChild(row);
  });
  m.classList.remove('hidden');
}

function acceptAc(idx) {
  if (!ac) return;
  const it = ac.items[idx != null ? idx : ac.sel];
  if (!it) return;
  const i = $('input'); const val = i.value; const tk = ac.token;
  if (ac.mode === 'slash') {
    const cmd = cmdCache.find(c => c.name === it.name) || it;
    if (cmd.client && CLIENT_CMDS[cmd.name]) { closeAc(); i.value = ''; autoGrow(); CLIENT_CMDS[cmd.name](''); return; }
    const rest = val.slice(tk.end);
    i.value = it.name + ' ' + rest.replace(/^\s+/, '');
    const caret = it.name.length + 1;
    i.setSelectionRange(caret, caret);
  } else {
    const insert = '@' + it.name + ' ';
    i.value = val.slice(0, tk.start) + insert + val.slice(tk.end);
    const caret = tk.start + insert.length;
    i.setSelectionRange(caret, caret);
  }
  closeAc(); autoGrow(); i.focus();
}
function closeAc() { ac = null; const m = acMenu(); m.classList.add('hidden'); m.innerHTML = ''; }

// אינטגרציה עם הקלט: מאזין input לעדכון, ומאזין keydown בשלב הלכידה כדי לתפוס ניווט לפני שליחה
$('input').addEventListener('input', updateAc);
$('input').addEventListener('keydown', (e) => {
  if (!ac || !ac.items.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); ac.sel = (ac.sel + 1) % Math.min(ac.items.length, 40); renderAc(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); const n = Math.min(ac.items.length, 40); ac.sel = (ac.sel - 1 + n) % n; renderAc(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); acceptAc(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeAc(); }
}, true);
$('input').addEventListener('blur', () => setTimeout(closeAc, 120));

// ---------- מודאל כללי ----------
function openModal(title, node) {
  $('modalTitle').textContent = title;
  const b = $('modalBody'); b.innerHTML = ''; b.appendChild(node);
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }
$('modalClose').onclick = closeModal;
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal(); });

function fmtAgo(ms) {
  const d = Date.now() - ms;
  if (d < 0) return 'עכשיו';
  const min = Math.floor(d / 60000), h = Math.floor(min / 60), day = Math.floor(h / 24);
  if (day >= 1) return `לפני ${day} ימים`;
  if (h >= 1) return `לפני ${h} שע׳`;
  if (min >= 1) return `לפני ${min} דק׳`;
  return 'עכשיו';
}

/* ==========================================================================
   יומן הריצה — מסך
   --------------------------------------------------------------------------
   היומן קיים על הדיסק מזמן (~/.claude/rtl-claude/rtl-claude.log) ונקרא דרך
   /api/logs, אבל הדרך היחידה להגיע אליו הייתה SSH — כלומר בדיוק לא מהמכשיר
   שבו התקלה קורית. כאן הוא מקבל מסך: מסנני נושא מוכנים לעצירות, חיפוש חופשי,
   רענון אוטומטי בזמן שהתקלה עוד באוויר, והעתקה/הורדה כדי לצרף לדיווח.
   ========================================================================== */
const LOG_FILTERS = [
  { key: '', name: 'הכול' },
  { key: 'turn\\.halt|cli\\.(api_error|api_error_message|stderr|exit|raw|rate_limit|stdout\\.overflow|spawn_error)|fatal', name: 'עצירות ושגיאות' },
  { key: 'cli\\.result|turn\\.(start|end|halt)', name: 'תורות' },
  { key: 'ws\\.|check\\.|subscribe|abandon|turn-state', name: 'חיבור וסנכרון' },
];
let logPollTimer = null;

function openLogs(preset) {
  const wrap = el('div', 'logs');
  const bar = el('div', 'logs-bar');
  const tabs = el('div', 'logs-tabs');
  const search = el('input', 'logs-search');
  search.type = 'search';
  search.placeholder = 'סינון חופשי (ביטוי רגולרי)…';
  search.dir = 'ltr';
  search.value = preset || '';

  const pre = el('pre', 'logs-out');
  pre.dir = 'ltr';
  pre.textContent = 'טוען…';

  let active = preset ? -1 : 0;
  const load = async () => {
    const grep = search.value.trim() || (active >= 0 ? LOG_FILTERS[active].key : '');
    try {
      const r = await fetch('/api/logs?n=1200' + (grep ? '&grep=' + encodeURIComponent(grep) : ''), { cache: 'no-store' });
      const text = (await r.text()).trim();
      const stick = pre.scrollTop >= pre.scrollHeight - pre.clientHeight - 40;
      pre.textContent = text || 'אין שורות שתואמות לסינון.';
      // תחתית היומן היא השורה האחרונה שנרשמה — שם מסתכלים אחרי תקלה
      if (stick) pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      pre.textContent = 'קריאת היומן נכשלה: ' + (e.message || e);
    }
  };

  LOG_FILTERS.forEach((f, i) => {
    const b = el('button', 'logs-tab' + (i === active ? ' on' : ''), f.name);
    b.type = 'button';
    b.onclick = () => {
      active = i;
      search.value = '';
      [...tabs.children].forEach((c, j) => c.classList.toggle('on', j === i));
      load();
    };
    tabs.appendChild(b);
  });
  // סינון חופשי גובר על הלשוניות; הקלדה בו משחררת את הבחירה שלהן
  search.addEventListener('input', () => {
    if (search.value.trim()) { active = -1; [...tabs.children].forEach((c) => c.classList.remove('on')); }
    else { active = 0; tabs.children[0].classList.add('on'); }
    clearTimeout(search._t);
    search._t = setTimeout(load, 250);
  });

  const acts = el('div', 'logs-acts');
  const auto = el('label', 'logs-auto');
  const chk = el('input');
  chk.type = 'checkbox';
  chk.checked = true;
  auto.appendChild(chk);
  auto.appendChild(document.createTextNode(' רענון אוטומטי'));
  const copy = el('button', 'logs-btn', '⧉ העתק');
  copy.type = 'button';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(pre.textContent); toast('היומן הועתק'); }
    catch { toast('ההעתקה נכשלה', true); }
  };
  const dl = el('button', 'logs-btn', '⇩ הורד');
  dl.type = 'button';
  dl.onclick = () => {
    const blob = new Blob([pre.textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rtl-claude-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.log';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  const now = el('button', 'logs-btn', '⟳ רענן');
  now.type = 'button';
  now.onclick = () => load();
  acts.append(auto, now, copy, dl);

  bar.append(tabs, search);
  wrap.append(bar, acts, pre);
  wrap.appendChild(el('div', 'modal-note', 'היומן נכתב ל-~/.claude/rtl-claude/rtl-claude.log ומאחד את מה שהשרת רואה עם מה שהדפדפן מדווח. הוא שורד אתחול ומסתובב ב-4MB.'));
  openModal('יומן ריצה', wrap);
  load();

  // הרענון נעצר עם סגירת המודאל — גם בלחיצה על ✕, גם ב-Escape וגם ברקע
  clearInterval(logPollTimer);
  logPollTimer = setInterval(() => {
    if ($('modal').classList.contains('hidden')) { clearInterval(logPollTimer); logPollTimer = null; return; }
    if (chk.checked && !document.hidden) load();
  }, 4000);
}

// ---------- סשנים על הדיסק ----------
async function openSessions() {
  const wrap = el('div', 'sess-list');
  const agent = activeAgent();
  // הרשימה היא של הסוכן שנבחר בבורר, כי מזהה סשן אינו קביל אצל האחר. אומרים
  // את זה במפורש: אחרת "לא נמצאו סשנים" נראה כמו תקלה ולא כמו בחירה.
  wrap.appendChild(el('div', 'modal-note',
    `סשנים קודמים של ${agent === 'cursor' ? 'cursor-agent' : 'Claude Code'} בתיקיית העבודה הנוכחית. "המשך" ממשיך את ההקשר מהמקום שבו הופסק. להחלפה — בחר מודל של הסוכן השני.`));
  openModal('סשנים על הדיסק', wrap);
  try {
    const r = await fetch('/api/sessions?cwd=' + encodeURIComponent($('cwd').value || '') + '&agent=' + agent);
    const sessions = (await r.json()).sessions || [];
    if (!sessions.length) { wrap.appendChild(el('div', 'modal-empty', 'לא נמצאו סשנים לתיקייה זו.')); return; }
    for (const s of sessions) {
      const row = el('div', 'sess-row');
      const info = el('div', 'sess-info');
      info.appendChild(el('div', 'sess-title', s.title));
      // ל-Cursor אין מניין תורות זמין בלי לפתוח את בסיס הנתונים שלו; שדה
      // שתמיד יראה "0 תורות" גרוע משדה שאינו שם.
      info.appendChild(el('div', 'sess-meta',
        `${fmtAgo(s.mtime)}${s.turns ? ` · ${s.turns} תורות` : ''} · ${s.id.slice(0, 8)}`));
      const btn = el('button', 'sess-resume', 'המשך');
      btn.onclick = () => resumeSession(s);
      row.appendChild(info); row.appendChild(btn);
      wrap.appendChild(row);
    }
  } catch { wrap.appendChild(el('div', 'modal-empty', 'שגיאה בטעינת הסשנים.')); }
}
function resumeSession(s) {
  const existing = store.convs.find(c => c.sessionId === s.id);
  if (!leaveAnon(existing ? existing.id : null)) return;
  if (existing) { switchConv(existing.id); closeModal(); return; }
  const c = {
    id: uid(), title: clamp(s.title, 42), sessionId: s.id, sessionAgent: s.agent || 'claude',
    messages: [], cost: 0, ctx: null,
    cwd: $('cwd').value, draft: '', createdAt: Date.now(), updatedAt: Date.now(), loaded: true,
  };
  store.convs.unshift(c); activeId = c.id; save();
  restoreDraft();
  renderConversation(); renderConvList(); closeModal();
  addNote('ממשיך סשן קיים מהדיסק — ההקשר ייטען אוטומטית בהודעה הבאה.');
  $('input').focus();
}
$('openSessions').onclick = openSessions;

// ---------- שרתי MCP ----------
async function openMcp() {
  const wrap = el('div', 'mcp-list');
  wrap.appendChild(el('div', 'modal-note', 'שרתי MCP המחוברים ל-Claude Code. הכלים שלהם זמינים אוטומטית בשיחות.'));
  openModal('שרתי MCP', wrap);
  try {
    const r = await fetch('/api/mcp');
    const data = await r.json();
    if (!data.servers || !data.servers.length) { wrap.appendChild(el('div', 'modal-empty', data.raw || 'לא הוגדרו שרתי MCP.')); return; }
    for (const s of data.servers) {
      const row = el('div', 'mcp-row');
      row.innerHTML = `<span class="mcp-dot ${s.connected ? 'on' : 'off'}"></span>` +
        `<div class="mcp-info"><div class="mcp-name">${escHtml(s.name)}</div><div class="mcp-url mono">${escHtml(s.url)}</div></div>` +
        `<span class="mcp-status ${s.connected ? 'on' : 'off'}">${s.connected ? 'מחובר' : 'מנותק'}</span>`;
      wrap.appendChild(row);
    }
  } catch { wrap.appendChild(el('div', 'modal-empty', 'שגיאה בטעינת שרתי MCP.')); }
}
$('openMcp').onclick = openMcp;
$('openLogs').onclick = () => { closeDrawer(); openLogs(); };

// ---------- מכשירים מקושרים ----------
// מכשיר מקושר פעם אחת ונשאר מקושר: הוא מגיע לכתובת ה-LAN של המחשב — ישירות
// או דרך VPN שמנתב לרשת — בלי פורט פתוח לאינטרנט ובלי טוקן שפג בכל סשן.
let remoteState = { listening: false, devices: [] };

function paintRemote() {
  const b = $('remoteBtn'); if (!b) return;
  const n = (remoteState.devices || []).length;
  b.classList.toggle('on', !!remoteState.listening && n > 0);
  b.title = !remoteState.listening ? 'חיבור מכשירים (המאזין לא פעיל)'
    : n ? `${n} מכשירים מקושרים` : 'קשר מכשיר';
}

async function fetchRemote() {
  try { remoteState = await (await fetch('/api/remote/status')).json(); }
  catch { remoteState = { listening: false, devices: [] }; }
  paintRemote();
  return remoteState;
}

function fmtLeft(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  return min >= 60 ? `${Math.floor(min / 60)} שע׳ ${min % 60} דק׳` : `${min} דק׳`;
}
function fmtSeen(ts) {
  if (!ts) return 'לא נראה עדיין';
  const d = Date.now() - ts;
  if (d < 120000) return 'מחובר עכשיו';
  if (d < 3600000) return `לפני ${Math.round(d / 60000)} דק׳`;
  if (d < 86400000) return `לפני ${Math.round(d / 3600000)} שע׳`;
  return new Date(ts).toLocaleDateString('he-IL');
}

async function remoteCall(path, body) {
  const r = await fetch('/api/remote/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'שגיאה');
  remoteState = data; paintRemote();
  return data;
}

function renderRemote(wrap) {
  wrap.innerHTML = '';
  const s = remoteState;

  if (!s.listening) {
    wrap.appendChild(el('div', 'modal-note',
      'לא נמצאה כתובת LAN שאפשר להאזין עליה במחשב הזה, ולכן אי אפשר לקשר מכשיר כרגע.'));
    const box = el('div', 'remote-box');
    box.appendChild(el('div', 'remote-meta', 'ודא שהמחשב מחובר לרשת המקומית, ואז פתח את החלון הזה שוב.'));
    wrap.appendChild(box);
    return;
  }

  wrap.appendChild(el('div', 'modal-note',
    'מכשיר מקושר מגיע לממשק הזה מכל מקום ברשת המקומית — ישירות או דרך VPN ' +
    'שמנתב אליה — כל עוד המחשב דלוק. הכול נשאר על המחשב.'));

  const box = el('div', 'remote-box');
  box.appendChild(el('div', 'remote-url', s.url || '—'));

  if (s.pairUrl) {
    const qr = el('div', 'pair-qr');
    const img = document.createElement('img');
    img.src = '/api/remote/qr?t=' + Date.now();
    img.alt = 'קוד קישור';
    qr.appendChild(img);
    qr.appendChild(el('div', 'remote-meta', `סרוק מהטלפון · תקף עוד ${fmtLeft((s.pairExpiresAt || 0) - Date.now())}`));
    box.appendChild(qr);

    // מי שלא יכול לסרוק — מחשב מול מחשב, או קוד שנשלח בהודעה — מקליד את הקוד
    // הקצר בכתובת ה-LAN. לכן הוא מוצג כאן באותה בולטות כמו ה-QR.
    if (s.pairCode) {
      const man = el('div', 'pair-code-box');
      man.appendChild(el('div', 'remote-meta', 'או פתחו במכשיר החדש את הכתובת שלמעלה והקלידו:'));
      const code = el('div', 'pair-code', s.pairCode);
      code.title = 'לחיצה מעתיקה';
      code.onclick = async () => { (await copyText(s.pairCode)) ? toast('הקוד הועתק') : toast('ההעתקה נכשלה', true); };
      man.appendChild(code);
      box.appendChild(man);
    }

    const row = el('div', 'remote-actions');
    const copy = el('button', 'rm-btn', 'העתק קישור');
    copy.onclick = async () => { (await copyText(s.pairUrl)) ? toast('הקישור הועתק') : toast('ההעתקה נכשלה', true); };
    const cancel = el('button', 'rm-btn', 'בטל');
    cancel.onclick = async () => { try { await remoteCall('cancel-pair'); renderRemote(wrap); } catch (e) { toast(e.message, true); } };
    row.appendChild(copy); row.appendChild(cancel);
    box.appendChild(row);
  } else {
    const row = el('div', 'remote-actions');
    const on = el('button', 'rm-btn primary', 'קשר מכשיר חדש');
    on.onclick = async () => {
      on.disabled = true;
      try { await remoteCall('pair'); renderRemote(wrap); }
      catch (e) { on.disabled = false; toast(e.message, true); }
    };
    row.appendChild(on);
    box.appendChild(row);
    box.appendChild(el('div', 'remote-meta',
      'קוד קצר שתקף לעשר דקות, לשימוש חד-פעמי. אפשר לקשר גם מכאן וגם מכל מכשיר שכבר מקושר.'));
  }
  wrap.appendChild(box);

  const devs = s.devices || [];
  wrap.appendChild(el('div', 'modal-sub', devs.length ? 'מכשירים מקושרים' : 'עדיין אין מכשירים מקושרים'));
  for (const d of devs) {
    const row = el('div', 'dev-row');
    const info = el('div', 'dev-info');
    info.appendChild(el('div', 'dev-name', d.name || 'מכשיר'));
    const by = d.pairedBy ? ` · קושר על ידי ${d.pairedBy}` : '';
    info.appendChild(el('div', 'dev-meta', `${fmtSeen(d.lastSeen)} · קושר ב-${new Date(d.createdAt).toLocaleDateString('he-IL')}${by}`));
    row.appendChild(info);
    const off = el('button', 'rm-btn danger', 'נתק');
    off.onclick = async () => {
      if (!confirm(`לנתק את ${d.name || 'המכשיר'}? הוא יצטרך קישור מחדש.`)) return;
      try { await remoteCall('unpair', { id: d.id }); renderRemote(wrap); toast('המכשיר נותק'); }
      catch (e) { toast(e.message, true); }
    };
    row.appendChild(off);
    wrap.appendChild(row);
  }
}

async function openRemote() {
  const wrap = el('div', 'remote-wrap');
  openModal('מכשירים מקושרים', wrap);
  wrap.appendChild(el('div', 'modal-empty', 'טוען…'));
  await fetchRemote();
  renderRemote(wrap);
}
$('remoteBtn').onclick = openRemote;
$('remoteBtn').title = 'מכשירים מקושרים';
fetchRemote();
setInterval(fetchRemote, 120000);

/* ==========================================================================
   Remote Control של Claude Code — הפקודה /rc
   --------------------------------------------------------------------------
   שני דברים שונים נקראים כאן "מרחוק", וכדאי לא לבלבל ביניהם:
   • "מכשירים מקושרים" שלמעלה — הממשק הזה, מכל מכשיר ברשת המקומית.
   • Remote Control — פיצ'ר של Claude Code עצמו: סשנים שנפתחים מ-claude.ai/code
     או מאפליקציית Claude בנייד ורצים על המחשב הזה, מכל מקום בעולם.
   ב-CLI זו /rc, אבל שם היא פקודה שמציירת מסך משלה ולא משהו שאפשר לשלוח לתוך
   השיחה — ולכן כאן היא פקודת-לקוח שפותחת את הפאנל הזה, והשרת מריץ בשבילה את
   `claude remote-control`.
   הפאנל הוא לוח ניהול: כל המופעים שרצים (תיקייה, מצב, קיבולת, קישור ו-QR),
   הסשנים שנפתחו בכל אחד מהם, וכל סשן claude חי על המחשב — עם התיקייה שבה הוא
   יושב ומאיפה הוא נפתח.
   ========================================================================== */
let rcData = { instances: [], sessions: [], max: 6, spawnModes: [], permissionModes: [] };
let rcTrust = { cwd: '', trusted: true };
let rcPollTimer = null;
// טופס ההפעלה חי מחוץ לציור: הפאנל מצייר את עצמו מחדש כל שתי שניות
let rcForm = { cwd: '', name: '', spawn: 'same-dir', capacity: '', perm: '', cont: false, inDir: true, adv: false, browse: false };
let rcQrFor = '';      // איזה מופע מציג QR
let rcLogFor = '';     // איזה מופע מציג את היומן שלו
let rcOnlyRc = false;  // סינון רשימת הסשנים לסשנים של Remote Control בלבד

const RC_LABEL = { off: 'כבוי', starting: 'מתחבר…', on: 'מחובר', reconnecting: 'מתחבר מחדש…', error: 'נכשל' };
const RC_SPAWN_LABEL = {
  'same-dir': 'סשן חדש נפתח באותה תיקייה',
  worktree: 'סשן חדש מקבל worktree משלו',
  session: 'סשן יחיד — נסגר בסיומו',
};
const RC_SOURCE = { rc: 'Remote Control', ui: 'הממשק הזה', terminal: 'טרמינל' };

async function rcFetch() {
  try {
    const d = await (await fetch('/api/rc/status', { cache: 'no-store' })).json();
    rcData = { instances: [], sessions: [], max: 6, spawnModes: [], permissionModes: [], ...d };
  } catch { rcData = { ...rcData, instances: [], sessions: [] }; }
  return rcData;
}
/** תיקייה שלא אושרה בדיאלוג האמון של ה-CLI תפיל את remote-control מיד. כשל
 *  ברשת לא יחסום כאן — השרת בודק שוב בהפעלה ומחזיר 409 עם needsTrust. */
async function rcTrustFetch(cwd) {
  try { rcTrust = await (await fetch('/api/rc/trust?cwd=' + encodeURIComponent(cwd || ''), { cache: 'no-store' })).json(); }
  catch { rcTrust = { cwd: cwd || '', trusted: true }; }
  return rcTrust;
}
async function rcCall(path, body) {
  const r = await fetch('/api/rc/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  if (!r.ok) { const err = new Error(data.error || 'שגיאה'); err.data = data; throw err; }
  return data;
}
/** מסמן את התיקייה כמהימנה — מה שבטרמינל היה דיאלוג האמון בהרצה הראשונה */
async function rcTrustApprove(cwd) {
  const r = await fetch('/api/rc/trust', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'שגיאה');
  rcTrust = data;
  return data;
}

/* -- מופע אחד: מצב, קישור, ומה רץ בתוכו ---------------------------------- */
function rcInstanceBox(inst, wrap) {
  const box = el('div', 'remote-box rc-inst');
  const head = el('div', 'remote-actions');
  head.appendChild(el('div', 'rc-state ' + inst.state, RC_LABEL[inst.state] || inst.state));
  if (inst.name) head.appendChild(el('div', 'rc-name', inst.name));
  head.appendChild(el('div', 'remote-meta', 'תיקייה: ' + inst.cwd));
  if (inst.capacity) head.appendChild(el('div', 'remote-meta', `סשנים: ${inst.capacity.used}/${inst.capacity.max}`));
  if (RC_SPAWN_LABEL[inst.spawn]) head.appendChild(el('div', 'remote-meta', RC_SPAWN_LABEL[inst.spawn]));
  if (inst.permissionMode) head.appendChild(el('div', 'remote-meta', 'הרשאות: ' + inst.permissionMode));
  if (inst.startedAt) head.appendChild(el('div', 'remote-meta', 'עלה ' + fmtAgo(inst.startedAt)));
  box.appendChild(head);

  if (inst.error) box.appendChild(el('div', 'remote-meta rc-err', inst.error));
  if (inst.url) box.appendChild(el('div', 'remote-url', inst.url));

  // הסשנים שנפתחו במופע הזה, כפי שהם מופיעים על המסך של ה-CLI
  if (inst.sessions && inst.sessions.length) {
    const list = el('div', 'rc-sessions');
    for (const s of inst.sessions) {
      const row = el('div', 'rc-sess');
      // "Attached" הוא מה שה-CLI כותב לסשן שעוד לא קיבל כותרת
      const t = el('div', 'rc-sess-title', s.title === 'Attached' ? 'סשן מחובר' : s.title);
      t.dir = 'auto';
      row.appendChild(t);
      if (s.activity) { const a = el('div', 'rc-sess-act', s.activity); a.dir = 'auto'; row.appendChild(a); }
      if (s.url) {
        const open = el('button', 'rm-btn', 'פתח');
        open.onclick = () => window.open(s.url, '_blank', 'noopener');
        row.appendChild(open);
      }
      list.appendChild(row);
    }
    box.appendChild(list);
  } else if (inst.state === 'on') {
    box.appendChild(el('div', 'remote-meta', 'אין סשנים פתוחים כרגע במופע הזה.'));
  }

  if (rcQrFor === inst.cwd && inst.url) {
    const qr = el('div', 'pair-qr');
    const img = document.createElement('img');
    img.src = '/api/rc/qr?t=' + inst.startedAt + '&cwd=' + encodeURIComponent(inst.cwd);
    img.alt = 'קוד לפתיחה בנייד';
    qr.appendChild(img);
    qr.appendChild(el('div', 'remote-meta', 'סרוק מהטלפון כדי לפתוח את הסביבה'));
    box.appendChild(qr);
  }
  if (rcLogFor === inst.cwd && inst.log && inst.log.length) {
    const log = el('div', 'rc-log');
    for (const line of inst.log) { const r = el('div', 'rc-log-line', line); r.dir = 'ltr'; log.appendChild(r); }
    box.appendChild(log);
  }

  const row = el('div', 'remote-actions');
  if (inst.url) {
    const open = el('button', 'rm-btn primary', 'פתח ב-claude.ai');
    open.onclick = () => window.open(inst.url, '_blank', 'noopener');
    const copy = el('button', 'rm-btn', 'העתק קישור');
    copy.onclick = async () => { (await copyText(inst.url)) ? toast('הקישור הועתק') : toast('ההעתקה נכשלה', true); };
    const qrBtn = el('button', 'rm-btn', rcQrFor === inst.cwd ? 'הסתר QR' : 'QR');
    qrBtn.onclick = () => { rcQrFor = rcQrFor === inst.cwd ? '' : inst.cwd; renderRc(wrap); };
    row.appendChild(open); row.appendChild(copy); row.appendChild(qrBtn);
  } else if (inst.state === 'starting') {
    row.appendChild(el('div', 'remote-meta', 'מתחבר ל-claude.ai…'));
  }
  if (inst.log && inst.log.length) {
    const logBtn = el('button', 'rm-btn', rcLogFor === inst.cwd ? 'הסתר יומן' : 'יומן');
    logBtn.onclick = () => { rcLogFor = rcLogFor === inst.cwd ? '' : inst.cwd; renderRc(wrap); };
    row.appendChild(logBtn);
  }
  // מופע שנפל נשאר ברשימה עם הסיבה, ולכן הכפתור שם הוא ניקוי ולא ניתוק
  const dead = !inst.pid;
  const off = el('button', 'rm-btn danger', dead ? 'הסר' : 'נתק');
  off.onclick = async () => {
    off.disabled = true;
    try { await rcCall('stop', { cwd: inst.cwd }); await rcFetch(); toast(dead ? 'הוסר' : 'המופע נותק'); renderRc(wrap); }
    catch (e) { off.disabled = false; toast(e.message, true); }
  };
  row.appendChild(off);
  box.appendChild(row);
  return box;
}

/* -- טופס ההפעלה: תיקייה, שם, ואיך ייפתחו סשנים חדשים -------------------- */
function rcStartForm(wrap) {
  const box = el('div', 'remote-box');
  box.appendChild(el('div', 'rc-h', 'הפעלה בתיקייה'));

  const dirRow = el('div', 'remote-actions');
  const cwd = el('input', 'rm-sel rc-cwd');
  cwd.type = 'text'; cwd.dir = 'ltr'; cwd.placeholder = 'נתיב התיקייה';
  cwd.value = rcForm.cwd;
  cwd.oninput = () => { rcForm.cwd = cwd.value; };
  // בדיקת האמון היא לתיקייה שהוקלדה, ולכן היא רצה כשעוזבים את השדה
  cwd.onchange = async () => { await rcTrustFetch(rcForm.cwd); renderRc(wrap); };
  const browse = el('button', 'rm-btn', rcForm.browse ? 'סגור בורר' : 'עיין…');
  // dirPickAt הוא מיקום הבורר, וגם מה ששומר אותו במקומו כשהפאנל מצייר את עצמו מחדש
  browse.onclick = () => { rcForm.browse = !rcForm.browse; if (rcForm.browse) dirPickAt = rcForm.cwd; renderRc(wrap); };
  dirRow.appendChild(el('label', 'rm-lbl', 'תיקייה:'));
  dirRow.appendChild(cwd);
  dirRow.appendChild(browse);
  box.appendChild(dirRow);

  if (rcForm.browse) {
    const cur = el('div', 'dp-cur');
    const list = el('div', 'dp-list');
    const pick = el('button', 'rm-btn', 'בחר את התיקייה הזו');
    pick.onclick = async () => {
      rcForm.cwd = dirPickAt; rcForm.browse = false;
      await rcTrustFetch(rcForm.cwd);
      renderRc(wrap);
    };
    const dp = el('div', 'dirpick');
    dp.appendChild(cur); dp.appendChild(list);
    const acts = el('div', 'dp-actions'); acts.appendChild(pick); dp.appendChild(acts);
    box.appendChild(dp);
    loadDirs(dirPickAt || rcForm.cwd || '', cur, list);
  }

  // או שהבדיקה המקדימה גילתה זאת, או שהתהליך כבר נפל על זה בפועל
  const untrusted = rcTrust.trusted === false;
  if (untrusted) {
    const note = el('div', 'rc-warn');
    note.appendChild(el('div', 'remote-meta',
      'התיקייה הזו עדיין לא אושרה כמהימנה ב-Claude Code, ולכן Remote Control נופל בה מיד. ' +
      'אישור פירושו שאתה סומך על הקוד שבתיקייה — סשנים שייפתחו מ-claude.ai ירוצו עליו כאן. ' +
      'זה בדיוק הדיאלוג שהיה עולה בהרצת claude בטרמינל בתיקייה הזו.'));
    note.appendChild(el('div', 'remote-url', rcTrust.cwd || rcForm.cwd || '—'));
    box.appendChild(note);
  }

  const row = el('div', 'remote-actions');
  row.appendChild(el('label', 'rm-lbl', 'שם:'));
  const nm = el('input', 'rm-sel');
  nm.type = 'text'; nm.dir = 'auto';
  nm.placeholder = 'שם הסביבה (לא חובה)';
  nm.value = rcForm.name;
  nm.oninput = () => { rcForm.name = nm.value; };
  row.appendChild(nm);
  const advBtn = el('button', 'rm-btn', rcForm.adv ? 'פחות אפשרויות' : 'אפשרויות…');
  advBtn.onclick = () => { rcForm.adv = !rcForm.adv; renderRc(wrap); };
  row.appendChild(advBtn);
  box.appendChild(row);

  if (rcForm.adv) {
    const opts = el('div', 'rc-opts');

    const sRow = el('div', 'remote-actions');
    sRow.appendChild(el('label', 'rm-lbl', 'סשן חדש:'));
    const sp = el('select', 'rm-sel');
    for (const m of (rcData.spawnModes.length ? rcData.spawnModes : ['same-dir', 'worktree', 'session'])) {
      const o = document.createElement('option');
      o.value = m; o.textContent = RC_SPAWN_LABEL[m] || m;
      sp.appendChild(o);
    }
    sp.value = rcForm.spawn;
    sp.onchange = () => { rcForm.spawn = sp.value; };
    sRow.appendChild(sp);
    opts.appendChild(sRow);

    const cRow = el('div', 'remote-actions');
    cRow.appendChild(el('label', 'rm-lbl', 'קיבולת:'));
    const capIn = el('input', 'rm-sel rc-num');
    capIn.type = 'number'; capIn.min = '1'; capIn.max = '32';
    capIn.placeholder = '32';
    capIn.value = rcForm.capacity;
    capIn.oninput = () => { rcForm.capacity = capIn.value; };
    cRow.appendChild(capIn);
    cRow.appendChild(el('div', 'remote-meta', 'כמה סשנים במקביל מותרים במופע'));
    opts.appendChild(cRow);

    const pRow = el('div', 'remote-actions');
    pRow.appendChild(el('label', 'rm-lbl', 'הרשאות:'));
    const pm = el('select', 'rm-sel');
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'ברירת המחדל של ה-CLI';
    pm.appendChild(none);
    for (const m of rcData.permissionModes) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      pm.appendChild(o);
    }
    pm.value = rcForm.perm;
    pm.onchange = () => { rcForm.perm = pm.value; };
    pRow.appendChild(pm);
    pRow.appendChild(el('div', 'remote-meta', 'המצב שבו ירוצו הסשנים שייפתחו מרחוק'));
    opts.appendChild(pRow);

    const kRow = el('div', 'remote-actions');
    const cont = el('input', 'rc-chk'); cont.type = 'checkbox'; cont.id = 'rcCont';
    cont.checked = rcForm.cont;
    cont.onchange = () => { rcForm.cont = cont.checked; };
    const contL = el('label', 'rm-lbl', 'המשך את הסשן האחרון שנרשם בתיקייה (-c)');
    contL.htmlFor = 'rcCont';
    kRow.appendChild(cont); kRow.appendChild(contL);
    opts.appendChild(kRow);

    const dRow = el('div', 'remote-actions');
    const inDir = el('input', 'rc-chk'); inDir.type = 'checkbox'; inDir.id = 'rcInDir';
    inDir.checked = rcForm.inDir;
    inDir.onchange = () => { rcForm.inDir = inDir.checked; };
    const inDirL = el('label', 'rm-lbl', 'פתח סשן אחד מראש בתיקייה');
    inDirL.htmlFor = 'rcInDir';
    dRow.appendChild(inDir); dRow.appendChild(inDirL);
    opts.appendChild(dRow);

    box.appendChild(opts);
  }

  const goRow = el('div', 'remote-actions');
  const running = rcData.instances.filter((i) => i.pid).length;
  const full = running >= (rcData.max || 6);
  const go = el('button', 'rm-btn primary', untrusted ? 'אשר את התיקייה והפעל' : 'הפעל');
  go.disabled = full;
  go.onclick = async () => {
    go.disabled = true;
    const target = rcForm.cwd;
    try {
      if (untrusted) await rcTrustApprove(target);
      await rcCall('start', {
        cwd: target, name: rcForm.name, spawn: rcForm.spawn,
        capacity: rcForm.capacity, permissionMode: rcForm.perm,
        continue: rcForm.cont, createSessionInDir: rcForm.inDir,
      });
      rcForm.name = '';
      await rcFetch();
      renderRc(wrap);
      rcPoll(wrap);
    } catch (e) {
      go.disabled = false;
      // 409 — התיקייה השתנתה מאז הבדיקה; מציירים מחדש עם בקשת האישור
      if (e.data && e.data.needsTrust) { rcTrust = { cwd: e.data.cwd, trusted: false }; renderRc(wrap); }
      else toast(e.message, true);
    }
  };
  goRow.appendChild(go);
  if (full) goRow.appendChild(el('div', 'remote-meta', `רצים כבר ${running} מופעים — זו התקרה`));
  box.appendChild(goRow);
  return box;
}

/* -- כל סשן claude חי על המחשב, ומאיפה הוא נפתח -------------------------- */
function rcSessionList(wrap) {
  const box = el('div', 'remote-box');
  const head = el('div', 'remote-actions');
  head.appendChild(el('div', 'rc-h', 'סשנים חיים על המחשב'));
  const only = el('input', 'rc-chk'); only.type = 'checkbox'; only.id = 'rcOnly';
  only.checked = rcOnlyRc;
  only.onchange = () => { rcOnlyRc = only.checked; renderRc(wrap); };
  const onlyL = el('label', 'rm-lbl', 'רק של Remote Control');
  onlyL.htmlFor = 'rcOnly';
  head.appendChild(only); head.appendChild(onlyL);
  box.appendChild(head);

  const rows = rcData.sessions.filter((s) => !rcOnlyRc || s.source === 'rc');
  if (!rows.length) {
    box.appendChild(el('div', 'remote-meta', rcOnlyRc ? 'אין סשנים פתוחים דרך Remote Control.' : 'אין סשני claude פתוחים.'));
    return box;
  }
  for (const s of rows) {
    const row = el('div', 'sess-row rc-live');
    const info = el('div', 'sess-info');
    const title = el('div', 'sess-title');
    title.appendChild(el('span', 'rc-badge ' + s.source, RC_SOURCE[s.source] || s.source));
    const nm = el('span', 'rc-live-name', s.name || (s.sessionId ? s.sessionId.slice(0, 8) : 'סשן'));
    nm.dir = 'auto';
    title.appendChild(nm);
    if (s.spare) title.appendChild(el('span', 'rc-badge idle', 'מוכן מראש'));
    if (s.agent) title.appendChild(el('span', 'rc-badge idle', 'סוכן: ' + s.agent));
    info.appendChild(title);
    const meta = [s.cwd || '—'];
    if (s.startedAt) meta.push(fmtAgo(s.startedAt));
    meta.push('pid ' + s.pid);
    if (s.kind && s.kind !== 'interactive') meta.push(s.kind);
    info.appendChild(el('div', 'sess-meta', meta.join('  ·  ')));
    row.appendChild(info);
    const kill = el('button', 'rm-btn danger', 'סגור');
    kill.onclick = async () => {
      const where = s.cwd || 'התיקייה הלא ידועה';
      if (!confirm(`לסגור את הסשן (${RC_SOURCE[s.source] || s.source}) שרץ ב-${where}?\nעבודה שלא נשמרה בו תאבד.`)) return;
      kill.disabled = true;
      try { await rcCall('session/stop', { pid: s.pid }); await rcFetch(); toast('הסשן נסגר'); renderRc(wrap); }
      catch (e) { kill.disabled = false; toast(e.message, true); }
    };
    row.appendChild(kill);
    box.appendChild(row);
  }
  return box;
}

function renderRc(wrap) {
  wrap.innerHTML = '';
  wrap.appendChild(el('div', 'modal-note',
    'Remote Control מחבר את המחשב הזה ל-claude.ai/code ולאפליקציה בנייד. משם אפשר ' +
    'לפתוח סשנים שרצים כאן, על הקבצים האמיתיים — גם מחוץ לרשת הבית. ' +
    'כל מופע הוא תיקייה אחת, והוא נשאר פעיל כל עוד הממשק רץ ונסגר איתו.'));

  const live = rcData.instances;
  if (live.length) {
    const head = el('div', 'remote-actions rc-head');
    head.appendChild(el('div', 'rc-h', `מופעים (${live.filter((i) => i.pid).length} רצים)`));
    if (live.filter((i) => i.pid).length > 1) {
      const all = el('button', 'rm-btn danger', 'נתק הכל');
      all.onclick = async () => {
        all.disabled = true;
        try { await rcCall('stop', {}); await rcFetch(); toast('כל המופעים נותקו'); renderRc(wrap); }
        catch (e) { all.disabled = false; toast(e.message, true); }
      };
      head.appendChild(all);
    }
    wrap.appendChild(head);
    for (const inst of live) wrap.appendChild(rcInstanceBox(inst, wrap));
  } else {
    wrap.appendChild(el('div', 'remote-meta', 'אין מופע פעיל. Remote Control לא עולה מעצמו — זו יציאה החוצה.'));
  }

  wrap.appendChild(rcStartForm(wrap));
  wrap.appendChild(rcSessionList(wrap));
}

/** מרענן כל עוד הפאנל פתוח — החיבור לוקח כמה שניות והמצב משתנה מעצמו.
 *  ציור מחדש בזמן הקלדה היה גונב את הפוקוס, ולכן הוא נדחה עד שעוזבים את השדה. */
function rcPoll(wrap) {
  clearInterval(rcPollTimer);
  rcPollTimer = setInterval(async () => {
    if ($('modal').classList.contains('hidden') || !wrap.isConnected) {
      clearInterval(rcPollTimer); rcPollTimer = null; return;
    }
    const before = JSON.stringify(rcData);
    await rcFetch();
    if (JSON.stringify(rcData) === before) return;
    const a = document.activeElement;
    if (a && wrap.contains(a) && /^(INPUT|SELECT)$/.test(a.tagName)) return;
    renderRc(wrap);
  }, 2000);
}

async function openRc(arg) {
  const wrap = el('div', 'remote-wrap');
  openModal('Remote Control', wrap);
  wrap.appendChild(el('div', 'modal-empty', 'טוען…'));
  // ברירת המחדל היא תיקיית השיחה הפתוחה, וממנה ממשיכים לכל תיקייה אחרת
  if (!rcForm.cwd) rcForm.cwd = (($('cwd') && $('cwd').value) || '').trim();
  if (arg && arg.trim()) rcForm.name = arg.trim();
  await Promise.all([rcFetch(), rcTrustFetch(rcForm.cwd)]);
  renderRc(wrap);
  rcPoll(wrap);
}
// אותו לוח בדיוק שנפתח מ-/rc ומלוח הפקודות, עכשיו גם ככפתור בסרגל. closeDrawer
// לפני הפתיחה, כמו ביומן הריצה: בטלפון המגירה פתוחה מעל המסך ברגע הלחיצה.
$('openRc').onclick = () => { closeDrawer(); openRc(); };

// ---------- מצב רחב: הגדלת שטח העבודה ----------
// ההגדרות נטענות מהשרת אחרי עליית הדף, לכן ההחלה עצמה קורית מתוך init().
function applyWide() {
  document.querySelector('.app').classList.toggle('wide', !!store.settings.wide);
}
(function wireWide() {
  const app = document.querySelector('.app');
  const btn = $('wideToggle');
  if (btn) btn.onclick = () => { const on = app.classList.toggle('wide'); store.settings.wide = on; btn.title = on ? 'צמצם את שטח העבודה' : 'הרחב את שטח העבודה'; save(); };
})();

// ---------- לוח פקודות (Ctrl/Cmd+K) — ניווט ופעולות מהירות ----------
const paletteActions = () => [
  { ic: '＋', name: 'שיחה חדשה', run: () => $('newChat').click() },
  { ic: '🕶', name: 'צ׳אט אנונימי · לא נשמר בשום מקום', run: () => startAnonChat() },
  { ic: '⚯', name: 'דואט — שני מודלים על תוצר אחד', run: () => $('newDuet').click() },
  { ic: '⟲', name: 'סשנים על הדיסק', run: () => openSessions() },
  { ic: '⧉', name: 'שרתי MCP', run: () => openMcp() },
  { ic: '⇋', name: 'מכשירים מקושרים', run: () => openRemote() },
  { ic: '⌁', name: 'Remote Control — שליטה מ-claude.ai ומהנייד (/rc)', run: () => openRc() },
  { ic: '◐', name: 'החלף מצב תצוגה (בהיר/כהה)', run: () => $('themeToggle').click() },
  { ic: '⤢', name: 'מצב רחב', run: () => $('wideToggle').click() },
  { ic: '▤', name: 'מכסה — Claude מול Cursor', run: () => setUsageModalOpen(true) },
  { ic: '⇄', name: `החלף את רצועת המכסה ל-${usageSourceName(usageSource() === 'claude' ? 'cursor' : 'claude')}`, run: () => $('usageSrcToggle').click() },
  { ic: '⟳', name: 'בדוק מול השרת וסנכרן את המסך', run: () => manualCheck() },
  { ic: '☰', name: 'יומן ריצה — למה התור נעצר', run: () => openLogs() },
  { ic: '⌂', name: 'תיקיית העבודה של השיחה', run: () => openDirPicker($('cwd').value.trim()) },
  { ic: '⚙', name: 'הגדרות', run: () => openSettings() },
  { ic: '⌕', name: 'חיפוש בתוך השיחה', run: () => openFind() },
  { ic: '⇩', name: 'ייצוא השיחה ל-Markdown', run: () => exportActiveConv() },
  ...(dictSupported() ? [
    { ic: '🎙', name: dictOn ? 'עצור את ההכתבה הקולית' : 'הכתבה קולית — הכתב את ההודעה', run: () => dictToggle() },
    { ic: '⇄', name: `החלף את שפת ההכתבה ל${dictNextLang().name}`, run: () => dictSetLang(dictNextLang().id) },
  ] : []),
  { ic: '⌨', name: 'מקשי קיצור', run: () => openShortcuts() },
];
let pal = null;
// focus=false כשהלוח נפתח ככפתור "עוד" בטלפון: שם הוא תפריט פעולות, ומקלדת
// שקופצת ובולעת חצי מסך על תפריט של עשר שורות היא בדיוק ההפך ממה שצריך.
function openPalette(focus = true) {
  $('palette').classList.remove('hidden');
  const inp = $('paletteInput');
  inp.value = ''; buildPalette('');
  if (focus) inp.focus();
}
function closePalette() { $('palette').classList.add('hidden'); pal = null; }
function buildPalette(q) {
  q = q.trim().toLowerCase();
  const actions = paletteActions().filter(a => !q || a.name.toLowerCase().includes(q));
  // msgCount מגיע מהאינדקס — שיחה שעדיין לא נטענה לזיכרון חייבת להופיע גם היא
  const convs = store.convs
    .filter(c => (c.msgCount || (c.messages || []).length || isDuet(c)) && (!q || (c.title || '').toLowerCase().includes(q)))
    .sort((a, b) => convTime(b) - convTime(a)).slice(0, 6);
  const items = [];
  actions.forEach((a, i) => items.push({ ...a, group: i === 0 ? 'פעולות' : null }));
  convs.forEach((c, i) => items.push({ ic: '✎', name: c.title || 'שיחה', sub: shortAgo(convTime(c)), run: () => switchConv(c.id), group: i === 0 ? 'שיחות' : null }));
  pal = { items, sel: 0 };
  renderPalette();
}
function renderPalette() {
  const list = $('paletteList'); list.innerHTML = '';
  if (!pal.items.length) { list.appendChild(el('div', 'pl-empty', 'אין תוצאות')); return; }
  pal.items.forEach((it, idx) => {
    if (it.group) list.appendChild(el('div', 'pl-group', it.group));
    const row = el('div', 'pl-item' + (idx === pal.sel ? ' sel' : ''));
    row.innerHTML = `<span class="pl-ic">${escHtml(it.ic || '›')}</span><span>${escHtml(it.name)}</span>` + (it.sub ? `<span class="pl-sub">${escHtml(it.sub)}</span>` : '');
    row.onmousedown = (e) => { e.preventDefault(); runPalette(idx); };
    list.appendChild(row);
  });
}
function runPalette(idx) { const it = pal && pal.items[idx != null ? idx : pal.sel]; closePalette(); if (it && it.run) it.run(); }
$('paletteInput').addEventListener('input', (e) => buildPalette(e.target.value));
$('paletteInput').addEventListener('keydown', (e) => {
  if (!pal || !pal.items.length) { if (e.key === 'Escape') closePalette(); return; }
  const n = pal.items.length;
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.sel = (pal.sel + 1) % n; renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.sel = (pal.sel - 1 + n) % n; renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('palette').addEventListener('click', (e) => { if (e.target === $('palette')) closePalette(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    $('palette').classList.contains('hidden') ? openPalette() : closePalette();
  }
});

/* ==========================================================================
   התראות · ייצוא · חיפוש בתוך שיחה · מקשי קיצור
   ========================================================================== */

// ---------- כותרת החלון + התראות שולחן עבודה ----------
function setTitleBadge(t) { document.title = t ? '● ' + t + ' · ממשק עברית' : BASE_TITLE; }
function clearTitleBadge() { setTitleBadge(''); }
addEventListener('focus', clearTitleBadge);
// אישור/חסימה מתוך הגדרות הדפדפן לא מייצרים אירוע — בחזרה לטאב בודקים מחדש
addEventListener('focus', renderNotifyChip);
// ב-PWA מותקן לחיצה על התרעה לא תמיד מייצרת focus — ה-SW מודיע לנו ישירות
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'notification-click') clearTitleBadge();
});

/**
 * רטט קצר על אירוע שדורש תשומת לב.
 *
 * שני מסלולים נפרדים לשני מצבים, ולא בכפילות: ‎navigator.vibrate‎ מתעלם
 * בשקט כשהלשונית מוסתרת (זה בכוונה, בכל הדפדפנים), ולכן הוא משרת רק את הרגע
 * שבו *מסתכלים* על המסך — כרטיס אישור שנפתח מול העיניים. כשהאפליקציה ברקע
 * או סגורה, הרטט נוסע כשדה ‎vibrate‎ *בתוך* ההתראה עצמה, וה-Service Worker
 * מוציא אותו יחד איתה.
 * רק במגע: במחשב אין מנוע רטט, והקריאה שם היא רעש לשווא.
 */
function haptic(pattern) {
  if (!notifyOn()) return;   // אותו מתג — הרטט הוא חלק מאותה התראה
  if (!navigator.vibrate || document.hidden) return;
  if (!matchMedia('(pointer: coarse)').matches) return;
  try { navigator.vibrate(pattern); } catch {}
}
const HAPTIC_ASK = [55, 45, 55];   // "משהו ממתין לך" — שתי נקישות
const HAPTIC_DONE = [22];          // "נגמר" — נקישה אחת קצרה

/* ==========================================================================
   התקנה על מסך הבית
   --------------------------------------------------------------------------
   באנדרואיד הדפדפן יורה ‎beforeinstallprompt‎ כשהאפליקציה עומדת בתנאי
   ההתקנה, ומציג באנר משלו — בתחתית המסך, בתזמון שלו, ובדרך כלל בדיוק כשלא
   מתאים. ‎preventDefault‎ לוקח ממנו את זה ומעביר את ההזמנה לכפתור בהגדרות,
   שם היא נמצאת כשמחפשים אותה.
   באייפון אין אירוע כזה בכלל וגם אין API להתקנה — שם נשארות ההוראות, כי
   בלעדיהן המסך פשוט שותק על שאלה שנשאלת הרבה.
   ========================================================================== */
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);

addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; renderInstallRow(); });
addEventListener('appinstalled', () => { installPrompt = null; renderInstallRow(); toast('הותקנה על מסך הבית'); });

function renderInstallRow() {
  const row = $('installRow'); if (!row) return;
  const btn = $('installBtn'), hint = $('installHint');
  const standalone = isStandalone();
  // שורה שאין לה מה לומר לא מוצגת: בדפדפן שכבר התקין, או כזה שאינו תומך
  row.classList.toggle('hidden', !installPrompt && !standalone && !isIOS());
  btn.classList.toggle('hidden', !installPrompt);
  if (standalone) {
    hint.textContent = '✓ פועלת כאפליקציה מותקנת';
    hint.className = 'hint ok';
  } else if (installPrompt) {
    hint.textContent = 'חלון משלה, בלי סרגל הכתובת, ועם התראות שעובדות ברקע';
    hint.className = 'hint';
  } else {
    hint.textContent = 'בספארי: כפתור השיתוף ← “הוספה למסך הבית”';
    hint.className = 'hint';
  }
}
$('installBtn').onclick = async () => {
  if (!installPrompt) return;
  const p = installPrompt;
  // ההזמנה תקפה לשימוש אחד. גם אם המשתמש ביטל — אי-אפשר להציג אותה שוב,
  // והדפדפן יירה אירוע חדש בביקור הבא אם הוא עדיין רוצה.
  installPrompt = null;
  try { p.prompt(); await p.userChoice; } catch {}
  renderInstallRow();
};

/** כבוי התרעות מתוך ההגדרות. ברירת המחדל דלוק — השער האמיתי הוא הרשאת הדפדפן. */
function notifyOn() { return store.settings.notify !== false; }

/**
 * שתי דרכים לאותה מטרה: באנדרואיד וב-PWA מותקן `new Notification()`
 * זורק או נבלע בשקט, וההתרעה חייבת לצאת מה-Service Worker; בדסקטופ
 * המסלול הישיר עדיף כי הוא עובד גם לפני שה-SW נרשם. מנסים SW קודם
 * ונופלים אחורה — כך אותה קריאה עובדת בשני המקרים.
 */
function desktopNotify(title, body, extra) {
  if (!notifyOn()) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body, icon: '/icons/icon-192.png', badge: '/icons/icon-128.png',
    tag: 'rtl-claude', renotify: true, dir: 'rtl', lang: 'he',
    ...extra,
    data: { url: location.pathname + location.search, ...(extra && extra.data) },
  };
  // actions נתמך אך ורק דרך ה-Service Worker. ב-‎new Notification()‎ הוא לא
  // רק מתעלם — בחלק מהדפדפנים הבנאי זורק, כלומר ההתראה כולה נעלמת בגלל
  // כפתור. לכן במסלול הישיר הוא מוסר, וההתראה יורדת לגרסה בלי כפתורים.
  const plain = { ...opts }; delete plain.actions;
  const direct = () => {
    try {
      const n = new Notification(title, plain);
      n.onclick = () => { window.focus(); clearTitleBadge(); n.close(); };
      return true;
    } catch { return false; }
  };
  const viaSW = () => navigator.serviceWorker?.ready
    .then((reg) => reg.showNotification(title, opts))
    .then(() => true)
    .catch(() => false);
  // לא ממתינים ל-SW כשאפשר להתריע מיד; ב-serviceWorker.ready יש מצב שבו הוא
  // פשוט לא נפתר (אין רישום), ואז ההתרעה הייתה נבלעת לגממרי.
  if (isMobileUA() && navigator.serviceWorker) { viaSW().then((ok) => { if (!ok) direct(); }); return; }
  if (!direct() && navigator.serviceWorker) viaSW();
}

/** אנדרואיד/אייפון או חלון מותקן — שם חובה לעבור דרך ה-Service Worker. */
function isMobileUA() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
}

/** מבקשים רשות פעם אחת בלבד, בעקבות פעולה יזומה של המשתמש (שליחת הודעה). */
function ensureNotifyPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  if (store.settings.notifyAsked) return;
  store.settings.notifyAsked = true; markSettings();
  try { Promise.resolve(Notification.requestPermission()).then(renderNotifyRow).catch(() => {}); } catch {}
}

/**
 * בקשת רשות יזומה — מכפתור בהגדרות. בעבר הבקשה היחידה נשלחה
 * בשליחת הודעה ראשונה, ומי שפיספס אותה נשאר בלי דרך חזרה.
 */
async function requestNotifyPermission() {
  // insecure נראה כמו denied אבל אינו — המנעול שליד הכתובת לא יעזור שם
  if (notifyBlockReason() === 'insecure') { openInsecureNotifyHelp(); return; }
  if (!('Notification' in window)) { toast('הדפדפן הזה לא תומך בהתרעות', true); return; }
  if (Notification.permission === 'denied') {
    toast('ההתרעות חסומות — פתחו את המנעול ליד הכתובת ואשרו אותן', true);
    return;
  }
  try {
    const res = await Notification.requestPermission();
    store.settings.notifyAsked = true; markSettings();
    renderNotifyRow();
    if (res === 'granted') { store.settings.notify = true; save(); toast('התרעות הופעלו'); renderNotifyRow(); }
    else toast('לא ניתנה הרשאה להתרעות', true);
  } catch { toast('בקשת ההרשאה נכשלה', true); }
}

/**
 * שורת ההתרעות בהגדרות. החסימה הנפוצה ביותר היא גישה דרך כתובת
 * ה-LAN ב-http: הדפדפן לא מאפשר שם התרעות כלל, ובלי הסבר זה נראה
 * כמו תקלה בממשק. לכן מציגים במפורש מה חוסם ומה עושים.
 */
function renderNotifyRow() {
  renderNotifyChip(); // אותו מצב בדיוק — נגזר משניהם יחד כדי שלא יסתרו זה את זה
  const box = $('notifyRow'); if (!box) return;
  const cb = $('notifyOn'), hint = $('notifyHint'), ask = $('notifyAsk'), test = $('notifyTest');
  const why = notifyBlockReason();
  const granted = why === 'ok';

  cb.checked = notifyOn();
  cb.disabled = !granted;
  test.disabled = !granted || !notifyOn();

  // כפתורים בהתראה קיימים רק כשההתראה יוצאת מה-Service Worker. בדסקטופ
  // ‎new Notification()‎ מתעלם מהם, ולכן המתג שם היה מבטיח משהו שלא קורה.
  const canAct = !!navigator.serviceWorker && 'actions' in Notification.prototype;
  const actBox = $('notifyActionsRow'), actHint = $('notifyActionsHint');
  const actCb = $('notifyActionsOn');
  actCb.checked = notifyActionsOn();
  actCb.disabled = !granted || !notifyOn() || !canAct;
  actBox.classList.toggle('off', actCb.disabled);
  actHint.textContent = !canAct
    ? 'הדפדפן הזה לא תומך בכפתורים בתוך התראה'
    : notifyActionsOn()
      ? '✓ אפשר לאשר או לדחות בלי לפתוח את האפליקציה'
      : 'ההתראה תגיע בלי כפתורים — האישור נעשה במסך עצמו';
  actHint.className = 'hint' + (canAct && notifyActionsOn() && granted && notifyOn() ? ' ok' : '');
  // ב-insecure הכפתור כן מוצג — הוא לא יבקש הרשאה אלא יפתח את ההסבר,
  // וזה המקום היחיד שממנו מגיעים אליו.
  ask.classList.toggle('hidden', granted || why === 'unsupported' || why === 'denied');
  ask.textContent = why === 'insecure' ? 'למה זה חסום?' : 'בקש הרשאה';

  if (why === 'insecure') {
    // כרום לא מסתיר את ה-API אלא מחזיר denied מיד; ראו notifyBlockReason
    hint.textContent = '✗ הכתובת אינה מאובטחת — התרעות דורשות localhost או HTTPS';
    hint.className = 'hint bad';
  } else if (why === 'unsupported') {
    hint.textContent = '✗ הדפדפן הזה לא תומך בהתרעות';
    hint.className = 'hint bad';
  } else if (why === 'denied') {
    hint.textContent = '✗ חסום בדפדפן — מנעול/⚙ ליד הכתובת ← התרעות ← אפשר';
    hint.className = 'hint bad';
  } else if (!granted) {
    hint.textContent = 'טרם אושרו — לחצו “בקש הרשאה”';
    hint.className = 'hint';
  } else if (!notifyOn()) {
    hint.textContent = 'מושבת — לא תשלחנה התרעות';
    hint.className = 'hint';
  } else {
    hint.textContent = '✓ פעיל — סיום משימה, שאלה, אישור וסוף מכסה';
    hint.className = 'hint ok';
  }
}

/**
 * החיווי בסרגל העליון. שורת ההגדרות למעלה מדויקת אבל בלתי נראית — מי שלא
 * פותח הגדרות מגלה שאין התרעות רק כשהוא מחכה לאחת שלא מגיעה. כאן זה גלוי
 * במקום שהעין ממילא עוברת בו, ולחיצה מטפלת בזה בלי לחפש איפה זה יושב.
 * מוסתר כשההתרעות כובו מדעת: מי שביטל אותן לא צריך תזכורת קבועה.
 */
function renderNotifyChip() {
  const chip = $('notifyChip'); if (!chip) return;
  const why = notifyBlockReason();
  const show = notifyOn() && why !== 'ok';
  chip.classList.toggle('hidden', !show);
  if (!show) return;

  // ההפרדה חשובה: "כבויות" זה מצב שלחיצה אחת פותרת, "חסומות" דורש את
  // הדפדפן עצמו — ומילה אחת חוסכת לחיצה על כפתור שלא יעשה כלום.
  $('notifyChipText').textContent = why === 'ask' ? 'התרעות כבויות' : 'התרעות חסומות';
  chip.title = {
    insecure: 'הכתובת אינה מאובטחת — הדפדפן חוסם התרעות. לחצו להסבר',
    denied: 'ההתרעות חסומות בדפדפן — לחצו להסבר',
    unsupported: 'הדפדפן הזה לא תומך בהתרעות',
    ask: 'לא תקבלו הודעה בסיום משימה — לחצו כדי לאשר התרעות',
  }[why];
  // מתחת ל־640px הטקסט מוסתר ב־CSS; בלי aria-label נשאר רק אייקון אילם.
  chip.setAttribute('aria-label', $('notifyChipText').textContent + ' — ' + (chip.title || ''));
}

/**
 * למה ההתרעות לא יעבדו. `insecure` נבדק ראשון ובכוונה: על origin לא מאובטח
 * כרום לא מסתיר את ה-API אלא מחזיר permission === 'denied' מיד, בלי לשאול.
 * מי שקורא רק את ה-permission מסיק "המשתמש חסם" ושולח למנעול שליד הכתובת —
 * ושם אין בכלל רשומת התרעות, אז העצה מובילה למבוי סתום.
 */
function notifyBlockReason() {
  if (!isSecure()) return 'insecure';
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'ok';
  return Notification.permission === 'denied' ? 'denied' : 'ask';
}

/** לחיצה על החיווי: לבקש את ההרשאה, או להסביר למה אי אפשר לבקש אותה כאן. */
function notifyChipClick() {
  if (notifyBlockReason() === 'insecure') { openInsecureNotifyHelp(); return; }
  requestNotifyPermission();
}

/**
 * ההסבר למצב ה-insecure. toast קצר מדי בשביל ארבעה צעדים שצריך לבצע
 * בחלון אחר, ולכן זה נכנס ליומן השיחה ונשאר שם עד הרענון הבא. את הכתובת
 * עצמה מעתיקים ללוח, כי היא מה שצריך להדביק בתיבה של הדגל — והקלדה ידנית
 * של ip:port היא בדיוק המקום שבו טעות אחת שוברת את כל התהליך.
 */
async function openInsecureNotifyHelp() {
  const origin = location.origin;
  const scheme = /Edg\//.test(navigator.userAgent) ? 'edge'
    : navigator.brave ? 'brave'
    : /Firefox\//.test(navigator.userAgent) ? 'firefox' : 'chrome';

  if (scheme === 'firefox') {
    addNote('פיירפוקס חוסם התרעות בכל כתובת שאינה HTTPS או localhost, ואין בו דגל שעוקף את זה. '
      + 'האפשרויות: לפתוח את הממשק מהמחשב שמריץ אותו דרך localhost, או להגיש אותו ב-HTTPS.');
    return;
  }

  const copied = await copyText(origin);
  addNote('התרעות דורשות הקשר מאובטח, ו-' + origin + ' הוא http רגיל — לכן הדפדפן מחזיר '
    + '"חסום" בלי לשאול אותך, ואין רשומת התרעות במנעול שליד הכתובת. '
    + 'כדי לאשר את הכתובת הזו כמאובטחת: '
    + '(1) פתחו ' + scheme + '://flags/#unsafely-treat-insecure-origin-as-secure  '
    + '(2) הדביקו בתיבה את ' + origin + (copied ? ' — הועתק ללוח' : '') + '  '
    + '(3) העבירו את התפריט לצד ל-Enabled  '
    + '(4) הפעילו מחדש את הדפדפן. '
    + 'לאחר מכן החיווי בסרגל יציע "בקש הרשאה" והתרעות יעבדו כרגיל.');
}

/** הדפדפן מגדיר localhost כמאובטח גם ב-http; כתובת LAN — לא. */
function isSecure() { return window.isSecureContext === true; }

// ---------- ייצוא שיחה ל-Markdown ----------
function convToMarkdown(c) {
  const lines = [`# ${c.title || 'שיחה'}`, ''];
  lines.push(`> ${new Date(c.createdAt || Date.now()).toLocaleString('he-IL')}`);
  if (isNoDir(c.cwd)) lines.push('> שיחה ללא תיקייה (בלי כלים)');
  else if (c.cwd) lines.push(`> תיקיית עבודה: \`${c.cwd}\``);
  if (c.sessionId) lines.push(`> session: \`${c.sessionId}\``);
  lines.push('');
  for (const m of (c.messages || [])) {
    if (m.role === 'user') {
      lines.push('## אני', '', m.text || '', '');
      for (const a of (m.atts || [])) lines.push(`- תמונה: ${a.name} (\`${a.path}\`)`);
    } else {
      lines.push('## Claude', '');
      for (const b of (m.blocks || [])) {
        if (b.type === 'text') lines.push(b.text || '', '');
        else if (b.type === 'thinking') lines.push('<details><summary>חשיבה</summary>', '', (b.text && b.text.trim()) ? b.text : `_המודל הזה לא חושף את תוכן החשיבה${b.tokens ? ` · ~${Number(b.tokens).toLocaleString('he-IL')} טוקנים` : ''}_`, '', '</details>', '');
        else if (b.type === 'tool') {
          lines.push(`**כלי: ${b.name}**`, '', '```json', prettyInput(b.input || {}), '```', '');
          if (b.result) lines.push('```', clamp(String(b.result), 4000), '```', '');
        } else if (b.type === 'ask') {
          lines.push(`**${b.tool === 'AskUserQuestion' ? 'שאלה' : 'בקשת אישור'}**`, '');
          for (const [q, a] of Object.entries(b.answers || {})) lines.push(`- ${q} → **${a}**`);
          lines.push('');
        } else if (b.type === 'halt') {
          lines.push(`> ${b.soft ? '⏸' : '⚠'} **${b.title || 'התור נעצר'}** (\`${b.reason || 'error'}\`)`, '');
          if (b.detail) lines.push('```', clamp(String(b.detail), 4000), '```', '');
        }
      }
    }
  }
  return lines.join('\n');
}
async function exportActiveConv() {
  const c = activeConv();
  if (!c) return;
  if (!c.loaded) await ensureLoaded(c.id);
  const blob = new Blob([convToMarkdown(c)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (c.title || 'שיחה').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) + '.md';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('השיחה יוצאה כקובץ Markdown');
}

// ---------- חיפוש בתוך השיחה הפעילה ----------
// מסמן התאמות ישירות בטקסט (בלי לגעת ב-HTML של הבלוקים) ומדלג ביניהן.
function clearFindMarks() {
  for (const m of findState.marks) {
    const p = m.parentNode;
    if (!p) continue;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  }
  findState.marks = []; findState.idx = -1;
}
function runFind(q) {
  clearFindMarks();
  findState.q = q;
  if (!q || q.length < 2) { updateFindCount(); return; }
  const needle = q.toLowerCase();
  const root = $('log');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.toLowerCase().includes(needle) && n.parentElement
      && !['SCRIPT', 'STYLE', 'MARK'].includes(n.parentElement.tagName)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const targets = [];
  while (walker.nextNode() && targets.length < 500) targets.push(walker.currentNode);
  for (const node of targets) {
    let text = node.nodeValue, pos = 0;
    const frag = document.createDocumentFragment();
    for (;;) {
      const i = text.toLowerCase().indexOf(needle, pos);
      if (i < 0) break;
      if (i > pos) frag.appendChild(document.createTextNode(text.slice(pos, i)));
      const mark = document.createElement('mark');
      mark.className = 'find-hit';
      mark.textContent = text.slice(i, i + q.length);
      frag.appendChild(mark);
      findState.marks.push(mark);
      pos = i + q.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }
  if (findState.marks.length) stepFind(1);   // idx מתחיל ב־1- ⇒ קופץ להתאמה הראשונה
  updateFindCount();
}
function stepFind(delta) {
  if (!findState.marks.length) return;
  const prev = findState.marks[findState.idx];
  if (prev) prev.classList.remove('cur');
  findState.idx = (findState.idx + delta + findState.marks.length) % findState.marks.length;
  const cur = findState.marks[findState.idx];
  cur.classList.add('cur');
  stick = false;
  cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  updateFindCount();
}
function updateFindCount() {
  const c = $('findCount');
  if (c) c.textContent = findState.marks.length ? `${findState.idx + 1}/${findState.marks.length}` : (findState.q.length >= 2 ? 'אין תוצאות' : '');
}
function openFind() {
  $('findBar').classList.remove('hidden');
  const i = $('findInput'); i.focus(); i.select();
}
function closeFind() {
  $('findBar').classList.add('hidden');
  clearFindMarks(); findState.q = '';
  $('findInput').value = ''; updateFindCount();
  $('input').focus();
}

// ---------- עזרת מקשי קיצור ----------
const SHORTCUTS = [
  ['Ctrl/⌘ + K', 'לוח פקודות — קפיצה לשיחה או פעולה'],
  ['Ctrl/⌘ + F', 'חיפוש בתוך השיחה הפעילה'],
  ['Ctrl/⌘ + Shift + F', 'חיפוש בכל השיחות (סרגל הצד)'],
  ['Ctrl/⌘ + N', 'שיחה חדשה'],
  ['Ctrl/⌘ + E', 'ייצוא השיחה ל-Markdown'],
  ['Ctrl/⌘ + Shift + M', 'הכתבה קולית — התחלה ועצירה'],
  ['Enter', 'שליחה · Shift+Enter לשורה חדשה'],
  ['↑ / ↓ בתיבה ריקה', 'מעבר בהיסטוריית ההודעות'],
  ['/ בתחילת שורה', 'תפריט פקודות'],
  ['@', 'אזכור קובץ מתיקיית העבודה'],
  ['Esc', 'סגירת חלונית / תפריט'],
  ['?', 'המסך הזה'],
];
function openShortcuts() {
  const wrap = el('div', 'sc-list');
  for (const [k, d] of SHORTCUTS) {
    const row = el('div', 'sc-row');
    row.appendChild(el('kbd', null, k));
    row.appendChild(el('span', 'sc-desc', d));
    wrap.appendChild(row);
  }
  openModal('מקשי קיצור', wrap);
}

// ---------- חיווט ----------
$('limitResumeNow').onclick = () => {
  if (!sendQueueCmd('limit_resume_now')) { toast('אין חיבור לשרת', true); return; }
  toast('מנסים להמשיך עכשיו…');
};
$('limitCancel').onclick = () => {
  if (!sendQueueCmd('limit_cancel')) return;
  setLimitState(null);
  toast('ההמשך האוטומטי בוטל');
};

$('askBarGo').onclick = jumpToPendingAsk;
$('askBar').onclick = (e) => { if (e.target === $('askBar')) jumpToPendingAsk(); };
$('exportBtn').onclick = exportActiveConv;
$('findBtn').onclick = openFind;
$('findClose').onclick = closeFind;
$('findPrev').onclick = () => stepFind(-1);
$('findNext').onclick = () => stepFind(1);
$('findInput').addEventListener('input', debounce((e) => runFind(e.target.value.trim()), 200));
$('findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = ['INPUT', 'TEXTAREA'].includes((e.target.tagName || '')) || e.target.isContentEditable;
  if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    if (e.shiftKey) { document.querySelector('.app').classList.remove('side-collapsed'); $('convSearch').focus(); $('convSearch').select(); }
    else openFind();
    return;
  }
  if (mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); $('newChat').click(); return; }
  if (mod && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); exportActiveConv(); return; }
  if (mod && e.shiftKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); dictToggle(); return; }
  if (e.key === '?' && !typing && !mod) { e.preventDefault(); openShortcuts(); return; }
  if (e.key === 'Escape' && dictOn) { e.preventDefault(); dictStop(); return; }
  if (e.key === 'Escape' && !$('findBar').classList.contains('hidden')) { closeFind(); return; }
  // לוח "עוד" בטלפון נפתח בלי פוקוס בשדה — Escape על הקלט לא קיים שם.
  if (e.key === 'Escape' && !$('palette').classList.contains('hidden')) { e.preventDefault(); closePalette(); return; }
  if (e.key === 'Escape' && !$('settings').classList.contains('hidden')) { e.preventDefault(); $('settings').classList.add('hidden'); return; }
  if (e.key === 'Escape' && !$('usageModal').classList.contains('hidden')) { e.preventDefault(); setUsageModalOpen(false); return; }
  if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) { e.preventDefault(); closeModal(); return; }
  if (e.key === 'Escape' && !$('modelPicker').classList.contains('hidden')) { e.preventDefault(); closeModelPicker(); return; }
});

/* ==========================================================================
   טלפון: מידות אמיתיות במקום מספרים קבועים
   ========================================================================== */

// גובה המחבר בפועל -> --composer-h.
// הבר "מעבד", הבזק הסיום, כפתור "לתחתית" וההודעות הצפות מרחפים מעל המחבר,
// וכולם הניחו גובה קבוע של 132px. כל דבר שמגדיל את המחבר — רצועת המכסה,
// צרופות, תור הודעות, ובעיקר שורת הבוררים שנעטפת בטלפון — הקפיץ אותם אל
// *מעל* תיבת הכתיבה והסתיר בדיוק את "שלח".
(function trackComposerHeight() {
  const composer = document.querySelector('.composer');
  if (!composer) return;
  const apply = () => {
    const h = Math.round(composer.getBoundingClientRect().height);
    if (h) document.documentElement.style.setProperty('--composer-h', h + 'px');
  };
  new ResizeObserver(apply).observe(composer);
  apply();
})();

// גובה החלון שנשאר אחרי המקלדת -> --app-h.
// ב-iOS המקלדת לא מקטינה את 100dvh, ולכן המחבר נדחף מתחת למקלדת בדיוק ברגע
// שמתחילים להקליד. visualViewport הוא היחיד שיודע כמה מסך באמת נשאר.
// רק במגע: בדסקטופ זום של הדפדפן משנה את visualViewport ויכווץ את הממשק לחינם.
//
// --app-top (= offsetTop): כשהמקלדת דוחפת את החלון החזותי למעלה בלי לשנות
// את ה-layout, גובה לבדו משאיר פער מת בין תחתית האפליקציה למקלדת. מצמידים.
//
// compose-compact: *רק* כשהמקלדת באמת פתוחה. משווים לגובה המנוחה (הגבוה
// ביותר שראינו), לא לפוקוס בשדה — אחרת המטא־נתונים נעלמים גם בלי מקלדת.
// הסף 150px מבדיל מקלדת מצמצום סרגל הכתובת (~50–100).
(function trackVisualViewport() {
  const vv = window.visualViewport;
  if (!vv || !matchMedia('(pointer: coarse)').matches) return;
  let resting = vv.height;
  const apply = () => {
    const h = Math.round(vv.height);
    const top = Math.round(vv.offsetTop);
    document.documentElement.style.setProperty('--app-h', h + 'px');
    document.documentElement.style.setProperty('--app-top', top + 'px');
    // ה-layout viewport עצמו נגלל כשהמקלדת נפתחת, והממשק "בורח" כלפי מעלה
    if (window.scrollY > 0) window.scrollTo(0, 0);
    if (stick) autoScroll(true);
    if (h > resting) resting = h;
    // פתיחת המקלדת וסגירתה משנות את הפריסה של שורת הכתיבה: החריץ שבו הטקסט
    // צריך להיכנס, הריפוד, והתקרה לגובה התיבה. בלי חישוב מחדש כאן, המצב
    // שנקבע לפני המקלדת נשאר עד ההקלדה הבאה — ורואים תיבה בגובה הלא נכון.
    const wasCompact = document.body.classList.contains('compose-compact');
    const compact = (resting - h) > 150;
    document.body.classList.toggle('compose-compact', compact);
    if (compact !== wasCompact) autoGrow();
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  addEventListener('orientationchange', () => {
    setTimeout(() => { resting = vv.height; apply(); }, 400);
  });
  apply();
})();

// ה-placeholder המלא ("במה אפשר לעזור לך היום? · / לפקודות · @ לקבצים") נשבר
// לשתי שורות ברוחב 360 ודחף את שורת הפקדים מטה. בטלפון הוא הזמנה לכתוב, לא
// טבלת קיצורים — ‎/‎ ו-@ ממילא מציגים את התפריט שלהם ברגע שמקלידים אותם.
(function narrowPlaceholder() {
  const input = $('input');
  if (!input) return;
  const full = input.placeholder;
  const short = 'הודעה ל-Claude…';
  const mq = matchMedia('(max-width: 560px)');
  const apply = () => { input.placeholder = mq.matches ? short : full; };
  mq.addEventListener('change', apply);
  apply();
})();

/* ==========================================================================
   מצב דואט — הצד של המסך
   --------------------------------------------------------------------------
   הריצה עצמה חיה בשרת. מה שכאן הוא צופה: תמונת מצב שמגיעה ב-sync, ואחריה
   פריימים נקודתיים שמעדכנים חלקים ממנה. לכן אין כאן בנייה מחדש של המסך בכל
   דלתא — השלד נבנה פעם אחת, וההפניות אליו נשמרות ב-duetDom.
   ========================================================================== */

let duetRun = null;               // תמונת המצב של הריצה שמוצגת כרגע
let duetDom = null;               // הפניות לשלד שנבנה
let duetLive = null;              // התור שמזרים ברגע זה — { role, raw, think }
let duetViewV = 0;                // הגרסה שנבחרה בבורר; 0 = הנוכחית
const duetVerCache = new Map();   // v → טקסט, כדי לא למשוך את אותה גרסה פעמיים
let duetPaintRaf = 0;

// הצהרת function ולא const: היא נקראת מ-renderConversation ומכפתור "שיחה
// חדשה", ששניהם מוגדרים למעלה בקובץ — הרמה של ההצהרה מבטיחה שהיא קיימת שם.
function isDuet(c) { return !!(c && c.mode === 'duet'); }
const ROLE_LABEL = { A: 'משתתף א׳', B: 'משתתף ב׳', S: 'מפקח', user: 'ממך' };
const DUET_STATUS_LABEL = {
  setup: 'הגדרת ריצה', idle: 'מוכן', running: 'רצה', paused: 'מושהית',
  error: 'נעצרה על שגיאה', done: 'הסתיימה',
};
const END_LABEL = {
  complete: 'המטרה הושגה', stalled: 'התכנסות — אין רווח נוסף',
  turnlimit: 'תקרת התורות', stopped: 'הופסקה על-ידך',
};

let duetSetupBusy = null;   // { reset } — הכפתור שממתין לתשובת השרת על duet_start

function duetSend(type, extra) {
  if (!ws || ws.readyState !== ws.OPEN) { toast('אין חיבור לשרת', true); return false; }
  ws.send(JSON.stringify({ type, ...(extra || {}) }));
  return true;
}

/** שיחה חדשה במצב דואט. לא נכתבת לדיסק עד שהריצה מתחילה — השרת הוא שכותב. */
function newDuetConv() {
  const c = {
    id: uid(), title: 'דואט חדש', mode: 'duet', sessionId: null, messages: [], cost: 0, ctx: null,
    cwd: (store.settings.cwd || ''), draft: '', createdAt: Date.now(), updatedAt: Date.now(),
    loaded: true, rev: 0,
  };
  store.convs.unshift(c);
  activeId = c.id;
  duetRun = null; duetLive = null; duetViewV = 0; duetVerCache.clear();
  subscribeActive();
  markSettings();
  renderConvList();
  renderConversation();
  return c;
}

/* ---------- בוררי מודל לטופס ההגדרה ---------- */

function duetModelSelect(value) {
  const sel = el('select', 'pill dt-model-sel');
  sel.appendChild(opt('', 'מודל ברירת מחדל'));
  fillModelOptions(sel);
  keepValue(sel, value || '', '');
  return sel;
}
function duetEffortSelect(modelSel, value) {
  const sel = el('select', 'pill dt-effort-sel');
  const fill = () => {
    const cur = sel.value || value || '';
    const m = CONFIG.models.find((x) => x.id === modelSel.value);
    const efforts = m ? (m.efforts || []) : [];
    sel.innerHTML = '';
    sel.appendChild(opt('', 'מאמץ רגיל'));
    EFFORT_ORDER.filter((e) => efforts.includes(e)).forEach((e) => sel.appendChild(opt(e, EFFORT_LABEL[e] || e)));
    sel.disabled = !efforts.length;
    keepValue(sel, cur, '');
  };
  modelSel.addEventListener('change', fill);
  fill();
  return sel;
}

/** שורת בחירה אחת (משתתף או מפקח) בטופס ההגדרה. */
function duetPickerRow(role, title, hint, defModel) {
  const row = el('div', 'dt-pick dt-pick-' + role);
  const head = el('div', 'dt-pick-head');
  head.appendChild(el('span', 'dt-badge dt-badge-' + role, role === 'S' ? 'ם' : (role === 'A' ? 'א' : 'ב')));
  head.appendChild(el('b', null, title));
  head.appendChild(el('small', null, hint));
  row.appendChild(head);
  const controls = el('div', 'dt-pick-ctl');
  const m = duetModelSelect(defModel);
  const e = duetEffortSelect(m, '');
  // גם כאן הבחירה עוברת בחלונית החיפוש; הבורר עצמו נשאר מוסתר בתוך העטיפה
  // ונקרא כרגיל ב-row._model.value כשהריצה מתחילה.
  const mWrap = el('div', 'pill-wrap');
  mWrap.appendChild(attachModelSearch(m));
  mWrap.appendChild(m);
  controls.appendChild(mWrap); controls.appendChild(e);
  row.appendChild(controls);
  row._model = m; row._effort = e;
  return row;
}

/* ---------- טופס ההגדרה ---------- */

function renderDuetSetup(conv, log) {
  const box = el('div', 'dt-setup');

  const intro = el('div', 'dt-intro');
  intro.appendChild(el('h2', null, 'דואט'));
  intro.appendChild(el('p', null,
    'שני מודלים עובדים על תוצר אחד, לסירוגין: אחד כותב גרסה, השני קורא אותה, ' +
    'משפר ומחזיר. מודל שלישי מפקח — הוא לא כותב ולא מדבר אליך, רק בודק שהעבודה ' +
    'עדיין משרתת את המטרה ומחליט מתי היא נגמרה.'));
  box.appendChild(intro);

  const goalWrap = el('label', 'dt-field');
  goalWrap.appendChild(el('span', 'dt-lbl', 'המטרה'));
  const goal = el('textarea', 'dt-goal');
  goal.rows = 4;
  goal.placeholder = 'מה שני המודלים אמורים לייצר? ככל שתהיה מדויק יותר, כך המפקח יוכל לשפוט טוב יותר.';
  goalWrap.appendChild(goal);
  box.appendChild(goalWrap);

  // ברירת מחדל: ב׳ אינו א׳. אותו מודל בשני הצדדים הוא הגדרה לגיטימית, אבל
  // ההצעה הראשונה היא שני מודלים שונים — שם ההבדל בין הידיים באמת מורגש.
  const ids = CONFIG.models.map((m) => m.id);
  const defA = store.settings.model || ids[0] || '';
  const defB = ids.find((x) => x !== defA) || defA;
  const defS = ids.find((x) => x !== defA && x !== defB) || defA;

  const picks = el('div', 'dt-picks');
  const rowA = duetPickerRow('A', 'משתתף א׳', 'כותב את הגרסה הראשונה', defA);
  const rowB = duetPickerRow('B', 'משתתף ב׳', 'מקבל, משפר ומחזיר', defB);
  const rowS = duetPickerRow('S', 'מפקח', 'לא כותב — רק מכוון ומחליט מתי נגמר', defS);
  picks.appendChild(rowA); picks.appendChild(rowB); picks.appendChild(rowS);
  box.appendChild(picks);

  const opts = el('div', 'dt-opts');

  const turnsWrap = el('label', 'dt-field dt-inline');
  turnsWrap.appendChild(el('span', 'dt-lbl', 'מספר תורות מרבי'));
  const turns = el('input', 'dt-turns');
  turns.type = 'number'; turns.min = '2'; turns.max = '30'; turns.value = '8'; turns.dir = 'ltr';
  turnsWrap.appendChild(turns);
  turnsWrap.appendChild(el('small', 'dt-hint', 'הריצה יכולה להסתיים לפני כן — המפקח הוא שמחליט'));
  opts.appendChild(turnsWrap);

  const visWrap = el('label', 'dt-field dt-inline');
  visWrap.appendChild(el('span', 'dt-lbl', 'הערות המפקח'));
  const vis = el('select', 'pill dt-vis');
  vis.appendChild(opt('shared', 'גלויות לשני המשתתפים'));
  vis.appendChild(opt('whisper', 'נלחשות לדובר הבא בלבד'));
  visWrap.appendChild(vis);
  visWrap.appendChild(el('small', 'dt-hint', 'בשני המצבים ההערה נכנסת לתור הבא; ההבדל הוא אם היא מוצגת בתמליל'));
  opts.appendChild(visWrap);
  box.appendChild(opts);

  const seedDet = el('details', 'dt-seed');
  seedDet.innerHTML = '<summary>תוצר פתיחה (לא חובה)</summary>';
  const seed = el('textarea', 'dt-seed-text');
  seed.rows = 6;
  seed.placeholder = 'יש כבר טיוטה? הדבק אותה כאן והיא תהיה גרסה 1. אחרת משתתף א׳ יכתוב אותה מהמטרה.';
  seedDet.appendChild(seed);
  box.appendChild(seedDet);

  const acts = el('div', 'dt-setup-acts');
  const go = el('button', 'dt-go', 'התחל את הריצה');
  const err = el('span', 'dt-setup-err');
  go.onclick = () => {
    const g = goal.value.trim();
    if (!g) { err.textContent = 'צריך מטרה כדי להתחיל.'; goal.focus(); return; }
    err.textContent = '';
    go.disabled = true; go.textContent = 'מתחיל…';
    duetSetupBusy = { reset: (why) => { go.disabled = false; go.textContent = 'התחל את הריצה'; err.textContent = why || ''; } };
    conv.cwd = conv.cwd || store.settings.cwd || '';
    duetSend('duet_start', {
      cfg: {
        goal: g,
        seed: seed.value,
        A: { model: rowA._model.value, effort: rowA._effort.value },
        B: { model: rowB._model.value, effort: rowB._effort.value },
        S: { model: rowS._model.value, effort: rowS._effort.value },
        maxTurns: Number(turns.value) || 8,
        noteVisibility: vis.value,
        cwd: conv.cwd,
      },
    });
    // אם השרת לא ענה תוך כמה שניות, מחזירים את הכפתור במקום להשאיר מסך תקוע
    setTimeout(() => { if (!duetRun && go.isConnected && duetSetupBusy) duetSetupBusy.reset('השרת לא הגיב — נסה שוב.'); }, 8000);
  };
  acts.appendChild(go); acts.appendChild(err);
  box.appendChild(acts);

  log.appendChild(box);
  setTimeout(() => goal.focus(), 30);
}

/* ---------- תצוגת הריצה ---------- */

function renderDuetRun(log) {
  const root = el('div', 'dt-run');

  // ----- למעלה: התוצר החי -----
  const art = el('section', 'dt-art');
  const ah = el('header', 'dt-art-head');
  ah.appendChild(el('b', 'dt-art-title', 'התוצר'));
  const verSel = el('select', 'pill dt-ver');
  verSel.title = 'צפייה בגרסה קודמת';
  ah.appendChild(verSel);
  const verNote = el('span', 'dt-ver-note');
  ah.appendChild(verNote);
  ah.appendChild(el('span', 'dt-spacer'));
  const copyBtn = el('button', 'dt-mini', 'העתק');
  const saveBtn = el('button', 'dt-mini', 'שמור לקובץ');
  ah.appendChild(copyBtn); ah.appendChild(saveBtn);
  art.appendChild(ah);

  const prog = el('div', 'dt-prog');
  prog.innerHTML = '<i></i>';
  const progTxt = el('span', 'dt-prog-txt');
  prog.appendChild(progTxt);
  art.appendChild(prog);

  const artBody = el('div', 'dt-art-body md');
  art.appendChild(artBody);
  root.appendChild(art);

  // ----- למטה: מהלך העבודה -----
  const lane = el('section', 'dt-lane');
  const lh = el('header', 'dt-lane-head');
  lh.appendChild(el('b', null, 'מהלך העבודה'));
  const goalChip = el('span', 'dt-goal-chip');
  goalChip.title = 'המטרה של הריצה';
  lh.appendChild(goalChip);
  lh.appendChild(el('span', 'dt-spacer'));
  const costChip = el('span', 'dt-cost');
  costChip.title = 'עלות מצטברת של שלושת המודלים בריצה הזו';
  lh.appendChild(costChip);
  lane.appendChild(lh);
  const cards = el('div', 'dt-cards');
  lane.appendChild(cards);
  root.appendChild(lane);

  // ----- פקדים -----
  const ctl = el('footer', 'dt-ctl');
  const statusWrap = el('div', 'dt-state');
  ctl.appendChild(statusWrap);
  const acts = el('div', 'dt-acts');
  ctl.appendChild(acts);
  const noteRow = el('div', 'dt-note-row');
  const noteIn = el('input', 'dt-note-in');
  noteIn.type = 'text';
  noteIn.placeholder = 'הערה לתור הבא — תיכנס למשתתף הבא, מסומנת כהערה ממך';
  const noteBtn = el('button', 'dt-mini', 'שלח הערה');
  const sendNote = () => {
    const t = noteIn.value.trim();
    if (!t) return;
    duetSend('duet_note', { text: t });
    noteIn.value = '';
  };
  noteBtn.onclick = sendNote;
  noteIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendNote(); } };
  noteRow.appendChild(noteIn); noteRow.appendChild(noteBtn);
  ctl.appendChild(noteRow);
  root.appendChild(ctl);

  log.appendChild(root);

  duetDom = { root, artBody, verSel, verNote, prog, progBar: prog.querySelector('i'), progTxt, cards, lane, ctl, statusWrap, acts, costChip, goalChip, noteRow, noteIn, copyBtn, saveBtn, liveCard: null, liveBody: null };

  copyBtn.onclick = async () => {
    const ok = await copyText(duetShownText());
    copyBtn.textContent = ok ? 'הועתק ✓' : 'נכשל';
    setTimeout(() => { copyBtn.textContent = 'העתק'; }, 1400);
  };
  saveBtn.onclick = () => duetSaveFile();
  verSel.onchange = () => duetShowVersion(Number(verSel.value));

  duetPaintAll();
}

/** הטקסט שמוצג כרגע בחלונית התוצר — הנוכחי, או גרסה קודמת שנבחרה. */
function duetShownText() {
  if (!duetRun) return '';
  if (duetViewV && duetVerCache.has(duetViewV)) return duetVerCache.get(duetViewV);
  if (duetLive && duetLive.artifact != null) return duetLive.artifact;
  return duetRun.artifact || '';
}

function duetSaveFile() {
  const text = duetShownText();
  if (!text) return;
  const name = 'duet-v' + (duetViewV || (duetRun && duetRun.version) || 0) + '.md';
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('נשמר: ' + name);
}

async function duetShowVersion(v) {
  duetViewV = v || 0;
  if (!duetViewV || duetVerCache.has(duetViewV)) return duetPaintArtifact();
  // גוף הגרסאות הישנות לא נשלח בסנכרון — נמשך רק כשבוחרים בהן
  try {
    const r = await fetch('/api/duet/' + encodeURIComponent(activeId) + '/version/' + duetViewV);
    if (r.ok) { const d = await r.json(); duetVerCache.set(duetViewV, d.text || ''); }
  } catch {}
  duetPaintArtifact();
}

/* ---------- ציור ---------- */

function duetPaintAll() {
  if (!duetDom || !duetRun) return;
  duetPaintVersions();
  duetPaintArtifact();
  duetPaintLane();
  duetPaintStatus();
  duetPaintProgress();
  duetPaintCost();
  duetDom.goalChip.textContent = clamp((duetRun.goal || '').replace(/\s+/g, ' '), 90);
}

function duetPaintVersions() {
  const sel = duetDom.verSel;
  const vs = duetRun.versions || [];
  const want = duetViewV;
  sel.innerHTML = '';
  sel.appendChild(opt('0', vs.length ? 'גרסה ' + duetRun.version + ' · נוכחית' : 'עוד אין גרסה'));
  for (let i = vs.length - 1; i >= 0; i--) {
    const v = vs[i];
    if (v.v === duetRun.version) continue;
    sel.appendChild(opt(String(v.v), 'גרסה ' + v.v + ' · ' + (ROLE_LABEL[v.author] || v.author)));
  }
  keepValue(sel, String(want || 0), '0');
  sel.disabled = vs.length < 2;
}

function duetPaintArtifact() {
  if (!duetDom) return;
  if (duetPaintRaf) cancelAnimationFrame(duetPaintRaf);
  // סטרימינג יורה עשרות דלתות בשנייה, ופענוח Markdown על כל אחת מהן היה נועל
  // את הדפדפן. פריים אחד לכל ציור, ולא ציור אחד לכל דלתא.
  duetPaintRaf = requestAnimationFrame(() => {
    duetPaintRaf = 0;
    const body = duetDom.artBody;
    const streaming = !!(duetLive && duetLive.artifact != null && !duetViewV);
    const text = duetShownText();
    duetDom.verNote.textContent = duetViewV ? 'גרסה קפואה — הריצה ממשיכה' : '';
    duetDom.verNote.classList.toggle('on', !!duetViewV);
    if (!text) {
      body.innerHTML = '';
      body.appendChild(el('div', 'dt-empty', duetRun && duetRun.status === 'running'
        ? 'משתתף א׳ כותב את הגרסה הראשונה…'
        : 'עוד אין תוצר.'));
      return;
    }
    body.innerHTML = streaming ? renderMdLive(text) : renderMd(text);
    if (!streaming) enhance(body);
    body.classList.toggle('streaming', streaming);
  });
}

function duetPaintProgress() {
  const p = Math.max(0, Math.min(100, Number(duetRun.progress) || 0));
  duetDom.progBar.style.width = p + '%';
  duetDom.progTxt.textContent = p ? p + '%' : '';
  duetDom.prog.classList.toggle('on', p > 0);
}

function duetPaintCost() {
  const c = duetRun.cost || {};
  const bits = [fmtCost(c.usd || 0)];
  if (c.in || c.out) bits.push('קלט ' + fmtTok(c.in || 0) + ' · פלט ' + fmtTok(c.out || 0));
  duetDom.costChip.textContent = bits.join(' · ');
  const per = Object.entries(c.byRole || {}).map(([r, x]) => `${ROLE_LABEL[r] || r}: ${fmtCost(x.usd)} (${x.calls} קריאות)`);
  duetDom.costChip.title = per.length ? 'עלות לפי משתתף —\n' + per.join('\n') : 'עלות מצטברת של הריצה';
}

/* ---------- מהלך העבודה: כרטיס לכל תור, נתיב צר למפקח ---------- */

const roleBadge = (r) => el('span', 'dt-badge dt-badge-' + r, r === 'A' ? 'א' : r === 'B' ? 'ב' : r === 'S' ? 'ם' : '·');

function duetTurnCard(t) {
  const card = el('article', 'dt-turn dt-turn-' + t.speaker);
  const h = el('header', null);
  h.appendChild(roleBadge(t.speaker));
  h.appendChild(el('b', null, ROLE_LABEL[t.speaker] || t.speaker));
  h.appendChild(el('span', 'dt-vtag', 'גרסה ' + t.version));
  const mdl = el('span', 'dt-model');
  mdl.appendChild(brandMarkEl(t.model, 14));
  mdl.appendChild(el('span', 'dt-model-name', t.model ? modelShort(t.model) : 'ברירת מחדל'));
  mdl.title = brandTitle(t.model);
  h.appendChild(mdl);
  h.appendChild(el('span', 'dt-spacer'));
  if (t.done) h.appendChild(el('span', 'dt-flag', 'אין מה לשנות'));
  h.appendChild(el('time', 'dt-time', shortAgo(t.ts)));
  card.appendChild(h);

  // הנחיות שנכנסו דווקא לתור הזה — כך רואים מה הניע שינוי ולא רק מה השתנה
  for (const n of (t.notes || [])) {
    const chip = el('div', 'dt-inj dt-inj-' + n.from);
    chip.appendChild(el('span', 'dt-inj-tag', n.from === 'user' ? 'הערה ממך' : 'הכוונת המפקח'));
    chip.appendChild(el('span', null, n.text));
    card.appendChild(chip);
  }

  const ul = el('ul', 'dt-chg');
  for (const c of (t.changelog || [])) ul.appendChild(el('li', null, c));
  card.appendChild(ul);

  if (t.full) {
    const det = el('details', 'dt-full');
    det.appendChild(el('summary', null, 'התשובה המלאה'));
    const pre = el('pre', null, t.full);
    det.appendChild(pre);
    card.appendChild(det);
  }
  return card;
}

function duetSupCard(n) {
  const whisper = duetRun.noteVisibility === 'whisper';
  if (n.status === 'complete' || n.status === 'stalled') {
    const box = el('div', 'dt-sup dt-sup-end');
    box.appendChild(el('span', 'dt-sup-ic', n.status === 'complete' ? '✓' : '⏹'));
    const b = el('div', 'dt-sup-body');
    b.appendChild(el('b', null, n.status === 'complete' ? 'המפקח: המטרה הושגה' : 'המפקח: העבודה הפסיקה להשתפר'));
    if (n.reason) b.appendChild(el('small', null, n.reason));
    box.appendChild(b);
    return box;
  }
  if (n.status === 'steer') {
    const box = el('div', 'dt-sup dt-sup-steer' + (whisper ? ' dt-sup-whisper' : ''));
    box.appendChild(el('span', 'dt-sup-ic', '◇'));
    const b = el('div', 'dt-sup-body');
    if (whisper) {
      // "נלחשת" משנה את הבליטות בתמליל, לא את הזכות שלך לראות מה נאמר בשמך
      const sum = el('button', 'dt-whisper-toggle', 'הערה נלחשה למשתתף הבא — הצג');
      const txt = el('div', 'dt-sup-note hidden', n.note);
      sum.onclick = () => { txt.classList.toggle('hidden'); sum.textContent = txt.classList.contains('hidden') ? 'הערה נלחשה למשתתף הבא — הצג' : 'הערה נלחשה למשתתף הבא'; };
      b.appendChild(sum); b.appendChild(txt);
    } else {
      b.appendChild(el('div', 'dt-sup-note', n.note));
    }
    if (n.reason) b.appendChild(el('small', null, n.reason));
    box.appendChild(b);
    return box;
  }
  // "ok" — סימן דק בלבד. שתיקה היא הפלט הנכון של המפקח ברוב התורות, ולא
  // אמורה לתפוס באמת מקום על המסך.
  const q = el('div', 'dt-sup dt-sup-ok' + (n.unreadable ? ' dt-sup-bad' : ''));
  q.appendChild(el('span', 'dt-sup-ic', n.unreadable ? '!' : '·'));
  q.appendChild(el('span', 'dt-sup-quiet', n.unreadable ? 'הפיקוח דילג על התור הזה' : 'המפקח לא התערב'));
  // המפקח לפעמים מנסח הערה גם כשהוא בוחר לא להתערב. היא לא נכנסת לתור הבא —
  // ולכן היא לא תופסת מקום בתמליל — אבל אין סיבה שלא תהיה זמינה בריחוף.
  q.title = [n.note, n.reason].filter(Boolean).join('\n\n');
  return q;
}

function duetPaintLane() {
  const cards = duetDom.cards;
  cards.innerHTML = '';
  duetDom.liveCard = null; duetDom.liveBody = null;

  const notes = duetRun.supervisorNotes || [];
  for (const t of (duetRun.history || [])) {
    cards.appendChild(duetTurnCard(t));
    for (const n of notes) if (n.after === t.version) cards.appendChild(duetSupCard(n));
  }

  // הערות שהוקלדו ועוד לא נצרכו — כדי שלא תיראה כאילו נבלעו
  const pending = (duetRun.userNotes || []).filter((n) => n.atVersion >= duetRun.version && !laneHasNote(n));
  for (const n of pending) {
    const box = el('div', 'dt-sup dt-sup-user');
    box.appendChild(el('span', 'dt-sup-ic', '✎'));
    const b = el('div', 'dt-sup-body');
    b.appendChild(el('div', 'dt-sup-note', n.text));
    b.appendChild(el('small', null, 'תיכנס לתור הבא'));
    box.appendChild(b);
    cards.appendChild(box);
  }

  if (duetLive) duetMountLive();
  if (['done', 'error'].includes(duetRun.status)) cards.appendChild(duetEndCard());
  duetScrollLane();
}

/** האם ההערה הזו כבר נרשמה בתוך כרטיס תור (כלומר נצרכה) */
function laneHasNote(n) {
  return (duetRun.history || []).some((t) => (t.notes || []).some((x) => x.from === 'user' && x.text === n.text));
}

function duetEndCard() {
  const box = el('div', 'dt-end dt-end-' + (duetRun.status === 'error' ? 'err' : (duetRun.endKind || 'done')));
  if (duetRun.status === 'error') {
    box.appendChild(el('b', null, 'הריצה נעצרה'));
    box.appendChild(el('p', null, (duetRun.error && duetRun.error.text) || 'שגיאה לא ידועה'));
    if (duetRun.error && duetRun.error.raw) {
      const d = el('details', 'dt-full');
      d.appendChild(el('summary', null, 'מה המודל החזיר בפועל'));
      d.appendChild(el('pre', null, duetRun.error.raw));
      box.appendChild(d);
    }
    box.appendChild(el('small', null, 'שום תור לא נבלע — "נסה שוב" מריץ את אותו תור מחדש.'));
    return box;
  }
  box.appendChild(el('b', null, 'הריצה הסתיימה · ' + (END_LABEL[duetRun.endKind] || 'הסתיימה')));
  if (duetRun.endReason) box.appendChild(el('p', null, duetRun.endReason));
  const acts = el('div', 'dt-end-acts');
  const copy = el('button', 'dt-go', 'העתק את התוצר הסופי');
  copy.onclick = async () => {
    const ok = await copyText(duetRun.artifact || '');
    copy.textContent = ok ? 'הועתק ✓' : 'ההעתקה נכשלה';
    setTimeout(() => { copy.textContent = 'העתק את התוצר הסופי'; }, 1500);
  };
  const save = el('button', 'dt-mini', 'שמור לקובץ');
  save.onclick = () => { duetViewV = 0; duetSaveFile(); };
  acts.appendChild(copy); acts.appendChild(save);
  box.appendChild(acts);
  box.appendChild(el('small', null, `${duetRun.version} גרסאות · ${(duetRun.history || []).length} תורות · ${fmtCost((duetRun.cost || {}).usd || 0)}`));
  return box;
}

function duetScrollLane() {
  const c = duetDom && duetDom.cards;
  if (!c) return;
  // נצמדים לתחתית רק כשכבר היינו שם — אחרת קריאה של תור ישן הייתה נקטעת
  if (c.scrollHeight - c.scrollTop - c.clientHeight < 160) requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

/* ---------- התור שמזרים ברגע זה ---------- */

const A_OPEN = '<<<ARTIFACT';
const A_CLOSE = 'ARTIFACT>>>';

/**
 * חילוץ התוצר מתוך תשובה שעדיין נכתבת. המגביל הסוגר מגיע בסוף, ולכן עד אז
 * מציגים את כל מה שאחרי הפותח — פחות זנב שהוא תחילת המגביל עצמו, כדי שלא
 * יבהב ‎ARTIF‎ בסוף הטקסט בכל תור.
 */
function liveArtifactOf(raw) {
  const i = raw.indexOf(A_OPEN);
  if (i < 0) return null;
  let t = raw.slice(i + A_OPEN.length).replace(/^[ \t]*\r?\n/, '');
  const c = t.lastIndexOf(A_CLOSE);
  if (c >= 0) return t.slice(0, c).replace(/\r?\n[ \t]*$/, '');
  for (let k = A_CLOSE.length - 1; k >= 4; k--) if (t.endsWith(A_CLOSE.slice(0, k))) return t.slice(0, t.length - k);
  return t;
}

function duetMountLive() {
  if (!duetDom || !duetLive) return;
  const cards = duetDom.cards;
  if (duetLive.role === 'S') {
    const strip = el('div', 'dt-sup dt-sup-live');
    strip.appendChild(el('span', 'spinner sm'));
    strip.appendChild(el('span', 'dt-sup-quiet', 'המפקח קורא את הגרסה…'));
    duetDom.liveCard = strip;
    duetDom.liveBody = null;
    cards.appendChild(strip);
    return;
  }
  const card = el('article', 'dt-turn dt-turn-' + duetLive.role + ' dt-live');
  const h = el('header', null);
  h.appendChild(roleBadge(duetLive.role));
  h.appendChild(el('b', null, ROLE_LABEL[duetLive.role] || duetLive.role));
  h.appendChild(el('span', 'dt-vtag', 'גרסה ' + duetLive.version));
  const mdl = el('span', 'dt-model');
  mdl.appendChild(brandMarkEl(duetLive.model, 14));
  mdl.appendChild(el('span', 'dt-model-name', duetLive.model ? modelShort(duetLive.model) : 'ברירת מחדל'));
  mdl.title = brandTitle(duetLive.model);
  h.appendChild(mdl);
  h.appendChild(el('span', 'dt-spacer'));
  h.appendChild(el('span', 'spinner sm'));
  card.appendChild(h);
  const body = el('pre', 'dt-stream');
  card.appendChild(body);
  cards.appendChild(card);
  duetDom.liveCard = card;
  duetDom.liveBody = body;
  duetPaintLive();
}

function duetPaintLive() {
  if (!duetDom || !duetLive || !duetDom.liveBody) return;
  // בכרטיס התור מוצג היומן והפתיחה בלבד: התוצר עצמו כבר מצויר למעלה, ואין
  // טעם להזרים אותו פעמיים על אותו מסך.
  const raw = duetLive.raw;
  const cut = raw.indexOf(A_OPEN);
  duetDom.liveBody.textContent = cut >= 0 ? raw.slice(0, cut).trimEnd() + '\n\n[התוצר נכתב למעלה…]' : raw;
  duetScrollLane();
}

/* ---------- מצב ופקדים ---------- */

function duetPaintStatus() {
  const st = duetRun.status;
  const w = duetDom.statusWrap;
  w.innerHTML = '';
  w.className = 'dt-state dt-state-' + st + (duetRun.pausing ? ' dt-pausing' : '');
  if (st === 'running') w.appendChild(el('span', 'spinner sm'));
  const label = el('b', null, st === 'running' && duetRun.pausing ? 'משהים בסוף התור' : (DUET_STATUS_LABEL[st] || st));
  w.appendChild(label);
  const bits = [];
  if (duetRun.version) bits.push('גרסה ' + duetRun.version);
  bits.push('תור ' + Math.min(duetRun.turn + 1, duetRun.maxTurns) + ' מתוך ' + duetRun.maxTurns);
  // המפקח לא כותב את התוצר, ולכן הוא גם לא "כותב" בשורת המצב
  if (duetRun.speaking) bits.push((duetRun.speaking === 'S' ? 'המפקח קורא' : 'כותב: ' + (ROLE_LABEL[duetRun.speaking] || duetRun.speaking)));
  if (st === 'paused' && duetRun.phase === 'supervisor') bits.push('ימשיך מהמפקח');
  if (duetRun.ceilingHit) bits.push('התוצר בתקרת הגודל');
  w.appendChild(el('small', null, bits.join(' · ')));

  const acts = duetDom.acts;
  acts.innerHTML = '';
  const btn = (cls, txt, fn, title) => { const b = el('button', cls, txt); b.onclick = fn; if (title) b.title = title; acts.appendChild(b); return b; };
  if (st === 'running' && duetRun.pausing) {
    // חלון הביניים: הבקשה נרשמה והתור הנוכחי עוד רץ. הכפתור מתחלף לביטול,
    // כדי שהיציאה מהמצב הזה תהיה במקום שבו נכנסת אליו.
    btn('dt-go', 'בטל השהיה', () => duetSend('duet_resume'));
    btn('dt-mini dt-danger', 'עצור עכשיו', () => duetSend('duet_stop'));
  } else if (st === 'running') {
    btn('dt-mini', 'השהה', () => duetSend('duet_pause'), 'ההשהיה נכנסת לתוקף בסוף התור הנוכחי, לפני הקריאה הבאה למודל');
    btn('dt-mini dt-danger', 'עצור עכשיו', () => duetSend('duet_stop'), 'קוטע את התור הפעיל ומסיים את הריצה');
  } else if (st === 'paused') {
    btn('dt-go', 'המשך', () => duetSend('duet_resume'));
    btn('dt-mini dt-danger', 'סיים', () => duetSend('duet_stop'));
  } else if (st === 'error') {
    btn('dt-go', 'נסה את התור שוב', () => duetSend('duet_retry'));
    btn('dt-mini dt-danger', 'סיים', () => duetSend('duet_stop'));
  }
  duetDom.noteRow.classList.toggle('hidden', !['running', 'paused'].includes(st));
  duetDom.ctl.classList.toggle('dt-ctl-idle', st === 'done');
}

/* ---------- פריימים מהשרת ---------- */

function onDuetFrame(m) {
  if (m.ev === 'state') { duetAdopt(m.run); return; }
  if (!duetRun && m.ev !== 'status') return;
  switch (m.ev) {
    case 'status':
      if (!duetRun) { duetRequestState(); return; }
      duetRun.status = m.status;
      duetRun.endReason = m.endReason || '';
      duetRun.error = m.error || null;
      duetRun.pausing = false;
      if (m.status !== 'running') { duetLive = null; duetRun.speaking = null; }
      if (duetDom) { duetPaintStatus(); duetPaintLane(); duetPaintArtifact(); }
      break;

    case 'turn_start':
      duetLive = { role: m.role, model: m.model, version: m.version, raw: '', artifact: null };
      duetRun.speaking = m.role;
      if (duetDom) { duetMountLive(); duetPaintStatus(); }
      break;

    case 'delta':
      if (!duetLive || duetLive.role !== m.role) return;
      duetLive.raw += m.text;
      if (duetLive.role !== 'S') {
        const a = liveArtifactOf(duetLive.raw);
        if (a != null) { duetLive.artifact = a; duetPaintArtifact(); }
        duetPaintLive();
      }
      break;

    case 'turn_end':
      duetRun.history.push(m.turn);
      duetRun.artifact = m.artifact;
      duetRun.version = m.turn.version;
      duetRun.versions.push({ v: m.turn.version, author: m.turn.speaker, model: m.turn.model, changelog: m.turn.changelog, ts: m.turn.ts, size: (m.artifact || '').length });
      duetVerCache.set(m.turn.version, m.artifact);
      duetLive = null;
      duetRun.speaking = null;
      if (duetDom) { duetPaintVersions(); duetPaintArtifact(); duetPaintLane(); duetPaintStatus(); }
      break;

    case 'supervisor':
      duetRun.supervisorNotes.push(m.note);
      if (typeof m.progress === 'number') duetRun.progress = m.progress;
      duetLive = null;
      duetRun.speaking = null;
      if (duetDom) { duetPaintLane(); duetPaintProgress(); duetPaintStatus(); }
      break;

    case 'user_note':
      duetRun.userNotes.push(m.note);
      if (duetDom) duetPaintLane();
      toast('ההערה תיכנס לתור הבא');
      break;

    case 'cost':
      duetRun.cost = m.cost;
      if (duetDom) duetPaintCost();
      break;

    case 'retry':
      toast('ניסיון שני אצל ' + (ROLE_LABEL[m.role] || m.role) + ' — ' + clamp(m.text, 90), true);
      break;

    case 'reformat':
      toast((ROLE_LABEL[m.role] || m.role) + ': התשובה לא הגיעה בפורמט — מבקשים שוב');
      break;

    case 'error':
      duetRun.status = 'error';
      duetRun.error = { role: m.role, text: m.text, raw: m.raw || null };
      duetLive = null; duetRun.speaking = null;
      if (duetDom) { duetPaintLane(); duetPaintStatus(); }
      toast('הריצה נעצרה: ' + clamp(m.text, 90), true);
      break;

    case 'finished':
      duetRun.status = 'done';
      duetRun.endKind = m.endKind;
      duetRun.endReason = m.reason || '';
      if (typeof m.progress === 'number') duetRun.progress = m.progress;
      duetLive = null; duetRun.speaking = null;
      if (duetDom) { duetPaintLane(); duetPaintStatus(); duetPaintProgress(); duetPaintArtifact(); }
      if (!document.hasFocus()) desktopNotify('הדואט הסתיים', clamp(m.reason || '', 60));
      break;

    case 'pausing':
      duetRun.pausing = true;
      if (duetDom) duetPaintStatus();
      toast('ההשהיה תיכנס לתוקף בסוף התור הנוכחי');
      break;

    case 'stopping':
      duetRun.stopping = true;
      if (duetDom) duetPaintStatus();
      break;
  }
}

/** תמונת מצב הגיעה לפני שהמסך היה מוכן — מבקשים סנכרון מלא מהשרת. */
function duetRequestState() { subscribeActive(true); }

/** אימוץ תמונת מצב מלאה מ-sync. זה מה שמחזיר ריצה שרצה אחרי רענון דף. */
function duetAdopt(snap) {
  duetSetupBusy = null;
  duetRun = snap;
  if (!duetRun) return;
  duetRun.history = duetRun.history || [];
  duetRun.versions = duetRun.versions || [];
  duetRun.supervisorNotes = duetRun.supervisorNotes || [];
  duetRun.userNotes = duetRun.userNotes || [];
  duetLive = null;
  duetViewV = 0;
  duetVerCache.clear();
  if (duetRun.artifact && duetRun.version) duetVerCache.set(duetRun.version, duetRun.artifact);
  const c = convById(snap.convId);
  if (c) c.mode = 'duet';
  if (activeId === snap.convId) renderConversation();
}

/** נקודת הכניסה מ-renderConversation. */
function renderDuet(conv, log) {
  duetDom = null;
  log.classList.add('duet');
  if (!duetRun || duetRun.convId !== conv.id) { renderDuetSetup(conv, log); return; }
  renderDuetRun(log);
}
