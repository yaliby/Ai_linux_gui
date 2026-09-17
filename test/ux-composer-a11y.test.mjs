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
  t.ok('מכשיר משני מסומן תצוגה בלבד', /!isPrimary/.test(snip) && /תצוגה בלבד/.test(snip));
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

t.done();
