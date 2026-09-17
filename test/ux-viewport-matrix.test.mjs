/**
 * סימולציית פריסת composer במטריצת viewports.
 *   node test/ux-viewport-matrix.test.mjs
 */
import { makeEnv, installViewport, runner } from './harness.mjs';

const t = runner('סימולציית UX — מטריצת viewports');

const VPS = [
  { w: 360, h: 640, name: '360×640' },
  { w: 390, h: 844, name: '390×844' },
  { w: 412, h: 915, name: '412×915' },
];

for (const vp of VPS) {
  t.section(vp.name + ' מקלדת סגורה');
  const env = makeEnv({ cardWidth: vp.w - 16, charW: 9, innerHeight: vp.h, coarse: true });
  installViewport(env, { width: vp.w, height: vp.h });
  env.keyboard(false);
  env.setText('שלום עולם זה טקסט בעברית לבדיקת פריסה');
  env.relayout();
  t.ok(vp.name + ' שלח ≥38', env.els.send.rect.width >= 38);
  t.ok(vp.name + ' תיבה חיובית', env.els.input.rect.width > 40);
  t.ok(vp.name + ' אין overflow קלף', env.els.card.rect.width <= vp.w);

  t.section(vp.name + ' מקלדת פתוחה + 15 שורות');
  env.keyboard(true, 320);
  const long = Array.from({ length: 15 }, (_, i) => `שורה מספר ${i + 1} עם טקסט עברי ארוך יחסית לבדיקה`).join('\n');
  env.setText(long);
  env.relayout();
  t.ok(vp.name + ' compact דלוק', env.els.body.classList.contains('compose-compact'));
  t.ok(vp.name + ' tall אחרי 15 שורות', env.tall());
}

t.section('1280 דסקטופ');
{
  const env = makeEnv({ cardWidth: 720, charW: 8, innerHeight: 800, coarse: false });
  env.setText('hello עברית mixed');
  env.relayout();
  t.ok('בלי compact בעכבר', !env.els.body.classList.contains('compose-compact'));
}

t.done();
