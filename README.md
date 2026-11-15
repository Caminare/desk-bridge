# DeskBridge

DeskBridge is a full-stack remote desktop and AI command platform built to let you register, organize, and control **multiple Windows computers** from your Android phone or web browser.

Each Windows computer runs a lightweight host agent that exposes its desktop over a WebSocket relay (TLS-encrypted when served over HTTPS) and generates a scannable QR code / 6-character pairing code. From your phone, you can pair any number of named Windows machines, switch between them in one tap, control them using an ergonomic touch trackpad or direct screen taps, and issue voice or text commands powered by **Gemini**.

---

## Key Capabilities

- **Unlimited Named Computers**: Add as many Windows PCs as you need, assign custom computer names and group/location labels (e.g., `Office`, `Home`, `Studio`, `Lab`), rename them anytime, and filter your fleet dynamically.
- **Instant QR & Code Pairing**: Scan the host QR code with your phone camera, upload a QR screenshot, open a pairing link, or enter the 6-character pairing code.
- **Touch-First Remote Control Deck**:
  - **Trackpad Mode**: Laptop-style thumb trackpad with adjustable pointer speed, tap-to-click, dedicated Left/Right Click buttons, and vertical scroll controls.
  - **Direct Tap Screen Mode**: Tap or double-tap directly on the streamed Windows desktop with 1.5× zoom support.
  - **Keyboard & Windows Shortcuts**: Send any text, including accents, CJK and emoji, from your mobile keyboard (buffered or live keystrokes). The toolbar has quick shortcuts (`Win+D`, `Alt+Tab`, copy/paste/undo, `Win+E`, `Alt+F4`, Task Manager, `Win+L`). The keyboard drawer adds sticky **Ctrl / Alt / Shift / Win** modifiers, F1–F12 and navigation keys, and a field for sending any combo (e.g. `Ctrl+Shift+T`).
  - **Multi-Monitor**: hosts with several displays show a monitor picker in the Control Deck and the fullscreen toolbar. The agent's `-MonitorIndex` parameter picks the starting display.
- **Gemini Voice & Text Assistant**:
  - Record voice commands (`gemini-3.5-transcribe`) or type natural instructions (`gemini-4-hydrogen` in Fast or Deep Reason mode).
  - Screen-aware multimodal vision inspects the active computer's live frame to locate UI elements or summarize what is on screen.
  - Translates commands into structured desktop actions (`open_application`, `type_text`, `press_hotkey`, `move_and_click`, `scroll_screen`, `run_shell_command`, `switch_workstation`, `lock_workstation`) with optional spoken confirmation (`gemini-3.8-flash-lite-tts`).

---

## Security Model

DeskBridge gives full keyboard, mouse and PowerShell control of every enrolled PC, so the relay is locked down:

- **Owner login**: the controller UI, all `/api/*` routes (except `/api/health` and `/api/auth/*`) and every controller WebSocket action require a signed, HttpOnly session cookie. You get it by signing in with the **owner access token**, which comes from `DESKBRIDGE_ACCESS_TOKEN` (min 16 chars). If that is unset, a random token is generated on first start, saved to `.deskbridge-auth.json` and printed to the server console. Changing the token signs out every session.
- **Agent enrollment**: downloading a host agent requires login, and each script embeds the server's **enrollment key**. **Treat downloaded agent scripts as secrets.** On first registration, the relay gives each host its own **host secret** (stored in `%APPDATA%\DeskBridge-host-secret.txt` or `~/.deskbridge-host.json`). After that, only the holder of that secret (or the logged-in owner's browser host) can register with that host id. To re-enroll a machine, delete it in the Fleet tab.
- **Frame integrity**: screen frames are always attributed to the socket that registered the host. A host cannot inject frames into another host's stream.
- **Cross-origin protection**: session cookies are `SameSite=Lax`, and WebSocket sessions from a foreign `Origin` are treated as anonymous.
- **Limits**: WebSocket messages are capped at 8 MB, failed logins are rate-limited, and AI requests are limited per session (`AI_RATE_LIMIT_PER_MIN`, default 20).
- **Liveness**: the relay pings every connection (`DESKBRIDGE_HEARTBEAT_MS`, default 15 s) and drops unresponsive ones, so a dead PC shows as offline within about two intervals.
- **Pairing codes** are now only a convenient way to find a host. They are not credentials, because pairing requires an owner session.
- **Not end-to-end encrypted**: TLS (via ngrok/HTTPS) protects each device↔relay hop, but the relay itself sees frames and keystrokes. Run it on a machine you trust.

Runtime state files `.deskbridge-auth.json` and `.deskbridge-hosts.json` hold secrets. They are created with `0600` permissions and are git-ignored.

> **Upgrading from an older version**: previously downloaded agent scripts have no enrollment key and will be rejected. Re-download `DeskBridge-Host.ps1` / `deskbridge-host.mjs` from the Windows Host tab on each PC.

---

## Architecture & How It Works

DeskBridge uses a three-part real-time architecture connected through a central Express + WebSocket relay server on port `3000`:

```
+----------------------------+          WSS (/ws)          +----------------------------+
|   Windows Host Agent(s)    | --------------------------> |   DeskBridge Relay Server  |
|  (PC #1, PC #2, ... PC #N) | <-------------------------- |   Express + WebSocket      |
|                            |   JPEG frames & telemetry   |   + Gemini AI Orchestrator |
|  - DeskBridge-Host.ps1     |   Win32 mouse/key/shell     +----------------------------+
|  - or Browser Host Mode    |                                       ^          |
+----------------------------+                                       |          | WSS (/ws)
                                                                     |          v
                                                           +----------------------------+
                                                           |  Android / Web Controller  |
                                                           |  (React + Vite PWA)        |
                                                           |                            |
                                                           |  - Fleet & QR Scanner      |
                                                           |  - Trackpad & Keyboard     |
                                                           |  - Gemini Voice & Chat     |
                                                           +----------------------------+
```

### 1. Relay Server (`server.ts` → `server/relay.ts`)
- Runs an Express HTTP server and attaches a `ws` WebSocket server at `/ws`.
- Maintains paired workstation profiles in `.deskbridge-hosts.json` alongside live WebSocket room mappings (`hosts` registry).
- Routes `host:register` and `host:frame` events from connected Windows PCs to authorized controllers, and forwards `client:input` events (`mousemove`, `click`, `scroll`, `type`, `key`, `hotkey`, `launch`, `shell`, `clipboard`) directly to the target host.
- Exposes REST endpoints for QR image generation (`/api/qr`), dynamic Windows agent script downloads (`/api/host-agent/download`), pairing code lookup (`/api/hosts/pair-code`), workstation renaming (`PATCH /api/hosts/:hostId`), and server-side Gemini AI execution (`/api/ai/command`, `/api/ai/voice-command`).

### 2. Windows Host Agent (`server/windowsAgentGenerator.ts` & `WindowsHostView.tsx`)
- **Native Windows 10/11 Agent (`DeskBridge-Host.ps1` + `Start-DeskBridge.bat`)**: Pure PowerShell + `.NET` (`System.Drawing`, `System.Windows.Forms`, `System.Net.WebSockets.ClientWebSocket`, and inline Win32 `user32.dll` P/Invoke) requiring zero external runtimes. Captures scaled JPEG desktop frames via GDI+, prints a 6-character pairing code/URL, and executes real cursor movement (`SetCursorPos`), clicks (`mouse_event`), keystrokes (`SendKeys`), shortcuts, app launches (`Start-Process`), and PowerShell commands.
- **Node.js Host Script (`deskbridge-host.mjs`)**: Minimal Node 22+ agent that handles `launch` and `shell` commands only (no screen streaming).
- **Browser Host Mode**: Built-in WebSocket host supporting either `getDisplayMedia` screen capture or an interactive HTML5 Windows desktop canvas with a live scannable QR code for immediate testing.

### 3. Android / Mobile Controller (`src/`)
- Built as a responsive, thumb-ergonomic React + Vite Progressive Web App (`public/manifest.webmanifest`) so it can be installed directly onto Android home screens.
- Uses `jsqr` for real-time camera QR decoding and screenshot QR decoding, `MediaRecorder` for mobile voice capture, and pointer-capture gestures for smooth trackpad control.

### 4. Gemini AI Orchestrator (`server/aiAssistant.ts`)
- Runs exclusively on the server using `@google/genai` and `process.env.GEMINI_API_KEY`.
- Combines voice transcription (`gemini-3.5-transcribe`), computer-control function calling + screen vision (`gemini-4-hydrogen`), and optional TTS audio responses (`gemini-3.8-flash-lite-tts`).

---

## Running the Server Locally

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Configure environment variables**:
   Create a `.env` file (see `.env.example`):
   ```env
   GEMINI_API_KEY="your_gemini_api_key"
   APP_URL="https://your-public-or-tunnel-url"
   DESKBRIDGE_ACCESS_TOKEN="a-long-random-string"   # optional; generated if omitted
   ```
3. **Start the development server** (runs Express, WebSockets, and Vite middleware on port `3000`):
   ```bash
   npm run dev
   ```
4. **Run the checks** (type-check, tests, build; the same as CI):
   ```bash
   npm run check
   ```
5. **Or build and run for production**:
   ```bash
   npm run build
   npm start
   ```

---

## Exposing DeskBridge Over the Internet with ngrok (Step-by-Step)

You only need **one** DeskBridge server + **one** ngrok tunnel to control **all** of your Windows computers from a **single URL** on your Android phone.

### Do I need a different URL on my phone for each Windows PC?
**No.** DeskBridge uses a **hub-and-spoke relay** model:
- **Only ONE machine** (your main always-on PC, home server, or laptop) runs the DeskBridge server (`npm run dev` / `npm start`) and `ngrok http 3000`. That gives you **one single HTTPS URL** (for example, `https://your-name.ngrok-free.app`).
- **All of your other Windows PCs (PC #1, PC #2, PC #3, ... PC #N)** do **not** run their own server and do **not** install ngrok. They only run the lightweight `DeskBridge-Host.ps1` script, which makes an outbound `wss://` connection to that one central ngrok URL.
- **On your mobile phone**, you only ever open **that single URL** (`https://your-name.ngrok-free.app`). Every paired PC appears inside the **Fleet** tab and the **Control Deck** top switcher, so you can jump between computers with one tap.

> **Why ngrok helps on Android**: Android Chrome requires `HTTPS` to allow camera access (live QR scanner) and microphone access (Gemini voice commands). ngrok provides an instant `HTTPS` + `WSS` tunnel automatically.

### Step 1: Start the DeskBridge Relay Server (on ONE Hub Machine)
1. On the computer that will stay powered on as your relay hub, configure `.env`:
   ```env
   GEMINI_API_KEY="your_gemini_api_key"
   ```
2. Start DeskBridge:
   ```bash
   npm install
   npm run dev
   ```
   Confirm it prints: `DeskBridge server listening on http://0.0.0.0:3000`, followed by your **owner access token** (unless you set `DESKBRIDGE_ACCESS_TOKEN`). Keep it handy: you will sign in with it on each device.

### Step 2: Start ngrok (on That Same Hub Machine)
1. Install ngrok from [ngrok.com/download](https://ngrok.com/download) and authenticate once:
   ```bash
   ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
   ```
2. Open a second terminal and tunnel port `3000`:
   ```bash
   ngrok http 3000
   ```
   *(Tip: On ngrok's free tier you can also claim one free **static domain** in the ngrok dashboard and run `ngrok http --url=your-static-name.ngrok-free.app 3000` so your phone URL and Windows host scripts never change after restarts.)*
3. Copy the **Forwarding** HTTPS URL shown by ngrok, e.g.:
   ```
   https://a1b2-203-0-113-5.ngrok-free.app
   ```

### Step 3: Point `APP_URL` to Your ngrok URL
1. Stop DeskBridge (`Ctrl+C`), update `.env` on your hub machine with your ngrok URL (no trailing slash):
   ```env
   GEMINI_API_KEY="your_gemini_api_key"
   APP_URL="https://a1b2-203-0-113-5.ngrok-free.app"
   ```
2. Start DeskBridge again (`npm run dev` or `npm run build && npm start`).
   - Now, whenever you download `DeskBridge-Host.ps1` for any PC, DeskBridge automatically embeds `wss://a1b2-203-0-113-5.ngrok-free.app/ws` inside the script, and every QR code points to your public HTTPS URL.

### Step 4: Connect All of Your Windows PCs (PC #1, PC #2, ... PC #N)
Repeat these steps on each Windows 10/11 computer you want to control (whether on your home Wi-Fi or a completely different network/office):

1. Open your ngrok URL (`https://a1b2-203-0-113-5.ngrok-free.app`) in a browser, sign in with the owner access token, and go to the **Windows Host** tab.
2. Enter a unique **Computer Name** (e.g., `Home-Desktop`, `Office-Laptop`, `Build-Server`) and **Group / Location Label** (e.g., `Home`, `Office`, `Studio`).
3. Download **`DeskBridge-Host.ps1`** and **`Start-DeskBridge.bat`** into the same folder on that Windows PC.
4. Double-click **`Start-DeskBridge.bat`** (or run `powershell -ExecutionPolicy Bypass -File .\DeskBridge-Host.ps1`).
5. The terminal will connect outbound to your single ngrok relay (`wss://.../ws`) and print `ONLINE & READY TO PAIR` along with that PC's **6-character pairing code** and **pair link**.
6. *(Optional Browser Testing)*: You can also click **Start Host & Generate QR** directly inside the **Windows Host** tab to generate a scannable QR code immediately using real screen sharing or the interactive Windows canvas.

### Step 5: Open That Single URL on Your Android Phone
DeskBridge is packaged as an installable **Progressive Web App (PWA)** optimized for Android touch ergonomics:

1. Open **Google Chrome** on your Android phone and go to your **one** ngrok URL (e.g., `https://a1b2-203-0-113-5.ngrok-free.app`).
   - If ngrok displays its one-time *"You are about to visit..."* banner, tap **Visit Site**.
   - Sign in with your owner access token. The session lasts 30 days.
2. Tap the Chrome menu (**⋮**) and select **Install app** or **Add to Home screen** so DeskBridge launches full-screen like a native Android app.
3. Pair each Windows PC once by tapping **Scan QR** in the top bar:
   - Point your phone camera at the QR code, **or**
   - Tap **Enter Code** and type the 6-character pairing code printed by `Start-DeskBridge.bat`, **or**
   - Upload a screenshot of the QR code.
4. Every paired computer now lives in your **Fleet** tab and in the top switcher bar of the **Control Deck** — no need to change URLs when switching PCs.
5. Use **Trackpad** / **Tap Screen**, the **Keyboard** drawer, or tap the **Mic** in **AI Voice / AI Assistant** to control any paired PC hands-free from anywhere.

