/**
 * טיוטה בין שני מכשירים — שני "דפדפנים" מול אותו ערוץ סנכרון.
 *
 * הבאג שהבדיקה הזו נולדה ממנו: אחרי שליחה, הטקסט נמחק מהתיבה כאן — אבל
 * השידור שאמר למכשיר השני "התיבה ריקה" מעולם לא יצא. השמה ל-‎value‎ אינה
 * מייצרת אירוע ‎input‎, ולכן ה-debounce לא נורה, ו-‎stashDraft‎ ממילא יוצא
 * מוקדם כשהטיוטה כבר אופסה. התוצאה: הטלפון נשאר עם ההודעה *ששלחת* בתיבה,
 * ומאחר שטיוטה מרחוק נכנסת רק לשדה ריק — היא נשארת שם עד שמוחקים ביד.
 */
import { makeEnv, slice, runner } from './harness.mjs';

const t = runner('סנכרון טיוטה בין מכשירים');

/** מכשיר = סביבה משלו + החלקים האמיתיים מ-app.js שמטפלים בטיוטה. */
function device(name, bus) {
  const env = makeEnv();
  const conv = { id: 'c1', draft: '', loaded: true, messages: [], title: 'שיחה' };
  globalThis.store.convs = [conv];
  globalThis.activeId = 'c1';
  globalThis.activeConv = () => conv;
  globalThis.convById = (id) => (id === conv.id ? conv : null);
  globalThis.markDirty = () => { env.dirty = (env.dirty || 0) + 1; };
  globalThis.debounce = (fn) => fn;                      // בלי השהיה בבדיקה
  globalThis.ws = { readyState: 1, OPEN: 1, send: (s) => bus.push({ from: name, msg: JSON.parse(s) }) };
  globalThis.subId = 'sub-' + name;
  globalThis.renderConvList = () => {};
  globalThis.updateStatusbar = () => {};
  globalThis.markSettings = () => {};
  globalThis.markGodPill = () => {};
  globalThis.updateEfforts = () => {};
  globalThis.syncConvCwd = () => {};
  globalThis.UI_FIELDS = {};

  const api = new Function(`
    ${slice('function sendUi(field, value) {', '/** רשימת השיחות מתעדכנת')}
    ${slice('function stashDraft() {', '/** תיקיית העבודה נזכרת')}
    return { stashDraft, restoreDraft, clearComposer, applyRemoteUi, sendUi };
  `)();

  const d = {
    name, env, conv, api,
    get box() { return env.els.input.value; },
    type(s) { env.setText(s); api.stashDraft(); },
    // מה שמגיע מהמכשיר השני
    receive(msg) { if (msg.type === 'ui') api.applyRemoteUi({ ...msg, convId: 'c1' }); },
    activate() {   // מחזיר את הגלובלים של המכשיר הזה לקדמת הבמה
      globalThis.$ = (id) => env.els[id] || (id === 'input' ? env.els.input : null);
      globalThis.autoGrow = env.api.autoGrow;
      globalThis.activeConv = () => conv;
      globalThis.convById = (id) => (id === conv.id ? conv : null);
      globalThis.markDirty = () => { env.dirty = (env.dirty || 0) + 1; };
      globalThis.ws = { readyState: 1, OPEN: 1, send: (s) => bus.push({ from: name, msg: JSON.parse(s) }) };
    },
  };
  return d;
}

// שני מכשירים חיים בו-זמנית באותו תהליך; `activate` מחליף בין הגלובלים
const bus = [];
const a = device('מחשב', bus);
const b = device('טלפון', bus);

/** מעביר הודעות שממתינות בערוץ אל המכשיר השני. */
function deliver() {
  while (bus.length) {
    const { from, msg } = bus.shift();
    const target = from === 'מחשב' ? b : a;
    target.activate();
    target.receive(msg);
  }
}

// ---------------------------------------------------------------------------
t.section('טיוטה עוברת למכשיר השני');
{
  a.activate();
  a.type('התחלתי לכתוב במחשב');
  deliver();
  t.eq('הטלפון קיבל', b.box, 'התחלתי לכתוב במחשב');
  t.eq('ונשמר גם על השיחה', b.conv.draft, 'התחלתי לכתוב במחשב');
}

t.section('המשך הקלדה ממשיך להתעדכן, לא קופא על המילה הראשונה');
{
  a.activate();
  a.type('התחלתי לכתוב במחשב ועוד');
  deliver();
  t.eq('הטלפון מראה את הגרסה העדכנית', b.box, 'התחלתי לכתוב במחשב ועוד');
}

t.section('טיוטה לא דורסת טקסט שמוקלד באותו רגע');
{
  b.activate();
  b.env.setText('מה שאני כותב בטלפון');
  a.activate();
  a.type('משהו אחר במחשב');
  deliver();
  t.eq('התיבה המלאה לא נדרסה', b.box, 'מה שאני כותב בטלפון');
  t.eq('אבל הטיוטה השמורה כן התעדכנה', b.conv.draft, 'משהו אחר במחשב');
}

t.section('אחרי שליחה — התיבה בצד השני מתנקה');
{
  // מצב פתיחה: אותו טקסט בשני המכשירים
  b.activate(); b.env.setText('');
  a.activate(); a.type('ההודעה שאשלח');
  deliver();
  t.eq('הטלפון מראה את הטיוטה', b.box, 'ההודעה שאשלח');

  a.activate();
  a.api.clearComposer();                 // זה מה שקורה בסוף sendMessage
  t.eq('התיבה במחשב התנקתה', a.box, '');
  t.eq('והטיוטה על השיחה', a.conv.draft, '');
  deliver();
  t.eq('והטלפון כבר לא מציג את מה שנשלח', b.box, '');
  t.eq('גם לא בטיוטה השמורה', b.conv.draft, '');
}

t.section('ניקוי תיבה שכבר ריקה לא מפיל כלום');
{
  a.activate();
  a.api.clearComposer();
  deliver();
  t.eq('נשאר ריק', b.box, '');
}

t.section('טיוטה חוזרת כשנכנסים לשיחה');
{
  a.activate();
  a.type('טיוטה שנשמרה');
  a.env.setText('');                     // כאילו עברנו לשיחה אחרת וחזרנו
  a.api.restoreDraft();
  t.eq('הטיוטה שוחזרה מהשיחה', a.box, 'טיוטה שנשמרה');
}

t.done();
