# AGENTS.md

Guidance for AI coding agents (and humans) working on DeskBridge. Read this before making changes.

## What this project is

DeskBridge is a remote-desktop relay. A phone or browser controller sends mouse, keyboard and PowerShell commands through a central Node relay to Windows host agents, which stream JPEG frames back. A Gemini assistant turns natural-language and voice requests into the same input events.

**This software executes arbitrary commands on real machines.** Treat every change that touches authentication, message routing or the agent scripts as security-sensitive.

## Layout

| Path | Role |
| --- | --- |
| `server.ts` | Entry point: reads env and calls `createRelay()`. Keep it thin. |
| `server/relay.ts` | `createRelay(options)`: Express + `ws` relay (REST API, WebSocket routing, host registry, heartbeat, Vite middleware or static `dist/`). All state is per instance, so tests can run several relays. |
| `server/rateLimit.ts` | Sliding-window limiter (used for `/api/ai/*`). |
| `server/auth.ts` | Owner access token, signed session cookies, enrollment key, per-host secrets, origin check, login rate limiter. |
| `server/aiAssistant.ts` | Gemini calls: transcription, function-calling (desktop actions), optional TTS. Server-side only. |
| `server/windowsAgentGenerator.ts` | Generates the PowerShell agent (`DeskBridge-Host.ps1`), `.bat` launcher and Node agent (`deskbridge-host.mjs`) as template strings. |
| `src/main.tsx` | Entry. Wraps `App` in `AuthGate` (login screen until an owner session exists). |
| `src/App.tsx` | Tab shell: Fleet, Control Deck, AI Assistant, Windows Host. |
| `src/hooks/useDeskBridgeSocket.ts` | Controller WebSocket client: fleet state, pairing, frame decoding, input sending. |
| `src/lib/auth.ts` | `apiFetch` (use it for all `/api` calls), login/logout, unauthorized event. |
| `src/components/` | UI. `TouchControlDeck.tsx` (trackpad/tap/keyboard), `WindowsHostView.tsx` (agent downloads + browser host mode), `AIAssistantPanel.tsx`, `FleetView.tsx`, `QrScannerModal.tsx`, `LoginScreen.tsx`, `AuthGate.tsx`. |
| `src/types/deskbridge.ts` | Shared types between server and client (`HostProfile`, `RemoteInputEvent`, AI types). |
| `tests/` | `node:test` suites run through `tsx`: `relay.test.ts` (REST + WebSocket protocol, heartbeat, AI limits), `auth.test.ts`, `agentGenerator.test.ts`. `helpers.ts` starts an in-process relay on a free port with a temp data dir. |
| `.github/workflows/ci.yml` | CI: `bun install --frozen-lockfile`, lint, test, build. |

Runtime state (git-ignored, contains secrets, never commit): `.deskbridge-auth.json`, `.deskbridge-hosts.json`, `.env`.

## Commands

```bash
npm install          # or: bun install (bun.lock is the committed lockfile; don't add package-lock.json)
npm run dev          # tsx server.ts: relay + Vite middleware on :3000
npm run lint         # tsc --noEmit; must pass
npm test             # tsx --test "tests/**/*.test.ts"; must pass
npm run build        # vite build -> dist/
npm run check        # lint + test + build (what CI runs)
npm start            # NODE_ENV=production tsx server.ts (serves dist/)
```

If you change dependencies, run `bun install` so `bun.lock` stays in sync. CI uses `--frozen-lockfile`.

### Testing

- Every server behavior change needs a test in `tests/`. Use `startTestRelay()` from `tests/helpers.ts`, not a real port or the repo's data files.
- Security changes need both an allowed-path test and a rejected-path test (see the existing 401/4401 cases).
- `TestSocket.open(url, { autoPong: false })` simulates a dead connection, and `encodeFrame()` builds binary frames.
- There are no browser/UI tests. For UI changes, run `npm run dev` and check at ~390px width.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini key (server only). |
| `APP_URL` | Public base URL used in pairing links and agent scripts. |
| `DESKBRIDGE_ACCESS_TOKEN` | Owner login token (≥16 chars). Generated and stored if unset. |
| `DESKBRIDGE_DATA_DIR` | Where runtime state files live. Default: repo root. |
| `DESKBRIDGE_HEARTBEAT_MS` | WebSocket ping interval. Default 15000. |
| `AI_RATE_LIMIT_PER_MIN` | AI requests per session per minute. Default 20. |
| `GEMINI_MODEL`, `GEMINI_TRANSCRIBE_MODEL` | Override the primary model ids. |
| `PORT` | Listen port. Default 3000. |

## Wire protocol

All WebSocket traffic goes over `/ws`. JSON messages are `{ event, payload }`.

- **Host → relay**: `host:register` (needs `enrollKey`, plus `hostSecret` after first enrollment, unless the socket has an owner session), `host:frame` (JSON data-URL frame, browser host), `host:regenerate_code`.
- **Binary frames (host → relay → controllers)**: `0x44 0x01`, a big-endian `uint16` header length, a UTF-8 JSON header (`hostId`, `seq`, `activeWindow`, `timestamp`), then the JPEG bytes. The relay rewrites `hostId` to the socket's registered host.
- **Relay → host**: `host:registered` (may include a one-time `hostSecret`), `host:auth_error`, `host:controller_count`, `host:frame_ack`, `client:input`.
- **Controller → relay** (owner session required): `client:subscribe_fleet`, `client:pair`, `client:unpair`, `client:input`, `client:frame_ack`.
- **Relay → controller**: `fleet:update`, `client:paired`, `client:pair_error`, `host:frame`, `host:status`, `auth:required`.
- **Close codes**: `4401` authentication failed, `4409` host replaced by a newer connection, `1009` message too big (limit 8 MB).

Flow control: hosts keep at most about 2 unacknowledged frames in flight, and the relay drops frames for controllers whose `bufferedAmount` is high. Preserve both mechanisms when touching streaming code.

If you add an input type, update `RemoteInputEvent` in `src/types/deskbridge.ts`, the PowerShell `Handle-RemoteInput` switch, the browser host's `applyInputToVirtualDesktop`, and (if relevant) the Gemini tool declarations.

## Security invariants (do not break)

1. Every `/api/*` route except `/api/health` (reduced output when anonymous) and `/api/auth/*` sits behind the session middleware in `server/relay.ts`. Add new routes **after** that middleware.
2. `client:*` WebSocket events are rejected unless the socket has an owner session (`isOwner`). Origin is checked for cookie-bearing sockets.
3. A host frame or host event is only accepted from the socket that registered that host (`entry.ws === ws`). Never trust `payload.hostId` or the binary header's `hostId` for routing.
4. Never send `secretHash`, the enrollment key or the access token to clients, or include them in `HostProfile`. The only place the enrollment key leaves the server is the authenticated agent download.
5. Compare secrets with `safeEqual` / `verifySecret`, never with `===`.
6. Agent scripts must not interpolate untrusted strings into a shell. The PowerShell generator escapes `'` for single-quoted literals. The Node agent uses `execFile` with argument arrays (`shell` input is intentionally a shell command and is owner-only).
7. Every `ws` connection must have an `error` listener; without one, a malformed or oversized frame crashes the relay.
8. Client code calls the API through `apiFetch` so expired sessions return the user to the login screen.

## Conventions

- TypeScript (tsconfig has no `strict` flag; write code as if it did), ES modules. Server imports of local TS files use the `.js` extension (`./server/auth.js`).
- React 19 function components with hooks, Tailwind v4 utility classes, `lucide-react` icons, and dark mode via the `dark` class on `<html>`.
- Mobile-first UI: touch targets ≥ 40–44px, and test at phone width (~390px).
- Keep the PowerShell agent dependency-free (PowerShell 5.1 + .NET Framework only). Remember it is generated from a JS template literal: escape `` ` ``, `${` and backslashes accordingly.
- Gemini model ids live in `server/aiAssistant.ts` with env overrides `GEMINI_MODEL` and `GEMINI_TRANSCRIBE_MODEL`. The Gemini key is only read server-side.
- Don't commit build output (`dist/`), runtime state files, or a second lockfile.

## Reliability notes

- **Heartbeat**: the relay pings every socket each `DESKBRIDGE_HEARTBEAT_MS` and terminates any socket that missed the previous pong. Terminating marks a host offline. The PowerShell agent also sends keep-alive pongs.
- **Gemini fallbacks**: each candidate model is tried in turn. If all fail, the route returns 502 listing every model's error. If a fallback succeeded, the response `warning` names the models that failed. A missing key returns 503.

## Known gaps / roadmap

- There are no UI tests.
