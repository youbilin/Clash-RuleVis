import type { HistoryEntry } from '../../shared/types';
import { toast } from '../store/ui';

export function notifyRemoved(
  _entry: HistoryEntry | null | undefined,
  title: string,
  message: string,
): void {
  toast('success', title, message);
}
