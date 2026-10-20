import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryEntry, Workspace } from '../shared/types';
import { createDefaultWorkspace, ensureWorkspaceShape } from './defaults';
import { atomicWriteFile, readJsonFile } from './fsutil';
import { redactLog } from './logging';
import { HISTORY_DIR, WORKSPACE_PATH } from './paths';

interface HistoryFile {
  entry: HistoryEntry;
  workspace: Workspace;
}

let current: Workspace | null = null;
let queue: Promise<unknown> = Promise.resolve();

export async function initStore(): Promise<Workspace> {
  try {
    const loaded = await readJsonFile<Workspace>(WORKSPACE_PATH);
    if (loaded) {
      current = ensureWorkspaceShape(loaded);
      if (!current.createdAt) current.createdAt = new Date().toISOString();
      return current;
    }
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.rename(WORKSPACE_PATH, path.join(path.dirname(WORKSPACE_PATH), `workspace.corrupt-${stamp}.json`)).catch(() => {});
    console.warn('[store] workspace.json 解析失败，已备份并重建：', redactLog(error));
  }
  current = createDefaultWorkspace();
  await persist(current);
  return current;
}

export function getWorkspace(): Workspace {
  if (!current) throw new Error('工作区尚未加载');
  return current;
}

async function persist(workspace: Workspace): Promise<void> {
  await atomicWriteFile(WORKSPACE_PATH, JSON.stringify(workspace, null, 2));
}

export async function updateWorkspace<T>(
  mutate: (draft: Workspace) => T | Promise<T>,
): Promise<{ value: T; workspace: Workspace }> {
  const run = queue.then(async () => {
    if (!current) throw new Error('工作区尚未加载');
    const draft = structuredClone(current);
    const value = await mutate(draft);
    ensureWorkspaceShape(draft);
    draft.revision = current.revision + 1;
    draft.updatedAt = new Date().toISOString();
    await persist(draft);
    current = draft;
    return { value, workspace: draft };
  });
  queue = run.catch(() => {});
  return run;
}

export async function replaceWorkspace(next: Workspace, baseRevision?: number): Promise<Workspace> {
  const { workspace } = await updateWorkspace((draft) => {
    if (typeof baseRevision === 'number' && baseRevision !== draft.revision) {
      throw new RevisionConflictError(structuredClone(draft));
    }
    draft.sources = next.sources ?? draft.sources;
    draft.nodes = next.nodes ?? draft.nodes;
    draft.exits = next.exits ?? draft.exits;
    draft.routes = next.routes ?? draft.routes;
    draft.settings = { ...draft.settings, ...(next.settings ?? {}) };
    draft.lastExport = next.lastExport ?? draft.lastExport;
    draft.createdAt = next.createdAt ?? draft.createdAt;
  });
  return workspace;
}

export class RevisionConflictError extends Error {
  current: Workspace;
  constructor(current: Workspace) {
    super('工作区已被更新');
    this.current = current;
  }
}

const INDEX_PATH = path.join(HISTORY_DIR, 'index.json');

async function readIndex(): Promise<HistoryEntry[]> {
  const index = await readJsonFile<HistoryEntry[]>(INDEX_PATH);
  if (index) {
    const seen = new Set<string>();
    const unique = index.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    if (unique.length !== index.length) {
      await atomicWriteFile(INDEX_PATH, JSON.stringify(unique, null, 2));
    }
    return unique;
  }
  const entries: HistoryEntry[] = [];
  const files = await fs.readdir(HISTORY_DIR).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    const data = await readJsonFile<HistoryFile>(path.join(HISTORY_DIR, file)).catch(() => null);
    if (data?.entry) entries.push(data.entry);
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  if (unique.length) await atomicWriteFile(INDEX_PATH, JSON.stringify(unique, null, 2));
  return unique;
}

export async function listHistory(): Promise<HistoryEntry[]> {
  return readIndex();
}

export async function addHistory(
  entry: Omit<HistoryEntry, 'id' | 'at'> & { at?: string },
  workspace: Workspace,
): Promise<HistoryEntry> {
  const full: HistoryEntry = {
    id: `${Date.now()}-${randomUUID().slice(0, 6)}`,
    at: entry.at ?? new Date().toISOString(),
    label: entry.label,
    kind: entry.kind,
    exportPath: entry.exportPath,
    fileName: entry.fileName,
    counts: entry.counts,
    note: entry.note,
  };
  const payload: HistoryFile = { entry: full, workspace: structuredClone(workspace) };
  await atomicWriteFile(path.join(HISTORY_DIR, `${full.id}.json`), JSON.stringify(payload, null, 2));
  const index = (await readIndex()).filter((item) => item.id !== full.id);
  index.unshift(full);
  while (index.length > 40) {
    const dropped = index.pop();
    if (dropped) await fs.rm(path.join(HISTORY_DIR, `${dropped.id}.json`), { force: true }).catch(() => {});
  }
  await atomicWriteFile(INDEX_PATH, JSON.stringify(index, null, 2));
  return full;
}

export async function readHistory(id: string): Promise<HistoryFile | null> {
  if (!/^\d+-[a-z0-9]+$/i.test(id)) return null;
  return readJsonFile<HistoryFile>(path.join(HISTORY_DIR, `${id}.json`));
}

export async function restoreHistory(
  id: string,
): Promise<{ workspace: Workspace; undoEntry: HistoryEntry } | null> {
  const data = await readHistory(id);
  if (!data) return null;
  const undoEntry = await addHistory(
    {
      label: `恢复前快照 · ${data.entry.label}`,
      kind: 'manual',
      note: '恢复工作区前自动创建',
    },
    getWorkspace(),
  );
  const restored = ensureWorkspaceShape(structuredClone(data.workspace));
  const { workspace } = await updateWorkspace((draft) => {
    draft.sources = restored.sources;
    draft.nodes = restored.nodes;
    draft.exits = restored.exits;
    draft.routes = restored.routes;
    draft.settings = restored.settings;
    draft.lastExport = restored.lastExport;
  });
  await addHistory(
    { label: `恢复自 ${data.entry.label}`, kind: 'restore', note: new Date().toISOString() },
    workspace,
  );
  return { workspace, undoEntry };
}
