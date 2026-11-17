import type {
  ExtensionToWebviewMessage,
  FileEntry,
  FilerStatePayload,
  KeybindingsMap,
  LogEntry,
  OverwriteDecision,
  OverwriteFileInfo,
  OverwritePromptPayload,
  PaneId,
  PaneState,
  WebviewToExtensionMessage,
} from '../src/core/types';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void;
};

const vscode = acquireVsCodeApi();

let currentState: FilerStatePayload | null = null;
let keyLookup = new Map<string, string>();
let isHelpOpen = false;
let isSearchActive = false;
let activeOverwritePromptId: string | null = null;
let focusedOverwriteBtnIdx = 0;
const OVERWRITE_BTN_IDS = [
  'overwrite-btn-overwrite',
  'overwrite-btn-skip',
  'overwrite-btn-cancel',
] as const;
const OVERWRITE_DECISIONS: readonly OverwriteDecision[] = ['overwrite', 'skip', 'cancel'];

function focusOverwriteButton(index: number): void {
  focusedOverwriteBtnIdx = ((index % OVERWRITE_BTN_IDS.length) + OVERWRITE_BTN_IDS.length) % OVERWRITE_BTN_IDS.length;
  const btn = document.getElementById(OVERWRITE_BTN_IDS[focusedOverwriteBtnIdx]) as HTMLButtonElement | null;
  btn?.focus();
}

const ACTION_LABELS: Record<string, string> = {
  cursorUp: 'Cursor Up',
  cursorDown: 'Cursor Down',
  paneLeft: 'Focus Left Pane',
  paneRight: 'Focus Right Pane',
  switchPane: 'Switch Pane',
  cursorTop: 'Jump to Top',
  cursorBottom: 'Jump to Bottom',
  pageUp: 'Page Up (10 lines)',
  pageDown: 'Page Down (10 lines)',
  enter: 'Open File / Enter Dir',
  openExternal: 'Open with OS Default App',
  preview: 'BDF Document Preview',
  parentDir: 'Parent Directory',
  rootDir: 'Root Directory',
  homeDir: 'Home Directory',
  toggleMark: 'Mark & Move Down',
  rangeMarkStart: 'Range Mark Start',
  rangeMarkEnd: 'Range Mark End',
  invertFileMarks: 'Invert File Marks',
  invertAllMarks: 'Invert All Marks',
  globMark: 'Glob Mark',
  regexMark: 'RegExp Mark',
  toggleDotFiles: 'Toggle Dotfiles',
  copy: 'Copy to Other Pane',
  copyPath: 'Copy Path to Clipboard',
  copyFileName: 'Copy File Name to Clipboard',
  move: 'Move to Other Pane',
  trash: 'Move to Trash',
  deletePermanent: 'Delete Permanently',
  symlink: 'Create Symlink',
  rename: 'Rename / Regex Rename',
  newFile: 'New File',
  newDir: 'New Directory',
  compressToOther: 'Compress to Other Pane',
  compressHere: 'Compress Here',
  extractToOther: 'Extract to Other Pane',
  extractHere: 'Extract Here',
  sortMenu: 'Sort Menu',
  maskMenu: 'File Mask',
  syncActiveToOther: 'Sync Active -> Other',
  syncOtherToActive: 'Sync Other -> Active',
  swapPanes: 'Swap Panes',
  incrementalSearch: 'Incremental Search',
  findVirtualDir: 'Find (Virtual Dir)',
  grepVirtualDir: 'Grep (Virtual Dir)',
  jumpMenu: 'Bookmarks (Jump)',
  driveMenu: 'Drives / Network / WSL',
  goToPath: 'Go to Path',
  historyMenu: 'History Menu',
  historyBack: 'History Back',
  historyForward: 'History Forward',
  openTerminal: 'Open Terminal',
  refresh: 'Refresh Panes',
  clearLog: 'Clear Operation Log',
  help: 'Toggle Help',
};

function normalizeKeyBinding(binding: string): string {
  if (binding === ' ' || binding.toLowerCase() === 'space') {
    return ' ';
  }
  if (binding === '+') {
    return '+';
  }

  const rawParts = binding.endsWith('++')
    ? [...binding.slice(0, -2).split('+'), '+']
    : binding.split('+');

  const modifiers: string[] = [];
  for (let i = 0; i < rawParts.length - 1; i++) {
    const mod = rawParts[i].trim().toLowerCase();
    if (mod === 'ctrl' || mod === 'alt' || mod === 'meta' || mod === 'shift') {
      modifiers.push(mod);
    }
  }
  modifiers.sort();

  const rawKey = rawParts[rawParts.length - 1] ?? '';
  let key = rawKey === ' ' ? ' ' : rawKey.trim();
  if (key.toLowerCase() === 'space') {
    key = ' ';
  } else if (key.toLowerCase() === 'enter') {
    key = 'Enter';
  }
  if (modifiers.length > 0 && key.length === 1) {
    key = key.toLowerCase();
  }
  return [...modifiers, key].join('+');
}

function eventToKeyString(e: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (e.ctrlKey) {
    modifiers.push('ctrl');
  }
  if (e.altKey) {
    modifiers.push('alt');
  }
  if (e.metaKey) {
    modifiers.push('meta');
  }
  modifiers.sort();

  let key = e.key;
  if (modifiers.length > 0 && key.length === 1) {
    key = key.toLowerCase();
  }
  return [...modifiers, key].join('+');
}

function rebuildKeyLookup(keybindings: KeybindingsMap): void {
  keyLookup = new Map<string, string>();
  for (const [action, keys] of Object.entries(keybindings)) {
    for (const k of keys) {
      keyLookup.set(normalizeKeyBinding(k), action);
    }
  }
}

function formatSize(entry: FileEntry): string {
  if (entry.name === '..') {
    return '<UP>';
  }
  if (entry.isDirectory) {
    return '<DIR>';
  }
  const bytes = entry.size;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(mtimeMs: number): string {
  if (!mtimeMs) {
    return '';
  }
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar'];

function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function renderPane(pane: PaneState, isActive: boolean): void {
  const paneEl = document.getElementById(`pane-${pane.id}`);
  const pathEl = document.getElementById(`pane-${pane.id}-path`);
  const metaEl = document.getElementById(`pane-${pane.id}-meta`);
  const listEl = document.getElementById(`pane-${pane.id}-list`);
  if (!paneEl || !pathEl || !metaEl || !listEl) {
    return;
  }

  paneEl.classList.toggle('active', isActive);
  pathEl.textContent = pane.isVirtual ? `${pane.virtualLabel} (${pane.cwd})` : pane.cwd;
  pathEl.title = pane.cwd;

  const markedCount = pane.entries.filter((e) => e.marked).length;
  const maskText = pane.mask ? ` | Mask: ${pane.mask}` : '';
  const dotText = pane.showDotFiles ? '' : ' | NoDot';
  metaEl.textContent = `${pane.entries.length} items | Marks: ${markedCount} | ${pane.sortField}:${pane.sortOrder}${maskText}${dotText}`;

  listEl.innerHTML = '';
  const fragment = document.createDocumentFragment();

  pane.entries.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row';
    if (idx === pane.cursor) {
      row.classList.add('cursor');
    }
    if (isActive) {
      row.classList.add('pane-active');
    }
    if (entry.marked) {
      row.classList.add('marked');
    }

    const markSpan = document.createElement('span');
    markSpan.className = 'entry-mark';
    markSpan.textContent = entry.marked ? '*' : '';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'entry-name';
    if (entry.isDirectory) {
      nameSpan.classList.add('is-dir');
    }
    if (entry.isSymlink) {
      nameSpan.classList.add('is-link');
    }
    if (entry.isBrokenSymlink) {
      nameSpan.classList.add('is-broken-link');
    }
    if (entry.isExecutable) {
      nameSpan.classList.add('is-exec');
    }
    if (!entry.isDirectory && isArchiveName(entry.name)) {
      nameSpan.classList.add('is-archive');
    }
    if (entry.isReadOnly) {
      nameSpan.classList.add('is-readonly');
    }
    if (entry.isHidden) {
      nameSpan.classList.add('is-hidden');
    }
    nameSpan.textContent = entry.isSymlink && entry.linkTarget
      ? `${entry.name} -> ${entry.linkTarget}`
      : entry.name;

    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'entry-size';
    sizeSpan.textContent = formatSize(entry);

    const dateSpan = document.createElement('span');
    dateSpan.className = 'entry-date';
    dateSpan.textContent = formatDate(entry.mtimeMs);

    row.appendChild(markSpan);
    row.appendChild(nameSpan);
    row.appendChild(sizeSpan);
    row.appendChild(dateSpan);

    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectEntry', paneId: pane.id, index: idx, open: false });
    });
    row.addEventListener('dblclick', () => {
      vscode.postMessage({ type: 'selectEntry', paneId: pane.id, index: idx, open: true });
    });

    fragment.appendChild(row);
  });

  listEl.appendChild(fragment);

  const cursorRow = listEl.children[pane.cursor] as HTMLElement | undefined;
  if (cursorRow) {
    cursorRow.scrollIntoView({ block: 'nearest' });
  }
}

function appendLogElement(entry: LogEntry): void {
  const logList = document.getElementById('log-list');
  if (!logList) {
    return;
  }
  const line = document.createElement('div');
  line.className = `log-line ${entry.level}`;
  line.textContent = `[${entry.timestamp}] ${entry.message}`;
  logList.appendChild(line);
  logList.scrollTop = logList.scrollHeight;
}

function renderLogs(logs: LogEntry[]): void {
  const logList = document.getElementById('log-list');
  if (!logList) {
    return;
  }
  logList.innerHTML = '';
  for (const entry of logs) {
    appendLogElement(entry);
  }
}

function renderHelp(keybindings: KeybindingsMap): void {
  const grid = document.getElementById('help-grid');
  if (!grid) {
    return;
  }
  grid.innerHTML = '';
  for (const [action, keys] of Object.entries(keybindings)) {
    const item = document.createElement('div');
    item.className = 'help-item';
    const label = document.createElement('span');
    label.textContent = ACTION_LABELS[action] || action;
    const keySpan = document.createElement('span');
    keySpan.className = 'help-keys';
    keySpan.textContent = keys.map((k) => (k === ' ' ? 'Space' : k)).join(', ');
    item.appendChild(label);
    item.appendChild(keySpan);
    grid.appendChild(item);
  }
}

function formatEntryMode(entry: FileEntry): string {
  const typeChar = entry.isSymlink ? 'l' : entry.isDirectory ? 'd' : '-';
  const m = entry.mode & 0o777;
  const perms = [
    m & 0o400 ? 'r' : '-',
    m & 0o200 ? 'w' : '-',
    m & 0o100 ? 'x' : '-',
    m & 0o040 ? 'r' : '-',
    m & 0o020 ? 'w' : '-',
    m & 0o010 ? 'x' : '-',
    m & 0o004 ? 'r' : '-',
    m & 0o002 ? 'w' : '-',
    m & 0o001 ? 'x' : '-',
  ].join('');
  const flags: string[] = [];
  if (entry.isBrokenSymlink) {
    flags.push('BROKEN');
  }
  if (entry.isReadOnly) {
    flags.push('RO');
  }
  if (entry.isHidden) {
    flags.push('H');
  }
  if (entry.isExecutable) {
    flags.push('EXE');
  }
  return flags.length > 0 ? `${typeChar}${perms} [${flags.join(',')}]` : `${typeChar}${perms}`;
}

function formatCursorMeta(entry: FileEntry | undefined): string {
  if (!entry) {
    return '';
  }
  if (entry.name === '..') {
    return 'Parent Directory';
  }
  const modeText = formatEntryMode(entry);
  const sizeText = entry.isDirectory
    ? '<DIR>'
    : entry.size >= 1024
      ? `${formatSize(entry)} (${entry.size.toLocaleString('en-US')} B)`
      : `${entry.size.toLocaleString('en-US')} B`;
  const dateText = entry.mtimeMs ? formatOverwriteDate(entry.mtimeMs) : '-';
  return `${modeText} | ${sizeText} | ${dateText}`;
}

function renderStatus(): void {
  if (!currentState) {
    return;
  }
  const active = currentState.panes[currentState.activePane];
  const cursorEntry = active.entries[active.cursor];
  const leftStatus = document.getElementById('status-left');
  const rightStatus = document.getElementById('status-right');

  if (leftStatus) {
    leftStatus.style.display = isSearchActive ? 'none' : 'inline';
    leftStatus.textContent = cursorEntry
      ? `Pane ${active.id + 1} | ${cursorEntry.name} (${formatSize(cursorEntry)})`
      : `Pane ${active.id + 1}`;
  }
  if (rightStatus) {
    rightStatus.textContent = `Press ? for Help`;
  }

  const cursorPathEl = document.getElementById('cursor-path-value');
  if (cursorPathEl) {
    const fullPath = cursorEntry ? cursorEntry.path : active.cwd;
    cursorPathEl.textContent = fullPath;
    cursorPathEl.title = fullPath;
  }

  const cursorMetaEl = document.getElementById('cursor-path-meta');
  if (cursorMetaEl) {
    cursorMetaEl.textContent = formatCursorMeta(cursorEntry);
  }
}

function renderState(state: FilerStatePayload): void {
  currentState = state;
  rebuildKeyLookup(state.keybindings);
  renderPane(state.panes[0], state.activePane === 0);
  renderPane(state.panes[1], state.activePane === 1);
  renderLogs(state.logs);
  renderHelp(state.keybindings);
  renderStatus();
}

function openSearch(): void {
  const box = document.getElementById('search-box');
  const input = document.getElementById('search-input') as HTMLInputElement | null;
  if (!box || !input) {
    return;
  }
  isSearchActive = true;
  box.classList.add('active');
  input.value = '';
  input.focus();
  renderStatus();
}

function closeSearch(): void {
  const box = document.getElementById('search-box');
  const input = document.getElementById('search-input') as HTMLInputElement | null;
  if (!box || !input) {
    return;
  }
  isSearchActive = false;
  box.classList.remove('active');
  input.blur();
  renderStatus();
}

function findNextMatch(query: string, direction: 1 | -1, startOffset: number): void {
  if (!currentState || !query) {
    return;
  }
  const active = currentState.panes[currentState.activePane];
  const len = active.entries.length;
  if (len === 0) {
    return;
  }
  const lower = query.toLowerCase();
  for (let i = 0; i < len; i++) {
    const idx = (active.cursor + startOffset + i * direction + len * 2) % len;
    if (active.entries[idx].name.toLowerCase().includes(lower)) {
      vscode.postMessage({ type: 'action', action: 'jumpToIndex', args: { index: idx } });
      return;
    }
  }
}

function toggleHelp(force?: boolean): void {
  const overlay = document.getElementById('help-overlay');
  if (!overlay) {
    return;
  }
  isHelpOpen = force ?? !isHelpOpen;
  overlay.classList.toggle('open', isHelpOpen);
}

function formatOverwriteDate(mtimeMs: number): string {
  if (!mtimeMs) {
    return 'unknown';
  }
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatOverwriteSize(info: OverwriteFileInfo): string {
  if (!info.available) {
    return '(unavailable)';
  }
  if (info.isDirectory) {
    return '<DIR>';
  }
  const exact = `${info.size.toLocaleString('en-US')} B`;
  if (info.size < 1024) {
    return exact;
  }
  if (info.size < 1024 * 1024) {
    return `${(info.size / 1024).toFixed(1)} KB (${exact})`;
  }
  if (info.size < 1024 * 1024 * 1024) {
    return `${(info.size / (1024 * 1024)).toFixed(1)} MB (${exact})`;
  }
  return `${(info.size / (1024 * 1024 * 1024)).toFixed(1)} GB (${exact})`;
}

function fillOverwriteCard(prefix: 'source' | 'target', info: OverwriteFileInfo | undefined, badgeText: string | null): void {
  const dateEl = document.getElementById(`overwrite-${prefix}-date`);
  const sizeEl = document.getElementById(`overwrite-${prefix}-size`);
  const pathEl = document.getElementById(`overwrite-${prefix}-path`);
  const badgeEl = document.getElementById(`overwrite-${prefix}-badge`);

  if (dateEl) {
    dateEl.textContent = info?.available ? formatOverwriteDate(info.mtimeMs) : '-';
  }
  if (sizeEl) {
    sizeEl.textContent = info ? formatOverwriteSize(info) : '-';
  }
  if (pathEl) {
    pathEl.textContent = info?.path ?? '';
  }
  if (badgeEl) {
    if (badgeText) {
      badgeEl.textContent = badgeText;
      badgeEl.className = 'overwrite-badge newer';
      badgeEl.style.display = 'inline-block';
    } else {
      badgeEl.style.display = 'none';
    }
  }
}

function showOverwritePrompt(prompt: OverwritePromptPayload): void {
  const overlay = document.getElementById('overwrite-overlay');
  const titleEl = document.getElementById('overwrite-title');
  if (!overlay || !titleEl) {
    return;
  }
  activeOverwritePromptId = prompt.id;
  titleEl.textContent = `Overwrite existing "${prompt.target.name}"?`;

  let sourceBadge: string | null = null;
  let targetBadge: string | null = null;
  if (prompt.source?.available && prompt.target.available) {
    if (prompt.source.mtimeMs > prompt.target.mtimeMs) {
      sourceBadge = 'Newer';
    } else if (prompt.target.mtimeMs > prompt.source.mtimeMs) {
      targetBadge = 'Newer';
    }
  }

  fillOverwriteCard('source', prompt.source, sourceBadge);
  fillOverwriteCard('target', prompt.target, targetBadge);
  overlay.classList.add('open');
  window.focus();
  focusedOverwriteBtnIdx = 0;
  requestAnimationFrame(() => {
    focusOverwriteButton(0);
  });
}

function resolveOverwritePrompt(decision: OverwriteDecision): void {
  const id = activeOverwritePromptId;
  if (!id) {
    return;
  }
  activeOverwritePromptId = null;
  document.getElementById('overwrite-overlay')?.classList.remove('open');
  vscode.postMessage({ type: 'overwriteResult', id, decision });
  (document.querySelector('.root') as HTMLElement | null)?.focus();
}

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      renderState(msg.state);
      break;
    case 'log':
      appendLogElement(msg.entry);
      break;
    case 'clearLogs': {
      const logList = document.getElementById('log-list');
      if (logList) {
        logList.innerHTML = '';
      }
      break;
    }
    case 'help':
      toggleHelp(msg.open);
      break;
    case 'overwritePrompt':
      showOverwritePrompt(msg.prompt);
      break;
    case 'focus':
      window.focus();
      (document.querySelector('.root') as HTMLElement | null)?.focus();
      break;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  ([0, 1] as PaneId[]).forEach((paneId) => {
    const paneEl = document.getElementById(`pane-${paneId}`);
    paneEl?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement | null)?.closest('.entry-row')) {
        return;
      }
      if (currentState?.activePane !== paneId) {
        vscode.postMessage({ type: 'selectPane', paneId });
      }
      (document.querySelector('.root') as HTMLElement | null)?.focus();
    });
  });

  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    findNextMatch(searchInput.value, 1, 0);
  });
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      findNextMatch(searchInput.value, 1, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      findNextMatch(searchInput.value, -1, -1);
    }
  });

  document.getElementById('overwrite-btn-overwrite')?.addEventListener('click', (e) => {
    resolveOverwritePrompt((e as MouseEvent).shiftKey ? 'overwriteAll' : 'overwrite');
  });
  document.getElementById('overwrite-btn-skip')?.addEventListener('click', (e) => {
    resolveOverwritePrompt((e as MouseEvent).shiftKey ? 'skipAll' : 'skip');
  });
  document.getElementById('overwrite-btn-cancel')?.addEventListener('click', () => {
    resolveOverwritePrompt('cancel');
  });

  window.addEventListener(
    'keydown',
    (e) => {
      if (activeOverwritePromptId) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          resolveOverwritePrompt('cancel');
        } else if (e.key === 'o' || e.key === 'O') {
          resolveOverwritePrompt(e.shiftKey ? 'overwriteAll' : 'overwrite');
        } else if (e.key === 's' || e.key === 'S') {
          resolveOverwritePrompt(e.shiftKey ? 'skipAll' : 'skip');
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          focusOverwriteButton(focusedOverwriteBtnIdx - 1);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          focusOverwriteButton(focusedOverwriteBtnIdx + 1);
        } else if (e.key === 'Tab') {
          focusOverwriteButton(focusedOverwriteBtnIdx + (e.shiftKey ? -1 : 1));
        } else if (e.key === 'Enter' || e.key === ' ') {
          const baseDecision = OVERWRITE_DECISIONS[focusedOverwriteBtnIdx] ?? 'overwrite';
          if (e.shiftKey && baseDecision === 'overwrite') {
            resolveOverwritePrompt('overwriteAll');
          } else if (e.shiftKey && baseDecision === 'skip') {
            resolveOverwritePrompt('skipAll');
          } else {
            resolveOverwritePrompt(baseDecision);
          }
        }
        return;
      }

    if (isSearchActive) {
      return;
    }

    if (isHelpOpen) {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        toggleHelp(false);
      }
      return;
    }

    const keyStr = eventToKeyString(e);
    const action = keyLookup.get(keyStr);
    if (!action) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (action === 'help') {
      toggleHelp();
      return;
    }
    if (action === 'incrementalSearch') {
      openSearch();
      return;
    }

    vscode.postMessage({ type: 'action', action });
  },
    true
  );

  vscode.postMessage({ type: 'ready' });
});

