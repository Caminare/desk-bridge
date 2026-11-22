export type HostStatus = 'online' | 'idle' | 'offline';

export type AgentType = 'windows-native' | 'browser-host' | 'virtual-sandbox';

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface HostProfile {
  hostId: string;
  name: string;
  groupLabel: string;
  os: string;
  screenWidth: number;
  screenHeight: number;
  pairingCode: string;
  pairingUrl?: string;
  status: HostStatus;
  lastSeen: number;
  agentType: AgentType;
  activeWindow?: string;
  cpuUsage?: number;
  memoryUsage?: number;
  connectedControllers?: number;
  /** Monitors reported by the agent (native agent only). */
  monitors?: MonitorInfo[];
  /** Index into `monitors` currently being streamed. */
  activeMonitor?: number;
  /**
   * The agent sends its cursor as `host:cursor` / `host:cursor_shape` instead of drawing it
   * into frames, so the controller must draw it.
   */
  clientCursor?: boolean;
}

/**
 * Cursor image sent by the agent when the shape changes. `rgba` is base64 of w*h*4 bytes,
 * straight (non-premultiplied) RGBA, rows top-down. `id` is a hash of the pixels. Sizes and the
 * hotspot are in the PC's physical pixels.
 */
export interface CursorShape {
  id: string;
  w: number;
  h: number;
  hotX: number;
  hotY: number;
  rgba: string;
}

/**
 * Cursor position normalized (0..1) on the streamed monitor. Values outside 0..1 mean the
 * cursor is on another monitor. `shape` is the id of the current `CursorShape`.
 */
export interface CursorPosition {
  x: number;
  y: number;
  visible: boolean;
  shape: string | null;
}

export type RemoteInputEvent =
  | {
      type: 'mousemove';
      x: number;
      y: number;
      relative?: boolean;
      dx?: number;
      dy?: number;
    }
  | {
      type: 'click';
      button: 'left' | 'right' | 'middle';
      double?: boolean;
      x?: number;
      y?: number;
    }
  | {
      type: 'mousedown' | 'mouseup';
      button: 'left' | 'right';
    }
  | {
      type: 'scroll';
      deltaX: number;
      deltaY: number;
    }
  | {
      type: 'type';
      text: string;
    }
  | {
      type: 'key';
      key: string;
      modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'win'>;
    }
  | {
      type: 'hotkey';
      combo: string;
    }
  | {
      type: 'launch';
      target: string;
      args?: string;
    }
  | {
      type: 'shell';
      command: string;
    }
  | {
      type: 'clipboard';
      text: string;
    }
  | {
      type: 'quality';
      maxWidth: number;
      jpegQuality: number;
    }
  | {
      /** Switch which monitor the agent captures and maps input to. */
      type: 'monitor';
      index: number;
    };

export interface TranscribeResponse {
  text: string;
  model: string;
  warning?: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  hostId: string;
  source: 'touch' | 'keyboard' | 'system';
  summary: string;
}
