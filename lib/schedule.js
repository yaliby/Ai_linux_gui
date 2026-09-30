'use strict';
/* ==========================================================================
   הודעות מתוזמנות בתוך סשן
   --------------------------------------------------------------------------
   פרומפט שנשמר על השיחה ויוצא באותו סשן בשעה שנקבעה. המודל, ההרשאות
   והמאמץ נצרבים ברגע התזמון — לא ברגע השיגור — כדי ששינוי בורר באמצע
   ההמתנה לא יישלח במקומם.

   מה שהמודול שומר:
     • שעה בעבר נדחית, לא "נשלחת מיד בטעות".
     • תקרה על כמה אפשר לתלות על שיחה אחת.
     • צורת השידור ללקוח בלי הטיימר הפנימי.
   ========================================================================== */

const MAX_SCHEDULES = 20;
const MIN_LEAD_MS = 10 * 1000;
const MAX_LEAD_MS = 14 * 24 * 60 * 60 * 1000;

const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

function scheduleView(list) {
  return (Array.isArray(list) ? list : []).map((s) => ({
    id: s.id,
    at: s.at,
    text: (s.msg && s.msg.text) || '',
    model: (s.msg && s.msg.model) || '',
    permissionMode: (s.msg && s.msg.permissionMode) || '',
    effort: (s.msg && s.msg.effort) || '',
    by: s.by || null,
  }));
}

function persistShape(list) {
  return (Array.isArray(list) ? list : []).map((s) => ({
    id: s.id,
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
  validateSchedule, buildItem, scheduleView, persistShape, dueItems, newId,
};
