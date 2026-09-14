// גשר Anthropic ⇄ OpenAI — ספק אחד או יותר
//
// למה בכלל גשר: הלקוח היחיד שיש כאן הוא ה-CLI של Claude Code, והוא מדבר
// Anthropic Messages API (`POST /v1/messages`) בלבד. הדרך להפנות אותו לספק אחר
// היא `ANTHROPIC_BASE_URL` — בדיוק כמו במסלול ה-CCR הקיים — אבל CCR *הוא* שער
// שמדבר Anthropic, ואילו שרתים תואמי-OpenAI (OmniRoute, LM Studio, Ollama,
// vLLM) מדברים `/v1/chat/completions`. הפניה ישירה של ה-CLI אליהם הייתה
// מחזירה 404/שגיאת סכימה בכל תור.
//
// הקובץ הזה מרים לכל ספק מאזין קטן על הלולאה המקומית שמדבר Anthropic כלפי
// ה-CLI, מתרגם את הבקשה ל-OpenAI, ומתרגם את התשובה (כולל SSE) חזרה. מבחינת
// שאר המערכת זה עוד "שער" בדיוק כמו CCR: מודלים ב-/api/config, וניתוב ב-transportOf.
//
// createProvider יוצר ספק כזה; loadProviders() בונה מהסביבה את הרשימה שהשרת
// משתמש בה. כל ספק מקבל תחילית משלו לתפריט המודלים, כדי ששני שרתים שמגישים
// מודל באותו שם (וגם הרשומות הישירות מול Anthropic) לא יתנגשו בניתוב.
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MODELS_TIMEOUT_MS = 4000;

// ---------- כלי עזר משותפים ----------

// `localhost` נפתר גם ל-::1 וגם ל-127.0.0.1, ולכן סירוב חיבור מגיע כ-AggregateError
// שה-message שלו ריק. בלי זה הודעת השגיאה בממשק הייתה "… לא זמין: ".
function errText(e) {
  if (!e) return 'שגיאה לא ידועה';
  if (e.message) return e.message;
  if (Array.isArray(e.errors) && e.errors.length) return e.errors.map((x) => x.message || String(x)).join('; ');
  return String(e);
}
// ---------- תרגום בקשה: Anthropic → OpenAI ----------

function joinText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

/** תוצאת כלי חוזרת ל-OpenAI כמחרוזת אחת; חלקי תמונה בתוכה לא ניתנים לייצוג ומסומנים. */
function toolResultText(block) {
  const c = block.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    text = c.map((b) => {
      if (!b) return '';
      if (b.type === 'text') return b.text || '';
      if (b.type === 'image') return '[תמונה]';
      return JSON.stringify(b);
    }).filter(Boolean).join('\n');
  } else text = c == null ? '' : JSON.stringify(c);
  return block.is_error ? 'Error: ' + text : text;
}

function imageUrlOf(source) {
  if (!source) return null;
  if (source.type === 'base64' && source.data) return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  if (source.type === 'url' && source.url) return source.url;
  return null;
}

function translateToolChoice(tc) {
  if (!tc) return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

/**
 * Anthropic → OpenAI. `stripPrefix` מסיר את תחילית הספק ממזהה המודל: התפריט
 * מציג `local/qwen3`, והספק עצמו מכיר רק את `qwen3`.
 */
function translateRequest(a, stripPrefix = (m) => String(m || '')) {
  const messages = [];
  const sys = joinText(a.system);
  if (sys.trim()) messages.push({ role: 'system', content: sys });

  for (const m of (Array.isArray(a.messages) ? a.messages : [])) {
    if (!m) continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content == null ? '' : m.content) }];

    if (m.role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const b of blocks) {
        if (!b) continue;
        // thinking / redacted_thinking נזרקים: אין להם מקבילה בפרוטוקול OpenAI,
        // והחתימה שהמצאנו בכיוון ההפוך ממילא חסרת משמעות לספק.
        if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input == null ? {} : b.input) },
          });
        }
      }
      // הודעה שכל תוכנה היה בלוק thinking שנזרק נשארת ריקה, ו-OpenAI דוחה
      // content:null בלי tool_calls. אין מה לשלוח — מדלגים עליה.
      if (!text && !toolCalls.length) continue;
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }

    // בצד Anthropic תוצאות כלים יושבות בתוך הודעת user; ב-OpenAI הן הודעות
    // role:'tool' נפרדות שחייבות לבוא מיד אחרי ה-assistant שקרא לכלי — ולכן
    // הן נפלטות ראשונות, לפני שאר תוכן ההודעה.
    const rest = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b) });
      else rest.push(b);
    }
    if (!rest.length) continue;

    const parts = [];
    for (const b of rest) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image') {
        const url = imageUrlOf(b.source);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (!parts.length) continue;
    const textOnly = parts.every((p) => p.type === 'text');
    messages.push({ role: 'user', content: textOnly ? parts.map((p) => p.text).join('\n') : parts });
  }

  const body = { model: stripPrefix(a.model), messages, stream: !!a.stream };
  if (typeof a.max_tokens === 'number') body.max_tokens = a.max_tokens;
  if (typeof a.temperature === 'number') body.temperature = a.temperature;
  if (typeof a.top_p === 'number') body.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) body.stop = a.stop_sequences.slice(0, 4);
  // כלים בעלי input_schema בלבד: הכלים המובנים בצד השרת של Anthropic
  // (web_search וכו׳) אינם ניתנים להעברה, והכללתם הייתה מפילה את הבקשה.
  const tools = (Array.isArray(a.tools) ? a.tools : [])
    .filter((t) => t && t.name && t.input_schema)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema },
    }));
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = translateToolChoice(a.tool_choice);
  }
  if (body.stream) body.stream_options = { include_usage: true };
  return body;
}

// ---------- תרגום תשובה: OpenAI → Anthropic ----------

const STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};
const mapStop = (r) => STOP_REASON[r] || (r ? 'end_turn' : null);

const newMsgId = () => 'msg_' + crypto.randomBytes(12).toString('hex');
const newToolId = () => 'toolu_' + crypto.randomBytes(12).toString('hex');

/** אומדן טוקנים — הספק מדווח שימוש רק בסוף, וכאן צריך מספר כבר ב-message_start. */
function estimateTokens(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.max(1, Math.ceil(s.length / 4));
}

function usageOf(u, fallbackIn) {
  return {
    input_tokens: (u && (u.prompt_tokens ?? u.input_tokens)) ?? fallbackIn ?? 0,
    output_tokens: (u && (u.completion_tokens ?? u.output_tokens)) ?? 0,
  };
}

function translateResponse(oa, model, fallbackIn) {
  const choice = (oa && Array.isArray(oa.choices) && oa.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (typeof reasoning === 'string' && reasoning) {
    content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  }
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  else if (Array.isArray(msg.content)) {
    const t = msg.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('');
    if (t) content.push({ type: 'text', text: t });
  }
  for (const tc of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
    if (!tc || !tc.function) continue;
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id || newToolId(), name: tc.function.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: oa && oa.id ? String(oa.id) : newMsgId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStop(choice.finish_reason) || 'end_turn',
    stop_sequence: null,
    usage: usageOf(oa && oa.usage, fallbackIn),
  };
}

/**
 * מתרגם זרם chunks של OpenAI לזרם אירועי SSE של Anthropic.
 *
 * טקסט וחשיבה זורמים מילה-מילה כפי שהם מגיעים. קריאות כלים דווקא נצברות
 * ונפלטות בסוף כבלוק שלם: ב-Anthropic מותר בלוק פתוח אחד בכל רגע, ואילו
 * OpenAI רשאי לפזר `tool_calls` לפי `index` בסדר כלשהו — פליטה תוך כדי הייתה
 * מחייבת לסגור בלוק ואז "לפתוח אותו מחדש", מה שאי אפשר. הכלי ממילא אינו רץ
 * לפני שהארגומנטים שלמים, ולכן ההשהיה אינה נראית למשתמש.
 */
function createStreamTranslator(res, model, fallbackIn) {
  const id = newMsgId();
  let index = -1;
  let textOpen = false;
  let thinkOpen = false;
  let stopReason = null;
  let usage = null;
  let closed = false;
  const toolCalls = new Map();   // index של OpenAI → { id, name, args }

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: fallbackIn || 0, output_tokens: 0 },
    },
  });
  send('ping', { type: 'ping' });

  const closeBlock = () => {
    if (!textOpen && !thinkOpen) return;
    send('content_block_stop', { type: 'content_block_stop', index });
    textOpen = false;
    thinkOpen = false;
  };
  const openText = () => {
    if (textOpen) return;
    closeBlock();
    index += 1;
    textOpen = true;
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  };
  const openThinking = () => {
    if (thinkOpen) return;
    closeBlock();
    index += 1;
    thinkOpen = true;
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
  };

  return {
    chunk(oa) {
      if (!oa) return;
      if (oa.usage) usage = oa.usage;
      const choice = Array.isArray(oa.choices) && oa.choices[0];
      if (!choice) return;
      if (choice.finish_reason) stopReason = mapStop(choice.finish_reason);
      const d = choice.delta || {};

      const reasoning = d.reasoning_content || d.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        openThinking();
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reasoning } });
      }
      if (typeof d.content === 'string' && d.content) {
        openText();
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const tc of (Array.isArray(d.tool_calls) ? d.tool_calls : [])) {
        if (!tc) continue;
        const key = tc.index == null ? 0 : tc.index;
        const entry = toolCalls.get(key) || { id: null, name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function && tc.function.name) entry.name = tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') entry.args += tc.function.arguments;
        toolCalls.set(key, entry);
      }
    },

    /** סוגר את ההודעה. `errorText` נשלח כאירוע error כשהתקלה קרתה אחרי שהזרם כבר יצא לדרך. */
    end(errorText) {
      if (closed) return;
      if (errorText) {
        closeBlock();
        send('error', { type: 'error', error: { type: 'api_error', message: errorText } });
        closed = true;
        res.end();
        return;
      }
      closeBlock();
      // חשיבה נפלטת עם חתימה מומצאת רק כדי לספק את סכימת הבלוק; בכיוון ההפוך
      // (translateRequest) בלוקים כאלה נזרקים, ולכן היא לעולם לא נשלחת לספק.
      for (const [, t] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        if (!t.name) continue;
        index += 1;
        send('content_block_start', {
          type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: t.id || newToolId(), name: t.name, input: {} },
        });
        send('content_block_delta', {
          type: 'content_block_delta', index,
          delta: { type: 'input_json_delta', partial_json: t.args || '{}' },
        });
        send('content_block_stop', { type: 'content_block_stop', index });
        if (!stopReason) stopReason = 'tool_use';
      }
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
        usage: usageOf(usage, fallbackIn),
      });
      send('message_stop', { type: 'message_stop' });
      closed = true;
      res.end();
    },
  };
}
// ---------- המאזין שמדבר Anthropic כלפי ה-CLI ----------

const ERROR_TYPE = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
};

function sendError(res, status, message) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: ERROR_TYPE[status] || 'api_error', message } }));
}

function sendJson(res, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

function collect(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); return reject(new Error('בקשה גדולה מדי')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** פירוק זרם SSE לאירועי `data:`; מחזיר את השארית שטרם הושלמה. */
function parseSse(buf, onData) {
  buf = buf.replace(/\r\n/g, '\n');   // יש ספקים ששולחים CRLF, ואז ההפרדה ב-\n\n לא נתפסת
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') onData(payload);
    }
  }
  return buf;
}
// ---------- ספק בודד ----------

/**
 * יוצר ספק תואם-OpenAI: שליפת מודלים, מעקב זמינות, וגשר Anthropic מקומי.
 *
 * id       — מזהה פנימי לניתוב (transportOf) ולהודעות שגיאה.
 * label    — השם שמוצג בסוף כל מודל בתפריט.
 * baseUrl  — כתובת הבסיס כולל /v1.
 * apiKey   — שרת מקומי לרוב לא מחייב מפתח, ולכן ערך דמה עדיף על 401 מבלבל.
 * prefix   — תחילית מזהי המודלים בתפריט (חייבת להיות ייחודית בין הספקים).
 * groupOf  — כותרת הקבוצה בבורר המודלים, לפי מזהה המודל אצל הספק. ספק עם
 *            עשרות מודלים מתפצל לתתי-קבוצות; ברירת המחדל היא קבוצה אחת.
 * envHint  — שם משתנה הסביבה שמופיע בהודעת שגיאה, כדי שיהיה ברור מה לתקן.
 */
function createProvider({ id, label, baseUrl, apiKey, prefix, timeoutMs, envHint, groupOf }) {
  const BASE_URL = String(baseUrl).replace(/\/+$/, '');
  const API_KEY = apiKey;
  const PREFIX = prefix;
  const REQUEST_TIMEOUT_MS = timeoutMs || 600000;
  const tag = '[' + id + ']';

  let modelIds = new Set();
  let lastModels = null;

  const hasModel = (mid) => !!mid && modelIds.has(mid);
  const upstreamModel = (mid) => (String(mid || '').startsWith(PREFIX) ? String(mid).slice(PREFIX.length) : String(mid || ''));

  // ---------- HTTP אל הספק ----------

  function upstream(pathSuffix, { method = 'GET', body = null, timeout = REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(BASE_URL + pathSuffix); } catch (e) { return reject(e); }
      const mod = url.protocol === 'https:' ? https : http;
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = {
        Accept: body && body.stream ? 'text/event-stream' : 'application/json',
        Authorization: 'Bearer ' + API_KEY,
        'x-api-key': API_KEY,
      };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      const req = mod.request(url, { method, headers }, resolve);
      req.on('error', reject);
      req.setTimeout(timeout, () => req.destroy(new Error(label + ' timeout')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  function readBody(res, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
        if (d.length > limit) { res.destroy(); reject(new Error('התשובה מ-' + label + ' חרגה מהגודל המותר')); }
      });
      res.on('end', () => resolve(d));
      res.on('error', reject);
    });
  }

  /**
   * שליפת המודלים הזמינים מ-GET /v1/models, לתפריט הבחירה.
   * מחזיר מערך בהצלחה ו-null בכישלון. הרשימה האחרונה שהצליחה נשמרת ב-lastModels
   * ונחשפת דרך getModels(), כך שכשל רשת לא מרוקן את התפריט באמצע עבודה — וגם
   * modelIds לא מתאפס, כדי ששיחה שרצה עכשיו על מודל של הספק לא תנותב פתאום
   * לחיבור הישיר מול Anthropic.
   */
  async function fetchModels() {
    try {
      const res = await upstream('/models', { timeout: MODELS_TIMEOUT_MS });
      const text = await readBody(res);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.warn(tag + ' /v1/models החזיר HTTP ' + res.statusCode);
        return null;
      }
      const j = JSON.parse(text);
      const data = Array.isArray(j) ? j : (Array.isArray(j && j.data) ? j.data : null);
      if (!data) { console.warn(tag + ' /v1/models לא החזיר data'); return null; }
      const models = data.map((m) => {
        const raw = typeof m === 'string' ? m : (m && (m.id || m.name));
        if (!raw) return null;
        // Claude Code הוא סוכן: בלי קריאת כלים כל תור נכשל. מודל שמצהיר מפורשות
        // שאינו תומך לא מוצג — עדיף שלא יופיע בתפריט מאשר שייבחר וייפול.
        const caps = (typeof m === 'object' && m.capabilities) || null;
        if (caps && caps.tool_calling === false) return null;
        // שרתים מקומיים מגישים גם מודלי הטמעה באותה רשימה, והם לא יודעים לשוחח.
        // LM Studio מסמן אותם ב-type רק ב-API הפרטי שלו, ולכן ב-/v1/models נותרת
        // גם בדיקת שם — מודל שיחה אמיתי כמעט לעולם לא נקרא embed.
        const kind = typeof m === 'object' ? m.type : '';
        if (kind === 'embeddings' || kind === 'embedding') return null;
        if (/(^|[-_/])embed/i.test(String(raw))) return null;
        const name = (typeof m === 'object' && (m.display_name || m.name)) || raw;
        // `name` נושא את שם הספק כי הוא מוצג גם מחוץ להקשר (שורת המצב, דואט);
        // `short` הוא מה שמופיע בתוך הקבוצה בבורר, שם הספק כבר כתוב בכותרת.
        return {
          id: PREFIX + raw,
          name: name + ' · ' + label,
          short: name,
          group: groupOf ? groupOf(raw) : label,
          efforts: [],
        };
      }).filter(Boolean);
      if (!models.length) return null;
      // הספק מחזיר את המודלים בסדר משלו, ובו מודלים מאותה קבוצה מפוזרים.
      // מיון יציב לפי סדר ההופעה הראשון של כל קבוצה שומר על סדר הספק בתוך
      // הקבוצה, ובכל זאת מגיש את הרשימה כשהקבוצות שלמות.
      const order = [];
      for (const m of models) if (!order.includes(m.group)) order.push(m.group);
      models.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
      modelIds = new Set(models.map((m) => m.id));
      lastModels = models;
      return models;
    } catch (e) {
      console.warn(tag + ' /v1/models נכשל:', errText(e));
      return null;
    }
  }

  /** הרשימה האחרונה שהצליחה — נקראת סינכרונית מ-/api/config, בלי לחסום על הרשת. */
  const getModels = () => lastModels || [];

  /**
   * מעקב רקע אחרי זמינות הספק.
   *
   * הבדיקה הראשונה יוצאת מיד עם timeout קצר (MODELS_TIMEOUT_MS), ולא חוסמת את
   * עליית השרת: אם הספק עדיין עולה — הממשק עולה בלעדיו והמעקב ממשיך לנסות
   * ברקע עם השהיה גדלה, עד 30 שנ׳. ברגע שהוא זמין המודלים נכנסים לתפריט מעצמם,
   * בלי להפעיל מחדש. אחרי הצלחה עוברים לרענון איטי, שגם קולט מודלים שנטענו
   * בצד הספק אחרי שהשרת כבר רץ.
   */
  function startModelWatcher(onChange) {
    const RETRY_MIN = 2000, RETRY_MAX = 30000, STEADY = 300000;
    let delay = RETRY_MIN;
    let timer = null;
    let stopped = false;
    let announced = false;

    const tick = async () => {
      if (stopped) return;
      const models = await fetchModels();
      if (models) {
        if (!announced) {
          console.log(`  \x1b[90m${label}: ${models.length} מודלים זמינים\x1b[0m`);
          announced = true;
        }
        delay = STEADY;
        try { onChange(models); } catch { /* המאזין לא אמור להפיל את המעקב */ }
      } else {
        // ריווח גדל: ספק שלא רץ בכלל לא ייצור רעש בלוג כל שתי שניות.
        if (announced) { announced = false; }
        delay = Math.min(delay * 2, RETRY_MAX);
      }
      timer = setTimeout(tick, delay);
      timer.unref?.();
    };

    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  // ---------- הטיפול בבקשות שמגיעות מה-CLI ----------

  const unavailable = (e) => label + ' לא זמין (' + BASE_URL + '): ' + errText(e) +
    (envHint ? ' — בדוק את ' + envHint : '');

  async function handleMessages(req, res) {
    let anth;
    try { anth = JSON.parse(await collect(req)); }
    catch (e) { return sendError(res, 400, 'גוף בקשה לא תקין: ' + e.message); }

    const model = String(anth.model || '');
    const body = translateRequest(anth, upstreamModel);
    // ה-CLI מציג ניצול הקשר כבר בתחילת התור, אבל השימוש מדווח רק בסוף.
    const estIn = estimateTokens(body.messages);

    let up;
    try { up = await upstream('/chat/completions', { method: 'POST', body }); }
    catch (e) { return sendError(res, 502, unavailable(e)); }

    // `stream_options` אינו מוכר לכל שרת תואם-OpenAI, ודחייה שלו מפילה תור שלם
    // רק בשביל מספרי שימוש. במקרה כזה מנסים שוב בלעדיו ונופלים לאומדן.
    if (up.statusCode === 400 && body.stream_options) {
      await readBody(up).catch(() => '');
      delete body.stream_options;
      try { up = await upstream('/chat/completions', { method: 'POST', body }); }
      catch (e) { return sendError(res, 502, unavailable(e)); }
    }

    if (up.statusCode < 200 || up.statusCode >= 300) {
      const text = await readBody(up).catch(() => '');
      let message = text;
      try { const j = JSON.parse(text); message = (j.error && (j.error.message || j.error)) || j.message || text; } catch {}
      return sendError(res, up.statusCode, label + ': ' + (typeof message === 'string' ? message : JSON.stringify(message)));
    }

    if (!body.stream) {
      const text = await readBody(up).catch(() => null);
      if (text == null) return sendError(res, 502, 'קריאת התשובה מ-' + label + ' נכשלה');
      try { return sendJson(res, translateResponse(JSON.parse(text), model, estIn)); }
      catch (e) { return sendError(res, 502, 'התשובה מ-' + label + ' לא הייתה JSON תקין: ' + e.message); }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    const tr = createStreamTranslator(res, model, estIn);

    let buf = '';
    up.on('data', (c) => {
      buf += c.toString('utf8');
      buf = parseSse(buf, (payload) => {
        try { tr.chunk(JSON.parse(payload)); } catch { /* פריים חלקי או תגובת keep-alive */ }
      });
    });
    up.on('end', () => tr.end());
    up.on('error', (e) => tr.end('הזרם מ-' + label + ' נקטע: ' + errText(e)));
    // ניתוק מצד ה-CLI (עצירת תור) — לא משאירים את החיבור למעלה תלוי באוויר.
    res.on('close', () => { if (!up.destroyed) up.destroy(); });
  }

  async function handleCountTokens(req, res) {
    let anth;
    try { anth = JSON.parse(await collect(req)); }
    catch (e) { return sendError(res, 400, 'גוף בקשה לא תקין: ' + e.message); }
    // שרת תואם-OpenAI לא חושף ספירת טוקנים, ולכן אומדן. עדיף על 404 שמפיל את התור.
    const body = translateRequest(anth, upstreamModel);
    sendJson(res, { input_tokens: estimateTokens(body.messages) + estimateTokens(body.tools || []) });
  }

  /**
   * מרים את הגשר על הלולאה המקומית בפורט אקראי.
   * מחזיר { url, token } להזנה ל-ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY של התהליך.
   */
  function startBridge() {
    const token = 'rtl-' + id + '-' + crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => {
      const auth = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (auth !== token) return sendError(res, 401, 'טוקן גשר לא תקין');

      const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
      if (req.method === 'POST' && url === '/v1/messages') return handleMessages(req, res).catch((e) => sendError(res, 500, errText(e)));
      if (req.method === 'POST' && url === '/v1/messages/count_tokens') return handleCountTokens(req, res).catch((e) => sendError(res, 500, errText(e)));
      if (req.method === 'GET' && url === '/v1/models') {
        return sendJson(res, { data: (lastModels || []).map((m) => ({ id: upstreamModel(m.id), type: 'model', display_name: m.name })) });
      }
      sendError(res, 404, 'הגשר אינו תומך ב-' + req.method + ' ' + url);
    });
    server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });

    return new Promise((resolve) => {
      server.once('error', (e) => { console.warn(tag + ' הגשר לא עלה:', errText(e)); resolve(null); });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        console.log(`  \x1b[90mגשר ${label}: http://127.0.0.1:${port} → ${BASE_URL}\x1b[0m`);
        resolve({ url: `http://127.0.0.1:${port}`, token, port, server });
      });
      server.unref?.();
    });
  }

  return {
    id, label, envHint,
    BASE_URL, PREFIX,
    hasModel, upstreamModel,
    fetchModels, getModels, startModelWatcher, startBridge,
  };
}

/**
 * הספקים תואמי-OpenAI שהשרת מרים, לפי הסביבה.
 *
 * ספק שכתובת הבסיס שלו רוקנה (`LOCAL_BASE_URL=`) פשוט לא נבנה — כך אפשר לכבות
 * אחד מהם בלי לגעת בקוד. ספק שכתובתו מוגדרת אבל אינו רץ אינו מפריע לכלום:
 * המעקב פשוט לא ימצא מודלים והתפריט יישאר בלעדיו.
 */
function loadProviders() {
  // הסדר כאן הוא גם סדר הקבוצות בבורר המודלים: השרת המקומי לפני OmniRoute,
  // כי הוא מגיש מעט מודלים וחבל שיישבו מתחת למאה רשומות.
  const defs = [
    {
      // שרת מודלים מקומי ברשת המקומית (LM Studio / Ollama / vLLM וכל תואם-OpenAI).
      id: 'local',
      label: 'מקומי',
      baseUrl: process.env.LOCAL_BASE_URL ?? 'http://192.168.1.253:1234/v1',
      apiKey: process.env.LOCAL_API_KEY || 'local',
      prefix: 'local/',
      groupOf: () => 'מודלים מקומיים',
      timeoutMs: Number(process.env.LOCAL_TIMEOUT_MS) || 0,
      envHint: 'LOCAL_BASE_URL',
    },
    {
      id: 'omniroute',
      label: 'OmniRoute',
      baseUrl: process.env.OMNIROUTE_BASE_URL ?? 'http://localhost:3000/v1',
      apiKey: process.env.OMNIROUTE_API_KEY || 'omniroute-local',
      prefix: 'omniroute/',
      // מזהי OmniRoute בנויים `ספק/מודל` (`auto/best-coding`, `aug/sonnet4.6`),
      // וכ-100 מודלים ברשימה שטוחה אינם ניתנים לסריקה. הפילוח לפי החלק הראשון
      // הוא בדיוק החלוקה שהמשתמש רואה גם בדאשבורד של OmniRoute.
      groupOf: (raw) => {
        const i = String(raw).indexOf('/');
        return i > 0 ? 'OmniRoute · ' + String(raw).slice(0, i) : 'OmniRoute';
      },
      timeoutMs: Number(process.env.OMNIROUTE_TIMEOUT_MS) || 0,
      envHint: 'OMNIROUTE_BASE_URL',
    },
  ];
  return defs.filter((d) => d.baseUrl && d.baseUrl.trim()).map(createProvider);
}

module.exports = {
  createProvider,
  loadProviders,
  // מיוצא לבדיקות ידניות של התרגום בלי להרים תהליך CLI
  _internal: { translateRequest, translateResponse, createStreamTranslator, parseSse },
};
