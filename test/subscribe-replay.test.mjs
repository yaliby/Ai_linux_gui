/**
 * השלמת יומן ב-mode:reset — בלי כפילויות אחרי רענון.
 *   node test/subscribe-replay.test.mjs
 */
import { createRequire } from 'node:module';
import { runner } from './harness.mjs';

const require = createRequire(import.meta.url);
const { resetReplaySince } = require('../lib/subscribe-replay.js');

const t = runner('השלמת יומן ב-reset (בלי כפילויות ברענון)');

t.section('תור שכבר הסתיים — אין מה לשחזר מהיומן');
{
  const s = {
    running: false,
    log: [
      { seq: 1, kind: 'user_msg', text: 'שלום', nonce: 'n1' },
      { seq: 2, kind: 'event', evt: { type: 'assistant' } },
      { seq: 3, kind: 'busy', running: false },
    ],
  };
  t.eq('reset בלי תור רץ מדלג על היומן', resetReplaySince(s), null);
}

t.section('תור רץ — משלימים מתחילת התור החי');
{
  const s = {
    running: true,
    log: [
      { seq: 10, kind: 'user_msg', text: 'שאלתי', nonce: 'n2' },
      { seq: 11, kind: 'busy', running: true },
      { seq: 12, kind: 'event', evt: { type: 'stream_event' } },
    ],
  };
  t.eq('מתחילים לפני ה-user_msg של התור החי', resetReplaySince(s), 9);
}

t.section('יומן שצבר תור ישן + תור רץ — רק התור החי');
{
  const s = {
    running: true,
    log: [
      { seq: 1, kind: 'user_msg', text: 'ישן', nonce: 'old' },
      { seq: 2, kind: 'event', evt: { type: 'assistant' } },
      { seq: 3, kind: 'busy', running: false },
      { seq: 4, kind: 'user_msg', text: 'חדש', nonce: 'new' },
      { seq: 5, kind: 'busy', running: true },
      { seq: 6, kind: 'event', evt: { type: 'stream_event' } },
    ],
  };
  t.eq('מדלגים על התור שכבר בדיסק', resetReplaySince(s), 3);
}

t.section('קצוות');
{
  t.eq('בלי סשן', resetReplaySince(null), null);
  t.eq('תור רץ בלי יומן', resetReplaySince({ running: true, log: [] }), 0);
  t.eq('תור רץ בלי user_msg', resetReplaySince({
    running: true,
    log: [{ seq: 7, kind: 'busy', running: true }],
  }), 0);
}

t.done();
