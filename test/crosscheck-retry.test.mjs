/**
 * הקרוס־צ'ק — מה קורה כשהבדיקה *עצמה* נכשלת.
 *   node test/crosscheck-retry.test.mjs
 *
 * הקרוס־צ'ק קיים בשביל תקלה אחת: ‎socket‎ חצי-פתוח בטלפון אחרי יציאה מ-sleep
 * או מעבר Wi-Fi↔סלולר. ‎readyState‎ נשאר ‎OPEN‎, ‎onclose‎ לא נורה, ואף פריים
 * לא מגיע — ולכן ההתחברות-מחדש הרגילה לא מופעלת לעולם.
 *
 * הבדיקה נורית בדיוק ברגע ההוא (‎visibilitychange‎ / ‎online‎), כלומר כשהרדיו
 * עדיין לא עלה. ביומן אמיתי של המכשיר: 26 כשלי ‎resume‎ ו-5 של ‎online‎. עד
 * לתיקון, כישלון כזה הדפיס «השרת לא מגיב» וסיים — והלולאה האוטומטית בודקת רק
 * כש-‎busy‎. כלומר בדיוק בתרחיש שהמנגנון נבנה בשבילו, המנגנון ויתר.
 *
 * הקוד נטען כפרוסה מ-‎public/app.js‎ ורץ מול שעון וירטואלי ו-‎fetch‎ מבוקר, כדי
 * שמה שנבדק יהיה הקוד עצמו ולא שכפול שלו.
 */
import { slice } from './harness.mjs';
import { runner } from './harness.mjs';

const t = runner('קרוס־צ׳ק: בדיקה שנכשלה מנסה שוב');

/* ---------- שעון וירטואלי ---------- */
function makeClock() {
  let now = 1_000_000, seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending() { return timers.size; },
    /** מקדם את השעון ומריץ כל טיימר שהגיע זמנו, לפי סדר. */
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= until && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await new Promise((r) => setImmediate(r));   // נותן ל-await שבתוך הקוד להתקדם
      }
      now = until;
      await new Promise((r) => setImmediate(r));
    },
  };
}

/**
 * בונה מופע חי של הקרוס־צ'ק מתוך ‎app.js‎.
 * ‎fetchImpl‎ — מה ‎/api/turn-state‎ יחזיר; זריקה = הרשת נפלה.
 */
function build({ fetchImpl, wsState = 1, busy0 = false }) {
  const clock = makeClock();
  const calls = { dlog: [], toast: [], status: [], connect: 0, subscribe: [], abandon: 0, fetches: [] };

  // ‎reconnectNow‎, ‎resync‎, ‎renderStale‎ ו-‎staleFor‎ נמצאים בתוך הפרוסה עצמה
  // ורצים כמות שהם — מה שמוזרק כאן הוא רק מה שיושב *מחוצה* לה.
  const prelude = `
    const Date = { now: () => clock.now };
    const setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
    const clearTimeout = (id) => clock.clearTimeout(id);
    const document = { body: { classList: { toggle() {} } } };
    const addEventListener = () => {};
    const $ = () => null;
    let busy = ${busy0};
    let subId = 'c1', activeId = 'c1', streamOwnerId = null, subSeq = 5;
    let live = true;
    let ws = { readyState: ${wsState}, OPEN: 1, close() { this.readyState = 3; } };
    const pendingPerms = new Set();
    const dlog = (tag, data) => calls.dlog.push({ tag, data });
    const toast = (msg, err) => calls.toast.push({ msg, err });
    const setStatus = (cls, title) => calls.status.push({ cls, title });
    const renderWorking = () => {};
    const wsConnected = () => !!(ws && ws.readyState === 1);
    const connect = () => { calls.connect++; };
    const subscribeActive = (force) => calls.subscribe.push({ force: !!force, subSeq });
    const onRemoteBusy = (v) => { busy = !!v; };
    const abandonTurn = () => { calls.abandon++; busy = false; };
    const reconcileFromDisk = async () => null;
    const reconcileFromSession = async () => null;
    const endAnon = () => {};
    const anonOpenIds = () => [];
    const fetch = (url, opts) => { calls.fetches.push(url); return fetchImpl(url, opts, calls.fetches.length); };
  `;

  const body = slice('let lastFrameAt = Date.now();', '// מנוע הבדיקה');

  const make = new Function('clock', 'calls', 'fetchImpl', 'AbortController',
    prelude + '\n' + body + '\nreturn { crossCheck, cancelCheckRetry, peek: () => ({ busy, wsOpen: wsConnected(), subSeq }) };');

  const api = make(clock, calls, fetchImpl, AbortController);
  // ‎reconnectNow‎ מסתיים ב-‎connect()‎, ולכן מספר הקריאות אליו הוא מספר האתחולים
  Object.defineProperty(calls, 'reconnect', { get: () => calls.connect });
  Object.defineProperty(calls, 'resync', { get: () => calls.subscribe });
  return { clock, calls, api };
}

const okState = (over = {}) => ({
  ok: true,
  json: async () => ({ known: true, running: false, alive: true, seq: 5, oldestSeq: 1, subs: 1, ...over }),
});
const netDown = () => { throw new Error('Failed to fetch'); };
const aborted = () => { const e = new Error('signal is aborted without reason'); throw e; };

// ---------------------------------------------------------------------------
/* הליבה: כישלון אחד אינו סוף הסיפור. */
t.section('כישלון מזמן ניסיון חוזר');
{
  const { clock, calls, api } = build({ fetchImpl: netDown });

  await api.crossCheck('resume');
  t.eq('הבדיקה יצאה פעם אחת', calls.fetches.length, 1);
  t.eq('ונרשם כישלון', calls.dlog.filter((d) => d.tag === 'check.fail').length, 1);
  t.eq('והפסיל מדווח', calls.status.at(-1).title, 'השרת לא מגיב');
  t.ok('ויש ניסיון מתוזמן', clock.pending() > 0, clock.pending());

  await clock.advance(1600);
  t.eq('אחרי 1.5 שנ׳ — ניסיון שני', calls.fetches.length, 2);
  await clock.advance(4100);
  t.eq('ואחריו שלישי', calls.fetches.length, 3);
  await clock.advance(10100);
  t.eq('ורביעי', calls.fetches.length, 4);

  // שלושה ניסיונות ודי: מחשב שבאמת כבוי לא זוכה לתשאול אינסופי.
  await clock.advance(60000);
  t.eq('ואז נעצרים', calls.fetches.length, 4);
  t.eq('בלי טיימרים תלויים', clock.pending(), 0);

  // הניסיונות אינם «ידניים», ולכן אינם מקפיצים toast על כל אחד מהם
  t.eq('בלי מטר toast', calls.toast.length, 0);
}

// ---------------------------------------------------------------------------
t.section('ניסיון שהצליח סוגר את הסולם');
{
  let fail = true;
  const { clock, calls, api } = build({ fetchImpl: (u, o, n) => (fail && n === 1 ? netDown() : okState()) });

  await api.crossCheck('online');
  t.eq('הראשון נכשל', calls.fetches.length, 1);

  fail = false;
  await clock.advance(1600);
  t.eq('השני יצא', calls.fetches.length, 2);
  t.eq('והצליח', calls.dlog.filter((d) => d.tag === 'check.done').length, 1);

  await clock.advance(60000);
  t.eq('ואין ניסיון שלישי', calls.fetches.length, 2);
  t.eq('ולא נשאר טיימר', clock.pending(), 0);
}

// ---------------------------------------------------------------------------
/* בלי זה הפסיל היה נשאר על «השרת לא מגיב» גם אחרי שהכול חזר לעבוד: הכיתוב
   משתנה רק ב-‎onopen/onclose/onerror‎, וב-socket חצי-פתוח אף אחד מהם לא נורה. */
t.section('בדיקה שהצליחה מחזירה את הפסיל למצב תקין');
{
  let n = 0;
  const { clock, calls, api } = build({ fetchImpl: () => (++n === 1 ? netDown() : okState()) });

  await api.crossCheck('resume');
  t.eq('אחרי הכישלון', calls.status.at(-1).title, 'השרת לא מגיב');

  await clock.advance(1600);
  t.eq('אחרי ההצלחה', calls.status.at(-1).title, 'מחובר');
  t.eq('והמחלקה נכונה', calls.status.at(-1).cls, 'on');
}

// ---------------------------------------------------------------------------
/* כשהבדיקה סוגרת בעצמה את ה-socket, ההתחברות-מחדש היא הבעלים של הכיתוב —
   ולכתוב «מחובר» מעליה היה שקר עד שה-‎onopen‎ באמת קורה. */
t.section('בדיקה שאתחלה את החיבור לא מכריזה «מחובר»');
{
  const { calls, api } = build({ fetchImpl: () => okState({ subs: 0 }), wsState: 1 });
  await api.crossCheck('resume');
  t.eq('החיבור אותחל', calls.reconnect, 1);
  t.eq('ולא נטען שהוא מחובר', calls.status.filter((s) => s.title === 'מחובר').length, 0);
}

// ---------------------------------------------------------------------------
t.section('טריגר חדש פותח סולם חדש');
{
  const { clock, calls, api } = build({ fetchImpl: netDown });

  await api.crossCheck('resume');
  await clock.advance(1600);
  await clock.advance(4100);
  t.eq('שני ניסיונות נצרכו', calls.fetches.length, 3);

  // המשתמש חזר למסך שוב — זו אינה המשך של הסולם הקודם אלא אירוע חדש
  await api.crossCheck('online');
  t.eq('בדיקה חדשה יצאה', calls.fetches.length, 4);
  await clock.advance(1600);
  t.eq('והסולם התחיל מחדש', calls.fetches.length, 5);
  await clock.advance(4100);
  t.eq('צעד שני של הסולם החדש', calls.fetches.length, 6);
  await clock.advance(10100);
  t.eq('ושלישי', calls.fetches.length, 7);
  await clock.advance(60000);
  t.eq('ואז נעצר', calls.fetches.length, 7);
}

// ---------------------------------------------------------------------------
t.section('בדיקה ידנית: toast פעם אחת בלבד');
{
  const { clock, calls, api } = build({ fetchImpl: aborted });

  await api.crossCheck('manual');
  t.eq('השגיאה הוצגה', calls.toast.length, 1);
  t.ok('ובנוסח הנכון', calls.toast[0].msg.startsWith('השרת לא מגיב'), calls.toast[0].msg);
  t.eq('כשגיאה', calls.toast[0].err, true);

  await clock.advance(1600);
  await clock.advance(4100);
  await clock.advance(10100);
  t.eq('הניסיונות רצו', calls.fetches.length, 4);
  t.eq('אבל ה-toast לא חזר', calls.toast.length, 1);
}

// ---------------------------------------------------------------------------
/* התיקונים הרגילים חייבים להמשיך לעבוד — הסולם נוסף לצידם ולא במקומם. */
t.section('סולם הניסיונות לא שבר את התיקונים הקיימים');
{
  {
    const { calls, api } = build({ fetchImpl: () => okState({ running: true }), busy0: false });
    await api.crossCheck('auto');
    t.eq('תור פעיל בשרת מסומן', api.peek().busy, true);
    t.eq('ונרשם', calls.dlog.find((d) => d.tag === 'check.done').data.fixed, ['התור מסומן כפעיל']);
  }
  {
    const { calls, api } = build({ fetchImpl: () => okState({ known: false }), busy0: true });
    await api.crossCheck('auto');
    t.eq('שיחה שאינה בשרת משחררת את המסך', calls.abandon, 1);
  }
  {
    // תור שעדיין רץ בשרת ואנחנו מפגרים אחריו: השלמה מהיומן, בלי טעינה מהדיסק
    const { calls, api } = build({ fetchImpl: () => okState({ running: true, seq: 99 }), busy0: true });
    await api.crossCheck('auto');
    t.eq('פער בפריימים מושלם מהיומן', calls.resync.length, 1);
    t.eq('והמנוי נשאר על אותו מקום', api.peek().subSeq, 5);
  }
  {
    // הפער גדול מהיומן ששמור בשרת — רק טעינה מלאה תסגור אותו
    const { calls, api } = build({ fetchImpl: () => okState({ running: true, seq: 99, oldestSeq: 50 }), busy0: true });
    await api.crossCheck('auto');
    t.eq('פער שמעבר ליומן', calls.resync.length, 1);
    t.eq('גורר טעינה מלאה מאפס', api.peek().subSeq, 0);
  }
  {
    // התור הסתיים בשרת בזמן שהמסך עוד מציג «עובד»
    const { calls, api } = build({ fetchImpl: () => okState({ seq: 99 }), busy0: true });
    await api.crossCheck('auto');
    const fixed = calls.dlog.find((d) => d.tag === 'check.done').data.fixed;
    t.eq('שני התיקונים נרשמים', fixed, ['הושלמו עדכונים שהוחמצו', 'התור כבר הסתיים בשרת']);
  }
  {
    const { calls, api } = build({ fetchImpl: () => okState(), wsState: 3 });
    await api.crossCheck('auto');
    t.eq('socket סגור → התחברות מחדש', calls.reconnect, 1);
  }
}

t.done();
