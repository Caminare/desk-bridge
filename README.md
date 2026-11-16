# DeskBridge

DeskBridge is a full-stack remote desktop and AI command platform built to let you register, organize, and control **multiple Windows computers** from your Android phone or web browser.

Each Windows computer runs a lightweight host agent that exposes its desktop over a WebSocket relay (TLS-encrypted when served over HTTPS) and generates a scannable QR code / 6-character pairing code. From your phone, you can pair any number of named Windows machines, switch between them in one tap, control them using an ergonomic touch trackpad or direct screen taps, and issue voice or text commands powered by **Gemini**.

---

## Key Capabilities

- **Unlimited Named Computers**: Add as many Windows PCs as you need, assign custom computer names and group/location labels (e.g., `Office`, `Home`, `Studio`, `Lab`), rename them anytime, and filter your fleet dynamically.
- **Instant QR & Code Pairing**: Scan the host QR code with your phone camera, upload a QR screenshot, open a pairing link, or enter the 6-character pairing code.
- **Touch-First Remote Control Deck**:
  - **Trackpad Mode**: Laptop-style thumb trackpad with adjustable pointer speed, tap-to-click, dedicated Left/Right Click buttons, and vertical scroll controls.
  - **Direct Tap Screen Mode**: Tap or double-tap directly on the streamed Windows desktop.
  - **Zoom & Pan**: Zoom from 1× to 4× with the − / + buttons (tap the level to reset), by pinching (tap mode), or with Ctrl + mouse wheel. While zoomed, drag with one finger (tap mode) or use the overview minimap (any mode) to move anywhere on the screen. Taps still land exactly where you tap.
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

## Streaming Performance

DeskBridge is built for controlling PCs over the internet, so it keeps the stream small and adapts to the link:

- **Only changed screen areas are sent.** The agent compares 64×64 tiles and sends the changed regions merged into rectangles (a playing video becomes one JPEG); an idle desktop costs almost nothing, typing sends a few small tiles.
- **Fast capture.** The screen is grabbed and scaled in a single Windows GDI call, and capture runs at full rate whenever the screen is changing (video, scrolling), not only while you touch the controls. If that call fails on a PC, the agent falls back to the older capture method automatically; the stats panel shows which one is active (`fast` or `gdi+`).
- **Capture and sending run in parallel** with input handling, so the mouse stays responsive even while a frame is uploading.
- **Adaptive quality and pacing.** The agent and relay watch the frame round trip (PC upload → relay → phone → back) and compare it with the path's normal latency. Only *extra* delay, meaning frames queuing up, lowers resolution/JPEG quality or shrinks the send window. A distant but uncongested connection keeps full quality and frame rate. The SD/HD/Ultra selector sets the maximum (as a pixel budget, so ultrawide screens get the same detail).
- **Smooth on phones.** Frames are drawn straight onto a canvas (decoded off the main thread) and acknowledged only after they are on screen.

Tap the **pulse icon** in the Control Deck or fullscreen toolbar to see live stats: FPS, download/upload rate, round trip and queuing delay, send window, capture/encode/decode times, current quality and changed tiles. A high round trip with low **Queue** is just distance and is handled fine. A growing **Queue** with upload near your PC's upload speed means the connection is the bottleneck. A high **Capture** time means the PC is slow at grabbing the screen. Where the relay runs matters too: every frame goes PC → relay → phone, so a relay on a well-connected server near your users is faster than one at home behind a tunnel.

Agent tuning parameters (`DeskBridge-Host.ps1 -Name value`): `-MaxStreamWidth` / `-JpegQuality` (starting quality), `-FrameIntervalMs` (idle capture interval, default 100), `-MaxInFlight` (hard cap on unacknowledged frames, default 32; the real window adapts automatically).

---

## Deploying on a VPS (recommended)

Running the relay on a small Linux VPS near you gives the lowest latency and no tunnel limits: each frame goes PC → VPS → phone. A 1 vCPU / 1 GB plan (about $5/month) is enough. The steps below use [Vultr](https://www.vultr.com) as the example, but any provider with Ubuntu works the same.

### 1. Create the server

1. **Create an SSH key** on your computer if you don't have one (Git Bash, macOS or Linux terminal):
   ```bash
   ssh-keygen -t ed25519
   ```
   Your **public** key is `~/.ssh/id_ed25519.pub`; that's the one you give to the provider. If you only have a private key, print its public key with `ssh-keygen -y -f ~/.ssh/id_rsa`. Never upload the private key.
2. **Deploy a server** in your provider's panel:
   - **Location:** the region closest to you and your PCs.
   - **Image:** Ubuntu 24.04 LTS.
   - **Plan:** the cheapest plan **with IPv4** (1 vCPU / 1 GB). Avoid "IPv6 only" plans.
   - **SSH key:** add your public key and select it.
   - **Extras:** no backups, VPC, startup script or DDoS add-on needed.
3. **Firewall:** in the provider's firewall (Vultr: *Network → Firewall*), allow inbound **TCP 22, 80 and 443** from anywhere, and attach it to the server. Use *Anywhere* for SSH rather than *My IP*: home and mobile IPs change, which would lock you out.
4. **Domain:** HTTPS is required (the phone's camera and microphone only work over HTTPS). Create a free subdomain at [duckdns.org](https://www.duckdns.org) (e.g. `yourname.duckdns.org`) and set it to the server's **IPv4 address**.

### 2. Install DeskBridge

Connect to the server:
```bash
ssh root@YOUR_SERVER_IP
```
Download and run the setup script, using your domain:
```bash
curl -fsSL https://raw.githubusercontent.com/Caminare/desk-bridge/main/deploy/setup-ubuntu.sh -o setup.sh
```
```bash
bash setup.sh --domain yourname.duckdns.org
```

The script takes 3–6 minutes on a small server. On a brand-new server it may first wait a few minutes for Ubuntu's automatic updates to finish. It:
- installs Node.js 22, Caddy (automatic HTTPS certificates), the `ufw` firewall and a 2 GB swap file;
- downloads and builds DeskBridge into `/opt/deskbridge/app`;
- writes the settings file `/etc/deskbridge.env` with a generated **access token**;
- runs DeskBridge as the `deskbridge` system service, **started automatically at boot**;
- prints the access token at the end. **Save it**; you sign in with it.

To deploy a branch other than `main`, add `--branch NAME`. Re-running the script is safe: it keeps your token and paired PCs.

### 3. First use

1. On your phone, open `https://yourname.duckdns.org` and sign in with the access token.
2. On each Windows PC, open the same address, go to **Windows Host**, download **`DeskBridge-Host.ps1`** (and `Start-DeskBridge.bat`) **again**, and start it. Agents downloaded from another address (e.g. an old ngrok URL) won't connect.
3. Pair each PC from the phone (Scan QR or pairing code).

### Settings (token, Gemini, address)

All settings live in `/etc/deskbridge.env` on the server:
```bash
nano /etc/deskbridge.env
```
- **Gemini assistant:** set `GEMINI_API_KEY=your_key` (remove the leading `#`). Get a key at [Google AI Studio](https://aistudio.google.com).
- **Your own access token:** change `DESKBRIDGE_ACCESS_TOKEN=` (at least 16 characters). This signs out every phone and browser.
- **Show the current token:** `grep DESKBRIDGE_ACCESS_TOKEN /etc/deskbridge.env`
- `APP_URL` is set from `--domain`. To change the domain, re-run the setup script with the new `--domain`, then re-download the agent on each PC.

Save (in nano: `Ctrl+O`, Enter, `Ctrl+X`) and restart to apply:
```bash
systemctl restart deskbridge
```

### Updating to a new version

```bash
bash /opt/deskbridge/app/deploy/update.sh
```
This fetches the latest code from the branch you deployed, rebuilds and restarts. Your settings and paired PCs are kept. Use `--branch NAME` to switch branches. If the release changed the Windows agent, re-download `DeskBridge-Host.ps1` on each PC.

### Starting, stopping and checking the service

| Task | Command |
|---|---|
| Status (should say `active (running)`) | `systemctl status deskbridge --no-pager` |
| Stop | `systemctl stop deskbridge` |
| Start | `systemctl start deskbridge` |
| Restart (after changing settings) | `systemctl restart deskbridge` |
| Live logs (`Ctrl+C` to exit) | `journalctl -u deskbridge -f` |
| Last 100 log lines | `journalctl -u deskbridge -n 100 --no-pager` |
| Don't start at boot / start at boot again | `systemctl disable deskbridge` / `systemctl enable deskbridge` |
| HTTPS proxy status | `systemctl status caddy --no-pager` |

### Stopping and starting the VPS

- **Nothing to do after a restart.** DeskBridge and Caddy are system services that start automatically when the server boots. Start the VPS in your provider's panel, wait about a minute, and open your address again. Windows agents that were left running reconnect by themselves every few seconds; otherwise start them again on the PC.
- **The IP address stays the same** across stop/start on most providers (including Vultr), so the DuckDNS domain keeps working. If your provider ever assigns a new IP, update it at duckdns.org.
- **Billing:** on Vultr (and most providers), **a stopped server is still billed**. Only *Destroy* stops the charges, and destroying deletes the server: you would have to run the setup again and re-pair your PCs.

### Backups

Everything DeskBridge needs to survive a rebuild is the settings file and the state folder (enrollment key, paired PCs):
```bash
tar czf deskbridge-backup.tgz /etc/deskbridge.env /var/lib/deskbridge
```
Copy it to your computer (run this on your computer, not the server):
```bash
scp root@YOUR_SERVER_IP:deskbridge-backup.tgz .
```
To restore on a new server, run the setup script first, copy the backup over, then on the server:
```bash
tar xzf deskbridge-backup.tgz -C /
```
```bash
chown -R deskbridge:deskbridge /var/lib/deskbridge && chown root:deskbridge /etc/deskbridge.env
```
```bash
systemctl restart deskbridge
```

### Troubleshooting

- **SSH hangs or times out after adding a firewall:** the provider's firewall is missing an *accept TCP 22 from Anywhere* rule (IPv4), or it uses *My IP* and your IP changed. Vultr's *View Console* gives browser access regardless of the firewall.
- **`Could not get lock /var/lib/dpkg/lock-frontend`:** automatic updates are running on a new server. Wait a few minutes and run the setup again. Never delete the lock file.
- **The site doesn't load or shows a certificate error:** make sure the domain points at the server's IPv4 address (`ping yourname.duckdns.org`) and ports 80/443 are open, then check `journalctl -u caddy -n 50 --no-pager`.
- **Login works but PCs don't appear:** re-download the agent from the new address, and check `journalctl -u deskbridge -f` while the agent starts.

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

