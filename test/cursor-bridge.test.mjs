/**
 * גשר Cursor (`cursor-bridge.js`) — מכסה, מודלים, ותרגום אירועים.
 *
 * הגשר הזה מחקה CLI שלם: מה שנכנס הוא זרם של `cursor-agent`, ומה שיוצא חייב
 * להיראות ל-server.js בדיוק כמו `claude --stream-json`. שגיאה כאן לא נראית
 * כשגיאה אלא כתשובה כפולה, ככרטיס כלי שלא נסגר, או כמכסה שמראה מספר שגוי —
 * ולכן כל אחד מהשלושה נבדק כאן על נתונים בצורה שבה הם באמת מגיעים.
 */
import { createRequire } from 'node:module';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const cursor = require('../cursor-bridge.js');
const { parseModels, parseCursorUsage, splitVariant, resolveModel, Translator, resultText, collapse } = cursor._internal;

const t = runner('גשר Cursor');

// ---------------------------------------------------------------------------
t.section('מכסה — חשבון מודרני');
{
  const u = parseCursorUsage({
    membershipType: 'pro',
    billingCycleEnd: '2026-10-01T00:00:00.000Z',
    individualUsage: { plan: { enabled: true, apiPercentUsed: 42.7, autoPercentUsed: 8, totalPercentUsed: 25 } },
  }, null, null);

  t.eq('שני דליים', u.windows.map((w) => w.id), ['cursor-api', 'cursor-auto']);
  t.eq('מודלים כלליים ראשון', u.windows[0].pct, 42.7);
  t.eq('מודלי קרסר שני', u.windows[1].pct, 8);
  t.eq('הסה״כ המעורב לא מוצג', JSON.stringify(u).includes('"pct":25'), false);
  t.eq('מחזור החיוב', u.windows[0].resets_at, '2026-10-01T00:00:00.000Z');
  t.ok('שם תוכנית', !!u.plan, u.plan);

  const un = parseCursorUsage({ isUnlimited: true, membershipType: 'ultra' }, null, null);
  t.eq('ללא הגבלה = חלון אחד באפס', un.windows.length, 1);
  t.eq('ונאמר', un.windows[0].detail, 'ללא הגבלה');

  const clamp = parseCursorUsage({ individualUsage: { plan: { enabled: true, apiPercentUsed: 180, autoPercentUsed: -5 } } }, null, null);
  t.eq('אחוז מעל 100 נחתך', clamp.windows[0].pct, 100);
  t.eq('אחוז שלילי נחתך', clamp.windows[1].pct, 0);

  const bad = parseCursorUsage({ individualUsage: { plan: { enabled: true, apiPercentUsed: null, autoPercentUsed: 'x' } } }, null, null);
  t.eq('ערכים לא-מספריים נשמטים', bad, null);
  t.eq('אין נתונים בכלל', parseCursorUsage(null, null, null), null);
}

t.section('מכסה — גרוק בוט, חיוב לפי שימוש, וחשבון ישן');
{
  const sand = parseCursorUsage(null, null, {
    hasNonZeroIncludedLimit: true, usagePercent: 33, nextResetTimestampUtc: '2026-09-22T00:00:00Z', cursorPlanName: 'pro',
  });
  t.eq('מד גרוק', sand.windows[0].id, 'cursor-grok-bot');
  t.eq('אחוז', sand.windows[0].pct, 33);
  t.eq('איפוס שבועי', sand.windows[0].resets_at, '2026-09-22T00:00:00Z');

  const noSand = parseCursorUsage(null, null, { hasNonZeroIncludedLimit: false, usagePercent: 33 });
  t.eq('חשבון בלי תקרת בוט לא מקבל מד', noSand, null);

  const od = parseCursorUsage({ individualUsage: { onDemand: { enabled: true, used: 1234, limit: 5000 } } }, null, null);
  t.eq('חיוב לפי שימוש', od.windows[0].id, 'cursor-ondemand');
  t.eq('בדולרים', od.windows[0].detail, '$12.34 מתוך תקרה של $50.00');

  const legacy = parseCursorUsage(null, { membershipType: 'pro', startOfMonth: '2026-08-15T00:00:00.000Z', 'gpt-4': { numRequests: 120, maxRequestUsage: 500 } }, null);
  t.eq('בקשות פרימיום', legacy.windows[0].id, 'cursor-requests');
  t.eq('אחוז מחושב', legacy.windows[0].pct, 24);
  t.eq('פירוט', legacy.windows[0].detail, '120 מתוך 500 בקשות');
  t.ok('איפוס חודש קדימה', legacy.windows[0].resets_at.startsWith('2026-09-15'), legacy.windows[0].resets_at);

  // מחזור שמתחיל ב-31 לחודש: חודש קדימה מפברואר אינו 3 במרץ
  const edge = parseCursorUsage(null, { startOfMonth: '2026-01-31T00:00:00.000Z', 'gpt-4': { numRequests: 1, maxRequestUsage: 10 } }, null);
  t.ok('31 בינואר → סוף פברואר ולא 3 במרץ', /2026-02-2[89]|2026-03-01/.test(edge.windows[0].resets_at), edge.windows[0].resets_at);
}

// ---------------------------------------------------------------------------
t.section('רשימת המודלים');
{
  const list = parseModels([
    'Available models:',
    '  auto - Auto (current, default)',
    '  gpt-5.3-codex - Codex 5.3',
    '  gpt-5.3-codex-low - Codex 5.3 Low',
    '  gpt-5.3-codex-low-fast - Codex 5.3 Low Fast',
    '  claude-4.5-sonnet - Claude Sonnet 4.5',
    'not a model line',
  ].join('\n'));
  t.eq('רק שורות מודל', list.length, 5);
  t.eq('סימון ברירת המחדל הוסר מהשם', list[0], { id: 'auto', name: 'Auto' });

  t.eq('פירוק וריאנט', splitVariant('gpt-5.3-codex-low-fast'), { base: 'gpt-5.3-codex', effort: 'low', fast: true });
  t.eq('בלי מאמץ', splitVariant('claude-4.5-sonnet'), { base: 'claude-4.5-sonnet', effort: '', fast: false });
  t.eq('fast בלי מאמץ', splitVariant('grok-4-fast'), { base: 'grok-4', effort: '', fast: true });

  const have = new Set(['gpt-5.3-codex-low', 'gpt-5.3-codex-medium', 'gpt-5.3-codex-high', 'claude-4.5-sonnet', 'auto']);
  t.eq('מאמץ שקיים', resolveModel('cursor/gpt-5.3-codex', 'medium', have), 'gpt-5.3-codex-medium');
  t.eq('מאמץ שלא קיים יורד למטה', resolveModel('cursor/gpt-5.3-codex', 'max', have), 'gpt-5.3-codex-high');
  t.eq('בלי מאמץ, כשיש וריאנט נקי', resolveModel('cursor/claude-4.5-sonnet', '', have), 'claude-4.5-sonnet');
  t.eq('בלי מאמץ, כשאין נקי — יוצאים מ-high', resolveModel('cursor/gpt-5.3-codex', '', have), 'gpt-5.3-codex-high');
  t.eq('auto נשלח במפורש', resolveModel('cursor/auto', 'high', have), 'auto');
  t.eq('רשימה ריקה — מרכיבים כמיטב היכולת', resolveModel('cursor/x', 'low', new Set()), 'x-low');
  // מזהה שאינו של קרסר עובר כמו שהוא — הסינון נעשה ב-isCursorModel אצל הקורא
  t.eq('מזהה זר עובר כמו שהוא', resolveModel('opus-5', '', have), 'opus-5');

  t.eq('זיהוי מודל קרסר', [cursor.isCursorModel('cursor/auto'), cursor.isCursorModel('omniroute/gpt-5')], [true, false]);
  t.eq('הסרת תחילית', cursor.bareModel('cursor/claude-4.5-sonnet'), 'claude-4.5-sonnet');
}

// ---------------------------------------------------------------------------
t.section('תרגום תור שלם: cursor-agent → stream-json');
{
  const out = [];
  const child = { sessionId: '', _line: (o) => out.push(o), _err: () => {} };
  const tr = new Translator(child, { cwd: '/tmp', model: 'cursor/claude-4.5-sonnet', permissionMode: 'default' });
  const feed = (o) => tr.line(JSON.stringify(o));

  feed({ type: 'system', subtype: 'init', session_id: 's1', cwd: '/tmp', model: 'claude-4.5-sonnet' });
  feed({ type: 'thinking', subtype: 'delta', text: 'אני חושב ' });
  feed({ type: 'thinking', subtype: 'delta', text: 'על זה' });
  feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'שלום' }] } });
  feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'שלום עולם' }] } });   // המשך מצטבר
  feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'שלום עולם' }] } });   // חזרה מלאה
  feed({ type: 'tool_call', subtype: 'started', call_id: 'c\n1', tool_call: { readToolCall: { args: { path: '/tmp/a.txt' } } } });
  feed({ type: 'tool_call', subtype: 'completed', call_id: 'c\n1', tool_call: { readToolCall: { args: { path: '/tmp/a.txt' }, result: { content: 'תוכן הקובץ' } } } });
  feed({ type: 'result', subtype: 'success', duration_ms: 1200, result: '', usage: { inputTokens: 10, outputTokens: 20 } });

  const init = out.find((o) => o.type === 'system');
  t.eq('init מתורגם', init.subtype, 'init');
  t.eq('סוכן מסומן', init.agent, 'cursor');
  t.eq('סשן נתפס', child.sessionId, 's1');

  const events = out.filter((o) => o.type === 'stream_event').map((o) => o.event);
  const texts = events.filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta').map((e) => e.delta.text);
  t.eq('הטקסט לא הוכפל', texts.join(''), 'שלום עולם');
  const think = events.filter((e) => e.type === 'content_block_delta' && e.delta.type === 'thinking_delta').map((e) => e.delta.thinking);
  t.eq('חשיבה זרמה', think.join(''), 'אני חושב על זה');

  // חוקי הפרוטוקול: בלוק אחד פתוח בכל רגע, וכל בלוק נסגר
  let open = null; const bad = [];
  for (const e of events) {
    if (e.type === 'content_block_start') { if (open !== null) bad.push('שני בלוקים פתוחים'); open = e.index; }
    if (e.type === 'content_block_delta' && open !== e.index) bad.push('delta לבלוק לא פתוח');
    if (e.type === 'content_block_stop') { if (open !== e.index) bad.push('stop לא תואם'); open = null; }
  }
  t.eq('רצף בלוקים תקין', bad, []);
  t.eq('לא נשאר בלוק פתוח', open, null);

  const starts = events.filter((e) => e.type === 'content_block_start');
  t.eq('חשיבה, טקסט וכלי — שלושה בלוקים', starts.map((e) => e.content_block.type), ['thinking', 'text', 'tool_use']);
  const tool = starts.find((e) => e.content_block.type === 'tool_use');
  t.eq('כרטיס קריאה', tool.content_block.name, 'Read');
  t.ok('מזהה בלי שורה חדשה', !/\n/.test(tool.content_block.id), tool.content_block.id);

  const res = out.find((o) => o.type === 'result');
  t.eq('תוצאה', res.subtype, 'success');
  t.eq('שימוש בשמות של Claude', res.usage, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  t.eq('הודעה נסגרה לפני התוצאה', events[events.length - 1].type, 'message_stop');
}

t.section('שימוש שמדווח ב-snake_case (גרסה אחרת של הסוכן)');
{
  const out = [];
  const child = { sessionId: '', _line: (o) => out.push(o), _err: () => {} };
  const tr = new Translator(child, { cwd: '/tmp', model: 'cursor/auto' });
  tr.line(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 7, output_tokens: 9 } }));
  const res = out.find((o) => o.type === 'result');
  t.eq('נקרא גם כך', [res.usage.input_tokens, res.usage.output_tokens], [7, 9]);
}

t.section('תור בלי סטרימינג חלקי — רק הודעה מלאה');
{
  const out = [];
  const child = { sessionId: '', _line: (o) => out.push(o), _err: () => {} };
  const tr = new Translator(child, { cwd: '/tmp', model: 'cursor/auto' });
  tr.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'תשובה שלמה בבת אחת' }] } }));
  tr.line(JSON.stringify({ type: 'result', subtype: 'success', result: '' }));
  const texts = out.filter((o) => o.type === 'stream_event' && o.event.type === 'content_block_delta').map((o) => o.event.delta.text);
  t.eq('נפלט פעם אחת', texts.join(''), 'תשובה שלמה בבת אחת');
}

t.section('שורות שבורות ואירועים לא מוכרים');
{
  const out = [];
  const child = { sessionId: '', _line: (o) => out.push(o), _err: () => {} };
  const tr = new Translator(child, { cwd: '/tmp', model: 'cursor/auto' });
  tr.line('לא JSON בכלל');
  tr.line('{"type":"user","message":{}}');
  tr.line('{"type":"מה זה"}');
  tr.line('');
  t.eq('כלום לא נפלט וכלום לא קרס', out.length, 0);
}

t.done();
