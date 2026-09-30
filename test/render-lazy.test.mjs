/**
 * ציור התמליל בדפדפן אמיתי — גופי כרטיסים נבנים רק כשפותחים אותם.
 *   node test/render-lazy.test.mjs
 *
 * כרטיס כלי וכרטיס חשיבה הם ‎<details>‎ סגורים: הכותרת (שם, תצוגה מקדימה,
 * סטטוס) היא כל מה שנראה עד שלוחצים. נמדד על השיחות האמיתיות שבמכונה הזאת:
 * מתוך 8,057 צמתי DOM בגדולה שבהן, **4,932 (61%) ישבו בגופים של 352
 * כרטיסים שכולם סגורים**.
 *
 * מה שנבדק כאן הוא מה שעלול להישבר בגלל הדחייה, ולא הביצועים עצמם:
 *
 *   • הכותרת נראית מיד — הדחייה נוגעת לגוף בלבד.
 *   • פתיחה בונה את הגוף, וסגירה ופתיחה שוב לא מרוקנות אותו.
 *   • החיפוש סורק טקסט מתוך ה-DOM, ולכן חייב לבנות הכול לפניו.
 *   • ‎toggle‎ אינו מבעבע — המאזין היחיד יושב על ‎#log‎ בשלב הלכידה, ובדיקה
 *     בדפדפן היא הדרך היחידה לוודא שזה באמת עובד.
 *
 * הבדיקה מרימה את השרת האמיתי מול ‎HOME‎ זמני, ולכן אינה נוגעת בשיחות של מי
 * שמריץ אותה. בלי דפדפן מותקן היא מדלגת ולא נכשלת.
 */
import { runner } from './harness.mjs';
import { findBrowser, launch, newPage, startServer, freePort } from './browser.mjs';

if (!findBrowser()) {
  console.log('\nציור התמליל בדפדפן אמיתי\n  ⚠ אין דפדפן מבוסס-Chromium — מדלג (SOL_TEST_BROWSER מכוון לנתיב)\n');
  process.exit(0);
}

const t = runner('ציור התמליל בדפדפן אמיתי');

/* ---------- שיחה מלאכותית, בגודל שמייצג את מה שנמדד ---------- */
const bigText = (n) => 'שורה של פלט שחוזר על עצמו כדי שהגוף יהיה כבד.\n'.repeat(n);

function toolBlock(i) {
  return {
    type: 'tool', id: 'toolu_' + i, name: 'Bash', status: 'ok', isError: false,
    input: { command: 'echo ' + i + ' && ls -la', description: 'פקודה מספר ' + i },
    // מחרוזת ייחודית שקיימת *רק* בגוף — מה שהחיפוש אמור למצוא
    result: 'ZEBRAFISH' + i + '\n' + bigText(12),
  };
}

/* כרטיס ‎Edit‎ ולא רק ‎Bash‎: ‎renderDiff‎ יוצר ‎<span>‎ לכל שורה, ולכן הוא
   מייצג נאמנה את מה שנמדד בשיחות האמיתיות — שם רוב הצמתים המוסתרים הם
   שורות diff, ולא ‎<pre>‎ אחד גדול שהוא צומת בודד. */
function editBlock(i) {
  const lines = (p) => Array.from({ length: 14 }, (_, k) => p + ' שורה ' + k).join('\n');
  return {
    type: 'tool', id: 'edit_' + i, name: 'Edit', status: 'ok', isError: false,
    input: { file_path: '/tmp/file' + i + '.js', old_string: lines('ישן'), new_string: lines('חדש') },
    result: 'OK',
  };
}

// טקסט החשיבה מסתיים ב-‎\n\n‎ כמו בפועל — זה מה שמייצר את התצוגה המקדימה הריקה
const thinkBlock = (i) => ({ type: 'thinking', text: 'מחשבה מספר ' + i + '\n' + bigText(4) + '\n\n', tokens: 120 });
const textBlock = (i) => ({ type: 'text', text: 'תשובה מספר ' + i + ' עם `קוד` ו**הדגשה**.' });

function makeConv(id, turns) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', text: 'בקשה מספר ' + i });
    messages.push({
      role: 'assistant', model: 'sonnet',
      blocks: [thinkBlock(i), textBlock(i), toolBlock(i * 2), editBlock(i), toolBlock(i * 2 + 1)],
    });
  }
  return {
    id, title: 'שיחת בדיקה ' + id, sessionId: null, cwd: '/tmp', draft: '',
    cost: 0, createdAt: Date.now() - 1000, updatedAt: Date.now(), rev: 1, messages,
  };
}

const CONV = makeConv('test-big-1', 12);      // 24 הודעות, 12×(1 חשיבה + 3 כלים) = 48 כרטיסים
const PORT = freePort();

const srv = await startServer({ port: PORT, conversations: [CONV] });
const br = await launch();
const page = await newPage(br);
const cleanup = async () => { try { await page.close(); } catch {} try { await br.close(); } catch {} srv.stop(); };
process.on('exit', () => srv.stop());

try {
  await page.goto(srv.url);
  await page.waitFor('typeof renderConversation === "function" && storeReady && store.convs.length > 0');
  await page.eval(`(async () => {
    const c = store.convs.find((x) => x.id === '${CONV.id}');
    await ensureLoaded(c.id); activeId = c.id; renderConversation();
  })()`);

  // -------------------------------------------------------------------------
  t.section('מה שנבנה ומה שלא');
  {
    const r = await page.eval(`(() => {
      const log = document.getElementById('log');
      const det = [...log.querySelectorAll('details')];
      const bodies = det.map((d) => d.querySelector('.tbody')).filter(Boolean);
      return {
        cards: det.length,
        open: det.filter((d) => d.open).length,
        emptyTools: bodies.filter((b) => b.children.length === 0).length,
        emptyThink: det.filter((d) => d.querySelector('.think') && !d.querySelector('.think').innerHTML).length,
        names: det.filter((d) => (d.querySelector('.tname') || {}).textContent).length,
        previews: det.filter((d) => ((d.querySelector('.tprev') || {}).textContent || '').trim()).length,
      };
    })()`);
    t.eq('נוצרו הכרטיסים', r.cards, 48);
    t.eq('וכולם סגורים', r.open, 0);
    // ל-‎tbody‎ של כרטיס חשיבה יש תמיד ילד אחד — ה-‎.think‎ עצמו; מה שנמדד
    // בו הוא שהוא ריק מתוכן.
    t.eq('גופי כרטיסי הכלים ריקים', r.emptyTools, 36);
    t.eq('וגופי החשיבה ריקים מתוכן', r.emptyThink, 12);
    // הדחייה נוגעת לגוף בלבד: הכותרת היא מה שנראה, והיא חייבת להיות מלאה
    t.eq('אבל לכולם יש שם', r.names, 48);
    t.eq('ולכולם תצוגה מקדימה', r.previews, 48);
  }

  // -------------------------------------------------------------------------
  t.section('פתיחה בונה את הגוף');
  {
    const r = await page.eval(`(async () => {
      const log = document.getElementById('log');
      const card = [...log.querySelectorAll('details')].find((d) => (d.querySelector('.tname') || {}).textContent === 'Bash');
      const before = card.querySelector('.tbody').children.length;
      card.open = true;
      await new Promise((r) => setTimeout(r, 120));
      const after = card.querySelector('.tbody').children.length;
      const text = card.querySelector('.tbody').textContent;
      card.open = false; await new Promise((r) => setTimeout(r, 60));
      const closed = card.querySelector('.tbody').children.length;
      card.open = true;  await new Promise((r) => setTimeout(r, 60));
      return { before, after, closed, again: card.querySelector('.tbody').children.length,
               hasResult: text.includes('ZEBRAFISH'), hasInput: text.includes('echo') };
    })()`);
    t.eq('לפני הפתיחה — ריק', r.before, 0);
    t.ok('אחרי הפתיחה — נבנה', r.after > 0, r);
    t.ok('ויש בו את התוצאה', r.hasResult, r);
    t.ok('ואת הקלט', r.hasInput, r);
    // סגירה אינה מוחקת: בנייה מחדש בכל פתיחה הייתה הופכת כל לחיצה ליקרה
    t.eq('סגירה לא מרוקנת', r.closed, r.after);
    t.eq('ופתיחה שוב לא בונה מחדש', r.again, r.after);
  }

  // -------------------------------------------------------------------------
  t.section('כרטיס חשיבה');
  {
    const r = await page.eval(`(async () => {
      const log = document.getElementById('log');
      const card = [...log.querySelectorAll('details')].find((d) => (d.querySelector('.tname') || {}).textContent === 'חשיבה');
      const prev = (card.querySelector('.tprev') || {}).textContent || '';
      const before = card.querySelector('.think').innerHTML.length;
      card.open = true;
      await new Promise((r) => setTimeout(r, 120));
      return { prev: prev.trim().length, before, after: card.querySelector('.think').innerHTML.length,
               text: card.querySelector('.think').textContent.includes('מחשבה מספר') };
    })()`);
    t.ok('התצוגה המקדימה הייתה שם כל הזמן', r.prev > 0, r);
    t.eq('הגוף היה ריק', r.before, 0);
    t.ok('ונבנה בפתיחה', r.after > 0, r);
    t.ok('עם התמליל המלא', r.text, r);
  }

  // -------------------------------------------------------------------------
  /* החיפוש סורק ‎TreeWalker‎ על טקסט שב-DOM. בלי בנייה מקדימה הוא היה מפספס
     את כל מה שלא נפתח ביד — כלומר את רוב התמליל. */
  t.section('חיפוש מוצא גם במה שמעולם לא נפתח');
  {
    const r = await page.eval(`(() => {
      renderConversation();   // מתחילים נקי — הכול סגור וריק
      const log = document.getElementById('log');
      const empty = () => [...log.querySelectorAll('.tbody')].filter((b) => b.children.length === 0).length;
      const emptyBefore = empty();
      runFind('ZEBRAFISH7');
      return { emptyBefore, hits: findState.marks.length, emptyAfter: empty() };
    })()`);
    t.eq('לפני החיפוש גופי הכלים ריקים', r.emptyBefore, 36);
    t.ok('החיפוש מצא את המחרוזת שבגוף', r.hits > 0, r);
    t.eq('ובנה את כל הגופים לשם כך', r.emptyAfter, 0);
  }

  // -------------------------------------------------------------------------
  /* המספרים שבזכותם הדחייה קיימת. הסף רופף בכוונה — זו בדיקת אי-רגרסיה על
     סדר הגודל, לא נעילה של מדידה שתלויה במכונה. */
  t.section('הרווח בפועל');
  {
    const r = await page.eval(`(() => {
      renderConversation();
      const log = document.getElementById('log');
      const lazy = log.querySelectorAll('*').length;
      flushBodies(log);
      const full = log.querySelectorAll('*').length;
      return { lazy, full, saved: +(100 - lazy / full * 100).toFixed(0) };
    })()`);
    // 35% הוא רצפה לזיהוי רגרסיה, לא היעד: בשיחה מלאכותית החיסכון 44%,
    // ובשיחות האמיתיות שנמדדו כאן 55%. אם הדחייה תישבר המספר יצנח לאפס.
    t.ok('הציור בונה הרבה פחות צמתים', r.lazy < r.full * 0.65, r);
    t.ok('והחיסכון מהותי', r.saved >= 35, r);
    console.log(`      ${r.lazy} צמתים במקום ${r.full} — ${r.saved}% פחות`);
  }

  // -------------------------------------------------------------------------
  t.section('בלי שגיאות');
  {
    const errs = page.errors();
    t.eq('הקונסולה נקייה', errs.map((e) => String(e.text).slice(0, 120)), []);
  }
} catch (e) {
  console.log('\n  ✗ הבדיקה נפלה: ' + e.message);
  console.log('     ' + JSON.stringify(page.logs.slice(-5)));
  await cleanup();
  process.exit(1);
}

await cleanup();
t.done();
