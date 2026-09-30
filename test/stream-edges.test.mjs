/**
 * מסלולי הקצה של התור, בדפדפן אמיתי.
 *   node test/stream-edges.test.mjs
 *
 * ‎stream-render.test.mjs‎ בודק את התור שהצליח. כאן נבדק מה שקורה כשהוא לא:
 * בקשת הרשאה, ביטולה ממכשיר אחר, כלי שנכשל, ניסיון חוזר של ה-API, עצירה
 * (מכסה, קריסה), ופריימים פגומים.
 *
 * אלה בדיוק המסלולים שקשה לייצר ביד — צריך להגיע למכסה, להרוג תהליך באמצע,
 * או לגרום ל-API לשגות — ולכן הם גם אלה שנשארים בלי בדיקה. הזרקת הפריימים
 * ישירות ל-‎handleServer‎ הופכת אותם לזולים, בלי CLI ובלי לשרוף מכסה.
 *
 * הערה על סיום התור: ‎onRemoteBusy‎ *מתעלם במכוון* מ-‎running:false‎ — הפריים
 * הזה מייעץ ולא קובע. מה שמסיים תור הוא ‎result‎ (הצלחה) או ‎exit‎ (התהליך
 * מת). הבדיקה האחרונה כאן נועלת את זה, כי זה בדיוק המקום שבו קל להסיק שיש
 * באג ולתקן מה שלא שבור.
 */
import { runner } from './harness.mjs';
import { findBrowser, launch, newPage, startServer, freePort } from './browser.mjs';

if (!findBrowser()) {
  console.log('\nמסלולי הקצה של התור\n  ⚠ אין דפדפן מבוסס-Chromium — מדלג\n');
  process.exit(0);
}

const t = runner('מסלולי הקצה של התור');

const CONV = {
  id: 'edge-1', title: 'שיחת קצה', cwd: '/tmp', draft: '',
  cost: 0, createdAt: Date.now() - 1000, updatedAt: Date.now(), rev: 1,
  messages: [{ role: 'user', text: 'בקשה' }],
};

const PORT = freePort();
const srv = await startServer({ port: PORT, conversations: [CONV] });
const br = await launch();
const page = await newPage(br);
const cleanup = async () => { try { await page.close(); } catch {} try { await br.close(); } catch {} srv.stop(); };
process.on('exit', () => srv.stop());

const feed = (frames) => page.eval(`(async () => {
  for (const f of ${JSON.stringify(frames)}) { handleServer(f); await new Promise((r) => setTimeout(r, 8)); }
  await new Promise((r) => setTimeout(r, 160));
})()`);
const evt = (e, seq) => ({ kind: 'event', convId: CONV.id, seq, evt: e });
const stream = (event, seq) => evt({ type: 'stream_event', event }, seq);
const reset = () => page.eval(`(async () => {
  const c = store.convs[0];
  c.messages = [{ role: 'user', text: 'בקשה' }];
  c.loaded = true; live = null; streamOwnerId = null; busy = false; awaitingServer = false;
  if (typeof pendingPerms !== 'undefined') pendingPerms.clear();
  activeId = c.id; subId = c.id; renderConversation();
  await new Promise((r) => setTimeout(r, 80));
})()`);

try {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(srv.url);
  await page.waitFor('typeof handleServer === "function" && storeReady && store.convs.length > 0');
  await reset();

  // -------------------------------------------------------------------------
  t.section('בקשת הרשאה');
  {
    await feed([
      { kind: 'busy', convId: CONV.id, running: true, seq: 1 },
      stream({ type: 'message_start' }, 2),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } }, 3),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"rm -rf /tmp/x"}' } }, 4),
      stream({ type: 'content_block_stop', index: 0 }, 5),
      { kind: 'permission', convId: CONV.id, seq: 6, id: 'req1',
        req: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' },
               permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }] } },
    ]);
    const r = await page.eval(`(() => {
      const card = document.querySelector('#log .perm');
      const btns = card ? [...card.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean) : [];
      return { card: !!card, pending: pendingPerms.size, btns,
               text: card ? card.textContent.replace(/\\s+/g, ' ') : '' };
    })()`);
    t.ok('נוצר כרטיס הרשאה', r.card, r);
    t.eq('והוא רשום כממתין', r.pending, 1);
    t.ok('עם «אשר»', r.btns.some((b) => b.includes('אשר')), r.btns);
    t.ok('עם «דחה»', r.btns.some((b) => b.includes('דחה')), r.btns);
    // ההצעה ‎addRules‎ היא מה שהופך את «אשר תמיד» לאפשרי; בלעדיה אין מה לזכור
    t.ok('ועם «אשר תמיד»', r.btns.some((b) => b.includes('תמיד')), r.btns);
    t.ok('והפקודה עצמה מוצגת', r.text.includes('rm -rf /tmp/x'), r.text.slice(0, 90));
  }

  // -------------------------------------------------------------------------
  /* ה-CLI מבטל בקשה כשהוא כבר לא צריך אותה, וגם מכשיר אחר עשוי לענות עליה.
     כרטיס שנשאר על המסך אחרי זה הוא בקשה שאי-אפשר לענות עליה יותר. */
  t.section('ביטול הבקשה מרחוק סוגר את הכרטיס');
  {
    await feed([{ kind: 'permission_cancel', convId: CONV.id, seq: 7, id: 'req1' }]);
    const r = await page.eval(`(() => ({ pending: pendingPerms.size }))()`);
    t.eq('הבקשה כבר לא ממתינה', r.pending, 0);
  }

  // -------------------------------------------------------------------------
  t.section('כלי שנכשל');
  {
    await feed([evt({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'permission denied' }] } }, 8)]);
    const r = await page.eval(`(async () => {
      const card = document.querySelector('#log details.tool');
      const st = card.querySelector('.tstatus');
      card.open = true; await new Promise((r) => setTimeout(r, 120));
      return { text: st.textContent, cls: st.className, body: card.querySelector('.tbody').textContent };
    })()`);
    t.eq('הסטטוס «שגיאה»', r.text, 'שגיאה');
    t.ok('ומסומן ככזה ב-CSS', r.cls.includes('err'), r.cls);
    t.ok('והשגיאה עצמה בגוף', r.body.includes('permission denied'), r.body.slice(0, 80));
  }

  // -------------------------------------------------------------------------
  /* בלי החיווי הזה ניסיון חוזר נראה על המסך כשקט ארוך בלי הסבר, וכשהניסיונות
     נגמרים — כעצירה פתאומית באמצע משפט. */
  t.section('ניסיון חוזר של ה-API נראה על המסך');
  {
    await feed([evt({ type: 'system', subtype: 'api_error', retryAttempt: 2, maxRetries: 5, retryInMs: 4000 }, 9)]);
    const r = await page.eval(`(() => ({
      wt: (document.getElementById('workingText') || {}).textContent || '',
      retry: turnRetry ? { a: turnRetry.attempt, m: turnRetry.max } : null,
    }))()`);
    t.eq('המצב נשמר', r.retry, { a: 2, m: 5 });
    t.ok('והמונה מוצג', /2\s*\/\s*5/.test(r.wt), r.wt);

    // תוכן שחוזר לזרום מסיר את החיווי — אחרת הוא נתקע שם עד סוף התור
    await feed([stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }, 10),
                stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'התאושש' } }, 11)]);
    t.eq('והזרם שחזר מנקה אותו', await page.eval('turnRetry'), null);
  }

  // -------------------------------------------------------------------------
  t.section('עצירה: כרטיס במקום שקט');
  {
    await feed([{ kind: 'halt', convId: CONV.id, seq: 12, reason: 'limit', title: 'הגעת למכסה',
                  detail: '5-hour limit reached', soft: true, model: 'sonnet', at: Date.now() }]);
    const r = await page.eval(`(() => {
      const h = document.querySelector('#log .halt');
      const blocks = (activeConv().messages.at(-1).blocks || []).map((b) => b.type);
      return { card: !!h, soft: h ? h.className.includes('soft') : null,
               text: h ? h.textContent.replace(/\\s+/g, ' ') : '', blocks };
    })()`);
    t.ok('יש כרטיס עצירה', r.card, r);
    t.ok('הכותרת מוצגת', r.text.includes('הגעת למכסה'), r.text.slice(0, 80));
    t.ok('וגם מה שה-CLI אמר', r.text.includes('5-hour limit reached'), r.text.slice(0, 120));
    t.eq('עצירה רכה מסומנת ככזו', r.soft, true);
    t.ok('והיא נשמרת בתמליל ולא רק על המסך', r.blocks.includes('halt'), r.blocks);
  }

  // -------------------------------------------------------------------------
  /* ניתוק באמצע כתיבה היה משאיר משפט קטוע בלי הסבר. עכשיו ההודעה נושאת
     חיווי המתנה, ואם השרת עלה בלי התור — היא נסגרת עם כרטיס «השרת עלה מחדש». */
  t.section('ניתוק באמצע תור: חיווי המתנה ואז סגירה');
  {
    await reset();
    await feed([
      { kind: 'busy', convId: CONV.id, running: true, seq: 1 },
      stream({ type: 'message_start' }, 2),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 3),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'התשובה באמצע' } }, 4),
    ]);
    const waiting = await page.eval(`(() => {
      showAwaitServer();
      const bar = document.querySelector('#log .await-server');
      return {
        banner: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
        awaiting: !!awaitingServer,
        flag: !!(activeConv().messages.at(-1) || {}).awaiting,
        wt: (document.getElementById('workingText') || {}).textContent || '',
      };
    })()`);
    t.ok('יש חיווי על ההודעה', waiting.banner.includes('מחכה שהשרת יעלה'), waiting);
    t.eq('הדגל דולק', waiting.awaiting, true);
    t.eq('וההודעה מסומנת', waiting.flag, true);
    t.ok('וגם פס העבודה', waiting.wt.includes('מחכה שהשרת יעלה'), waiting.wt);

    const resumed = await page.eval(`(() => {
      hideAwaitServer();
      return {
        awaiting: !!awaitingServer,
        banner: !!document.querySelector('#log .await-server'),
        text: [...document.querySelectorAll('#log .md')].map((e) => e.textContent).join(''),
      };
    })()`);
    t.eq('הזרם שחזר מסיר את החיווי', resumed.awaiting, false);
    t.eq('בלי באנר', resumed.banner, false);
    t.ok('והטקסט נשאר', resumed.text.includes('התשובה באמצע'), resumed.text);

    await page.eval('showAwaitServer()');
    const sealed = await page.eval(`(() => {
      closeTurnAfterServerBack();
      const h = document.querySelector('#log .halt');
      const last = activeConv().messages.at(-1);
      return {
        busy,
        awaiting: !!awaitingServer,
        banner: !!document.querySelector('#log .await-server'),
        halt: h ? h.textContent.replace(/\\s+/g, ' ') : '',
        reason: ((last.blocks || []).find((b) => b.type === 'halt') || {}).reason,
      };
    })()`);
    t.eq('אחרי שהשרת עלה המסך משוחרר', sealed.busy, false);
    t.eq('החיווי ירד', sealed.awaiting, false);
    t.eq('בלי באנר המתנה', sealed.banner, false);
    t.ok('יש כרטיס שהשרת עלה', sealed.halt.includes('השרת עלה מחדש'), sealed.halt);
    t.eq('והוא נשמר בתמליל', sealed.reason, 'server_restart');
    t.ok('עם כפתור המשך', sealed.halt.includes('המשך'), sealed.halt);
  }

  // -------------------------------------------------------------------------
  /* המקום שהכי קל לטעות בו. ‎running:false‎ *מתעלמים* ממנו במכוון, ומה
     שמסיים תור הוא ‎result‎ או ‎exit‎. מי שיראה רק את הראשון יסיק שיש באג. */
  t.section('מה באמת מסיים את התור');
  {
    await reset();
    await feed([{ kind: 'busy', convId: CONV.id, running: true, seq: 1 }]);
    await feed([{ kind: 'busy', convId: CONV.id, running: false, seq: 13 }]);
    t.eq('busy:false לבדו אינו מסיים', await page.eval('busy'), true);

    await feed([{ kind: 'exit', convId: CONV.id, seq: 14, code: null, signal: 'SIGKILL' }]);
    t.eq('exit כן מסיים', await page.eval('busy'), false);

    // והמסלול הרגיל: ‎result‎ אחרי תור שהצליח
    await reset();
    await feed([
      { kind: 'busy', convId: CONV.id, running: true, seq: 1 },
      stream({ type: 'message_start' }, 2),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 3),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'טוב' } }, 4),
      stream({ type: 'content_block_stop', index: 0 }, 5),
      stream({ type: 'message_stop' }, 6),
      evt({ type: 'result', subtype: 'success', duration_ms: 1200, total_cost_usd: 0.004,
            usage: { input_tokens: 10, output_tokens: 20 } }, 7),
    ]);
    t.eq('result מסיים', await page.eval('busy'), false);
  }

  // -------------------------------------------------------------------------
  t.section('GOD — כפתור חי תוך כדי תור');
  {
    await reset();
    await feed([
      { kind: 'busy', convId: CONV.id, running: true, seq: 1 },
      stream({ type: 'message_start' }, 2),
      { kind: 'god_allow', convId: CONV.id, seq: 3, entry: {
        id: 'g1', tool: 'Bash', input: { command: 'ls -la /tmp/secret' }, desc: '', at: Date.now(),
      } },
    ]);
    const before = await page.eval(`(() => {
      const btn = document.getElementById('godLiveBtn');
      const panel = document.getElementById('godLivePanel');
      return {
        busy,
        n: godTurn.length,
        btn: !!(btn && !btn.classList.contains('hidden')),
        txt: btn ? btn.textContent.replace(/\\s+/g, ' ') : '',
        panelHidden: !panel || panel.classList.contains('hidden'),
      };
    })()`);
    t.eq('הכפתור מופיע אחרי אישור', before.btn, true);
    t.ok('עם מספר הבקשות', /אחת|1/.test(before.txt), before.txt);
    t.eq('הפאנל סגור עד שלוחצים', before.panelHidden, true);

    await page.eval(`document.getElementById('godLiveBtn').click()`);
    const open = await page.eval(`(() => {
      const panel = document.getElementById('godLivePanel');
      const btn = document.getElementById('godLiveBtn');
      return {
        open: !!(panel && !panel.classList.contains('hidden')),
        expanded: btn && btn.getAttribute('aria-expanded') === 'true',
        text: panel ? panel.textContent.replace(/\\s+/g, ' ') : '',
      };
    })()`);
    t.eq('לחיצה פותחת את הפאנל', open.open, true);
    t.eq('aria-expanded=true', open.expanded, true);
    t.ok('רואים את הכלי', open.text.includes('Bash'), open.text);
    t.ok('ואת הפקודה שאושרה', open.text.includes('ls -la /tmp/secret'), open.text);

    await feed([{ kind: 'god_allow', convId: CONV.id, seq: 4, entry: {
      id: 'g2', tool: 'Read', input: { file_path: '/etc/passwd' }, desc: '', at: Date.now(),
    } }]);
    const liveUp = await page.eval(`(() => {
      const panel = document.getElementById('godLivePanel');
      const btn = document.getElementById('godLiveBtn');
      return {
        n: godTurn.length,
        btn: (btn && btn.textContent || '').replace(/\\s+/g, ' '),
        text: panel ? panel.textContent.replace(/\\s+/g, ' ') : '',
        rows: panel ? panel.querySelectorAll('.god-row').length : 0,
      };
    })()`);
    t.eq('אישור שני מתעדכן בלייב', liveUp.rows, 2);
    t.ok('הכפתור סופר שתיים', /2/.test(liveUp.btn), liveUp.btn);
    t.ok('גם Read מופיע עם הנתיב', liveUp.text.includes('Read') && liveUp.text.includes('/etc/passwd'), liveUp.text);

    await feed([
      stream({ type: 'message_stop' }, 5),
      evt({ type: 'result', subtype: 'success', duration_ms: 100, total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 } }, 6),
    ]);
    const after = await page.eval(`(() => {
      const btn = document.getElementById('godLiveBtn');
      const panel = document.getElementById('godLivePanel');
      const card = document.querySelector('#log .godlog');
      return {
        busy,
        btnHidden: !btn || btn.classList.contains('hidden'),
        panelHidden: !panel || panel.classList.contains('hidden'),
        card: card ? card.textContent.replace(/\\s+/g, ' ') : '',
      };
    })()`);
    t.eq('בסיום התור הכפתור החי נעלם', after.btnHidden, true);
    t.eq('והפאנל נסגר', after.panelHidden, true);
    t.ok('והכרטיס נשאר בתמליל', after.card.includes('Bash') && /2/.test(after.card), after.card);
  }

  // -------------------------------------------------------------------------
  /* פריים פגום מגיע ממש: גרסת שרת אחרת, פריים שנחתך, באג. הוא לא אמור
     להפיל את המסך ולהשאיר את המשתמש בלי ממשק. */
  t.section('פריימים פגומים לא מפילים את המסך');
  {
    const before = await page.eval(`document.querySelectorAll('#log .row').length`);
    await feed([
      evt(null, 20),
      evt({ type: 'stream_event', event: null }, 21),
      evt({ type: 'stream_event', event: { type: 'content_block_delta', index: 99, delta: { type: 'text_delta', text: 'יתום' } } }, 22),
      { kind: 'לא-קיים', convId: CONV.id, seq: 23 },
      evt({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'אין-כזה', content: 'x' }] } }, 24),
      { kind: 'permission', convId: CONV.id, seq: 25, id: 'p9', req: null },
      { kind: 'halt', convId: CONV.id, seq: 26 },
    ]);
    const r = await page.eval(`(() => ({
      alive: typeof handleServer === 'function',
      rows: document.querySelectorAll('#log .row').length,
      composer: !!document.getElementById('input'),
    }))()`);
    t.eq('הממשק חי', r.alive, true);
    t.eq('ותיבת הכתיבה עדיין שם', r.composer, true);
    t.ok('ולא נוצרו שורות רפאים', r.rows <= before + 1, [before, r.rows]);

    // ואחרי כל זה, פריים תקין עדיין עובד
    await feed([stream({ type: 'content_block_start', index: 5, content_block: { type: 'text' } }, 27),
                stream({ type: 'content_block_delta', index: 5, delta: { type: 'text_delta', text: 'עדיין עובד' } }, 28)]);
    const ok = await page.eval(`[...document.querySelectorAll('#log .md')].some((e) => e.textContent.includes('עדיין עובד'))`);
    t.eq('והזרם ממשיך כרגיל', ok, true);
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
