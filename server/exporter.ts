import fs from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type {
  ExportPreview,
  ExportRecord,
  ExportResult,
  HistoryEntry,
  KernelValidation,
  Workspace,
} from '../shared/types';
import { generateConfig } from './generator';
import { readBaseTemplate, type BaseTemplate } from './base-template';
import { validateConfig } from './mihomo-validator';
import { EXPORTS_DIR } from './paths';
import { atomicWriteFile, fileExists, isPathInside } from './fsutil';
import { addHistory, getWorkspace, listHistory, updateWorkspace } from './store';

export class ExportValidationError extends Error {
  preview: ExportPreview;
  validation?: KernelValidation;
  constructor(preview: ExportPreview, validation?: KernelValidation) {
    super('配置校验未通过');
    this.preview = preview;
    this.validation = validation;
  }
}

function stamp(date = new Date()): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function uniqueFileName(date: Date, requestedName?: string): Promise<string> {
  const requested = sanitizeExportName(requestedName);
  const base = requested ? requested.replace(/\.yaml$/i, '') : `clash-rulevis-${stamp(date)}`;
  let candidate = `${base}.yaml`;
  let index = 2;
  while (await fileExists(path.join(EXPORTS_DIR, candidate))) {
    candidate = `${base}-${index}.yaml`;
    index += 1;
  }
  return candidate;
}

function sanitizeExportName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const stem = raw
    .replace(/\.ya?ml$/i, '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80);
  if (!stem) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return `export-${stem}`;
  return stem;
}

export async function buildPreview(workspace: Workspace): Promise<ExportPreview> {
  const includeBase = workspace.settings.includeBaseTemplate !== false;
  let base: BaseTemplate | null = null;
  if (includeBase) {
    base = await readBaseTemplate();
  }
  const generated = generateConfig(workspace, { baseSettings: base?.values });
  const issues = [...generated.issues];
  if (includeBase && base && !base.info.included) {
    issues.push({
      severity: 'warning',
      code: 'base-template-missing',
      message: base.info.warning ?? '未能读取 Verge 的基础设置，导出将不包含端口 / DNS / TUN',
    });
  }
  let diff: string | null = null;
  let previousExportAt: string | null = null;
  if (workspace.lastExport?.path) {
    try {
      const previous = await fs.readFile(workspace.lastExport.path, 'utf8');
      diff = createTwoFilesPatch(
        path.basename(workspace.lastExport.path),
        'next-export.yaml',
        previous,
        generated.yaml,
        '上一次导出',
        '本次导出',
        { context: 4 },
      );
      previousExportAt = workspace.lastExport.at;
    } catch {
      diff = null;
    }
  }
  return {
    yaml: generated.yaml,
    issues,
    counts: generated.counts,
    generatedAt: new Date().toISOString(),
    fileName: `clash-rulevis-${stamp()}.yaml`,
    diff,
    previousExportAt,
    baseSettings: includeBase
      ? base?.info ?? { included: false, keys: [] }
      : { included: false, keys: [] },
  };
}

export async function exportConfig(requestedName?: string): Promise<ExportResult> {
  let validation: KernelValidation | undefined;
  const { value, workspace } = await updateWorkspace(async (draft) => {
    const preview = await buildPreview(draft);
    if (preview.issues.some((issue) => issue.severity === 'error')) {
      throw new ExportValidationError(preview);
    }
    validation = await validateConfig(preview.yaml);
    if (!validation.available) {
      preview.issues = [
        ...preview.issues,
        {
          severity: 'warning',
          code: 'kernel-validation-unavailable',
          message: validation.error ?? '无法运行内核校验，已跳过',
        },
      ];
    } else if (!validation.ok) {
      preview.issues = [
        ...preview.issues,
        {
          severity: 'error',
          code: 'kernel-validation',
          message: 'mihomo 内核校验未通过，请查看校验输出',
        },
      ];
      throw new ExportValidationError(preview, validation);
    }
    const fileName = await uniqueFileName(new Date(), requestedName);
    const filePath = path.join(EXPORTS_DIR, fileName);
    await atomicWriteFile(filePath, preview.yaml);
    const at = new Date().toISOString();
    for (const route of draft.routes) {
      route.pending = false;
      route.appliedAt = at;
    }
    const record: ExportRecord = {
      id: `${Date.now()}`,
      at,
      path: filePath,
      revision: draft.revision + 1,
      bytes: Buffer.byteLength(preview.yaml),
      ruleCount: preview.counts.rules,
      nodeCount: preview.counts.nodes,
      exitCount: preview.counts.exits,
      providerCount: preview.counts.providers,
    };
    draft.lastExport = record;
    return { preview: { ...preview, fileName }, filePath, record };
  });

  const entry = await addHistory(
    {
      label: '导出配置',
      kind: 'export',
      exportPath: value.filePath,
      fileName: path.basename(value.filePath),
      counts: value.preview.counts,
      note: '安全模式：仅写入工具目录，未修改 Clash Verge',
    },
    workspace,
  );

  return {
    ...value.preview,
    path: value.filePath,
    historyId: entry.id,
    workspace,
    validation,
  };
}

export async function readExportForHistory(entry: HistoryEntry): Promise<string | null> {
  if (!entry.exportPath || !isPathInside(EXPORTS_DIR, entry.exportPath)) return null;
  try {
    return await fs.readFile(entry.exportPath, 'utf8');
  } catch {
    return null;
  }
}

interface ExportFileInfo {
  path: string;
  size: number;
  modifiedAt: number;
}

async function listExportFiles(): Promise<ExportFileInfo[]> {
  const entries = await fs.readdir(EXPORTS_DIR, { withFileTypes: true }).catch(() => []);
  const files: ExportFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const filePath = path.join(EXPORTS_DIR, entry.name);
    const info = await fs.stat(filePath).catch(() => null);
    if (info) files.push({ path: filePath, size: info.size, modifiedAt: info.mtimeMs });
  }
  return files;
}

export async function exportStorageStats(): Promise<{ count: number; bytes: number; keepDays: number }> {
  const files = await listExportFiles();
  return {
    count: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    keepDays: 30,
  };
}

export async function cleanupExports(
  keepDays = 30,
): Promise<{ removed: number; freedBytes: number; count: number; bytes: number; keepDays: number }> {
  const [files, history] = await Promise.all([listExportFiles(), listHistory()]);
  const protectedPaths = new Set(history.flatMap((entry) => (entry.exportPath ? [entry.exportPath] : [])));
  const lastExport = getWorkspace().lastExport?.path;
  if (lastExport) protectedPaths.add(lastExport);
  const cutoff = Date.now() - Math.max(0, keepDays) * 86_400_000;
  let removed = 0;
  let freedBytes = 0;
  for (const file of files) {
    if (protectedPaths.has(file.path)) continue;
    if (file.modifiedAt > cutoff) continue;
    try {
      await fs.rm(file.path, { force: true });
      removed += 1;
      freedBytes += file.size;
    } catch {
      // Leave files we cannot delete for the next run.
    }
  }
  const stats = await exportStorageStats();
  return { removed, freedBytes, count: stats.count, bytes: stats.bytes, keepDays };
}
