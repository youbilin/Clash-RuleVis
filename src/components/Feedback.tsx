import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useEscape } from '../lib/hooks';
import { useUi, type ToastTone } from '../store/ui';
import { useDialogFocus } from './Overlay';

const ICONS: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  warn: AlertTriangle,
  info: Info,
};

export function ToastStack() {
  const toasts = useUi((state) => state.toasts);
  if (!toasts.length) return null;
  return createPortal(
    <div className="toast-stack" aria-live="polite">
      {toasts.map((item) => {
        const Icon = ICONS[item.tone];
        return (
          <div key={item.id} className={`toast tone-${item.tone}`}>
            <span className="toast-icon">
              <Icon size={16} />
            </span>
            <div className="toast-copy">
              <div className="toast-title">{item.title}</div>
              {item.message ? <div className="toast-msg">{item.message}</div> : null}
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export function ConfirmDialog() {
  const state = useUi((state) => state.confirmState);
  const resolve = useUi((state) => state.resolveConfirm);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(panelRef, Boolean(state));
  useEscape(() => resolve(false), Boolean(state));
  if (!state) return null;
  const { options } = state;
  return (
    <div className="modal-backdrop confirm-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) resolve(false);
    }}>
      <div ref={panelRef} className="modal sm" role="alertdialog" aria-modal="true" aria-label={options.title}>
        <div className="modal-head">
          <div className="modal-head-copy">
            <div className="modal-title">{options.title}</div>
            <div className="modal-sub" style={{ whiteSpace: 'pre-line' }}>{options.message}</div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={() => resolve(false)}>
            {options.cancelLabel ?? '取消'}
          </button>
          <button
            className={options.danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => resolve(true)}
            autoFocus
          >
            {options.confirmLabel ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}
