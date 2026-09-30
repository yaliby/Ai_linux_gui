'use strict';
/* ==========================================================================
   שכבת האחסון של השיחות
   --------------------------------------------------------------------------
   עד כה כל שמירה שילמה את מלוא מחיר השיחה, סינכרונית, על ה-event loop:
   ‎PUT /api/conversations/:id‎ קרא את הקובץ כולו ופענח אותו, ואז סידר וכתב
   אותו כולו בחזרה. במדידה על השיחה הגדולה שכאן (756KB) זה ‎1.6ms‎ פענוח +
   ‎3.8ms‎ סריאליזציה + ‎1.8ms‎ כתיבה — כ-7ms שבהם התהליך *אינו עושה דבר אחר*,
   כל 2.5 שניות לאורך כל תור.

   הצד השני של אותו גבול כבר תוקן: הלקוח עבר לשמירה חלקית (‎fromIndex‎), והערה
   מפורשת ב-app.js מסבירה למה — "עלות שגדלה ליניארית עם אורך השיחה ומשולמת
   עשרות פעמים בתור". האופטימיזציה פשוט נעצרה בגבול הרשת ולא חצתה אותו.

   ולמה זה חשוב מעבר למילישניות: בזמן שה-event loop חסום, כל הזרמת ה-WebSocket
   של *כל* המנויים עומדת. זה בדיוק המנגנון שבשבילו נבנו ‎WS_HIGH_WATER‎,
   ‎sweepLag‎ ו-‎replayLog‎ — ועצירה קצרה שחוזרת כל 2.5 שניות נראית לו כמו בדיוק
   מה שהוא בא למדוד: סוקט שלא מתנקז.

   מה שהמודול הזה משנה, בלי לגעת בחתימה ש-server.js ו-duet.js כבר קוראים:

     • הפענוח נעלם מהמסלול החם. ‎writeConv‎ מזין את המטמון באובייקט שהוא כתב,
       ולכן ה-‎readConv‎ הבא — זה שפותח את השמירה הבאה — לא נוגע בדיסק בכלל.
       מטמון קר מאומת מול ‎mtime+size‎, כך שעריכה חיצונית של קובץ עדיין נקראת.

     • הכתיבה יורדת מה-event loop ומתאחדת. שמירה שמגיעה בזמן שכתיבה באוויר
       *מחליפה* את הממתינה במקום להצטרף לתור: מה שמעניין הוא המצב האחרון,
       ולכן לכל שיחה יש לכל היותר כתיבה אחת ממתינה, ולא תור שמתארך.

     • האטומיות נעשית אמיתית. ‎tmp + rename‎ לבדו אינו מבטיח את מה שההערה
       הישנה הבטיחה: בלי ‎fsync‎ על הקובץ הזמני לפני ה-rename, קריסת מערכת
       יכולה להשאיר קובץ שהשם שלו התחלף אבל התוכן שלו עדיין לא הגיע לדיסק.
       כאן יש fsync על הקובץ, ואחרי ה-rename גם על התיקייה.

   מה שאסינכרוניות הייתה עלולה לשבור, ונסגר במפורש:

     • ‎writeConv‎ מחזיר הבטחה שנפתרת כשהערך על הדיסק, והמסלולים ב-server.js
       ממתינים לה לפני שהם עונים ‎ok‎. "אסינכרוני" כאן אינו "בלי אישור" — הוא
       רק אומר שבזמן ההמתנה ה-event loop פנוי להזרים לשאר המכשירים. הלקוח
       משלם על כך כמה מילישניות בשמירת רקע מושהית, שאיש אינו מרגיש.

     • כתיבה שנכשלה *נזרקת* אל הקורא במקום להיבלע. בגרסה הסינכרונית שגיאת
       דיסק הפילה את המסלול והחזירה 500, והלקוח ניסה שוב; שמירה שנכשלת בשקט
       אחרי שהובטח עליה ‎ok‎ הייתה אובדן נתונים שקט.

     • ‎readConv‎ מחזיר תמיד את הערך החדש ביותר — גם כשהוא עדיין בדרך לדיסק —
       כך שאף קורא לא רואה מצב ישן ממה שנכתב. ו-‎listIds‎ מאחד את מה שבדיסק
       עם מה שממתין, אחרת שיחה שנוצרה הרגע הייתה נעדרת מהאינדקס עד הנחיתה.

     • ‎flushSync‎ מנקז הכול ביציאת התהליך, כרשת ביטחון אחרונה.

   חוזה לקוראים: האובייקט שחוזר מ-‎readConv‎ הוא *קריאה בלבד*. הוא משותף עם
   המטמון, ומי שישנה אותו ישנה את מה שכל השאר יראו. אותו חוזה חל הפוך על
   ‎writeConv‎: האובייקט שנמסר לו נשמר, ואסור שימשיך להשתנות אחריו.
   ========================================================================== */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * dir   — תיקיית קובצי השיחות.
 * guard — נקרא לפני כל כתיבה; זורק כדי לחסום מזהה שאסור שיגיע לדיסק.
 * dbg   — שורת יומן.
 */
module.exports = function createConvStore({ dir, guard, dbg = () => {} }) {
  const pathOf = (id) => path.join(dir, id + '.json');

  // מה שנקרא מהדיסק ואומת מולו: id → { conv, mtimeMs, size }
  const cached = new Map();
  // מה שנכתב וטרם אושר על הדיסק. קיים רק בין writeConv לנחיתה, והוא האמת
  // העליונה לקריאה — קורא לעולם לא יראה מצב ישן ממה שכבר נשמר.
  const desired = new Map();
  // מה שעוד לא יצא לדיסק. שמירה נוספת דורסת אותו: המצב האחרון הוא הקובע.
  const queued = new Map();
  const writing = new Set();
  // מי מחכה לאישור שהכתיבה נחתה: id → [{resolve, reject}]. שמירה שנדרסה על-ידי
  // שמירה חדשה יותר נפתרת יחד איתה — הנתונים שלה הוחלפו, לא אבדו.
  const waiters = new Map();
  // שיחות שנמחקו בזמן שכתיבה שלהן כבר הייתה באוויר. מחיקה אינה יכולה פשוט
  // למחוק את הקובץ הזמני מתחת לרגליה של כתיבה רצה — ה-rename היה נכשל — ולכן
  // היא מסמנת, והכתיבה היא שמנקה אחריה כשהיא מגיעה לסופה.
  const gone = new Set();
  // מונה גרסה לכל שיחה, כדי שמטמונים נגזרים (תקציר לאינדקס) ידעו להתיישן
  // בלי להסתמך על mtime — שמפגר אחרי כתיבה אסינכרונית.
  const stamps = new Map();
  let tick = 0;
  let closed = false;

  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { dbg('store.mkdir.fail', { err: String(e.message || e) }); }

  // ---------- כתיבה אטומית ----------

  async function writeAtomic(p, json) {
    const tmp = p + '.tmp';
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(json);
      await fh.sync();            // התוכן על הדיסק לפני שהשם מצביע עליו
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, p);
    // גם ה-rename עצמו צריך להגיע לדיסק, אחרת אחרי קריסה הקובץ הישן חוזר
    try { const d = await fsp.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } } catch {}
  }

  function writeAtomicSync(p, json) {
    const tmp = p + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
  }

  function settle(id, err) {
    const list = waiters.get(id);
    if (!list) return;
    waiters.delete(id);
    for (const w of list) { if (err) w.reject(err); else w.resolve(); }
  }

  function land(id, conv, st) {
    cached.set(id, { conv, mtimeMs: st.mtimeMs, size: st.size });
    // הערך נחת. הוא נשאר "רצוי" רק אם בינתיים נכתב מעליו ערך חדש יותר.
    if (!queued.has(id) && desired.get(id) === conv) desired.delete(id);
  }

  function pump(id) {
    if (writing.has(id) || closed) return;
    writing.add(id);
    (async () => {
      try {
        while (queued.has(id) && !closed) {
          const conv = queued.get(id);
          queued.delete(id);
          if (gone.has(id)) break;              // נמחקה לפני שהספקנו לכתוב
          const p = pathOf(id);
          await writeAtomic(p, JSON.stringify(conv));
          // נמחקה *בזמן* הכתיבה: המחיקה לא נגעה בקובץ הזמני כדי לא להפיל את
          // ה-rename, ולכן הניקוי נופל כאן — אחרי שהכתיבה סיימה.
          if (gone.has(id)) { try { await fsp.unlink(p); } catch {} break; }
          land(id, conv, await fsp.stat(p));
          // רק מי שהמתין *עד* הנחיתה הזו משוחרר. שמירה שנכנסה לתור בזמן
          // הכתיבה תמתין לסיבוב הבא, שבו הנתונים שלה באמת יגיעו לדיסק.
          if (!queued.has(id)) settle(id, null);
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        dbg('store.write.fail', { convId: id, err: err.message });
        queued.delete(id);
        settle(id, err);       // הקורא יחזיר 500, והלקוח ינסה שוב
      } finally {
        writing.delete(id);
        if (queued.has(id) && !closed) pump(id);
      }
    })();
  }

  // ---------- ה-API שהשרת ו-duet קוראים ----------

  /** השיחה כאובייקט, או null. קריאה בלבד — ראו החוזה בראש הקובץ. */
  function readConv(id) {
    const live = desired.get(id);
    if (live !== undefined) return live;

    const p = pathOf(id);
    let st;
    try { st = fs.statSync(p); } catch { cached.delete(id); stamps.delete(id); return null; }

    const hit = cached.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.conv;

    try {
      const conv = JSON.parse(fs.readFileSync(p, 'utf8'));
      cached.set(id, { conv, mtimeMs: st.mtimeMs, size: st.size });
      stamps.set(id, ++tick);     // הקובץ השתנה מתחתינו — כל תקציר נגזר התיישן
      return conv;
    } catch { cached.delete(id); return null; }
  }

  /**
   * שומר את השיחה. ההבטחה נפתרת כשהערך על הדיסק ונדחית אם הכתיבה נכשלה.
   * הקריאה עצמה אינה חוסמת: בזמן ההמתנה ה-event loop פנוי להזרים לשאר.
   */
  function writeConv(conv) {
    const id = conv && conv.id;
    if (guard) guard(conv);           // זורק סינכרונית — לפני שנוצרה כל הבטחה
    gone.delete(id);                  // שיחה שנמחקה ונכתבת שוב חוזרת לחיים
    desired.set(id, conv);
    queued.set(id, conv);
    stamps.set(id, ++tick);
    const done = new Promise((resolve, reject) => {
      if (!waiters.has(id)) waiters.set(id, []);
      waiters.get(id).push({ resolve, reject });
    });
    // קורא שלא ממתין לתוצאה הוא מקרה לגיטימי (‎duet‎ שומר ברקע). בלי המאזין
    // הריק הזה דחייה אצלו הייתה יוצאת כ-unhandledRejection ומפילה את התהליך,
    // במקום להיבלע אצלו. מי שכן ממתין מקבל את הדחייה כרגיל.
    done.catch(() => {});
    pump(id);
    return done;
  }

  /** מזהי כל השיחות — כולל אחת שנוצרה הרגע וטרם הגיעה לדיסק. */
  function listIds() {
    const ids = new Set(desired.keys());
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) ids.add(f.slice(0, -5));
    } catch {}
    return [...ids];
  }

  function remove(id) {
    queued.delete(id);
    desired.delete(id);
    cached.delete(id);
    stamps.delete(id);
    gone.add(id);
    // מי שהמתין לכתיבה שנמחקה לא נכשל — פשוט אין יותר למה לחכות.
    settle(id, null);
    try { fs.unlinkSync(pathOf(id)); } catch {}
    // הקובץ הזמני נשאר במתכוון: כתיבה שנמצאת עכשיו באמצע תסתמך עליו ל-rename,
    // והיא זו שתנקה אחריה כשתראה את הסימון.
  }

  /** אסימון גרסה: משתנה בכל שינוי תוכן. מטמון נגזר נשען עליו במקום על mtime. */
  function stamp(id) {
    if (!stamps.has(id)) readConv(id);     // קריאה ראשונה מולידה את האסימון
    return stamps.get(id) || 0;
  }

  /**
   * ניקוז סינכרוני — ליציאת התהליך.
   * הלקוח קיבל ok על כתיבה שעוד לא נחתה, ולכן יציאה בלי ניקוז הייתה מאבדת
   * בדיוק את מה שהובטח לו. ‎closed‎ עוצר את הלולאה הא-סינכרונית לפני שהיא
   * מספיקה לכתוב ערך ישן מעל מה שנכתוב כאן.
   */
  function flushSync() {
    closed = true;
    const ids = new Set([...queued.keys(), ...desired.keys()]);
    let n = 0;
    for (const id of ids) {
      const conv = queued.get(id) || desired.get(id);
      if (!conv) continue;
      try { writeAtomicSync(pathOf(id), JSON.stringify(conv)); n++; settle(id, null); } catch (e) {
        dbg('store.flush.fail', { convId: id, err: String((e && e.message) || e) });
        settle(id, e instanceof Error ? e : new Error(String(e)));
      }
    }
    queued.clear();
    // ‎closed‎ עצר את הלולאה הא-סינכרונית; מי שעוד המתין לה לא יקבל תשובה משם.
    for (const id of [...waiters.keys()]) settle(id, null);
    return n;
  }

  /** ממתין לניקוז כל הכתיבות — לבדיקות, שרוצות לראות את הדיסק. */
  async function drain() {
    while (queued.size || writing.size) await new Promise((r) => setTimeout(r, 2));
  }

  return { readConv, writeConv, listIds, remove, stamp, flushSync, drain, pathOf };
};
