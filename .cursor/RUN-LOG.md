# Sol UX Optimization Run Log

Start: 2026-09-17 08:08 · Branch: `ux-optimization-run`  
Planned stop: ~16:08 (full ~8h window — user override of premature 33.B stop)

## Heartbeat

| Time | Track | Done | Evidence |
|------|-------|------|----------|
| 08:08 | SETUP | Branch, baseline tests, worker probe | 14→16 packages; parallel (25 @media) |
| 08:12 | DISCOVER | Product map + Workers A/B | 21 candidates |
| 08:20 | COMMIT | b5335a6 Batch 1–2 | 15/15 then growing |
| 08:24 | COMMIT | b3632ac Escape/presence/retry | 15/15 |
| 08:26 | COMMIT | 0b9962e find/perm/scroll/contrast | faint 4.64:1 |
| 08:29 | COMMIT | 0d3854a backdrop/aria/save | 46 asserts |
| 08:32 | COMMIT | 82af9c8 + 2fbb65c dropzone/matrix | 16 packages |
| 08:35 | COMMIT | 4542bda stop-offline/resync | 53 asserts; **STOP 33.B** (premature) |
| 08:45 | RESUME | User: continue full ~8h until ~16:08 | Round 2 implement |
| 08:50 | COMMIT | Round 2 F45,F49–F60 | npm test 16/16 · 71 ux asserts · CACHE v25 |
| 08:52 | COMMIT | Round 3 F61–F67 | queue/offline, toast a11y, rewind confirm · CACHE v26 |
| 08:54 | COMMIT | Round 4 F68–F70 | hist↑, settings focus, offline perm · CACHE v27 |
| 08:55 | COMMIT | Round 5 F71–F72 | duet note/save/version feedback · CACHE v28 |
| 08:56 | COMMIT | Round 6 F73–F74 | search toast, icon/cwd 44px · CACHE v29 |

## Decisions

- Parallel workers; serialize writers on same files.
- No push; ports 5xxx only; kill by PID.
- First commit mixed Sol rename dirt (inseparable); later commits UX-only.
- Premature 33.B stop reversed by user — continue window without inventing work.

## Commits

`b5335a6` `b3632ac` `0b9962e` `0d3854a` `82af9c8` `2fbb65c` `4542bda` `a5d676b` + Round 2 pending

## Existing dirty (owner — do not commit)

README, cursor-bridge, icons, package.json, manifest, hljs-theme.test.mjs
