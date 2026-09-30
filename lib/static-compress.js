'use strict';
/* ==========================================================================
   דחיסת נכסים סטטיים
   --------------------------------------------------------------------------
   ‎express.static‎ מגיש את הקבצים כמות שהם. טעינה קרה של הממשק העבירה על החוט
   819KB — ‎app.js‎ 434KB, ‎style.css‎ 161KB, ‎highlight.min.js‎ 127KB,
   ‎index.html‎ 31KB, ועוד. ב-brotli זה ‎199KB‎: ‎76%‎ פחות.

   **למה זה לא רק "טעינה ראשונה".** ה-Service Worker כאן הוא רשת-קודם בכוונה
   (‎public/sw.js‎: "אין שום טעם ב-offline כאן"), והמטמון שלו הוא רק רשת ביטחון.
   כלומר כל שינוי ב-‎app.js‎ — והקליפה הגיעה כבר לגרסה 60 — גורר הורדה מחדש של
   הקליפה כולה. וזה קורה על טלפון, מעבר ל-Wi-Fi ביתי או סלולר, כי בשביל זה
   נבנו הקישור ב-QR והשליטה מרחוק.

   **למה לא ‎compression‎ מ-npm.** החבילה ההיא דוחסת מחדש בכל בקשה. כאן הקבצים
   סטטיים לחלוטין: דוחסים פעם אחת, שומרים בזיכרון, ומאמתים מול ‎mtime‎. זה גם
   מה שמאפשר brotli באיכות 11 — 648ms על ‎app.js‎, מחיר שאי-אפשר לשלם בכל בקשה
   אבל שמשתלם פעם אחת (‎21%‎ טוב יותר מ-gzip 9).

   **למה זה לא חוסם את ה-event loop.** ‎zlib.brotliCompress‎ הא-סינכרוני רץ על
   ה-threadpool של libuv ולא על החוט הראשי. ה-threadpool משרת גם את ‎fs‎ ואת
   הכתיבות של ‎conv-store‎, ולכן ‎MAX_INFLIGHT‎ מגביל ל-2 דחיסות במקביל: יותר
   מזה היה תופס את הבריכה כולה (ברירת המחדל: 4) ומרעיב את הדיסק.

   **הבקשה שגרמה למחדל לא ממתינה.** מי שביקש קובץ שעדיין לא נדחס מקבל אותו
   מיד דרך ‎express.static‎ הרגיל; רק הבקשה הבאה תקבל את הדחוס. לכן הדחיסה
   לעולם אינה מוסיפה השהיה, גם לא באלף הבקשות הראשונות.
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* מתחת ל-MTU בודד הדחיסה חוסכת אפס חבילות ומוסיפה עבודה משני הצדדים. */
const MIN_SIZE = 1024;
/* תקרת קובץ בודד: מה שגדול מזה יוגש כמות שהוא ולא יישמר בזיכרון. */
const MAX_FILE = 8 * 1024 * 1024;
/* תקרת המטמון כולו. הקליפה כולה בשתי קידודים היא ~400KB, אז יש מרווח גדול —
   התקרה קיימת כדי שקובץ שמישהו יזרוק ל-‎public/‎ לא יהפוך לדליפת זיכרון. */
const MAX_CACHE = 64 * 1024 * 1024;
/* ראו למעלה: חצי מה-threadpool, לא יותר. */
const MAX_INFLIGHT = 2;

/* סוגי הקבצים שדחיסה עוזרת להם. PNG/WebP/מפות גופנים כבר דחוסים, ולדחוס
   אותם שוב זה לשרוף מעבד בשביל אחוז. */
const TYPES = new Map([
  ['.js', 'application/javascript; charset=UTF-8'],
  ['.mjs', 'application/javascript; charset=UTF-8'],
  ['.css', 'text/css; charset=UTF-8'],
  ['.html', 'text/html; charset=UTF-8'],
  ['.json', 'application/json; charset=UTF-8'],
  ['.map', 'application/json; charset=UTF-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=UTF-8'],
  ['.xml', 'text/xml; charset=UTF-8'],
]);

/* איכות brotli לפי גודל. 11 הוא הטוב ביותר אבל גדל על-ליניארית בזמן, ומעל
   חצי מגה הוא מחזיק חוט מה-threadpool שניות שלמות. */
function brotliQuality(size) {
  if (size <= 512 * 1024) return 11;
  if (size <= 2 * 1024 * 1024) return 9;
  return 5;
}

/**
 * הקידודים שהלקוח מקבל, מהמועדף לפחות-מועדף. רשימה ריקה = אף אחד.
 * ‎q=0‎ הוא סירוב מפורש ולא חולשה — דפדפן ששולח ‎br;q=0‎ מבקש לא לקבל brotli.
 */
function acceptedEncodings(header) {
  if (!header) return [];
  let br = -1, gzip = -1;
  for (const part of String(header).split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (name !== 'br' && name !== 'gzip' && name !== '*') continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = parseFloat(m[1]);
    }
    if (!(q > 0)) q = 0;
    if (name === 'br') br = Math.max(br, q);
    else if (name === 'gzip') gzip = Math.max(gzip, q);
    else { if (br < 0) br = q; if (gzip < 0) gzip = q; }
  }
  const out = [];
  if (br > 0) out.push(['br', br]);
  if (gzip > 0) out.push(['gzip', gzip]);
  // שוויון נשבר לטובת brotli: הוא הקטן מהשניים.
  out.sort((a, b) => b[1] - a[1] || (a[0] === 'br' ? -1 : 1));
  return out.map((x) => x[0]);
}

/** הקידוד המועדף בלבד, או null. */
function pickEncoding(header) {
  const list = acceptedEncodings(header);
  return list.length ? list[0] : null;
}

/**
 * mounts — ‎[{ prefix, dir }]‎, באותו סדר שבו ‎express.static‎ רשום.
 * now    — שעון מוזרק, לבדיקות.
 */
module.exports = function createStaticCompress({ mounts = [], onError = null } = {}) {
  const roots = mounts
    .map((m) => ({
      prefix: m.prefix === '/' ? '' : String(m.prefix).replace(/\/+$/, ''),
      dir: path.resolve(m.dir),
    }))
    // התאמה הכי-ארוכה-ראשונה: ‎/vendor/marked‎ חייב לנצח את ‎/‎, אחרת הכול
    // ייפתר מול ‎public/‎ וייפול.
    .sort((a, b) => b.prefix.length - a.prefix.length);

  const cache = new Map();          // key → { body, enc, size, mtimeMs, type, etag, atime }
  const inflight = new Map();       // key → true
  const queue = [];
  let cacheBytes = 0;
  let running = 0;

  const stats = { hit: 0, miss: 0, compressed: 0, bytesIn: 0, bytesOut: 0, skipped: 0 };

  /** הנתיב שבבקשה → קובץ אמיתי תחת אחד השורשים, או null. */
  function resolveFile(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes('\0')) return null;
    for (const r of roots) {
      if (r.prefix && !(decoded === r.prefix || decoded.startsWith(r.prefix + '/'))) continue;
      let rest = decoded.slice(r.prefix.length);
      if (!rest || rest === '/') rest = '/index.html';   // כמו ‎express.static‎
      // ‎path.resolve‎ מנטרל ‎..‎, והבדיקה שאחריה סוגרת גם קישור סימבולי החוצה.
      const file = path.resolve(r.dir, '.' + rest);
      if (file !== r.dir && !file.startsWith(r.dir + path.sep)) continue;
      const type = TYPES.get(path.extname(file).toLowerCase());
      if (!type) continue;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      return { file, type, size: st.size, mtimeMs: st.mtimeMs };
    }
    return null;
  }

  function evictTo(limit) {
    if (cacheBytes <= limit) return;
    // הכי-פחות-שימושי-לאחרונה יוצא ראשון. המטמון קטן, מיון מלא זול פה.
    const byAge = [...cache.entries()].sort((a, b) => a[1].atime - b[1].atime);
    for (const [k, v] of byAge) {
      if (cacheBytes <= limit) break;
      cache.delete(k);
      cacheBytes -= v.body.length;
    }
  }

  function pump() {
    while (running < MAX_INFLIGHT && queue.length) {
      const job = queue.shift();
      running++;
      compress(job).finally(() => { running--; pump(); });
    }
  }

  function compress({ key, file, enc, type, size, mtimeMs }) {
    return new Promise((resolve) => {
      fs.readFile(file, (err, raw) => {
        if (err) { inflight.delete(key); return resolve(); }
        // הקובץ השתנה בין ה-‎stat‎ לקריאה — הגרסה הזאת כבר לא רלוונטית.
        if (raw.length !== size) { inflight.delete(key); return resolve(); }
        const done = (e2, body) => {
          inflight.delete(key);
          if (e2 || !body) { if (onError) onError(e2); return resolve(); }
          // דחיסה שלא הרוויחה כלום (קובץ שכבר דחוס בתוכו) — לא שומרים,
          // כדי לא לשלם קידוד ופענוח בשביל כלום.
          if (body.length >= size * 0.95) { stats.skipped++; return resolve(); }
          stats.compressed++; stats.bytesIn += size; stats.bytesOut += body.length;
          cache.set(key, {
            body, enc, type, size, mtimeMs,
            etag: `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}-${enc}"`,
            atime: Date.now(),
          });
          cacheBytes += body.length;
          evictTo(MAX_CACHE);
          resolve();
        };
        if (enc === 'br') {
          zlib.brotliCompress(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality(size),
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
            },
          }, done);
        } else {
          zlib.gzip(raw, { level: 9 }, done);
        }
      });
    });
  }

  function want(key, meta, enc) {
    if (inflight.has(key)) return;
    inflight.set(key, true);
    queue.push({ key, file: meta.file, enc, type: meta.type, size: meta.size, mtimeMs: meta.mtimeMs });
    pump();
  }

  /**
   * מחמם מראש את הקליפה, כדי שגם הבקשה הראשונה תקבל גרסה דחוסה.
   * **gzip לכל הקבצים קודם, ורק אז brotli.** כל ה-gzip יחד נגמרים בעשרות
   * מילישניות, בעוד brotli אחד על ‎app.js‎ לוקח 650ms — סדר הפוך היה מותיר
   * את רוב הקליפה בלי שום דחיסה במשך יותר משנייה אחרי ההפעלה.
   */
  function warm(pathnames) {
    const metas = pathnames.map(resolveFile)
      .filter((m) => m && m.size >= MIN_SIZE && m.size <= MAX_FILE);
    for (const enc of ['gzip', 'br']) {
      for (const meta of metas) want(meta.file + '\0' + enc, meta, enc);
    }
  }

  const middleware = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // ‎Range‎ על גוף דחוס הוא מלכודת נכונות: הטווח שהלקוח מבקש מתייחס לייצוג
    // שהוא כבר מכיר. מוותרים ונותנים ל-‎express.static‎ לטפל.
    if (req.headers.range) return next();

    const meta = resolveFile(req.path);
    if (!meta) return next();

    // ‎Vary‎ נדרש גם על התשובה הלא-דחוסה: בלעדיו מטמון משותף עלול להגיש
    // לדפדפן אחד את מה שנשמר עבור אחר.
    res.setHeader('Vary', 'Accept-Encoding');

    if (meta.size < MIN_SIZE || meta.size > MAX_FILE) return next();
    const order = acceptedEncodings(req.headers['accept-encoding']);
    if (!order.length) return next();

    /* מגישים את הטוב ביותר ש*כבר* קיים, ולא רק את המועדף. brotli באיכות 11
       על ‎app.js‎ לוקח 650ms, ובזמן הזה gzip (13ms) כבר מוכן — בלי הנפילה
       הזאת טעינה ראשונה אחרי הפעלת השרת הייתה מקבלת את הקובץ לא דחוס בכלל,
       וזה בדיוק הרגע שאחרי עדכון, שבו הקליפה נטענת מחדש ממילא. */
    let hit = null, enc = null;
    for (const e of order) {
      const k = meta.file + '\0' + e;
      const c = cache.get(k);
      if (!c) continue;
      if (c.mtimeMs !== meta.mtimeMs || c.size !== meta.size) {   // הקובץ התחלף
        cache.delete(k); cacheBytes -= c.body.length;
        continue;
      }
      hit = c; enc = e; break;
    }
    // המועדף נדחס ברקע גם כשהוגש קידוד אחר, כדי שהבקשה הבאה תקבל אותו
    if (enc !== order[0]) want(meta.file + '\0' + order[0], meta, order[0]);
    if (!hit) {
      stats.miss++;
      return next();                       // הבקשה הזאת לא ממתינה לדחיסה
    }

    stats.hit++;
    hit.atime = Date.now();
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Content-Encoding', enc);
    res.setHeader('Cache-Control', 'public, max-age=0');
    res.setHeader('ETag', hit.etag);
    res.setHeader('Last-Modified', new Date(meta.mtimeMs).toUTCString());

    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === hit.etag)) {
      // ‎304‎ לא נושא גוף, ולכן גם לא ‎Content-Length‎ שמתאר אותו.
      res.removeHeader('Content-Encoding');
      res.removeHeader('Content-Type');
      return res.status(304).end();
    }

    res.setHeader('Content-Length', hit.body.length);
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).end(hit.body);
  };

  middleware.warm = warm;
  middleware.stats = () => ({ ...stats, entries: cache.size, bytes: cacheBytes });
  middleware._internal = { resolveFile, pickEncoding, acceptedEncodings, brotliQuality, cache };
  return middleware;
};

module.exports.acceptedEncodings = acceptedEncodings;
module.exports.pickEncoding = pickEncoding;
module.exports.brotliQuality = brotliQuality;
module.exports.TYPES = TYPES;
module.exports.MIN_SIZE = MIN_SIZE;
