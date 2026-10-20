import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.CRS_DATA_DIR
  ? path.resolve(process.env.CRS_DATA_DIR)
  : path.join(APP_ROOT, 'data');
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
export const HISTORY_DIR = path.join(DATA_DIR, 'history');
export const RULE_SETS_DIR = path.join(DATA_DIR, 'rule-sets');
export const WORKSPACE_PATH = path.join(DATA_DIR, 'workspace.json');
export const KERNEL_SETTINGS_PATH = path.join(DATA_DIR, 'kernel.json');
export const DIST_DIR = path.join(APP_ROOT, 'dist');

export const SERVER_PORT = Number(process.env.PORT || 4780);
export const SERVER_HOST = '127.0.0.1';

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, EXPORTS_DIR, HISTORY_DIR, RULE_SETS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
