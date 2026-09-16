#!/usr/bin/env node
/**
 * מריץ את כל חבילות הבדיקה ומסכם.   npm test
 *
 * כל קובץ רץ בתהליך נפרד: חלקם טוענים מקטעים מ-app.js לתוך גלובלים מזויפים,
 * וחלקם מרימים שרת — שיתוף תהליך ביניהם היה הופך כל בדיקה לתלויה בשכנתה.
 * הרצה עם `node test/<שם>.test.mjs` תמיד עובדת גם לבד.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const dir = new URL('.', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

const results = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [new URL(f, dir).pathname], { stdio: 'inherit' });
  results.push({ f, ok: r.status === 0 });
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '─'.repeat(52));
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'}  ${r.f}`);
console.log('─'.repeat(52));
console.log(failed.length ? `\n${failed.length} חבילות נכשלו\n` : `\nכל ${results.length} החבילות עברו\n`);
process.exit(failed.length ? 1 : 0);
