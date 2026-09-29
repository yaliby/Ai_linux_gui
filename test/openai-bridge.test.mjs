/**
 * הגשר Anthropic ⇄ OpenAI (`openai-bridge.js`) — תרגום בקשה, תשובה, וזרם.
 *
 * הלקוח היחיד בצד השני הוא ה-CLI של Claude Code, והוא לא סלחן: רצף SSE
 * שאינו תקין (בלוק שנפתח ולא נסגר, שני בלוקים פתוחים יחד, אינדקס שחוזר)
 * לא מייצר שגיאה ברורה אלא תור שנתקע או תשובה חלקית. לכן כאן יש מאמת רצף
 * מלא, ולא רק השוואת שדות.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const { loadProviders, createProvider, _internal } = require('../openai-bridge.js');
const { translateRequest, translateResponse, createStreamTranslator, parseSse, resolveModelAlias, classifyProbeFailure, modelProbePriority } = _internal;

const t = runner('גשר OpenAI ⇄ Anthropic');

/** תופס את מה שנכתב ל-res ומפרק אותו לאירועי SSE. */
function sink() {
  let raw = '';
  return {
    res: {
      write(s) { raw += s; return true; },
      end() { this.ended = true; },
      ended: false,
    },
    get events() {
      return raw.split('\n\n').filter((f) => f.trim()).map((f) => {
        const ev = (f.match(/^event: (.+)$/m) || [])[1];
        const data = (f.match(/^data: ([\s\S]+)$/m) || [])[1];
        return { ev, data: JSON.parse(data) };
      });
    },
    get raw() { return raw; },
  };
}

/**
 * מאמת את חוקי הפרוטוקול של Anthropic על רצף אירועים.
 * מחזיר רשימת הפרות — ריקה פירושה רצף שה-CLI יידע לקרוא.
 */
function validate(events) {
  const bad = [];
  if (!events.length || events[0].ev !== 'message_start') bad.push('לא מתחיל ב-message_start');
  let open = null;
  const seen = new Set();
  let stopped = false, delta = false;
  for (const { ev, data } of events) {
    if (stopped) { bad.push('אירוע אחרי message_stop: ' + ev); break; }
    if (ev === 'content_block_start') {
      if (open !== null) bad.push(`בלוק ${data.index} נפתח בזמן ש-${open} פתוח`);
      if (seen.has(data.index)) bad.push('אינדקס חוזר: ' + data.index);
      seen.add(data.index);
      open = data.index;
    } else if (ev === 'content_block_delta') {
      if (open !== data.index) bad.push(`delta לאינדקס ${data.index} בזמן ש-${open} פתוח`);
    } else if (ev === 'content_block_stop') {
      if (open !== data.index) bad.push(`stop לאינדקס ${data.index} בזמן ש-${open} פתוח`);
      open = null;
    } else if (ev === 'message_delta') {
      if (open !== null) bad.push('message_delta בזמן שבלוק פתוח');
      delta = true;
    } else if (ev === 'message_stop') {
      if (!delta) bad.push('message_stop בלי message_delta');
      stopped = true;
    }
  }
  if (open !== null) bad.push('בלוק ' + open + ' נשאר פתוח');
  if (!stopped) bad.push('הזרם לא נסגר ב-message_stop');
  const idx = [...seen].sort((a, b) => a - b);
  if (idx.length && (idx[0] !== 0 || idx[idx.length - 1] !== idx.length - 1)) bad.push('אינדקסים לא רציפים: ' + idx.join(','));
  return bad;
}

// ---------------------------------------------------------------------------
t.section('בקשה: Anthropic → OpenAI');
{
  const body = translateRequest({
    model: 'omniroute/gpt-5',
    system: [{ type: 'text', text: 'אתה עוזר' }],
    max_tokens: 1000, temperature: 0.3, stream: true,
    stop_sequences: ['a', 'b', 'c', 'd', 'e'],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'מה יש בקובץ?' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'צריך לקרוא', signature: 'x' },
        { type: 'text', text: 'אקרא' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file: 'a.txt' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'תוכן' }] },
        { type: 'text', text: 'תודה' },
      ] },
    ],
    tools: [
      { name: 'Read', description: 'קריאה', input_schema: { type: 'object' } },
      { name: 'web_search', type: 'web_search_20250305' },   // מובנה — לא ניתן להעברה
    ],
  }, (m) => m.replace(/^omniroute\//, ''));

  t.eq('התחילית הוסרה מהמודל', body.model, 'gpt-5');
  t.eq('system ראשון', body.messages[0], { role: 'system', content: 'אתה עוזר' });
  t.eq('user ראשון', body.messages[1], { role: 'user', content: 'מה יש בקובץ?' });
  t.eq('assistant עם קריאת כלי', body.messages[2].tool_calls[0].function, { name: 'Read', arguments: '{"file":"a.txt"}' });
  t.eq('חשיבה לא נשלחת לספק', /צריך לקרוא/.test(JSON.stringify(body)), false);
  t.eq('tool_result הפך להודעת tool', body.messages[3], { role: 'tool', tool_call_id: 'tu1', content: 'תוכן' });
  t.eq('והיא באה לפני שאר תוכן ההודעה', body.messages[4], { role: 'user', content: 'תודה' });
  t.eq('כלי מובנה סונן', body.tools.length, 1);
  t.eq('כלי רגיל הועבר', body.tools[0].function.name, 'Read');
  t.eq('stop מוגבל ל-4', body.stop.length, 4);
  t.eq('סטרימינג מבקש usage', body.stream_options, { include_usage: true });
}

t.section('בקשה — מקרי קצה');
{
  // הודעת assistant שכולה חשיבה: OpenAI דוחה content:null בלי tool_calls
  const b1 = translateRequest({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'רק מחשבה' }] }] });
  t.eq('הודעה שכולה חשיבה נשמטת', b1.messages.length, 0);

  // תמונה
  const b2 = translateRequest({ model: 'm', messages: [{ role: 'user', content: [
    { type: 'text', text: 'מה רואים?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
  ] }] });
  t.eq('תמונה הפכה ל-image_url', b2.messages[0].content[1].image_url.url, 'data:image/png;base64,AAA');
  t.eq('והטקסט נשאר לצידה', b2.messages[0].content[0], { type: 'text', text: 'מה רואים?' });

  // תוצאת כלי שנכשלה
  const b3 = translateRequest({ model: 'm', messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'קרס' },
    { type: 'text', text: 'ok' },
  ] }] });
  t.eq('שגיאה מסומנת בטקסט', b3.messages[0].content, 'Error: קרס');

  // תוצאת כלי עם תמונה בתוכה
  const b4 = translateRequest({ model: 'm', messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'לפני' }, { type: 'image', source: {} }] },
    { type: 'text', text: 'ok' },
  ] }] });
  t.eq('חלק תמונה מסומן ולא מפיל', b4.messages[0].content, 'לפני\n[תמונה]');

  // בחירת כלי
  t.eq('tool_choice: any', translateRequest({ model: 'm', messages: [], tool_choice: { type: 'any' }, tools: [{ name: 'a', input_schema: {} }] }).tool_choice, 'required');
  t.eq('tool_choice: כלי מסוים', translateRequest({ model: 'm', messages: [], tool_choice: { type: 'tool', name: 'Read' }, tools: [{ name: 'a', input_schema: {} }] }).tool_choice, { type: 'function', function: { name: 'Read' } });

  // גוף ריק לגמרי
  const b5 = translateRequest({});
  t.eq('בקשה ריקה לא מפילה', Array.isArray(b5.messages), true);
  t.eq('בלי כלים אין tools', b5.tools, undefined);
}

// ---------------------------------------------------------------------------
t.section('תשובה יחידה: OpenAI → Anthropic');
{
  const a = translateResponse({
    id: 'cmpl-1',
    choices: [{ finish_reason: 'tool_calls', message: {
      reasoning_content: 'חשבתי',
      content: 'הנה',
      tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
    } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, 'gpt-5', 0);

  t.eq('חשיבה ראשונה', a.content[0], { type: 'thinking', thinking: 'חשבתי', signature: '' });
  t.eq('טקסט', a.content[1], { type: 'text', text: 'הנה' });
  t.eq('כלי עם קלט מפוענח', a.content[2], { type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } });
  t.eq('סיבת עצירה', a.stop_reason, 'tool_use');
  t.eq('שימוש', a.usage, { input_tokens: 10, output_tokens: 5 });

  // ארגומנטים שבורים לא מפילים את התור
  const b = translateResponse({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'X', arguments: '{לא json' } }] } }] }, 'm', 0);
  t.eq('JSON שבור → קלט ריק', b.content[0].input, {});

  // תשובה ריקה לגמרי
  const c = translateResponse({ choices: [{ message: {} }] }, 'm', 3);
  t.eq('תמיד יש בלוק אחד', c.content, [{ type: 'text', text: '' }]);
  t.eq('input_tokens נופל לאומדן', c.usage.input_tokens, 3);
  t.eq('ברירת מחדל end_turn', c.stop_reason, 'end_turn');

  // content כמערך חלקים
  const d = translateResponse({ choices: [{ message: { content: [{ type: 'text', text: 'א' }, { type: 'text', text: 'ב' }] } }] }, 'm', 0);
  t.eq('חלקי טקסט מחוברים', d.content[0].text, 'אב');

  // content כמערך מחרוזות / אובייקטים ללא type (סגנון Gemini)
  const d2 = translateResponse({ choices: [{ message: { content: [{ text: 'שלום ' }, 'עולם'] } }] }, 'm', 0);
  t.eq('חלקי טקסט של Gemini מחוברים', d2.content[0].text, 'שלום עולם');

  // תגובה עם חשיבה בלבד מבטיחה בלוק טקסט (עבור פרוטוקול Anthropic)
  const d3 = translateResponse({ choices: [{ message: { reasoning_content: 'חושב' } }] }, 'm', 0);
  t.eq('תשובה עם חשיבה בלבד כוללת בלוק טקסט', d3.content.some((b) => b.type === 'text'), true);

  t.eq('length → max_tokens', translateResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }, 'm', 0).stop_reason, 'max_tokens');
}

// ---------------------------------------------------------------------------
t.section('זרם: chunks של OpenAI → SSE של Anthropic');
{
  const s = sink();
  const tr = createStreamTranslator(s.res, 'gpt-5', 7);
  tr.chunk({ choices: [{ delta: { reasoning_content: 'מחשבה ' } }] });
  tr.chunk({ choices: [{ delta: { reasoning_content: 'נוספת' } }] });
  tr.chunk({ choices: [{ delta: { content: 'שלום ' } }] });
  tr.chunk({ choices: [{ delta: { content: 'עולם' } }] });
  tr.chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  tr.chunk({ usage: { prompt_tokens: 11, completion_tokens: 4 } });
  tr.end();

  const ev = s.events;
  t.eq('רצף תקין', validate(ev), []);
  t.eq('נפתח ב-message_start', ev[0].ev, 'message_start');
  t.eq('אומדן קלט כבר בהתחלה', ev[0].data.message.usage.input_tokens, 7);
  const thinking = ev.filter((e) => e.ev === 'content_block_delta' && e.data.delta.type === 'thinking_delta');
  t.eq('חשיבה זרמה בשני חלקים', thinking.map((e) => e.data.delta.thinking).join(''), 'מחשבה נוספת');
  const text = ev.filter((e) => e.ev === 'content_block_delta' && e.data.delta.type === 'text_delta');
  t.eq('טקסט זרם', text.map((e) => e.data.delta.text).join(''), 'שלום עולם');
  t.eq('חשיבה וטקסט בשני בלוקים', new Set(ev.filter((e) => e.ev === 'content_block_start').map((e) => e.data.index)).size, 2);
  const md = ev.find((e) => e.ev === 'message_delta');
  t.eq('סיבת עצירה', md.data.delta.stop_reason, 'end_turn');
  t.eq('שימוש אמיתי בסוף', md.data.usage, { input_tokens: 11, output_tokens: 4 });
  t.eq('התגובה נסגרה', s.res.ended, true);
}

t.section('זרם עם קריאות כלים');
{
  const s = sink();
  const tr = createStreamTranslator(s.res, 'm', 0);
  tr.chunk({ choices: [{ delta: { content: 'רגע' } }] });
  // שני כלים, מפוזרים ולא לפי הסדר — בדיוק מה ש-OpenAI מרשה לעצמו
  tr.chunk({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'Write', arguments: '{"p":' } }] } }] });
  tr.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{"f":"x"}' } }] } }] });
  tr.chunk({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"y"}' } }] } }] });
  tr.chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  tr.end();

  const ev = s.events;
  t.eq('רצף תקין', validate(ev), []);
  const tools = ev.filter((e) => e.ev === 'content_block_start' && e.data.content_block.type === 'tool_use');
  t.eq('שני כלים', tools.length, 2);
  t.eq('לפי סדר האינדקס של הספק', tools.map((e) => e.data.content_block.name), ['Read', 'Write']);
  const args = ev.filter((e) => e.ev === 'content_block_delta' && e.data.delta.type === 'input_json_delta');
  t.eq('ארגומנטים שנצברו מכמה chunks', args[1].data.delta.partial_json, '{"p":"y"}');
  t.eq('JSON שלם', JSON.parse(args[1].data.delta.partial_json), { p: 'y' });
  t.eq('סיבת עצירה', ev.find((e) => e.ev === 'message_delta').data.delta.stop_reason, 'tool_use');
}

t.section('זרם — מקרי קצה');
{
  // כלי בלי שם (chunk חלקי שנקטע) — לא נפלט בלוק פגום
  let s = sink();
  let tr = createStreamTranslator(s.res, 'm', 0);
  tr.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] });
  tr.end();
  t.eq('כלי בלי שם נזרק', s.events.filter((e) => e.ev === 'content_block_start').length, 0);
  t.eq('והרצף עדיין תקין', validate(s.events), []);

  // שגיאה באמצע הזרם
  s = sink();
  tr = createStreamTranslator(s.res, 'm', 0);
  tr.chunk({ choices: [{ delta: { content: 'חצי' } }] });
  tr.end('הספק ניתק');
  const ev = s.events;
  t.eq('הבלוק נסגר לפני השגיאה', ev[ev.length - 2].ev, 'content_block_stop');
  t.eq('אירוע שגיאה', ev[ev.length - 1].ev, 'error');
  t.eq('עם ההודעה', ev[ev.length - 1].data.error.message, 'הספק ניתק');

  // end כפול לא כותב פעמיים
  s = sink();
  tr = createStreamTranslator(s.res, 'm', 0);
  tr.end();
  const n = s.events.length;
  tr.end();
  t.eq('end שני נבלע', s.events.length, n);

  // chunk אחרי end לא כותב לתגובה סגורה
  tr.chunk({ choices: [{ delta: { content: 'מאוחר' } }] });
  t.eq('chunk אחרי סגירה לא נכתב', s.events.length, n);

  // chunk ריק / שבור
  s = sink();
  tr = createStreamTranslator(s.res, 'm', 0);
  tr.chunk(null); tr.chunk({}); tr.chunk({ choices: [] }); tr.chunk({ choices: [{}] });
  tr.end();
  t.eq('חבילות ריקות לא מפילות', validate(s.events), []);

  // זרם עם חשיבה בלבד (Gemini שסיים את כל הטוקנים על חשיבה)
  s = sink();
  tr = createStreamTranslator(s.res, 'gemini-3.8-flash', 0);
  tr.chunk({ choices: [{ delta: { reasoning_content: 'רעיון' } }] });
  tr.chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  tr.end();
  t.eq('זרם חשיבה בלבד מייצר רצף תקין', validate(s.events), []);
  t.eq('ונכלל בלוק טקסט תקין', s.events.some((e) => e.ev === 'content_block_start' && e.data.content_block.type === 'text'), true);

  // chunk עם תוכן במערך (סגנון Gemini)
  s = sink();
  tr = createStreamTranslator(s.res, 'gemini-3.8-flash', 0);
  tr.chunk({ choices: [{ delta: { content: [{ text: 'שלום' }] } }] });
  tr.end();
  t.eq('תוכן מערך בזרם נפרס לטקסט', s.events.some((e) => e.ev === 'content_block_delta' && e.data.delta.text === 'שלום'), true);
}

// ---------------------------------------------------------------------------
t.section('מיפוי מודלי Gemini שהוצאו משימוש (404)');
{
  t.eq('gemini-2.5-flash ממופה ל-3.8-flash', resolveModelAlias('gemini-2.5-flash'), 'gemini-3.8-flash');
  t.eq('gemini/gemini-2.5-pro ממופה ל-3.1-pro-preview', resolveModelAlias('gemini/gemini-2.5-pro'), 'gemini/gemini-3.1-pro-preview');
  t.eq('gemini-2.5-flash-lite ממופה ל-3.5-flash-lite', resolveModelAlias('gemini-2.5-flash-lite'), 'gemini-3.5-flash-lite');
  t.eq('tllm/gemini_2_5_pro ממופה ל-tllm/gemini_3_pro', resolveModelAlias('tllm/gemini_2_5_pro'), 'tllm/gemini_3_pro');
  t.eq('מודל פעיל לא משתנה', resolveModelAlias('gemini-3.8-flash'), 'gemini-3.8-flash');
}

// ---------------------------------------------------------------------------
t.section('טעינת ספקים: GEMINI_API_KEY');
{
  const origKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const providers = loadProviders();
    const gem = providers.find((p) => p.id === 'gemini');
    t.ok('ספק Gemini נטען כשיש מפתח', !!gem);
    t.eq('תחילית הספק', gem && gem.PREFIX, 'gemini/');
  } finally {
    if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey;
    else delete process.env.GEMINI_API_KEY;
  }
}

// ---------------------------------------------------------------------------
t.section('פירוק SSE');
{
  let got = [];
  let rest = parseSse('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"', (d) => got.push(d));
  t.eq('שתי חבילות שלמות', got, ['{"a":1}', '{"b":2}']);
  t.eq('השארית נשמרת להמשך', rest, 'data: {"c"');

  got = [];
  rest = parseSse(rest + ':3}\n\n', (d) => got.push(d));
  t.eq('השארית הושלמה', got, ['{"c":3}']);

  got = [];
  parseSse('data: {"a":1}\r\n\r\n', (d) => got.push(d));
  t.eq('CRLF נתמך', got, ['{"a":1}']);

  got = [];
  parseSse(': keep-alive\n\ndata: [DONE]\n\nevent: x\ndata: {"z":1}\n\n', (d) => got.push(d));
  t.eq('הערות ו-[DONE] מסוננים, event: נקרא', got, ['{"z":1}']);
}

/* ---------------------------------------------------------------------------
 * ריווח בדיקת הזמינות
 *
 * הבדיקה כאן היא על *מדיניות* ולא על תזמון: הרצה אמיתית של המעקב הייתה לוקחת
 * רבע שעה כדי להראות מה שהחישוב אומר בשורה אחת. מה שנשמר הוא ההתנהגות
 * שנצפתה ביומן אמיתי — ספק נעדר שייצר 60% משורות היומן — ומה שאמור להחליף
 * אותה: התכנסות לרבע שעה, בלי לוותר על קליטה מהירה של ספק שרק מתאחר.
 * ------------------------------------------------------------------------- */
t.section('ריווח בדיקת זמינות של ספק');
{
  const { PROBE, nextProbeDelay } = _internal;

  /** מריץ את המדיניות n כישלונות רצופים ומחזיר את סדרת ההשהיות. */
  const series = (n) => {
    const out = [];
    let delay = PROBE.RETRY_MIN, fails = 0;
    for (let i = 0; i < n; i++) { fails++; delay = nextProbeDelay(delay, fails); out.push(delay); }
    return out;
  };

  t.eq('ספק שרק מתאחר נבדק מיד שוב', series(3), [4000, 8000, 16000]);

  const s = series(4);
  t.ok('לפני ההכרזה התקרה היא RETRY_MAX', Math.max(...s) <= PROBE.RETRY_MAX, s);

  const long = series(30);
  t.eq('אחרי היעדרות ממושכת מתכנסים לתקרה הגבוהה', long[long.length - 1], PROBE.ABSENT_MAX);

  // הטענה שבגללה השינוי נעשה: היקף הבדיקות ביממה מול ספק שאינו קיים.
  const perDay = (delays) => {
    let t0 = 0, n = 0, delay = PROBE.RETRY_MIN, fails = 0;
    while (t0 < 86400000) { fails++; delay = delays(delay, fails); t0 += delay; n++; }
    return n;
  };
  const before = perDay((d) => Math.min(d * 2, PROBE.RETRY_MAX));   // ההתנהגות הישנה
  const after = perDay(nextProbeDelay);
  t.ok('ביממה מול ספק נעדר: לפחות פי 20 פחות בדיקות', before / after >= 20, { before, after });
  t.ok('ובכל זאת נבדק לפחות פעם ברבע שעה', 86400000 / after >= PROBE.ABSENT_MAX * 0.9, { after });
}

// ---------------------------------------------------------------------------
t.section('סיווג כשל של בדיקת מודל');
{
  t.eq('404 הוא קשיח', classifyProbeFailure(404, 'no longer available to new users'), 'hard');
  t.eq('כלי לא נתמך הוא קשיח', classifyProbeFailure(400, 'tools not supported'), 'hard');
  t.eq('CLI חסר הוא קשיח גם על 502', classifyProbeFailure(502, 'Auggie CLI not found in container'), 'hard');
  t.eq('נתיב לא מוחלט הוא קשיח', classifyProbeFailure(500, 'DEVIN_AGENTIC_HOME must be absolute path'), 'hard');
  t.eq('ENOENT הוא קשיח', classifyProbeFailure(502, 'spawn zcode ENOENT'), 'hard');
  t.eq('403 הוא קשיח', classifyProbeFailure(403, 'free tier only'), 'hard');
  t.eq('429 הוא רך', classifyProbeFailure(429, 'quota exceeded'), 'soft');
  t.eq('503 הוא רך', classifyProbeFailure(503, 'high demand'), 'soft');
  t.eq('דחיית max_tokens היא רכה', classifyProbeFailure(400, 'Unsupported parameter: max_tokens'), 'soft');
  t.eq('פסק זמן בלי סטטוס הוא רך', classifyProbeFailure(0, 'OmniRoute timeout'), 'soft');
  t.eq('auto נבדק אחרון', modelProbePriority('auto/best-coding'), 2);
  t.eq('תמונה אחרי מודלי שיחה', modelProbePriority('aihorde/Qwen-Image'), 1);
  t.eq('מודל רגיל ראשון', modelProbePriority('gpt/gpt-5'), 0);
}

function readReq(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
const completion = (text) => ({ id: 'cmpl', choices: [{ finish_reason: 'stop', message: { content: text } }] });

/**
 * שרת OpenAI מזויף: רשימה מעורבת, ותשובת צ׳אט לפי מזהה.
 * `delayMs` מעכב את התשובה כדי לוודא ששליפת הרשימה לא מחכה לבדיקות.
 */
function startFake() {
  const state = { delayMs: 0, probes: [], override: new Map() };
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url.endsWith('/models')) {
      return sendJson(res, 200, { data: [
        { id: 'good/m', capabilities: { tool_calling: true } },
        { id: 'gone/m', capabilities: { tool_calling: true } },
        { id: 'rate/m', capabilities: { tool_calling: true } },
        { id: 'cli/m', capabilities: { tool_calling: true } },
        { id: 'busy/m', capabilities: { tool_calling: true } },
        { id: 'tools/m', capabilities: { tool_calling: true } },
        { id: 'bare/m', capabilities: { tool_calling: true } },
        { id: 'auto/fast', capabilities: { tool_calling: true } },
        { id: 'embed/m', capabilities: { tool_calling: true } },
        { id: 'notool/m', capabilities: { tool_calling: false } },
      ] });
    }
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      const body = await readReq(req);
      if (body.messages && body.messages[0] && body.messages[0].content === 'ping') state.probes.push(body);
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      const id = body.model;
      const fail = (code, message) => sendJson(res, code, { error: { message } });
      const over = state.override.get(id);
      if (over === 200) return sendJson(res, 200, completion('pong'));
      if (over && over.status) return fail(over.status, over.message || 'error');
      if (id === 'gone/m') return fail(404, 'gemini-2.5 is no longer available to new users');
      if (id === 'rate/m') return fail(429, 'quota exceeded');
      if (id === 'cli/m') return fail(502, 'Auggie CLI not found in container');
      if (id === 'busy/m') return fail(503, 'high demand');
      if (id === 'tools/m') return fail(400, 'tools not supported');
      if (id === 'bare/m' && body.max_tokens != null) return fail(400, 'Unsupported parameter: max_tokens');
      if (id === 'good/m' || id === 'bare/m' || id === 'auto/fast') return sendJson(res, 200, completion('pong'));
      return fail(500, 'unknown');
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function sortedIds(p) {
  return p.getModels().map((m) => m.id).sort();
}

await (async () => {
  t.section('סינון מודלים לפי בריאות');
  const fake = await startFake();
  const bridges = [];
  let clock = 5_000_000;
  const healthOf = (extra) => ({
    enabled: true,
    auto: false,
    now: () => clock,
    graceMs: 0,
    concurrency: 4,
    probeTimeoutMs: 2000,
    healthyTtlMs: 100000,
    coolingTtlMs: 5000,
    unhealthyTtlMs: 20000,
    trustMs: 8000,
    tickMs: 60 * 60 * 1000,
    ...extra,
  });
  const make = (health) => createProvider({
    id: 'omniroute', label: 'OmniRoute', baseUrl: fake.baseUrl, apiKey: 'test',
    prefix: 'omniroute/', groupOf: () => 'OmniRoute', health,
  });
  try {
    const offEnv = process.env.OMNIROUTE_HEALTH_PROBE;
    process.env.OMNIROUTE_HEALTH_PROBE = '0';
    try {
      const off = make(undefined);
      const listed = await off.fetchModels();
      t.eq('בלי בדיקות הרשימה השמישה שלמה', listed && listed.length, 8);
      t.eq('והתפריט מציג את כולה', off.getModels().length, 8);
      t.eq('הטמעה לא נכנסת', off.hasModel('omniroute/embed/m'), false);
      t.eq('בלי tool_calling לא נכנס', off.hasModel('omniroute/notool/m'), false);
    } finally {
      if (offEnv === undefined) delete process.env.OMNIROUTE_HEALTH_PROBE;
      else process.env.OMNIROUTE_HEALTH_PROBE = offEnv;
    }

    const p = make(healthOf());
    await p.fetchModels();
    t.eq('בלי חלון חסד אין עדיין מה להציג', p.getModels().length, 0);
    t.eq('אבל הניתוב עדיין מכיר מודל מהרשימה', p.hasModel('omniroute/gone/m'), true);
    await p.probeHealth();
    t.eq('בתפריט רק מי שענה', sortedIds(p), ['omniroute/auto/fast', 'omniroute/bare/m', 'omniroute/good/m']);
    t.eq('מודל שנעלם לא מוצע', p.getModels().some((m) => m.id === 'omniroute/gone/m'), false);
    t.eq('429 לא מוצע', p.getModels().some((m) => m.id === 'omniroute/rate/m'), false);
    t.eq('503 לא מוצע', p.getModels().some((m) => m.id === 'omniroute/busy/m'), false);
    t.eq('CLI חסר לא מוצע', p.getModels().some((m) => m.id === 'omniroute/cli/m'), false);
    t.eq('כלים לא נתמכים לא מוצעים', p.getModels().some((m) => m.id === 'omniroute/tools/m'), false);
    t.ok('הבדיקה קצרה ובלי סכמת כלים', fake.state.probes.length > 0 && fake.state.probes.every((b) => !b.tools && JSON.stringify(b).length < 400), fake.state.probes[0]);
    t.ok('דחיית max_tokens נוסתה שוב בלי השדה', fake.state.probes.some((b) => b.model === 'bare/m' && b.max_tokens == null));

    const rateAt = clock;
    fake.state.override.set('rate/m', 200);
    clock = rateAt + 4999;
    await p.probeHealth();
    t.eq('עוד בתוך ה-TTL הרך המודל לא חוזר', p.getModels().some((m) => m.id === 'omniroute/rate/m'), false);
    clock = rateAt + 5001;
    await p.probeHealth();
    t.ok('אחרי התקררות מודל שהחלים חוזר', p.getModels().some((m) => m.id === 'omniroute/rate/m'));
    fake.state.override.delete('rate/m');

    fake.state.override.set('gone/m', 200);
    clock = rateAt + 5001;
    await p.probeHealth();
    t.eq('כשל קשיח לא חוזר ב-TTL הקצר', p.getModels().some((m) => m.id === 'omniroute/gone/m'), false);
    t.eq('CLI חסר גם הוא ממתין ל-TTL הארוך', p.getModels().some((m) => m.id === 'omniroute/cli/m'), false);
    clock = rateAt + 20001;
    await p.probeHealth();
    t.ok('אחרי ה-TTL הארוך 404 שהחלים חוזר', p.getModels().some((m) => m.id === 'omniroute/gone/m'));
    fake.state.override.delete('gone/m');

    const grace = make(healthOf({ graceMs: 60000 }));
    clock = 8_000_000;
    await grace.fetchModels();
    t.ok('בחלון החסד מוצג גם מי שטרם נבדק', grace.getModels().some((m) => m.id === 'omniroute/gone/m'));
    await grace.probeHealth();
    t.eq('תוצאה קשיחה מסירה אותו גם בתוך החלון', grace.getModels().some((m) => m.id === 'omniroute/gone/m'), false);
    t.ok('ותקין נשאר', grace.getModels().some((m) => m.id === 'omniroute/good/m'));

    const turn = make(healthOf());
    clock = 9_000_000;
    await turn.fetchModels();
    await turn.probeHealth();
    const bridge = await turn.startBridge();
    bridges.push(bridge);
    const postTurn = (model) => fetch(bridge.url + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': bridge.token },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });

    const cooled = make(healthOf());
    clock = 10_000_000;
    await cooled.fetchModels();
    await cooled.probeHealth();
    t.eq('429 אחרי בדיקה לא בתפריט', cooled.getModels().some((m) => m.id === 'omniroute/rate/m'), false);
    fake.state.override.set('rate/m', 200);
    const bridge2 = await cooled.startBridge();
    bridges.push(bridge2);
    const okTurn = await fetch(bridge2.url + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': bridge2.token },
      body: JSON.stringify({ model: 'omniroute/rate/m', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    t.eq('תור אמיתי שהצליח', okTurn.status, 200);
    t.ok('מחזיר את המודל לתפריט בלי לחכות לבדיקה', cooled.getModels().some((m) => m.id === 'omniroute/rate/m'));
    fake.state.override.delete('rate/m');

    fake.state.override.set('good/m', { status: 404, message: 'no longer available to new users' });
    const broken = await postTurn('omniroute/good/m');
    t.eq('תור שנכשל ב-404', broken.status, 404);
    t.eq('יורד מהתפריט בלי אתחול', turn.getModels().some((m) => m.id === 'omniroute/good/m'), false);
    t.eq('אבל שיחה קיימת עדיין מנותבת אליו', turn.hasModel('omniroute/good/m'), true);
    fake.state.override.delete('good/m');

    const trusted = make(healthOf({ healthyTtlMs: 1000, trustMs: 8000 }));
    clock = 11_000_000;
    fake.state.override.set('busy/m', 200);
    await trusted.fetchModels();
    await trusted.probeHealth();
    t.ok('אחרי הצלחה זמנית המודל בתפריט', trusted.getModels().some((m) => m.id === 'omniroute/busy/m'));
    const bridge3 = await trusted.startBridge();
    bridges.push(bridge3);
    const trustRes = await fetch(bridge3.url + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': bridge3.token },
      body: JSON.stringify({ model: 'omniroute/busy/m', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    t.eq('תור מוצלח לפני כשל רך', trustRes.status, 200);
    fake.state.override.delete('busy/m');
    clock = 11_000_000 + 1001;
    await trusted.probeHealth();
    t.ok('כשל רך של בדיקה לא מוחק תור שהצליח', trusted.getModels().some((m) => m.id === 'omniroute/busy/m'));
    clock = 11_000_000 + 8001;
    await trusted.probeHealth();
    t.eq('אחרי חלון האמון בדיקה רכה כן מקררת', trusted.getModels().some((m) => m.id === 'omniroute/busy/m'), false);

    fake.state.delayMs = 400;
    const slow = make(healthOf({ auto: true, graceMs: 0 }));
    const t0 = Date.now();
    const listed = await slow.fetchModels();
    const elapsed = Date.now() - t0;
    t.ok('שליפת הרשימה לא ממתינה לבדיקות', elapsed < 300, elapsed);
    t.eq('הרשימה עצמה מלאה', listed && listed.length, 8);
    t.eq('בלי חסד ובלי תוצאה התפריט ריק', slow.getModels().length, 0);
    await slow.probeHealth();
    t.ok('אחרי שהבדיקות חוזרות מופיע מודל תקין', slow.getModels().some((m) => m.id === 'omniroute/good/m'));
    fake.state.delayMs = 0;
  } finally {
    for (const b of bridges) { try { await new Promise((r) => b.server.close(r)); } catch {} }
    await fake.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

t.done();
