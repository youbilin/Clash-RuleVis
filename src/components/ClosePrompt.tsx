import { useEffect, useState } from 'react';
import { LogOut, Minimize2 } from 'lucide-react';
import { invokeNative, isDesktopRuntime } from '../api';
import { useWorkspace } from '../store/workspace';
import { Modal } from './Overlay';
import { Spinner } from './Common';

export function ClosePrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const stop = await listen('close-requested', () => setOpen(true));
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // the shell owns the close event; if listening fails the window stays open
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const minimize = async () => {
    setBusy(true);
    try {
      await useWorkspace.getState().saveNow();
    } catch {
      // saving is best effort when leaving the window
    }
    await invokeNative('hide_main_window').catch(() => {});
    setBusy(false);
    setOpen(false);
  };

  const quit = async () => {
    setBusy(true);
    try {
      await useWorkspace.getState().saveNow();
    } catch {
      // saving is best effort when quitting
    }
    await invokeNative('quit_app').catch(() => {});
  };

  if (!open) return null;

  return (
    <Modal
      title="退出 Clash RuleVis"
      size="sm"
      onClose={() => {
        if (!busy) setOpen(false);
      }}
      closeOnBackdrop={!busy}
      hideClose={busy}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </button>
          <button className="btn btn-danger" onClick={() => void quit()} disabled={busy}>
            {busy ? <Spinner /> : <LogOut size={13} />} 直接退出
          </button>
          <button className="btn btn-primary" onClick={() => void minimize()} disabled={busy}>
            {busy ? <Spinner onAccent /> : <Minimize2 size={13} />} 最小化到托盘
          </button>
        </>
      }
    >
      <p className="hint" style={{ margin: 0 }}>
        最小化后 Clash RuleVis 会继续在托盘运行，实时连接和后台任务不会中断。直接退出会停止所有本地任务。
      </p>
    </Modal>
  );
}
