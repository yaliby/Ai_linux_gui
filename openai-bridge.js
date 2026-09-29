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

/**
 * מיפוי שמות מודלים של Google Gemini שהוצאו משימוש ב-API (מחזירים 404)
 * למודלים המקבילים העדכניים של Gemini 3.x.
 */
const DEPRECATED_GEMINI_ALIASES = {
  'gemini-2.5-flash': 'gemini-3.8-flash',
  'gemini-2.5-pro': 'gemini-3.1-pro-preview',
  'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-1.5-flash': 'gemini-3.8-flash',
  'gemini-1.5-pro': 'gemini-3.1-pro-preview',
  'gemini-2.0-flash': 'gemini-3.8-flash',
  'gemini_2_5_pro': 'gemini_3_pro',
  'gemini_2_0_flash': 'gemini_3_flash',
  'gemini_1_5_flash': 'gemini_3_flash',
};

function resolveModelAlias(model) {
  if (!model) return model;
  const s = String(model);
  const parts = s.split('/');
  const leaf = parts[parts.length - 1];
  if (DEPRECATED_GEMINI_ALIASES[leaf]) {
    parts[parts.length - 1] = DEPRECATED_GEMINI_ALIASES[leaf];
    return parts.join('/');
  }
  return model;
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
    const t = msg.content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      return '';
    }).join('');
    if (t) content.push({ type: 'text', text: t });
  }
  for (const tc of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
    if (!tc || !tc.function) continue;
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id || newToolId(), name: tc.function.name, input });
  }
  if (!content.some((b) => b.type === 'text' || b.type === 'tool_use')) content.push({ type: 'text', text: '' });
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
  let hasText = false;
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
    hasText = true;
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
      } else if (Array.isArray(d.content)) {
        const t = d.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
        if (t) {
          openText();
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
        }
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
      if (!toolCalls.size && !hasText) {
        index += 1;
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        send('content_block_stop', { type: 'content_block_stop', index });
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
// ---------- מדיניות בדיקת הזמינות ----------

/*
 * שני סוגי כישלון, ולא אחד. ספק ש*עולה* ייענה בעוד שניות, ולכן כדאי לנסות
 * אותו מהר. ספק ש*נעדר* — כתובת שכבר לא קיימת ברשת, מכונה שכובתה, פורט
 * שהוחלף — לא ייענה היום, ובדיקה כל 30 שנ׳ מולו היא 2,880 שורות ביומן ליממה.
 * היומן מסתובב ב-4MB, ולכן המחיר אינו רעש בלבד אלא מחיקת ההיסטוריה שבשבילה
 * הוא קיים: ביומן אמיתי כאן 60% מהשורות היו בדיוק הכישלון החוזר הזה.
 *
 * לכן התקרה כפולה: RETRY_MAX כל עוד סביר שהספק רק מתאחר, ו-ABSENT_MAX אחרי
 * ABSENT_AFTER כישלונות רצופים. ספק שיחזור עדיין נקלט מעצמו תוך רבע שעה —
 * בלי להפעיל מחדש — ומי שלא חוזר פשוט שותק.
 */
const PROBE = {
  RETRY_MIN: 2000,      // הניסיון החוזר הראשון
  RETRY_MAX: 30000,     // תקרה כל עוד מניחים שהספק עולה
  ABSENT_MAX: 900000,   // תקרה אחרי שהוכרז נעדר — רבע שעה
  STEADY: 300000,       // רענון שגרתי אחרי הצלחה, לקליטת מודלים שנוספו
  ABSENT_AFTER: 6,      // כישלונות רצופים (~90 שנ׳) עד ההכרזה
};

/** ההשהיה הבאה בבדיקת זמינות: הכפלה עד לתקרה שנגזרת ממספר הכישלונות ברצף. */
function nextProbeDelay(delay, fails) {
  const ceiling = fails >= PROBE.ABSENT_AFTER ? PROBE.ABSENT_MAX : PROBE.RETRY_MAX;
  return Math.min(delay * 2, ceiling);
}

/*
 * בריאות של מודל בודד, לא של הספק.
 *
 * `/v1/models` רק אומר שהשער מכיר את השם. אצל OmniRoute זו רשימה של מאות
 * מזהים, ורבים מהם נכשלים ברגע ש-Claude Code פותח תור: 404 על מודל שהוצא
 * משימוש, 403 של שכבה חינמית, CLI חסר, או קומבו `auto/*` שרץ דקות ונופל.
 * הבורר מציג רק מודל שענה לבדיקה קצרה — או לתור אמיתי — לא את כל הרשימה.
 *
 * שני סוגי כשל, כמו במעקב אחרי הספק עצמו: קשיח (המודל איננו, אין כלים, אין
 * הרשאה, חסר בינארי) נשאר בחוץ עד TTL ארוך; רך (429, 503, פסק זמן) "מתקרר"
 * לזמן קצר וחוזר להיבדק, כדי שמכסה שנגמרה לא תמחק מודל מהתפריט עד מחר.
 */
const HEALTH_DEFAULTS = {
  concurrency: 2,
  probeTimeoutMs: 12000,
  healthyTtlMs: 30 * 60 * 1000,
  coolingTtlMs: 3 * 60 * 1000,
  unhealthyTtlMs: 15 * 60 * 1000,
  graceMs: 15 * 1000,
  trustMs: 10 * 60 * 1000,
  tickMs: 30 * 1000,
};

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolveHealthConfig(over) {
  const o = over && typeof over === 'object' ? over : {};
  const envOff = process.env.OMNIROUTE_HEALTH_PROBE === '0' || process.env.OMNIROUTE_HEALTH_PROBE === 'false';
  const enabled = o.enabled != null ? !!o.enabled : !envOff;
  const concurrency = o.concurrency != null ? o.concurrency : envNum('OMNIROUTE_HEALTH_CONCURRENCY', HEALTH_DEFAULTS.concurrency);
  const probeTimeoutMs = o.probeTimeoutMs != null ? o.probeTimeoutMs : envNum('OMNIROUTE_HEALTH_TIMEOUT_MS', HEALTH_DEFAULTS.probeTimeoutMs);
  return {
    enabled,
    concurrency: Math.max(1, Math.min(8, concurrency || 1)),
    probeTimeoutMs: probeTimeoutMs > 0 ? probeTimeoutMs : HEALTH_DEFAULTS.probeTimeoutMs,
    healthyTtlMs: o.healthyTtlMs != null ? o.healthyTtlMs : envNum('OMNIROUTE_HEALTH_TTL_MS', HEALTH_DEFAULTS.healthyTtlMs),
    coolingTtlMs: o.coolingTtlMs != null ? o.coolingTtlMs : envNum('OMNIROUTE_HEALTH_COOLING_MS', HEALTH_DEFAULTS.coolingTtlMs),
    unhealthyTtlMs: o.unhealthyTtlMs != null ? o.unhealthyTtlMs : envNum('OMNIROUTE_HEALTH_UNHEALTHY_MS', HEALTH_DEFAULTS.unhealthyTtlMs),
    graceMs: o.graceMs != null ? o.graceMs : envNum('OMNIROUTE_HEALTH_GRACE_MS', HEALTH_DEFAULTS.graceMs),
    trustMs: o.trustMs != null ? o.trustMs : HEALTH_DEFAULTS.trustMs,
    tickMs: o.tickMs != null ? o.tickMs : HEALTH_DEFAULTS.tickMs,
    now: typeof o.now === 'function' ? o.now : Date.now,
    // auto:false בבדיקות — בלי זה כל fetchModels יוצא לבדיקות ברקע ומערבב שעונים.
    auto: o.auto !== false && enabled,
  };
}

function errorTextFromBody(text) {
  if (text == null || text === '') return '';
  try {
    const j = JSON.parse(text);
    if (!j) return '';
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error === 'object') return j.error.message || JSON.stringify(j.error);
    if (!j.choices && typeof j.message === 'string') return j.message;
    return '';
  } catch { /* גוף שאינו JSON — נשאר כטקסט */ }
  return String(text);
}

/**
 * hard — אין טעם להציע את המודל עד שהספק עצמו משתנה (מודל נמחק, כלים לא
 * נתמכים, מפתח/מדיניות, קובץ בינארי חסר).
 * soft — עומס, מכסה, נפילה זמנית. המודל יוצא מהתפריט לזמן קצר וחוזר להיבדק.
 * דחיית פרמטר של הבדיקה עצמה (`max_tokens`) היא soft: הבדיקה תנוסה שוב בלי
 * השדה, ולא נחביא מודל בגלל צורת הבקשה שלנו.
 */
function classifyProbeFailure(status, message) {
  const text = String(message == null ? '' : message).toLowerCase();
  if (/max_tokens|max_completion_tokens|unsupported parameter|unrecognized request argument/.test(text)) return 'soft';
  if (/no longer available|not found|does not exist|unknown model|model_not_found|deprecated|enoent|cli not found|not found in container|spawn |must be absolute path|devin_agentic|no such file/.test(text)) {
    return 'hard';
  }
  if (/tools? (?:are |is )?not supported|does not support tools?|unsupported tool|tool use is not supported|function calling is not|functions? (?:are )?not supported/.test(text)) {
    return 'hard';
  }
  const code = Number(status) || 0;
  if (code === 404 || code === 410 || code === 401 || code === 402 || code === 403 || code === 501) return 'hard';
  if (code === 400 && /tool|function call|unknown model|invalid model/.test(text)) return 'hard';
  return 'soft';
}

/** קומבואים ותמונות/וידאו נבדקים אחרונים: הם איטיים או לא-שיחה, ולא חוסמים את השאר. */
function modelProbePriority(rawId) {
  const raw = String(rawId || '');
  if (/^auto\//i.test(raw)) return 2;
  if (/^(aihorde|veo-free|veoaifree-web|felo)\//i.test(raw)) return 1;
  return 0;
}

/* ---------- הגדרות ייחודיות לספק המקומי ----------
   Claude ו-Cursor לא חושפים טמפרטורה/תקרת טוקנים/כתובת שרת. הספק המקומי
   כן — ומי שמחליף אליו מצפה שהבוררים האלה יישארו אצלו, לא יימחקו בדרך
   ולא יישלחו ל-OmniRoute. הנרמול כאן הוא החוזה מול ה-UI והקובץ בדיסק. */
const LOCAL_TEMP_MAX = 2;
const LOCAL_MAX_TOKENS_MAX = 128000;
const LOCAL_TIMEOUT_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * כתובת בסיס תואמת-OpenAI, כולל `/v1`. שורש בלי הסיומת מושלם — אחרת
 * `/models` נוחת על 404 אצל LM Studio. מחזיר null לערך ריק או לא-HTTP.
 */
function normalizeLocalUrl(raw) {
  let u = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch { return null; }
  if (!/\/v1$/i.test(u) && !/\/v1\//i.test(u)) u += '/v1';
  return u;
}

/** שדות יצירה שהגשר מזריק לכל `/chat/completions`. ערך חסר = ברירת השרת. */
function normalizeLocalExtras(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (src.temperature != null && src.temperature !== '') {
    const t = Number(src.temperature);
    if (Number.isFinite(t) && t >= 0 && t <= LOCAL_TEMP_MAX) out.temperature = t;
  }
  if (src.maxTokens != null && src.maxTokens !== '') {
    const m = Number(src.maxTokens);
    if (Number.isFinite(m) && m >= 1 && m <= LOCAL_MAX_TOKENS_MAX) out.maxTokens = Math.round(m);
  }
  if (src.timeoutMs != null && src.timeoutMs !== '') {
    const to = Number(src.timeoutMs);
    if (Number.isFinite(to) && to >= 0 && to <= LOCAL_TIMEOUT_MAX_MS) out.timeoutMs = Math.round(to);
  }
  return out;
}

function applyProviderExtras(body, extras) {
  if (!body || !extras) return body;
  if (typeof extras.temperature === 'number') body.temperature = extras.temperature;
  if (typeof extras.maxTokens === 'number' && extras.maxTokens > 0) body.max_tokens = extras.maxTokens;
  return body;
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
function createProvider({ id, label, baseUrl, apiKey, prefix, timeoutMs, envHint, groupOf, health } = {}) {
  let BASE_URL = String(baseUrl).replace(/\/+$/, '');
  let API_KEY = apiKey;
  const PREFIX = prefix;
  let REQUEST_TIMEOUT_MS = timeoutMs || 600000;
  const tag = '[' + id + ']';
  let extras = {};
  let wakeProbe = null;
  const healthCfg = resolveHealthConfig(health);

  let modelIds = new Set();
  let lastModels = null;
  // מזהה מלא (עם תחילית) → { status: healthy|cooling|unhealthy, at, source }
  const healthById = new Map();
  let catalogAt = 0;
  let sweepPromise = null;
  let healthTimer = null;
  let lastHealthyLogged = -1;
  // סיבת הכישלון האחרון של בדיקת הזמינות. ‎fetchModels‎ רק רושם אותה כאן;
  // מי שמחליט אם היא ראויה לשורה ביומן הוא ‎startModelWatcher‎, שלבדו יודע אם
  // זה כישלון ראשון או המאה-וחמישים ברצף.
  let lastFailReason = null;

  const hasModel = (mid) => !!mid && modelIds.has(mid);
  // בלי כינוי: הבדיקה צריכה את המזהה שמופיע ברשימה, לא את היורש שלו.
  const rawModelId = (mid) => {
    const s = String(mid || '');
    return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s;
  };
  const upstreamModel = (mid) => resolveModelAlias(rawModelId(mid));
  const modelKey = (mid) => {
    const s = String(mid || '');
    if (!s) return '';
    return s.startsWith(PREFIX) ? s : PREFIX + s;
  };

  // ---------- HTTP אל הספק ----------

  function requestTimeout() {
    return extras.timeoutMs > 0 ? extras.timeoutMs : REQUEST_TIMEOUT_MS;
  }

  function upstream(pathSuffix, { method = 'GET', body = null, timeout = requestTimeout() } = {}) {
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

  // ---------- בריאות פר-מודל ----------

  function applyHealth(id, kind, source) {
    if (!healthCfg.enabled || !id) return;
    const now = healthCfg.now();
    const prev = healthById.get(id);
    if (kind === 'ok') {
      healthById.set(id, { status: 'healthy', at: now, source });
      return;
    }
    // בדיקה רכה לא דורסת תור אמיתי שהצליח לאחרונה: פינג קצר נכשל לפעמים על
    // מודל שעובד. כשל קשיח כן דורס — המודל נעלם או שאינו יכול להריץ סוכן.
    if (kind === 'soft' && source === 'probe' && prev && prev.status === 'healthy' && prev.source === 'turn' && (now - prev.at) < healthCfg.trustMs) {
      return;
    }
    healthById.set(id, { status: kind === 'hard' ? 'unhealthy' : 'cooling', at: now, source });
  }

  function recordUpstream(model, status, message, source) {
    const id = modelKey(model);
    if (!id) return;
    if (status >= 200 && status < 300) applyHealth(id, 'ok', source);
    else applyHealth(id, classifyProbeFailure(status, message), source);
  }

  function healthDue(id, now) {
    const h = healthById.get(id);
    if (!h || h.status === 'unknown') return true;
    const ttl = h.status === 'healthy' ? healthCfg.healthyTtlMs
      : h.status === 'cooling' ? healthCfg.coolingTtlMs
      : healthCfg.unhealthyTtlMs;
    return (now - h.at) >= ttl;
  }

  /**
   * התפריט: בריאים תמיד. לא-ידועים רק בחלון החסד, ורק כל עוד אין עדיין שום
   * תוצאה — כדי שהבורר לא יישאר ריק בשניות הראשונות, בלי להשאיר מאות מודלים
   * שבורים על המסך אחרי שהבדיקה הראשונה כבר חזרה. מחוץ לחלון, ורגע אחרי
   * תוצאה ראשונה, נשארים רק מי שענו.
   */
  function visibleModels() {
    const list = lastModels || [];
    if (!healthCfg.enabled) return list;
    const now = healthCfg.now();
    const inGrace = catalogAt > 0 && (now - catalogAt) < healthCfg.graceMs;
    let anyResolved = false;
    for (const m of list) {
      const h = healthById.get(m.id);
      if (h && h.status && h.status !== 'unknown') { anyResolved = true; break; }
    }
    const showUnknown = inGrace && !anyResolved;
    return list.filter((m) => {
      const h = healthById.get(m.id);
      if (!h || h.status === 'unknown') return showUnknown;
      return h.status === 'healthy';
    });
  }

  async function postProbe(raw, withMaxTokens) {
    const body = {
      model: raw,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
    };
    if (withMaxTokens) body.max_tokens = 1;
    const res = await upstream('/chat/completions', { method: 'POST', body, timeout: healthCfg.probeTimeoutMs });
    const text = await readBody(res).catch(() => '');
    if (res.statusCode >= 200 && res.statusCode < 300) {
      // רק שדה error ב-JSON נחשב כשל. גוף ריק או לא-JSON אחרי 200 הוא הצלחה:
      // המודל ענה, וזה מה שהבדיקה באה לבדוק.
      let err = '';
      if (text) {
        try {
          const j = JSON.parse(text);
          if (j && j.error) err = errorTextFromBody(text);
        } catch { err = ''; }
      }
      if (err) return { kind: classifyProbeFailure(res.statusCode, err), message: err };
      return { kind: 'ok', message: '' };
    }
    const message = errorTextFromBody(text) || text;
    const kind = classifyProbeFailure(res.statusCode, message);
    const retryBare = withMaxTokens && kind === 'soft' && /max_tokens|max_completion_tokens|unsupported parameter/i.test(String(message));
    return { kind, message, retryBare };
  }

  async function probeOne(model) {
    const raw = rawModelId(model.id);
    try {
      let outcome = await postProbe(raw, true);
      if (outcome.retryBare) outcome = await postProbe(raw, false);
      applyHealth(model.id, outcome.kind, 'probe');
    } catch {
      applyHealth(model.id, 'soft', 'probe');
    }
  }

  function logHealthSummary() {
    let healthy = 0;
    for (const m of lastModels || []) {
      const h = healthById.get(m.id);
      if (h && h.status === 'healthy') healthy += 1;
    }
    if (healthy === lastHealthyLogged) return;
    lastHealthyLogged = healthy;
    const total = (lastModels || []).length;
    console.log(`  \x1b[90m${label}: ${healthy} מודלים תקינים מתוך ${total}\x1b[0m`);
  }

  async function sweepHealth() {
    if (!healthCfg.enabled) return;
    const list = lastModels;
    if (!list || !list.length) return;
    const now = healthCfg.now();
    const todo = list.filter((m) => healthDue(m.id, now));
    if (!todo.length) return;
    todo.sort((a, b) => modelProbePriority(rawModelId(a.id)) - modelProbePriority(rawModelId(b.id)));
    let cursor = 0;
    const workers = Math.min(healthCfg.concurrency, todo.length);
    await Promise.all(Array.from({ length: workers }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= todo.length) return;
        await probeOne(todo[i]);
      }
    }));
    logHealthSummary();
  }

  function probeHealth() {
    if (!healthCfg.enabled) return Promise.resolve();
    if (sweepPromise) return sweepPromise;
    sweepPromise = sweepHealth().finally(() => { sweepPromise = null; });
    return sweepPromise;
  }

  function ensureHealthTimer() {
    if (healthTimer || !healthCfg.enabled || !healthCfg.auto) return;
    const tick = healthCfg.tickMs > 0 ? healthCfg.tickMs : HEALTH_DEFAULTS.tickMs;
    healthTimer = setInterval(() => { probeHealth().catch(() => {}); }, tick);
    healthTimer.unref?.();
  }

  function kickHealth() {
    if (!healthCfg.auto) return;
    ensureHealthTimer();
    probeHealth().catch(() => {});
  }

  /**
   * שליפת המודלים הזמינים מ-GET /v1/models, לתפריט הבחירה.
   * מחזיר מערך בהצלחה ו-null בכישלון. הרשימה האחרונה שהצליחה נשמרת ב-lastModels
   * לניתוב, ו-getModels() מגיש ממנה רק מודלים בריאים. כשל רשת לא מוחק את
   * הרשימה באמצע עבודה — וגם modelIds לא מתאפס, כדי ששיחה שרצה עכשיו על מודל
   * של הספק לא תנותב פתאום לחיבור הישיר מול Anthropic.
   */
  async function fetchModels() {
    try {
      const res = await upstream('/models', { timeout: MODELS_TIMEOUT_MS });
      const text = await readBody(res);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        lastFailReason = '/v1/models החזיר HTTP ' + res.statusCode;
        return null;
      }
      const j = JSON.parse(text);
      const data = Array.isArray(j) ? j : (Array.isArray(j && j.data) ? j.data : null);
      if (!data) { lastFailReason = '/v1/models לא החזיר data'; return null; }
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
      if (!models.length) { lastFailReason = '/v1/models לא החזיר אף מודל שמיש'; return null; }
      // הספק מחזיר את המודלים בסדר משלו, ובו מודלים מאותה קבוצה מפוזרים.
      // מיון יציב לפי סדר ההופעה הראשון של כל קבוצה שומר על סדר הספק בתוך
      // הקבוצה, ובכל זאת מגיש את הרשימה כשהקבוצות שלמות.
      const order = [];
      for (const m of models) if (!order.includes(m.group)) order.push(m.group);
      models.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
      modelIds = new Set(models.map((m) => m.id));
      lastModels = models;
      for (const id of healthById.keys()) if (!modelIds.has(id)) healthById.delete(id);
      catalogAt = healthCfg.now();
      lastFailReason = null;
      // הבדיקות יוצאות אחרי שהרשימה כבר נשמרה, ולא נמצאות על נתיב ההחזרה —
      // עליית השרת והמעקב לא ממתינים להן.
      kickHealth();
      return models;
    } catch (e) {
      lastFailReason = '/v1/models נכשל: ' + errText(e);
      return null;
    }
  }

  /**
   * מה שהבורר רואה. סינכרוני, בלי רשת: הרשימה המלאה נשמרת ב-lastModels לניתוב
   * (`hasModel`), והתפריט מקבל רק את מי שנחשב בריא. כיבוי הבדיקות
   * (`OMNIROUTE_HEALTH_PROBE=0`) מחזיר את הרשימה כולה, כמו קודם.
   */
  const getModels = () => visibleModels();

  /**
   * מעקב רקע אחרי זמינות הספק.
   *
   * הבדיקה הראשונה יוצאת מיד עם timeout קצר (MODELS_TIMEOUT_MS), ולא חוסמת את
   * עליית השרת: אם הספק עדיין עולה — הממשק עולה בלעדיו והמעקב ממשיך לנסות
   * ברקע עם השהיה גדלה, עד 30 שנ׳. ברגע שהוא זמין המודלים נכנסים לתפריט מעצמם,
   * בלי להפעיל מחדש. אחרי הצלחה עוברים לרענון איטי, שגם קולט מודלים שנטענו
   * בצד הספק אחרי שהשרת כבר רץ.
   *
   * ההשהיה בין בדיקות נקבעת ב-nextProbeDelay — שם גם ההסבר למה יש שתי תקרות.
   * ביומן נרשמים מעברי מצב בלבד: הכישלון הראשון, ההכרזה על היעדרות, וההתאוששות.
   * ניסיון שנכשל שוב מאותה סיבה אינו חדשות, ואין לו מה לעשות ביומן.
   */
  function startModelWatcher(onChange) {
    let delay = PROBE.RETRY_MIN;
    let timer = null;
    let stopped = false;
    let announced = false;
    let fails = 0;

    const handleResult = (models) => {
      if (models) {
        if (fails >= PROBE.ABSENT_AFTER) console.log(`  \x1b[90m${label}: חזר\x1b[0m`);
        fails = 0;
        if (!announced) {
          const note = healthCfg.enabled ? ' (בתפריט רק מי שיענה לבדיקה)' : '';
          console.log(`  \x1b[90m${label}: ${models.length} מודלים ברשימה${note}\x1b[0m`);
          announced = true;
        }
        delay = PROBE.STEADY;
        try { onChange(models); } catch { /* המאזין לא אמור להפיל את המעקב */ }
      } else {
        fails += 1;
        announced = false;
        const why = lastFailReason || 'לא זמין';
        if (fails === 1) console.warn(tag + ' ' + why);
        else if (fails === PROBE.ABSENT_AFTER) console.warn(tag + ' ' + why + ' — נעדר, ממשיכים לבדוק בריווח של עד רבע שעה');
        delay = nextProbeDelay(delay, fails);
      }
    };

    const tick = async () => {
      if (stopped) return;
      handleResult(await fetchModels());
      timer = setTimeout(tick, delay);
      timer.unref?.();
    };

    wakeProbe = async () => {
      if (stopped) return lastModels;
      if (timer) { clearTimeout(timer); timer = null; }
      delay = PROBE.RETRY_MIN;
      const models = await fetchModels();
      handleResult(models);
      timer = setTimeout(tick, delay);
      timer.unref?.();
      return models;
    };

    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    };
  }

  function getExtras() { return { ...extras }; }
  function setExtras(next) {
    extras = normalizeLocalExtras({ ...extras, ...next });
  }
  function getStatus() {
    return {
      id, label, prefix: PREFIX, baseUrl: BASE_URL,
      online: !!(lastModels && lastModels.length),
      models: lastModels ? lastModels.length : 0,
      healthy: (lastModels || []).filter((m) => {
        if (!healthCfg.enabled) return true;
        const h = healthById.get(m.id);
        return !!(h && h.status === 'healthy');
      }).length,
      lastFail: lastFailReason,
      extras: getExtras(),
    };
  }
  function reconfigure({ baseUrl, apiKey, timeoutMs } = {}) {
    const url = baseUrl != null ? normalizeLocalUrl(baseUrl) : null;
    if (url) BASE_URL = url;
    if (apiKey != null && String(apiKey).trim()) API_KEY = String(apiKey).trim();
    if (timeoutMs !== undefined) {
      const n = Number(timeoutMs);
      REQUEST_TIMEOUT_MS = (Number.isFinite(n) && n > 0) ? Math.round(n) : 600000;
    }
  }
  const probeNow = () => (wakeProbe ? wakeProbe() : fetchModels());

  // ---------- הטיפול בבקשות שמגיעות מה-CLI ----------

  const unavailable = (e) => label + ' לא זמין (' + BASE_URL + '): ' + errText(e) +
    (envHint ? ' — בדוק את ' + envHint : '');

  async function handleMessages(req, res) {
    let anth;
    try { anth = JSON.parse(await collect(req)); }
    catch (e) { return sendError(res, 400, 'גוף בקשה לא תקין: ' + e.message); }

    const model = String(anth.model || '');
    const body = applyProviderExtras(translateRequest(anth, upstreamModel), extras);
    // ה-CLI מציג ניצול הקשר כבר בתחילת התור, אבל השימוש מדווח רק בסוף.
    const estIn = estimateTokens(body.messages);

    let up;
    try { up = await upstream('/chat/completions', { method: 'POST', body }); }
    catch (e) {
      recordUpstream(model, 502, errText(e), 'turn');
      return sendError(res, 502, unavailable(e));
    }

    // `stream_options` אינו מוכר לכל שרת תואם-OpenAI, ודחייה שלו מפילה תור שלם
    // רק בשביל מספרי שימוש. במקרה כזה מנסים שוב בלעדיו ונופלים לאומדן.
    // ה-400 הזה הוא על צורת הבקשה שלנו, לא על המודל — לא נרשם ככשל בריאות.
    if (up.statusCode === 400 && body.stream_options) {
      await readBody(up).catch(() => '');
      delete body.stream_options;
      try { up = await upstream('/chat/completions', { method: 'POST', body }); }
      catch (e) {
        recordUpstream(model, 502, errText(e), 'turn');
        return sendError(res, 502, unavailable(e));
      }
    }

    if (up.statusCode < 200 || up.statusCode >= 300) {
      const text = await readBody(up).catch(() => '');
      let message = text;
      try { const j = JSON.parse(text); message = (j.error && (j.error.message || j.error)) || j.message || text; } catch {}
      const messageText = typeof message === 'string' ? message : JSON.stringify(message);
      recordUpstream(model, up.statusCode, messageText, 'turn');
      return sendError(res, up.statusCode, label + ': ' + messageText);
    }
    recordUpstream(model, 200, '', 'turn');

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
        return sendJson(res, { data: getModels().map((m) => ({ id: upstreamModel(m.id), type: 'model', display_name: m.name })) });
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
    PREFIX,
    hasModel, upstreamModel,
    fetchModels, getModels, startModelWatcher, startBridge,
    getStatus, getExtras, setExtras, reconfigure, probeNow, probeHealth,
  };
}

/**
 * הספקים תואמי-OpenAI שהשרת מרים, לפי הסביבה.
 *
 * ספק שכתובת הבסיס שלו רוקנה (`LOCAL_BASE_URL=`) פשוט לא נבנה — כך אפשר לכבות
 * אחד מהם בלי לגעת בקוד. ספק שכתובתו מוגדרת אבל אינו רץ אינו מפריע לכלום:
 * המעקב פשוט לא ימצא מודלים והתפריט יישאר בלעדיו.
 */
function loadProviders(overrides = {}) {
  // הסדר כאן הוא גם סדר הקבוצות בבורר המודלים: השרת המקומי לפני OmniRoute,
  // כי הוא מגיש מעט מודלים וחבל שיישבו מתחת למאה רשומות.
  const localOver = (overrides && overrides.local) || {};
  const envLocal = process.env.LOCAL_BASE_URL;
  const savedLocal = localOver.baseUrl != null ? String(localOver.baseUrl).trim() : '';
  const savedNorm = savedLocal ? (normalizeLocalUrl(savedLocal) || savedLocal) : '';
  const localUrl = savedNorm || (envLocal !== undefined ? envLocal : 'http://192.168.1.253:1234/v1');

  const geminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const geminiUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').trim();

  const defs = [
    {
      // שרת מודלים מקומי ברשת המקומית (LM Studio / Ollama / vLLM וכל תואם-OpenAI).
      id: 'local',
      label: 'מקומי',
      baseUrl: localUrl,
      apiKey: (localOver.apiKey && String(localOver.apiKey).trim()) || process.env.LOCAL_API_KEY || 'local',
      prefix: 'local/',
      groupOf: () => 'מודלים מקומיים',
      timeoutMs: Number(localOver.timeoutMs != null ? localOver.timeoutMs : process.env.LOCAL_TIMEOUT_MS) || 0,
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

  if (geminiKey) {
    defs.push({
      // חיבור ישיר ל-Google Gemini דרך נקודת הקצה התואמת OpenAI של Google AI Studio.
      id: 'gemini',
      label: 'Google Gemini',
      baseUrl: geminiUrl,
      apiKey: geminiKey,
      prefix: 'gemini/',
      groupOf: () => 'Gemini · Google',
      timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS) || 0,
      envHint: 'GEMINI_API_KEY',
    });
  }

  return defs.filter((d) => d.baseUrl && d.baseUrl.trim()).map(createProvider);
}

module.exports = {
  createProvider,
  loadProviders,
  normalizeLocalUrl,
  normalizeLocalExtras,
  applyProviderExtras,
  resolveModelAlias,
  DEPRECATED_GEMINI_ALIASES,
  // מיוצא לבדיקות ידניות של התרגום בלי להרים תהליך CLI
  _internal: {
    translateRequest, translateResponse, createStreamTranslator, parseSse,
    PROBE, nextProbeDelay, applyProviderExtras, normalizeLocalUrl, normalizeLocalExtras,
    resolveModelAlias, DEPRECATED_GEMINI_ALIASES,
    classifyProbeFailure, resolveHealthConfig, modelProbePriority,
  },
};
