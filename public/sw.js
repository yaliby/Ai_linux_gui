/* Service worker — קיים כדי שהאפליקציה תהיה ניתנת להתקנה על מסך הבית,
   ולא כדי לעבוד בלי רשת. אין שום טעם ב-offline כאן: Claude, הקבצים והכלים
   נמצאים על המחשב, ובלי חיבור אליו אין מה להריץ.
   לכן: רשת קודם תמיד, והמטמון הוא רק רשת ביטחון לקליפה (HTML/CSS/JS) כדי
   שמסך ריק לא יקפוץ בשנייה שבה ה-Wi-Fi מתחלף לסלולר.
   קריאות API ו-WebSocket לא נכנסות למטמון לעולם. */
const CACHE = 'rtl-claude-shell-v37';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // SHARE_CACHE אינו גרסה של הקליפה אלא תיבת דואר: שיתוף שהמתין בזמן
      // שהאפליקציה התעדכנה היה נמחק כאן לפני שהדף הספיק לאסוף אותו.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- שיתוף אל תוך האפליקציה ----------
   ‎share_target‎ שבמניפסט מוסיף את "Sol עברית" לתפריט השיתוף של הטלפון:
   צילום מסך, קטע טקסט או קישור מכל אפליקציה אחרת נשלחים לכאן כ-POST רב-חלקי.
   הפענוח נעשה *כאן* ולא בשרת, ובכוונה — ‎Request.formData()‎ הוא מנתח
   multipart מובנה בדפדפן, ובלעדיו היה צריך להכניס לפרויקט תלות חדשה רק
   בשביל הנתיב הזה. מה שהתקבל יושב ב-Cache Storage עד שהדף נפתח ולוקח אותו,
   כי ‎303‎ אל הדף הוא ניווט חדש ואי-אפשר לצרף אליו גוף.
   ‎/share‎ אינו נתיב אמיתי בשרת: הוא קיים אך ורק כאן. */
const SHARE_CACHE = 'rtl-claude-share';
const SHARE_MAX_FILES = 6;

async function takeShare(request) {
  const cache = await caches.open(SHARE_CACHE);
  // שיתוף קודם שלא נאסף (הדף נסגר לפני שהספיק) לא מצטרף לזה שעכשיו
  for (const k of await cache.keys()) await cache.delete(k);
  let fd;
  // כתובת מוחלטת: ‎Response.redirect‎ מנתח את הארגומנט כ-URL מלא, ומנוע שלא
  // משלים אותו מול מקור הדף זורק TypeError על כתובת יחסית — כלומר השיתוף
  // היה נבלע בשקט במקום להיפתח.
  const home = new URL('/', self.location.origin).href;
  try { fd = await request.formData(); } catch { return Response.redirect(home, 303); }
  const text = ['title', 'text', 'url'].map((k) => fd.get(k)).filter((v) => typeof v === 'string' && v.trim()).join('\n');
  if (text) await cache.put('/__share/text', new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  const files = fd.getAll('files').filter((f) => f && typeof f === 'object' && (f.type || '').startsWith('image/'));
  let i = 0;
  for (const f of files.slice(0, SHARE_MAX_FILES)) {
    await cache.put('/__share/file/' + i++, new Response(f, {
      headers: { 'Content-Type': f.type, 'X-Share-Name': encodeURIComponent(f.name || 'image') },
    }));
  }
  // ‎303‎ ולא ‎302‎: הופך את הניווט ל-GET, אחרת הדפדפן מנסה לשלוח את ה-POST שוב
  return Response.redirect(new URL('/?share=1', self.location.origin).href, 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname === '/share') {
    e.respondWith(takeShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // מצב חי — אסור שיוגש ממטמון
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // מעדכנים את הקליפה ברקע, כך שגרסה חדשה של app.js נתפסת מיד
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});

/* ---------- התראות ----------
   בדסקטופ `new Notification()` בעמוד עובד, אבל באנדרואיד (וב-PWA מותקן) הוא
   נחסם: שם ההתראה חייבת לצאת מה-Service Worker. לכן app.js מנסה קודם
   showNotification() דרך ה-registration, וכאן יושב מה שקורה בלחיצה.
   בלי ה-handler הזה לחיצה על התראה בטלפון פשוט לא עושה כלום. */
/* ---------- מענה מתוך ההתראה ----------
   בקשת אישור שמגיעה לטלפון נושאת שני כפתורים, ולחיצה עליהם קורית כשהאפליקציה
   סגורה לגמרי: אין דף, אין WebSocket, ואין דרך להחזיר החלטה דרך הזרם הרגיל.
   ה-SW חי גם אז ויכול לעשות fetch — וזה כל מה שצריך. ‎credentials‎ נשאר
   ברירת המחדל (‎same-origin‎), ולכן עוגיית המכשיר נוסעת איתו והשער בצד השרת
   מזהה אותו בדיוק כמו כל בקשה אחרת מהטלפון. */
function answerAsk(data, decision) {
  return fetch('/api/permission-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ convId: data.convId, requestId: data.requestId, decision }),
  }).then(() => {
    // הדפים הפתוחים (אם יש כאלה) מעדכנים את הכרטיס דרך permission_resolved
    // שמגיע מהשרת — כאן רק מנקים את הסימון בכותרת.
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  }).then((wins) => { for (const w of wins) w.postMessage({ type: 'notification-click' }); })
    .catch(() => {});
}

self.addEventListener('notificationclick', (e) => {
  const data = e.notification.data || {};
  e.notification.close();
  // כפתור בתוך ההתראה — עונים ונשארים בחוץ. פתיחת האפליקציה כאן הייתה
  // מבטלת בדיוק את מה שהכפתור בא לחסוך.
  if (e.action === 'allow' || e.action === 'deny') {
    if (data.convId && data.requestId) { e.waitUntil(answerAsk(data, e.action)); return; }
  }
  // new URL עם כתובת מוחלטת מתעלם מהבסיס — אז כתובת חיצונית ב-data הייתה
  // פותחת אתר זר מתוך האפליקציה. נועלים על המקור שלנו.
  let target = new URL('/', self.location.origin);
  try {
    const u = new URL(data.url || '/', self.location.origin);
    if (u.origin === self.location.origin) target = u;
  } catch {}
  e.waitUntil((async () => {
    const wins = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter((w) => { try { return new URL(w.url).origin === self.location.origin; } catch { return false; } });
    // ההודעה הולכת לכל הטאבים — סימון ה-● בכותרת יושב על כל אחד מהם בנפרד,
    // ולנקות רק את זה שקיבל פוקוס משאיר את השאר מסומנים לנצח.
    // ה-focus, לעומת זאת, ניתן לחלון אחד בלבד.
    for (const w of wins) w.postMessage({ type: 'notification-click' });
    if (wins.length) {
      // מעדיפים חלון פתוח — פתיחת טאב חדש על כל התרעה היא באג בפני עצמו.
      // focus רשאי להיכשל (הרשאה, מרחב עבודה אחר) ואסור שיפיל את ה-handler.
      try { await wins[0].focus(); } catch {}
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
