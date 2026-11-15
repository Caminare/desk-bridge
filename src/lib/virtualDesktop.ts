import type { RemoteInputEvent } from '../types/deskbridge';

/**
 * Simulated Windows desktop used by Browser Host Mode when screen capture is not
 * used. Pure state + drawing helpers so the input behaviour can be unit-tested.
 */

export const VIRTUAL_W = 960;
export const VIRTUAL_H = 540;
const W = VIRTUAL_W;
const H = VIRTUAL_H;

export interface VirtualWindow {
  id: string;
  title: string;
  app: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string[];
  minimized?: boolean;
}

export interface VirtualDesktopState {
  cursorX: number;
  cursorY: number;
  locked: boolean;
  startMenuOpen: boolean;
  focusedId: string;
  windows: VirtualWindow[];
}

export function createVirtualDesktopState(): VirtualDesktopState {
  return {
  cursorX: 480,
  cursorY: 270,
  locked: false,
  startMenuOpen: false,
  focusedId: 'outlook',
  windows: [
    {
      id: 'outlook',
      title: 'Outlook — Client Updates',
      app: 'outlook',
      x: 70,
      y: 52,
      w: 440,
      h: 270,
      content: [
        'Inbox · Primary Account',
        '----------------------------------------',
        'From: Sarah Chen <schen@clientops.io>',
        'Subject: Q4 Deployment Checklist',
        '',
        'Hi! Can you confirm once the staging build',
        'is pushed before 2:00 PM?',
        '',
        'Draft Reply: ',
      ],
    },
    {
      id: 'terminal',
      title: 'Windows PowerShell',
      app: 'powershell',
      x: 540,
      y: 88,
      w: 360,
      h: 240,
      content: [
        'PS C:\\Projects\\ClientApp> git status',
        'On branch main — clean working tree',
        'PS C:\\Projects\\ClientApp> ',
      ],
    },
  ],
};
}

export function getFocusedWindowTitle(state: VirtualDesktopState): string | undefined {
  return state.windows.find((w) => w.id === state.focusedId)?.title;
}

/** Applies a remote input event. Returns a short status line, or null if nothing notable happened. */
export function applyVirtualInput(state: VirtualDesktopState, input: RemoteInputEvent): string | null {

  if (input.type === 'mousemove') {
    if (input.relative) {
      state.cursorX = Math.max(0, Math.min(W - 4, state.cursorX + (input.dx || 0)));
      state.cursorY = Math.max(0, Math.min(H - 4, state.cursorY + (input.dy || 0)));
    } else {
      state.cursorX = Math.max(0, Math.min(W - 4, input.x * W));
      state.cursorY = Math.max(0, Math.min(H - 4, input.y * H));
    }
    return null;
  }

  if (input.type === 'click') {
    if (typeof input.x === 'number' && typeof input.y === 'number') {
      state.cursorX = Math.max(0, Math.min(W - 4, input.x * W));
      state.cursorY = Math.max(0, Math.min(H - 4, input.y * H));
    }
    if (state.locked) {
      state.locked = false;
      return 'Unlocked desktop';
    }

    const cx = state.cursorX;
    const cy = state.cursorY;

    if (cy >= H - 42 && cx >= W / 2 - 100 && cx <= W / 2 - 60) {
      state.startMenuOpen = !state.startMenuOpen;
      return 'Toggled Start Menu';
    }

    for (let i = state.windows.length - 1; i >= 0; i--) {
      const win = state.windows[i];
      if (win.minimized) continue;
      if (cx >= win.x && cx <= win.x + win.w && cy >= win.y && cy <= win.y + win.h) {
        state.focusedId = win.id;
        state.startMenuOpen = false;
        return `Clicked inside ${win.title}`;
      }
    }

    if (cx >= 24 && cx <= 88) {
      const launchMap = [
        { minY: 24, maxY: 82, app: 'outlook', title: 'Outlook — Client Updates' },
        { minY: 98, maxY: 156, app: 'excel', title: 'Excel — Q4 Budget.xlsx' },
        { minY: 172, maxY: 230, app: 'code', title: 'Visual Studio Code' },
        { minY: 246, maxY: 304, app: 'powershell', title: 'Windows PowerShell' },
      ];
      const hit = launchMap.find((m) => cy >= m.minY && cy <= m.maxY);
      if (hit) {
        const existing = state.windows.find((w) => w.app === hit.app);
        if (existing) {
          existing.minimized = false;
          state.focusedId = existing.id;
        } else {
          const newWin: VirtualWindow = {
            id: hit.app,
            title: hit.title,
            app: hit.app,
            x: 120 + state.windows.length * 24,
            y: 64 + state.windows.length * 20,
            w: 440,
            h: 250,
            content: [`Opened ${hit.title}`, 'Ready for keyboard input...'],
          };
          state.windows.push(newWin);
          state.focusedId = newWin.id;
        }
        return `Opened ${hit.title}`;
      }
    }
    return null;
  }

  if (input.type === 'type') {
    state.locked = false;
    const win = state.windows.find((w) => w.id === state.focusedId) || state.windows[0];
    if (win) {
      const lastIdx = win.content.length - 1;
      win.content[lastIdx] = (win.content[lastIdx] || '') + input.text;
      return `Typed "${input.text.slice(0, 28)}"`;
    }
    return null;
  }

  if (input.type === 'key') {
    state.locked = false;
    const win = state.windows.find((w) => w.id === state.focusedId) || state.windows[0];
    if (win) {
      if (input.key === 'Enter') {
        win.content.push('');
      } else if (input.key === 'Backspace') {
        const lastIdx = win.content.length - 1;
        win.content[lastIdx] = (win.content[lastIdx] || '').slice(0, -1);
      }
    }
    return `Key: ${input.key}`;
  }

  if (input.type === 'hotkey') {
    if (input.combo === 'Win+D') {
      const anyOpen = state.windows.some((w) => !w.minimized);
      state.windows.forEach((w) => {
        w.minimized = anyOpen;
      });
    } else if (input.combo === 'Win+L') {
      state.locked = true;
    } else if (input.combo === 'Alt+Tab') {
      const idx = state.windows.findIndex((w) => w.id === state.focusedId);
      const next = state.windows[(idx + 1) % state.windows.length];
      if (next) {
        next.minimized = false;
        state.focusedId = next.id;
      }
    }
    return `Shortcut: ${input.combo}`;
  }

  if (input.type === 'launch') {
    state.locked = false;
    const target = input.target.toLowerCase();
    const existing = state.windows.find((w) => w.app === target || w.title.toLowerCase().includes(target));
    if (existing) {
      existing.minimized = false;
      state.focusedId = existing.id;
    } else {
      const id = `${target}-${Date.now()}`;
      state.windows.push({
        id,
        title: `${input.target} — Active Window`,
        app: target,
        x: 110 + (state.windows.length % 4) * 28,
        y: 56 + (state.windows.length % 4) * 24,
        w: 450,
        h: 255,
        content: [`Launched ${input.target}`, 'Ready for input: '],
      });
      state.focusedId = id;
    }
    return `Launched ${input.target}`;
  }

  if (input.type === 'shell') {
    state.locked = false;
    let ps = state.windows.find((w) => w.app === 'powershell');
    if (!ps) {
      ps = {
        id: 'powershell',
        title: 'Windows PowerShell',
        app: 'powershell',
        x: 360,
        y: 80,
        w: 440,
        h: 250,
        content: [],
      };
      state.windows.push(ps);
    }
    ps.minimized = false;
    state.focusedId = ps.id;
    ps.content.push(`PS> ${input.command}`);
    ps.content.push(`Executed "${input.command}" [OK]`);
    return `Ran PowerShell: ${input.command}`;
  }
  return null;
}

export interface DrawOptions {
  wallpaper: HTMLImageElement | null;
  hostName: string;
  groupLabel: string;
}

export function drawVirtualDesktop(ctx: CanvasRenderingContext2D, state: VirtualDesktopState, opts: DrawOptions) {


  if (opts.wallpaper) {
    ctx.drawImage(opts.wallpaper, 0, 0, W, H);
  } else {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(1, '#1e3a8a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  if (state.locked) {
    ctx.fillStyle = 'rgba(9, 13, 22, 0.85)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 32px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), W / 2, H / 2 - 20);
    ctx.font = '500 14px "DM Sans", sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${opts.hostName} Locked · Click or press a key to unlock`, W / 2, H / 2 + 16);
    ctx.textAlign = 'left';
  } else {
    const desktopIcons = [
      { label: 'Outlook', x: 24, y: 24 },
      { label: 'Excel', x: 24, y: 98 },
      { label: 'VS Code', x: 24, y: 172 },
      { label: 'PowerShell', x: 24, y: 246 },
    ];
    for (const icon of desktopIcons) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.fillRect(icon.x, icon.y, 64, 58);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.strokeRect(icon.x, icon.y, 64, 58);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(icon.x + 20, icon.y + 10, 24, 22);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '500 11px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(icon.label, icon.x + 32, icon.y + 48);
    }
    ctx.textAlign = 'left';

    const ordered = [...state.windows].sort((a, b) =>
      a.id === state.focusedId ? 1 : b.id === state.focusedId ? -1 : 0,
    );

    for (const win of ordered) {
      if (win.minimized) continue;
      const isFocused = win.id === state.focusedId;

      ctx.fillStyle = win.app === 'powershell' ? 'rgba(9, 13, 22, 0.94)' : 'rgba(15, 23, 42, 0.92)';
      ctx.fillRect(win.x, win.y, win.w, win.h);
      ctx.strokeStyle = isFocused ? '#3b82f6' : 'rgba(148, 163, 184, 0.28)';
      ctx.lineWidth = isFocused ? 1.5 : 1;
      ctx.strokeRect(win.x, win.y, win.w, win.h);

      ctx.fillStyle = isFocused ? '#1e293b' : '#0f172a';
      ctx.fillRect(win.x, win.y, win.w, 30);

      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 12px "DM Sans", sans-serif';
      ctx.fillText(win.title, win.x + 12, win.y + 19);

      ctx.fillStyle = '#94a3b8';
      ctx.fillText('—   □   ×', win.x + win.w - 64, win.y + 19);

      ctx.fillStyle = win.app === 'powershell' ? '#38bdf8' : '#e2e8f0';
      ctx.font = '400 12px "JetBrains Mono", monospace';
      const lines = win.content.slice(-11);
      lines.forEach((line, idx) => {
        ctx.fillText(line.slice(0, 52), win.x + 14, win.y + 54 + idx * 18);
      });
    }

    if (state.startMenuOpen) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
      ctx.fillRect(W / 2 - 140, H - 250, 280, 198);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
      ctx.strokeRect(W / 2 - 140, H - 250, 280, 198);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 13px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`${opts.hostName} · ${opts.groupLabel}`, W / 2 - 122, H - 224);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '400 12px "DM Sans", sans-serif';
      ctx.fillText('Pinned: Outlook, Excel, VS Code, Terminal', W / 2 - 122, H - 196);
    }

    ctx.fillStyle = 'rgba(9, 13, 22, 0.88)';
    ctx.fillRect(0, H - 42, W, 42);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.beginPath();
    ctx.moveTo(0, H - 42);
    ctx.lineTo(W, H - 42);
    ctx.stroke();

    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(W / 2 - 90, H - 32, 22, 22);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '500 11px "DM Sans", sans-serif';
    ctx.fillText(opts.groupLabel, 16, H - 17);
    ctx.fillText(
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      W - 64,
      H - 17,
    );
  }

  const cx = state.cursorX;
  const cy = state.cursorY;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy + 18);
  ctx.lineTo(cx + 5, cy + 14);
  ctx.lineTo(cx + 12, cy + 14);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
