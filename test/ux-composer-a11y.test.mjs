/**
 * משוב composer + נגישות ויזואלית — ממצאי סבב UX.
 *   node test/ux-composer-a11y.test.mjs
 *
 * מכסה:
 * 1. שליחה ריקה חייבת לתת משוב (toast) ולא לחזור בשקט
 * 2. מצב תור על כפתור השליחה מעדכן גם aria-label
 * 3. מיקרופון לא-מאובטח נשאר לחיץ ומסביר (לא disabled ששותק)
 * 4. ניגודיות «תמיד» במצב כהה ≥ 4.5:1
 * 5. כפתורי דחיית כלי לא משתמשים ב־--surface שלא מוגדר
 * 6. יעדי מגע: עצור / סיום הכתבה / הסרת תור
 * 7. כפתור העתקת קוד גלוי ב־focus-within
 * 8. askBar עם aria-live
 */
import fs from 'node:fs';
import { slice, runner } from './harness.mjs';

const t = runner('UX — composer feedback & a11y');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function luminance(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a, b) {
  const L1 = luminance(a), L2 = luminance(b);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}
function darkGood() {
  const m = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  t.ok('בלוק data-theme=dark קיים', !!m);
  const block = m ? m[1] : '';
  const g = block.match(/--good:\s*(#[0-9a-fA-F]{3,8})/);
  return g ? g[1] : null;
}

t.section('שליחה ריקה — משוב');
{
  const snip = app.slice(app.indexOf('async function sendMessage'), app.indexOf('function syncSendAffordance'));
  t.ok('קיים שמירה על שליחה ריקה', /!text\s*&&\s*!atts\.length/.test(snip));
  t.ok('שליחה ריקה קוראת ל-toast', /!text\s*&&\s*!atts\.length[\s\S]{0,120}toast\s*\(/.test(snip));
}

t.section('מצב תור — aria-label');
{
  const snip = slice('function syncSendAffordance()', 'function setBusy(');
  t.ok('syncSendAffordance מעדכן aria-label', /setAttribute\s*\(\s*['"]aria-label['"]/.test(snip) || /ariaLabel\s*=/.test(snip) || /\.ariaLabel\s*=/.test(snip));
}

t.section('מיקרופון לא-מאובטח — לחיץ');
{
  const paint = slice('function dictPaint()', 'for (const id of [\'micBtn\'');
  // אסור: btn.disabled = !dictSecure() — כי disabled בולע את הלחיצה
  t.ok('dictPaint לא משבית את המיקרופון ב-disabled', !/btn\.disabled\s*=\s*!dictSecure\(\)/.test(paint));
  t.ok('dictPaint מסמן aria-disabled כשאין https', /aria-disabled/.test(paint));
}

t.section('ניגודיות .pbtn.always במצב כהה');
{
  const good = darkGood();
  t.ok('--good כהה נמצא', !!good);
  // הדיו על הכפתור חייב להיות כהה מספיק על ירוק בהיר — לא #fff קשיח
  const alwaysRule = css.match(/\.pbtn\.always\s*\{([^}]+)\}/);
  t.ok('כלל .pbtn.always קיים', !!alwaysRule);
  const color = alwaysRule && alwaysRule[1].match(/(?:^|[^-])\bcolor:\s*([^;]+)/);
  const colorVal = color ? color[1].trim() : '';
  t.ok('צבע הדיו אינו #fff קשיח', !!colorVal && colorVal !== '#fff' && colorVal !== '#ffffff');
  // במצב כהה --on-accent = #08201e (דיו כהה על משטח בהיר) — אותו דפוס כמו שליחה
  const ink = /on-accent/.test(colorVal) ? '#08201e'
    : /#08201e|#0[0-9a-f]{5}/i.test(colorVal) ? (colorVal.match(/#[0-9a-fA-F]{6}/) || [])[0]
    : (colorVal.match(/#[0-9a-fA-F]{3,8}/) || [])[0];
  if (good && ink) {
    const ratio = contrast(ink, good);
    t.ok(`ניגודיות תמיד כהה ≥ 4.5 (נמדד ${ratio.toFixed(2)}:1)`, ratio >= 4.5, { ink, good, ratio });
  } else {
    t.ok('ניתן לחשב ניגודיות (דיו+good)', false, { colorVal, good });
  }
}

t.section('כרטיס דחיית כלי — משתנה מוגדר');
{
  t.ok('tool-rej-btn לא משתמש ב־--surface', !/\.tool-rej-btn[^}]*var\(--surface\)/.test(css));
  t.ok('tool-rej-btn משתמש ב־--panel', /\.tool-rej-btn[^}]*var\(--panel\)/.test(css));
}

t.section('יעדי מגע ב־pointer: coarse');
{
  const coarse = css.match(/@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/);
  // הבלוק גדול — ניקח עד ה־media הבא או סוף קובץ בקירוב
  const start = css.indexOf('@media (hover: none), (pointer: coarse)');
  const chunk = css.slice(start, start + 2500);
  t.ok('.stop עם min-height ≥ 44px', /\.stop\s*\{\s*min-height:\s*44px/.test(chunk));
  t.ok('.dk-stop / .dk-lang עם min-height ≥ 40px', /\.dk-(?:lang|stop)[^{]*\{[^}]*min-height:\s*(4[0-9]|[5-9]\d)px/.test(chunk) || /\.dk-lang,\s*\.dk-stop[^{]*\{[^}]*min-height:\s*(4[0-9]|[5-9]\d)px/.test(chunk));
  t.ok('.q-rm מוגדל במגע', /\.q-chip\s+\.q-rm|\.q-rm[^{]*\{[^}]*width:\s*(3[4-9]|[4-9]\d)px/.test(chunk));
}

t.section('העתקת קוד במקלדת');
{
  t.ok('code-wrap:focus-within מציג copy-btn', /\.code-wrap:focus-within\s+\.copy-btn/.test(css));
}

t.section('כפתור העתק לא מכסה את הקוד');
{
  const btn = css.match(/\.copy-btn\s*\{([^}]+)\}/);
  t.ok('כלל .copy-btn קיים', !!btn);
  const body = btn ? btn[1] : '';
  t.ok('copy-btn ממוקם ב-right פיזי', /\bright:\s*\d+px/.test(body));
  t.ok('copy-btn לא נוחת ב-inset-inline-end (שמאל ב-RTL)', !/inset-inline-end/.test(body));
  t.ok('code-wrap משאיר ריפוד עליון לכפתור', /\.code-wrap\s*>\s*pre[^}]*padding-top:\s*(3[6-9]|[4-9]\d)px/.test(css));
}

t.section('askBar — הכרזה');
{
  t.ok('askBar עם aria-live', /id="askBar"[^>]*aria-live=/.test(html) || /id='askBar'[^>]*aria-live=/.test(html));
}

t.section('סטטוס חיבור — פסיל');
{
  const snip = slice('function setStatus(', 'function wsConnected(');
  t.ok('setStatus מעדכן גם את statusPill', /statusPill/.test(snip));
  t.ok('יש wsConnected לדיוק אחרי תור', /function wsConnected\(/.test(app));
}

t.section('מעבר שיחה באמצע תור');
{
  const snip = slice('async function switchConv(', 'function deleteConv(');
  t.ok('toast כשעוזבים תור רץ', /עדיין רץ/.test(snip));
  t.ok('toast כשעוזבים המתנת מכסה', /המתנה למכסה/.test(snip));
}

t.section('קפיצה לתחתית — מגע + שם');
{
  t.ok('jump עם aria-label', /id="jumpBtn"[^>]*aria-label=/.test(html));
  const start = css.indexOf('@media (hover: none), (pointer: coarse)');
  const chunk = css.slice(start, start + 2500);
  t.ok('.jump ≥ 44px במגע', /\.jump\s*\{\s*width:\s*44px;\s*height:\s*44px/.test(chunk));
}

t.section('GOD — title על הבורר');
{
  const snip = slice('function markGodPill()', 'function populatePerms(');
  t.ok('markGodPill מעדכן title לפי GOD', /GOD_HINT/.test(snip) && /sel\.title/.test(snip));
}

t.section('GOD — כפתור חי תוך כדי תור');
{
  t.ok('יש godLiveBtn בפס העבודה', /id="godLiveBtn"/.test(html));
  t.ok('יש פאנל godLivePanel', /id="godLivePanel"/.test(html));
  t.ok('onGodAllow קורא ל-renderWorking', /function onGodAllow\([\s\S]*?renderWorking\(\)/.test(app));
  t.ok('renderWorking מרענן את הכפתור החי', /function renderWorking\([\s\S]*?renderGodLive\(\)/.test(app));
  t.ok('לחיצה פותחת את הפאנל', /godLiveBtn[\s\S]{0,80}toggleGodLive/.test(app));
  t.ok('Escape סוגר את פאנל GOD', /godLivePanel[\s\S]{0,200}closeGodLive/.test(app));
  t.ok('GOD_HINT מזכיר כפתור תוך כדי ריצה', /תוך כדי הריצה/.test(app) && /GOD_HINT/.test(app));
  t.ok('יעד מגע לכפתור החי', /\.god-live-btn\s*\{\s*min-height:\s*44px/.test(css));
}

t.section('שבב התרעות — aria-label');
{
  const snip = slice('function renderNotifyChip()', 'function notifyBlockReason(');
  t.ok('renderNotifyChip כותב aria-label', /aria-label/.test(snip));
}

t.section('כותרת שיחה — clamp בשם מחדש');
{
  const snip = slice('function startRename(', 'function renderConvList(');
  t.ok('rename גוזר עם clamp', /clamp\s*\(\s*v\s*,\s*80\s*\)/.test(snip));
}

t.section('Escape סוגר overlays');
{
  const snip = app.slice(app.indexOf("document.addEventListener('keydown'"), app.indexOf('trackComposerHeight'));
  t.ok('Escape סוגר palette', /Escape[\s\S]*palette[\s\S]*closePalette/.test(snip) || /palette[\s\S]*Escape[\s\S]*closePalette/.test(snip) || /!\$\('palette'\)[\s\S]*closePalette/.test(snip));
  t.ok('Escape סוגר settings', /\$\('settings'\)[\s\S]*hidden/.test(snip));
}

t.section('נוכחות — מכשיר משני');
{
  const snip = slice('function renderPresence(', 'const UI_FIELDS');
  t.ok('מכשיר משני מציע לקחת שליטה', /!isPrimary/.test(snip) && /קח שליטה/.test(snip));
  t.ok('claimPrimary שולח claim_primary', /function claimPrimary\(/.test(app) && /claim_primary/.test(app));
}

t.section('צירוף — ניסיון חוזר');
{
  t.ok('uploadAttachment קיים לניסיון חוזר', /function uploadAttachment\(/.test(app));
  t.ok('צ׳יפ שגיאה מציע ניסיון חוזר', /לחץ לניסיון חוזר/.test(app));
}

t.section('מתג ערכה — משוב');
{
  const a = app.indexOf("$('themeToggle').onclick");
  const snip = app.slice(a, a + 500);
  t.ok('החלפת ערכה מציגה toast', a >= 0 && /toast\(/.test(snip));
}

t.section('ask/limit go — מגע 44');
{
  const start = css.indexOf('@media (hover: none), (pointer: coarse)');
  const chunk = css.slice(start, start + 2800);
  t.ok('.ab-go/.lb-go ≥ 44px', /\.ab-go,\s*\.lb-go\s*\{\s*min-height:\s*44px/.test(chunk));
}

t.section('חיפוש — שימור אחרי render');
{
  const snip = slice('function renderConversation()', 'function convBucket(');
  t.ok('שומרים findQ לפני איפוס', /findQ/.test(snip) && /runFind\(findQ\)/.test(snip));
}

t.section('working מול הרשאה');
{
  const snip = slice('function renderWorking()', 'function markDirty(');
  t.ok('renderWorking מכבד pendingPerms', /pendingPerms/.test(snip) && /permWaiting/.test(snip));
}

t.section('תור — aria-live');
{
  t.ok('queueStrip עם aria-live', /id="queueStrip"[^>]*aria-live=/.test(html));
}

t.section('מקלדת לא כופה stick');
{
  const snip = slice('(function trackVisualViewport()', '})();');
  t.ok('autoScroll בלי force במקלדת', /if\s*\(\s*stick\s*\)\s*autoScroll\s*\(\s*\)/.test(snip));
  t.ok('אין autoScroll(true) ב-viewport', !/autoScroll\s*\(\s*true\s*\)/.test(snip));
}

t.section('ניגודיות text-faint על panel-2 (בהיר)');
{
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const block = root ? root[1] : '';
  const faint = (block.match(/--text-faint:\s*(#[0-9a-fA-F]+)/) || [])[1];
  const panel2 = (block.match(/--panel-2:\s*(#[0-9a-fA-F]+)/) || [])[1];
  t.ok('tokens קיימים', !!(faint && panel2));
  if (faint && panel2) {
    const ratio = contrast(faint, panel2);
    t.ok(`text-faint על panel-2 ≥ 4.5 (נמדד ${ratio.toFixed(2)}:1)`, ratio >= 4.5, { faint, panel2, ratio });
  }
}

t.section('מגירת שיחות — backdrop לחיץ');
{
  t.ok('sideBackdrop בלי hidden שמנטרל display', !/id="sideBackdrop"[^>]*\bhidden\b/.test(html));
}

t.section('בורר מודל — aria');
{
  const snip = slice('function attachModelSearch(', 'function modelPickerItems(');
  t.ok('mp-btn עם aria-haspopup', /aria-haspopup/.test(snip));
  t.ok('open/close מעדכנים aria-expanded', /aria-expanded/.test(snip));
}

t.section('בורר מודל — שם ליד הסימן, לא plaintext');
{
  t.ok('.mp-name isolate', /\.mp-name\s*\{[\s\S]{0,280}unicode-bidi:\s*isolate/.test(css));
  t.ok('.mp-name לא plaintext', !/\.mp-name\s*\{[\s\S]{0,280}unicode-bidi:\s*plaintext/.test(css));
  t.ok('.mp-name מיושר ל-start', /\.mp-name\s*\{[\s\S]{0,500}text-align:\s*start/.test(css));
  t.ok('במגע placeholder עברי בלבד', /inp\.placeholder = isTouch\(\)[\s\S]{0,120}חיפוש מודל…/.test(app));
  t.ok('במגע כותרת בלי Enter/F', /isTouch\(\)\s*\n?\s*\? st\.items\.length \+ ' מודלים · ★ מועדף'/.test(app));
  t.ok('בטלפון עמודה אחת', /\.mp-cols\s*\{\s*column-width:\s*auto;\s*columns:\s*1/.test(css));
  t.ok('עמודה אחת לא נכפית בשכיבה רחבה', /@media \(max-width: 760px\)\s*\{[\s\S]{0,80}\.mp-cols\s*\{\s*column-width:\s*auto;\s*columns:\s*1/.test(css));
}

t.section('bidi — פס שאלה, placeholder, פקודות');
{
  t.ok('#askBarText isolate ולא plaintext', /\.ask-bar #askBarText[^}]*unicode-bidi:\s*isolate/.test(css)
    && !/\.ask-bar #askBarText[^}]*unicode-bidi:\s*plaintext/.test(css));
  t.ok('placeholder קצר מבודד את Claude', /הודעה ל\\u2066Claude\\u2069/.test(app));
  t.ok('.ac-name הוא LTR מבודד', /\.ac-name\s*\{[^}]*direction:\s*ltr[^}]*unicode-bidi:\s*isolate/.test(css)
    || /\.ac-name\s*\{[^}]*unicode-bidi:\s*isolate[^}]*direction:\s*ltr/.test(css));
}

t.section('moreBtn — גילוי');
{
  t.ok('moreBtn מזכיר חיפוש/הגדרות', /id="moreBtn"[^>]*(חיפוש|הגדרות)/.test(html));
  t.ok('moreBtn עם aria-expanded', /id="moreBtn"[^>]*aria-expanded=/.test(html));
}

t.section('שמירה נכשלה — toast');
{
  const snip = slice('function setSaveState(', '// ---------- טעינה מהשרת');
  t.ok('שגיאת שמירה מציגה toast', /error[\s\S]{0,200}toast\(/.test(snip));
}

t.section('dropzone — ביטול');
{
  t.ok('hideDropzone קיים', /function hideDropzone|const hideDropzone/.test(app));
  t.ok('Escape סוגר dropzone', /dropzone[\s\S]{0,80}hideDropzone/.test(app));
}

t.section('stale מול חושב');
{
  const snip = slice('function renderStale()', 'function pingSocket(');
  t.ok('stale משנה workingText', /נראה תקוע/.test(snip));
}

t.section('statusbar mobile ellipsis');
{
  t.ok('#sbContext עם ellipsis במובייל', /#sbContext\s*\{[^}]*text-overflow:\s*ellipsis/.test(css));
}

t.section('AC scrollIntoView');
{
  const snip = slice('function renderAc()', 'function acceptAc(');
  t.ok('פריט נבחר נגלל לטווח', /scrollIntoView/.test(snip));
}

t.section('עצור בלי חיבור');
{
  const snip = slice('function interruptTurn()', 'function abandonTurn(');
  t.ok('interruptTurn מציג toast בלי WS', /toast\(/.test(snip) && /manualCheck/.test(snip));
}

t.section('resync מגע');
{
  const start = css.indexOf('@media (hover: none), (pointer: coarse)');
  const chunk = css.slice(start, start + 2800);
  t.ok('.resync ≥ 44px', /\.resync\s*\{\s*min-height:\s*44px/.test(chunk));
}

t.section('סבב 2 — אנונימי × עם אישור');
{
  const snip = slice('function deleteConv(', 'function updateStatusbar(');
  t.ok('deleteConv קורא leaveAnon/anonLeaveOk', /leaveAnon|anonLeaveOk/.test(snip));
}

t.section('סבב 2 — שימור גלילה ב-renderConversation');
{
  const snip = slice('function renderConversation(', '// ---------- סרגל שיחות');
  t.ok('preserveScroll כש־!stick', /preserveScroll\s*=\s*!stick/.test(snip));
  t.ok('מחזיר scrollTop אחרי רינדור', /log\.scrollTop\s*=\s*savedTop/.test(snip));
}

t.section('סבב 2 — מעבר שיחה מאפס stick');
{
  const snip = slice('async function switchConv(', 'function deleteConv(');
  t.ok('switchConv מעמיד stick=true', /stick\s*=\s*true/.test(snip));
  t.ok('toast על עזיבת דואט רץ', /הדואט ממשיך ברקע/.test(snip));
}

t.section('סבב 2 — halt נסה שוב');
{
  const snip = slice('function renderHaltCard(', 'function onHalt(');
  t.ok('כפתור נסה שוב ב-halt recoverable', /נסה שוב/.test(snip));
}

t.section('סבב 2 — ייצוא דואט');
{
  const snip = slice('async function exportActiveConv(', '// ---------- חיפוש בתוך השיחה');
  t.ok('ייצוא דואט משתמש ב-duetShownText', /duetShownText/.test(snip));
}

t.section('סבב 2 — טיוטה ממכשיר אחר');
{
  t.ok('toast על קונפליקט טיוטה', /טיוטה עודכנה במכשיר אחר/.test(app));
}

t.section('סבב 2 — usage focus restore');
{
  const snip = slice('function setUsageModalOpen(', 'function toggleUsageModal(');
  t.ok('שומר _returnFocus בפתיחה', /_returnFocus\s*=\s*document\.activeElement/.test(snip));
  t.ok('מחזיר focus בסגירה', /_returnFocus\.focus/.test(snip));
}

t.section('סבב 2 — AC ריק/שגיאה');
{
  const snip = slice('function renderAc()', 'function acceptAc(');
  t.ok('מציג ac-empty', /ac-empty/.test(snip));
  t.ok('הודעת שגיאה נטען', /לא נטען/.test(snip));
  t.ok('CSS ל-.ac-empty', /\.ac-empty\s*\{/.test(css));
}

t.section('סבב 2 — הדבקה/העלאה/GOD');
{
  t.ok('הדבקה בלי קובץ → toast', /לא הצלחתי לקרוא תמונה מהלוח/.test(app));
  t.ok('העלאה נכשלה → toast', /העלאת התמונה נכשלה/.test(app));
  t.ok('בחירת GOD → toast', /מצב GOD — כל בקשת הרשאה/.test(app));
}

t.section('סבב 2 — getCommands מחזיר ok');
{
  const snip = slice('async function getCommands()', 'const fileFetch');
  t.ok('מחזיר { ok, commands }', /ok:\s*(true|false)/.test(snip));
  t.ok('מטמון ריק תקין (cmdCache !== null)', /cmdCache\s*!==\s*null/.test(snip));
}

t.section('סבב 3 — תור/מכסה בלי חיבור');
{
  const clr = slice('function clearQueue()', 'function onQueueUpdate(');
  t.ok('clearQueue דורש חיבור לפני ניקוי', /sendQueueCmd\('queue_clear'\)/.test(clr) && /toast\(/.test(clr));
  t.ok('limitCancel עם toast בלי WS', /limitCancel[\s\S]{0,200}אין חיבור לשרת/.test(app));
  const rq = slice('function renderQueue()', '// ---------- פעולות על הודעה');
  t.ok('הסרת פריט מהתור מדווחת בלי חיבור', /queue_remove[\s\S]{0,120}toast\(/.test(rq));
}

t.section('סבב 3 — toast נגיש');
{
  t.ok('#toasts עם aria-live', /id="toasts"[^>]*aria-live=/.test(html));
}

t.section('סבב 3 — שיתוף / cwd / rewind / ייצוא');
{
  t.ok('כשל שיתוף → toast', /share\.fail[\s\S]{0,120}toast\(/.test(app));
  t.ok('checkCwd catch מעדכן hint', /לא הצלחתי לבדוק את התיקייה/.test(app));
  const rw = slice('async function rewindToMessage(', '// ----------');
  t.ok('rewind Claude דורש confirm', /confirm\(/.test(rw) && /לחתוך את השיחה/.test(rw));
  const ex = slice('async function exportActiveConv(', '// ---------- חיפוש בתוך השיחה');
  t.ok('ייצוא שיחה ריקה → toast', /אין מה לייצא/.test(ex));
}

t.section('סבב 4 — היסטוריית ↑ ופוקוס הגדרות');
{
  const snip = app.slice(app.indexOf("$('input').addEventListener('keydown'"), app.indexOf("$('sendBtn').onclick"));
  t.ok('ArrowUp רק בתיבה ריקה או באמצע דפדוף', /histIdx\s*>=\s*0\s*\|\|\s*!i\.value/.test(snip));
  t.ok('closeSettings מחזיר focus', /function closeSettings\(/.test(app) && /settingsReturnFocus/.test(app));
  t.ok('Escape קורא closeSettings', /Escape[\s\S]{0,80}closeSettings\(/.test(app));
}

t.section('סבב 4 — אישור הרשאה בלי חיבור');
{
  const snip = slice('function decidePermission(', 'function closeAskNotification(');
  t.ok('decidePermission בלי WS לא סוגר כרטיס', /אין חיבור לשרת/.test(snip) && /return;/.test(snip));
  t.ok('שולח permission רק אחרי בדיקת WS', /readyState\s*!==\s*ws\.OPEN[\s\S]{0,200}return/.test(snip));
}

t.section('סבב 5 — דואט משוב');
{
  t.ok('הערת דואט ריקה → toast', /כתוב הערה לפני השליחה/.test(app));
  t.ok('שמירת דואט ריק → toast', /אין תוצר לשמירה עדיין/.test(app));
  t.ok('כשל טעינת גרסה → toast', /טעינת הגרסה נכשלה/.test(app));
}

t.section('סבב 6 — מגע וחיפוש');
{
  const start = css.indexOf('@media (hover: none), (pointer: coarse)');
  const chunk = css.slice(start, start + 3200);
  t.ok('.icon-btn ≥ 44px במגע', /\.icon-btn\s*\{\s*width:\s*44px/.test(chunk));
  t.ok('.cwd-chip ≥ 44px במגע', /\.cwd-chip\s*\{\s*min-height:\s*44px/.test(chunk));
  t.ok('חיפוש שיחות נכשל → toast', /חיפוש בגוף השיחות נכשל/.test(app));
}

t.section('סבב 7 — שינוי שם במגע');
{
  t.ok('bindTitleRename קיים', /function bindTitleRename\(/.test(app));
  t.ok('לחיצה ארוכה 500ms', /setTimeout\([\s\S]{0,80}startRename[\s\S]{0,40}500\)/.test(app));
  t.ok('renameConvPrompt בלוח פקודות', /שנה שם לשיחה הפעילה/.test(app));
  t.ok('convTitle לחיץ עם role=button', /id="convTitle"[^>]*role="button"/.test(html));
}

t.section('סבב 8 — מגע נוסף ונגישות');
{
  const start = css.indexOf('@media (hover: none), (pointer: coarse)');
  const chunk = css.slice(start, start + 4000);
  t.ok('.notify-chip ≥ 44px', /\.notify-chip\s*\{[^}]*min-height:\s*44px/.test(chunk));
  t.ok('.dt-mini/.dt-go ≥ 44px', /\.dt-mini,\s*\.dt-go\s*\{[^}]*min-height:\s*44px/.test(chunk));
  t.ok('.anon-tools ≥ 44px', /\.anon-tools,\s*\.anon-exit\s*\{[^}]*min-height:\s*44px/.test(chunk));
  t.ok('findCount aria-live', /id="findCount"[^>]*aria-live=/.test(html));
  t.ok('settings role=dialog', /id="settings"[^>]*role="dialog"/.test(html));
  t.ok('settingsToggle aria-expanded', /id="settingsToggle"[^>]*aria-expanded=/.test(html));
  t.ok('closeModelPicker מחזיר focus', /function closeModelPicker\([\s\S]{0,200}btn\.focus/.test(app));
  t.ok('Escape סוגר מגירה', /side-open[\s\S]{0,80}closeDrawer/.test(app));
  t.ok('anonTools aria-pressed', /tools\.setAttribute\(\s*['"]aria-pressed['"]/.test(app));
  t.ok('העתקת דואט ריק → toast', /אין תוצר להעתקה/.test(app));
  t.ok('pair-code הוא button', /el\('button',\s*'pair-code'/.test(app));
  t.ok('histIdx מתאפס בהקלדה', /histIdx\s*=\s*-1;\s*stashDraftSoon/.test(app));
}

t.section('סבב 13 — מודאל עם פוקוס');
{
  t.ok('openModal שומר modalReturnFocus', /modalReturnFocus\s*=\s*document\.activeElement/.test(app));
  t.ok('closeModal מחזיר focus', /function closeModal\([\s\S]{0,200}modalReturnFocus/.test(app));
  t.ok('modal role=dialog', /id="modal"[^>]*role="dialog"/.test(html));
  t.ok('duet maxTurns נחתך', /Math\.max\(2,\s*Math\.min\(30/.test(app));
  t.ok('loadConfig toast על כשל', /טעינת הגדרות השרת נכשלה/.test(app));
}

t.section('סבב 14 — מחיקה / דואט / שיתוף / יומן');
{
  const del = slice('function deleteConv(', 'function updateStatusbar(');
  t.ok('מחיקת שיחה דורשת confirm', /confirm\(/.test(del) && /למחוק את/.test(del));
  t.ok('שיחה חדשה מאשרת עצירת תור פעיל', /לעצור אותה ולפתוח שיחה חדשה/.test(app));
  t.ok('דואט ממתין לסנכרון במקום טופס', /_awaitDuetSync/.test(app) && /טוען את מצב הדואט/.test(app));
  t.ok('שיתוף ריק → toast', /השיתוף לא הגיע/.test(app));
  t.ok('העתקת יומן דרך copyText', /copyText\(body\)/.test(app) && /אין יומן להעתקה/.test(app));
}

t.section('סבב 15 — קיצור השקה / לוח / resume');
{
  t.ok('go=new קורא startNewChat', /go === 'new'\)\s*startNewChat\(/.test(app));
  t.ok('closePalette מחזיר focus', /paletteReturnFocus/.test(app));
  t.ok('resumeSession דרך switchConv', /function resumeSession\(/.test(app) && /switchConv\(c\.id\)/.test(app));
  t.ok('מחיקה מהשרת מדווחת בכשל', /המחיקה מהשרת נכשלה/.test(app));
}

t.section('סבב 16 — מחיקה / מגירה / חיפוש בדואט');
{
  const del = slice('function deleteConv(', 'function updateStatusbar(');
  t.ok('מחיקה משחזרת טיוטה בשיחה הבאה', /restoreDraft\(\)/.test(del) && /subscribeActive\(\)/.test(del) && /stick\s*=\s*true/.test(del));
  const remote = slice('function onRemoteConvDeleted(', 'function handleEvent(');
  t.ok('מחיקה מרחוק משחזרת טיוטה', /restoreDraft\(\)/.test(remote) && /stick\s*=\s*true/.test(remote));
  t.ok('לוח פקודות סוגר מגירה לפני הגדרות/חיפוש', /closeDrawer\(\);\s*openSettings\(\)/.test(app) && /closeDrawer\(\);\s*openFind\(\)/.test(app));
  const cf = slice('function closeFind(', 'const SHORTCUTS');
  t.ok('סגירת חיפוש בדואט לא ממקדת את תיבת הקלט', /duet-mode[\s\S]{0,120}findBtn/.test(cf));
}

t.section('סבב 17 — הרשאות / השלמה / מעבר שיחה');
{
  t.ok('jumpToPendingAsk מעדיף AskUserQuestion', /AskUserQuestion[\s\S]{0,80}first\s*=\s*p/.test(app) || /tool === 'AskUserQuestion'/.test(slice('async function jumpToPendingAsk(', 'function notifyQuestion(')));
  t.ok('Enter חוסם גם בקשות אישור', /pendingPerms\.size\s*>\s*0/.test(app) && /בקשת אישור שממתינה/.test(app));
  t.ok('השלמה בטעינה בולמת Enter', /!ac\.items\.length[\s\S]{0,120}Enter/.test(app));
  t.ok('fileFetch בודק q עדכני', /ac\.token\.q === q/.test(app));
  t.ok('לחיצה על התראה קופצת לכרטיס', /notification-click[\s\S]{0,120}jumpToPendingAsk/.test(app));
  t.ok('sync לא מפיל busy של שיחה אחרת', /busy && streamOwnerId === subId/.test(app));
  const del = slice('function deleteConv(', 'function updateStatusbar(');
  t.ok('× על אנונימית פעילה משחזר אח', /leaveAnon\(null\)[\s\S]{0,200}subscribeActive|newConv/.test(del));
  t.ok('אופליין+עסוק מסביר שלא ניתן לשרשר', /לא ניתן לשרשר הודעה לתור/.test(app));
}

t.section('סבב 18 — מודאל / שליחה / Escape / שיתוף');
{
  t.ok('openModal מלכודת Tab', /onModalKeydown/.test(app) && /modalFocusables/.test(app));
  t.ok('sendMessage חוסם כשיש pendingPerms', /pendingPerms && pendingPerms\.size > 0/.test(slice('async function sendMessage(', 'function syncSendAffordance(')) || /pendingPerms\.size > 0[\s\S]{0,200}jumpToPendingAsk/.test(app));
  t.ok('sync סוגר כרטיסים שנענו מרחוק', /!live\.has\(id\)\) closePermission/.test(app) || /closePermission\(id, 'ended'\)/.test(app));
  t.ok('ספירת מכסה מתעדכנת כל שנייה', /setInterval\(renderLimitBar,\s*1000\)/.test(app));
  t.ok('Ctrl+F סוגר לוח לפני חיפוש', /closePalette\(\)[\s\S]{0,120}openFind\(\)/.test(app));
  t.ok('שיתוף לא-תמונה מדווח', /ניתן לצרף תמונות בלבד/.test(app));
  const escBlock = slice("mod && (e.key === 'f'", 'trackComposerHeight');
  const iPal = escBlock.indexOf('closePalette');
  const iSet = escBlock.indexOf('closeSettings');
  t.ok('Escape סוגר palette לפני settings', iPal >= 0 && iSet > iPal);
}

t.section('סבב 19 — מכסה / rewind / תיקייה / pair');
{
  t.ok('usage modal מלכודת Tab', /onUsageModalKeydown/.test(app) && /usageFocusables/.test(app));
  t.ok('rewind מדווח על ביטול תור', /פרומפטים בתור בוטלו/.test(app));
  t.ok('loadDirs משבית בחירה בכשל', /pick\.disabled\s*=\s*true/.test(slice('async function loadDirs(', 'function checkCwd(')));
  t.ok('קוד pair מושבת אחרי פקיעה', /codeBtn\.disabled\s*=\s*dead|code\.disabled/.test(app) && /פג תוקף/.test(app));
}

t.section('סבב 20 — mermaid / מועדפים / halt');
{
  t.ok('mermaid עם כפתור העתק', /mermaid-wrap[\s\S]{0,200}copy-btn|dataset\.mermaid[\s\S]{0,300}copy-btn/.test(app));
  t.ok('החלפת ערכה מרעננת mermaid', /rethemeMermaid\(\)/.test(app));
  t.ok('מועדף במודל ב-F או click', /e\.key === 'f'[\s\S]{0,200}toggleFavoriteModel/.test(app) && /e\.detail === 0/.test(app));
  t.ok('נסה שוב לוקח הודעת משתמש מהשיחה', /role === 'user'[\s\S]{0,80}last = m\.text/.test(app));
}

t.section('סבב 21 — שליחה כפולה / working live');
{
  t.ok('sendGate מונע שליחה חופפת', /let sendGate = false/.test(app) && /if \(sendGate\) return/.test(app));
  t.ok('Enter מתעלם מ-repeat', /!e\.repeat/.test(app));
  t.ok('working עם aria-live', /id="working"[^>]*aria-live="polite"/.test(html));
}

t.section('שליחה כפולה — socket כפול והד כפול');
{
  const conn = slice('function connect() {', 'function setStatus(');
  t.ok('connect מבטל טיימר onclose קודם', /if \(reconnectTimer\) \{ clearTimeout\(reconnectTimer\)/.test(conn));
  t.ok('connect סוגר את ה-socket הקודם', /prev\.onclose = null/.test(conn) && /prev\.close\(\)/.test(conn));
  t.ok('מאזינים מתעלמים מ-socket ישן', /if \(ws !== sock\) return/.test(conn));
  t.ok('onclose מתזמן דרך reconnectTimer', /reconnectTimer = setTimeout\(connect, 1500\)/.test(conn));
  t.ok('הד user_msg לא מצויר פעמיים לאותו nonce', /seenUserNonces\.has\(m\.nonce\)/.test(app));
  t.ok('כפתור שלח הוא type=button', /id="sendBtn"[^>]*type="button"|type="button"[^>]*id="sendBtn"/.test(html));
  const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  t.ok('user באמצע תור נכנס לתור ולא ל-stdin', /msg\.type === 'user'[\s\S]{0,280}s\.running[\s\S]{0,80}enqueueTurn/.test(srv));
}

t.section('סבב 22 — רגרסיות מגע / פוקוס חיפוש');
{
  t.ok('q-rm לא יורד ל-30 במובייל', /\.q-chip \.q-rm \{ width: 36px; height: 36px/.test(css) && !/\.q-chip \.q-rm \{ width: 30px/.test(css));
  t.ok('lb-go נשאר 44 במובייל', /\.lb-go \{ flex: 1; min-height: 44px/.test(css) && !/\.lb-go \{ flex: 1; min-height: 40px/.test(css));
  t.ok('findInput עם טבעת פוקוס', /\.find-bar input:focus[^{]*\{[^}]*box-shadow/.test(css));
}

t.section('סבב 23 — נוכחות / הכתבה / התראת אישור');
{
  t.ok('נוכחות משנית data-mode=view', /dataset\.mode = 'view'/.test(app) && /data-mode="view"/.test(css));
  t.ok('החלפת שפת הכתבה מנקה interim', /a\.interim = ''/.test(app) && /dictSetLang/.test(app));
}

t.section('סבב 24 — ערכת מערכת / סנכרון הרשאות');
{
  t.ok('שינוי ערכת מערכת מרענן mermaid', /matchMedia\('\(prefers-color-scheme: dark\)'\)[\s\S]{0,160}rethemeMermaid/.test(app));
  t.ok('סנכרון מחייה כרטיסים בשקט', /showPermission\([^)]+\{ silent: true \}/.test(app));
}

t.section('סבב 25 — מודאל / אנונימי מושבת');
{
  t.ok('openModal מסיר מאזין לפני הוספה', /removeEventListener\('keydown', onModalKeydown/.test(app));
  t.ok('newAnon.disabled לחיץ להסבר', /\.nav-row\.disabled[^}]*cursor: not-allowed/.test(css) && !/\.nav-row\.disabled[^}]*pointer-events:\s*none/.test(css));
}

t.section('סבב 26 — שינוי שם Escape');
{
  const ren = slice('function startRename(', 'function deleteConv(');
  t.ok('Escape בשינוי שם לא סוגר מגירה', /Escape[\s\S]{0,120}stopPropagation/.test(ren));
}

t.section('סבב 27 — חיפוש מול מגירה');
{
  t.ok('Ctrl+F סוגר מגירה לפני חיפוש', /drawerMode\(\)\) closeDrawer\(\)[\s\S]{0,40}openFind/.test(app) || /closeDrawer\(\);\s*\n\s*openFind/.test(app));
  t.ok('Ctrl+Shift+F פותח מגירה בטלפון', /drawerMode\(\)\) document\.querySelector\('\.app'\)\.classList\.add\('side-open'\)/.test(app));
}

t.section('סבב 29 — חיפוש מול הגדרות');
{
  t.ok('openFind סוגר הגדרות', /function openFind\([\s\S]{0,120}closeSettings/.test(app));
  t.ok('openSettings סוגר חיפוש', /function openSettings\([\s\S]{0,80}closeFind/.test(app));
}

t.section('סבב 30 — הגדרות מול מודאל');
{
  t.ok('openModal סוגר הגדרות', /function openModal\([\s\S]{0,80}closeSettings/.test(app));
  t.ok('usage open סוגר הגדרות', /setUsageModalOpen[\s\S]{0,200}closeSettings/.test(app) || /if \(open\) \{[\s\S]{0,80}closeSettings/.test(app));
}

t.section('סרגל עליון — בלי כותרת ובלי נקודת מצב');
{
  t.ok('convTitle מוסתר בסרגל', /#convTitle,\s*\n?\s*\.title-wrap #statusDot|#convTitle[\s\S]{0,80}display:\s*none/.test(css)
    || /\.title-wrap #convTitle[\s\S]{0,60}display:\s*none/.test(css));
  t.ok('statusDot מוסתר בסרגל', /\.title-wrap #statusDot[\s\S]{0,80}display:\s*none/.test(css));
  t.ok('שינוי שם נשאר בלוח פקודות', /שנה שם לשיחה הפעילה/.test(app));
}

t.section('כפתור מודל — שלושת הבוררים מעליו');
{
  t.ok('modelDockBtn ב-HTML', /id="modelDockBtn"/.test(html));
  t.ok('modelDockPop מכיל את שלושת הבוררים',
    /id="modelDockPop"[\s\S]*id="perm"[\s\S]*id="model"[\s\S]*id="effort"/.test(html));
  t.ok('openModelDock קיים', /function openModelDock\(/.test(app));
  t.ok('Escape סוגר את חלונית המודל', /isModelDockOpen\(\)[\s\S]{0,80}closeModelDock/.test(app));
  t.ok('החלונית ממוקמת מעל הכפתור', /bottom:\s*calc\(100% \+ 8px\)/.test(css));
}

t.section('כתיבה רחבה — כפתור מודל ולא החלקה');
{
  const tall = css.slice(css.indexOf('body.compose-compact.compose-tall .model-dock'),
    css.indexOf('body.compose-compact.compose-tall #sendBtn'));
  t.ok('perm/effort לא מוסתרים ב-tall', !/\.pill-wrap:has\(#perm\)[\s\S]{0,80}display:\s*none/.test(css));
  t.ok('אין החלקת snap ב-tall', !/scroll-snap-type:\s*x mandatory/.test(css));
  t.ok('כפתור המודל חוזר ב-tall', /display:\s*flex\s*!important/.test(tall));
  t.ok('snapTallPillsToModel הוסר', !/function snapTallPillsToModel\(/.test(app));
}

t.section('המתנה לשרת שנפל באמצע תור');
{
  t.ok('showAwaitServer קיים', /function showAwaitServer\(/.test(app));
  t.ok('closeTurnAfterServerBack קיים', /function closeTurnAfterServerBack\(/.test(app));
  t.ok('onclose מציג המתנה כשיש תור חי', /sock\.onclose[\s\S]{0,400}if \(busy\) showAwaitServer/.test(app));
  t.ok('זרם שחזר מסיר את החיווי', /awaitingServer && \(evt\.type === 'stream_event'/.test(app));
  t.ok('reset בלי תור חי סוגר עם כרטיס', /awaitingServer && m\.mode === 'reset'/.test(app) && /closeTurnAfterServerBack/.test(app));
  t.ok('כרטיס server_restart עם המשך', /reason === 'server_restart'[\s\S]{0,200}המשך/.test(app));
  t.ok('CSS ל-.await-server', /\.await-server\s*\{/.test(css));
  t.ok('sanitize שומר awaiting', /m\.awaiting \? \{ awaiting: true \}/.test(fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8')));
}

t.section('מסגרת נעה + עצירה בכפתור שליחה');
{
  t.ok('composer-orbit ב-HTML', /class="composer-orbit"/.test(html));
  t.ok('אין stopBtn בפס העבודה', !/id="stopBtn"/.test(html));
  t.ok('אייקון עצירה בכפתור שליחה', /class="send-stop"/.test(html));
  t.ok('אנימציית composerOrbit על הקו', /@keyframes composerOrbit/.test(css) && /stroke-dashoffset/.test(css));
  t.ok('מסגרת אדומה ב-nosync/stale', /body\.nosync \.orbit-run/.test(css) && /var\(--danger\)/.test(css));
  t.ok('זוהר על הקו ולא conic', /orbit-bloom/.test(html) && /orbit-glow/.test(html) && /stroke-dasharray/.test(css) && !/\.composer-orbit::before/.test(css));
  t.ok('.send.stopping מחליף לריבוע', /\.send\.stopping \.send-stop/.test(css));
  t.ok('עצירה נשארת באקצנט', /\.send\.stopping/.test(css) && !/\.send\.stopping\s*\{[^}]*background:\s*var\(--text\)/.test(css));
  const snip = slice('function syncSendAffordance()', 'function setBusy(');
  t.ok('syncSendAffordance מסמן stopping', /classList\.toggle\(\s*['"]stopping['"]/.test(snip));
  t.ok('sendBtn עוצר כשאין טקסט בתור חי', /sendBtn'\)\.onclick[\s\S]{0,180}interruptTurn/.test(app));
  t.ok('working לא כרטיס אקצנט ענק', !/\.working\s*\{[^}]*linear-gradient\(120deg,\s*var\(--accent\)/.test(css));
}

t.done();
