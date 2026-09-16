/**
 * הגשר Anthropic ⇄ OpenAI (`openai-bridge.js`) — תרגום בקשה, תשובה, וזרם.
 *
 * הלקוח היחיד בצד השני הוא ה-CLI של Claude Code, והוא לא סלחן: רצף SSE
 * שאינו תקין (בלוק שנפתח ולא נסגר, שני בלוקים פתוחים יחד, אינדקס שחוזר)
 * לא מייצר שגיאה ברורה אלא תור שנתקע או תשובה חלקית. לכן כאן יש מאמת רצף
 * מלא, ולא רק השוואת שדות.
 */
import { createRequire } from 'node:module';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const { _internal } = require('../openai-bridge.js');
const { translateRequest, translateResponse, createStreamTranslator, parseSse } = _internal;

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

t.done();
