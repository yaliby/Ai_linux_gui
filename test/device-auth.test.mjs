/**
 * קישור מכשירים ואימותם (`lib/device-auth.js`).
 *   node test/device-auth.test.mjs
 *
 * זה מה שעומד בין הרשת הביתית לבין שליטה מלאה ב-Claude ובכלים שלו, ועד
 * עכשיו לא הייתה לו אף בדיקה — לא על חד-פעמיות הקוד, לא על תקרת הניחושים
 * ולא על פג התוקף. שלוש התכונות האלה הן היחידות שמונעות ממי שנמצא על אותה
 * רשת לקשר את עצמו, ולכן הן נבדקות כאן אחת-אחת.
 *
 * השעון מוזרק, ולכן פג-תוקף נבדק בלי להמתין עשר דקות.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const createDeviceAuth = require('../lib/device-auth.js');
const { normPair, prettyPair, PAIR_LEN, PAIR_ALPHABET, newPairCode } = createDeviceAuth;

const t = runner('קישור מכשירים ואימותם');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-auth-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

let clock = Date.now();
let n = 0;
let lastFile = '';
/** אחסון טרי לכל תרחיש, כדי ששום בדיקה לא תסמוך על קודמתה. */
function fresh() {
  lastFile = path.join(DIR, `devices-${++n}.json`);
  return createDeviceAuth({ file: lastFile, now: () => clock });
}

// ---------------------------------------------------------------------------
t.section('צורת הקוד');
{
  const c = newPairCode();
  t.eq('אורך קבוע', c.length, PAIR_LEN);
  t.ok('רק מהא״ב המצומצם', [...c].every((ch) => PAIR_ALPHABET.includes(ch)), c);
  // 0/O/1/I/L/U הוצאו במכוון: הקוד נאמר בקול ומוקלד ביד, לא רק נסרק
  t.ok('בלי תווים שמתבלבלים בקריאה', !/[01OILU]/.test(c), c);

  t.eq('נורמליזציה מנקה מקפים ורווחים', normPair(' ab4d-ef7h '), 'AB4DEF7H');
  t.eq('נורמליזציה של ריק', normPair(null), '');
  t.eq('תצוגה עם מקף', prettyPair('AB4DEF7H'), 'AB4D-EF7H');

  // אקראיות: 200 קודים ללא כפילות. לא הוכחה לאנטרופיה, אבל כן תופס
  // מחולל שנתקע על ערך אחד — כשל שקט שנראה תקין לגמרי מבחוץ.
  const seen = new Set(Array.from({ length: 200 }, () => newPairCode()));
  t.eq('200 קודים — כולם שונים', seen.size, 200);
}

// ---------------------------------------------------------------------------
t.section('הקוד חד-פעמי');
{
  const a = fresh();
  const { code } = a.issuePairCode('המחשב');
  const tok1 = a.consumePairCode(code, { name: 'טלפון' });
  t.ok('הראשון מקבל טוקן', !!tok1);
  // זה העיקר: קוד שנשלח בהודעה לא אמור לקשר מכשיר שני אחרי שנוצל
  t.eq('השני עם אותו קוד נדחה', a.consumePairCode(code, { name: 'פולש' }), null);
  t.eq('ונרשם מכשיר אחד בלבד', a.readDevices().length, 1);
}

// ---------------------------------------------------------------------------
/* מה שמגן על קוד בן 8 תווים אינו האורך שלו אלא התקרה הזו. בלעדיה אפשר
   לנסות בלולאה עד שמצליחים. */
t.section('תקרת ניחושים שורפת את הקוד');
{
  const a = fresh();
  const { code } = a.issuePairCode('המחשב');
  const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';

  for (let i = 1; i < a.PAIR_MAX_TRIES; i++) {
    t.ok(`ניסיון כושל ${i} נדחה והקוד עוד חי`, a.consumePairCode(wrong) === null && !!a.currentPairCode());
  }
  t.eq('הניסיון האחרון נדחה', a.consumePairCode(wrong), null);
  t.eq('והקוד נשרף', a.currentPairCode(), null);
  t.eq('גם הקוד הנכון כבר לא עובד', a.consumePairCode(code), null);
  t.eq('ולא נרשם אף מכשיר', a.readDevices().length, 0);
}

// ---------------------------------------------------------------------------
t.section('פג תוקף');
{
  const a = fresh();
  const { code } = a.issuePairCode('המחשב');
  clock += a.PAIR_TTL_MS - 1000;
  t.ok('רגע לפני — עוד חי', !!a.currentPairCode());
  clock += 2000;
  t.eq('רגע אחרי — פג', a.currentPairCode(), null);
  t.eq('וקוד שפג אינו מקשר', a.consumePairCode(code), null);
  t.eq('ולא נרשם מכשיר', a.readDevices().length, 0);
}

// ---------------------------------------------------------------------------
t.section('אימות מכשיר מול טוקן');
{
  const a = fresh();
  const { code } = a.issuePairCode('המחשב');
  const token = a.consumePairCode(code, { name: 'טלפון', ua: 'x'.repeat(500) });

  const d = a.findDevice(token);
  t.ok('הטוקן מזוהה', !!d);
  t.eq('עם השם שנמסר', d && d.name, 'טלפון');
  t.eq('ה-user-agent נחתך', d && d.ua.length, 200);
  t.eq('טוקן שגוי אינו מזוהה', a.findDevice('לא-הטוקן'), null);
  t.eq('טוקן ריק אינו מזוהה', a.findDevice(''), null);

  // הקובץ בדיסק אינו מפתח כניסה: רק ה-hash נשמר בו
  const raw = fs.readFileSync(lastFile, 'utf8');
  t.ok('הטוקן עצמו אינו על הדיסק', !raw.includes(token), raw.slice(0, 200));
  t.ok('רק ה-hash שלו', /"hash":\s*"[0-9a-f]{64}"/.test(raw));

  clock += a.DEVICE_TTL_MS + 1000;
  t.eq('טוקן שפג תוקפו אינו מזוהה', a.findDevice(token), null);
}

// ---------------------------------------------------------------------------
t.section('ניתוק מכשיר');
{
  const a = fresh();
  const { code } = a.issuePairCode('המחשב');
  const token = a.consumePairCode(code, { name: 'טלפון' });
  const id = a.findDevice(token).id;

  t.eq('ניתוק מזהה שאינו קיים מדווח false', a.removeDevice('אין-כזה'), false);
  t.eq('ניתוק מחזיר true', a.removeDevice(id), true);
  t.eq('והטוקן כבר לא מזוהה', a.findDevice(token), null);
}

// ---------------------------------------------------------------------------
t.section('קלט חריג לא מקשר ולא מפיל');
{
  const a = fresh();
  a.issuePairCode('המחשב');
  for (const bad of [null, undefined, '', '   ', '---', 'A', 'A'.repeat(200), 123, {}, []]) {
    let threw = false, tok = 'לא-רץ';
    try { tok = a.consumePairCode(bad); } catch { threw = true; }
    t.ok(`${JSON.stringify(bad)} → לא זורק ולא מקשר`, !threw && tok === null);
  }
  t.eq('ולא נרשם אף מכשיר', a.readDevices().length, 0);
}

// ---------------------------------------------------------------------------
t.section('עוגייה');
{
  const a = fresh();
  const c = a.cookieFor('rtl_device', 'abc/def+gh=');
  t.ok('הערך מקודד', c.includes(encodeURIComponent('abc/def+gh=')), c);
  t.ok('HttpOnly', /HttpOnly/.test(c));
  t.ok('SameSite=Lax', /SameSite=Lax/.test(c));
  t.ok('Max-Age בשניות ולא במילישניות', c.includes('Max-Age=' + Math.floor(a.DEVICE_TTL_MS / 1000)), c);
}

t.done();
