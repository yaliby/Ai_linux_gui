'use strict';

/* ==========================================================================
   מצב דואט — שני מודלים שמעבירים ביניהם תוצר אחד, ומפקח שקורא מעל הכתף
   --------------------------------------------------------------------------
   זו לא שיחה בין שני מודלים ולא ויכוח ביניהם. יש טקסט אחד, והוא עובר מיד ליד:
   אחד כותב גרסה, השני קורא אותה, משפר ומחזיר. המפקח לא כותב ולא מדבר אל
   המשתמש — הוא רק מחליט אם הכיוון עוד משרת את המטרה, אם התור האחרון באמת שיפר
   משהו, ומתי העבודה נגמרה.

   הרַכָּז (הקוד כאן) לא מריץ CLI בעצמו: הוא מקבל מ-server.js את אותם פרימיטיבים
   שמריצים שיחה רגילה (newSession/startChild/writeStdin/emit) ומשתמש בהם כדי
   להחזיק שלושה סשנים נפרדים — A, B ו-S — שכל אחד מהם זוכר את ההיגיון של עצמו
   דרך ‎--resume‎. מה שלא נשען על הזיכרון הזה הוא התוצר: הוא נשלח *במלואו* בכל
   תור, כי הוא מקור האמת, ולא ההיסטוריה של השיחה.

   הריצה חיה בשרת ולא בדפדפן. רענון דף, נעילת טלפון או מעבר לשיחה אחרת לא
   עוצרים אותה, והחזרה אליה מציגה בדיוק את מה שקרה בינתיים.
   ========================================================================== */

const ROLES = ['A', 'B', 'S'];
const MAX_ARTIFACT = 200 * 1024;        // תקרת גודל התוצר
const CEILING_WARN = 0.9;               // ממנה והלאה מזהירים מראש, לפני שנחסמים
const MAX_TURNS = 30;
const MIN_TURNS = 2;
const NOTE_KEEP = 3;                    // כמה הערות מפקח נשמרות לתצוגה
const TURN_TIMEOUT_MS = 12 * 60 * 1000; // תור שלא החזיר כלום — נחשב כישלון קריאה
const MAX_FULL_TEXT = 60 * 1024;        // התשובה הגולמית שנשמרת לכרטיס "תשובה מלאה"
const MAX_GOAL = 8000;

const OPEN = '<<<ARTIFACT';
const CLOSE = 'ARTIFACT>>>';

/* ---------- תבניות ההנחיה ---------- */

const participantSystem = (goal) => `You and one other AI model are collaborating on a single shared work product.
You are not debating and you are not talking about the work — you are doing the
work, in turns, on the same text. Your partner just handed you the current
version. Your job is to hand back a better one.

THE GOAL:
${goal}

Every turn you must do two things:

ADOPT — keep what your partner got right. Do not rewrite their work to match
your own style. Style churn is not improvement.

REFINE — make a real, substantive improvement: fix what is wrong, sharpen
what is vague, fill what is missing, cut what is redundant.

Rules:

- Never revert a change from an earlier version unless you state, in the
  changelog, why it was wrong.
- Do not praise your partner, do not address them, do not narrate your process.
  No "great start" and no "as you correctly noted". Just improve the artifact.
- If you genuinely believe the artifact is finished, say so in the changelog
  with the single bullet "NO FURTHER CHANGES NEEDED: <reason>" and return the
  artifact unchanged. Do not invent changes to look useful.
- Prefer one deep improvement over five cosmetic ones.

Output format (mandatory, exactly this shape):

CHANGELOG:
- <change 1>
- <change 2>

${OPEN}
<the complete revised artifact>
${CLOSE}`;

const supervisorSystem = (goal) => `You are supervising two AI models who are collaborating on a single shared
artifact, taking turns refining it. You never write the artifact yourself and
you never speak to the user. You watch two things:

DIRECTION — is the work still serving the goal, or has it drifted into
something adjacent and interesting but off-target?

PROGRESS — did this turn actually improve the artifact, or was it
restatement, style churn, padding, or two models agreeing with each other?

Your intervention is a nudge, never a takeover. You do not rewrite, you do not
dictate wording, you do not add requirements the user did not ask for. One or
two sentences that point at what to attend to next. Steer only when it is
needed — silence is the correct output most of the time. Over-steering destroys
the productive friction between the two models.

Declare completion when the goal is met, OR when the last two turns produced no
meaningful gain. A collaboration that has stopped improving is finished, even
if it is not perfect. Someone has to call it, and that is you.

THE GOAL:
${goal}

Respond with JSON only, no prose outside it:
{
  "status": "ok" | "steer" | "complete" | "stalled",
  "note": "<one or two sentences; required for 'steer', empty otherwise>",
  "reason": "<short internal justification, always required>",
  "progress": <integer 0-100, your estimate of how close the artifact is to the goal>
}`;

const FORMAT_REMINDER = `

---
FORMAT REMINDER — your previous response could not be parsed. Respond again,
with nothing before or after this exact shape:

CHANGELOG:
- <change 1>

${OPEN}
<the complete artifact, in full>
${CLOSE}`;

const JSON_REMINDER = `

---
FORMAT REMINDER — your previous response was not valid JSON. Respond with the
JSON object alone: no prose, no code fence, no commentary.`;

/* ---------- הודעת התור ---------- */

function participantMessage(run, note) {
  const v = run.version;
  const last = run.history[run.history.length - 1];
  const lines = [`GOAL: ${run.goal}`, `VERSION: ${v} (you are producing version ${v + 1})`, ''];

  // הערת המפקח נכנסת לתור *הבא* בלבד ולא מצטברת. הערת משתמש מסומנת ככזו, כדי
  // שהמודל יידע שזו דרישה של מי שהזמין את העבודה ולא נגיעה של המפקח.
  for (const n of (note.user || [])) {
    lines.push('USER NOTE (read this first, it takes priority):', n.text, '');
  }
  if (note.supervisor) {
    lines.push('SUPERVISOR NOTE (read this first, it takes priority):', note.supervisor, '');
  }
  if (last && last.changelog && last.changelog.length) {
    lines.push("YOUR PARTNER'S LAST CHANGES:", last.changelog.map((c) => '- ' + c).join('\n'), '');
  }
  // תקרת הגודל מוזכרת רק כשהיא כבר קרובה — אחרת היא רק מזמינה קיצוץ מיותר
  if (run.artifact.length >= MAX_ARTIFACT * CEILING_WARN) {
    lines.push(
      `SIZE CEILING: the artifact is at ${Math.round((run.artifact.length / MAX_ARTIFACT) * 100)}% of its hard size limit ` +
      `(${Math.floor(MAX_ARTIFACT / 1024)} KB). It must not grow. Improve by replacing and cutting, not by adding.`, '');
  }

  if (!run.artifact) {
    lines.push('There is no artifact yet. Write the first version from the goal above.');
  } else {
    lines.push('CURRENT ARTIFACT:', OPEN, run.artifact, CLOSE);
  }
  lines.push('', 'Now produce the next version.');
  return lines.join('\n');
}

function supervisorMessage(run) {
  const h = run.history;
  const last = h[h.length - 1] || {};
  const prev = h[h.length - 2];
  const bullets = (c) => (c && c.length ? c.map((x) => '- ' + x).join('\n') : '(none)');
  const lines = [
    `VERSION ${last.version} was just produced by ${last.speaker}.`, '',
    'THEIR CHANGELOG:', bullets(last.changelog), '',
    "PREVIOUS VERSION'S CHANGELOG:", bullets(prev && prev.changelog), '',
  ];
  if (run.ceilingHit) {
    lines.push('NOTE: the artifact has reached its hard size ceiling and cannot grow further.', '');
  }
  lines.push('CURRENT ARTIFACT:', OPEN, run.artifact, CLOSE, '',
    'Assess direction and progress. Respond with the JSON object only.');
  return lines.join('\n');
}

/* ---------- פענוח התשובות ---------- */

/**
 * מחלץ CHANGELOG ותוצר מתשובת משתתף.
 * הסוגר האחרון ולא הראשון: תוצר שמסביר את הפרוטוקול הזה בעצמו מכיל את
 * המחרוזת ‎ARTIFACT>>>‎ בתוכו, ולקיחת הראשון הייתה חותכת אותו באמצע.
 */
function parseArtifact(text) {
  const s = String(text || '');
  const open = s.indexOf(OPEN);
  if (open < 0) return { ok: false, why: 'missing-open' };
  const close = s.lastIndexOf(CLOSE);
  if (close < 0 || close <= open) return { ok: false, why: 'missing-close' };

  let artifact = s.slice(open + OPEN.length, close);
  // שורת מעבר אחת אחרי הפותח ולפני הסוגר היא חלק מהתחביר, לא מהטקסט
  artifact = artifact.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  if (!artifact.trim()) return { ok: false, why: 'empty' };

  const head = s.slice(0, open);
  const at = head.search(/CHANGELOG\s*:/i);
  const body = at >= 0 ? head.slice(head.indexOf(':', at) + 1) : head;
  const changelog = body
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•‣]|\d+[.)])\s*/, '').trim())
    .filter((l) => l && !/^```/.test(l))
    .slice(0, 5);

  // "אין מה לשנות" הוא הצהרת סיום של משתתף, ולא עוד שורת יומן. שני תורות
  // כאלה ברצף הם עצירה עובדתית, ולכן שווה לזהות אותה כאן ולא בעין.
  const done = /NO FURTHER CHANGES NEEDED/i.test(head);
  return { ok: true, artifact, changelog: changelog.length ? changelog : ['(ללא יומן שינויים)'], done };
}

/** מחלץ את פסק הדין של המפקח. סובלני לגדר קוד ולפטפוט מסביב, ותו לא. */
function parseVerdict(text) {
  const s = String(text || '').trim();
  const tries = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));

  for (const t of tries) {
    let j; try { j = JSON.parse(t); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const status = String(j.status || '').toLowerCase();
    if (!['ok', 'steer', 'complete', 'stalled'].includes(status)) continue;
    let progress = Math.round(Number(j.progress));
    if (!isFinite(progress)) progress = null; else progress = Math.max(0, Math.min(100, progress));
    return {
      ok: true,
      status,
      note: String(j.note || '').slice(0, 1200),
      reason: String(j.reason || '').slice(0, 1200),
      progress,
    };
  }
  return { ok: false };
}

const trimTail = (s, max) => {
  const t = String(s == null ? '' : s);
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.7);
  return t.slice(0, head) + `\n\n… [נחתכו ${t.length - max} תווים] …\n\n` + t.slice(-(max - head));
};

/* ==========================================================================
   הרַכָּז
   ========================================================================== */

module.exports = function createDuet(D) {
  /** convId → ריצה. חיה בשרת, ולכן שורדת רענון דף וניתוק של הדפדפן. */
  const runs = new Map();

  const roleModel = (run, role) => (run.cfg[role] && run.cfg[role].model) || '';
  const has = (id) => runs.has(id);

  /* ---------- הסשן של כל משתתף ---------- */

  // מזהה עם ‎~‎ במכוון: ‎VALID_ID‎ פוסל אותו, ולכן אי-אפשר להירשם לסשן של משתתף
  // מבחוץ ואי-אפשר לכתוב אותו כשיחה. הפריימים שלו מגיעים למסך רק דרך הרַכָּז.
  const actorId = (convId, role) => convId + '~' + role;

  function actorSession(run, role) {
    const id = actorId(run.convId, role);
    let s = D.sessions.get(id);
    if (!s) {
      s = D.newSession(id);
      s.duetRole = role;                       // reapIdle מדלג על אלה
      s.relay = (frame) => onActorFrame(run, role, frame);
    }
    return s;
  }

  function killActors(run) {
    for (const role of ROLES) {
      const s = D.sessions.get(actorId(run.convId, role));
      if (s) { D.killChild(s); D.sessions.delete(actorId(run.convId, role)); }
    }
  }

  /* ---------- שידור למסך ---------- */

  function push(run, frame) {
    const main = D.sessions.get(run.convId);
    if (!main) return;
    // תור חדש מאפס את יומן ההשלמה, בדיוק כמו בשיחה רגילה: תור אחד מייצר אלפי
    // פריימי דלתא, ובלי האיפוס מכשיר שמתחבר מחדש היה מקבל את כולם מחמישה
    // תורות אחורה. כאן זה בטוח תמיד — השרת עצמו כותב את הריצה לדיסק, ולכן מה
    // שנמחק מהיומן כבר קיים בקובץ.
    if (frame.ev === 'turn_start') main.log.length = 0;
    // ‎kind‎ אחרון ולא ראשון: מעטפת הפריים חייבת לנצח כל שדה שנשא אותו שם
    // בפנים. כשהיא הייתה ראשונה, פריים הסיום (שנשא ‎kind‎ משלו) דרס אותה,
    // הלקוח לא זיהה אותו כפריים דואט — והריצה נראתה כאילו נעצרה בלי סיום.
    D.emit(main, { ...frame, kind: 'duet' });
  }

  /* ---------- קריאה אחת למודל ---------- */

  /**
   * מריץ תור אחד אצל שחקן אחד ומחזיר את הטקסט המלא שלו.
   * הזרימה למסך קורית תוך כדי (delta), אבל הטקסט שמוחזר נאסף דווקא מאירועי
   * ‎assistant‎ המלאים ולא מהדלתות — הן נועדו לעין, והן זה שעלול לחסר פיסה
   * כשהתהליך נופל באמצע.
   */
  function callModel(run, role, message) {
    return new Promise((resolve, reject) => {
      const s = actorSession(run, role);
      const cfg = run.cfg[role];

      // מודל או מאמץ שהשתנו מאז ההרצה הקודמת מחייבים תהליך חדש; ‎--resume‎ על
      // אותו ‎session_id‎ שומר על ההקשר, כך שהחלפה כזו לא מוחקת את הזיכרון.
      if (s.child && (s.liveModel !== (cfg.model || '') || s.liveEffort !== (cfg.effort || ''))) D.killChild(s);
      if (!s.child) {
        const ok = D.startChild(s, {
          cwd: run.cfg.cwd,
          model: cfg.model || '',
          effort: cfg.effort || '',
          permissionMode: 'plan',
          resume: s.cliSessionId || cfg.sessionId || null,
          // ההנחיה נקבעת בהפעלה ולכן חוזרת גם אחרי ‎--resume‎: התוצר נשלח מחדש
          // בכל תור, אבל *הכללים* חייבים להיות שם גם אם ההקשר נגזם.
          systemPrompt: role === 'S' ? supervisorSystem(run.goal) : participantSystem(run.goal),
          // בגרסה הזו התוצר הוא טקסט במצב הריצה, לא קבצים על הדיסק
          noTools: true,
        });
        if (!ok) return reject(new Error('הפעלת התהליך נכשלה'));
      }

      const w = {
        role, text: '', settled: false,
        done(evt) {
          if (w.settled) return; w.settled = true;
          clearTimeout(w.timer); run.wait = null;
          const failed = evt && (evt.is_error || (evt.subtype && evt.subtype !== 'success'));
          // תשובה חלקית עדיפה על כישלון: אם יצא טקסט, מנסים לפענח אותו. רק
          // כישלון *בלי* פלט הוא באמת תור שלא קרה.
          if (failed && !w.text.trim()) {
            const why = [evt && evt.result, evt && evt.error].filter((x) => typeof x === 'string')[0];
            return reject(new Error(why || 'התור נכשל ללא פלט'));
          }
          resolve(w.text);
        },
        fail(why) {
          if (w.settled) return; w.settled = true;
          clearTimeout(w.timer); run.wait = null;
          reject(new Error(why || 'שגיאת תהליך'));
        },
      };
      w.timer = setTimeout(() => w.fail('התור לא החזיר תשובה בזמן'), TURN_TIMEOUT_MS);
      run.wait = w;

      s.turnProduced = false;
      s.limitHint = '';
      if (!D.writeStdin(s, { type: 'user', message: { role: 'user', content: message } })) {
        w.fail('כתיבה לתהליך נכשלה');
        return;
      }
      D.setRunning(s, true);
    });
  }

  /** קריאה עם ניסיון שני אחד — כישלון של קריאה לא מפיל ריצה שלמה בבת אחת. */
  async function callWithRetry(run, role, message) {
    try {
      return await callModel(run, role, message);
    } catch (e) {
      if (run.gen !== run.myGen) throw e;
      push(run, { ev: 'retry', role, text: String(e.message || e) });
      // התהליך שנפל לא ינסה שוב מעצמו; הפעלה נקייה עם ‎--resume‎ תחזיר את ההקשר
      const s = D.sessions.get(actorId(run.convId, role));
      if (s) D.killChild(s);
      return await callModel(run, role, message);
    }
  }

  /* ---------- פריימים מהתהליך של שחקן ---------- */

  function onActorFrame(run, role, frame) {
    const w = run.wait && run.wait.role === role ? run.wait : null;

    if (frame.kind === 'event') {
      const evt = frame.evt || {};
      if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
        // נשמר כדי שהריצה תוכל להתחדש אחרי הפעלה מחדש של השרת
        run.cfg[role].sessionId = evt.session_id;
      }
      if (evt.type === 'stream_event') {
        const ev = evt.event || {};
        // דלתות של טקסט בלבד. החשיבה לא מוצגת בדואט — מה שנמדד כאן הוא התוצר,
        // לא הדרך אליו — ושידור שלה היה מציף את יומן ההשלמה במאות פריימים לתור
        // ודוחק ממנו בדיוק את מה שמכשיר שמתחבר מחדש צריך לראות.
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
          push(run, { ev: 'delta', role, text: ev.delta.text });
        }
        return;
      }
      if (evt.type === 'assistant' && evt.message) {
        if (w) for (const b of (evt.message.content || [])) if (b && b.type === 'text' && b.text) w.text += b.text;
        return;
      }
      if (evt.type === 'result') {
        addCost(run, role, evt);
        if (w) w.done(evt);
        return;
      }
      return;
    }
    // מיצוי מכסה בתוך דואט לא נכנס למנגנון ההמתנה של שיחה רגילה (ראו onLimitHit)
    if (frame.kind === 'limit_stop') { if (w) w.fail('מכסה נגמרה: ' + (frame.text || '')); return; }
    if (frame.kind === 'error') { if (w) w.fail(frame.text); return; }
    if (frame.kind === 'exit') { if (w) w.fail('התהליך נסגר (קוד ' + frame.code + ')'); return; }
  }

  function addCost(run, role, evt) {
    const c = Number(evt && evt.total_cost_usd) || 0;
    const u = (evt && evt.usage) || {};
    const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const outTok = u.output_tokens || 0;
    const r = run.cost.byRole[role] || (run.cost.byRole[role] = { usd: 0, in: 0, out: 0, calls: 0 });
    r.usd += c; r.in += inTok; r.out += outTok; r.calls += 1;
    run.cost.usd += c; run.cost.in += inTok; run.cost.out += outTok;
    push(run, { ev: 'cost', cost: run.cost });
  }

  /* ==========================================================================
     הלולאה
     ========================================================================== */

  /** נקודת העצירה היחידה. נבדקת *לפני* כל קריאה למודל, כדי ש"עצור" יעצור באמת. */
  function halted(run) {
    if (run.gen !== run.myGen) return true;           // ריצה אחרת כבר תפסה את המקום
    if (run.stopReq) { finish(run, 'stopped', 'הופסק על-ידך'); return true; }
    if (run.pauseReq) { run.pauseReq = false; setStatus(run, 'paused', ''); return true; }
    return false;
  }

  async function loop(run) {
    const myGen = run.gen;
    run.myGen = myGen;
    try {
      while (true) {
        if (halted(run)) return;

        // תור אחד מורכב משני שלבים: משתתף ואז מפקח. השהיה שנפלה *ביניהם*
        // חייבת להתחדש מהמפקח ולא מהמשתתף — אחרת "המשך" היה מריץ את אותו תור
        // פעם שנייה, מייצר גרסה כפולה מאותו דובר ומדלג על הפיקוח שדילגנו עליו.
        if (run.phase === 'supervisor') { if (await supervise(run, myGen)) return; continue; }

        const role = run.turn % 2 === 0 ? 'A' : 'B';
        const note = { supervisor: run.pendingNote, user: run.pendingUserNotes };
        run.pendingNote = null;
        run.pendingUserNotes = [];

        push(run, { ev: 'turn_start', role, model: roleModel(run, role), version: run.version + 1, turn: run.turn });

        let parsed;
        try {
          parsed = await participantTurn(run, role, participantMessage(run, note));
        } catch (e) {
          // ההערות שנצרכו לתור שנכשל חוזרות למקומן: "נסה שוב" מריץ את אותו תור
          // מחדש, ולא היה שום היגיון שהנחיה שהמשתמש כתב תיבלע יחד עם הכישלון.
          run.pendingNote = note.supervisor;
          run.pendingUserNotes = note.user;
          // תור שנקטע כי לחצת "עצור" הוא לא תקלה. הדור כבר התקדם, והמצב
          // הסופי כבר נקבע — כאן רק יוצאים בשקט במקום לצייר שגיאה מעליו.
          if (run.gen !== myGen) return;
          return fault(run, role, e);
        }
        if (run.gen !== myGen) return;

        run.artifact = parsed.artifact;
        run.version += 1;
        const entry = {
          speaker: role, model: roleModel(run, role), version: run.version,
          changelog: parsed.changelog, done: !!parsed.done,
          full: trimTail(parsed.raw, MAX_FULL_TEXT), ts: Date.now(),
          notes: [...(note.user || []).map((n) => ({ from: 'user', text: n.text })),
                  ...(note.supervisor ? [{ from: 'supervisor', text: note.supervisor }] : [])],
        };
        run.history.push(entry);
        run.versions.push({ v: run.version, author: role, model: entry.model, changelog: parsed.changelog, text: parsed.artifact, ts: entry.ts });
        run.phase = 'supervisor';
        push(run, { ev: 'turn_end', turn: entry, artifact: run.artifact });
        persist(run);

        if (await supervise(run, myGen)) return;
      }
    } catch (e) {
      if (run.gen !== run.myGen || run.myGen !== myGen) return;
      fault(run, null, e);
    }
  }

  /**
   * שלב הפיקוח וההחלטה שאחריו. מוצא מהלולאה (true) כשהריצה נגמרה או הושהתה.
   * נפרד מגוף התור בדיוק כדי שאפשר יהיה להיכנס אליו ישירות בחידוש.
   */
  async function supervise(run, myGen) {
    if (halted(run)) return true;

    const verdict = await supervisorTurn(run);
    if (run.gen !== myGen) return true;
    run.supervisorNotes.push(verdict);
    if (typeof verdict.progress === 'number') run.progress = verdict.progress;
    push(run, { ev: 'supervisor', note: verdict, progress: run.progress });

    // מכאן והלאה התור הזה סגור: השלב הבא הוא משתתף, גם אם נעצור כאן.
    run.phase = 'participant';
    persist(run);

    if (verdict.status === 'complete') { finish(run, 'complete', verdict.reason || 'המטרה הושגה'); return true; }
    if (verdict.status === 'stalled') { finish(run, 'stalled', verdict.reason || 'התכנסות — אין רווח נוסף'); return true; }

    // גיבוי דטרמיניסטי לשיפוט של המפקח: שתי גרסאות רצופות עם אותו טקסט
    // בדיוק הן עצירה עובדתית, ולא עניין של דעה. בלי זה ריצה שבה שני
    // המשתתפים כבר סיימו הייתה רצה עד תקרת התורות רק כדי לחזור על עצמה.
    const stall = stalledByRepeat(run);
    if (stall) { finish(run, 'stalled', stall); return true; }

    if (run.turn + 1 >= run.cfg.maxTurns) { finish(run, 'turnlimit', 'הריצה הגיעה לתקרת התורות'); return true; }

    run.pendingNote = verdict.status === 'steer' ? verdict.note : null;
    run.turn += 1;
    persist(run);
    return false;
  }

  /** תור משתתף, כולל ניסיון שני אחד כשהפורמט לא נשמר. */
  async function participantTurn(run, role, message) {
    let raw = await callWithRetry(run, role, message);
    let parsed = checkArtifact(run, raw);
    if (!parsed.ok) {
      push(run, { ev: 'reformat', role, why: parsed.why });
      raw = await callWithRetry(run, role, message + (parsed.why === 'too-big'
        ? `\n\n---\nSIZE LIMIT — the artifact you returned exceeds the hard ceiling of ${Math.floor(MAX_ARTIFACT / 1024)} KB. Return a version that fits, by cutting, not by truncating mid-sentence.`
        : FORMAT_REMINDER));
      parsed = checkArtifact(run, raw);
      if (!parsed.ok) {
        const why = parsed.why === 'too-big'
          ? 'התוצר חרג מתקרת הגודל פעמיים ברצף'
          : 'התשובה לא הגיעה בפורמט הנדרש (חסרים מגבילי התוצר)';
        throw Object.assign(new Error(why), { raw });
      }
    }
    parsed.raw = raw;
    return parsed;
  }

  function checkArtifact(run, raw) {
    const p = parseArtifact(raw);
    if (!p.ok) return p;
    // "מסרבים לגדול מעבר לתקרה" — הגרסה נדחית, ולא נחתכת באמצע משפט
    if (p.artifact.length > MAX_ARTIFACT) { run.ceilingHit = true; return { ok: false, why: 'too-big' }; }
    if (p.artifact.length >= MAX_ARTIFACT * CEILING_WARN) run.ceilingHit = true;
    return p;
  }

  /**
   * תור המפקח. פסק דין שלא ניתן לפענוח מקבל ניסיון שני, ואז נופל ל-"ok":
   * המפקח הוא יועץ, ותקלת פורמט אצלו לא אמורה להפיל שיתוף פעולה שעובד.
   */
  async function supervisorTurn(run) {
    const message = supervisorMessage(run);
    push(run, { ev: 'turn_start', role: 'S', model: roleModel(run, 'S'), version: run.version, turn: run.turn });
    let raw = '';
    try {
      raw = await callWithRetry(run, 'S', message);
      let v = parseVerdict(raw);
      if (!v.ok) {
        raw = await callWithRetry(run, 'S', message + JSON_REMINDER);
        v = parseVerdict(raw);
      }
      if (v.ok) return { ...v, after: run.version, afterSpeaker: run.history[run.history.length - 1].speaker, ts: Date.now() };
      return unreadable(run, 'המפקח לא החזיר JSON תקין');
    } catch (e) {
      // קריאה שנכשלה פעמיים — ממשיכים בלי פיקוח על התור הזה במקום לעצור את
      // הריצה. המשתתפים הם העבודה; המפקח הוא ההשגחה עליה.
      return unreadable(run, 'קריאת המפקח נכשלה: ' + String(e.message || e));
    }
  }

  const unreadable = (run, reason) => ({
    status: 'ok', note: '', reason, progress: null, unreadable: true,
    after: run.version, afterSpeaker: run.history[run.history.length - 1].speaker, ts: Date.now(),
  });

  function stalledByRepeat(run) {
    const v = run.versions;
    const n = v.length;
    if (n >= 2 && v[n - 1].text === v[n - 2].text) return 'שתי גרסאות רצופות זהות — התור האחרון לא שינה דבר';
    const h = run.history;
    if (h.length >= 2 && h[h.length - 1].done && h[h.length - 2].done) return 'שני המשתתפים הצהירו שאין מה לשנות';
    return null;
  }

  /* ==========================================================================
     מחזור החיים
     ========================================================================== */

  function setStatus(run, status, endReason) {
    run.status = status;
    if (endReason !== undefined) run.endReason = endReason;
    push(run, { ev: 'status', status, endReason: run.endReason, error: run.error || null });
    persist(run, true);
  }

  function finish(run, kind, reason) {
    if (run.status === 'done') return;
    run.gen += 1;                 // כל לולאה שעוד באוויר תזהה שהיא כבר לא רלוונטית
    run.error = null;
    run.endKind = kind;
    if (kind === 'complete') run.progress = 100;
    killActors(run);
    setStatus(run, 'done', reason);
    push(run, { ev: 'finished', endKind: kind, reason, progress: run.progress });
  }

  /** כישלון שאין ממנו התאוששות אוטומטית: עוצרים, מציגים, ומחכים ל"נסה שוב". */
  function fault(run, role, e) {
    run.gen += 1;
    const text = String((e && e.message) || e || 'שגיאה לא ידועה');
    run.error = { role, text, ts: Date.now(), raw: e && e.raw ? trimTail(e.raw, 4000) : null };
    killActors(run);              // תהליך שנפל באמצע לא ימשיך נכון; resume יקים אותו
    setStatus(run, 'error', '');
    push(run, { ev: 'error', role, text, raw: run.error.raw });
  }

  function launch(run) {
    run.gen += 1;
    run.error = null;
    run.stopReq = false;
    run.pauseReq = false;
    setStatus(run, 'running', '');
    loop(run).catch((e) => fault(run, null, e));
  }

  /* ---------- הפעולות שהמשתמש מפעיל ---------- */

  function start(convId, opts) {
    const cfg = normalizeCfg(opts);
    if (!cfg.goal) return { ok: false, error: 'חסרה מטרה' };
    if (cfg.seedTooBig) return { ok: false, error: `תוצר הפתיחה גדול מהתקרה (${Math.floor(MAX_ARTIFACT / 1024)}KB) — קצר אותו ונסה שוב` };
    let run = runs.get(convId);
    if (run && run.status === 'running') return { ok: false, error: 'הריצה כבר פעילה' };

    run = {
      convId,
      goal: cfg.goal,
      cfg: {
        A: { model: cfg.A.model, effort: cfg.A.effort, sessionId: null },
        B: { model: cfg.B.model, effort: cfg.B.effort, sessionId: null },
        S: { model: cfg.S.model, effort: cfg.S.effort, sessionId: null },
        maxTurns: cfg.maxTurns, noteVisibility: cfg.noteVisibility, cwd: cfg.cwd,
      },
      artifact: cfg.seed || '',
      version: cfg.seed ? 1 : 0,
      turn: 0,
      phase: 'participant',
      history: [],
      versions: cfg.seed
        ? [{ v: 1, author: 'user', model: '', changelog: ['תוצר פתיחה שסופק על-ידך'], text: cfg.seed, ts: Date.now() }]
        : [],
      supervisorNotes: [],
      userNotes: [],
      pendingNote: null,
      pendingUserNotes: [],
      progress: 0,
      cost: { usd: 0, in: 0, out: 0, byRole: {} },
      status: 'idle', endReason: '', endKind: '', error: null,
      ceilingHit: false,
      gen: 0, myGen: 0, wait: null, stopReq: false, pauseReq: false,
      createdAt: Date.now(),
    };
    runs.set(convId, run);
    persist(run, true);
    // תמונת מצב מלאה לפני הפריים הראשון: המסך שפתח את הריצה בונה ממנה את
    // התצוגה מיד, בלי סיבוב נוסף של הרשמה מחדש רק כדי לגלות מה התחיל.
    push(run, { ev: 'state', run: snapshot(run) });
    launch(run);
    return { ok: true, run: snapshot(run) };
  }

  function pause(convId) {
    const run = runs.get(convId);
    if (!run || run.status !== 'running') return;
    // עצירה לפני הקריאה הבאה ולא אחריה: אם תור כבר באוויר הוא יסתיים ויירשם,
    // וההשהיה תיתפס בבדיקה שלפני התור שאחריו. מסמנים מיד כדי שהמסך יגיב עכשיו.
    run.pauseReq = true;
    push(run, { ev: 'pausing' });
    if (!run.wait) { run.pauseReq = false; run.gen += 1; setStatus(run, 'paused', ''); }
  }

  function resume(convId) {
    const run = runs.get(convId);
    if (!run) return;
    // השהיה נכנסת לתוקף רק בגבול שבין שתי קריאות למודל, ולכן יש חלון שבו
    // ביקשת להשהות והריצה עוד רצה. "המשך" בחלון הזה מבטל את הבקשה — אחרת הוא
    // היה נבלע, והריצה הייתה נעצרת שנייה אחרי שביקשת בדיוק את ההפך.
    if (run.status === 'running') {
      if (!run.pauseReq) return;
      run.pauseReq = false;
      push(run, { ev: 'status', status: 'running', endReason: run.endReason, error: null });
      return;
    }
    if (!['paused', 'error'].includes(run.status)) return;
    launch(run);
  }

  function stop(convId) {
    const run = runs.get(convId);
    if (!run || ['done'].includes(run.status)) return;
    if (run.status !== 'running') { run.gen += 1; killActors(run); return finish(run, 'stopped', 'הופסק על-ידך'); }
    run.stopReq = true;
    push(run, { ev: 'stopping' });
    // הדור עולה *לפני* קטיעת התור, כדי שהדחייה שתגיע מיד אחריה תזוהה בלולאה
    // כ"כבר לא רלוונטי" ולא תצויר כשגיאה מעל הסיום.
    run.gen += 1;
    const w = run.wait;
    if (w) {
      const s = D.sessions.get(actorId(convId, w.role));
      if (s && s.child) { try { s.child.kill('SIGINT'); } catch {} }
      w.fail('הריצה הופסקה');
    }
    finish(run, 'stopped', 'הופסק על-ידך');
  }

  /** הערת משתמש — נכנסת לתור המשתתף הבא, בדיוק כמו הערת מפקח ומסומנת ככזו. */
  function note(convId, text) {
    const run = runs.get(convId);
    const t = String(text || '').trim().slice(0, 4000);
    if (!run || !t) return;
    const rec = { text: t, ts: Date.now(), atVersion: run.version };
    run.userNotes.push(rec);
    run.pendingUserNotes.push(rec);
    push(run, { ev: 'user_note', note: rec });
    persist(run);
  }

  function retry(convId) {
    const run = runs.get(convId);
    if (!run || run.status !== 'error') return;
    launch(run);
  }

  function normalizeCfg(o) {
    const one = (x) => ({
      model: String((x && x.model) || '').slice(0, 200),
      effort: String((x && x.effort) || '').slice(0, 20),
    });
    const n = Math.round(Number(o && o.maxTurns));
    return {
      goal: String((o && o.goal) || '').trim().slice(0, MAX_GOAL),
      seed: String((o && o.seed) || ''),
      seedTooBig: String((o && o.seed) || '').length > MAX_ARTIFACT,
      A: one(o && o.A), B: one(o && o.B), S: one(o && o.S),
      maxTurns: Math.max(MIN_TURNS, Math.min(MAX_TURNS, isFinite(n) ? n : 8)),
      noteVisibility: (o && o.noteVisibility) === 'whisper' ? 'whisper' : 'shared',
      cwd: typeof (o && o.cwd) === 'string' ? o.cwd : '',
    };
  }

  /* ==========================================================================
     תמונת מצב ושמירה
     ========================================================================== */

  /**
   * מה שהמסך מקבל. גוף הגרסאות הישנות לא נכלל בכוונה — הוא נמשך לפי דרישה
   * דרך ‎/api/duet/:id/version/:v‎ כשבוחרים בהן. ריצה של שלושים תורות עם תוצר
   * של מאתיים קילובייט הייתה שולחת שישה מגה בכל רענון, על גרסאות שאיש לא פתח.
   */
  function snapshot(run) {
    if (!run) return null;
    return {
      convId: run.convId,
      goal: run.goal,
      status: run.status,
      endReason: run.endReason,
      endKind: run.endKind,
      error: run.error,
      turn: run.turn,
      phase: run.phase,
      version: run.version,
      maxTurns: run.cfg.maxTurns,
      noteVisibility: run.cfg.noteVisibility,
      participants: {
        A: { model: run.cfg.A.model, effort: run.cfg.A.effort },
        B: { model: run.cfg.B.model, effort: run.cfg.B.effort },
        S: { model: run.cfg.S.model, effort: run.cfg.S.effort },
      },
      artifact: run.artifact,
      versions: run.versions.map((v) => ({ v: v.v, author: v.author, model: v.model, changelog: v.changelog, ts: v.ts, size: v.text.length })),
      history: run.history,
      supervisorNotes: run.supervisorNotes,
      userNotes: run.userNotes,
      progress: run.progress,
      cost: run.cost,
      ceilingHit: run.ceilingHit,
      speaking: run.wait ? run.wait.role : null,
      maxArtifact: MAX_ARTIFACT,
    };
  }

  function versionText(convId, v) {
    const run = runs.get(convId) || hydrate(convId);
    if (!run) return null;
    const hit = run.versions.find((x) => x.v === Number(v));
    return hit ? hit.text : null;
  }

  const titleOf = (goal) => {
    const line = String(goal || '').split('\n').find((l) => l.trim()) || 'דואט';
    return 'דואט · ' + (line.length > 60 ? line.slice(0, 60).trim() + '…' : line.trim());
  };

  /** קובץ השיחה של ריצת דואט. אותו מנגנון אחסון, שדות נוספים. */
  function convOf(run, prev) {
    return {
      id: run.convId,
      mode: 'duet',
      title: (prev && prev.title && prev.renamed) ? prev.title : titleOf(run.goal),
      renamed: !!(prev && prev.renamed),
      sessionId: null,
      cwd: run.cfg.cwd || '',
      draft: '',
      cost: run.cost.usd,
      ctx: null,
      createdAt: run.createdAt,
      updatedAt: Date.now(),
      messages: [],
      goal: run.goal,
      participants: {
        A: { ...run.cfg.A }, B: { ...run.cfg.B }, S: { ...run.cfg.S },
      },
      maxTurns: run.cfg.maxTurns,
      noteVisibility: run.cfg.noteVisibility,
      // עותקים ולא הפניות: מה שנמסר לאחסון הוא *תצלום* של הריצה, והריצה
      // ממשיכה לדחוף לאותם מערכים אחרי הקריאה. כל עוד הכתיבה הייתה מיידית
      // וסינכרונית אי-אפשר היה להבחין בהבדל; מרגע שהאחסון מחזיק את האובייקט
      // במטמון, הפניה חיה פירושה שהמטמון זוחל אחרי הריצה במקום לשקף את הדיסק.
      // (המערכים נדחפים בלבד — אף איבר אינו משתנה במקומו — ולכן slice מספיק.)
      versions: run.versions.slice(),
      turns: run.history.slice(),
      supervisorNotes: run.supervisorNotes.slice(),
      userNotes: run.userNotes.slice(),
      // ריצה שהייתה באוויר כשהשרת ירד תיטען כמושהית, עם כפתור המשך — ולא
      // תיראה לנצח כאילו היא עדיין רצה
      status: run.status === 'running' ? 'paused' : run.status,
      phase: run.phase,
      endReason: run.endReason,
      endKind: run.endKind,
      progress: run.progress && typeof run.progress === 'object' ? { ...run.progress } : run.progress,
      usage: { ...run.cost },
      ceilingHit: run.ceilingHit,
    };
  }

  // כתיבה דחוסה: תור נגמר ומיד אחריו נכנס פסק דין, ואין טעם לכתוב מגה-בייט
  // לדיסק פעמיים בתוך שנייה. שמירה מיידית שמורה לשינויי מצב.
  function persist(run, now) {
    if (run.saveTimer) { clearTimeout(run.saveTimer); run.saveTimer = null; }
    const write = () => {
      run.saveTimer = null;
      try {
        const prev = D.readConv(run.convId);
        const c = convOf(run, prev);
        c.rev = ((prev && Number(prev.rev)) || 0) + 1;
        // הכתיבה אסינכרונית, ולכן כישלון שלה מגיע כדחייה ולא כזריקה. בלי
        // התפיסה הזו הוא היה יוצא כ-unhandledRejection במקום כשורת יומן.
        Promise.resolve(D.writeConv(c)).catch((e) =>
          D.dbg('duet.persist.fail', { convId: run.convId, err: String((e && e.message) || e) }));
        D.broadcastAll({ kind: 'conv_meta', meta: D.convMeta(c) });
      } catch (e) { D.dbg('duet.persist.fail', { convId: run.convId, err: String(e.message || e) }); }
    };
    if (now) write(); else run.saveTimer = setTimeout(write, 700);
  }

  /** טוען ריצה שמורה מהדיסק לזיכרון — כדי שאפשר יהיה להמשיך אותה או לצפות בה. */
  function hydrate(convId) {
    if (runs.has(convId)) return runs.get(convId);
    const c = D.readConv(convId);
    if (!c || c.mode !== 'duet') return null;
    const p = c.participants || {};
    const one = (x) => ({ model: (x && x.model) || '', effort: (x && x.effort) || '', sessionId: (x && x.sessionId) || null });
    const versions = Array.isArray(c.versions) ? c.versions : [];
    const run = {
      convId,
      goal: c.goal || '',
      cfg: {
        A: one(p.A), B: one(p.B), S: one(p.S),
        maxTurns: Number(c.maxTurns) || 8,
        noteVisibility: c.noteVisibility === 'whisper' ? 'whisper' : 'shared',
        cwd: c.cwd || '',
      },
      artifact: versions.length ? versions[versions.length - 1].text : '',
      version: versions.length ? versions[versions.length - 1].v : 0,
      turn: (Array.isArray(c.turns) ? c.turns.length : 0) - (c.phase === 'supervisor' ? 1 : 0),
      phase: c.phase === 'supervisor' ? 'supervisor' : 'participant',
      history: Array.isArray(c.turns) ? c.turns : [],
      versions,
      supervisorNotes: Array.isArray(c.supervisorNotes) ? c.supervisorNotes : [],
      userNotes: Array.isArray(c.userNotes) ? c.userNotes : [],
      pendingNote: null, pendingUserNotes: [],
      progress: Number(c.progress) || 0,
      cost: (c.usage && typeof c.usage === 'object') ? c.usage : { usd: Number(c.cost) || 0, in: 0, out: 0, byRole: {} },
      status: c.status === 'running' ? 'paused' : (c.status || 'paused'),
      endReason: c.endReason || '', endKind: c.endKind || '', error: null,
      ceilingHit: !!c.ceilingHit,
      gen: 0, myGen: 0, wait: null, stopReq: false, pauseReq: false,
      createdAt: Number(c.createdAt) || Date.now(),
    };
    if (!run.cost.byRole) run.cost.byRole = {};
    runs.set(convId, run);
    return run;
  }

  function dispose(convId) {
    const run = runs.get(convId);
    if (!run) return;
    run.gen += 1;
    if (run.saveTimer) clearTimeout(run.saveTimer);
    killActors(run);
    runs.delete(convId);
  }

  return {
    start, pause, resume, stop, note, retry, dispose, hydrate, versionText, has,
    snapshot: (convId) => snapshot(runs.get(convId) || hydrate(convId)),
    limits: { MAX_ARTIFACT, MAX_TURNS, MIN_TURNS },
  };
};
