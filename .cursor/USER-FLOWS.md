# User Flows — Sol

Mapped from `public/index.html`, `public/app.js`, `public/style.css`, and harness APIs.
Simulations will mark each flow as RUN / PARTIAL / BLOCKED with evidence.

## Product shape

- RTL Hebrew chat shell around Claude/Cursor agents
- Desktop: persistent sidebar + main
- Mobile (≤760px / short landscape coarse): drawer sidebar + backdrop
- Composer at bottom; transcript `#log`; overlays for palette, model picker, modals, usage

---

## 1. Open app

**Steps:** load `/` → SW register → WS connect → restore active conversation / welcome
**UI:** `#statusDot`, `#statusPill`, `#log` (`.welcome` or messages), composer ready
**Success signal:** pill “מוכן”, dot `.on`
**Failure:** disconnected title, no `.on`
**Status:** PENDING simulation

## 2. Open conversation

**Steps:** `#sideToggle` (mobile) → pick `.conv` in `#convList` → `switchConv(id)`
**UI:** title `#convTitle`, transcript render, draft restore
**Status:** PENDING

## 3. Create conversation

**Paths:**
- `#newChat` / `#newChatTop` → `startNewChat()`
- `#newAnon` → anon bar + `body.anon-mode`
- `#newDuet` → duet mode
**Status:** PENDING

## 4. Write prompt

**Steps:** focus `#input` → type / dictate / attach
**States:** `compose-compact` (keyboard), `compose-tall` (multi-line), `#attStrip`, `#dictStrip`
**Status:** PENDING

## 5. Send

**Steps:** Enter or `#sendBtn` → `sendMessage()`
**Busy:** `body.busy`, `#working`, send may become queueing
**Status:** PENDING

## 6. Stop

**Steps:** `#stopBtn` → `interruptTurn()`
**Status:** PENDING

## 7. Streaming

**Signal:** live assistant row, `#topProgress`, `#workingText`
**Status:** PENDING

## 8. Tool output

**DOM:** `details.tool`, `.tstatus` run/ok/rej/err
**Status:** PENDING

## 9. Permission

**DOM:** `.perm` cards, `#askBar`, `body.awaiting`
**Actions:** allow / always / deny
**Status:** PENDING

## 10. Switch conversation

**While idle / busy:** `switchConv`; draft stash/restore
**Status:** PENDING

## 11. Switch model

**Paths:** `#model` / model picker `#modelPicker` → `pickModel` / `pushModel` if busy
**Status:** PENDING

## 12. Return to conversation

**Via list or palette Ctrl+K**
**Status:** PENDING

## 13. Phone use

**Viewports:** 360×640, 390×844, 412×915
**Focus:** drawer, `#moreBtn`, compact composer, safe-area, thumb reach
**Status:** PENDING

## 14. Error

**Toasts `.toast.err`, notes `.note.err`, halt cards, WS disconnect**
**Status:** PENDING

## 15. Reconnect

**Auto 1.5s; manual `#syncBtn` / `#resyncBtn` when stale**
**Status:** PENDING

## 16. Refresh mid-action

**Page reload during busy / permission / draft**
**Status:** PENDING

---

## Supporting flows

| Flow | Entry | Notes |
|------|-------|-------|
| Theme | `#themeToggle` | `data-theme` light/dark |
| Settings | `#settingsToggle` | cwd, notify, install |
| Find in chat | `#findBtn` / Ctrl+F | `#findBar` |
| Usage meters | `#composerUsage` | `#usageModal` |
| Command palette | Ctrl/Cmd+K | `#palette` |
| Remote/pair | `#remoteBtn` | modal |
| Jump to bottom | `#jumpBtn` | when scrolled up |

---

## Simulation matrix (planned)

Viewports: 360×640, 390×844, 412×915, 1280×800
Themes: light, dark, light+dark OS, dark+light OS
Scenarios: see run checklist (long Hebrew, code, 200 msgs, keyboard open, etc.)
