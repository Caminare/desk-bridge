# AGENTS.md

Guidance for AI coding agents (and humans) working on DeskBridge. Read this before making changes.

## What this project is

DeskBridge is a remote-desktop relay. A phone or browser controller sends mouse, keyboard and PowerShell commands through a central Node relay to Windows host agents, which stream JPEG frames back. A Gemini assistant turns natural-language and voice requests into the same input events.

**This software executes arbitrary commands on real machines.** Treat every change that touches authentication, message routing or the agent scripts as security-sensitive.

## Layout

| Path | Role |
| --- | --- |
| `server.ts` | Express + `ws` relay: REST API, WebSocket routing, host registry, Vite middleware in dev, static `dist/` in prod. |
| `server/auth.ts` | Owner access token, signed session cookies, enrollment key, per-host secrets, origin check, login rate limiter. |
| `server/aiAssistant.ts` | Gemini calls: transcription, function-calling (desktop actions), optional TTS. Server-side only. |
| `server/windowsAgentGenerator.ts` | Generates the PowerShell agent (`DeskBridge-Host.ps1`), `.bat` launcher and Node agent (`deskbridge-host.mjs`) as template strings. |
| `src/main.tsx` | Entry. Wraps `App` in `AuthGate` (login screen until an owner session exists). |
| `src/App.tsx` | Tab shell: Fleet, Control Deck, AI Assistant, Windows Host. |
| `src/hooks/useDeskBridgeSocket.ts` | Controller WebSocket client: fleet state, pairing, frame decoding, input sending. |
| `src/lib/auth.ts` | `apiFetch` (use it for all `/api` calls), login/logout, unauthorized event. |
| `src/components/` | UI. `TouchControlDeck.tsx` (trackpad/tap/keyboard), `WindowsHostView.tsx` (agent downloads + browser host mode), `AIAssistantPanel.tsx`, `FleetView.tsx`, `QrScannerModal.tsx`, `LoginScreen.tsx`, `AuthGate.tsx`. |
| `src/types/deskbridge.ts` | Shared types between server and client (`HostProfile`, `RemoteInputEvent`, AI types). |

Runtime state (git-ignored, contains secrets, never commit): `.deskbridge-auth.json`, `.deskbridge-hosts.json`, `.env`.

## Commands

```bash
npm install          # or: bun install (bun.lock is the committed lockfile; don't add package-lock.json)
npm run dev          # tsx server.ts: relay + Vite middleware on :3000
npm run lint         # tsc --noEmit (the only static check; must pass)
npm run build        # vite build -> dist/
npm start            # NODE_ENV=production tsx server.ts (serves dist/)
```

There is no automated test suite yet. For server changes, start the server on a spare port with `DESKBRIDGE_ACCESS_TOKEN` set and drive it with a small `ws`/`fetch` script. Cover both the allowed path and the rejected path.

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

1. Every `/api/*` route except `/api/health` (reduced output when anonymous) and `/api/auth/*` sits behind the session middleware in `server.ts`. Add new routes **after** that middleware.
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

## Known gaps / roadmap

- No heartbeat: a host whose connection silently dies stays "online" until TCP notices.
- AI routes are authenticated but not rate-limited.
- The Gemini fallback loops swallow errors from earlier models.
- No tests or CI. `TouchControlDeck.tsx` and `WindowsHostView.tsx` are large and should be split.
- The PowerShell agent captures only the primary monitor, and typing via `SendKeys` has Unicode/newline limitations.
