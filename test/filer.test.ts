import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractUncHost,
  isUncNotAllowedError,
  normalizeInputPath,
  parseWslListOutput,
  parseWslUncPath,
} from '../src/core/driveDetector';
import { FileOperations } from '../src/core/fileOperations';
import { DEFAULT_KEYBINDINGS, mergeKeybindings } from '../src/core/keybindings';
import { OperationLogger } from '../src/core/logger';
import { PaneManager } from '../src/core/paneManager';

describe('VS Code Filer Core', () => {
  let tmpRoot: string;
  let leftDir: string;
  let rightDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-filer-test-'));
    leftDir = path.join(tmpRoot, 'left');
    rightDir = path.join(tmpRoot, 'right');
    await fs.mkdir(leftDir, { recursive: true });
    await fs.mkdir(rightDir, { recursive: true });

    await fs.mkdir(path.join(leftDir, 'subA'));
    await fs.writeFile(path.join(leftDir, 'alpha.ts'), 'console.log("a");');
    await fs.writeFile(path.join(leftDir, 'beta.js'), 'console.log("b");');
    await fs.writeFile(path.join(leftDir, '.hidden'), 'secret');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('loads directories, sorts dirs before files, and toggles dotfiles', async () => {
    const pm = new PaneManager(leftDir, rightDir, true);
    await pm.reloadAll();

    const left = pm.getPane(0);
    // .., subA, .hidden, alpha.ts, beta.js
    const names = left.entries.map((e) => e.name);
    expect(names[0]).toBe('..');
    expect(names[1]).toBe('subA');
    expect(names).toContain('.hidden');

    const shown = await pm.toggleDotFiles(0);
    expect(shown).toBe(false);
    expect(pm.getPane(0).entries.map((e) => e.name)).not.toContain('.hidden');
  });

  it('supports pane switching, sync, swap, and history navigation', async () => {
    const pm = new PaneManager(leftDir, rightDir, true);
    await pm.reloadAll();

    expect(pm.getActivePaneId()).toBe(0);
    pm.switchPane();
    expect(pm.getActivePaneId()).toBe(1);

    await pm.cd(0, path.join(leftDir, 'subA'));
    expect(pm.getPane(0).cwd).toBe(path.join(leftDir, 'subA'));

    expect(await pm.historyBack(0)).toBe(true);
    expect(pm.getPane(0).cwd).toBe(leftDir);
    expect(await pm.historyForward(0)).toBe(true);
    expect(pm.getPane(0).cwd).toBe(path.join(leftDir, 'subA'));

    await pm.swapPanes();
    expect(pm.getPane(0).cwd).toBe(rightDir);
    expect(pm.getPane(1).cwd).toBe(path.join(leftDir, 'subA'));
  });

  it('supports marks (toggle, range, glob, regex, invert)', async () => {
    const pm = new PaneManager(leftDir, rightDir, false);
    await pm.reloadAll();

    // Select alpha.ts via glob
    const globCount = pm.markByGlob(0, '*.ts');
    expect(globCount).toBe(1);
    const targets = pm.getTargetEntries(0);
    expect(targets.map((t) => t.name)).toEqual(['alpha.ts']);

    pm.invertMarks(0, true);
    expect(pm.getTargetEntries(0).map((t) => t.name)).toEqual(['beta.js']);
  });

  it('performs file operations and logs them to OperationLogger', async () => {
    const logger = new OperationLogger();
    const ops = new FileOperations(logger);
    const pm = new PaneManager(leftDir, rightDir, false);
    await pm.reloadAll();

    const alpha = pm.getPane(0).entries.find((e) => e.name === 'alpha.ts')!;
    const copied = await ops.copyEntries([alpha], rightDir);
    expect(copied).toBe(1);

    await pm.reloadPane(1);
    expect(pm.getPane(1).entries.map((e) => e.name)).toContain('alpha.ts');

    const logs = logger.getLogs();
    expect(logs.some((l) => l.level === 'success' && l.message.includes('COPY:'))).toBe(true);

    // Regex rename in rightDir
    const rightAlpha = pm.getPane(1).entries.find((e) => e.name === 'alpha.ts')!;
    const renamed = await ops.regexRenameEntries([rightAlpha], '\\.ts$', '.tsx');
    expect(renamed).toBe(1);

    await pm.reloadPane(1);
    expect(pm.getPane(1).entries.map((e) => e.name)).toContain('alpha.tsx');

    // Mkdir
    expect(await ops.makeDirectory(rightDir, 'nested/dir')).toBe(true);
    const stat = await fs.stat(path.join(rightDir, 'nested/dir'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('merges user keybindings over defaults', () => {
    expect(DEFAULT_KEYBINDINGS.preview).toEqual(['v']);
    expect(DEFAULT_KEYBINDINGS.historyMenu).toEqual(['h']);
    const merged = mergeKeybindings({
      copy: ['F5'],
      customAction: 'x',
    });
    expect(merged.copy).toEqual(['F5']);
    expect(merged.customAction).toEqual(['x']);
    expect(merged.move).toEqual(DEFAULT_KEYBINDINGS.move);
  });

  it('parses wsl.exe -l -q UTF-16LE and UTF-8 output', () => {
    const utf16 = Buffer.from('\uFEFFUbuntu\r\nDebian\r\ndocker-desktop\r\n', 'utf16le');
    expect(parseWslListOutput(utf16)).toEqual(['Ubuntu', 'Debian', 'docker-desktop']);

    const utf8 = Buffer.from('Ubuntu-24.04\n\nAlpine\n', 'utf8');
    expect(parseWslListOutput(utf8)).toEqual(['Ubuntu-24.04', 'Alpine']);

    expect(parseWslListOutput(Buffer.alloc(0))).toEqual([]);
  });

  it('parses WSL UNC paths into distro and Linux path', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\user')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/user',
    });
    expect(parseWslUncPath('\\\\wsl$\\Debian\\')).toEqual({
      distro: 'Debian',
      linuxPath: '/',
    });
    expect(parseWslUncPath('C:\\Users\\hiro1')).toBeNull();
  });

  it('normalizes quoted, tilde, bare drive, and UNC paths', () => {
    const home = path.resolve(os.homedir());
    expect(normalizeInputPath('~', leftDir, home)).toBe(home);
    expect(normalizeInputPath('~/sub', leftDir, home)).toBe(path.resolve(home, 'sub'));
    expect(normalizeInputPath(`"${leftDir}"`, rightDir, home)).toBe(path.resolve(leftDir));

    if (process.platform === 'win32') {
      expect(normalizeInputPath('Z:', leftDir, home, 'win32')).toBe('Z:\\');
      expect(normalizeInputPath('//server/share/dir', leftDir, home, 'win32')).toBe(
        '\\\\server\\share\\dir'
      );
    }
  });

  it('extracts UNC host and detects ERR_UNC_HOST_NOT_ALLOWED errors', () => {
    expect(extractUncHost('\\\\wsl.localhost\\Ubuntu\\home')).toBe('wsl.localhost');
    expect(extractUncHost('\\\\fileserver\\public')).toBe('fileserver');
    expect(extractUncHost('C:\\Users\\hiro1')).toBeNull();

    expect(isUncNotAllowedError({ code: 'ERR_UNC_HOST_NOT_ALLOWED' })).toBe(true);
    expect(
      isUncNotAllowedError(new Error("Error [ERR_UNC_HOST_NOT_ALLOWED]: UNC host 'wsl.localhost'"))
    ).toBe(true);
    expect(isUncNotAllowedError(new Error('ENOENT'))).toBe(false);
  });
});

