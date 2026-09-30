/**
 * בדיקת האחסון בשרת מקצה לקצה — שרת אמיתי, קבצים אמיתיים, בקשות אמיתיות.
 *   node test/server-store.test.mjs
 *
 * השרת עולה עם ‎HOME‎ זמני, ולכן כל מה שהוא כותב נופל לתיקייה שנמחקת בסוף
 * ולא נוגע בשיחות האמיתיות. הפורט אינו 4173 מאותה סיבה, והתהליך נהרג לפי
 * ה-PID שהבדיקה עצמה הרימה.
 *
 * מה שנבדק כאן הוא בדיוק מה שאי אפשר לבדוק בלי שרת: בדיקת הגרסה (‎baseRev‎)
 * שמונעת ממכשיר מנותק לדרוס תמליל חדש, הכתיבה החלקית (‎fromIndex‎) שמריצה
 * את רוב השמירות בזמן תור, והחסימות — מזהה לא חוקי, נתיב שמנסה לצאת
 * מהתיקייה, ושיחה אנונימית שאסור שתיגע בדיסק.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runner } from './harness.mjs';

const PORT = Number(process.env.SIM_PORT || 4891);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-sim-home-'));
// השרת מרים HTTPS עם תעודה חתומה-עצמית (certs/). הבדיקה מדברת אליו
// באותו ערוץ שהדפדפן מדבר, ולכן היא מכבה רק כאן את אימות התעודה.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// אזהרת Node על ביטול אימות התעודה היא נכונה — וגם צפויה כאן, כי התעודה
// המקומית חתומה-עצמית. משתיקים אותה כדי שדוח הבדיקה יישאר קריא.
const _warn = process.emitWarning;
process.emitWarning = (w, ...r) => { if (!String(w).includes('NODE_TLS_REJECT_UNAUTHORIZED')) _warn.call(process, w, ...r); };
const scheme = fs.existsSync(new URL('../certs/cert.pem', import.meta.url).pathname) ? 'https' : 'http';
const BASE = `${scheme}://127.0.0.1:${PORT}`;
const ROOT = new URL('..', import.meta.url).pathname;

const t = runner('שרת האחסון (שרת אמיתי על HOME זמני)');

const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOME,
    PORT: String(PORT),
    REMOTE_PORT: String(PORT + 1),
    // בלי ספקים חיצוניים: הבדיקה לא אמורה לגעת ברשת
    OMNIROUTE_BASE_URL: '', LOCAL_BASE_URL: '', CCR_GATEWAY_URL: '', CURSOR_SESSION_TOKEN: '',
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
process.on('exit', cleanup);                     // רשת ביטחון אם הבדיקה נפלה

/** סגירה מסודרת: קודם ממתינים שהתהליך ימות, ורק אז מוחקים את הבית הזמני —
 *  אחרת הוא כותב את שורות היומן האחרונות שלו לתיקייה שהרגע נמחקה, ויוצר
 *  אותה מחדש. */
async function finish() {
  try { process.kill(srv.pid); } catch {}
  await Promise.race([
    new Promise((r) => srv.once('exit', r)),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  // השרת מריץ תהליכי עזר (למשל `cursor-agent --list-models`), והם עלולים
  // לכתוב לבית הזמני רגע אחרי שהוא מת. מחיקה שנייה סוגרת את הזנב הזה.
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
}

const j = async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

// --- המתנה לעלייה
let up = false;
for (let k = 0; k < 100 && !up; k++) {
  try { const r = await fetch(BASE + '/api/store'); up = r.ok; } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
if (!up) { console.error('השרת לא עלה:\n' + srvOut); cleanup(); process.exit(1); }

const CONV_DIR = path.join(HOME, '.claude', 'rtl-claude', 'conversations');
const conv = (over = {}) => ({
  id: 'sim1', title: 'שיחת בדיקה', cwd: '/tmp', draft: '',
  messages: [{ role: 'user', text: 'שלום לך' }, { role: 'assistant', blocks: [{ type: 'text', text: 'שלום גם לך' }] }],
  ...over,
});

// ---------------------------------------------------------------------------
t.section('עלייה נקייה');
{
  const { data } = await j('GET', '/api/store');
  t.eq('מתחילים בלי שיחות', data.conversations.length, 0);
  t.eq('תיקיית האחסון היא הזמנית', data.dir, CONV_DIR);
  t.ok('לא נגע בבית האמיתי', !fs.existsSync(path.join(os.homedir(), '.claude', 'rtl-claude', 'conversations', 'sim1.json')));
}

// ---------------------------------------------------------------------------
t.section('כתיבה, קריאה, ובדיקת גרסה');
{
  let r = await j('PUT', '/api/conversations/sim1', conv());
  t.eq('נשמרה', r.status, 200);
  t.eq('גרסה 1', r.data.rev, 1);
  t.eq('התקציר בלי גוף ההודעות', r.data.meta.messages, undefined);
  t.eq('אבל עם מונה', r.data.meta.msgCount, 2);

  r = await j('GET', '/api/conversations/sim1');
  t.eq('נקראת חזרה', r.data.conversation.messages.length, 2);
  t.eq('הטקסט שרד', r.data.conversation.messages[0].text, 'שלום לך');

  // מכשיר שהיה מנותק ומחזיק גרסה ישנה
  r = await j('PUT', '/api/conversations/sim1', conv({ baseRev: 0, title: 'ישן' }));
  t.eq('גרסה ישנה נדחית', r.status, 409);
  t.eq('ונאמר למה', r.data.error, 'stale');
  t.eq('ומוחזרת הגרסה שבדיסק', r.data.rev, 1);
  r = await j('GET', '/api/conversations/sim1');
  t.eq('הכותרת לא נדרסה', r.data.conversation.title, 'שיחת בדיקה');

  r = await j('PUT', '/api/conversations/sim1', conv({ baseRev: 1, title: 'מעודכן' }));
  t.eq('גרסה נכונה עוברת', r.status, 200);
  t.eq('גרסה 2', r.data.rev, 2);
}

// ---------------------------------------------------------------------------
t.section('כתיבה חלקית (fromIndex) — מה שרץ בזמן תור חי');
{
  const tail = { role: 'assistant', blocks: [{ type: 'text', text: 'תשובה שנייה' }] };
  let r = await j('PUT', '/api/conversations/sim1', { ...conv(), baseRev: 2, fromIndex: 2, messages: [tail] });
  t.eq('נכתבה', r.status, 200);
  r = await j('GET', '/api/conversations/sim1');
  t.eq('הקידומת נשארה והזנב נוסף', r.data.conversation.messages.length, 3);
  t.eq('הראשונה במקומה', r.data.conversation.messages[0].text, 'שלום לך');
  t.eq('האחרונה היא החדשה', r.data.conversation.messages[2].blocks[0].text, 'תשובה שנייה');

  // fromIndex גדול ממה שיש בדיסק = חוסר התאמה, לא התנגשות
  r = await j('PUT', '/api/conversations/sim1', { ...conv(), baseRev: 3, fromIndex: 99, messages: [tail] });
  t.eq('פער מזוהה', r.status, 409);
  t.eq('ומבקש שמירה מלאה', r.data.needFull, true);
  r = await j('GET', '/api/conversations/sim1');
  t.eq('השיחה לא נפגעה', r.data.conversation.messages.length, 3);
}

// ---------------------------------------------------------------------------
t.section('גבולות וקלט זדוני');
{
  let r = await j('PUT', '/api/conversations/..%2F..%2Fetc%2Fpasswd', conv({ id: '../../etc/passwd' }));
  t.eq('נתיב שמנסה לצאת מהתיקייה נחסם', r.status, 400);
  r = await j('GET', '/api/conversations/' + encodeURIComponent('a/b'));
  t.ok('גם בקריאה', r.status === 400 || r.status === 404, r.status);

  r = await j('PUT', '/api/conversations/sim1', { messages: 'לא מערך', baseRev: 3 });
  t.eq('גוף שגוי לא מפיל', r.status, 200);
  r = await j('GET', '/api/conversations/sim1');
  t.eq('הודעות לא-תקינות נזרקות', r.data.conversation.messages.length, 0);

  // גזימת פלט ענק של כלי
  const huge = 'x'.repeat(80000);
  r = await j('PUT', '/api/conversations/sim2', {
    id: 'sim2', title: 'ענק',
    messages: [{ role: 'assistant', blocks: [{ type: 'tool', id: 'a', name: 'Bash', result: huge }] }],
  });
  t.eq('נשמרה', r.status, 200);
  r = await j('GET', '/api/conversations/sim2');
  const kept = r.data.conversation.messages[0].blocks[0].result;
  t.ok('הפלט נגזם', kept.length < 30000, kept.length);
  t.ok('ונאמר שנגזם', /נחתכו/.test(kept));
}

// ---------------------------------------------------------------------------
t.section('שיחה אנונימית לא נוגעת בדיסק');
{
  let r = await j('PUT', '/api/conversations/anon-abc123', { id: 'anon-abc123', title: 'סוד', messages: [] });
  t.eq('כתיבה נדחית', r.status, 403);
  r = await j('GET', '/api/conversations/anon-abc123');
  t.eq('אין מה לקרוא', r.status, 404);
  r = await j('POST', '/api/flush', { conversations: [{ id: 'anon-abc123', title: 'סוד', messages: [] }] });
  t.eq('גם ה-beacon של סגירת החלון', r.status, 200);
  t.eq('ולא נוצר קובץ', fs.readdirSync(CONV_DIR).filter((f) => f.startsWith('anon-')).length, 0);

  r = await j('PUT', '/api/settings', { settings: { model: 'x' }, history: ['היי'], activeId: 'anon-abc123' });
  t.eq('נשמר', r.status, 200);
  r = await j('GET', '/api/store');
  t.eq('activeId אנונימי לא נשמר', r.data.activeId, null);
  t.eq('שאר ההגדרות כן', r.data.settings.model, 'x');
}

// ---------------------------------------------------------------------------
t.section('חיפוש בגוף שיחות שלא נטענו');
{
  await j('PUT', '/api/conversations/sim3', {
    id: 'sim3', title: 'מדריך',
    messages: [{ role: 'user', text: 'איך מגדירים את מכסת Cursor במערכת' }],
  });
  let r = await j('GET', '/api/search?q=' + encodeURIComponent('מכסת Cursor'));
  t.eq('נמצא', r.data.results.length, 1);
  t.eq('השיחה הנכונה', r.data.results[0].id, 'sim3');
  t.ok('עם קטע הקשר', /מכסת/.test(r.data.results[0].snippet), r.data.results[0].snippet);

  r = await j('GET', '/api/search?q=' + encodeURIComponent('מילה שאין'));
  t.eq('אין תוצאות מדומות', r.data.results.length, 0);

  // מטמון החיפוש לפי חתימת קובץ — שינוי בשיחה חייב להיתפס
  const cur = (await j('GET', '/api/conversations/sim3')).data.conversation;
  await j('PUT', '/api/conversations/sim3', { ...cur, baseRev: cur.rev, messages: [{ role: 'user', text: 'טקסט אחר לגמרי' }] });
  r = await j('GET', '/api/search?q=' + encodeURIComponent('מכסת Cursor'));
  t.eq('הישן כבר לא נמצא', r.data.results.length, 0);
  r = await j('GET', '/api/search?q=' + encodeURIComponent('אחר לגמרי'));
  t.eq('והחדש כן', r.data.results.length, 1);
}

// ---------------------------------------------------------------------------
t.section('מחיקה, ואטומיות הכתיבה');
{
  let r = await j('DELETE', '/api/conversations/sim2');
  t.eq('נמחקה', r.status, 200);
  r = await j('GET', '/api/store');
  t.ok('נעלמה מהאינדקס', !r.data.conversations.some((c) => c.id === 'sim2'));
  t.eq('אין שאריות tmp', fs.readdirSync(CONV_DIR).filter((f) => f.includes('.tmp')).length, 0);
  t.ok('הקבצים הם JSON תקין', fs.readdirSync(CONV_DIR).every((f) => {
    try { JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8')); return true; } catch { return false; }
  }));
}

// ---------------------------------------------------------------------------
t.section('בדיקת תיקייה (השדה בהגדרות)');
{
  let r = await j('GET', '/api/check-dir?path=' + encodeURIComponent(HOME));
  t.eq('תיקייה קיימת', r.data.ok, true);
  r = await j('GET', '/api/check-dir?path=' + encodeURIComponent(path.join(HOME, 'אין-כזו')));
  t.eq('תיקייה שאינה קיימת', r.data.ok, false);
  r = await j('GET', '/api/check-dir?path=~');
  t.eq('טילדה מתורגמת לבית', r.data.path, HOME);
  r = await j('GET', '/api/check-dir?path=' + encodeURIComponent(ROOT + 'package.json'));
  t.eq('קובץ אינו תיקייה', r.data.ok, false);
}

// ---------------------------------------------------------------------------
t.section('יומן הריצה');
{
  const r = await j('POST', '/api/client-log', { rows: [{ at: '10:00:00.123', tag: 'sim.hello', data: { a: 1 } }] });
  t.eq('נכתב', r.status, 200);
  const text = await (await fetch(BASE + '/api/logs?grep=' + encodeURIComponent('sim\\.hello'))).text();
  t.ok('חוזר בסינון', /sim\.hello/.test(text), text.slice(0, 300));
  t.ok('עם השעה שהמכשיר דיווח', /10:00:00\.123/.test(text), text.slice(0, 300));
  const other = await (await fetch(BASE + '/api/logs?grep=' + encodeURIComponent('אין-כזה-תג'))).text();
  t.eq('סינון שלא תואם מחזיר ריק', other.trim(), '');
  const bad = await fetch(BASE + '/api/logs?grep=' + encodeURIComponent('[unclosed'));
  t.eq('ביטוי רגולרי שבור לא מפיל את המסך', bad.status, 200);
}

// ---------------------------------------------------------------------------
/* תקלה שחוזרת בלולאה כתבה את עצמה ליומן בלי סוף: ביומן אמיתי כאן 60% מהשורות
   היו שורה אחת — ספק מקומי שכתובתו כבר לא קיימת. מכיוון שהיומן מסתובב ב-4MB,
   זה לא רעש אלא מחיקה של מה שהיומן נועד לשמר. */
t.section('שורה שחוזרת מתקפלת ולא מציפה את היומן');
{
  const rows = Array.from({ length: 50 }, () => ({ tag: 'sim.repeat', data: { why: 'EHOSTUNREACH' } }));
  await j('POST', '/api/client-log', { rows });
  const text = await (await fetch(BASE + '/api/logs?n=5000')).text();

  const lines = text.split('\n').filter((l) => l.includes('sim.repeat'));
  t.eq('נכתבה פעם אחת ולא חמישים', lines.length, 1);
  t.ok('והסיכום אומר כמה נבלעו', /↑ חזר עוד 49 פעמים/.test(text), text.slice(-400));

  // הקיפול מבוסס על זהות, ולכן חייב להישבר כשהתוכן באמת משתנה — אחרת
  // הוא היה מסתיר תקלה חדשה שבמקרה הגיעה אחרי תקלה חוזרת.
  await j('POST', '/api/client-log', { rows: [{ tag: 'sim.repeat', data: { why: 'ECONNREFUSED' } }] });
  const after = await (await fetch(BASE + '/api/logs?n=5000')).text();
  t.ok('סיבה אחרת נכתבת בנפרד', /ECONNREFUSED/.test(after), after.slice(-400));
}

// ---------------------------------------------------------------------------
/* מחזור קוד הקישור דרך HTTP אמיתי. הלוגיקה עצמה נבדקת לעומק ב-
   device-auth.test.mjs; מה שנבדק כאן הוא דווקא החיווט — שהמסלולים בשרת
   באמת מדברים עם המודול שחולץ, ולא נשארו מחוברים למשתנה שכבר אינו קיים. */
t.section('קוד קישור דרך המסלולים בשרת');
{
  let r = await j('GET', '/api/remote/status');
  t.eq('מצב נענה', r.status, 200);
  t.eq('מתחילים בלי קוד פתוח', r.data.pairCode, null);

  r = await j('POST', '/api/remote/pair', {});
  // מחשב בלי כתובת LAN מחזיר 503 — זה מצב לגיטימי ולא כשל של החיווט
  if (r.status === 503) {
    t.ok('אין LAN על המכונה הזו — מדלגים', true, r.data);
  } else {
    t.eq('הונפק קוד', r.status, 200);
    t.ok('בצורת XXXX-XXXX', /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(r.data.pairCode || ''), r.data.pairCode);
    t.ok('בלי תווים שמתבלבלים בקריאה', !/[01OILU]/.test(r.data.pairCode || ''), r.data.pairCode);
    t.ok('עם שעת תפוגה בעתיד', r.data.pairExpiresAt > Date.now(), r.data.pairExpiresAt);

    const shown = (await j('GET', '/api/remote/status')).data;
    t.eq('והוא נראה גם בבקשת מצב', shown.pairCode, r.data.pairCode);

    r = await j('POST', '/api/remote/cancel-pair', {});
    t.eq('ביטול נענה', r.status, 200);
    t.eq('והקוד נעלם', r.data.pairCode, null);
  }
}

// ---------------------------------------------------------------------------
t.section('הקליפה מוגשת');
{
  for (const [url, re] of [['/', /<html/i], ['/app.js', /function/], ['/style.css', /composer/], ['/sw.js', /CACHE/]]) {
    const r = await fetch(BASE + url);
    const body = await r.text();
    t.ok(`${url} מוגש`, r.ok && re.test(body), r.status);
  }
  const mani = await (await fetch(BASE + '/manifest.webmanifest')).json();
  t.ok('מניפסט תקין', !!mani.name && Array.isArray(mani.icons) && mani.icons.length > 0);
}

t.section('סיכום');
t.ok('השרת לא כתב שגיאות חריגות', !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(srvOut), srvOut.slice(-600));

await finish();
t.done();
