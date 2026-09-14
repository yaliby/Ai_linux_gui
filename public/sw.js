/* Service worker — קיים כדי שהאפליקציה תהיה ניתנת להתקנה על מסך הבית,
   ולא כדי לעבוד בלי רשת. אין שום טעם ב-offline כאן: Claude, הקבצים והכלים
   נמצאים על המחשב, ובלי חיבור אליו אין מה להריץ.
   לכן: רשת קודם תמיד, והמטמון הוא רק רשת ביטחון לקליפה (HTML/CSS/JS) כדי
   שמסך ריק לא יקפוץ בשנייה שבה ה-Wi-Fi מתחלף לסלולר.
   קריאות API ו-WebSocket לא נכנסות למטמון לעולם. */
const CACHE = 'rtl-claude-shell-v2';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
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
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // new URL עם כתובת מוחלטת מתעלם מהבסיס — אז כתובת חיצונית ב-data הייתה
  // פותחת אתר זר מתוך האפליקציה. נועלים על המקור שלנו.
  let target = new URL('/', self.location.origin);
  try {
    const u = new URL(e.notification.data?.url || '/', self.location.origin);
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
