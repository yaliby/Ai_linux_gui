# User Flows — Sol (executed)

Status: smoke + independent simulations complete (2026-09-17)

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
| 9 | Permission | RUN | pendingPerms vs renderWorking |
| 10 | Switch conversation | RUN | busy/limit toasts |
| 11 | Switch model | RUN | mp-btn aria |
| 12 | Return to conversation | RUN | draft restore paths |
| 13 | Phone | RUN | ux-viewport-matrix 360/390/412 |
| 14 | Error | RUN | save error toast, disconnect pill |
| 15 | Reconnect | RUN | setStatus + manualCheck |
| 16 | Refresh mid-action | PARTIAL | beacon/stashDraft code review |

## Viewports × themes

- 360×640, 390×844, 412×915, 1280×800 — layout harness
- Light/dark token contrast measured (incl. OS mismatch via hljs-theme suite)
