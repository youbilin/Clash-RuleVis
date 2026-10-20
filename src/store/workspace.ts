import { create } from 'zustand';
import type { AppStatus, HistoryEntry, RuleRoute, Workspace } from '../../shared/types';
import { findDuplicateRoute, insertRouteOrdered } from '../../shared/model';
import { ApiError, api } from '../api';
import { toast, useUi } from './ui';

export interface PendingRuleInput {
  type: RuleRoute['type'];
  payload: string;
  exitId: string;
  targetNodeId?: string;
  noResolve?: boolean;
  origin?: 'drag' | 'manual';
  note?: string;
}

interface WorkspaceState {
  workspace: Workspace | null;
  status: AppStatus | null;
  loading: boolean;
  error: string | null;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt: number | null;
  load: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  applyServerWorkspace: (workspace: Workspace) => void;
  update: (mutate: (draft: Workspace) => void) => void;
  saveNow: () => Promise<void>;
  addPendingRules: (inputs: PendingRuleInput[]) => { added: number; skipped: number };
  createUndoPoint: (label: string) => Promise<HistoryEntry | null>;
}

let changeCounter = 0;
let lastSavedCounter = 0;
let baseRevision = 0;
let pausedForConflict = false;
let debounceTimer: number | null = null;
let inFlight: Promise<void> | null = null;

function clearDebounce(): void {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function schedulePersist(): void {
  clearDebounce();
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void persistLoop();
  }, 450);
}

async function persistLoop(): Promise<void> {
  if (pausedForConflict) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    while (true) {
      const state = useWorkspace.getState();
      if (!state.workspace || changeCounter === lastSavedCounter) break;
      const sentToken = changeCounter;
      const snapshot = state.workspace;
      useWorkspace.setState({ saveState: 'saving' });
      try {
        const result = await api<{ workspace: Workspace }>('/api/workspace', {
          method: 'PUT',
          body: { workspace: snapshot, baseRevision },
        });
        baseRevision = result.workspace.revision;
        lastSavedCounter = sentToken;
        if (sentToken === changeCounter) {
          useWorkspace.setState((current) => ({
            workspace: current.workspace
              ? { ...current.workspace, revision: result.workspace.revision }
              : current.workspace,
            saveState: 'saved',
            lastSavedAt: Date.now(),
          }));
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const serverWorkspace = (error.payload as { workspace?: Workspace }).workspace;
          pausedForConflict = true;
          useWorkspace.setState({ saveState: 'error' });
          const loadLatest = await useUi.getState().confirm({
            title: '工作区已在别处更新',
            message: '另一个窗口或后台任务修改了工作区。加载最新版本会丢弃当前未保存的本地改动。',
            confirmLabel: '加载最新版本',
            cancelLabel: '先保留本地',
            danger: true,
          });
          if (loadLatest && serverWorkspace) {
            useWorkspace.getState().applyServerWorkspace(serverWorkspace);
            toast('info', '已加载服务器最新工作区');
          } else {
            toast('warn', '存在版本冲突', '刷新页面后才能继续保存，避免覆盖其他窗口的修改');
          }
          break;
        }
        useWorkspace.setState({ saveState: 'error' });
        toast('error', '工作区保存失败', (error as Error).message);
        break;
      }
    }
    if (changeCounter === lastSavedCounter) {
      useWorkspace.setState({ saveState: 'saved' });
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspace: null,
  status: null,
  loading: true,
  error: null,
  saveState: 'idle',
  lastSavedAt: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const [workspaceResult, status] = await Promise.all([
        api<{ workspace: Workspace }>('/api/workspace'),
        api<AppStatus>('/api/status'),
      ]);
      changeCounter = 0;
      lastSavedCounter = 0;
      baseRevision = workspaceResult.workspace.revision;
      pausedForConflict = false;
      set({
        workspace: workspaceResult.workspace,
        status,
        loading: false,
        saveState: 'saved',
        lastSavedAt: Date.now(),
      });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
    }
  },
  refreshStatus: async () => {
    try {
      const status = await api<AppStatus>('/api/status');
      set({ status });
    } catch {
      // 状态栏保留上一次结果
    }
  },
  applyServerWorkspace: (workspace) => {
    clearDebounce();
    changeCounter = 0;
    lastSavedCounter = 0;
    baseRevision = workspace.revision;
    pausedForConflict = false;
    set({ workspace, saveState: 'saved', lastSavedAt: Date.now() });
  },
  update: (mutate) => {
    const current = get().workspace;
    if (!current) return;
    const draft = structuredClone(current);
    mutate(draft);
    changeCounter += 1;
    set({ workspace: draft });
    schedulePersist();
  },
  saveNow: async () => {
    clearDebounce();
    pausedForConflict = false;
    await persistLoop();
    if (changeCounter !== lastSavedCounter) {
      await persistLoop();
    }
  },
  createUndoPoint: async (label) => {
    await get().saveNow();
    if (get().saveState === 'error') return null;
    try {
      const result = await api<{ entry: HistoryEntry }>('/api/history/snapshot', {
        method: 'POST',
        body: { label: '操作前快照 · ' + label, note: '删除或清理前自动创建' },
      });
      return result.entry;
    } catch (error) {
      toast('warn', '无法创建操作前快照', (error as Error).message);
      return null;
    }
  },
  addPendingRules: (inputs) => {
    const current = get().workspace;
    if (!current) return { added: 0, skipped: 0 };
    const draft = structuredClone(current);
    let added = 0;
    let skipped = 0;
    for (const input of inputs) {
      const exists = findDuplicateRoute(draft.routes, { type: input.type, payload: input.payload });
      if (exists >= 0) {
        skipped += 1;
        continue;
      }
      const route: RuleRoute = {
        id: crypto.randomUUID(),
        kind: 'rule',
        type: input.type,
        payload: input.payload,
        exitId: input.exitId,
        targetNodeId: input.targetNodeId,
        noResolve: input.noResolve || undefined,
        origin: input.origin ?? 'drag',
        note: input.note,
        enabled: true,
        pending: true,
      };
      draft.routes = insertRouteOrdered(draft.routes, route);
      added += 1;
    }
    if (added) {
      changeCounter += 1;
      set({ workspace: draft });
      schedulePersist();
    }
    return { added, skipped };
  },
}));
