import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { KernelValidation } from '../shared/types';
import { DATA_DIR } from './paths';
import { fileExists } from './fsutil';
import { kernel } from './kernel';

const execFileAsync = promisify(execFile);
const VALIDATION_DIR = path.join(DATA_DIR, 'validation');
const GEO_FILES = ['geoip.dat', 'geosite.dat', 'Country.mmdb', 'ASN.mmdb'];

let binaryCache: { value: string | null; at: number } | null = null;
let geoCopy: Promise<void> | null = null;

async function processPaths(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process clash-verge,verge-mihomo -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path)',
      ],
      { timeout: 5000, windowsHide: true, maxBuffer: 128 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function existingFile(files: string[]): Promise<string | null> {
  for (const file of files) {
    if (!file) continue;
    if (await fileExists(file)) return file;
  }
  return null;
}

export async function findMihomoBinary(): Promise<string | null> {
  if (binaryCache && Date.now() - binaryCache.at < 60_000) return binaryCache.value;
  const candidates: string[] = [];
  if (process.env.CRS_MIHOMO_BIN) candidates.push(process.env.CRS_MIHOMO_BIN);

  if (process.platform === 'win32') {
    const paths = await processPaths();
    for (const processPath of paths) {
      if (/verge-mihomo(?:-alpha)?\.exe$/i.test(processPath)) candidates.push(processPath);
      const dir = path.dirname(processPath);
      candidates.push(
        path.join(dir, 'verge-mihomo.exe'),
        path.join(dir, 'verge-mihomo-alpha.exe'),
        path.join(dir, 'mihomo.exe'),
      );
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(
        path.join(localAppData, 'Programs', 'clash-verge', 'verge-mihomo.exe'),
        path.join(localAppData, 'Programs', 'Clash Verge', 'verge-mihomo.exe'),
      );
    }
  } else {
    candidates.push('mihomo', 'clash-meta');
  }

  const unique = [...new Set(candidates)];
  let found: string | null = null;
  if (process.platform === 'win32') {
    found = await existingFile(unique);
  } else {
    for (const name of unique) {
      try {
        const { stdout } = await execFileAsync('which', [name], { timeout: 2000 });
        found = stdout.trim() || null;
        if (found) break;
      } catch {
        // 继续尝试下一个
      }
    }
  }
  binaryCache = { value: found, at: Date.now() };
  return found;
}

async function ensureGeoFiles(): Promise<void> {
  if (geoCopy) return geoCopy;
  geoCopy = (async () => {
    await fsp.mkdir(VALIDATION_DIR, { recursive: true });
    const vergeDir = kernel.getVerge()?.dir;
    if (!vergeDir) return;
    for (const name of GEO_FILES) {
      const target = path.join(VALIDATION_DIR, name);
      if (await fileExists(target)) continue;
      await fsp.copyFile(path.join(vergeDir, name), target).catch(() => {});
    }
  })().finally(() => {
    geoCopy = null;
  });
  return geoCopy;
}

function sanitizeOutput(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^time="[^"]+"\s+level=(\w+)\s+msg="?/, '').replace(/"$/, ''))
    .filter((line) => !/^(Start initial configuration|Geodata Loader|Geosite Matcher|Initial configuration complete)/i.test(line));
  const relevant = lines.filter((line) => !/^configuration file .* test is successful$/i.test(line));
  const summary = lines.find((line) => /test is (successful|failed)/i.test(line)) ?? '';
  const text = [...relevant.slice(-16), summary].filter(Boolean).join('\n');
  return (text || 'mihomo 未返回可读输出').slice(0, 4000);
}

export async function validateConfig(yamlText: string): Promise<KernelValidation> {
  const binary = await findMihomoBinary();
  if (!binary) {
    return {
      available: false,
      ok: false,
      error: '未找到 mihomo 可执行文件。启动 Clash Verge，或设置 CRS_MIHOMO_BIN 指向 verge-mihomo.exe。',
    };
  }
  await ensureGeoFiles();
  await fsp.mkdir(VALIDATION_DIR, { recursive: true });
  const file = path.join(VALIDATION_DIR, `validate-${Date.now()}-${randomUUID().slice(0, 6)}.yaml`);
  await fsp.writeFile(file, yamlText, 'utf8');
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(binary, ['-t', '-d', VALIDATION_DIR, '-f', file], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = sanitizeOutput(`${stdout}\n${stderr}`);
    return {
      available: true,
      ok: !/test failed/i.test(output),
      binary: path.basename(binary),
      durationMs: Date.now() - started,
      output,
    };
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; killed?: boolean; message: string };
    const raw = `${detail.stdout ?? ''}\n${detail.stderr ?? ''}`.trim() || detail.message;
    return {
      available: true,
      ok: false,
      binary: path.basename(binary),
      durationMs: Date.now() - started,
      output: sanitizeOutput(raw),
      error: detail.killed ? '校验超时' : undefined,
    };
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}
