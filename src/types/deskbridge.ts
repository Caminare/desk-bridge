export type HostStatus = 'online' | 'idle' | 'offline';

export type AgentType = 'windows-native' | 'browser-host' | 'virtual-sandbox';

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
    };

export type AIModelProvider = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite' | (string & {});

export type AIThinkingMode = 'fast' | 'deep';

export type AIActionName =
  | 'open_application'
  | 'type_text'
  | 'press_hotkey'
  | 'move_and_click'
  | 'scroll_screen'
  | 'run_shell_command'
  | 'switch_workstation'
  | 'lock_workstation';

export interface AIActionStep {
  id: string;
  action: AIActionName;
  label: string;
  params: Record<string, unknown>;
  status?: 'pending' | 'executed' | 'failed';
}

export interface AICommandResponse {
  model: AIModelProvider;
  transcript?: string;
  reply: string;
  actions: AIActionStep[];
  spokenAudioBase64?: string;
  warning?: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  hostId: string;
  source: 'touch' | 'keyboard' | 'ai' | 'system';
  summary: string;
}
