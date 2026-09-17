/**
 * דפדפן אמיתי לבדיקות, דרך Chrome DevTools Protocol.
 *
 * ‎harness.mjs‎ מסביר למה אין כאן jsdom: מה שנשבר בממשק הזה הוא *מדידה*,
 * ו-jsdom מחזיר 0 בכל מדידה. מנוע הפריסה הקטן שם פותר את זה לשורת הכתיבה,
 * שבה ההחלטות נגזרות ממספר קטן של מדדים ידועים. יש שאלות שהוא לא יכול לענות
 * עליהן — כמה צמתים באמת נבנו, מה עולה ציור של תמליל בן 50 הודעות, והאם
 * ‎<details>‎ שנפתח באמת יורה ‎toggle‎ — ובשבילן צריך מנוע אמיתי.
 *
 * אין תלות חדשה ב-‎package.json‎: הנהיגה היא WebSocket (‎ws‎ כבר כאן) מול
 * דפדפן שמותקן ממילא על המכונה, בדיוק כמו ב-‎tools/build-icons.mjs‎. אם אין
 * דפדפן — ‎findBrowser()‎ מחזיר null והבדיקה מדלגת במקום להיכשל, כי
 * ‎npm test‎ חייב לעבוד גם על מכונה בלי ממשק גרפי.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const CANDIDATES = [
  process.env.SOL_TEST_BROWSER,
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/brave-browser', '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
];

/** הנתיב לדפדפן מבוסס-Chromium שמותקן כאן, או null. */
export function findBrowser() {
  for (const c of CANDIDATES) {
    if (!c) continue;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return null;
}

/**
 * מרים דפדפן ללא ראש. ‎close()‎ חייב להיקרא — ‎brave-browser‎ ודומיו הם
 * עטיפות shell, ו-SIGKILL עליהן משאיר את הדפדפן עצמו רץ; ‎Browser.close‎
 * דרך ה-WebSocket הראשי הוא מה שסוגר אותו באמת.
 */
export async function launch({ port = 0, width = 412, height = 915 } = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error('אין דפדפן');
  // פורט 0 מבקש מהמערכת פורט פנוי, אבל CDP צריך מספר ידוע מראש — לכן
  // בוחרים אקראית בטווח גבוה ומנסים שוב אם תפוס.
  const p = port || 9200 + Math.floor(Math.random() * 600);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-cdp-'));
  const proc = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--ignore-certificate-errors', '--allow-insecure-localhost',
    '--user-data-dir=' + dir, '--remote-debugging-port=' + p,
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });

  let ver = null;
  for (let i = 0; i < 120; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json(); break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ver) { try { proc.kill('SIGKILL'); } catch {} throw new Error('הדפדפן לא עלה: ' + err.slice(0, 300)); }

  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.once('open', res); bws.once('error', rej); });

  return {
    bin, port: p, version: ver.Browser,
    async close() {
      try { bws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch {}
      await new Promise((r) => setTimeout(r, 400));
      try { bws.close(); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** לשונית חדשה. ‎logs‎ אוסף שגיאות קונסולה וחריגות — בדיקה אמורה לבדוק גם אותן. */
export async function newPage(br) {
  const t = await (await fetch(`http://127.0.0.1:${br.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  let id = 0;
  const waits = new Map();
  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && waits.has(m.id)) {
      const w = waits.get(m.id); waits.delete(m.id);
      m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push({ type: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description).join(' ') });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push({ type: 'exception', text: d?.exception?.description || d?.text || '' });
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; waits.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  /* בלי זה ‎:focus‎ לעולם אינו מתקיים בדפדפן ללא ראש — החלון עצמו אינו
     ממוקד, ולכן ‎el.focus()‎ מעדכן את ‎document.activeElement‎ אבל *לא* מפעיל
     את הפסבדו-קלאס. בדיקת חיווי פוקוס בלי השורה הזאת מדווחת שאין טבעת מיקוד
     בשום מקום, וזה מסקנה שגויה שנראית מדאיגה מאוד. */
  try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}

  return {
    send, logs,
    /** שגיאות בלבד — הודעות ‎console.log‎ רגילות אינן כישלון. */
    errors() { return logs.filter((l) => l.type === 'error' || l.type === 'exception'); },
    async goto(url) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 200; i++) {
        try {
          const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          if (r.result.value === 'complete') return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('הדף לא סיים להיטען: ' + url);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('JS: ' + (d.exception?.description || d.text));
      }
      return r.result.value;
    },
    async waitFor(expr, ms = 20000) {
      const t0 = Date.now();
      for (;;) {
        if (await this.eval(expr)) return true;
        if (Date.now() - t0 > ms) throw new Error('תנאי לא התקיים בזמן: ' + expr);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    /** מקש יחיד. ‎modifiers‎: 1=Alt 2=Ctrl 4=Meta 8=Shift (סכום). */
    async key(k, modifiers = 0) {
      const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40 };
      const base = { key: k, code: k, windowsVirtualKeyCode: codes[k] || 0, modifiers };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await new Promise((r) => setTimeout(r, 40));
    },
    /** קליק אמיתי במרכז האלמנט, ולא ‎el.click()‎ — עובר דרך hit-testing. */
    async click(selector) {
      const box = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null; const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!box) throw new Error('לא נמצא: ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await new Promise((r) => setTimeout(r, 60));
    },
    close() { try { ws.close(); } catch {} return fetch(`http://127.0.0.1:${br.port}/json/close/${t.id}`).catch(() => {}); },
  };
}

/**
 * מרים את השרת האמיתי מול ‎HOME‎ זמני. האחסון נגזר מ-‎os.homedir()‎, ולכן
 * זה מה שמפריד בין הבדיקה לבין השיחות האמיתיות של מי שמריץ אותה — בלי זה
 * ‎npm test‎ היה כותב לתוך ‎~/.claude/rtl-claude‎.
 */
export async function startServer({ port, conversations = [], settings = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-home-'));
  const store = path.join(home, '.claude', 'rtl-claude');
  fs.mkdirSync(path.join(store, 'conversations'), { recursive: true });
  for (const c of conversations) {
    fs.writeFileSync(path.join(store, 'conversations', c.id + '.json'), JSON.stringify(c));
  }
  if (settings) fs.writeFileSync(path.join(store, 'settings.json'), JSON.stringify(settings));

  const root = new URL('..', import.meta.url).pathname;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, HOME: home, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });

  // מחכים שהפורט יענה. ‎fetch‎ מול תעודה חתומה-עצמית נכשל, ולכן מספיק שקרה
  // *משהו* ברמת ה-TCP; ההבדל בין https ל-http נקבע לפי מה שהשרת בחר.
  const net = await import('node:net');
  for (let i = 0; i < 150; i++) {
    const up = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); r(true); });
      s.once('error', () => r(false));
      setTimeout(() => { s.destroy(); r(false); }, 300);
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const https = /HTTPS מאופשר/.test(out);
  return {
    home, proc, out: () => out,
    url: `${https ? 'https' : 'http'}://127.0.0.1:${port}/`,
    stop() {
      try { proc.kill('SIGKILL'); } catch {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

/** פורט פנוי לבדיקה. לא 4173 — שם רץ המופע האמיתי. */
export function freePort() { return 4300 + Math.floor(Math.random() * 400); }
