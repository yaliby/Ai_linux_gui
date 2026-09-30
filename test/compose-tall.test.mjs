/**
 * סימולציה לבאג ה-oscillation של compose-tall.
 *   node test/compose-tall.test.mjs
 *
 * הבאג: ברוחב הצר (שורה בין כפתורים) הטקסט נשבר → tall → ברוחב המלא הוא
 * שוב שורה אחת לפי scrollHeight → יורדים מ-tall → שוב צר → לולאה.
 * התיקון מחליט לפי רוחב החריץ הצר תמיד, לא לפי הגובה המוצג.
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = src.indexOf('function composeTallDecision(');
const end = src.indexOf('function composeNarrowSlotPx(', start);
if (start < 0 || end < 0) {
  console.error('לא נמצא composeTallDecision ב-app.js');
  process.exit(1);
}
const { composeTallDecision } = new Function(
  `${src.slice(start, end)}\nreturn { composeTallDecision };`,
)();

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, `\n      got:  ${got}\n      want: ${want}`); }
};

console.log('\ncomposeTallDecision — מקרי יסוד');
eq('ריק', composeTallDecision(0, 100, false, false), false);
eq('שורה חדשה תמיד tall', composeTallDecision(10, 200, false, true), true);
eq('נכנס כשחורג מהחריץ הצר', composeTallDecision(130, 100, false, false), true);
eq('לא נכנס כשנכנס בחריץ', composeTallDecision(80, 100, false, false), false);
eq('נשאר tall עם היסטרזיס גם קרוב לסף', composeTallDecision(90, 100, true, false), true);
eq('יוצא מ-tall רק כשברור שנכנס', composeTallDecision(70, 100, true, false), false);

console.log('\nסימולציית לולאה — הטקסט שבור בצר, שלם ברחב');
{
  // פיקסלים: חריץ צר 120, תיבה רחבה 280, טקסט ברוחב 150
  const narrowSlot = 120;
  const textW = 150;
  const wideFits = textW < 280; // מה ש-scrollHeight היה אומר אחרי המעבר לרחב
  eq('ברחב הטקסט באמת נכנס לשורה (תנאי הבאג)', wideFits, true);

  // --- הלוגיקה הישנה (לפי גובה מוצג) — חייבת להתנדנד ---
  let oldTall = false;
  const flips = [];
  for (let i = 0; i < 8; i++) {
    const layoutWidth = oldTall ? 280 : narrowSlot;
    const wouldWrap = textW > layoutWidth; // proxy ל-scrollHeight > שורה אחת
    const next = wouldWrap;
    flips.push(next);
    oldTall = next;
  }
  const oldOscillates = flips.some((v, i) => i > 0 && v !== flips[i - 1]);
  eq('הלוגיקה הישנה מתנדנדת (שיחזור הבאג)', oldOscillates, true);

  // --- הלוגיקה החדשה — יציבה על tall ---
  let tall = false;
  const states = [];
  for (let i = 0; i < 20; i++) {
    // תמיד מודדים מול החריץ הצר, גם אחרי שהפריסה רחבה
    tall = composeTallDecision(textW, narrowSlot, tall, false);
    states.push(tall);
  }
  eq('אחרי כניסה נשארים tall בכל האיטרציות', states.every(Boolean), true);
  eq('נכנסים כבר בצעד הראשון', states[0], true);
}

console.log('\nסימולציה — מחיקה עד שורה אחת צרה');
{
  const narrowSlot = 120;
  let tall = false;
  // הקלדה הדרגתית עד חריגה
  for (const w of [40, 80, 100, 130]) {
    tall = composeTallDecision(w, narrowSlot, tall, false);
  }
  eq('אחרי חריגה: tall', tall, true);
  // מחיקה הדרגתית — ההיסטרזיס: נשארים כל עוד textW > slot-16 (=104)
  tall = composeTallDecision(110, narrowSlot, tall, false);
  eq('עדיין tall ב-110 (מעל 104)', tall, true);
  tall = composeTallDecision(100, narrowSlot, tall, false);
  eq('יוצא ב-100 (מתחת ל-104)', tall, false);
  tall = composeTallDecision(50, narrowSlot, false, false);
  eq('נשאר כבוי ב-50', tall, false);
}

console.log('\nסימולציה — Enter לשורה חדשה');
{
  let tall = composeTallDecision(40, 200, false, false);
  eq('מילה קצרה בלי newline: לא tall', tall, false);
  tall = composeTallDecision(40, 200, tall, true);
  eq('אחרי newline: tall גם בטקסט קצר', tall, true);
}

console.log('\nסימולציית הקלדה תו-אחר-תו (רוחב תו ≈ 9px)');
{
  const narrowSlot = 100;
  const charW = 9;
  let tall = false;
  let enteredAt = -1;
  for (let n = 1; n <= 20; n++) {
    const textW = n * charW;
    const next = composeTallDecision(textW, narrowSlot, tall, false);
    if (next && enteredAt < 0) enteredAt = n;
    tall = next;
  }
  // כניסה כש-textW > slot+4 ⇒ >104 ⇒ n>=12 (108)
  eq('נכנס סביב תו 12', enteredAt >= 11 && enteredAt <= 13, true);

  // ממשיכים להקליד בזמן tall — אין יציאה חזרה לצר
  let exitedWhileGrowing = false;
  tall = false;
  for (let n = 1; n <= 30; n++) {
    const prev = tall;
    tall = composeTallDecision(n * charW, narrowSlot, tall, false);
    if (prev && !tall && n * charW > narrowSlot) exitedWhileGrowing = true;
  }
  eq('אין יציאה בזמן שהטקסט גדל מעבר לחריץ', exitedWhileGrowing, false);
  eq('בסוף ההקלדה: tall', tall, true);

  // מחיקה הפוכה — יציאה אחת בלבד, בלי רפרוף
  const exits = [];
  for (let n = 30; n >= 1; n--) {
    const prev = tall;
    tall = composeTallDecision(n * charW, narrowSlot, tall, false);
    if (prev && !tall) exits.push(n);
  }
  eq('יציאה אחת במחיקה', exits.length, 1);
  eq('אחרי מחיקה מלאה: כבוי', tall, false);
}

console.log(`\n${pass} עברו, ${fail} נכשלו`);
process.exit(fail ? 1 : 0);