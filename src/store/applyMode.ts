import { create } from 'zustand';
import type { VergeLiveApplyResult, VergeLiveStatus } from '../../shared/types';
import { api, isDesktopRuntime } from '../api';

interface ApplyModeState {
  status: VergeLiveStatus | null;
  busy: 'enable' | 'disable' | 'apply' | null;
  error: string | null;
  refresh: () => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  applyNow: () => Promise<VergeLiveApplyResult>;
}

export const useApplyMode = create<ApplyModeState>((set, get) => ({
  status: null,
  busy: null,
  error: null,
  refresh: async () => {
    if (!isDesktopRuntime()) return;
    try {
      const status = await api<VergeLiveStatus>('/api/verge/live');
      set({ status, error: null });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },
  enable: async () => {
    set({ busy: 'enable' });
    try {
      const status = await api<VergeLiveStatus>('/api/verge/live/enable', { method: 'POST' });
      set({ status, error: null });
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    } finally {
      set({ busy: null });
    }
  },
  disable: async () => {
    set({ busy: 'disable' });
    try {
      const status = await api<VergeLiveStatus>('/api/verge/live/disable', { method: 'POST' });
      set({ status, error: null });
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    } finally {
      set({ busy: null });
    }
  },
  applyNow: async () => {
    set({ busy: 'apply' });
    try {
      const result = await api<VergeLiveApplyResult>('/api/verge/live/apply', { method: 'POST' });
      const live = get().status;
      set({
        status: live
          ? {
              ...live,
              lastAppliedAt: result.appliedAt,
              lastBackup: result.backupPath,
              error: undefined,
            }
          : live,
        error: null,
      });
      return result;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    } finally {
      set({ busy: null });
    }
  },
}));
