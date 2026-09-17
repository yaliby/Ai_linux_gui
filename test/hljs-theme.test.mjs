/**
 * ערכת הדגשת התחביר מול מתג הערכה של האפליקציה.
 *   node test/hljs-theme.test.mjs
 *
 * הבאג שהבדיקה הזו נולדה ממנו: שתי ערכות highlight.js נטענות ב-index.html
 * עם ‎media="(prefers-color-scheme: …)"‎, כלומר הן הולכות אחרי מערכת ההפעלה.
 * אבל לאפליקציה יש מתג ערכה משלה (‎data-theme‎), ושאר הממשק הולך אחריו.
 * בטלפון שמערכת ההפעלה שלו בהירה ושהאפליקציה בו כהה נטענה הערכה *הבהירה*
 * מעל ‎--code-bg‎ הכהה — דיו כהה על רקע כהה, בלוק קוד שאי-אפשר לקרוא.
 *
 * ארבעת הצירופים נבדקים כאן במפורש, כי שניים מהם הם בדיוק אלה שנשברו:
 * אלה שבהם המתג ומערכת ההפעלה חלוקים.
 */
import { slice, runner } from './harness.mjs';

const t = runner('ערכת הדגשת תחביר');

// שתי הפונקציות נחתכות מ-app.js עצמו, כדי שהבדיקה תיפול אם מישהו ישנה אותן
const src = slice('function isDark()', "$('themeToggle').onclick");

/** מריץ את הקוד מול DOM מזויף ומחזיר את מצב שני הגיליונות. */
function run({ dataTheme, osDark }) {
  const sheets = { hlLight: { media: '(prefers-color-scheme: light)' }, hlDark: { media: '(prefers-color-scheme: dark)' } };
  const document = {
    documentElement: { getAttribute: (k) => (k === 'data-theme' ? dataTheme : null) },
    getElementById: (id) => sheets[id] || null,
  };
  const matchMedia = (q) => ({ matches: q.includes('dark') ? osDark : !osDark });
  // eslint-disable-next-line no-new-func
  new Function('document', 'matchMedia', src + '\nsyncHljsTheme();')(document, matchMedia);
  return {
    light: sheets.hlLight.media !== 'not all',
    dark: sheets.hlDark.media !== 'not all',
  };
}

/** בדיוק אחת משתי הערכות פעילה, והיא הנכונה. */
function expect(name, opts, wantDark) {
  const r = run(opts);
  t.ok(name, r.dark === wantDark && r.light === !wantDark, r);
}

t.section('המתג של האפליקציה גובר על מערכת ההפעלה');
// שני אלה הם הבאג עצמו — המתג ומערכת ההפעלה חלוקים
expect('אפליקציה כהה + מערכת בהירה → ערכה כהה', { dataTheme: 'dark', osDark: false }, true);
expect('אפליקציה בהירה + מערכת כהה → ערכה בהירה', { dataTheme: 'light', osDark: true }, false);
// ואלה עבדו גם קודם, ואסור שיישברו
expect('אפליקציה כהה + מערכת כהה', { dataTheme: 'dark', osDark: true }, true);
expect('אפליקציה בהירה + מערכת בהירה', { dataTheme: 'light', osDark: false }, false);

t.section('בלי העדפה מפורשת — הולכים אחרי מערכת ההפעלה');
expect('אין data-theme + מערכת כהה', { dataTheme: null, osDark: true }, true);
expect('אין data-theme + מערכת בהירה', { dataTheme: null, osDark: false }, false);

t.section('עמידוּת');
{
  // דף שבו הגיליונות עוד לא נוספו ל-DOM לא אמור להפיל את הטעינה
  let threw = false;
  try {
    const document = {
      documentElement: { getAttribute: () => 'dark' },
      getElementById: () => null,
    };
    new Function('document', 'matchMedia', src + '\nsyncHljsTheme();')(document, () => ({ matches: false }));
  } catch { threw = true; }
  t.ok('גיליון חסר אינו זורק', !threw);
}

t.done();
