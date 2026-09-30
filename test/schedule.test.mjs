/**
 * הודעות מתוזמנות בתוך סשן.
 *   node test/schedule.test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const {
  MAX_SCHEDULES, MIN_LEAD_MS, MAX_LEAD_MS,
  MAX_HISTORY_GLOBAL, MAX_HISTORY_PER_CONV,
  KIND_LIMIT_RESUME, LIMIT_RESUME_ID, isLimitResume, promptOnly,
  validateSchedule, buildItem, buildLimitResumeItem, scheduleView, persistShape, dueItems,
  buildHistoryEntry, appendHistory, historyView,
} = require('../lib/schedule.js');

const t = runner('הודעות מתוזמנות');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const caps = fs.readFileSync(new URL('../lib/agent-capabilities.js', import.meta.url), 'utf8');

t.section('ולידציה');
{
  const now = 1_700_000_000_000;
  t.eq('פרומפט ריק נדחה', validateSchedule({ text: '  ', at: now + 60_000 }, now).ok, false);
  t.eq('שעה בעבר נדחית', validateSchedule({ text: 'שלום', at: now - 1000 }, now).ok, false);
  t.eq('שעה קרובה מדי נדחית', validateSchedule({ text: 'שלום', at: now + MIN_LEAD_MS - 1 }, now).ok, false);
  t.eq('רחוק מדי נדחה', validateSchedule({ text: 'שלום', at: now + MAX_LEAD_MS + 1 }, now).ok, false);
  t.eq('שעה תקינה עוברת', validateSchedule({ text: 'שלום', at: now + 60_000 }, now).ok, true);
  t.eq('שעה לא מספר נדחית', validateSchedule({ text: 'שלום', at: 'מחר' }, now).ok, false);
}

t.section('בניית פריט ושידור');
{
  const now = Date.now();
  const built = buildItem({
    text: '  בדוק לוגים  ', at: now + 120_000,
    model: 'sonnet', permissionMode: 'god', effort: 'high', cwd: '/tmp',
  }, { by: 'Mac' }, now);
  t.eq('נבנה', built.ok, true);
  t.eq('הטקסט מקוצץ', built.item.msg.text, 'בדוק לוגים');
  t.eq('המודל נצרב', built.item.msg.model, 'sonnet');
  t.eq('ההרשאות נצרבות', built.item.msg.permissionMode, 'god');
  t.eq('השולח נרשם', built.item.by, 'Mac');

  const view = scheduleView([built.item]);
  t.eq('השידור בלי msg המלא', Object.keys(view[0]).sort().join(), 'at,by,effort,id,kind,model,permissionMode,resetsAt,text');
  t.eq('סוג פרומפט', view[0].kind, 'prompt');
  t.ok('הטיימר לא בשידור', !('timer' in view[0]));

  const persisted = persistShape([{ ...built.item, timer: 1 }]);
  t.ok('השמירה בלי טיימר', !('timer' in persisted[0]));
  t.eq('הפרומפט נשמר', persisted[0].msg.text, 'בדוק לוגים');

  t.eq('עדיין לא הגיע הזמן', dueItems([built.item], now).length, 0);
  t.eq('הגיע הזמן', dueItems([built.item], built.item.at).length, 1);
  t.eq('תקרה קיימת', MAX_SCHEDULES, 20);
}

t.section('limit_resume כתזמון');
{
  const now = Date.now();
  const built = buildLimitResumeItem({
    at: now + 120_000, resetsAt: now + 90_000, produced: true, text: 'usage limit',
  });
  t.eq('נבנה', built.ok, true);
  t.eq('מזהה קבוע', built.item.id, LIMIT_RESUME_ID);
  t.eq('סוג', built.item.kind, KIND_LIMIT_RESUME);
  t.ok('מזוהה', isLimitResume(built.item));
  t.eq('פרומפטים בלבד מסננים אותו', promptOnly([built.item]).length, 0);

  const view = scheduleView([built.item]);
  t.eq('השידור נושא kind', view[0].kind, KIND_LIMIT_RESUME);
  t.ok('עם resetsAt', view[0].resetsAt === now + 90_000);

  const persisted = persistShape([built.item]);
  t.eq('נשמר עם kind', persisted[0].kind, KIND_LIMIT_RESUME);

  const bad = buildLimitResumeItem({ at: 0, resetsAt: 0 });
  t.eq('בלי שעה נדחה', bad.ok, false);

  // שעה שכבר עברה מותרת (שחזור אחרי הפעלה מחדש)
  const past = buildLimitResumeItem({ at: now - 1000, resetsAt: now - 5000, produced: false });
  t.eq('שעה בעבר מותרת להמשך־מכסה', past.ok, true);
}

t.section('היסטוריית תזמונים');
{
  const now = Date.now();
  const built = buildItem({ text: 'בדוק', at: now + 60_000 }, {}, now);
  const entry = buildHistoryEntry(built.item, {
    firedAt: now + 60_000, convId: 'c1', title: 'שיחה א', outcome: 'ok',
  });
  t.eq('רשומה עם outcome', entry.outcome, 'ok');
  t.eq('שומרת convId', entry.convId, 'c1');
  t.eq('שומרת kind', entry.kind, 'prompt');

  let hist = [];
  hist = appendHistory(hist, entry);
  t.eq('נוסף לרשימה', hist.length, 1);

  const queued = buildHistoryEntry(built.item, {
    firedAt: now + 61_000, convId: 'c1', title: 'שיחה א', outcome: 'queued',
  });
  hist = appendHistory(hist, queued);
  t.eq('חדש בראש', hist[0].outcome, 'queued');
  t.eq('שניים באותה שיחה', hist.length, 2);

  // תקרה לכל שיחה
  for (let i = 0; i < MAX_HISTORY_PER_CONV + 5; i++) {
    hist = appendHistory(hist, buildHistoryEntry(built.item, {
      firedAt: now + i, convId: 'c1', title: 'א', outcome: 'ok', id: 'x' + i,
    }));
  }
  t.ok('תקרה לשיחה', hist.filter((e) => e.convId === 'c1').length <= MAX_HISTORY_PER_CONV);

  // תקרה גלובלית
  hist = [];
  for (let i = 0; i < MAX_HISTORY_GLOBAL + 10; i++) {
    hist = appendHistory(hist, buildHistoryEntry(built.item, {
      firedAt: now + i, convId: 'c' + i, title: 't', outcome: 'ok', id: 'g' + i,
    }));
  }
  t.eq('תקרה גלובלית', hist.length, MAX_HISTORY_GLOBAL);
  t.eq('historyView שומר שדות', Object.keys(historyView(hist)[0]).sort().join(),
    'at,convId,firedAt,id,kind,outcome,text,title');
}

t.section('השרת משגר ומשמר');

{
  t.ok('מייבא את המודול', /require\('\.\/lib\/schedule'\)/.test(srv));
  t.ok('סשן חדש עם מערך ריק', /schedules:\s*\[\]/.test(srv));
  t.ok('schedule_add מטופל', /msg\.type === 'schedule_add'/.test(srv));
  t.ok('schedule_remove מטופל', /msg\.type === 'schedule_remove'/.test(srv));
  t.ok('נשמר לדיסק', /schedules: persistSchedules/.test(srv));
  t.ok('חוזר אחרי הפעלה מחדש', /armAllSchedules\(s\)/.test(srv));
  t.ok('סשן עם תזמון לא נמחק במנוחה', /s\.schedules && s\.schedules\.length/.test(srv));
  t.ok('תור חי → enqueue', /enqueueTurn\(s, msg, null\)/.test(srv) && /התור מלא — ההודעה המתוזמנת/.test(srv));
  t.ok('מופיע ב-sync', /schedules: scheduleView\(s\.schedules\)/.test(srv));
  t.ok('upsert limit_resume', /function upsertLimitResumeSchedule\(/.test(srv));
  t.ok('onLimitHit מתזמן', /upsertLimitResumeSchedule\(s, s\.limit\)/.test(srv));
  t.ok('fireSchedule מטפל ב-limit_resume', /isLimitResume\(item\)/.test(srv) && /resumeAfterLimit\(s, false\)/.test(srv));
  t.ok('API רשימה מרכזית', /app\.get\('\/api\/schedules'/.test(srv));
  t.ok('API ביטול', /app\.post\('\/api\/schedules\/cancel'/.test(srv));
  t.ok('API הרץ עכשיו', /app\.post\('\/api\/schedules\/run-now'/.test(srv));
  t.ok('API מנקה היסטוריה', /app\.post\('\/api\/schedules\/clear-history'/.test(srv));
  t.ok('תשובה עם pending+history', /schedulesPayload\(\)/.test(srv) && /pending/.test(srv) && /history/.test(srv));
  t.ok('fireSchedule רושם היסטוריה', /recordScheduleFire\(s, item/.test(srv));
  t.ok('קובץ היסטוריה', /schedules-history\.json/.test(srv));
  t.ok('שחזור לא מאבד תזמונים ליד מכסה ישנה', /התור והתזמונים האחרים כן/.test(srv));
  t.ok('דדופ limit_resume', /seenLr|synthetic/.test(srv));
}

t.section('הממשק');
{
  t.ok('כפתור שעון במחבר', /id="schedBtn"/.test(html));
  t.ok('רצועת תזמונים', /id="schedStrip"/.test(html));
  t.ok('טופס תזמון', /function openSchedule\(/.test(app));
  t.ok('שולח schedule_add', /sendQueueCmd\('schedule_add'/.test(app));
  t.ok('צובע מודל והרשאות בטופס', /fillSchedPerms\(/.test(app) && /permissionMode: perm\.value/.test(app));
  t.ok('/later פותח את הטופס', /'\/later':\s*\(arg\)\s*=>\s*openSchedule/.test(app));
  t.ok('/later בתפריט הסלאש', /name: '\/later'/.test(caps) && /name: '\/later'/.test(app));
  t.ok('פעולה בלוח הפקודות', /תזמן הודעה לשעה מדויקת/.test(app));
  t.ok('מסנכרן מ-sync', /onScheduleUpdate\(m\.schedules/.test(app));
  t.ok('כפתור compact מקבל order', /#schedBtn \{ order: 3/.test(css));
  t.ok('ו-tall לא דורס את השליחה', /compose-tall #schedBtn \{ order: 4/.test(css) && /compose-tall #sendBtn \{ order: 6/.test(css));
  t.ok('כפתור סרגל למשימות מתוזמנות', /id="openSchedules"/.test(html));
  t.ok('פאנל מרכזי', /function openAllSchedules\(/.test(app));
  t.ok('מסתיר limit_resume מהרצועה', /kind !== 'limit_resume'/.test(app));
  t.ok('פעולה בלוח הפקודות לרשימה', /משימות מתוזמנות — כל השיחות/.test(app));
  t.ok('מחלק ממתינות/רצו', /ממתינות/.test(app) && /שכבר רצו/.test(app));
  t.ok('normalizeSchedulesPayload', /function normalizeSchedulesPayload\(/.test(app));
  t.ok('paint מקבל pending+history', /normalizeSchedulesPayload\(data\)/.test(app));
  t.ok('ניקוי היסטוריה בממשק', /clear-history/.test(app));
  t.ok('כותרות סעיפים ב-CSS', /sch-section-h/.test(css));
}

import { findBrowser, launch, newPage, startServer, freePort } from './browser.mjs';

if (!findBrowser()) {
  t.done();
  process.exit(0);
}

t.section('בדפדפן — תזמון הודעה');
{
  const CONV = {
    id: 'sched-ui-1', title: 'שיחת תזמון', cwd: '/tmp', draft: '',
    cost: 0, createdAt: Date.now() - 1000, updatedAt: Date.now(), rev: 1,
    messages: [{ role: 'user', text: 'שלום' }],
  };
  const PORT = freePort();
  const srvProc = await startServer({ port: PORT, conversations: [CONV] });
  const br = await launch({ width: 1280, height: 800 });
  const page = await newPage(br);
  const cleanup = async () => { try { await page.close(); } catch {} try { await br.close(); } catch {} srvProc.stop(); };
  process.on('exit', () => srvProc.stop());
  try {
    await page.goto(srvProc.url);
    await page.waitFor('typeof openSchedule === "function" && storeReady && store.convs.length > 0');
    await page.eval(`(async () => {
      const c = store.convs.find((x) => x.id === '${CONV.id}');
      await ensureLoaded(c.id); activeId = c.id; renderConversation();
    })()`);
    await page.waitFor('ws && ws.readyState === 1');

    const vis = await page.eval(`(() => {
      const b = document.getElementById('schedBtn');
      const r = b && b.getBoundingClientRect();
      return !!(b && r && r.width > 0 && r.height > 0);
    })()`);
    t.ok('כפתור השעון נראה', vis);

    await page.click('#schedBtn');
    await page.waitFor('!document.getElementById("modal").classList.contains("hidden") && document.getElementById("schedText")');

    const form = await page.eval(`(() => {
      const modal = document.getElementById('modal');
      return {
        title: document.getElementById('modalTitle').textContent,
        text: !!document.getElementById('schedText'),
        date: !!document.getElementById('schedDate'),
        time: !!document.getElementById('schedTime'),
        perm: !!document.getElementById('schedPerm'),
        model: !!document.getElementById('schedModel'),
        go: !!document.querySelector('.sched-go'),
        hidden: modal.classList.contains('hidden'),
      };
    })()`);
    t.eq('כותרת הטופס', form.title, 'תזמון הודעה');
    t.ok('שדה פרומפט', form.text);
    t.ok('תאריך', form.date);
    t.ok('שעה', form.time);
    t.ok('הרשאות', form.perm);
    t.ok('מודל', form.model);
    t.ok('כפתור תזמן', form.go);

    const at = await page.eval(`(() => {
      const d = new Date(); d.setHours(d.getHours() + 2, 0, 0, 0);
      const pad = (n) => String(n).padStart(2, '0');
      document.getElementById('schedText').value = 'בדוק את הלוגים בערב';
      document.getElementById('schedDate').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      document.getElementById('schedTime').value = pad(d.getHours()) + ':' + pad(d.getMinutes());
      document.querySelector('.sched-go').click();
      return d.getTime();
    })()`);

    await page.waitFor('!document.getElementById("schedStrip").classList.contains("hidden")');
    const strip = await page.eval(`(() => {
      const s = document.getElementById('schedStrip');
      return {
        hidden: s.classList.contains('hidden'),
        text: s.textContent,
        modal: document.getElementById('modal').classList.contains('hidden'),
        btnOn: document.getElementById('schedBtn').classList.contains('on'),
      };
    })()`);
    t.ok('המודאל נסגר', strip.modal);
    t.ok('הרצועה גלויה', !strip.hidden);
    t.ok('עם הפרומפט', /בדוק את הלוגים/.test(strip.text), strip.text);
    t.ok('השעון מסומן כפעיל', strip.btnOn);
    t.ok('השעה בעתיד', at > Date.now(), at);
  } finally {
    await cleanup();
  }
}

t.done();
