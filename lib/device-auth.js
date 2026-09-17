'use strict';
/* ==========================================================================
   קישור מכשירים ואימותם
   --------------------------------------------------------------------------
   כל מה שעומד בין הרשת הביתית לבין שליטה מלאה ב-Claude ובכלים שלו נמצא כאן:
   הנפקת קוד הקישור, צריכתו, הנפקת הטוקן הקבוע, וההכרעה אם בקשה נכנסת שייכת
   למכשיר מוכר. זו הייתה יחידה אבטחתית שפוזרה בתוך מונוליט של כמעט 3,900
   שורות ולא הייתה לה אף בדיקה — לא על תקרת הניחושים, לא על פג התוקף, ולא על
   החד-פעמיות של הקוד. היא יושבת כאן בנפרד בדיוק כדי שאפשר יהיה לבדוק אותה.

   שלוש התכונות שהמודול הזה קיים כדי לשמור, וכל אחת מהן נבדקת ב-
   ‎test/device-auth.test.mjs‎:

     • **הקוד חד-פעמי.** צריכה מוצלחת מאפסת אותו מיד, כך שאותו קוד שנשלח
       בהודעה אינו מקשר מכשיר שני אחריו.
     • **תקרת ניסיונות.** קוד בן 8 תווים מא״ב בן 30 (≈39 ביט) קצר מספיק
       להכתבה בטלפון; מה שמונע ניחוש בלולאה הוא לא האורך אלא ‎PAIR_MAX_TRIES‎,
       ששורף את הקוד אחרי עשרה כישלונות.
     • **השוואה בזמן קבוע.** ‎timingSafeEqual‎ ולא ‎===‎, כדי שזמן התשובה לא
       ידלוף כמה תווים מתחילת הקוד נוחשו נכון.

   ובדיסק נשמר רק ה-hash של הטוקן: הקובץ עצמו אינו מפתח כניסה.
   ========================================================================== */
const fs = require('node:fs');
const crypto = require('node:crypto');

const PAIR_TTL_MS = 10 * 60 * 1000;                 // תוקף קוד הקישור עצמו
const PAIR_MAX_TRIES = 10;                          // ניחושים כושלים עד שריפה
const DEVICE_TTL_MS = 365 * 24 * 3600 * 1000;

/* הקוד נועד גם להיאמר בקול או להיות מוקלד ביד, ולא רק להיסרק מ-QR: א״ב בן 30
   בלי ‎0/O/1/I/L/U‎ שמתבלבלים בקריאה. */
const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_LEN = 8;

/** מה שהוקלד → הצורה הקנונית: בלי מקפים ורווחים, אותיות גדולות. */
const normPair = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Z]/g, '');
/** הצורה שמוצגת לעין ולהכתבה: XXXX-XXXX. */
const prettyPair = (c) => c.slice(0, 4) + '-' + c.slice(4);

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

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/**
 * file — קובץ המכשירים.
 * now  — שעון מוזרק; הבדיקות מקדמות אותו כדי לבחון פג-תוקף בלי להמתין.
 */
module.exports = function createDeviceAuth({ file, now = Date.now } = {}) {
  let pairCode = null;   // { code, expiresAt, tries, by } — חי בזיכרון בלבד

  // ---------- הדיסק ----------

  function readDevices() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(j.devices) ? j.devices : [];
    } catch { return []; }
  }

  function writeDevices(devices) {
    const tmp = file + '.tmp';
    // ‎0o600‎: רשימת המכשירים היא רשימת מי שיכול להיכנס, ואין סיבה שמשתמש
    // אחר על אותה מכונה יוכל לקרוא אותה.
    fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ---------- אימות מכשיר ----------

  /** המכשיר שהטוקן הזה שייך לו, או null. טוקן שפג אינו מזוהה. */
  function findDevice(token) {
    if (!token) return null;
    const h = hashToken(token);
    const t = now();
    for (const d of readDevices()) {
      if (!d.hash || d.hash.length !== h.length) continue;
      if (!crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(h))) continue;
      if (d.expiresAt && d.expiresAt < t) return null;
      return d;
    }
    return null;
  }

  /** נגיעה עצלה: "נראה לאחרונה" מתעדכן לכל היותר פעם בשעה, לא בכל בקשה. */
  function touchDevice(id) {
    const devices = readDevices();
    const d = devices.find((x) => x.id === id);
    if (!d) return;
    const t = now();
    if (d.lastSeen && t - d.lastSeen < 3600 * 1000) return;
    d.lastSeen = t;
    try { writeDevices(devices); } catch {}
  }

  function removeDevice(id) {
    const before = readDevices();
    const after = before.filter((d) => d.id !== id);
    if (after.length === before.length) return false;
    writeDevices(after);   // זורק — הקורא מדווח למשתמש
    return true;
  }

  // ---------- קוד הקישור ----------

  function issuePairCode(by) {
    pairCode = { code: newPairCode(), expiresAt: now() + PAIR_TTL_MS, tries: 0, by: by || null };
    return pairCode;
  }

  /** הקוד הפתוח, או null. קוד שפג תוקפו נחשב כאילו אינו קיים. */
  function currentPairCode() {
    if (pairCode && pairCode.expiresAt <= now()) pairCode = null;
    return pairCode;
  }

  function clearPairCode() { pairCode = null; }

  /**
   * ממש קוד קישור: מנפיק טוקן קבוע ורושם את המכשיר, או מחזיר null אם הקוד
   * שגוי או פג. הקוד חד-פעמי, ותקרת הניסיונות שורפת אותו — בלעדיה קוד קצר
   * מספיק כדי להכתיב בטלפון היה גם מספיק קצר כדי לתקוף אותו בלולאה.
   */
  function consumePairCode(code, { name = 'מכשיר', ua = '' } = {}) {
    const given = normPair(code);
    if (!given || !currentPairCode()) return null;

    const want = Buffer.from(pairCode.code);
    const got = Buffer.from(given);
    // אורך שונה נפסל לפני ההשוואה — ‎timingSafeEqual‎ זורק על אורכים שונים.
    // זה אינו דולף דבר: אורך הקוד ידוע ממילא וקבוע.
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      if (++pairCode.tries >= PAIR_MAX_TRIES) pairCode = null;
      return null;
    }

    const by = pairCode.by;
    pairCode = null;   // חד-פעמי — לפני הכתיבה, כדי שכישלון כתיבה לא ישאיר קוד חי
    const token = crypto.randomBytes(32).toString('base64url');
    const devices = readDevices();
    devices.push({
      id: crypto.randomBytes(6).toString('hex'),
      name,
      ua: String(ua).slice(0, 200),
      hash: hashToken(token),
      pairedBy: by,
      createdAt: now(), lastSeen: now(),
      expiresAt: now() + DEVICE_TTL_MS,
    });
    writeDevices(devices);   // זורק — הקורא מדווח למשתמש
    return token;
  }

  const cookieFor = (cookieName, token) =>
    `${cookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(DEVICE_TTL_MS / 1000)}; HttpOnly; SameSite=Lax`;

  return {
    readDevices, writeDevices, findDevice, touchDevice, removeDevice,
    issuePairCode, currentPairCode, clearPairCode, consumePairCode,
    cookieFor,
    PAIR_TTL_MS, PAIR_MAX_TRIES, DEVICE_TTL_MS,
  };
};

module.exports.normPair = normPair;
module.exports.prettyPair = prettyPair;
module.exports.hashToken = hashToken;
module.exports.newPairCode = newPairCode;
module.exports.PAIR_ALPHABET = PAIR_ALPHABET;
module.exports.PAIR_LEN = PAIR_LEN;
