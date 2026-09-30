/**
 * סרגל עליון בלי כותרת/נקודה, וכפתור מודל שפותח את שלושת הבוררים מעליו.
 *   node test/topbar-pills.test.mjs
 */
import { runner } from './harness.mjs';
import { findBrowser, launch, newPage, startServer, freePort } from './browser.mjs';

if (!findBrowser()) {
  console.log('\nסרגל עליון ובוררים\n  ⚠ אין דפדפן מבוסס-Chromium — מדלג\n');
  process.exit(0);
}

const t = runner('סרגל עליון ובוררים בדפדפן');

const CONV = {
  id: 'topbar-1', title: 'כותרת שאסור שתופיע בסרגל', cwd: '/tmp/rtl-claude', draft: 'שורה\nשנייה',
  cost: 0, createdAt: Date.now() - 1000, updatedAt: Date.now(), rev: 1,
  messages: [{ role: 'user', text: 'שלום' }],
};

const PORT = freePort();
const srv = await startServer({ port: PORT, conversations: [CONV] });
const br = await launch({ width: 360, height: 640 });
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

  t.section('סרגל השיחה');
  {
    const r = await page.eval(`(() => {
      const box = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const s = getComputedStyle(e);
        const b = e.getBoundingClientRect();
        return { display: s.display, w: Math.round(b.width), h: Math.round(b.height), text: (e.textContent || '').trim() };
      };
      return {
        title: box('#convTitle'),
        dot: box('#statusDot'),
        folder: box('#cwdChip'),
      };
    })()`);
    t.eq('הכותרת לא מוצגת', r.title.display, 'none');
    t.eq('ואין לה תיבה', r.title.w, 0);
    t.eq('הנקודה הירוקה לא מוצגת', r.dot.display, 'none');
    t.eq('וגם לה אין תיבה', r.dot.w, 0);
    t.ok('תיקיית העבודה נשארת', r.folder.w > 20 && r.folder.h > 10, r.folder);
  }

  t.section('כפתור מודל אחד — שלושת הבוררים מעליו');
  {
    const r = await page.eval(`(() => {
      const vis = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return s.display !== 'none' && b.width > 8 && b.height > 8;
      };
      const btn = document.getElementById('modelDockBtn');
      const pop = document.getElementById('modelDockPop');
      const perm = document.getElementById('perm');
      const model = document.getElementById('model');
      const effort = document.getElementById('effort');
      const closed = {
        btn: vis(btn),
        pop: vis(pop),
        perm: vis(perm),
      };
      if (typeof openModelDock === 'function') openModelDock();
      const pb = pop.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      const modelWrap = model && model.closest('.pill-wrap');
      const opened = {
        pop: vis(pop),
        perm: vis(perm),
        modelWrap: vis(modelWrap),
        effort: vis(effort && effort.parentElement),
        above: pb.bottom <= bb.top + 2,
        aria: btn.getAttribute('aria-expanded'),
      };
      return { closed, opened };
    })()`);
    t.ok('כפתור המודל גלוי בסרגל', r.closed.btn);
    t.ok('החלונית סגורה בהתחלה', !r.closed.pop);
    t.ok('בורר הרשאות מוסתר כשהחלונית סגורה', !r.closed.perm);
    t.ok('לחיצה פותחת את החלונית', r.opened.pop);
    t.ok('הרשאות גלויות בחלונית', r.opened.perm);
    t.ok('מודל גלוי בחלונית', r.opened.modelWrap);
    t.ok('החלונית מעל הכפתור', r.opened.above, r.opened);
    t.eq('aria-expanded אחרי פתיחה', r.opened.aria, 'true');
  }

  t.section('כפתור המודל חוזר בכתיבה רחבה');
  {
    const r = await page.eval(`(() => {
      closeModelDock({ restoreFocus: false });
      document.body.classList.add('compose-compact', 'compose-tall');
      const btn = document.getElementById('modelDockBtn');
      const b = btn.getBoundingClientRect();
      const s = getComputedStyle(document.getElementById('modelDock'));
      return {
        display: s.display,
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
    })()`);
    t.ok('הכפתור לא מוסתר ב-tall', r.display !== 'none' && r.w > 20 && r.h > 10, r);
  }

  t.section('מחשב — הבוררים פרוסים בשורה, בלי כפתור תפריט');
  {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await page.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'pointer', value: 'fine' },
        { name: 'hover', value: 'hover' },
      ],
    });
    const r = await page.eval(`(() => {
      if (typeof closeModelDock === 'function') closeModelDock({ restoreFocus: false });
      document.body.classList.remove('compose-compact', 'compose-tall');
      const vis = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return s.display !== 'none' && b.width > 8 && b.height > 8;
      };
      const btn = document.getElementById('modelDockBtn');
      const perm = document.getElementById('perm');
      const modelBtn = document.getElementById('model').previousElementSibling;
      const effort = document.getElementById('effort');
      const pop = document.getElementById('modelDockPop');
      const ps = getComputedStyle(pop);
      return {
        btn: vis(btn),
        perm: vis(perm),
        model: vis(modelBtn),
        effortWrap: vis(effort && effort.parentElement && effort.parentElement.style.display !== 'none' ? effort.parentElement : null),
        row: ps.flexDirection,
        pos: ps.position,
        input: document.activeElement && document.activeElement.id,
      };
    })()`);
    t.ok('כפתור התפריט מוסתר', !r.btn, r);
    t.ok('הרשאות גלויות בלי לפתוח תפריט', r.perm, r);
    t.ok('מודל גלוי בלי לפתוח תפריט', r.model, r);
    t.eq('השורה אופקית', r.row, 'row');
    t.eq('בלי מיקום צף', r.pos, 'static');
    t.ok('התיבה לא קיבלה פוקוס', r.input !== 'input', r.input);
  }

  t.section('חלונית בחירת מודל — שם ליד הסימן ולא ליד הכוכב');
  {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await page.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'pointer', value: 'coarse' },
        { name: 'hover', value: 'none' },
      ],
    });
    await page.waitFor('document.querySelector("#model") && document.querySelector("#model").options.length > 2');
    const r = await page.eval(`(() => {
      if (typeof closeModelDock === 'function') closeModelDock({ restoreFocus: false });
      document.body.classList.remove('compose-compact', 'compose-tall');
      openModelPicker(document.getElementById('model'));
      const row = [...document.querySelectorAll('.mp-cols .pl-item')].find((el) => {
        const n = el.querySelector('.mp-name');
        return n && /[A-Za-z]{3,}/.test(n.textContent || '');
      });
      if (!row) return { err: 'אין שורת מודל לטינית' };
      const ic = row.querySelector('.pl-ic');
      const name = row.querySelector('.mp-name');
      const fav = row.querySelector('.mp-fav');
      const range = document.createRange();
      range.selectNodeContents(name);
      const ink = range.getBoundingClientRect();
      const ir = ic.getBoundingClientRect();
      const fr = fav.getBoundingClientRect();
      return {
        label: (name.textContent || '').trim(),
        gapIcon: Math.round(ir.left - ink.right),
        gapFav: Math.round(ink.left - fr.right),
        inkW: Math.round(ink.width),
        nameBoxW: Math.round(name.getBoundingClientRect().width),
        bidi: getComputedStyle(name).unicodeBidi,
        ph: document.getElementById('modelPickerInput').placeholder || '',
        foot: document.getElementById('modelPickerFoot').textContent || '',
        cols: getComputedStyle(document.querySelector('.mp-cols')).columnCount,
        searchRo: document.getElementById('modelPickerInput').readOnly,
        active: document.activeElement && document.activeElement.id,
      };
    })()`);
    t.ok('יש שורת מודל לטינית למדידה', !r.err, r);
    t.ok('הדיו קצר מהתא — אחרת אין מה למדוד', r.inkW > 20 && r.inkW + 12 < r.nameBoxW, r);
    t.ok('השם צמוד לסימן מימין, לא לכוכב משמאל', r.gapIcon < r.gapFav && r.gapIcon < 24, r);
    t.ok('unicode-bidi isolate', /isolate/i.test(r.bidi || ''), r.bidi);
    t.ok('placeholder בלי לטינית', !/[A-Za-z]/.test(r.ph), r.ph);
    t.ok('כותרת תחתונה בלי קיצורי מקלדת', !/Enter|לניווט/.test(r.foot), r.foot);
    t.eq('עמודה אחת', String(r.cols), '1');
    t.ok('שדה החיפוש לא נפתח להקלדה', r.searchRo === true, r.searchRo);
    t.ok('המקלדת לא נפתחת על התיבה', r.active !== 'input' && r.active !== 'modelPickerInput', r.active);
  }
} finally {
  await cleanup();
}

t.done();
