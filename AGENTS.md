# AGENTS.md

Guidance for AI coding agents (and humans) working on DeskBridge. Read this before making changes.

## What this project is

DeskBridge is a remote-desktop relay. A phone or browser controller sends mouse, keyboard and PowerShell commands through a central Node relay to Windows host agents, which stream JPEG frames back. A Gemini assistant turns natural-language and voice requests into the same input events.

**Source of truth:** the owner's Notion space "DeskBridge" holds the current state, capabilities, roadmap, specs and decisions. Read it before starting work (next task = lowest-Order Roadmap item not Done) and update it after each task. If it disagrees with this file about what is being built, Notion wins and this file gets updated.

**This software executes arbitrary commands on real machines.** Treat every change that touches authentication, message routing or the agent scripts as security-sensitive.

## Layout

| Path | Role |
| --- | --- |
| `server.ts` | Entry point: reads env and calls `createRelay()`. Keep it thin. |
| `server/relay.ts` | `createRelay(options)`: Express + `ws` relay (REST API, WebSocket routing, host registry, heartbeat, Vite middleware or static `dist/`). All state is per instance, so tests can run several relays. |
| `server/rateLimit.ts` | Sliding-window limiter (used for `/api/ai/*`). |
| `server/adaptiveStream.ts` | Adaptive stream quality: steps resolution/JPEG quality down when *queuing delay* (agent RTT above the path's baseline RTT) grows, back up when calm, capped by the user preset. |
| `src/lib/frameProtocol.ts` | Binary frame codec (v1 full JPEG, v2 tiled) shared by relay, client and tests. |
| `src/lib/frameCompositor.ts` | Per-host off-DOM canvas compositor: off-main-thread tile decode, in-order apply, keyframe resync, stats. |
| `server/auth.ts` | Owner access token, signed session cookies, enrollment key, per-host secrets, origin check, login rate limiter. |
| `server/aiAssistant.ts` | Gemini calls: transcription, function-calling (desktop actions), optional TTS. Server-side only. |
| `server/windowsAgentGenerator.ts` | Generates the PowerShell agent (`DeskBridge-Host.ps1`), `.bat` launcher and Node agent (`deskbridge-host.mjs`) as template strings. |
| `src/main.tsx` | Entry. Wraps `App` in `AuthGate` (login screen until an owner session exists). |
| `src/App.tsx` | Tab shell: Fleet, Control Deck, AI Assistant, Windows Host. |
| `src/hooks/useDeskBridgeSocket.ts` | Controller WebSocket client: fleet state, pairing, frame decoding, input sending. |
| `src/lib/auth.ts` | `apiFetch` (use it for all `/api` calls), login/logout, unauthorized event. |
| `src/components/` | UI. `TouchControlDeck.tsx` (gesture handling + layout) composes `controlDeck/*` (`StreamViewport`, `TrackpadPanel`, `KeyboardDrawer`, `FullscreenHud`, `HostChips`, `MobileAIDrawer`, `qualityPresets`). `WindowsHostView.tsx` (browser host mode) composes `hostView/*` (`PairingPanel`, `AgentDownloadCard`). Also `AIAssistantPanel.tsx`, `FleetView.tsx`, `QrScannerModal.tsx`, `LoginScreen.tsx`, `AuthGate.tsx`. |
| `src/components/LiveStreamCanvas.tsx` | Displays a host's composited canvas (rAF-coalesced, no React state per frame). |
| `src/lib/streamStatsRows.ts` | Label/value rows for `controlDeck/StreamStatsOverlay` (the strip adds the agent diagnostics; the fullscreen overlay stays compact). |
| `src/hooks/useCoalescedPointerInput.ts` | Batches relative mouse moves and absolute hover positions (16ms, latest wins) and scroll deltas (24ms) before sending. In Tap Screen mode a connected mouse moving with no button pressed moves the remote cursor (`queueMoveTo`). |
| `src/lib/activePointers.ts` | `registerPointerDown`: adds a pointer to a gesture map and drops fingers whose release was never seen (a new primary touch means no other finger is down). Without it a lost `pointerup` leaves a ghost finger and every one-finger touch becomes a pinch. |
| `src/lib/streamCoords.ts` | Pointer → normalized remote coordinates, accounting for `object-contain` letterboxing. |
| `src/lib/viewTransform.ts` | Zoom/pan view model (1–4×, zoom around a focal point, pan clamped to the letterboxed picture, CSS transform). `controlDeck/ZoomControls` and `controlDeck/ZoomMinimap` drive it; the viewport applies it as a `transform`, and click mapping keeps working because it measures the transformed canvas. Overlays drawn over the top of the stream (minimap, fullscreen stats) report their reach via `topInsetRef`, which becomes `topInset` so the top of the remote screen (browser tabs, title bars) can be panned out from under them. In the normal view the stats render as a strip below the stream, not over it. |
| `src/lib/virtualDesktop.ts` | Pure model + canvas drawing for the simulated desktop in browser host mode. |
| `src/types/deskbridge.ts` | Shared types between server and client (`HostProfile`, `RemoteInputEvent`, AI types). |
| `tests/` | `node:test` suites run through `tsx`: `relay.test.ts` (REST + WebSocket protocol, heartbeat, AI limits), `auth.test.ts`, `agentGenerator.test.ts`, `activePointers.test.ts`, `streamCoords.test.ts`, `streamStatsRows.test.ts`, `virtualDesktop.test.ts`. `helpers.ts` starts an in-process relay on a free port with a temp data dir. |
| `.github/workflows/ci.yml` | CI: `bun install --frozen-lockfile`, lint, test, build. |
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
| `HOST` | Bind address. Default `0.0.0.0`; the VPS setup uses `127.0.0.1` behind Caddy. |
| `TRUST_PROXY` | `1` to take the login-limiter client IP from the rightmost `X-Forwarded-For` entry. Only enable it behind a trusted proxy with the relay port not publicly reachable. |

## Wire protocol

All WebSocket traffic goes over `/ws`. JSON messages are `{ event, payload }`.

- **Host → relay**: `host:register` (needs `enrollKey`, plus `hostSecret` after first enrollment, unless the socket has an owner session; may include `monitors` and `activeMonitor`), `host:update` (screen size / monitor changes, validated by `sanitizeMonitors`), `host:frame` (JSON data-URL frame, browser host), `host:regenerate_code`.
- **Binary frames (host → relay → controllers)**: `0x44`, a version byte, a big-endian `uint16` header length, a UTF-8 JSON header, then the payload (see `src/lib/frameProtocol.ts`). The relay rewrites `hostId` to the socket's registered host.
  - **v1 (`0x01`)**: header `hostId`, `seq`, `activeWindow`, `timestamp`; payload is one full-frame JPEG. Used by older agents.
  - **v2 (`0x02`)**: also `w`, `h` (stream size), `key` (keyframe), `r` (flat `[x, y, w, h, byteLength]` per tile) and `stats` (agent `cap`/`enc` ms, capture method `cm`, `rtt` and baseline `brtt` ms, upload `kbps`, `q`, `mw`, changed/total tiles `ch`/`tt`, in-flight `inf`, send window `win` KB, sent fps `sfps`, plus diagnostics: scaling `sm`, smoothed capture ms per scaling `caps`/`capc`, diff `dif` and capture-cycle `tick` ms, per-second capture-thread rates `cfps`/`pfps`/`same`/`drop`/`rd`/`kf`, last keyframe reason `kr`, mailbox wait `age`, previous send `snd` ms, main-loop rate `lps`, keyframe requests `kreq`; all listed in `AgentFrameStats`). The payload is the tiles' JPEGs concatenated. Deltas only make sense on top of the previous frame.
- **Relay → host**: `host:registered` (may include a one-time `hostSecret`), `host:auth_error`, `host:controller_count`, `host:frame_ack` (`relay: true` when the relay acked a frame no controller received), `host:keyframe_request`, `client:input` (including relay-generated adaptive `quality`).
- **Controller → relay** (owner session required): `client:subscribe_fleet`, `client:pair`, `client:unpair`, `client:input`, `client:frame_ack`, `client:keyframe_request`.
- **Relay → controller**: `fleet:update`, `client:paired`, `client:pair_error`, `host:frame`, `host:status`, `auth:required`.
- **Close codes**: `4401` authentication failed, `4409` host replaced by a newer connection, `1009` message too big (limit 8 MB).

Input events (`RemoteInputEvent`): `mousemove`, `click`, `mousedown`/`mouseup`, `scroll`, `type` (any Unicode; `\n` = Enter), `key` (`key` plus optional `modifiers`), `hotkey` (combo string such as `Ctrl+Shift+T`), `launch`, `shell`, `clipboard`, `quality`, `monitor`.

### Streaming pipeline (keep these properties when changing it)

- **Agent**: `DeskBridgeStreamer` (C#, background thread) captures, scales and diffs 64×64 tiles against the last frame *handed to the sender*, then JPEG-encodes changed tiles merged into rectangles (horizontal runs, then identical runs on consecutive rows). Capture is one GDI `StretchBlt` from the screen DC into a top-down 24-bit DIB section that a GDI+ `Bitmap` wraps for encoding, so there's no full-resolution copy, no GDI+ resample and no `LockBits`. If any step fails, the agent switches for good to the `CopyFromScreen` + GDI+ path (`AllowFastCapture = false`); the method is reported as stats `cm`. Downscaling follows `-ScaleMode` (`auto` default, `halftone`, `fast`): HALFTONE averages every source pixel (sharp text, CPU-heavy on large screens), COLORONCOLOR drops pixels (much cheaper). In `auto`, two consecutive captures with ≥15% of tiles changed switch to COLORONCOLOR until 500 ms of calm, then back to HALFTONE (one refining keyframe). Only diffs against a reference scaled the same way count as motion, otherwise the switch itself would look like motion and flip-flop. `auto` also scales coarsely within 500 ms of any input, but only when the smoothed HALFTONE capture costs over 20 ms on that PC, so a click doesn't wait for a full HALFTONE pass. Capture runs every 33 ms while there is input *or* the screen changed in the last 500 ms, otherwise every `-FrameIntervalMs`. The capture thread waits on an `AutoResetEvent`, not a blind sleep: input wakes it for a capture 15 ms later (time for the app to repaint, at most one capture per 16 ms), and keyframe requests or monitor switches wake it immediately. The agent turns Nagle off (`ServicePointManager.UseNagleAlgorithm = $false`, before connecting) so a frame's last packet isn't held back. A keyframe is sent on request, after a resize or monitor switch, or when more than 50% changed. A single-slot mailbox holds the freshest unsent frame, and a generation counter discards frames diffed against an outdated reference. The PowerShell loop only applies input, paces and sends asynchronously. The send window is sized in bytes: it grows while queuing delay (smoothed RTT minus the baseline, the minimum RTT over rolling 15 s windows) is under 100 ms and shrinks by 30% (at most once per RTT) above 250 ms. There's a hard cap of `-MaxInFlight` frames (default 32) and a stall escape of max(1.5 s, 3×RTT). Stream size is a pixel budget (`maxWidth` is a 16:9-equivalent width), so ultrawide and 4:3 screens get the same detail.
- **Latency vs congestion**: a long path (PC → tunnel → relay → tunnel → phone) has a high RTT without being congested. Every adaptive decision (agent window, relay quality) must use queuing delay above the baseline, never absolute RTT. A fixed small frame window would cap fps at window ÷ RTT.
- **Relay**: never forwards a v2 delta to a controller that is not in sync. That covers controllers just paired and ones skipped because `bufferedAmount` ≥ 512 KB, which are tracked in `entry.needsKey`; the relay asks the agent for a keyframe (throttled to 300 ms). Frames delivered to nobody are acked by the relay. A user `quality` input sets the adaptive ceiling, and the relay sends the agent the effective level.
- **Controller**: frames go to `FrameStore`/`HostFrameCompositor`, not React state. It decodes with `createImageBitmap`, applies in order, skips deltas while out of sync (and requests a keyframe on decode errors), and **acks only after drawing**. Thumbnails (`framesByHost`) are canvas snapshots every 2 s. The AI assistant gets a fresh `toDataUrl()` screenshot.
- Browser host mode still sends JSON `host:frame` data URLs, which the compositor treats as full frames.

If you add an input type, update `RemoteInputEvent` in `src/types/deskbridge.ts`, the PowerShell `Handle-RemoteInput` switch, `applyVirtualInput` in `src/lib/virtualDesktop.ts` (browser host), and (if relevant) the Gemini tool declarations.

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
- Keep components presentational where possible. Put logic that can run without the DOM in `src/lib/` and unit-test it.
- Keep the PowerShell agent dependency-free (PowerShell 5.1 + .NET Framework only). It is generated from a JS template literal: escape `` ` ``, `${` and backslashes accordingly. In the inline C# (`Add-Type`), avoid backslashes entirely (use `(char)10`, not `'\n'`), and stick to C# 5 syntax (no `$"..."` interpolation), because Windows PowerShell 5.1 compiles it with the .NET Framework compiler.
- Keyboard input goes through `SendInput` (`[DeskBridgeWin32]::TypeUnicode` / `SendCombo`) and `Send-KeyCombo`. Add new key names to `$script:VkMap`, and don't reintroduce `SendKeys`.
- Script-level agent state that functions change must be assigned through `$script:` (e.g. `Select-Monitor` swaps `$script:bounds`, `$script:capBmp`).
- The agent runs **per-monitor DPI aware** (`[DeskBridgeWin32]::EnablePerMonitorDpi()`: process-level PMv2, else thread-level, else system DPI). The capture thread sets the same thread context. Without it, a monitor whose scaling differs from the primary is reported with scaled bounds, and its stream comes out cropped or as a small "miniature". The call must stay **before the first `[System.Windows.Forms.Screen]` use**, because .NET caches monitor bounds.
- `tests/agentGenerator.test.ts` only checks the generated script's structure. **Any agent change must also be run on a real Windows 10/11 machine**, because CI cannot run PowerShell or compile the C#.
- Gemini model ids live in `server/aiAssistant.ts` with env overrides `GEMINI_MODEL` and `GEMINI_TRANSCRIBE_MODEL`. The Gemini key is only read server-side.
- Don't commit build output (`dist/`), runtime state files, or a second lockfile.

## Reliability notes

- **Heartbeat**: the relay pings every socket each `DESKBRIDGE_HEARTBEAT_MS` and terminates any socket that missed the previous pong. Terminating marks a host offline. The PowerShell agent also sends keep-alive pongs.
- **Gemini fallbacks**: each candidate model is tried in turn. If all fail, the route returns 502 listing every model's error. If a fallback succeeded, the response `warning` names the models that failed. A missing key returns 503.

## Known gaps / roadmap

- Streaming is still JPEG (tiled). A real video codec (H.264 via WebRTC, or a native encoder in the agent) would cut bandwidth much further for full-screen motion such as video or scrolling.
- The relay's backlog-skip path (`bufferedAmount`) is not covered by tests, because it needs a deliberately slow socket.
- There are no UI tests, and the PowerShell agent has no automated runtime tests (no Windows runner).
- `Win+L` is mapped to `LockWorkStation()`, and `Ctrl+Alt+Del` cannot be injected at all (secure attention sequence). A locked PC can't be unlocked remotely: the PIN box is on the secure desktop (#10). The client confirms every locking input (`isLockingInput` in `src/lib/remoteInput.ts`, checked in `sendRemoteInput`). The agent's opt-in `-KeepAwake` (download option `keepAwake=1`) calls `SetThreadExecutionState` and nudges the idle timer every 50 s while a controller is connected.
- An agent running unelevated cannot send input to elevated windows (UIPI).
