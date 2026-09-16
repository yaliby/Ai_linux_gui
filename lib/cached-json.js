'use strict';
/**
 * קריאה וכתיבה של JSON עם מטמון בזיכרון.
 * לכל קובץ אחסון יש עותק אחד ב-memory, מאומת לפי mtime.
 * זה פיטורן חוזר שלוש פעמים ב-server.js, ולכן קודי זה מקום אחד.
 */
const fs = require('node:fs');

/**
 * קרא JSON מקובץ (עם מטמון בזיכרון).
 * @param {string} path - הנתיב המלא
 * @returns {any|null} האובייקט או null אם קובץ אינו קיים / לא תקין
 *
 * השימוש:
 *   const cache = createJsonCache();
 *   const data = cache.read('/tmp/file.json');   // קרא/מטמנו
 *   data.read('/tmp/file.json');                 // מזיכרון (בלי stat)
 */
function createJsonCache() {
  const memory = new Map();  // path → {data, mtimeMs}

  return {
    read(path) {
      let st;
      try { st = fs.statSync(path); } catch { memory.delete(path); return null; }

      const hit = memory.get(path);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;

      try {
        const data = JSON.parse(fs.readFileSync(path, 'utf8'));
        memory.set(path, { data, mtimeMs: st.mtimeMs });
        return data;
      } catch {
        memory.delete(path);
        return null;
      }
    },

    write(path, data) {
      try {
        const json = JSON.stringify(data);
        const tmp = path + '.tmp';
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, path);
        const st = fs.statSync(path);
        memory.set(path, { data, mtimeMs: st.mtimeMs });
        return true;
      } catch {
        return false;
      }
    },

    clear() { memory.clear(); },
  };
}

module.exports = { createJsonCache };
