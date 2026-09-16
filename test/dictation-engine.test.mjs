/**
 * סימולציית מנוע ההכתבה מקצה לקצה — הקוד האמיתי מ-app.js מול
 * `SpeechRecognition` מזויף שמדבר את אותה שפת אירועים של Chrome.
 *
 * מה שנבדק כאן ולא ב-dictation.test.mjs: לולאת ה-`onend` (המקום שבו הכתבה
 * מתה בשקט אחרי שקט קצר), מסלולי השגיאה, החלפת שפה תוך כדי, וכל דרך שבה
 * ההקשבה אמורה להיסגר מעצמה — שליחה, מעבר לשונית, Esc, יציאה מהדף.
 */
import { makeEnv, runner, FakeRecognition } from './harness.mjs';

const t = runner('הכתבה — מנוע חי (סימולציה)');

/** שקט אמיתי של Chrome: no-speech ואז end. */
function silence(env) { const r = env.rec(); r.err('no-speech'); r.abort(); }

// ---------------------------------------------------------------------------
t.section('הדלקה וכיבוי');
{
  const env = makeEnv();
  env.api.dictPaint();
  t.ok('המיקרופון נחשף כשהדפדפן תומך', !env.els.mic.classList.contains('hidden'));
  t.eq('כבוי בהתחלה', env.api.on, false);

  env.click('micBtn');
  t.eq('הדלקה', env.api.on, true);
  t.eq('מנוע אחד עלה', env.recs().length, 1);
  t.eq('שפת ברירת המחדל', env.rec().lang, 'he-IL');
  t.eq('רציף', env.rec().continuous, true);
  t.eq('תוצאות ביניים', env.rec().interimResults, true);
  t.ok('כפתור דלוק', env.els.mic.classList.contains('on'));
  t.eq('aria-pressed', env.els.mic.getAttribute('aria-pressed'), 'true');
  t.ok('הרצועה גלויה', !env.els.dictStrip.classList.contains('hidden'));
  t.ok('body.dictating', env.els.body.classList.contains('dictating'));
  t.eq('שבב השפה', env.els.dictLang.textContent, 'עב');

  env.click('micBtn');
  t.eq('כיבוי', env.api.on, false);
  t.ok('הרצועה נסגרה', env.els.dictStrip.classList.contains('hidden'));
  t.ok('body.dictating ירד', !env.els.body.classList.contains('dictating'));
  t.eq('המנוע הופסק', env.rec().state, 'idle');
  t.eq('אין מנוע חי', env.api.rec, null);
}

// ---------------------------------------------------------------------------
t.section('דיבור → טקסט בתיבה');
{
  const env = makeEnv();
  env.api.dictStart();
  env.rec().emit([['שלום', false]]);
  t.eq('ביניים נכתב לתיבה', env.els.input.value, 'שלום');
  env.rec().emit([['שלום עולם', false]]);
  t.eq('ביניים נדרס', env.els.input.value, 'שלום עולם');
  env.rec().emit([['שלום עולם', true]]);
  t.eq('סופי', env.els.input.value, 'שלום עולם');
  env.rec().emit([['מה קורה', true]]);
  t.eq('משפט שני מצטרף ברווח', env.els.input.value, 'שלום עולם מה קורה');
  t.eq('הסמן בסוף', env.els.input.selectionStart, env.els.input.value.length);
  env.api.dictStop();
  t.eq('הטקסט נשאר אחרי עצירה', env.els.input.value, 'שלום עולם מה קורה');
}

// ---------------------------------------------------------------------------
t.section('שקט לא מפסיק את ההקשבה (לולאת onend)');
{
  const env = makeEnv();
  env.api.dictStart();
  env.rec().emit([['ראשון', true]]);
  const first = env.rec();

  silence(env);
  t.eq('עדיין מקשיבים', env.api.on, true);
  t.ok('המנוע הורם מחדש', first.startCalls >= 2 || env.recs().length > 1);
  t.ok('הכפתור עדיין דלוק', env.els.mic.classList.contains('on'));

  env.rec().emit([['שני', true]]);
  t.eq('הדיבור ממשיך אחרי השקט', env.els.input.value, 'ראשון שני');

  // עשרה סבבי שקט עם דיבור ביניהם — אין נטישה ואין כפילות
  for (let k = 0; k < 10; k++) { silence(env); env.rec().emit([['עוד', true]]); }
  t.eq('אחרי עשרה סבבים עדיין דולק', env.api.on, true);
  t.eq('בלי כפילויות', env.els.input.value, 'ראשון שני' + ' עוד'.repeat(10));
  env.api.dictStop();
}

// ---------------------------------------------------------------------------
t.section('מנוע שמסרב לעלות — עצירה עם הסבר, לא לולאה');
{
  const env = makeEnv();
  env.api.dictStart();
  let guard = 0;
  while (env.api.on && guard++ < 50) env.rec().abort();   // סיום מיידי, שוב ושוב
  t.ok('נעצר ולא נתקע בלולאה', guard < 50, { guard });
  t.eq('ההקשבה כבויה', env.api.on, false);
  t.ok('נאמר למה', env.toasts.some((x) => x.err && /מיקרופון/.test(x.t)), env.toasts);
  t.ok('לא ניסה אינסוף פעמים', env.recs()[0].startCalls <= 6, env.recs()[0].startCalls);
}

// ---------------------------------------------------------------------------
t.section('שגיאות מהמנוע');
{
  const cases = [
    ['not-allowed', /הרשאת מיקרופון/, false],
    ['service-not-allowed', /הרשאת מיקרופון/, false],
    ['network', /לא זמין/, false],
    ['audio-capture', /לא נמצא מיקרופון/, false],
    ['language-not-supported', /לא יודע להכתיב/, false],
    ['bad-grammar', /ההכתבה נעצרה/, false],
    ['aborted', null, true],
    ['no-speech', null, true],
  ];
  for (const [err, re, keepsOn] of cases) {
    const env = makeEnv();
    env.api.dictStart();
    env.rec().err(err);
    t.eq(`${err} → ${keepsOn ? 'ממשיך' : 'נעצר'}`, env.api.on, keepsOn);
    if (re) t.ok(`${err} → הודעה בעברית`, env.toasts.some((x) => x.err && re.test(x.t)), env.toasts);
    if (!keepsOn) t.eq(`${err} → אין מנוע חי`, env.api.rec, null);
  }
}

// ---------------------------------------------------------------------------
t.section('שגיאה קטלנית שמלווה ב-onend (רצף אמיתי של Chrome)');
{
  const env = makeEnv();
  env.api.dictStart();
  const r = env.rec();
  r.err('not-allowed');
  r.abort();                       // Chrome שולח end מיד אחרי error
  t.eq('נשאר כבוי ולא הורם מחדש', env.api.on, false);
  t.eq('מנוע אחד בלבד', env.recs().length, 1);
}

// ---------------------------------------------------------------------------
t.section('החלפת שפה תוך כדי');
{
  const env = makeEnv();
  env.api.dictStart();
  env.rec().emit([['שלום', true]]);
  env.click('dictLang');
  t.eq('השפה התחלפה', env.api.dictLang(), 'en-US');
  t.eq('המנוע החדש באנגלית', env.rec().lang, 'en-US');
  t.eq('נשמר להגדרות', env.saved > 0, true);
  t.eq('שבב השפה התעדכן', env.els.dictLang.textContent, 'EN');
  t.eq('עדיין מקשיבים', env.api.on, true);
  env.rec().emit([['hello', true]]);
  t.eq('מה שהוכתב נשאר והמשך נצמד אליו', env.els.input.value, 'שלום hello');
  env.api.dictStop();
  t.eq('הבחירה נשמרת להפעלה הבאה', env.api.dictLang(), 'en-US');
}

// ---------------------------------------------------------------------------
t.section('כל דרך לסגור');
{
  // שליחה
  let env = makeEnv();
  env.api.dictStart();
  env.rec().emit([['תשלח את זה', true]]);
  env.keydown('Enter');
  t.eq('Enter שולח', env.sent.length, 1);
  t.eq('השליחה כיבתה את המיקרופון', env.api.on, false);
  t.eq('הטקסט הגיע לשליחה', env.sent[0], 'תשלח את זה');

  // Esc בתיבה
  env = makeEnv();
  env.api.dictStart();
  const e = env.keydown('Escape');
  t.eq('Esc עוצר', env.api.on, false);
  t.ok('Esc לא ממשיך לחלוניות אחרות', e.propagationStopped);

  // לשונית ברקע
  env = makeEnv();
  env.api.dictStart();
  env.hideTab();
  t.eq('מעבר לרקע עוצר', env.api.on, false);

  // יציאה מהדף
  env = makeEnv();
  env.api.dictStart();
  env.pagehide();
  t.eq('pagehide עוצר', env.api.on, false);

  // כפתור "סיום" ברצועה
  env = makeEnv();
  env.api.dictStart();
  env.click('dictDone');
  t.eq('כפתור סיום עוצר', env.api.on, false);
}

// ---------------------------------------------------------------------------
t.section('דפדפן בלי תמיכה / חיבור לא מאובטח');
{
  let env = makeEnv({ noSpeech: true });
  env.api.dictPaint();
  t.ok('המיקרופון מוסתר לגמרי', env.els.mic.classList.contains('hidden'));
  env.api.dictToggle();
  t.eq('אין הדלקה', env.api.on, false);
  t.ok('נאמר שאין תמיכה', env.toasts.some((x) => /לא תומך/.test(x.t)));

  env = makeEnv({ secure: false });
  env.api.dictPaint();
  t.ok('הכפתור מוצג', !env.els.mic.classList.contains('hidden'));
  t.eq('אבל מושבת', env.els.mic.disabled, true);
  env.api.dictToggle();
  t.eq('ולא מדליק', env.api.on, false);
  t.ok('ההסבר נאמר', env.toasts.some((x) => /מאובטח/.test(x.t)));
}

// ---------------------------------------------------------------------------
t.section('עמידות');
{
  const env = makeEnv();
  env.api.dictStop();                       // עצירה בלי התחלה
  t.eq('עצירה כפולה לא מפילה', env.api.on, false);
  env.api.dictStart();
  env.api.dictStart();                      // הדלקה כפולה
  t.eq('רק מנוע אחד', env.recs().length, 1);
  env.api.dictStop();
  env.api.dictStop();
  t.eq('סגור', env.api.on, false);

  // הדלקה אחרי עצירה — עוגן חדש, בלי לשחזר את הישן
  env.setText('טיוטה');
  env.els.input.focus();
  env.els.input.setSelectionRange(5, 5);
  env.api.dictStart();
  env.rec().emit([['המשך', true]]);
  t.eq('ממשיך את הטיוטה', env.els.input.value, 'טיוטה המשך');
  env.api.dictStop();
}

// ---------------------------------------------------------------------------
t.section('start() שנכשל');
{
  const env = makeEnv();
  FakeRecognition.throwOnStart = true;
  env.api.dictStart();
  t.eq('כישלון בהפעלה לא משאיר מצב דלוק', env.api.on, false);
  t.ok('ונאמר', env.toasts.some((x) => x.err));
  FakeRecognition.throwOnStart = false;
}

// ---------------------------------------------------------------------------
t.section('start() שנכשל בתוך onend — מתאושש, ואם לא: אומר');
{
  // אנדרואיד: המנוע מסיים כל כמה שניות, ולפעמים ‎start()‎ המיידי זורק.
  const env = makeEnv();
  env.api.dictStart();
  env.rec().emit([['ראשון', true]]);
  FakeRecognition.throwOnStart = true;
  env.rec().abort();                          // onend → start() נכשל
  t.eq('לא ויתר מיד', env.api.on, true);
  t.eq('גם לא נזרק טקסט', env.els.input.value, 'ראשון');
  FakeRecognition.throwOnStart = false;
  await new Promise((r) => setTimeout(r, 300));
  t.eq('הניסיון החוזר החזיר את ההקשבה', env.api.on, true);
  env.rec().emit([['שני', true]]);
  t.eq('וההכתבה ממשיכה מאותו מקום', env.els.input.value, 'ראשון שני');
  env.api.dictStop();

  // כישלון עקבי — עוצר ואומר, לא נכבה בשקט
  const env2 = makeEnv();
  env2.api.dictStart();
  env2.rec().emit([['משהו', true]]);
  FakeRecognition.throwOnStart = true;
  env2.rec().abort();
  await new Promise((r) => setTimeout(r, 900));
  t.eq('בסוף נעצר', env2.api.on, false);
  t.ok('ונאמר למה', env2.toasts.some((x) => x.err && /הכתבה נעצרה/.test(x.t)), env2.toasts);
  t.eq('הטקסט שהוכתב נשאר', env2.els.input.value, 'משהו');
  FakeRecognition.throwOnStart = false;

  // עצירה ידנית בזמן שניסיון חוזר ממתין — אין תחייה מאוחרת
  const env3 = makeEnv();
  env3.api.dictStart();
  FakeRecognition.throwOnStart = true;
  env3.rec().abort();
  env3.api.dictStop();
  FakeRecognition.throwOnStart = false;
  await new Promise((r) => setTimeout(r, 400));
  t.eq('נשאר כבוי', env3.api.on, false);
  t.eq('ולא הורם מנוע חדש', env3.recs().length, 1);
}

// ---------------------------------------------------------------------------
t.section('הכתבה + שורת הכתיבה הגבוהה (אינטגרציה)');
{
  const env = makeEnv({ cardWidth: 344, charW: 8 });
  env.keyboard(true);                        // מקלדת פתוחה
  env.api.dictStart();
  const flips = [];
  let prev = env.tall();
  for (let k = 0; k < 12; k++) {
    env.rec().emit([['מילה '.repeat(k + 1).trim(), false]]);
    if (env.tall() !== prev) { flips.push(k); prev = env.tall(); }
  }
  env.rec().emit([['מילה '.repeat(12).trim(), true]]);
  t.ok('הטקסט הארוך הפך את השורה לגבוהה', env.tall());
  t.eq('מעבר אחד בלבד, בלי רפרוף', flips.length, 1);
  env.api.dictStop();
}

t.done();
