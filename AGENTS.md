# AGENTS.md

Guidance for AI coding agents (and humans) working on DeskBridge. Read this before making changes.

## What this project is

DeskBridge is a remote-desktop relay. A phone or browser controller sends mouse and keyboard input through a central Node relay to native Windows host agents, which stream tiled JPEG frames back. Gemini voice dictation in the keyboard drawer turns speech into typed text.

**Source of truth:** the owner's Notion space "DeskBridge" holds the current state, capabilities, roadmap, specs and decisions. Read it before starting work (next task = lowest-Order Roadmap item not Done) and update it after each task. If it disagrees with this file about what is being built, Notion wins and this file gets updated.

**This software controls real machines.** Treat every change that touches authentication, enrollment, message routing or the agent as security-sensitive.

## Layout

| Path | Role |
| --- | --- |
| `server.ts` | Entry point: reads env and calls `createRelay()`. Keep it thin. |
| `server/relay.ts` | `createRelay(options)`: Express + `ws` relay (REST API, WebSocket routing, host registry, heartbeat, Vite middleware or static `dist/`). All state is per instance, so tests can run several relays. |
| `server/auth.ts` | Owner access token, signed session cookies, per-host secrets, origin check, login/enrollment rate limiter. |
| `server/enrollmentCodes.ts` | Short-lived single-use enrollment codes (`XXXX-XXXX`, 10 min, max 5 live, hashed in memory). |
| `server/cursorMessages.ts` | Validates agent cursor messages (`sanitizeCursorShape`: at most 128×128, RGBA byte count, hotspot inside; `sanitizeCursorPosition`: finite, -1..2). |
| `server/rateLimit.ts` | Sliding-window limiter (used for `/api/ai/*`). |
| `server/adaptiveStream.ts` | Adaptive stream quality: steps resolution/JPEG quality down when *queuing delay* (agent RTT above the path's baseline RTT) grows, back up when calm, capped by the user preset. |
| `server/aiAssistant.ts` | Gemini voice dictation transcription (server-side only). |
| `agent/windows/` | Native Windows host agent (.NET 10, `DeskBridge.Agent.sln`): `DeskBridge.Agent.Core` (platform-neutral protocol, tiling/diff, pacing, enrollment, supervisor; xUnit), `DeskBridge.Agent.Windows` (DXGI Desktop Duplication + GPU scale, GDI fallback, libjpeg-turbo, `SendInput`, DPAPI secret store, monitor enumeration, keep-awake), `DeskBridge.Agent.App` (WinForms tray app + enrollment window). |
| `src/lib/frameProtocol.ts` | Binary frame codec (v1 full JPEG, v2 tiled) shared by relay, client and tests (golden vectors shared with C#). |
| `src/lib/frameCompositor.ts` | Per-host off-DOM canvas compositor: off-main-thread tile decode, in-order apply, keyframe resync, stats. |
| `src/main.tsx` | Entry. Wraps `App` in `AuthGate` (login screen until an owner session exists). |
| `src/App.tsx` | Tab shell: Fleet, Control Deck, Windows Host. |
| `src/hooks/useDeskBridgeSocket.ts` | Controller WebSocket client: fleet state, pairing, frame decoding, input sending. |
| `src/lib/auth.ts` | `apiFetch` (use it for all `/api` calls), login/logout, unauthorized event. |
| `src/components/` | UI. `TouchControlDeck.tsx` (gesture handling + layout) composes `controlDeck/*` (`StreamViewport`, `TrackpadPanel`, `KeyboardDrawer`, `FullscreenHud`, `HostChips`, `qualityPresets`). `WindowsHostView.tsx` (agent download and Add a PC first, browser host demo mode below) composes `hostView/*` (`AgentDownloadCard`, `AddPcCard`, `PairingPanel`). Also `FleetView.tsx`, `QrScannerModal.tsx`, `LoginScreen.tsx`, `AuthGate.tsx`. |
| `src/components/LiveStreamCanvas.tsx` | Displays a host's composited canvas (rAF-coalesced, no React state per frame). |
| `src/lib/streamStatsRows.ts` | Label/value rows for `controlDeck/StreamStatsOverlay` (the strip adds the agent diagnostics; the fullscreen overlay stays compact). |
| `src/hooks/useCoalescedPointerInput.ts` | Batches relative mouse moves and absolute hover positions (16ms, latest wins) and scroll deltas (24ms) before sending. In Tap Screen mode a connected mouse moving with no button pressed moves the remote cursor (`queueMoveTo`). |
| `src/lib/activePointers.ts` | `registerPointerDown`: adds a pointer to a gesture map and drops fingers whose release was never seen (a new primary touch means no other finger is down). Without it a lost `pointerup` leaves a ghost finger and every one-finger touch becomes a pinch. |
| `src/lib/remoteCursor.ts` | `RemoteCursorStore` / `RemoteCursor`: per-host cursor outside React state. Agent position and shapes, plus local prediction fed from every sent input (absolute moves and clicks, relative deltas in physical pixels clamped like the agent); it hands over to the agent's position once the agent reports the predicted spot (within 2 px), or after 1.5 s. Unknown shapes draw a built-in arrow. |
| `src/lib/cursorOverlay.ts` | `cursorBox`: where and how big to draw the cursor (letterbox, zoom, physical-pixel scale, 16 CSS px minimum, hotspot). Drawn by `controlDeck/RemoteCursorOverlay` inside the zoomed container for hosts with `clientCursor`. |
| `src/lib/streamCoords.ts` | Pointer → normalized remote coordinates, accounting for `object-contain` letterboxing. |
| `src/lib/viewTransform.ts` | Zoom/pan view model (1–4×, zoom around a focal point, pan clamped to the letterboxed picture, CSS transform). `controlDeck/ZoomControls` and `controlDeck/ZoomMinimap` drive it; the viewport applies it as a `transform`, and click mapping keeps working because it measures the transformed canvas. Overlays drawn over the top of the stream (minimap, fullscreen stats) report their reach via `topInsetRef`, which becomes `topInset` so the top of the remote screen (browser tabs, title bars) can be panned out from under them. In the normal view the stats render as a strip below the stream, not over it. |
| `src/lib/dictation.ts` | Pure helpers for voice dictation text formatting (auto-spacing in buffered and live-keystroke modes). |
| `src/lib/virtualDesktop.ts` | Pure model + canvas drawing for the simulated desktop in browser host mode. |
| `src/types/deskbridge.ts` | Shared types between server and client (`HostProfile`, `RemoteInputEvent`, `TranscribeResponse`). |
| `tests/` | `node:test` suites run through `tsx`: `relay.test.ts` (REST + WebSocket protocol, heartbeat, AI limits), `auth.test.ts`, `enrollment.test.ts`, `enrollmentCodes.test.ts`, `activePointers.test.ts`, `dictation.test.ts`, `streamCoords.test.ts`, `streamStatsRows.test.ts`, `virtualDesktop.test.ts`, etc. `helpers.ts` starts an in-process relay on a free port with a temp data dir. |
| `.github/workflows/ci.yml` | CI: `bun install --frozen-lockfile`, lint, test, build; plus path-filtered .NET build/test on `windows-latest` and release publishing on `agent-v*` tags. |
| `deploy/setup-ubuntu.sh`, `deploy/update.sh` | One-command VPS install (Node 22, Caddy HTTPS, systemd service as user `deskbridge`, ufw, swap) and updater. Keep them idempotent; the env file and `/var/lib/deskbridge` state must survive re-runs. |

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

Native Windows agent (`agent/windows/`):

```powershell
dotnet test agent/windows/DeskBridge.Agent.sln
dotnet publish agent/windows/src/DeskBridge.Agent.App -c Release -o agent/windows/artifacts/publish
```

If you change dependencies, run `bun install` so `bun.lock` stays in sync. CI uses `--frozen-lockfile`.

### Releasing the Windows agent

Push a tag `agent-vX.Y.Z` (for example `git tag agent-v0.2.0 && git push origin agent-v0.2.0`). The `Agent (Windows)` workflow tests, runs `agent/windows/eng/package-release.ps1 -Version X.Y.Z` and publishes `deskbridge-agent-win-x64.zip` (exe plus `THIRD-PARTY-NOTICES.txt` and `licenses/`) as a GitHub release. The version comes only from the tag; local builds report `0.0.0-dev`, CI builds `0.0.0-ci`. A tag with a suffix (`-rc.1`) becomes a prerelease and never "latest". The Windows Host tab links to `releases/latest/download/deskbridge-agent-win-x64.zip`, so keep that asset name. A new bundled dependency needs its license added to `agent/windows/licenses/`, `THIRD-PARTY-NOTICES.txt` and the script.

### Testing

- Every server behavior change needs a test in `tests/`. Use `startTestRelay()` and `enrollHost()` from `tests/helpers.ts`, not a real port or the repo's data files.
- Security changes need both an allowed-path test and a rejected-path test (see the existing 401/4401/4403 cases).
- `TestSocket.open(url, { autoPong: false })` simulates a dead connection, and `encodeFrame()` builds binary frames.
- Platform-neutral agent logic lives in `DeskBridge.Agent.Core` and is tested with xUnit on any OS; binary frame and event contracts share golden vectors with `tests/`. DXGI capture tests skip automatically on runners without Desktop Duplication.
- There are no browser/UI tests. For UI changes, run `npm run dev` and check at ~390px width.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini key (server only). |
| `APP_URL` | Public base URL used in pairing and enrollment links. |
| `DESKBRIDGE_ACCESS_TOKEN` | Owner login token (≥16 chars). Generated and stored if unset. |
| `DESKBRIDGE_DATA_DIR` | Where runtime state files live. Default: repo root. |
| `DESKBRIDGE_HEARTBEAT_MS` | WebSocket ping interval. Default 15000. |
| `AI_RATE_LIMIT_PER_MIN` | AI requests per session per minute. Default 20. |
| `GEMINI_MODEL`, `GEMINI_TRANSCRIBE_MODEL` | Override the primary model ids. |
| `PORT` | Listen port. Default 3000. |
| `HOST` | Bind address. Default `0.0.0.0`; the VPS setup uses `127.0.0.1` behind Caddy. |
| `TRUST_PROXY` | `1` to take the login/enrollment rate-limiter client IP from the rightmost `X-Forwarded-For` entry. Only enable it behind a trusted proxy with the relay port not publicly reachable. |

## Wire protocol

All WebSocket traffic goes over `/ws`. JSON messages are `{ event, payload }`.

- **Enrollment (REST)**: owner mints a one-time code via `POST /api/agent/enroll-codes`; agent exchanges `{ code, name, previousHostId? }` at `POST /api/agent/enroll` (rate-limited, no owner session) for `{ hostId, hostSecret }`. `GET /enroll/:code` renders an instruction page without consuming or echoing the code.
- **Host → relay**: `host:register` (native agents send `hostId` + `hostSecret`; missing secret closes `4401`, unknown/revoked host id closes `4403`, wrong secret closes `4401`; an owner session running browser host mode needs no secret; may include `monitors` and `activeMonitor`; `cursor: true` means the agent can send its cursor separately), `host:cursor_shape` (`{ id, w, h, hotX, hotY, rgba }`: straight RGBA base64, physical pixels; each id sent once per connection, the agent remembers the last 32), `host:cursor` (`{ x, y, visible, shape }`: hotspot normalized on the streamed monitor, outside 0..1 = another monitor; sampled at the capture rate, 30 Hz while active, at most 60 Hz, only while a controller is paired), `host:update` (screen size / monitor changes, validated by `sanitizeMonitors`), `host:frame` (JSON data-URL frame, browser host), `host:regenerate_code`.
- **Binary frames (host → relay → controllers)**: `0x44`, a version byte, a big-endian `uint16` header length, a UTF-8 JSON header, then the payload (see `src/lib/frameProtocol.ts`). The relay rewrites `hostId` to the socket's registered host.
  - **v1 (`0x01`)**: header `hostId`, `seq`, `activeWindow`, `timestamp`; payload is one full-frame JPEG.
  - **v2 (`0x02`)**: also `w`, `h` (stream size), `key` (keyframe), `r` (flat `[x, y, w, h, byteLength]` per tile) and `stats` (agent `cap`/`enc` ms, capture method `cm`, `rtt` and baseline `brtt` ms, upload `kbps`, `q`, `mw`, changed/total tiles `ch`/`tt`, in-flight `inf`, send window `win` KB, sent fps `sfps`, plus diagnostics: scaling `sm`, smoothed capture ms per scaling `caps`/`capc`, diff `dif` and capture-cycle `tick` ms, per-second capture-thread rates `cfps`/`pfps`/`same`/`drop`/`rd`/`kf`, last keyframe reason `kr`, mailbox wait `age`, previous send `snd` ms, main-loop rate `lps`, keyframe requests `kreq`; all listed in `AgentFrameStats`). The payload is the tiles' JPEGs concatenated. Deltas only make sense on top of the previous frame.
- **Relay → host**: `host:registered` (`clientCursor: true` when the agent advertised `cursor`: from then on the agent stops drawing the cursor into frames; an agent that never gets it keeps drawing it), `host:auth_error`, `host:controller_count`, `host:frame_ack` (`relay: true` when the relay acked a frame no controller received), `host:keyframe_request`, `client:input` (including relay-generated adaptive `quality`).
- **Controller → relay** (owner session required): `client:subscribe_fleet`, `client:pair`, `client:unpair`, `client:input`, `client:frame_ack`, `client:keyframe_request`.
- **Relay → controller**: `fleet:update` (hosts carry `clientCursor`), `client:paired` (followed by the host's cached cursor shapes, up to 32, and the latest `host:cursor`), `client:pair_error`, `host:frame`, `host:status`, `host:cursor_shape`, `host:cursor` (a controller backed up past 512 KB is skipped and retried every 50 ms; it then gets the current position, plus all cached shapes if it missed one), `auth:required`. Cursor messages carry `hostId` and are validated by `server/cursorMessages.ts`.
- **Close codes**: `4401` authentication failed, `4403` host unknown or revoked (agent wipes credentials and re-prompts), `4409` host replaced by a newer connection, `1009` message too big (limit 8 MB).

Input events (`RemoteInputEvent`): `mousemove`, `click`, `mousedown`/`mouseup`, `scroll`, `type` (any Unicode; `\n` = Enter), `key` (`key` plus optional `modifiers`), `hotkey` (combo string such as `Ctrl+Shift+T`), `quality`, `monitor` (plus legacy `launch`, `shell`, `clipboard` in the type union, intentionally not implemented by the native agent).

### Streaming pipeline (keep these properties when changing it)

- **Agent (`agent/windows/`)**: `StreamingEngine` runs capture, diff, encode and send across dedicated threads so input (`InputWorker` calling `SendInput` on its own thread) is never blocked. Capture uses DXGI Desktop Duplication with GPU scaling (with automatic GDI fallback if Desktop Duplication is unavailable). The cursor is drawn into frames only until the relay confirms `clientCursor`; then both capture paths report it as a `CursorSnapshot` (`IFrameSource.Cursor`), `CursorShapeConverter` turns shapes into RGBA (inverting pixels become black with a white outline, shapes over 128 px are downscaled) and `CursorPublisher` sends each shape once per connection and throttled latest-wins positions, so cursor-only moves and animated cursors cost no frames. Cursor movement counts as activity for `CaptureScheduler`, so the cursor is sampled at the fast rate. The agent opts out of Windows EcoQoS power throttling at startup so encoding stays on performance cores. `DirtyTracker` sees every capture; `TileDiffer` compares 64×64 tiles against the last frame *handed to the sender*; `RegionMerger` merges changed tiles into rectangles; `libjpeg-turbo` encodes tiles. A keyframe is sent on request, after a resize or monitor switch, or when more than 50% of tiles changed. A single-slot `FrameMailbox` holds the freshest unsent frame, and a generation counter discards frames diffed against an outdated reference. Capture wakes early on input (after a short settle delay) and immediately on keyframe requests or monitor switches. Nagle is disabled on the socket. `SendWindow` is sized in bytes: it grows while queuing delay (smoothed RTT minus baseline RTT) is under 100 ms and shrinks by 30% (at most once per RTT) above 250 ms, with a hard in-flight cap and stall escape. Stream size is a pixel budget (`maxWidth` is a 16:9-equivalent width), so ultrawide and 4:3 screens get the same detail.
- **Latency vs congestion**: a long path (PC → tunnel → relay → tunnel → phone) has a high RTT without being congested. Every adaptive decision (agent window, relay quality) must use queuing delay above the baseline, never absolute RTT. A fixed small frame window would cap fps at window ÷ RTT.
- **Relay**: never forwards a v2 delta to a controller that is not in sync. That covers controllers just paired and ones skipped because `bufferedAmount` ≥ 512 KB, which are tracked in `entry.needsKey`; the relay asks the agent for a keyframe (throttled to 300 ms). Frames delivered to nobody are acked by the relay. A user `quality` input sets the adaptive ceiling, and the relay sends the agent the effective level.
- **Controller**: frames go to `FrameStore`/`HostFrameCompositor`, not React state. It decodes with `createImageBitmap`, applies in order, skips deltas while out of sync (and requests a keyframe on decode errors), and **acks only after drawing**. Thumbnails (`framesByHost`) are canvas snapshots every 2 s.
- Browser host mode still sends JSON `host:frame` data URLs, which the compositor treats as full frames.

If you add an input type, update `RemoteInputEvent` in `src/types/deskbridge.ts`, the native agent's input parser/worker in `agent/windows/`, and `applyVirtualInput` in `src/lib/virtualDesktop.ts` (browser host).

## Security invariants (do not break)

1. Every `/api/*` route except `/api/health` (reduced output when anonymous), `/api/auth/*`, and `POST /api/agent/enroll` (credentialed by one-time code, rate-limited) sits behind the session middleware in `server/relay.ts`. Add new routes **after** that middleware.
2. `client:*` WebSocket events are rejected unless the socket has an owner session (`isOwner`). Origin is checked for cookie-bearing sockets.
3. A host frame or host event is only accepted from the socket that registered that host (`entry.ws === ws`). Never trust `payload.hostId` or the binary header's `hostId` for routing.
4. Never send `secretHash` or the access token to clients, or include them in `HostProfile`. Never log enrollment codes, host secrets, or the access token (in either the relay or the agent).
5. Compare secrets with `safeEqual` / `verifySecret`, never with `===`.
6. Host secrets on Windows are encrypted with DPAPI (`CurrentUser`) under `%LOCALAPPDATA%\DeskBridge\`; never write them in plain text or the registry.
7. Every `ws` connection must have an `error` listener; without one, a malformed or oversized frame crashes the relay.
8. Client code calls the API through `apiFetch` so expired sessions return the user to the login screen.

## Conventions

- TypeScript (tsconfig has no `strict` flag; write code as if it did), ES modules. Server imports of local TS files use the `.js` extension (`./server/auth.js`).
- React 19 function components with hooks, Tailwind v4 utility classes, `lucide-react` icons, and dark mode via the `dark` class on `<html>`.
- Mobile-first UI: touch targets ≥ 40–44px, and test at phone width (~390px).
- Keep components presentational where possible. Put logic that can run without the DOM in `src/lib/` and unit-test it.
- Native agent host app: a WinForms tray app (`WinExe`, no console). `Program.Main` is `[STAThread]` and sync: the UI thread runs `TrayApp` and the enrollment window, `AgentSupervisor` (Core, unit-tested through `IAgentHost`) runs on the thread pool and owns enroll, run, pause/resume, re-enroll and the 4403 revoke flow. `AgentHost` (App) is the Windows side. Tray status comes from `AgentStatusTracker`, fed by `StreamingEngine.ConnectionEvent`; the icon is grey (offline/paused), blue (online) or orange (controller connected), and a notification fires when the controller count goes from 0 to 1 or more. Log: `logs/agent.log` next to `agent.json` (1 MB, one `.1` rotation, `RollingFileLog`); never log secrets, and the pairing code is shown under About instead of logged. `--console` mirrors the log into the launching terminal. "Start with Windows" writes `HKCU\...\CurrentVersion\Run` (`Autostart`), on only when it points at the running exe.
- Native agent monitors: `DpiAwareness.EnablePerMonitorV2()` runs first in `Program.cs`, so `MonitorEnumerator` bounds, capture sizes and `SendInput` coordinates are all physical pixels. `SwitchableFrameSource` (Core) owns the monitor list and the per-monitor capture source. A wire monitor index is the position in `EnumDisplayMonitors` order. `monitor` input and display changes (lost duplication, re-register) are applied on the capture thread. The active monitor follows its device name across re-enumeration and falls back to the primary when it is gone. A swap returns `Lost`, so the next frame is a keyframe, and the agent sends `host:update`. Input maps onto `SwitchableFrameSource.Active`, which can have a negative origin.
- Native agent builds: `DeskBridge.Agent.Windows` targets `net10.0-windows10.0.17763.0`. Namespace `DeskBridge.Agent.Windows.Encoding` shadows `System.Text.Encoding` (alias it when needed). `libjpeg-turbo` (`turbojpeg.dll`) is vendored with a pinned SHA-256.
- Gemini model ids live in `server/aiAssistant.ts` with env overrides `GEMINI_MODEL` and `GEMINI_TRANSCRIBE_MODEL`. The Gemini key is only read server-side.
- Don't commit build output (`dist/`), runtime state files, or a second lockfile.

## Reliability notes

- **Heartbeat**: the relay pings every socket each `DESKBRIDGE_HEARTBEAT_MS` and terminates any socket that missed the previous pong. Terminating marks a host offline.
- **Gemini fallbacks**: each candidate model is tried in turn. If all fail, the route returns 502 listing every model's error. If a fallback succeeded, the response `warning` names the models that failed. A missing key returns 503.

## Known gaps / roadmap

- Streaming is still JPEG (tiled). A real video codec (H.264 via Media Foundation + WebCodecs, #19) would cut bandwidth much further for full-screen motion such as video or scrolling.
- The relay's backlog-skip path (`bufferedAmount`) is not covered by tests, because it needs a deliberately slow socket.
- There are no UI tests.
- `Win+L` is mapped to `LockWorkStation()`, and `Ctrl+Alt+Del` cannot be injected at all (secure attention sequence). A locked PC can't be unlocked remotely: the PIN box is on the secure desktop (#10). The client confirms every locking input (`isLockingInput` in `src/lib/remoteInput.ts`, checked in `sendRemoteInput`). The native agent's opt-in `keepAwake` in `agent.json` (off by default; set with `--keep-awake on|off` for the next start, or live from the tray's "Keep PC awake") holds a power request (system and display required, thread-independent) and nudges the idle timer every 50 s for as long as the agent runs (connected or not, so the PC is still awake and unlocked when a controller reconnects).
- An agent running unelevated cannot send input to elevated windows (UIPI).
