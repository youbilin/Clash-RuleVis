import type { HistoryEntry, Workspace } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../store/workspace';
import { toast } from '../store/ui';

export async function undoSnapshot(entry: HistoryEntry | null | undefined, label: string): Promise<void> {
  if (!entry) return;
  try {
    const result = await api<{ workspace: Workspace; undoEntry: HistoryEntry }>(
      `/api/history/${entry.id}/restore`,
      { method: 'POST' },
    );
    useWorkspace.getState().applyServerWorkspace(result.workspace);
    toast('success', '已撤销', `${label} · 已恢复到操作前`);
  } catch (error) {
    toast('error', '撤销失败', (error as Error).message);
  }
}

export function offerUndo(
  entry: HistoryEntry | null | undefined,
  title: string,
  message: string,
): void {
  if (!entry) {
    toast('success', title, message);
    return;
  }
  toast('success', title, message, {
    duration: 12_000,
    action: { label: '撤销', onClick: () => void undoSnapshot(entry, title) },
  });
}
