'use strict';
/* ==========================================================================
   דחיסת תשובות ה-API
   --------------------------------------------------------------------------
   ‎lib/static-compress.js‎ מטפל בקבצים שעל הדיסק. את מה ש*נבנה* בזמן ריצה הוא
   לא יכול לגעת בו, ושם נמצאו המספרים הגדולים באמת:

     • ‎GET /api/conversations/:id‎ — השיחה הגדולה שעל המכונה הזאת היא גוף
       תשובה של **887KB**. ב-brotli איכות 5: **73KB**, כלומר ‎91.7%‎ פחות.
       זה נשלח בכל מעבר לשיחה, לרוב אל טלפון מעבר ל-Wi-Fi או סלולר.
     • ‎GET /api/config‎ — ‎66KB‎ (341 מודלים מ-OmniRoute) שיורדים ל-‎6KB‎.
     • ‎GET /api/logs‎ — עד 5,000 שורות יומן כטקסט.

   **למה brotli ולא gzip, ודווקא כאן.** על JSON חוזרני brotli לא רק קטן
   בהרבה מ-gzip (73KB מול 207KB) אלא גם *מהיר ממנו* — 7ms מול 15ms על אותם
   887KB. אין כאן שיקול נגדי: הוא מנצח בשני הצירים.

   **איכות 5 ולא 11.** בניגוד לקבצים הסטטיים אין כאן מה למטמן — כל תשובה
   נבנית מחדש, ולכן המחיר נגבה בכל בקשה. איכות 11 הייתה עולה מאות מילישניות
   בשביל אחוזים בודדים.

   הדחיסה א-סינכרונית ורצה על ה-threadpool, ולכן ‎JSON.stringify‎ הוא החלק
   היחיד כאן שחוסם את החוט הראשי — בדיוק כמו קודם.
   ========================================================================== */
const zlib = require('node:zlib');
const crypto = require('node:crypto');

/* מתחת ל-MTU בודד אין מה לחסוך, ויש מה לשלם משני הצדדים. */
const MIN_SIZE = 1024;
const BROTLI_QUALITY = 5;
const GZIP_LEVEL = 6;

/** הקידודים שהלקוח מקבל, מהמועדף ומטה. משותף במהותו ל-static-compress. */
const { acceptedEncodings } = require('./static-compress');

function compress(buf, enc) {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? null : out);
    if (enc === 'br') {
      zlib.brotliCompress(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      }, done);
    } else {
      zlib.gzip(buf, { level: GZIP_LEVEL }, done);
    }
  });
}

/**
 * עוטף ‎res.json‎ ו-‎res.send‎. ‎min‎ — הגודל שמתחתיו לא נוגעים.
 * ‎onError‎ מקבל תקלות דחיסה; בכל מקרה כזה התשובה יוצאת לא דחוסה.
 */
module.exports = function createApiCompress({ min = MIN_SIZE, onError = null } = {}) {
  return function apiCompress(req, res, next) {
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);

    /** מוציא גוף דחוס, או ‎false‎ אם אין טעם/אפשרות. */
    async function emit(body, contentType) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      const order = acceptedEncodings(req.headers['accept-encoding']);
      // ‎Vary‎ גם כשלא דוחסים: בלעדיו מטמון משותף יגיש את התשובה הזאת למי
      // שמצפה לקידוד אחר.
      res.setHeader('Vary', 'Accept-Encoding');
      if (buf.length < min || !order.length || res.getHeader('Content-Encoding')) return false;

      const enc = order[0];
      let out;
      try { out = await compress(buf, enc); } catch (e) { if (onError) onError(e); return false; }
      if (!out || out.length >= buf.length) return false;
      // התשובה נסגרה בינתיים (הלקוח ניתק) — אין למי לכתוב
      if (res.writableEnded || res.headersSent) return true;

      // ה-‎ETag‎ נגזר מהגוף הדחוס: הוא מזהה ייצוג, ושני קידודים אינם אותו
      // ייצוג. הגיבוב על 73KB במקום על 887KB הוא גם פשוט זול יותר.
      const etag = 'W/"' + crypto.createHash('sha1').update(out).digest('base64url').slice(0, 27) + '"';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Encoding', enc);
      res.setHeader('ETag', etag);
      // ‎no-cache‎ = מותר לשמור, אסור להגיש בלי אימות. זה מה שהופך את ה-ETag
      // לשימושי בלי לסכן הגשה של שיחה ישנה.
      res.setHeader('Cache-Control', 'no-cache');

      const inm = req.headers['if-none-match'];
      if (inm && inm.split(',').some((t) => t.trim() === etag)) {
        res.removeHeader('Content-Encoding');
        res.removeHeader('Content-Type');
        res.status(304).end();
        return true;
      }
      res.setHeader('Content-Length', out.length);
      if (req.method === 'HEAD') res.end();
      else res.end(out);
      return true;
    }

    res.json = function (obj) {
      let text;
      try { text = JSON.stringify(obj); } catch { return origJson(obj); }
      if (typeof text !== 'string') return origJson(obj);
      // הדחיסה א-סינכרונית, ולכן ‎res.json‎ חוזר מיד. זה תקין: ‎express‎ אינו
      // דורש שהתשובה תסתיים עד שהוא חוזר, ומי שקורא אחריו כבר לא כותב.
      emit(text, 'application/json; charset=utf-8').then((handled) => {
        if (!handled && !res.writableEnded && !res.headersSent) origJson(obj);
      }).catch(() => { if (!res.writableEnded && !res.headersSent) origJson(obj); });
      return res;
    };

    res.send = function (body) {
      // רק טקסט וגוף בינארי מוכן; אובייקט הולך ל-‎res.json‎ שכבר עטוף למעלה
      if (typeof body !== 'string' && !Buffer.isBuffer(body)) return origSend(body);
      const type = res.getHeader('Content-Type') ||
        (typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/octet-stream');
      emit(body, type).then((handled) => {
        if (!handled && !res.writableEnded && !res.headersSent) origSend(body);
      }).catch(() => { if (!res.writableEnded && !res.headersSent) origSend(body); });
      return res;
    };

    next();
  };
};

module.exports.MIN_SIZE = MIN_SIZE;
module.exports.BROTLI_QUALITY = BROTLI_QUALITY;
