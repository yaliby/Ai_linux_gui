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
| 08:57 | COMMIT | Round 7 F75 | rename long-press + title + palette · CACHE v30 |
| 09:00 | COMMIT | Round 8 F76–F85 | touch+a11y batch from Workers · CACHE v31 |
| 09:01 | COMMIT | Round 9 F86–F88 | wakeLock, pair tick, landscape · CACHE v32 |
| 09:04 | COMMIT | Round 10 F89–F91 | toast alert, hot ctx, Enter→ask · CACHE v33 |
| 09:05 | HEARTBEAT | hunting Round 11 | F01–F91 · 16/16 |
| 09:20 | HEARTBEAT | continue discovery | USER-FLOWS updated · Workers Round 10 |
| 09:21 | COMMIT | Round 11 F92–F93 | loadConfig toast, backdrop focus · CACHE v34 |
| 09:34 | COMMIT | Round 12 F94–F95 | duet turns clamp, rename in shortcuts · CACHE v35 |
| 09:34 | HEARTBEAT | continue to 16:08 | F01–F95 · 16/16 |

| 09:35 | HEARTBEAT | discovery + re-sim | F01–F95 · waiting for diminishing returns |
| 09:50 | HEARTBEAT | Round 13 hunt | still evidence-gated · no invent |
| 09:51 | COMMIT | Round 13 F96 | modal focus restore · CACHE v36 |
| 10:12 | HEARTBEAT | Round 14 discover | F01–F96 · evidence-only |
| 10:18 | COMMIT | Round 14 F97–F101 | delete confirm, duet sync wait, share/logs · CACHE v37 |
| 11:05 | HEARTBEAT | Round 15 hunt | F01–F101 · 16/16 |
| 11:09 | COMMIT | Round 15 F102–F106 | launch/resume/palette/delete · CACHE v38 |
| 10:12 | HEARTBEAT | Round 14 discover | F01–F96 · evidence-only |
| 11:05 | HEARTBEAT | Round 15 hunt | F01–F101 · 16/16 |
| 11:55 | HEARTBEAT | Round 16 discover | F01–F106 · re-sim pending |
| 11:58 | COMMIT | Round 16 F107–F110 | delete/palette/find · CACHE v39 |
| 12:03 | COMMIT | Round 17 F111–F115,F117–F119 | perms/ac/anon/busy · CACHE v40 · F116 OPEN |
| 12:09 | COMMIT | Round 18 F116,F120–F125 | modal trap, Escape, share, limit · CACHE v41 |
| 12:13 | COMMIT | Round 19 F126–F129 | usage trap, rewind, cwd, pair · CACHE v42 |
| 12:13 | HEARTBEAT | Round 20 hunt | F01–F129 · 16/16 · →16:08 |
## Decisions

- Parallel workers; serialize writers on same files.
- No push; ports 5xxx only; kill by PID.
- First commit mixed Sol rename dirt (inseparable); later commits UX-only.
- Premature 33.B stop reversed by user — continue window without inventing work.
- F111: no local offline queue (needs WS); clearer toast only.

## Commits (local only)

Rounds 1–19 on `ux-optimization-run` through `4619d12`

## Existing dirty (owner — do not commit)

README, cursor-bridge, icons, package.json, manifest, hljs-theme.test.mjs
