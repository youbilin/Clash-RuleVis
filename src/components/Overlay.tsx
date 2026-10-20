import { createPortal } from 'react-dom';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { useBodyLock, useEscape } from '../lib/hooks';
import { cx } from '../lib/misc';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return;
    const panel = ref.current;
    if (!panel) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.tabIndex = -1;
    const focusable = () =>
      [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.getClientRects().length > 0 && !element.hasAttribute('aria-hidden'),
      );
    if (!panel.contains(document.activeElement)) {
      const initial =
        focusable().find((element) => element.matches('input, textarea, select, [data-autofocus]')) ??
        focusable()[0] ??
        panel;
      initial.focus({ preventScroll: true });
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, [ref, active]);
}

interface ModalProps {
  title?: string;
  subtitle?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
  hideClose?: boolean;
  className?: string;
}

export function Modal({
  title,
  subtitle,
  size = 'md',
  onClose,
  children,
  footer,
  closeOnBackdrop = true,
  hideClose = false,
  className,
}: ModalProps) {
  useBodyLock(true);
  useEscape(onClose);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(panelRef);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className={cx('modal', size, className)} role="dialog" aria-modal="true" aria-label={title}>
        {title ? (
          <div className="modal-head">
            <div className="modal-head-copy">
              <div className="modal-title">{title}</div>
              {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
            </div>
            {hideClose ? null : (
              <button className="icon-btn" onClick={onClose} aria-label="关闭">
                <X size={15} />
              </button>
            )}
          </div>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

interface DrawerProps {
  title?: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ title, subtitle, onClose, children, footer }: DrawerProps) {
  useBodyLock(true);
  useEscape(onClose);
  const panelRef = useRef<HTMLElement | null>(null);
  useDialogFocus(panelRef);
  return createPortal(
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside ref={panelRef} className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head">
          <div className="modal-head-copy">
            <div className="modal-title">{title}</div>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </div>,
    document.body,
  );
}
