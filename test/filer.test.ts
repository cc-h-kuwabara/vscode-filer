import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const merged = mergeKeybindings({
      copy: ['F5'],
      customAction: 'x',
    });
    expect(merged.copy).toEqual(['F5']);
    expect(merged.customAction).toEqual(['x']);
    expect(merged.move).toEqual(DEFAULT_KEYBINDINGS.move);
  });
});

