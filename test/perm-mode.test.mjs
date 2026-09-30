/**
 * מיפוי מצבי הרשאה ל-Claude Code אחרי שה-CLI הפסיק לקבל ‎default‎/‎force‎.
 *   node test/perm-mode.test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const {
  GOD_MODE, GOD_CLI_MODE, CLAUDE_PERM_MODES,
  isGodMode, withGod, parsePermissionModes, claudeCliPerm,
} = require('../lib/perm-mode.js');

const t = runner('מצבי הרשאה של Claude');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

t.section('מיפוי ל-CLI');
{
  t.eq('GOD → manual', claudeCliPerm(GOD_MODE), GOD_CLI_MODE);
  t.eq('default הישן → manual', claudeCliPerm('default'), 'manual');
  t.eq('force של Cursor → acceptEdits', claudeCliPerm('force'), 'acceptEdits');
  t.eq('ask של Cursor → acceptEdits', claudeCliPerm('ask'), 'acceptEdits');
  t.eq('ריק → acceptEdits', claudeCliPerm(''), 'acceptEdits');
  t.eq('acceptEdits נשאר', claudeCliPerm('acceptEdits'), 'acceptEdits');
  t.eq('bypassPermissions נשאר', claudeCliPerm('bypassPermissions'), 'bypassPermissions');
  t.eq('plan נשאר', claudeCliPerm('plan'), 'plan');
  t.eq('dontAsk נשאר', claudeCliPerm('dontAsk'), 'dontAsk');
  t.eq('auto נשאר', claudeCliPerm('auto'), 'auto');
  t.ok('GOD הוא god', isGodMode('god') && !isGodMode('manual'));
  t.eq('withGod מוסיף פעם אחת', withGod(['acceptEdits', 'god']), ['acceptEdits', 'god']);
  t.ok('withGod על רשימה בלי god', withGod(['plan']).includes('god'));
}

t.section('רשימה מהעזרה של ה-CLI');
{
  const help = `
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
`;
  t.eq('פענוח רשימה שבורה לשורות', parsePermissionModes(help), CLAUDE_PERM_MODES);
  t.eq('בלי העזרה', parsePermissionModes(''), null);
  t.eq('בלי הדגל', parsePermissionModes('--model x'), null);
}

t.section('רשת ביטחון מול רשימה ישנה שעוד מכילה default');
{
  const old = ['acceptEdits', 'plan', 'bypassPermissions', 'default'];
  t.eq('GOD נופל ל-default אם זה מה שיש', claudeCliPerm('god', old), 'default');
  t.eq('force מול רשימה ישנה', claudeCliPerm('force', old), 'acceptEdits');
}

t.section('השרת משתמש במיפוי ולא שולח force');
{
  t.ok('server מייבא claudeCliPerm', /require\('\.\/lib\/perm-mode'\)/.test(srv));
  t.ok('שיגור Claude עובר ב-cliPermMode', /'--permission-mode',\s*permArg/.test(srv));
  t.ok('Cursor לא עובר את המיפוי של Claude', /s\.cliAgent === 'cursor' \? msg\.mode : cliPermMode/.test(srv));
}

t.section('הלקוח לא שולח מצב של הסוכן השני');
{
  t.ok('permValue קיים', /function permValue\(/.test(app));
  t.ok('שליחה רגילה דרך permValue', /permissionMode: permValue\(\)/.test(app));
  t.ok('תור ממתין דרך permValue', /permissionMode: permValue\(\), resumeSessionId/.test(app));
  t.ok('adoptModel בונה מחדש הרשאות', /function adoptModel\([\s\S]*?populatePerms\(\)/.test(app));
  t.ok('applyRemoteUi בונה מחדש בהחלפת מודל', /m\.field === 'model'[\s\S]{0,80}populatePerms\(\)/.test(app));
  t.ok('settings.perm לא נדרס מ-Cursor', /function permStoreKey\(/.test(app) && /localPerm/.test(app));
  t.ok('flushBeacon תופס Failed to fetch', /keepalive:\s*true\s*\}\)\.catch\(\(\) => \{\}\)/.test(app));
}
