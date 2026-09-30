# Sol — Hebrew RTL Interface for Claude Code

**TL;DR:** A full web interface for Claude Code with RTL/BIDI support, real-time streaming, multi-device sync over LAN, and support for multiple LLM providers (Claude, OpenAI, Cursor, local models).

## Project at a Glance

- **What it is:** A premium web UI wrapper around the `claude` CLI that adds a complete Hebrew-native experience
- **Why it exists:** Claude Code is terminal-based; this makes it mouse-friendly and mobile-optimized, especially for Hebrew text which requires BIDI handling
- **Live instance:** User runs `npm start` → opens on localhost:4173 + optional LAN (127.0.0.1:4173 + 192.168.x:4174)
- **Tech stack:** Node.js/Express backend, vanilla JS frontend, WebSocket for real-time sync, service worker for PWA

## Architecture Overview

### Backend (Server)

**Main entry:** `server.js` (~900 lines)
- Spawns child `claude` processes per conversation (not per device; conversations persist across connections)
- Wraps CLI output streams and translates them to WebSocket events for all connected clients
- Stores conversations to disk as JSON files under `~/.claude/rtl-claude/conversations/`
- Serves static assets with brotli compression (`lib/static-compress.js`)
- Routes: `/api/store`, `/api/conversations/*`, `/api/config`, `/api/search`, `/api/remote/*`, `/api/rc/*`, `/api/oauth/*`

**Bridges for multi-provider support:**
- `openai-bridge.js`: Translates Claude Messages API ↔ OpenAI Chat Completions API (for OmniRoute, local models)
  - Handles streaming, tool calls, reasoning, images as base64
  - Runs on random port with token auth, spawned per server instance
- `cursor-bridge.js`: Wraps cursor-agent CLI (runs one-shot per turn with `--resume` for context)
  - Simulates a persistent process by creating a fake child_process object
  - Compresses 223 models + effort levels down to ~78 display options
  - Maps different permission modes and handles tool rejections

**Core libraries:**
- `lib/agent-capabilities.js`: Scans CLI for available commands (slash commands)
- `lib/perm-mode.js`: Maps Claude Code permission modes and handles authorization flows
- `lib/schedule.js`: Manages scheduled tasks (placeholder for future features)
- `lib/mcp-admin.js`: MCP server management

### Frontend (Browser)

**Main app:** `public/app.js` (~4600 lines)
- Renders conversation in real-time as JSON events arrive
- Handles BIDI text layout (each paragraph inherits direction from first strong character)
- Rich rendering of tool cards (Bash output, diffs, file reads, todos, etc.)
- Lazy-loads tool card bodies (only built when first opened; search still finds content)
- Streaming text appears word-by-word with `--include-partial-messages`

**Key features in app.js:**
- Multi-conversation sidebar with auto-saved drafts per conversation
- Model selector with search and brand icons for each provider
- Live token counter and quota bar (Claude + Cursor)
- Permission mode selector (Approve Edits, Plan Only, Normal, No Prompts, GOD)
- Thinking card that displays summarized reasoning (`--thinking-display summarized`)
- Duet mode: two models taking turns on shared artifact
- Anonymous chat mode (no persistence, no session file, no logging)
- Voice dictation (`Ctrl+Shift+M`) with language switching mid-dictation
- Device linking via QR code or 8-char passphrase
- Remote Control panel for cloud sessions

**Styling:**
- `public/style.css`: ~1000 lines, all in HSL with CSS variables for light/dark modes
- Brand colors separated by saturation/lightness, not just hue (Sol's accent is deep teal; providers are distinct)
- Icons are inline SVG built from a single source (tools/build-icons.mjs), not PNG files

### Service Worker

**`public/sw.js`:** 
- Handles PWA installation and home-screen shortcuts
- Intercepts notifications; allows replying to permission requests from lock screen
- Shares files/links from other apps into the chat textarea
- Does NOT cache API responses (Claude + files live on the machine)

## Key Concepts

### Conversation Storage

Conversations live in `~/.claude/rtl-claude/conversations/` as JSON files:
- Index loaded on startup (list + metadata)
- Full conversation loaded only when clicked
- Atomic writes with tmp + rename
- Version (`rev`) field prevents write conflicts from multi-device editing
- Anonymous chats skip disk entirely (no file, no session file, no logging)

### Multi-Device Sync

**Single source of truth:** The server holds one `claude` process per conversation + a log of frames.
- Devices subscribe with `sincSeq` → receive `sync` (catchup from log) + live events
- Each frame gets sequential `seq` number
- If device falls behind by too much, it gets `reset` (reload from disk + start of current turn)
- Last writer wins, resolved by `baseRev` check on PUT (409 returns disk version)

**Real example:** Start message on laptop, read it on phone, continue on phone, close laptop — all three operations are to the same server process; closing a tab doesn't kill it.

### Permission Handling

Prompts from CLI arrive as `can_use_tool` events. Server has three options:
1. **Normal mode:** Show card with Bash/Edit/Write preview, buttons "Allow · Allow Always · Deny"
2. **GOD mode:** Auto-approve all, show collapsed card at end of message listing every approval
3. **No Prompts:** Skip card entirely (CLI was told to bypass)

Permission cards survive page reload and are shown on all connected devices.

### Multi-Provider Support

The server can launch multiple bridges simultaneously. Each provider is a separate entry in the model list:

| Provider | How it works | Unique aspects |
|---|---|---|
| **Claude (direct)** | CLI talks straight to api.anthropic.com | Most models, full feature support |
| **OmniRoute** | Claude Messages API → OpenAI adapter (Docker) | Can run Gemini, GPT, DeepSeek, etc. via OpenAI model names |
| **cursor-agent** | One-shot CLI with `--resume` for context | 78 models with effort levels, auto-resume, different permission mode handling |
| **Local** | OpenAI-compatible server (LM Studio, Ollama, vLLM) | Detectable at runtime, temperature + max tokens per model, no effort level |

Each bridge may have its own API key, timeout, and feature flags.

## Testing

**Run tests:** `npm test`

Tests are *not* in jsdom because the code measures DOM (bounding client rects, layout math) and jsdom returns 0 for everything. Instead:
- `test/harness.mjs`: Custom layout engine that simulates flex, wrapping, padding, text measurement
- `test/browser.mjs`: Real Chrome via DevTools Protocol for rendering validation
- Each test file is a complete module (Bash, Edit, voice dictation, permission sync, storage, WebSocket, etc.)

Key test suites:
- `composer-layout`, `compose-tall`: Single-line input box on mobile (no text wrap to second line)
- `dictation`: Voice input, whitespace logic, cursor anchoring, language switching
- `stream-render`: Receiving frames during rendering
- `contrast`: 4.5:1 WCAG ratio for all text in light + dark modes
- `server-store`: Multi-device writes, conflict resolution, atomic persistence
- `ws-sync`: WebSocket subscriptions, catch-up, and device presence

## Recent Work (Current Branch: `ux-optimization-run`)

Git status shows modified files across multiple domains:
- **New modules:** `lib/mcp-admin.js`, `lib/perm-mode.js`, `lib/schedule.js` (with corresponding tests)
- **Core updates:** `.env.example`, `server.js`, `openai-bridge.js`, `public/app.js`, `README.md`
- **Tests:** Updates to harness and most test files

From commit log: Work on MCP integration, permission modes, scheduling, and detecting "Connected" vs "Disconnected" states.

## Running the Project

```bash
# Terminal 1: Start the server (default: Claude via Anthropic)
npm start
# Listens on http://127.0.0.1:4173 (localhost)
# + http://<lan-ip>:4174 (LAN, if available)

# Terminal 2 (optional): Start OmniRoute + server together
npm run dev:all

# Optional: Watch/rebuild
npm run watch      # Rebuild on JS changes
npm run icons      # Rebuild brand icon set
```

**Environment:** See `.env.example` for all options. Key vars:
- `PORT=4173` (must match service worker assumptions)
- `RTL_HOST=127.0.0.1` (server listen address)
- `REMOTE_PORT=4174` (LAN port, auto-calculated as PORT+1)
- `OMNIROUTE_BASE_URL=http://localhost:3000/v1` (if using Docker)
- `LOCAL_BASE_URL=http://192.168.x.x:1234/v1` (if using local model server)

## Memory and State

User memory is already loaded — check `/home/yali/.claude/projects/-home-yali-Downloads-Progects-rtl-claude/memory/MEMORY.md` for:
- Live server running on 4173 (only kill test servers by exact PID)
- No git push credentials (commits land locally, user pushes manually)
- Ongoing quota-paced autonomous upgrade task

## Files You'll Touch

**Core logic changes:**
- `server.js`: Process lifecycle, event translation, storage
- `public/app.js`: Rendering, BIDI layout, interaction logic
- `openai-bridge.js`, `cursor-bridge.js`: Provider translation
- `lib/*.js`: Capabilities, permissions, scheduling

**Data & config:**
- `.env.example`: Environment variables (copy to `.env` locally, `.env` is gitignored)
- `lib/brands.js` (referenced in app.js): Brand colors and icons for 20+ model providers

**Testing:**
- `test/*.test.mjs`: Add tests here; run with `npm test`
- `test/harness.mjs`: Layout engine, fake DOM APIs

**No touch (auto-generated):**
- `public/icons/*`: Built by `npm run icons` from `icon.svg`
- `node_modules`: Dependencies

## How to Help the Next Model

When you hand off, include:
1. **What changed:** Files modified, tests added, bug fixed
2. **Why:** Context from commit messages and memory
3. **How to test:** Specific test commands, or "run the server and try X"
4. **What's next:** Any TODOs, failing tests, or known issues

Update this file (`CLAUDE.md`) if:
- Architecture changes fundamentally (e.g., moving from WebSocket to HTTP long-poll)
- A new provider is added (add a row to the table above)
- A test suite is created or removed
- Major libraries are added to `package.json`

Don't update if:
- Fixing a bug in an existing system (git log is the source of truth)
- Adding a feature to an existing module (mentioned in commit; this doc covers the module)
- Refactoring internal code without changing boundaries
