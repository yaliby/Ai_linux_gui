#!/usr/bin/env node
/**
 * ייצור אייקוני ה-PWA מתוך סימן Sol.
 *
 * הסימן חי כאן כמקור אחד (‎MARK‎) ולא כתשעה קבצי PNG שנערכים ביד: בפעם
 * הקודמת שהצבע השתנה נשארו מאחור קבצים בצבע הישן, כי אין דרך לראות
 * אייקון של 512 פיקסלים בסקירת דיף. שינוי צבע או צורה — עורכים כאן ומריצים
 * ‎npm run icons‎.
 *
 * הרסטור נעשה בדפדפן שמותקן על המכונה (Chromium headless). זו התלות היחידה,
 * והיא לא נכנסת ל-package.json כי היא נדרשת רק לסקריפט הזה.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** הסימן עצמו, ב-viewBox של 24. ראו icon.svg לנימוקי הצורה. */
const MARK = 'M16.6 7.4A4.6 4.6 0 1 0 12 12 4.6 4.6 0 1 1 7.4 16.6';
const BG = '#1a1d20';
const FG = '#6fb6ae';

/**
 * ‎scale‎ קובע כמה מהאריח הסימן תופס. ב-‎maskable‎ הוא קטן יותר בכוונה:
 * המערכת חותכת את האריח לצורה שלה (עיגול, סקוויירקל) ושומרת רק את 80%
 * המרכזיים, ולכן סימן בגודל הרגיל היה מאבד את קצות הלולאות.
 */
const tile = (px, { scale, radius }) => {
  const t = (64 - 12 * scale).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${px}" height="${px}">`
    + `<rect width="128" height="128" rx="${radius}" fill="${BG}"/>`
    + `<g transform="translate(${t} ${t}) scale(${scale}) rotate(30 12 12)"`
    + ` fill="none" stroke="${FG}" stroke-width="2.6" stroke-linecap="round">`
    + `<path d="${MARK}"/></g></svg>`;
};

const tmp = mkdtempSync(join(tmpdir(), 'sol-icons-'));
const shot = (svg, px, out) => {
  const html = join(tmp, 'i.html');
  writeFileSync(html, `<!doctype html><meta charset="utf-8">`
    + `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`);
  execFileSync('brave-browser', [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--default-background-color=00000000',
    `--window-size=${px},${px}`, `--screenshot=${out}`, `file://${html}`,
  ], { stdio: 'ignore' });
  console.log(`  ${out.replace(ROOT + '/', '')}  ${px}×${px}`);
};

console.log('סימן Sol → אייקונים:');
// הפינה המעוגלת גדלה עם האריח, אבל ב-16 ו-32 רדיוס יחסי מלא אוכל את הסימן
for (const px of [16, 32, 48, 64, 128, 192, 256, 512]) {
  shot(tile(px, { scale: 3, radius: px <= 32 ? 18 : 28 }), px, join(ROOT, 'public/icons', `icon-${px}.png`));
}
shot(tile(512, { scale: 2.35, radius: 0 }), 512, join(ROOT, 'public/icons/icon-maskable-512.png'));
copyFileSync(join(ROOT, 'public/icons/icon-32.png'), join(ROOT, 'public/favicon.png'));
console.log('  public/favicon.png  32×32 (עותק של icon-32)');
rmSync(tmp, { recursive: true, force: true });
