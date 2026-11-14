import { KeybindingsMap } from './types';

export const DEFAULT_KEYBINDINGS: KeybindingsMap = {
  cursorUp: ['ArrowUp', 'ctrl+p'],
  cursorDown: ['ArrowDown', 'ctrl+n'],
  paneLeft: ['ArrowLeft', 'ctrl+b'],
  paneRight: ['ArrowRight', 'ctrl+f'],
  switchPane: ['Tab'],
  cursorTop: ['ctrl+a'],
  cursorBottom: ['ctrl+e'],
  pageUp: ['PageUp', 'ctrl+u', 'alt+v'],
  pageDown: ['PageDown', 'ctrl+d', 'ctrl+v'],
  enter: ['Enter'],
  parentDir: ['Backspace', 'ctrl+h', 'Delete'],
  rootDir: ['\\'],
  homeDir: ['~'],
  toggleMark: [' '],
  rangeMarkStart: ['['],
  rangeMarkEnd: [']'],
  invertFileMarks: ['Home', 'alt+a'],
  invertAllMarks: ['End', 'alt+e'],
  globMark: ['*'],
  regexMark: ['+'],
  toggleDotFiles: ['.'],
  copy: ['c'],
  move: ['m'],
  trash: ['d'],
  deletePermanent: ['D'],
  symlink: ['l'],
  rename: ['r'],
  newFile: ['n'],
  newDir: ['k'],
  compressToOther: ['p'],
  compressHere: ['P'],
  extractToOther: ['u'],
  extractHere: ['U'],
  sortMenu: ['s'],
  maskMenu: ['V'],
  syncActiveToOther: ['o'],
  syncOtherToActive: ['O'],
  swapPanes: ['w'],
  incrementalSearch: ['/', 'f'],
  findVirtualDir: ['F'],
  grepVirtualDir: ['G'],
  jumpMenu: ['j'],
  historyMenu: ['H'],
  historyBack: ['alt+l'],
  historyForward: ['alt+r'],
  openTerminal: [':'],
  refresh: ['ctrl+l'],
  clearLog: ['ctrl+k'],
  help: ['?'],
};

export function mergeKeybindings(userConfig?: Record<string, unknown>): KeybindingsMap {
  const merged: KeybindingsMap = { ...DEFAULT_KEYBINDINGS };
  if (!userConfig) {
    return merged;
  }
  for (const [action, keys] of Object.entries(userConfig)) {
    if (Array.isArray(keys)) {
      merged[action] = keys.filter((k): k is string => typeof k === 'string');
    } else if (typeof keys === 'string') {
      merged[action] = [keys];
    }
  }
  return merged;
}

