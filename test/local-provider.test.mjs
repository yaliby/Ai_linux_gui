/**
 * הגדרות ייחודיות לספק המקומי — נרמול, הזרקה לגשר, והפרדה בממשק.
 *   node test/local-provider.test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const {
  normalizeLocalUrl,
  normalizeLocalExtras,
  applyProviderExtras,
  loadProviders,
} = require('../openai-bridge.js');

const t = runner('הגדרות הספק המקומי');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

t.section('נרמול כתובת');
{
  t.eq('משלים /v1', normalizeLocalUrl('http://192.168.1.253:1234'), 'http://192.168.1.253:1234/v1');
  t.eq('לא כופל /v1', normalizeLocalUrl('http://192.168.1.253:1234/v1/'), 'http://192.168.1.253:1234/v1');
  t.eq('https נשאר', normalizeLocalUrl('https://host:1234/v1'), 'https://host:1234/v1');
  t.eq('ריק נדחה', normalizeLocalUrl('  '), null);
  t.eq('לא-HTTP נדחה', normalizeLocalUrl('ftp://x/v1'), null);
  t.eq('לא-URL נדחה', normalizeLocalUrl('not a url'), null);
}

t.section('נרמול הגדרות יצירה');
{
  t.eq('טמפרטורה ומקסימום', normalizeLocalExtras({ temperature: 0.7, maxTokens: 2048.4 }), { temperature: 0.7, maxTokens: 2048 });
  t.eq('אפס טמפרטורה נשמר', normalizeLocalExtras({ temperature: 0 }), { temperature: 0 });
  t.eq('ריק ו-null נשמטים', normalizeLocalExtras({ temperature: '', maxTokens: null, timeoutMs: '' }), {});
  t.eq('מעל התקרה נשמט', normalizeLocalExtras({ temperature: 3, maxTokens: 999999 }), {});
  t.eq('תקרת זמן נשמרת', normalizeLocalExtras({ timeoutMs: 1_200_000 }).timeoutMs, 1_200_000);
}

t.section('הזרקה לגוף OpenAI');
{
  const body = { model: 'qwen', messages: [], stream: true };
  applyProviderExtras(body, { temperature: 0.3, maxTokens: 4096 });
  t.eq('temperature', body.temperature, 0.3);
  t.eq('max_tokens', body.max_tokens, 4096);
  const plain = { model: 'qwen', messages: [] };
  applyProviderExtras(plain, {});
  t.eq('בלי הגדרות לא נוגעים', 'temperature' in plain, false);
  t.eq('בלי maxTokens לא כופים תקרה', 'max_tokens' in plain, false);
}

t.section('loadProviders מכבד כתובת שמורה');
{
  const prev = process.env.LOCAL_BASE_URL;
  const prevOmni = process.env.OMNIROUTE_BASE_URL;
  process.env.LOCAL_BASE_URL = 'http://env-default:1234/v1';
  process.env.OMNIROUTE_BASE_URL = '';
  try {
    const [p] = loadProviders({ local: { baseUrl: 'http://192.168.1.10:1234' } });
    t.eq('הכתובת השמורה גוברת על .env', p.getStatus().baseUrl, 'http://192.168.1.10:1234/v1');
    t.eq('זה הספק המקומי', p.id, 'local');
    p.setExtras({ temperature: 1, maxTokens: 1024 });
    t.eq('extras נשמרים אצלו', p.getExtras(), { temperature: 1, maxTokens: 1024 });
    p.setExtras({ temperature: null, maxTokens: 1024 });
    t.eq('null מנקה טמפרטורה', p.getExtras(), { maxTokens: 1024 });
  } finally {
    if (prev === undefined) delete process.env.LOCAL_BASE_URL;
    else process.env.LOCAL_BASE_URL = prev;
    if (prevOmni === undefined) delete process.env.OMNIROUTE_BASE_URL;
    else process.env.OMNIROUTE_BASE_URL = prevOmni;
  }
}

t.section('השרת חושף API נפרד');
{
  t.ok('GET /api/local', /app\.get\('\/api\/local'/.test(srv));
  t.ok('PUT /api/local', /app\.put\('\/api\/local'/.test(srv));
  t.ok('POST /api/local/probe', /app\.post\('\/api\/local\/probe'/.test(srv));
  t.ok('הגדרות נשמרות לקובץ נפרד', /local-provider\.json/.test(srv));
  t.ok('תור מזריק extras', /function applyLocalTurnExtras\(/.test(srv) && /applyLocalTurnExtras\(msg\)/.test(srv));
  t.ok('/api/config נושא local', /local:\s*localPublicStatus\(\)/.test(srv));
}

t.section('הממשק מפריד הגדרות');
{
  t.ok('isLocalModel', /const isLocalModel = /.test(app));
  t.ok('permStoreKey עם localPerm', /function permStoreKey\(/.test(app) && /localPerm/.test(app));
  t.ok('בורר טמפרטורה בחלונית', /id="localTemp"/.test(html));
  t.ok('בורר תקרת תשובה', /id="localMaxTokens"/.test(html));
  t.ok('שורה בהגדרות', /id="localRow"/.test(html) && /id="localUrl"/.test(html));
  t.ok('בדיקה מיידית', /id="localProbe"/.test(html) && /\/api\/local\/probe/.test(app));
  t.ok('שליחה נושאת local', /function turnPayloadExtras\(/.test(app) && /\.\.\.turnPayloadExtras\(\)/.test(app));
  t.ok('תזמון נושא local', /isLocalModel\(model\.value\) \? \{ local: localExtrasPayload\(\)/.test(app));
}
