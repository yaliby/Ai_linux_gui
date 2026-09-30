/**
 * הזרמת תור אל תוך המסך, בדפדפן אמיתי.
 *   node test/stream-render.test.mjs
 *
 * ‎ws-sync.test.mjs‎ בודק את צד השרת: seq, יומן חוזר, מנויים. מה שלא נבדק עד
 * כה הוא מה שקורה *אחרי* — ‎handleServer‎ ו-‎handleStream‎ בונים את התשובה
 * חתיכה-חתיכה, וזה המסלול שהמשתמש מבלה בו את רוב הזמן.
 *
 * הפריימים מוזרקים ישירות ל-‎handleServer‎ בדיוק בצורה שבה השרת שולח אותם,
 * ולכן רץ כאן הקוד האמיתי: ‎startBlock‎, ‎deltaBlock‎, ‎stopBlock‎,
 * ‎addToolBlock‎, ‎fillToolResult‎ ו-‎renderConversation‎. אין CLI ואין מודל —
 * זה מה שמאפשר לבדוק גם מסלולים שקשה לייצר (שגיאת כלי, ניסיון חוזר של
 * ה-API), ובלי לשרוף מכסה.
 *
 * מה שנבדק במיוחד: שהתמליל *שורד ציור מחדש*. הבלוקים החיים מוחזקים בזיכרון
 * ומקושרים ל-DOM, ו-‎renderConversation‎ מוחק את ה-DOM הזה ובונה מחדש —
 * ‎detachLiveDom‎/‎rebindLiveDom‎ קיימים בדיוק בשביל התפר הזה.
 */
import { runner } from './harness.mjs';
import { findBrowser, launch, newPage, startServer, freePort } from './browser.mjs';

if (!findBrowser()) {
  console.log('\nהזרמת תור אל המסך\n  ⚠ אין דפדפן מבוסס-Chromium — מדלג\n');
  process.exit(0);
}

const t = runner('הזרמת תור אל המסך');

const CONV = {
  id: 'stream-1', title: 'שיחת הזרמה', cwd: '/tmp', draft: '',
  cost: 0, createdAt: Date.now() - 1000, updatedAt: Date.now(), rev: 1,
  messages: [{ role: 'user', text: 'בקשה ראשונה' }],
};

const PORT = freePort();
const srv = await startServer({ port: PORT, conversations: [CONV] });
const br = await launch();
const page = await newPage(br);
const cleanup = async () => { try { await page.close(); } catch {} try { await br.close(); } catch {} srv.stop(); };
process.on('exit', () => srv.stop());

/** מזרים פריימים דרך ‎handleServer‎, בדיוק כפי שהשרת שולח. */
const feed = (frames) => page.eval(`(async () => {
  for (const f of ${JSON.stringify(frames)}) { handleServer(f); await new Promise((r) => setTimeout(r, 6)); }
  await new Promise((r) => setTimeout(r, 120));
})()`);

const evt = (e, seq) => ({ kind: 'event', convId: CONV.id, seq, evt: e });
const stream = (event, seq) => evt({ type: 'stream_event', event }, seq);

try {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(srv.url);
  await page.waitFor('typeof handleServer === "function" && storeReady && store.convs.length > 0');
  await page.eval(`(async () => {
    const c = store.convs[0]; await ensureLoaded(c.id); activeId = c.id; subId = c.id;
    renderConversation();
  })()`);

  // -------------------------------------------------------------------------
  t.section('טקסט נבנה חתיכה-חתיכה');
  {
    await feed([
      { kind: 'busy', convId: CONV.id, running: true, seq: 1 },
      stream({ type: 'message_start' }, 2),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 3),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'שלום, ' } }, 4),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'זו תשובה ' } }, 5),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '**מודגשת**.' } }, 6),
      stream({ type: 'content_block_stop', index: 0 }, 7),
    ]);
    const r = await page.eval(`(() => {
      const log = document.getElementById('log');
      const md = log.querySelector('.row.assistant .md');
      return { text: md ? md.textContent.trim() : null, bold: !!(md && md.querySelector('strong')),
               rows: log.querySelectorAll('.row').length, busy };
    })()`);
    t.eq('הטקסט הצטבר', r.text, 'שלום, זו תשובה מודגשת.');
    t.ok('ו-markdown עובד', r.bold, r);
    t.eq('יש שורת משתמש ושורת תשובה', r.rows, 2);
    t.eq('והמסך מסומן כעסוק', r.busy, true);
  }

  // -------------------------------------------------------------------------
  t.section('כרטיס כלי: נפתח רץ, נסגר עם תוצאה');
  {
    await feed([
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } }, 8),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la"' } }, 9),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '}' } }, 10),
      stream({ type: 'content_block_stop', index: 1 }, 11),
    ]);
    const running = await page.eval(`(() => {
      const c = document.querySelector('#log details.tool .tstatus');
      return { status: c ? c.textContent : null, cls: c ? c.className : null };
    })()`);
    t.eq('בזמן הריצה מסומן «רץ…»', running.status, 'רץ…');

    await feed([
      evt({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'total 4\ndrwx' }] } }, 12),
    ]);
    const done = await page.eval(`(async () => {
      const card = document.querySelector('#log details.tool');
      const st = card.querySelector('.tstatus');
      card.open = true; await new Promise((r) => setTimeout(r, 120));
      return { status: st.textContent, name: card.querySelector('.tname').textContent,
               prev: card.querySelector('.tprev').textContent,
               body: card.querySelector('.tbody').textContent };
    })()`);
    t.eq('אחרי התוצאה — «הושלם»', done.status, 'הושלם');
    t.eq('שם הכלי', done.name, 'Bash');
    t.ok('התצוגה המקדימה מראה את הפקודה', done.prev.includes('ls -la'), done.prev);
    t.ok('והגוף מכיל את התוצאה', done.body.includes('total 4'), done.body.slice(0, 80));
  }

  // -------------------------------------------------------------------------
  /* התפר שהכי קל לשבור: ‎renderConversation‎ מוחק את ה-DOM שהבלוקים החיים
     מצביעים אליו. בלי ‎rebindLiveDom‎ הדלתא הבאה נכתבת לאלמנט יתום, והתשובה
     פשוט מפסיקה לגדול מול העיניים. */
  t.section('ציור מחדש באמצע התור לא קוטע את הזרם');
  {
    await page.eval('renderConversation(); ');
    await new Promise((r) => setTimeout(r, 120));
    const afterRender = await page.eval(`(() => {
      const md = document.querySelector('#log .row.assistant .md');
      return { text: md ? md.textContent.trim() : null,
               cards: document.querySelectorAll('#log details.tool').length };
    })()`);
    t.eq('מה שכבר נכתב שרד', afterRender.text, 'שלום, זו תשובה מודגשת.');
    t.eq('והכרטיס שרד', afterRender.cards, 1);

    await feed([
      stream({ type: 'content_block_start', index: 2, content_block: { type: 'text' } }, 13),
      stream({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'וגם אחרי הציור מחדש.' } }, 14),
      stream({ type: 'content_block_stop', index: 2 }, 15),
    ]);
    const after = await page.eval(`(() => {
      const mds = [...document.querySelectorAll('#log .row.assistant .md')];
      return { last: mds.length ? mds[mds.length - 1].textContent.trim() : null, count: mds.length };
    })()`);
    t.eq('והדלתא שאחריו נכנסה למסך', after.last, 'וגם אחרי הציור מחדש.');
    t.eq('כבלוק חדש ולא דריסה', after.count, 2);
  }

  // -------------------------------------------------------------------------
  t.section('כרטיס חשיבה בזמן אמת');
  {
    await feed([
      stream({ type: 'content_block_start', index: 3, content_block: { type: 'thinking' } }, 16),
      stream({ type: 'content_block_delta', index: 3, delta: { type: 'thinking_delta', thinking: 'צריך לבדוק משהו.\n' } }, 17),
      stream({ type: 'content_block_stop', index: 3 }, 18),
    ]);
    const r = await page.eval(`(async () => {
      const card = [...document.querySelectorAll('#log details.tool')].find((d) => d.querySelector('.think'));
      if (!card) return { missing: true };
      const prev = card.querySelector('.tprev').textContent.trim();
      card.open = true; await new Promise((r) => setTimeout(r, 120));
      return { prev, body: card.querySelector('.think').textContent.trim() };
    })()`);
    t.ok('נוצר כרטיס חשיבה', !r.missing, r);
    // הבאג שתוקן: טקסט שמסתיים ב-‎\\n‎ החזיר שורה אחרונה ריקה
    t.eq('התצוגה המקדימה אינה ריקה', r.prev, 'צריך לבדוק משהו.');
    t.eq('והגוף מכיל את התמליל', r.body, 'צריך לבדוק משהו.');
  }

  // -------------------------------------------------------------------------
  t.section('סיום התור');
  {
    await feed([
      stream({ type: 'message_delta', usage: { output_tokens: 128 } }, 19),
      stream({ type: 'message_stop' }, 20),
      evt({ type: 'result', subtype: 'success', duration_ms: 2400, total_cost_usd: 0.012,
            usage: { input_tokens: 90, output_tokens: 128 } }, 21),
      { kind: 'busy', convId: CONV.id, running: false, seq: 22 },
    ]);
    const r = await page.eval(`(() => ({
      busy, blocks: (activeConv().messages.at(-1).blocks || []).map((b) => b.type),
      role: activeConv().messages.at(-1).role,
    }))()`);
    t.eq('המסך כבר לא עסוק', r.busy, false);
    t.eq('והתשובה נשמרה בתמליל', r.role, 'assistant');
    t.eq('עם כל הבלוקים לפי הסדר', r.blocks, ['text', 'tool', 'text', 'thinking']);
  }

  // -------------------------------------------------------------------------
  /* ציור מחדש אחרי שהתור נגמר עובר במסלול אחר לגמרי — מהתמליל השמור ולא
     מהבלוקים החיים. אם השניים אינם מסכימים, זה נראה כאן. */
  t.section('הכול שורד ציור מחדש אחרי הסיום');
  {
    await page.eval('renderConversation();');
    await new Promise((r) => setTimeout(r, 200));
    const r = await page.eval(`(() => {
      const log = document.getElementById('log');
      return {
        mds: [...log.querySelectorAll('.row.assistant .md:not(.think)')].map((e) => e.textContent.trim()),
        cards: log.querySelectorAll('details.tool').length,
        rows: log.querySelectorAll('.row').length,
      };
    })()`);
    t.eq('שני בלוקי הטקסט', r.mds, ['שלום, זו תשובה מודגשת.', 'וגם אחרי הציור מחדש.']);
    t.eq('כרטיס כלי וכרטיס חשיבה', r.cards, 2);
    t.eq('שתי שורות', r.rows, 2);
  }

  t.section('בלי שגיאות');
  t.eq('הקונסולה נקייה', page.errors().map((e) => String(e.text).slice(0, 140)), []);
} catch (e) {
  console.log('\n  ✗ הבדיקה נפלה: ' + e.message);
  console.log('     ' + JSON.stringify(page.logs.slice(-5)));
  await cleanup();
  process.exit(1);
}

await cleanup();
t.done();
