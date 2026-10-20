import { useEffect } from 'react';

export function useEscape(handler: (() => void) | undefined, active = true): void {
  useEffect(() => {
    if (!active || !handler) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handler();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [handler, active]);
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
