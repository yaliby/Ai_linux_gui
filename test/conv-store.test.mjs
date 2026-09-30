/**
 * שכבת האחסון (`lib/conv-store.js`) — מטמון, איחוד כתיבות, ואטומיות.
 *   node test/conv-store.test.mjs
 *
 * מה שנבדק כאן הוא בדיוק מה שהמודול הבטיח כשהוחלף בו קוד סינכרוני שעבד:
 * שהקורא לעולם לא רואה מצב ישן ממה שנכתב, שכישלון כתיבה מגיע אל מי שביקש
 * אותה במקום להיבלע, ושהמטמון באמת חוסך את הפענוח — הסיבה היחידה שבגללה
 * המודול נכתב מלכתחילה.
 *
 * הכול רץ מול תיקייה זמנית שנמחקת בסוף. אין כאן שרת ואין רשת.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const createConvStore = require('../lib/conv-store.js');

const t = runner('אחסון השיחות');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-store-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const logs = [];
const store = createConvStore({
  dir: DIR,
  guard: (c) => { if (String(c && c.id).startsWith('anon-')) throw new Error('anon conversation must never reach disk'); },
  dbg: (tag, data) => logs.push({ tag, data }),
});

const conv = (id, over = {}) => ({
  id, title: 'שיחה', rev: 1, messages: [{ role: 'user', text: 'שלום' }], ...over,
});
const onDisk = (id) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8')); } catch { return null; } };

// ---------------------------------------------------------------------------
t.section('הלוך ושוב');
{
  await store.writeConv(conv('a', { title: 'ראשונה' }));
  t.eq('נכתבה לדיסק', onDisk('a').title, 'ראשונה');
  t.eq('ונקראת בחזרה', store.readConv('a').title, 'ראשונה');
  t.eq('מזהה שאינו קיים מחזיר null', store.readConv('אין-כזה'), null);
  t.eq('אין שאריות tmp', fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp')).length, 0);
}

// ---------------------------------------------------------------------------
/* הסיבה שבגללה המודול קיים: המסלול החם קורא ואז כותב, וכל שמירה בזמן תור
   שילמה פענוח מלא של התמליל. אחרי הכתיבה הערך כבר בזיכרון, ולכן הקריאה
   שפותחת את השמירה הבאה לא אמורה לגעת ב-JSON בכלל. */
t.section('הקריאה שאחרי כתיבה לא מפענחת מחדש');
{
  const big = conv('big', {
    messages: Array.from({ length: 400 }, (_, i) => ({ role: 'user', text: 'מ'.repeat(900) + i })),
  });
  await store.writeConv(big);

  const raw = fs.readFileSync(path.join(DIR, 'big.json'), 'utf8');
  t.ok('התמליל אכן גדול', raw.length > 300000, raw.length);

  const N = 200;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) store.readConv('big');
  const cachedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) JSON.parse(raw);
  const parseMs = Number(process.hrtime.bigint() - t0) / 1e6;

  t.ok('הקריאה מהמטמון מהירה בסדר גודל מהפענוח', parseMs / cachedMs > 20, { cachedMs, parseMs });
  t.ok('ומחזירה את אותו אובייקט עצמו', store.readConv('big') === store.readConv('big'));
}

// ---------------------------------------------------------------------------
/* מטמון שלא יודע להתיישן גרוע מאין מטמון. עריכה חיצונית של הקובץ חייבת
   להיקרא — אחרת שיחה שתוקנה מחוץ לאפליקציה תמשיך להופיע כפי שהייתה. */
t.section('שינוי חיצוני של הקובץ נקרא מחדש');
{
  await store.writeConv(conv('ext', { title: 'לפני' }));
  t.eq('לפני', store.readConv('ext').title, 'לפני');
  // מילישנייה, כדי ש-mtime באמת יזוז גם במערכות עם רזולוציה גסה
  await new Promise((r) => setTimeout(r, 12));
  fs.writeFileSync(path.join(DIR, 'ext.json'), JSON.stringify(conv('ext', { title: 'אחרי' })));
  t.eq('אחרי עריכה חיצונית', store.readConv('ext').title, 'אחרי');
}

// ---------------------------------------------------------------------------
/* שמירה בזמן תור מגיעה שוב ושוב, ומה שמעניין הוא המצב האחרון. הבדיקה כאן
   היא על התוצאה שחייבת להתקיים תמיד: אחרי שהכול נרגע, בדיסק יושבת הגרסה
   האחרונה — לא אחת מהביניים, וגם לא תערובת. */
t.section('כתיבות רצופות מתאחדות והאחרונה מנצחת');
{
  const done = [];
  for (let i = 1; i <= 40; i++) done.push(store.writeConv(conv('race', { rev: i, title: 'גרסה ' + i })));
  t.eq('בזמן שהן באוויר, הקריאה כבר רואה את האחרונה', store.readConv('race').title, 'גרסה 40');
  await Promise.all(done);
  await store.drain();
  t.eq('ובדיסק יושבת האחרונה', onDisk('race').title, 'גרסה 40');
  t.eq('כל הממתינים שוחררו', done.length, 40);
  t.eq('בלי שאריות tmp', fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp')).length, 0);
}

// ---------------------------------------------------------------------------
t.section('האינדקס כולל שיחה שטרם נחתה');
{
  const p = store.writeConv(conv('fresh'));
  t.ok('מופיעה מיד ברשימה', store.listIds().includes('fresh'));
  t.ok('ונקראת מיד', !!store.readConv('fresh'));
  await p;
  t.ok('וגם אחרי הנחיתה', store.listIds().includes('fresh') && !!onDisk('fresh'));
}

// ---------------------------------------------------------------------------
/* מחיקה שלא מבטלת כתיבה ממתינה הייתה מחזירה את השיחה לחיים רגע אחריה. */
t.section('מחיקה מבטלת גם כתיבה שממתינה');
{
  store.writeConv(conv('gone', { title: 'למחיקה' }));
  store.remove('gone');
  await store.drain();
  await new Promise((r) => setTimeout(r, 30));
  t.eq('לא קמה לתחייה', onDisk('gone'), null);
  t.eq('ויצאה מהרשימה', store.listIds().includes('gone'), false);
  t.eq('וגם מהקריאה', store.readConv('gone'), null);
}

// ---------------------------------------------------------------------------
t.section('אסימון הגרסה');
{
  await store.writeConv(conv('st', { title: 'א' }));
  const s1 = store.stamp('st');
  t.eq('יציב כשאין שינוי', store.stamp('st'), s1);
  await store.writeConv(conv('st', { title: 'ב' }));
  t.ok('זז אחרי כתיבה', store.stamp('st') !== s1);
}

// ---------------------------------------------------------------------------
/* השומר הוא הערובה האחרונה של הצ'אט האנונימי. הוא חייב לזרוק *סינכרונית*:
   מסלול שהיה מקבל הבטחה דחויה במקום זריקה היה עונה ok ורק אחר כך נכשל. */
t.section('שיחה אנונימית נעצרת בשומר');
{
  let threw = false;
  try { store.writeConv(conv('anon-1')); } catch { threw = true; }
  t.ok('נזרק מיד ולא כהבטחה דחויה', threw);
  await store.drain();
  t.eq('ולא נגעה בדיסק', onDisk('anon-1'), null);
}

// ---------------------------------------------------------------------------
/* כתיבה שנכשלת בשקט אחרי שהובטח עליה ok היא אובדן נתונים שקט. בגרסה
   הסינכרונית השגיאה הפילה את המסלול והחזירה 500; כאן היא חייבת להגיע
   כדחייה אל מי שביקש את הכתיבה. */
t.section('כישלון כתיבה מגיע אל מי שביקש אותה');
{
  // תיקיית אחסון שאי-אפשר ליצור: ההורה שלה הוא קובץ רגיל, ולכן כל פתיחה
  // בתוכה נכשלת ב-ENOTDIR. זו הדרך להפיל כתיבה בלי להסתמך על הרשאות, שממילא
  // לא היו חוסמות הרצה כ-root.
  const blocker = path.join(DIR, 'blocker');
  fs.writeFileSync(blocker, 'קובץ ולא תיקייה');
  const failing = [];
  const bad = createConvStore({ dir: path.join(blocker, 'sub'), dbg: (tag) => failing.push(tag) });

  let rejected = false;
  try { await bad.writeConv(conv('boom')); } catch { rejected = true; }
  t.ok('ההבטחה נדחתה', rejected);
  t.ok('והכישלון נרשם ביומן', failing.includes('store.write.fail'), failing);
}

// ---------------------------------------------------------------------------
/* היציאה היא הרשת האחרונה: מה שעוד לא נחת נכתב סינכרונית לפני שהתהליך מת. */
t.section('ניקוז ביציאה');
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-store2-'));
  const s2 = createConvStore({ dir: dir2, dbg: () => {} });
  s2.writeConv(conv('last', { title: 'לא הספיקה' }));
  const n = s2.flushSync();
  t.ok('נוקזה לפחות אחת', n >= 1, n);
  t.eq('והתוכן על הדיסק', JSON.parse(fs.readFileSync(path.join(dir2, 'last.json'), 'utf8')).title, 'לא הספיקה');
  fs.rmSync(dir2, { recursive: true, force: true });
}

t.section('סיכום');
t.eq('לא נרשמו כשלי כתיבה בלתי צפויים', logs.filter((l) => l.tag === 'store.write.fail').length, 0);

t.done();
