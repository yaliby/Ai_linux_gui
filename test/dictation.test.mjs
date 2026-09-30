/**
 * בדיקות למנוע ההכתבה הקולית (`public/app.js`, מקטע DICT).
 *   npm test
 *
 * החשבון של מי-מצטרף-לאן הוא מה שנשבר בשקט: הוא לא זורק שגיאה, הוא רק מדביק
 * שתי מילים או מרחיק מילה מנקודה, וזה נראה כמו תקלת הכרה ולא כמו באג. לכן
 * הפונקציות הטהורות נבדקות כאן מול textarea מזויף, בלי דפדפן ובלי מיקרופון.
 *
 * מה שלא נבדק כאן, כי הוא שייך למנוע ולא לנו: `SpeechRecognition` עצמו, לולאת
 * ה-`onend`, וההרשאה. אלה נבדקים בדפדפן.
 */
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// חילוץ מקטע ההכתבה בלבד, מהכותרת ועד סוף חיווט האירועים
const start = src.indexOf('const DICT_LANGS = [');
const end = src.indexOf("if (dictSupported()) {", start);
if (start < 0 || end < 0) { console.error('לא נמצא מקטע ההכתבה'); process.exit(1); }
const mod = src.slice(start, end);

// --- סביבה מזויפת: textarea אמיתי בהתנהגות, ללא DOM ---
const input = {
  value: '', selectionStart: 0, selectionEnd: 0,
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
  style: {}, scrollHeight: 20,
};
let focused = input;
globalThis.document = { get activeElement() { return focused; }, body: { classList: { toggle() {} } }, addEventListener() {} };
globalThis.window = { isSecureContext: true };
globalThis.$ = (id) => (id === 'input' ? input : null);
globalThis.store = { settings: {} };
globalThis.save = () => {};
globalThis.toast = () => {};
globalThis.dlog = () => {};
globalThis.autoGrow = () => {};
globalThis.stashDraft = () => {};
globalThis.stashDraftSoon = () => {};
globalThis.addEventListener = () => {};

const api = new Function(mod + '\nreturn { dictJoin, dictAnchorAtCaret, dictRender, dictReanchor, get anchor(){return dictAnchor}, set anchor(v){dictAnchor=v} };')();

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)); }
};

/** מדמה תוצאות מנוע: [טקסט, סופי?] ברצף, כמו onresult */
function speak(chunks) {
  for (const [text, final] of chunks) {
    api.dictReanchor();
    if (final) { api.anchor.head = api.dictJoin(api.anchor.head, text); api.anchor.interim = ''; }
    else api.anchor.interim = text.replace(/\s+/g, ' ').trim();
    api.dictRender();
  }
}
function begin(value, selStart, selEnd, isFocused = true) {
  input.value = value; input.selectionStart = selStart; input.selectionEnd = selEnd ?? selStart;
  focused = isFocused ? input : null;
  api.anchor = api.dictAnchorAtCaret();
}

console.log('\ndictJoin — רווחים');
eq('ריק + מקטע', api.dictJoin('', 'שלום'), 'שלום');
eq('מקטע אחרי מילה', api.dictJoin('שלום', 'עולם'), 'שלום עולם');
eq('לא מכפיל רווח', api.dictJoin('שלום ', 'עולם'), 'שלום עולם');
eq('רווח מוביל מהמנוע נבלע', api.dictJoin('hello', '  world '), 'hello world');
eq('רווחים פנימיים מנורמלים', api.dictJoin('', 'a   b'), 'a b');
eq('מקטע ריק לא משנה', api.dictJoin('שלום', '   '), 'שלום');
eq('שורה חדשה נחשבת רווח', api.dictJoin('שלום\n', 'עולם'), 'שלום\nעולם');

console.log('\nתיבה ריקה — ביניים נדרס בסופי');
begin('', 0);
speak([['שלום', false], ['שלום עולם', false], ['שלום עולם', true]]);
eq('טקסט סופי', input.value, 'שלום עולם');
speak([['מה', false], ['מה שלומך', true]]);
eq('משפט שני מצטרף ברווח', input.value, 'שלום עולם מה שלומך');
eq('הסמן בסוף', input.selectionStart, input.value.length);

console.log('\nהכתבה לאמצע טקסט קיים');
begin('לפני אחרי', 5);              // הסמן בין "לפני " ל"אחרי"
speak([['באמצע', true]]);
eq('נכנס בדיוק בסמן', input.value, 'לפני באמצע אחרי');
eq('הסמן בין הדיבור לשארית', input.selectionStart, 'לפני באמצע'.length);

console.log('\nטווח מסומן מוחלף');
begin('מחק אותי בבקשה', 0, 9);      // "מחק אותי " מסומן
speak([['כתוב זאת', true]]);
eq('הבחירה הוחלפה', input.value, 'כתוב זאת בבקשה');

console.log('\nתיבה לא בפוקוס — עוגן בסוף ולא בהתחלה');
begin('טיוטה קיימת', 0, 0, false);
speak([['תוספת', true]]);
eq('נוסף לסוף', input.value, 'טיוטה קיימת תוספת');

console.log('\nהמשתמש מקליד באמצע ההכתבה');
begin('', 0);
speak([['ראשון', true]]);
input.value = 'ראשון!';            // הקלדה ידנית — התיבה כבר לא mirror
input.selectionStart = input.selectionEnd = input.value.length;
speak([['שני', true]]);
eq('העריכה שרדה והדיבור המשיך אחריה', input.value, 'ראשון! שני');

console.log('\nמחיקה ידנית מלאה באמצע ההכתבה');
begin('', 0);
speak([['משהו ארוך', true]]);
input.value = ''; input.selectionStart = input.selectionEnd = 0;
speak([['התחלה חדשה', true]]);
eq('לא משחזר את מה שנמחק', input.value, 'התחלה חדשה');

console.log('\nביניים ארוך שמתקצר (המנוע מתקן את עצמו)');
begin('', 0);
speak([['אני חושב שזה', false], ['אני חושב', false], ['אני חושב שכן', true]]);
eq('רק התיקון האחרון נשאר', input.value, 'אני חושב שכן');


console.log('\nסימן פיסוק אחרי הסמן — בלי רווח לפניו');
begin('שלום.', 4);                  // הסמן לפני הנקודה
speak([['עולם', true]]);
eq('הנקודה נשארה צמודה', input.value, 'שלום עולם.');
begin('כן, ובכן', 2);               // הסמן לפני הפסיק
speak([['ודאי', true]]);
eq('הפסיק נשאר צמוד', input.value, 'כן ודאי, ובכן');

console.log('\nהסמן בסוף הטקסט — אין שארית ואין רווח מיותר');
begin('סוף', 3);
speak([['דבר', true]]);
eq('בלי רווח נגרר', input.value, 'סוף דבר');

console.log('\nהכתבה לאמצע מילה מתחילה מילה חדשה');
begin('אבגד', 2);
speak([['חדש', true]]);
eq('רווח משני הצדדים', input.value, 'אב חדש גד');

console.log('\nביניים לאמצע טקסט נדרס ולא מצטבר');
begin('ראש סוף', 4);
speak([['א', false], ['אב', false], ['אבג', false], ['אבג', true]]);
eq('רק הגרסה האחרונה', input.value, 'ראש אבג סוף');

console.log(`\n${pass} עברו, ${fail} נכשלו`);
process.exit(fail ? 1 : 0);
