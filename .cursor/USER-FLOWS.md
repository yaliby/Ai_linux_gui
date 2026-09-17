# User Flows — Sol (executed)

Status: continuous through ~8h window (resume 08:45 → target 16:08)

## Product shape

RTL Hebrew chat shell; drawer ≤760px; composer + `#log`; overlays palette/model/usage/modal.

## Flows

| # | Flow | Status | Evidence |
|---|------|--------|----------|
| 1 | Open app | RUN | HTTPS → 200 HTML/JS/CSS |
| 2 | Open conversation | RUN | switchConv + loading skeleton |
| 3 | Create conversation | RUN | newChat / anon / duet · startNewChat / go=new |
| 4 | Write prompt | RUN | harness type/tall/compact matrix |
| 5 | Send | RUN | empty toast + queue affordance + sendGate |
| 6 | Stop | RUN | interruptTurn offline toast |
| 7 | Streaming | RUN | working aria-live / stale / permWaiting |
| 8 | Tool output | PARTIAL | DOM + GOD card review |
| 9 | Permission | RUN | decidePermission + Enter/send gate + notify jump |
| 10 | Switch conversation | RUN | busy/limit/duet toasts · no false abandonTurn |
| 11 | Switch model | RUN | mp-btn + F favorite + focus restore |
| 12 | Return to conversation | RUN | draft restore + preserveScroll |
| 13 | Phone | RUN | ux-viewport-matrix + landscape + touch 44/36 |
| 14 | Error | RUN | save/share/search/upload/offline toasts |
| 15 | Reconnect | RUN | setStatus + stale perm prune + manualCheck |
| 16 | Refresh mid-action | PARTIAL | beacon/stashDraft code review |
| 17 | Rename | RUN | long-press + convTitle + palette |
| 18 | Duet | RUN | note/save/version/copy + closeFind focus |
| 19 | Pair remote | RUN | pair-code + expiry disable + QR fade |
| 20 | Delete conv | RUN | confirm + restoreDraft local/remote + anon × |
| 21 | Find / Escape stack | RUN | z-order Escape + Ctrl+F closes palette |
| 22 | Mermaid / theme | RUN | copy btn + rethemeMermaid |
| 23 | Presence secondary | RUN | data-mode=view → 👁N on narrow |
| 24 | Notification answer offline | RUN | SW showNotification on fail |

## Viewports × themes

- 360×640, 390×844, 412×915, 844×390 landscape, 1280×800
- Light/dark token contrast measured (all ≥4.5 on core pairs)
