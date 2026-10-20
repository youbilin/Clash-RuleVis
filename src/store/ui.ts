import { create } from 'zustand';

export type ToastTone = 'success' | 'error' | 'info' | 'warn';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  action?: ToastAction;
  duration?: number;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmState {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

interface UiState {
  toasts: Toast[];
  confirmState: ConfirmState | null;
  settingsOpen: boolean;
  commandOpen: boolean;
  addToast: (toast: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  resolveConfirm: (value: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandOpen: (open: boolean) => void;
}

let nextToastId = 1;

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  confirmState: null,
  settingsOpen: false,
  commandOpen: false,
  addToast: (toast) => {
    const id = nextToastId++;
    set((state) => ({ toasts: [...state.toasts.slice(-4), { ...toast, id }] }));
    const duration = toast.duration ?? (toast.tone === 'error' ? 8000 : 4200);
    window.setTimeout(() => get().dismissToast(id), duration);
    return id;
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      get().confirmState?.resolve(false);
      set({ confirmState: { options, resolve } });
    }),
  resolveConfirm: (value) => {
    const state = get().confirmState;
    state?.resolve(value);
    set({ confirmState: null });
  },
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setCommandOpen: (open) => set({ commandOpen: open }),
}));

export function toast(
  tone: ToastTone,
  title: string,
  message?: string,
  options?: { action?: ToastAction; duration?: number },
): number {
  return useUi.getState().addToast({ tone, title, message, ...options });
}
