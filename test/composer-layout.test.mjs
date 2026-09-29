/**
 * סימולציית שורת הכתיבה בטלפון — הקוד האמיתי (`autoGrow` → `shouldComposeTall`
 * → `setComposeTall`) מול מודל פריסה שמחשב רוחב חריץ, שבירת שורות וגובה.
 *
 * `compose-tall.test.mjs` בודק את פונקציית ההחלטה לבדה עם מספרים ביד; כאן
 * המספרים מגיעים מהפריסה עצמה, ולכן נבדק גם מה שביניהם: חישוב החריץ הצר
 * (כולל מיקרופון שקיים או לא), הריפוד שמשתנה בין המצבים, ומחזור החיים של
 * אנימציית ה-FLIP — כולל השיבוט הזמני שנשאר תלוי במסך אם לא ינוקה.
 */
import { makeEnv, installViewport, runner } from './harness.mjs';

const t = runner('שורת הכתיבה — פריסה (סימולציה)');

const phone = (o = {}) => makeEnv({ cardWidth: 344, charW: 8, innerHeight: 740, ...o });
const ghosts = (env) => env.els.body.querySelectorAll('.cc-ghost').length;

// ---------------------------------------------------------------------------
t.section('חישוב החריץ הצר');
{
  const env = phone();
  env.api.dictPaint();                       // מיקרופון גלוי
  env.keyboard = null;                       // נשתמש ב-classList ישירות כאן
  env.els.body.classList.add('compose-compact');
  env.relayout();
  const withMic = env.api.composeNarrowSlotPx(env.els.input);
  t.ok('החריץ חיובי והגיוני', withMic > 150 && withMic < 250, withMic);
  t.eq('תואם את רוחב התיבה בפועל', Math.round(withMic), Math.round(env.els.input.getBoundingClientRect().width));

  env.els.mic.classList.add('hidden');
  env.relayout();
  const noMic = env.api.composeNarrowSlotPx(env.els.input);
  t.eq('בלי מיקרופון החריץ רחב ב-34+6', Math.round(noMic - withMic), 40);
  t.eq('וגם אז תואם את הפריסה', Math.round(noMic), Math.round(env.els.input.getBoundingClientRect().width));

  env.els.sched.classList.add('hidden');
  env.relayout();
  const noSched = env.api.composeNarrowSlotPx(env.els.input);
  t.eq('תזמון לא תופס מקום בחריץ הצר', Math.round(noSched), Math.round(noMic));
}

// ---------------------------------------------------------------------------
t.section('הקלדה תו-אחר-תו — מעבר אחד, בלי רפרוף');
{
  const env = phone();
  env.api.dictPaint();
  installViewport(env);
  env.keyboard(true);
  t.ok('המקלדת הדליקה compose-compact', env.els.body.classList.contains('compose-compact'));

  const flips = [];
  let prev = env.tall();
  for (let n = 1; n <= 80; n++) {
    env.type('א');
    if (env.tall() !== prev) { flips.push({ n, to: env.tall() }); prev = env.tall(); }
  }
  t.eq('מעבר אחד בלבד בכל ההקלדה', flips.length, 1);
  t.eq('והוא לכיוון tall', flips[0].to, true);
  t.ok('נכנס סביב מילוי החריץ', flips[0].n >= 18 && flips[0].n <= 32, flips[0]);

  // מחיקה חזרה — יציאה אחת
  const back = [];
  prev = env.tall();
  for (let n = 80; n >= 0; n--) {
    env.setText('א'.repeat(n));
    if (env.tall() !== prev) { back.push({ n, to: env.tall() }); prev = env.tall(); }
  }
  t.eq('יציאה אחת במחיקה', back.length, 1);
  t.eq('והיא לכיוון הצר', back[0].to, false);
  t.ok('היסטרזיס אמיתי בין הכניסה ליציאה', back[0].n < flips[0].n, { in: flips[0].n, out: back[0].n });
}

// ---------------------------------------------------------------------------
// זה הפיצ'ר עצמו, כמשפט אחד: בשורה הצרה הטקסט לעולם לא נשבר לשתי שורות.
// שבירה כזו היא בדיוק מה שנראה שבור — חצי משפט מעל הכפתורים.
t.section('אף פעם לא שתי שורות בחריץ הצר');
{
  const env = phone();
  env.api.dictPaint();
  installViewport(env);
  env.keyboard(true);
  const broken = [];
  for (let n = 1; n <= 70; n++) {
    env.setText('א'.repeat(n));
    if (!env.tall() && env.lines() > 1) broken.push({ n, lines: env.lines() });
  }
  t.eq('מילה ארוכה אחת', broken, []);

  const words = [];
  for (let n = 1; n <= 30; n++) {
    env.setText(Array.from({ length: n }, (_, k) => 'מילה' + (k % 7)).join(' '));
    if (!env.tall() && env.lines() > 1) words.push({ n, lines: env.lines() });
  }
  t.eq('משפט במילים', words, []);

  // גם בדרך חזרה: מחיקה עד שהטקסט שוב נכנס — בלי לעבור דרך מצב שבור
  const back = [];
  for (let n = 70; n >= 1; n--) {
    env.setText('א'.repeat(n));
    if (!env.tall() && env.lines() > 1) back.push({ n, lines: env.lines() });
  }
  t.eq('במחיקה', back, []);
}

// ---------------------------------------------------------------------------
t.section('התייצבות — אותו טקסט, מאה חישובים');
{
  const env = phone();
  env.api.dictPaint();
  installViewport(env);
  env.keyboard(true);
  // אורכים שונים, כולל בדיוק על הסף
  for (const len of [1, 10, 20, 21, 22, 23, 24, 25, 26, 40, 200]) {
    env.setText('ב'.repeat(len));
    const first = env.tall();
    let stable = true;
    for (let k = 0; k < 100; k++) { env.api.autoGrow(); if (env.tall() !== first) stable = false; }
    t.ok(`אורך ${len}: יציב ב-100 חישובים`, stable);
  }
}

// ---------------------------------------------------------------------------
t.section('שורה חדשה, ריקון, ושליחה');
{
  const env = phone();
  env.api.dictPaint();
  installViewport(env);
  env.keyboard(true);
  env.setText('קצר');
  t.eq('קצר = צר', env.tall(), false);
  env.setText('קצר\nעוד שורה');
  t.eq('Enter → גבוה', env.tall(), true);
  env.setText('');
  t.eq('ריקון (כמו אחרי שליחה) → חוזר לצר', env.tall(), false);
  t.eq('גובה התיבה חזר לשורה אחת', env.els.input.style.height, '40px');
}

// ---------------------------------------------------------------------------
t.section('אנימציית המעבר לא משאירה שאריות');
{
  const env = phone();
  env.api.dictPaint();
  installViewport(env);
  env.keyboard(true);
  env.setText('ט'.repeat(60));
  t.eq('גבוה', env.tall(), true);
  t.eq('אין שיבוט בכניסה', ghosts(env), 0);
  env.setText('');
  t.eq('צר', env.tall(), false);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.eq('השיבוט נוקה אחרי היציאה', ghosts(env), 0);

  // עשרה מעברים רצופים — אין הצטברות של אנימציות או שיבוטים
  for (let k = 0; k < 10; k++) { env.setText('ט'.repeat(60)); env.setText(''); }
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.eq('אין שיבוטים תלויים', ghosts(env), 0);
  t.ok('אין ערימת אנימציות על התיבה', env.els.input.getAnimations().length <= 1, env.els.input.getAnimations().length);
}

// ---------------------------------------------------------------------------
t.section('מצב "פחות תנועה" — אותה החלטה, בלי אנימציה');
{
  const env = phone({ reduceMotion: true });
  env.api.dictPaint();
  installViewport(env);
  env.keyboard(true);
  env.setText('ט'.repeat(60));
  t.eq('גבוה', env.tall(), true);
  t.eq('בלי אנימציה', env.els.input.getAnimations().length, 0);
  env.setText('');
  t.eq('צר', env.tall(), false);
  t.eq('ובלי שיבוט', ghosts(env), 0);
}

// ---------------------------------------------------------------------------
t.section('פתיחת מקלדת על טיוטה קיימת');
{
  const env = phone();
  env.api.dictPaint();
  installViewport(env);
  env.setText('ש'.repeat(60));              // נכתב לפני שהמקלדת נפתחה
  env.keyboard(true);
  t.ok('המצב תואם את מה שנראה כשהמקלדת נפתחה', env.tall() === env.api.shouldComposeTall(env.els.input),
    { tall: env.tall(), want: env.api.shouldComposeTall(env.els.input) });
  env.keyboard(false);
  t.ok('וגם כשהיא נסגרת', env.tall() === env.api.shouldComposeTall(env.els.input),
    { tall: env.tall(), want: env.api.shouldComposeTall(env.els.input) });
}

// ---------------------------------------------------------------------------
t.section('המקלדת עצמה — --app-h ו---app-top');
{
  const env = phone();
  installViewport(env, { height: 740 });
  t.eq('גובה מנוחה', env.cssVars['--app-h'], '740px');
  t.eq('בלי הסטה', env.cssVars['--app-top'], '0px');
  env.keyboard(true, 320);
  t.eq('גובה עם מקלדת', env.cssVars['--app-h'], '420px');
  t.ok('compose-compact נדלק', env.els.body.classList.contains('compose-compact'));
  env.keyboard(false);
  t.ok('ונכבה בסגירה', !env.els.body.classList.contains('compose-compact'));

  // סרגל כתובת שמתכווץ (60px) הוא לא מקלדת
  env.keyboard(true, 60);
  t.ok('כיווץ סרגל הכתובת לא מפעיל compact', !env.els.body.classList.contains('compose-compact'));
  env.keyboard(false);

  // iOS: החלון החזותי נדחף למטה — האפליקציה נצמדת אליו
  env.vv.offsetTop = 84;
  env.vv.height = 420;
  env.vv.dispatch('resize');
  t.eq('--app-top עוקב אחרי offsetTop', env.cssVars['--app-top'], '84px');
  t.ok('סכום הגובה וההסטה לא חורג מהמסך', 84 + 420 <= 740 + 320, true);
}

// ---------------------------------------------------------------------------
// ב-iOS המקלדת לא מקטינה את innerHeight וגם לא את dvh. תקרה שנגזרת מהם
// פירושה תיבה שממשיכה מתחת למקלדת יחד עם כפתור השליחה.
t.section('תקרת גובה התיבה נגזרת מהחלון החזותי');
{
  const env = phone();
  env.api.dictPaint();
  installViewport(env, { height: 740 });
  const many = Array.from({ length: 40 }, (_, k) => 'שורה ' + k).join('\n');
  env.setText(many);
  const open = env.els.input.style.height;
  t.eq('בלי מקלדת — 42% מהחלון המלא', open, 740 * 0.42 + 'px');

  env.keyboard(true, 320);               // מקלדת פתוחה: נשארו 420
  t.eq('עם מקלדת — 42% ממה שנשאר', env.els.input.style.height, 420 * 0.42 + 'px');
  t.ok('וזה באמת נכנס למה שנראה', parseFloat(env.els.input.style.height) < 420, env.els.input.style.height);

  env.keyboard(false);
  t.eq('סגירת המקלדת מחזירה את התקרה', env.els.input.style.height, 740 * 0.42 + 'px');
}

// ---------------------------------------------------------------------------
t.section('דסקטופ — אין מקלדת, אין compact');
{
  const env = makeEnv({ cardWidth: 740, charW: 8, coarse: false });
  env.api.dictPaint();
  installViewport(env, { height: 900 });
  t.ok('מעקב visualViewport כלל לא נרשם בעכבר', !env.cssVars['--app-h']);
  env.setText('ט'.repeat(120));
  t.ok('בלי compose-compact אין אנימציית FLIP', env.els.input.getAnimations().length === 0);
  t.eq('אין שיבוטים', ghosts(env), 0);
}

t.done();
