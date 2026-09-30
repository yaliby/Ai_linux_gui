'use strict';
/* ==========================================================================
   מצבי הרשאה של Claude Code
   --------------------------------------------------------------------------
   ‎claude --permission-mode‎ מחליף שמות בין גרסאות. מה שהיה ‎default‎ הפך
   ל-‎manual‎, ו-‎force‎ (של cursor-agent) מעולם לא היה חוקי כאן — אבל הוא
   מגיע מהבורר כשמחליפים סוכן בלי לבנות את הרשימה מחדש. שליחה כמו שהיא
   מפילה את התהליך מיד: "argument 'force' is invalid".

   המיפוי כאן הוא רשת הביטחון של השרת: ערך שה-CLI לא מכיר הופך לערך שהוא
   כן מכיר, בלי שהשיחה תיכשל.
   ========================================================================== */

/** מצבי GOD חיים בממשק; ה-CLI חייב מצב שבו הוא *עדיין שואל*, כדי שנאשר ונרשום. */
const GOD_MODE = 'god';
const GOD_CLI_MODE = 'manual';

/** הרשימה הנוכחית של Claude Code 2.1 (‎claude --help‎). */
const CLAUDE_PERM_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

const isGodMode = (m) => m === GOD_MODE;
const withGod = (modes) => (Array.isArray(modes) && modes.includes(GOD_MODE) ? modes : [...(modes || []), GOD_MODE]);

/**
 * מפרק את ‎--permission-mode (choices: "a", "b")‎ מתוך ‎claude --help‎.
 * החלון רחב כי העזרה שוברת שורות באמצע הרשימה.
 */
function parsePermissionModes(help) {
  if (!help) return null;
  const i = String(help).indexOf('--permission-mode');
  if (i < 0) return null;
  const m = String(help).slice(i, i + 800).match(/choices:([\s\S]*?)\)/);
  if (!m) return null;
  const modes = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return modes.length ? modes : null;
}

/**
 * מה שנשלח באמת ל-‎--permission-mode‎ של Claude (לא של Cursor).
 * ‎allowed‎ — הרשימה מ-‎--help‎ אם כבר נקראה; אחרת הרשימה הידועה.
 */
function claudeCliPerm(mode, allowed) {
  const list = (allowed && allowed.length) ? allowed : CLAUDE_PERM_MODES;
  const pick = (...cands) => cands.find((x) => list.includes(x)) || list[0] || 'acceptEdits';
  if (isGodMode(mode) || mode === 'default') return pick(GOD_CLI_MODE, 'default', 'acceptEdits');
  if (list.includes(mode)) return mode;
  return pick('acceptEdits');
}

module.exports = {
  GOD_MODE, GOD_CLI_MODE, CLAUDE_PERM_MODES,
  isGodMode, withGod, parsePermissionModes, claudeCliPerm,
};
