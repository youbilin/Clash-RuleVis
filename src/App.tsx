import { useEffect, useLayoutEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Topbar } from './components/Topbar';
import { ConfirmDialog, ToastStack } from './components/Feedback';
import { CommandPalette } from './components/CommandPalette';
import { SettingsDrawer } from './components/SettingsDrawer';
import { LivePage } from './pages/LivePage';
import { NodesPage } from './pages/NodesPage';
import { ExitsPage } from './pages/ExitsPage';
import { ChainPage } from './pages/ChainPage';
import { RulesPage } from './pages/RulesPage';
import { ExportPage } from './pages/ExportPage';
import { useWorkspace } from './store/workspace';
import { useLive } from './store/live';
import { Spinner } from './components/Common';

function BootScreen() {
  return (
    <div className="boot-screen">
      <div className="boot-card">
        <div className="boot-mark logo"><img src="/logo.svg" alt="" /></div>
        <div className="boot-name">Clash RuleVis</div>
        <div className="boot-sub">本地路由工作台</div>
        <div className="boot-loading"><Spinner /> 正在加载工作区</div>
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="boot-screen">
      <div className="boot-card error">
        <div className="boot-mark error"><AlertTriangle size={22} /></div>
        <div className="boot-name">无法打开工作区</div>
        <p className="boot-error">{message}</p>
        <button className="btn btn-primary" onClick={onRetry}>
          <RefreshCw size={13} /> 重试
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const load = useWorkspace((state) => state.load);
  const loading = useWorkspace((state) => state.loading);
  const error = useWorkspace((state) => state.error);
  const refreshStatus = useWorkspace((state) => state.refreshStatus);
  const connectLive = useLive((state) => state.connect);
  const booted = useRef(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      await load();
      connectLive();
    })();
  }, [load, connectLive]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshStatus(), 25_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useLayoutEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  if (loading) return <BootScreen />;
  if (error) return <ErrorScreen message={error} onRetry={() => void load()} />;

  return (
    <div className="app-shell">
      <Topbar />
      <main className="main-pane" ref={mainRef}>
        <Routes>
          <Route path="/" element={<Navigate to="/live" replace />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/exits" element={<ExitsPage />} />
          <Route path="/chains" element={<ChainPage />} />
          <Route path="/rules" element={<Navigate to="/rulesets" replace />} />
          <Route path="/rulesets" element={<RulesPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="*" element={<Navigate to="/live" replace />} />
        </Routes>
      </main>
      <ToastStack />
      <CommandPalette />
      <ConfirmDialog />
      <SettingsDrawer />
    </div>
  );
}
