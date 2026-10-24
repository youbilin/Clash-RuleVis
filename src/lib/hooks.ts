import { useEffect, useRef } from 'react';

const escapeHandlers: Array<(event: KeyboardEvent) => void> = [];

export function useEscape(handler: (() => void) | undefined, active = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabled = active && Boolean(handler);

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (escapeHandlers[escapeHandlers.length - 1] !== listener) return;
      event.stopImmediatePropagation();
      handlerRef.current?.();
    };
    escapeHandlers.push(listener);
    window.addEventListener('keydown', listener);
    return () => {
      window.removeEventListener('keydown', listener);
      const index = escapeHandlers.lastIndexOf(listener);
      if (index >= 0) escapeHandlers.splice(index, 1);
    };
  }, [enabled]);
}

export function useBodyLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}
