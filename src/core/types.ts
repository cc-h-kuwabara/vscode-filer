export type PaneId = 0 | 1;

export type SortField = 'name' | 'size' | 'mtime' | 'ext';
export type SortOrder = 'asc' | 'desc';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  isBrokenSymlink?: boolean;
  isReadOnly?: boolean;
  isHidden?: boolean;
  isExecutable?: boolean;
  linkTarget?: string;
  size: number;
  mtimeMs: number;
  mode: number;
  marked: boolean;
}

export interface VirtualArchiveState {
  archivePath: string;
  archiveName: string;
  innerDir: string;
}

export interface PaneState {
  id: PaneId;
  cwd: string;
  entries: FileEntry[];
  cursor: number;
  showDotFiles: boolean;
  sortField: SortField;
  sortOrder: SortOrder;
  mask: string;
  isVirtual: boolean;
  virtualLabel?: string;
  virtualArchive?: VirtualArchiveState;
  history: string[];
  historyIndex: number;
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export type KeybindingsMap = Record<string, string[]>;

export interface FilerStatePayload {
  panes: [PaneState, PaneState];
  activePane: PaneId;
  logs: LogEntry[];
  keybindings: KeybindingsMap;
}

export type OverwriteDecision = 'overwrite' | 'skip' | 'overwriteAll' | 'skipAll' | 'cancel';

export interface OverwriteFileInfo {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  available: boolean;
}

export interface OverwritePromptPayload {
  id: string;
  target: OverwriteFileInfo;
  source?: OverwriteFileInfo;
}

export type ExtensionToWebviewMessage =
  | { type: 'state'; state: FilerStatePayload }
  | { type: 'log'; entry: LogEntry }
  | { type: 'clearLogs' }
  | { type: 'prompt'; promptType: PromptRequest }
  | { type: 'overwritePrompt'; prompt: OverwritePromptPayload }
  | { type: 'help'; open: boolean }
  | { type: 'focus' };

export interface PromptRequest {
  id: string;
  kind: 'incrementalSearch' | 'input' | 'confirm';
  title: string;
  placeholder?: string;
  defaultValue?: string;
  action: string;
}

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'action'; action: string; args?: Record<string, unknown> }
  | { type: 'selectPane'; paneId: PaneId }
  | { type: 'selectEntry'; paneId: PaneId; index: number; open?: boolean }
  | { type: 'promptResult'; id: string; action: string; value: string | null }
  | { type: 'overwriteResult'; id: string; decision: OverwriteDecision };

