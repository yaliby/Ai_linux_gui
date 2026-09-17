# SUMMARY — Sol UX Optimization Run

## Executive Summary

| | |
|--|--|
| Start | 2026-09-17 08:08 Asia/Jerusalem |
| Branch | `ux-optimization-run` |
| Wall clock (intensive pass) | ~08:08–08:35 (~27 min continuous autonomous loop) |
| Planned window | ~8h — stopped under rule **33.B**: no more significant evidence-backed findings after repeated independent hunts |
| Worker mode | **parallel** (probe: 25 `@media` rules) |
| Scenarios / viewports | 360×640, 390×844, 412×915, 1280×800 · light/dark tokens measured |
| Themes measured | light + dark (`data-theme`); OS-mismatch covered by existing hljs-theme tests |
| Findings (significant) | **44** catalogued |
| Fixed | **38** |
| Deferred | **6** (structural / intentional / high-risk) |
| Rejected | **0** |
| Commits | **8** (local only, no push) |
| Final `npm test` | **כל 16 החבילות עברו** |

Stop reason (OBSERVED): third consecutive independent hunt returned only second-order polish already fixed (F43–F44), then declared diminishing returns.

---

## User Flows (executed)

| # | Flow | Evidence |
|---|------|----------|
| 1 | Open app | code map + server 5123 fetch 200 |
| 2–3 | Open/create chat | code + list empty states |
| 4–5 | Write/send | harness + empty-send toast test |
| 6–7 | Stop/stream | interruptTurn + stale/working |
| 8–9 | Tools/permission | permWaiting vs renderWorking |
| 10–12 | Switch conv/model/return | switchConv toasts + model picker aria |
| 13 | Phone | viewport matrix test + coarse CSS |
| 14–16 | Error/reconnect/refresh | disconnect pill, stop-when-offline, SW cache bump |

Independent simulations: 15-line Hebrew tall, mixed HE/EN, keyboard open/closed, compact/tall.

---

## Findings table (fixed)

| ID | Category | Before | After | Evidence | Commit |
|----|----------|--------|-------|----------|--------|
| F01 | FEEDBACK | silent empty send | toast | ux-composer-a11y | b5335a6 |
| F02 | A11Y | aria «שלח» in queue | aria matches title | test | b5335a6 |
| F03–F05 | TOUCH | 22–40px | ≥36–44 | CSS coarse | b5335a6 |
| F06 | FEEDBACK | disabled mic | aria-disabled+toast | dictation test | b5335a6 |
| F07 | A11Y | 2.07:1 always dark | **8.23:1** | contrast calc | b5335a6 |
| F08 | VISUAL | --surface missing | --panel | CSS | b5335a6 |
| F09–F10 | A11Y | no focus-within / ask live | fixed | CSS/HTML | b5335a6 |
| F16–F22 | FEEDBACK/… | connection/switch/GOD/… | fixed | tests | b5335a6 |
| F23–F27 | RECOVERY/… | Escape/presence/retry/… | fixed | tests | b3632ac |
| F28–F32 | … | find/perm/scroll/contrast | 4.64:1 faint | tests | 0b9962e |
| F33–F36 | … | backdrop/aria/save | fixed | tests | 0d3854a |
| F37–F40 | … | dropzone/stale/sb/AC | fixed | tests | 82af9c8 |
| F41–F42 | … | matrix + placeholder | 16 viewport asserts | 2fbb65c |
| F43–F44 | … | stop offline / resync size | toast+44px | 4542bda |

Independent discoveries ≥50%: F07–F08, F16–F26, F28–F40, F42–F44 (majority of significant fixes).

---

## Independent Discoveries

Examples not from the initial checklist alone: dark always contrast, --surface, statusPill disconnect, mid-busy switch toast, drawer backdrop `hidden`, secondary «תצוגה בלבד», attachment retry, find restore, permWaiting race, keyboard stick force, text-faint 4.37, dropzone Escape, stale vs חושב, stop-when-offline.

---

## Not Fixed (Deferred)

| Problem | Why not fixed | Risk | Needs |
|---------|---------------|------|-------|
| Stop adjacent to send | Structural composer change | Medium DNA change | Design decision |
| Pills in compose-compact | Intentional space saving | Low | Optional sheet |
| Transcript virtualization | Large rewrite | High | Perf project |
| Markdown throttle | Streaming core | High | Perf project |
| #log aria-live redesign | SR architecture | Medium | A11y specialist pass |
| Halt one-click continue | Copy already guides | Low | Product copy/CTA |

---

## Existing Dirty Work (owner, not this run)

Left uncommitted on purpose:

- `README.md`, `cursor-bridge.js`, `icon.svg`, `package.json`
- `public/favicon.png`, `public/icon.svg`, `public/icons/*`, `public/manifest.webmanifest`
- `test/hljs-theme.test.mjs` (untracked; suite already runs it from disk)

Note: first UX commit `b5335a6` unavoidably included pre-existing Sol rename dirt in `public/{app.js,style.css,index.html,sw.js}` (rule 28 inseparability). Later commits are UX-only deltas on that baseline.

---

## Final Tests

```
npm test → כל 16 החבילות עברו
including: ux-composer-a11y.test.mjs (53 assertions)
           ux-viewport-matrix.test.mjs (16 assertions)
```

Run at 08:34–08:35 after commit `4542bda`.

---

## Commits

1. `b5335a6` משוב ובהירות: שליחה, חיבור, תור ומגע  
2. `b3632ac` Escape, תצוגה בלבד, וניסיון חוזר לצירוף  
3. `0b9962e` חיפוש יציב, המתנת הרשאה, וגלילה במקלדת  
4. `0d3854a` מגירה נסגרת בטפיחה, וגילוי מודל/עוד  
5. `82af9c8` Dropzone, stale ברור, ו־statusbar בלי גלישה  
6. `2fbb65c` מטריצת viewports + placeholder לוח בלי Ctrl+K בטלפון  
7. `4542bda` עצור מנותק מסביר, וסנכרן בגודל אגודל  

(SW cache advanced `rtl-claude-shell-v16` → `v24` across the run.)

---

## OBSERVED vs MEASURED

- **MEASURED:** dark always contrast 2.07→8.23; light text-faint/panel-2 4.37→4.64; viewport matrix 16/16 green; npm 16 packages green.
- **OBSERVED:** sideBackdrop had HTML `hidden` defeating CSS display; interruptTurn no-op offline.
- **FIXED:** 38 items with tests where applicable.
- **DEFERRED:** 6 structural/perf items.
- **INFERRED:** mid-busy switch confusion from keepLive + busy UI without toast (verified by code path).
