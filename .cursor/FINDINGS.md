# Findings

Run start: 2026-09-17 08:08

---

### F01 — שליחה ריקה בלי משוב

קטגוריה: [FEEDBACK]
מסך: composer
viewport: all
ערכה: all
מערכת: —

מטרת המשתמש: להבין למה שלח לא עושה כלום

תרחיש: תיבה ריקה → לחיצה על שלח / Enter

התנהגות נוכחית (לפני): `sendMessage` חוזר בשקט

Evidence: `if (!text && !atts.length) return;` ב-app.js; בדיקה אדומה ב-`ux-composer-a11y.test.mjs`

לפני: 0 אותות למשתמש

השפעה: כפתור ראשי נראה שבור

Root cause: early return בלי toast

Supervisor decision: FIX

תיקון: toast «כתוב הודעה או צרף תמונה»

אחרי: toast בנתיב; test ירוק

Test: `ux-composer-a11y.test.mjs` / שליחה ריקה

Commit: (pending)

מקור: [checklist + Worker A]

---

### F02 — מצב תור: aria-label נשאר «שלח»

קטגוריה: [ACCESSIBILITY]
מסך: composer
viewport: mobile (אין hover)
Evidence: `syncSendAffordance` עדכן רק `title`
Supervisor decision: FIX — `setAttribute('aria-label', btn.title)`
אחרי: aria-label = title במצב תור/מכסה
Test: ux-composer-a11y
מקור: [Worker A]

---

### F03 — עצור 40px במגע

קטגוריה: [RESPONSIVENESS]
Evidence: `.stop { min-height: 40px }` ב-coarse
Supervisor decision: FIX → 44px (פעולת interrupt ראשית תחת לחץ)
לפני: 40px | אחרי: 44px
מקור: [Worker A]

---

### F04 — סיום הכתבה / שפת הכתבה ~22px

קטגוריה: [RESPONSIVENESS]
Evidence: `.dk-lang, .dk-stop { padding: 2px 9px }`
Supervisor decision: FIX → min-height 40px ב-coarse
מקור: [Worker A]

---

### F05 — הסרת פריט מתור 22×22

קטגוריה: [RESPONSIVENESS]
Evidence: `.q-chip .q-rm { width: 22px; height: 22px }`
Supervisor decision: FIX → 36×36 ב-coarse
מקור: [Worker A]

---

### F06 — מיקרופון http: disabled בולע לחיצה

קטגוריה: [FEEDBACK]
Evidence: `btn.disabled = !dictSecure()`; disabled לא מפעיל onclick
Supervisor decision: FIX — aria-disabled + toast ב-dictStart
מקור: [Worker A]

---

### F07 — «תמיד» במצב כהה 2.07:1

קטגוריה: [ACCESSIBILITY]
Evidence: `#fff` על `--good:#74c775` → 2.07:1; אחרי `--on-accent:#08201e` → **8.23:1**
Supervisor decision: FIX
מקור: [Worker B] [חקירה עצמאית]

---

### F08 — `--surface` לא מוגדר ב-tool-rej-btn

קטגוריה: [VISUAL]
Evidence: `var(--surface)` פעם אחת ב-repo, לא ב-`:root`
Supervisor decision: FIX → `var(--panel)`
מקור: [Worker B] [חקירה עצמאית]

---

### F09 — העתקת קוד רק ב-hover

קטגוריה: [ACCESSIBILITY]
Evidence: אין `:focus-within` ל-`.copy-btn`
Supervisor decision: FIX
מקור: [Worker B]

---

### F10 — askBar בלי aria-live

קטגוריה: [ACCESSIBILITY]
Evidence: `#askBar` עם role=status בלי aria-live; שאר הפסים עם polite
Supervisor decision: FIX
מקור: [Worker B]

---

### F11 — Stop רחוק מה-composer (DEFER)

קטגוריה: [DISCOVERABILITY]
Supervisor decision: DEFER — שינוי מבני גדול יותר; לא בסבב הראשון
מקור: [Worker A]

---

### F12 — פילים מוסתרים ב-compose-compact (DEFER)

קטגוריה: [FRICTION]
Supervisor decision: DEFER — התנהגות מכוונת לחיסכון במקלדת; לבחון sheet מאוחר יותר
מקור: [Worker A]

---

### F13 — rebuild מלא של התמליל (DEFER)

קטגוריה: [PERFORMANCE]
Supervisor decision: DEFER — סיכון גבוה, מחוץ לסcope מינימלי
מקור: [Worker B]

---

### F14 — markdown מלא בכל delta (DEFER)

קטגוריה: [PERFORMANCE]
Supervisor decision: DEFER
מקור: [Worker B]

---

### F15 — aria-live על #log בזמן סטרימינג (DEFER)

קטגוריה: [ACCESSIBILITY]
Supervisor decision: DEFER — דורש עיצוב SR זהיר
מקור: [Worker B]
