/** רץ בדיקות קטן, בלי תלות — אותו קול כמו שאר הבדיקות בקובץ. */
export function runner(title) {
  let failed = 0;
  let passed = 0;

  const t = {
    section(name) {
      console.log('\n# ' + name);
    },
    eq(label, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      if (ok) {
        passed += 1;
        console.log('  ok ' + label);
      } else {
        failed += 1;
        console.error('  FAIL ' + label);
        console.error('    expected ' + JSON.stringify(expected));
        console.error('    actual   ' + JSON.stringify(actual));
      }
    },
    ok(label, cond, extra) {
      if (cond) {
        passed += 1;
        console.log('  ok ' + label);
      } else {
        failed += 1;
        console.error('  FAIL ' + label, extra != null ? extra : '');
      }
    },
    done() {
      console.log(`\n${title}: ${passed} עברו, ${failed} נכשלו`);
      if (failed) process.exitCode = 1;
    },
  };
  return t;
}
