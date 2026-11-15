import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type DriveKind = 'local' | 'network' | 'removable' | 'optical' | 'wsl' | 'other';

export interface DriveEntry {
  label: string;
  path: string;
  kind: DriveKind;
  detail?: string;
}

export interface WslUncInfo {
  distro: string;
  linuxPath: string;
}

/**
 * Parse output from `wsl.exe -l -q`, which is typically UTF-16LE encoded on Windows.
 */
export function parseWslListOutput(buffer: Buffer): string[] {
  if (buffer.length === 0) {
    return [];
  }

  // wsl.exe emits UTF-16LE by default (contains null bytes for ASCII characters).
  const hasNullByte = buffer.includes(0x00);
  const text = hasNullByte ? buffer.toString('utf16le') : buffer.toString('utf8');

  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Parse a Windows WSL UNC path (`\\wsl.localhost\Ubuntu\home\user` or `\\wsl$\Ubuntu\...`)
 * into its distribution name and POSIX path inside WSL.
 */
export function parseWslUncPath(targetPath: string): WslUncInfo | null {
  const normalized = targetPath.replace(/\//g, '\\');
  const match = normalized.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i);
  if (!match) {
    return null;
  }

  const distro = match[1];
  const rest = match[2] ?? '';
  const posixRest = rest.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const linuxPath = posixRest ? `/${posixRest}` : '/';
  return { distro, linuxPath };
}

/**
 * Extract the UNC host name from a path such as `\\wsl.localhost\Ubuntu` or `\\server\share`.
 */
export function extractUncHost(targetPath: string): string | null {
  const normalized = targetPath.replace(/\//g, '\\');
  const match = normalized.match(/^\\\\([^\\]+)/);
  return match ? match[1] : null;
}

/**
 * Check whether an error is VS Code's ERR_UNC_HOST_NOT_ALLOWED error.
 */
export function isUncNotAllowedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === 'ERR_UNC_HOST_NOT_ALLOWED') {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('ERR_UNC_HOST_NOT_ALLOWED');
}

/**
 * Normalize a user-entered path (stripping quotes, expanding `~`, handling UNC slashes and bare drive letters).
 */
export function normalizeInputPath(
  input: string,
  currentCwd: string,
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  let trimmed = input.trim();

  // Strip surrounding single or double quotes (e.g. from Windows "Copy as path")
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  if (!trimmed) {
    return path.resolve(currentCwd);
  }

  if (trimmed === '~') {
    return path.resolve(homeDir);
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(homeDir, trimmed.slice(2));
  }

  if (platform === 'win32') {
    // Convert forward-slash UNC input like `//server/share` or `//wsl.localhost/Ubuntu`
    if (trimmed.startsWith('//')) {
      trimmed = trimmed.replace(/\//g, '\\');
    }
    // Bare drive letter like `Z:` -> `Z:\`
    if (/^[a-zA-Z]:$/.test(trimmed)) {
      trimmed = `${trimmed}\\`;
    }
  }

  return path.resolve(currentCwd, trimmed);
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], {
      encoding: 'buffer',
      timeout: 5000,
    });
    return parseWslListOutput(stdout);
  } catch {
    return [];
  }
}

export async function resolveWslRootPath(distro: string): Promise<string> {
  const localhostRoot = `\\\\wsl.localhost\\${distro}\\`;
  if (await isDirectory(localhostRoot)) {
    return localhostRoot;
  }
  const legacyRoot = `\\\\wsl$\\${distro}\\`;
  if (await isDirectory(legacyRoot)) {
    return legacyRoot;
  }
  return localhostRoot;
}

interface RawLogicalDisk {
  DeviceID?: string;
  DriveType?: number;
  VolumeName?: string | null;
  ProviderName?: string | null;
}

function mapDriveType(driveType?: number): DriveKind {
  switch (driveType) {
    case 2:
      return 'removable';
    case 3:
      return 'local';
    case 4:
      return 'network';
    case 5:
      return 'optical';
    default:
      return 'other';
  }
}

async function listWindowsDrivesViaPowerShell(): Promise<DriveEntry[] | null> {
  try {
    const script =
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,ProviderName | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }
    const parsed = JSON.parse(trimmed) as RawLogicalDisk | RawLogicalDisk[];
    const disks = Array.isArray(parsed) ? parsed : [parsed];

    return disks
      .filter((d): d is RawLogicalDisk & { DeviceID: string } => typeof d.DeviceID === 'string')
      .map((d) => {
        const kind = mapDriveType(d.DriveType);
        const rootPath = `${d.DeviceID}\\`;
        const vol = d.VolumeName?.trim();
        const provider = d.ProviderName?.trim();
        let label = d.DeviceID;
        if (kind === 'network') {
          label = vol ? `${d.DeviceID} (${vol}) [Network]` : `${d.DeviceID} [Network]`;
        } else if (vol) {
          label = `${d.DeviceID} (${vol})`;
        }
        return {
          label,
          path: rootPath,
          kind,
          detail: provider || undefined,
        };
      });
  } catch {
    return null;
  }
}

async function listWindowsDrivesFallback(): Promise<DriveEntry[]> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const checks = await Promise.all(
    letters.map(async (letter): Promise<DriveEntry | null> => {
      const rootPath = `${letter}:\\`;
      if (await isDirectory(rootPath)) {
        return {
          label: `${letter}:`,
          path: rootPath,
          kind: 'other',
        };
      }
      return null;
    })
  );
  return checks.filter((item): item is DriveEntry => item !== null);
}

export async function listWindowsDrives(): Promise<DriveEntry[]> {
  const psDrives = await listWindowsDrivesViaPowerShell();
  if (psDrives !== null) {
    return psDrives;
  }
  return listWindowsDrivesFallback();
}

export async function listAvailableLocations(): Promise<DriveEntry[]> {
  if (process.platform === 'win32') {
    const [drives, distros] = await Promise.all([listWindowsDrives(), listWslDistros()]);
    const wslEntries: DriveEntry[] = await Promise.all(
      distros.map(async (distro) => {
        const rootPath = await resolveWslRootPath(distro);
        return {
          label: `WSL: ${distro}`,
          path: rootPath,
          kind: 'wsl' as const,
          detail: rootPath,
        };
      })
    );
    return [...drives, ...wslEntries];
  }

  const candidates: DriveEntry[] = [
    { label: 'Root (/)', path: '/', kind: 'local' },
    { label: `Home (${os.homedir()})`, path: os.homedir(), kind: 'local' },
  ];
  for (const mountPoint of ['/mnt', '/media', '/Volumes']) {
    if (await isDirectory(mountPoint)) {
      candidates.push({ label: mountPoint, path: mountPoint, kind: 'other' });
    }
  }
  return candidates;
}
