/**
 * פרוטוקול הדואט (`duet.js`) — חילוץ התוצר מתשובת משתתף, ופסק הדין של המפקח.
 *
 * זו נקודת השבירה של המצב הזה: המודל מחזיר טקסט חופשי, וכל מה שמפריד בין
 * "תור שעבד" ל"ריצה שנעצרה עם שגיאה" הוא שני הפרסרים האלה. הם לא מדברים עם
 * שום דבר חיצוני, ולכן אפשר לבדוק אותם על התשובות בצורה שבה הן באמת חוזרות —
 * כולל התשובה שמסבירה את הפרוטוקול ולכן מכילה את הסמנים שלו בתוך התוצר.
 */
import { slice, runner } from './harness.mjs';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../duet.js', import.meta.url), 'utf8');
const { parseArtifact, parseVerdict } = new Function(
  slice("const OPEN = '<<<ARTIFACT'", 'const CLOSE', SRC)
  + slice("const CLOSE = 'ARTIFACT>>>'", '\n', SRC)
  + slice('function parseArtifact(text) {', 'const trimTail', SRC)
  + '\nreturn { parseArtifact, parseVerdict };',
)();

const t = runner('פרוטוקול הדואט');

const wrap = (log, art) => `CHANGELOG:\n${log}\n\n<<<ARTIFACT\n${art}\nARTIFACT>>>`;

// ---------------------------------------------------------------------------
t.section('תוצר תקין');
{
  const p = parseArtifact(wrap('- שיניתי א\n- שיניתי ב', 'הטקסט המלא\nבשתי שורות'));
  t.eq('נקרא', p.ok, true);
  t.eq('התוצר בלי שורות המעבר של התחביר', p.artifact, 'הטקסט המלא\nבשתי שורות');
  t.eq('יומן בלי התבליטים', p.changelog, ['שיניתי א', 'שיניתי ב']);
  t.eq('לא הוכרז סיום', p.done, false);

  t.eq('תבליטים בכל צורה', parseArtifact(wrap('* א\n• ב\n1. ג\n2) ד', 'x')).changelog, ['א', 'ב', 'ג', 'ד']);
  t.eq('יומן נחתך לחמש', parseArtifact(wrap('- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 7', 'x')).changelog.length, 5);
  t.eq('בלי יומן — נאמר במפורש', parseArtifact('<<<ARTIFACT\nרק תוצר\nARTIFACT>>>').changelog, ['(ללא יומן שינויים)']);
  t.eq('CHANGELOG בלי רווח / באותיות קטנות', parseArtifact('changelog:\n- שינוי\n<<<ARTIFACT\nx\nARTIFACT>>>').changelog, ['שינוי']);
}

t.section('תוצר שמכיל את הסמנים של הפרוטוקול עצמו');
{
  const doc = 'כדי לסגור תוצר כותבים ARTIFACT>>> בסוף,\nואת <<<ARTIFACT בהתחלה.';
  const p = parseArtifact(wrap('- תיעדתי את הפרוטוקול', doc));
  t.eq('נקרא', p.ok, true);
  t.eq('התוצר לא נחתך על הסמן הפנימי', p.artifact, doc);
}

t.section('פורמט שבור');
{
  t.eq('בלי פותח', parseArtifact('סתם טקסט').why, 'missing-open');
  t.eq('בלי סוגר', parseArtifact('<<<ARTIFACT\nמשהו').why, 'missing-close');
  t.eq('סוגר לפני הפותח', parseArtifact('ARTIFACT>>>\nמשהו\n<<<ARTIFACT').why, 'missing-close');
  t.eq('תוצר ריק', parseArtifact('<<<ARTIFACT\n   \nARTIFACT>>>').why, 'empty');
  t.eq('טקסט ריק לגמרי', parseArtifact('').why, 'missing-open');
  t.eq('null', parseArtifact(null).why, 'missing-open');
}

t.section('הצהרת סיום של משתתף');
{
  t.eq('מזוהה', parseArtifact('NO FURTHER CHANGES NEEDED\n<<<ARTIFACT\nx\nARTIFACT>>>').done, true);
  t.eq('גם באותיות קטנות', parseArtifact('no further changes needed\n<<<ARTIFACT\nx\nARTIFACT>>>').done, true);
  t.eq('טקסט אחר אינו סיום', parseArtifact(wrap('- עוד שינוי', 'x')).done, false);
}

// ---------------------------------------------------------------------------
t.section('פסק הדין של המפקח');
{
  t.eq('JSON נקי', parseVerdict('{"status":"ok","progress":40}'), { ok: true, status: 'ok', note: '', reason: '', progress: 40 });
  t.eq('בתוך גדר קוד', parseVerdict('```json\n{"status":"steer","note":"קצר יותר"}\n```').note, 'קצר יותר');
  t.eq('עם פטפוט מסביב', parseVerdict('הנה ההחלטה שלי:\n{"status":"complete","reason":"מוכן"}\nבהצלחה').status, 'complete');
  t.eq('אותיות גדולות', parseVerdict('{"status":"STALLED"}').status, 'stalled');

  t.eq('אחוז מעל 100 נחתך', parseVerdict('{"status":"ok","progress":250}').progress, 100);
  t.eq('אחוז שלילי נחתך', parseVerdict('{"status":"ok","progress":-3}').progress, 0);
  t.eq('אחוז שאינו מספר', parseVerdict('{"status":"ok","progress":"הרבה"}').progress, null);
  t.eq('אחוז עשרוני מעוגל', parseVerdict('{"status":"ok","progress":41.6}').progress, 42);

  t.eq('סטטוס לא מוכר נדחה', parseVerdict('{"status":"maybe"}'), { ok: false });
  t.eq('לא JSON בכלל', parseVerdict('אין לי מושג'), { ok: false });
  t.eq('JSON שאינו אובייקט', parseVerdict('[1,2,3]'), { ok: false });
  t.eq('ריק', parseVerdict(''), { ok: false });

  const long = parseVerdict(JSON.stringify({ status: 'steer', note: 'א'.repeat(5000) }));
  t.eq('הערה ארוכה נחתכת', long.note.length, 1200);
}

t.done();
