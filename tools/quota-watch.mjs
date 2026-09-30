#!/usr/bin/env node
/**
 * מד־מכסה לחלון החמש־שעתי.   node tools/quota-watch.mjs
 *
 * הסוכן שעובד על המאגר הזה צורך את אותה מכסה שהאפליקציה עצמה מציגה במסך.
 * במקום לנחש כמה נשאר, הוא שואל את השרת החי שכבר יודע: /api/usage מחזיר את
 * אחוז הניצול של חלון הסשן ואת השעה שבה הוא מתאפס. הכלי הזה עוטף את זה
 * בפסיקה אחת קריאה — להמשיך, לסגור קצוות, או לעצור ולחזור אחרי האיפוס.
 *
 * למה לא לפנות ישירות ל-api.anthropic.com: אותו endpoint מוגבל בקצב, והשרת
 * כבר מחזיק מטמון עם backoff וגיבוי לדיסק. פנייה דרכו נותנת תשובה גם כשהמקור
 * עונה 429, ולא שורפת ניסיון על כל תקתוק של הסוכן.
 *
 * יציאה:  0 = אפשר להמשיך · 10 = לסגור קצוות · 20 = לעצור עד האיפוס
 */
import https from 'node:https';
import http from 'node:http';

const BASE = process.env.RTL_BASE || 'https://127.0.0.1:4173';
// ספי החלטה. WRAP הוא "אל תתחיל משימה חדשה", PAUSE הוא "עצור עכשיו".
// הפער ביניהם מכוון: צריך מספיק מכסה כדי *לסיים* מה שכבר התחיל — commit,
// הרצת בדיקות, כתיבת הסיכום — ולא להיקטע באמצע עריכה.
const WRAP_PCT = Number(process.env.RTL_WRAP_PCT || 80);
const PAUSE_PCT = Number(process.env.RTL_PAUSE_PCT || 92);

function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('תשובה לא־JSON מ-' + url)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
  });
}

const pad = (n) => String(n).padStart(2, '0');
function fmtLeft(ms) {
  if (!(ms > 0)) return 'עכשיו';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}ש ${pad(m % 60)}ד` : `${m}ד`;
}
function bar(pct, width = 24) {
  const on = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(on) + '░'.repeat(width - on);
}

const u = await get(BASE + '/api/usage').catch((e) => {
  // בלי נתון אין החלטה — וברירת המחדל הבטוחה היא *לא* לעצור עבודה בגלל
  // תקלת רשת מקומית. הסוכן יראה את השגיאה וימשיך בזהירות.
  console.error('quota: ' + e.message + ' (השרת על ' + BASE + ' לא ענה)');
  process.exit(0);
});

const fh = u.five_hour || null;
if (!fh || typeof fh.pct !== 'number') {
  console.error('quota: אין נתון לחלון החמש־שעתי');
  process.exit(0);
}

const resetMs = fh.resets_at ? Date.parse(fh.resets_at) - Date.now() : NaN;
const verdict = fh.pct >= PAUSE_PCT ? 'PAUSE' : fh.pct >= WRAP_PCT ? 'WRAP_UP' : 'CONTINUE';
const week = u.seven_day;

console.log(`חלון 5ש   ${bar(fh.pct)} ${String(fh.pct).padStart(3)}%   איפוס בעוד ${fmtLeft(resetMs)}`);
if (week && typeof week.pct === 'number') {
  console.log(`שבועי      ${bar(week.pct)} ${String(week.pct).padStart(3)}%   איפוס בעוד ${fmtLeft(Date.parse(week.resets_at) - Date.now())}`);
}
for (const w of u.windows || []) {
  if (w.kind !== 'weekly_scoped') continue;
  console.log(`  ${w.label.padEnd(9)}${bar(w.pct)} ${String(w.pct).padStart(3)}%`);
}
console.log(`\nVERDICT=${verdict}  PCT=${fh.pct}  RESET_IN_SEC=${Math.max(0, Math.round(resetMs / 1000)) || 0}  RESET_AT=${fh.resets_at || ''}`);

process.exit(verdict === 'PAUSE' ? 20 : verdict === 'WRAP_UP' ? 10 : 0);
