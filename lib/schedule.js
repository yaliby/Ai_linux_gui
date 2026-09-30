'use strict';
/* ==========================================================================
   הודעות מתוזמנות בתוך סשן
   --------------------------------------------------------------------------
   פרומפט שנשמר על השיחה ויוצא באותו סשן בשעה שנקבעה. המודל, ההרשאות
   והמאמץ נצרבים ברגע התזמון — לא ברגע השיגור — כדי ששינוי בורר באמצע
   ההמתנה לא יישלח במקומם.

   בנוסף: משימת limit_resume — המשך אוטומטי אחרי חידוש מכסת הסשן — נשמרת
   באותו מערך תזמונים, עם kind משלה, כדי שתשרוד הפעלה מחדש ותופיע ברשימה
   המרכזית לצד הודעות מתוזמנות רגילות.

   מה שהמודול שומר:
     • שעה בעבר נדחית, לא "נשלחת מיד בטעות" (לפרומפטים).
     • תקרה על כמה אפשר לתלות על שיחה אחת (לא כולל limit_resume).
     • צורת השידור ללקוח בלי הטיימר הפנימי.
   ========================================================================== */

const MAX_SCHEDULES = 20;
const MIN_LEAD_MS = 10 * 1000;
const MAX_LEAD_MS = 14 * 24 * 60 * 60 * 1000;

const KIND_PROMPT = 'prompt';
const KIND_LIMIT_RESUME = 'limit_resume';
const LIMIT_RESUME_ID = 'limit-resume';

const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function isLimitResume(item) {
  return !!(item && (item.kind === KIND_LIMIT_RESUME || item.id === LIMIT_RESUME_ID));
}

function promptOnly(list) {
  return (Array.isArray(list) ? list : []).filter((s) => !isLimitResume(s));
}

function validateSchedule(input, now = Date.now()) {
  const text = String((input && input.text) || '').trim();
  if (!text) return { ok: false, error: 'כתוב פרומפט לתזמון' };
  const at = Number(input && input.at);
  if (!Number.isFinite(at) || at <= 0) return { ok: false, error: 'שעה לא תקינה' };
  if (at < now + MIN_LEAD_MS) return { ok: false, error: 'השעה כבר עברה — בחר שעה מאוחרת יותר' };
  if (at - now > MAX_LEAD_MS) return { ok: false, error: 'אפשר לתזמן עד 14 יום קדימה' };
  return { ok: true, text, at };
}

function buildItem(input, extra = {}, now = Date.now()) {
  const v = validateSchedule(input, now);
  if (!v.ok) return v;
  return {
    ok: true,
    item: {
      id: extra.id || newId(),
      kind: KIND_PROMPT,
      at: v.at,
      by: extra.by || null,
      msg: {
        text: v.text,
        cwd: String((input && input.cwd) || ''),
        model: String((input && input.model) || ''),
        effort: String((input && input.effort) || ''),
        permissionMode: String((input && input.permissionMode) || ''),
        resumeSessionId: (input && input.resumeSessionId) || null,
        tools: !!(input && input.tools),
        ...(input && input.local && typeof input.local === 'object' ? { local: input.local } : {}),
      },
    },
  };
}

/**
 * משימת המשך אחרי מכסת סשן. מותרת גם שעה שכבר עברה (אחרי הפעלה מחדש של
 * השרת באמצע ההמתנה) — אז הטיימר נורה מיד.
 */
function buildLimitResumeItem(input = {}, extra = {}) {
  const resetsAt = Number(input.resetsAt) || Number(input.at) || 0;
  const at = Number(input.at) || resetsAt;
  if (!Number.isFinite(at) || at <= 0) return { ok: false, error: 'שעת איפוס לא תקינה' };
  return {
    ok: true,
    item: {
      id: extra.id || LIMIT_RESUME_ID,
      kind: KIND_LIMIT_RESUME,
      at,
      by: extra.by || null,
      msg: {
        text: 'המשך אחרי חידוש מכסת הסשן',
        produced: !!(input && input.produced),
        limitText: String((input && input.text) || '').slice(0, 300),
        resetsAt: resetsAt || at,
      },
    },
  };
}

function scheduleView(list) {
  return (Array.isArray(list) ? list : []).map((s) => ({
    id: s.id,
    kind: isLimitResume(s) ? KIND_LIMIT_RESUME : (s.kind || KIND_PROMPT),
    at: s.at,
    text: (s.msg && s.msg.text) || '',
    model: (s.msg && s.msg.model) || '',
    permissionMode: (s.msg && s.msg.permissionMode) || '',
    effort: (s.msg && s.msg.effort) || '',
    by: s.by || null,
    resetsAt: (s.msg && s.msg.resetsAt) || (isLimitResume(s) ? s.at : null),
  }));
}

function persistShape(list) {
  return (Array.isArray(list) ? list : []).map((s) => ({
    id: s.id,
    kind: isLimitResume(s) ? KIND_LIMIT_RESUME : (s.kind || KIND_PROMPT),
    at: s.at,
    by: s.by || null,
    msg: s.msg || { text: '' },
  }));
}

function dueItems(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((s) => s && s.at <= now);
}

module.exports = {
  MAX_SCHEDULES, MIN_LEAD_MS, MAX_LEAD_MS,
  KIND_PROMPT, KIND_LIMIT_RESUME, LIMIT_RESUME_ID,
  validateSchedule, buildItem, buildLimitResumeItem,
  scheduleView, persistShape, dueItems, newId,
  isLimitResume, promptOnly,
};
