# User Flows — Sol (executed)

Status: continuous through ~8h window (resume 08:45 → target 16:08)

## Product shape

RTL Hebrew chat shell; drawer ≤760px; composer + `#log`; overlays palette/model/usage/modal.

## Flows

| # | Flow | Status | Evidence |
|---|------|--------|----------|
| 1 | Open app | RUN | HTTPS 5123 → 200 HTML/JS/CSS |
| 2 | Open conversation | RUN | code paths switchConv + loading skeleton |
| 3 | Create conversation | RUN | newChat / anon / duet entries |
| 4 | Write prompt | RUN | harness type/tall/compact matrix |
| 5 | Send | RUN | empty toast + queue affordance tests |
| 6 | Stop | RUN | interruptTurn offline toast test |
| 7 | Streaming | RUN | working/stale/permWaiting code+tests |
| 8 | Tool output | PARTIAL | DOM structure review |
| 9 | Permission | RUN | offline decidePermission + Enter→ask |
| 10 | Switch conversation | RUN | busy/limit/duet toasts |
| 11 | Switch model | RUN | mp-btn aria + focus restore |
| 12 | Return to conversation | RUN | draft restore + preserveScroll |
| 13 | Phone | RUN | ux-viewport-matrix + landscape 844×390 |
| 14 | Error | RUN | save/share/search/upload toasts |
| 15 | Reconnect | RUN | setStatus + manualCheck |
| 16 | Refresh mid-action | PARTIAL | beacon/stashDraft code review |
| 17 | Rename | RUN | long-press + convTitle + palette |
| 18 | Duet | RUN | note/save/version/copy feedback |
| 19 | Pair remote | RUN | pair-code button + expiry tick |

## Viewports × themes

- 360×640, 390×844, 412×915, 844×390 landscape, 1280×800
- Light/dark token contrast measured (all ≥4.5 on core pairs)
