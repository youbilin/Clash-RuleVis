import { NavLink } from 'react-router-dom';
import {
  Activity,
  FileOutput,
  Layers,
  Search,
  Server,
  Settings,
  Waypoints,
} from 'lucide-react';
import { useWorkspace } from '../store/workspace';
import { useLive } from '../store/live';
import { useUi, toast } from '../store/ui';
import { formatRelative } from '../lib/format';
import { cx } from '../lib/misc';

const NAV_ITEMS = [
  { to: '/live', label: '实时连接', icon: Activity },
  { to: '/nodes', label: '节点与订阅', icon: Server },
  { to: '/exits', label: '出口', icon: Waypoints },
  { to: '/rulesets', label: '规则集', icon: Layers },
  { to: '/export', label: '导出', icon: FileOutput },
];

function BrandMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 18V10a4 4 0 0 1 4-4h9.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="19.5" cy="6" r="2.1" fill="currentColor" />
      <circle cx="5" cy="19" r="1.7" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function Topbar() {
  const workspace = useWorkspace((state) => state.workspace);
  const status = useWorkspace((state) => state.status);
  const saveState = useWorkspace((state) => state.saveState);
  const lastSavedAt = useWorkspace((state) => state.lastSavedAt);
  const saveNow = useWorkspace((state) => state.saveNow);
  const snapshot = useLive((state) => state.snapshot);
  const setSettingsOpen = useUi((state) => state.setSettingsOpen);
  const setCommandOpen = useUi((state) => state.setCommandOpen);

  const kernel = snapshot?.kernel ?? status?.kernel;
  const pending = workspace?.routes.filter((route) => route.pending).length ?? 0;
  const connected = Boolean(kernel?.connected);

  const retrySave = async () => {
    await saveNow();
    if (useWorkspace.getState().saveState === 'error') {
      toast('error', '仍然无法保存', '请检查本地服务是否在运行');
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="brand-mark">
          <BrandMark />
        </div>
        <div className="brand-text">
          <div className="brand-name">路由台</div>
          <div className="brand-sub">CLASH ROUTE DESK</div>
        </div>
      </div>

      <nav className="topnav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              title={item.label}
              className={({ isActive }) => cx('topnav-item', isActive && 'active')}
            >
              <Icon size={15} strokeWidth={1.7} />
              <span className="topnav-label">{item.label}</span>
              {item.to === '/live' && pending > 0 ? <span className="nav-count">{pending}</span> : null}
            </NavLink>
          );
        })}
      </nav>

      <div className="topbar-spacer" />

      <div className="topbar-status">
        <button className="command-chip" onClick={() => setCommandOpen(true)} title="全局搜索 (Ctrl+K)" aria-label="全局搜索">
          <Search size={13} />
          <span className="mono">Ctrl K</span>
        </button>
        <button
          className={cx('save-state', saveState === 'error' && 'error', saveState === 'saving' && 'saving')}
          title={lastSavedAt ? `上次保存 ${formatRelative(lastSavedAt)}` : undefined}
          onClick={() => {
            if (saveState === 'error') void retrySave();
          }}
        >
          {saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败 · 重试' : '本地已保存'}
        </button>
        <button
          className={cx('kernel-chip', connected ? 'online' : 'offline')}
          onClick={() => setSettingsOpen(true)}
          title={connected ? `${kernel?.version ?? ''} · ${kernel?.endpoint ?? ''}` : kernel?.error ?? '打开连接设置'}
        >
          <span className={cx('dot', connected ? 'green pulse' : 'red')} />
          <span className="kernel-chip-state">
            {connected ? '内核已连接' : kernel?.discovering ? '正在探测' : '内核未连接'}
          </span>
          {connected ? (
            <span className="kernel-chip-meta mono">
              {kernel?.version ?? ''}{kernel?.mixedPort ? ` · :${kernel.mixedPort}` : ''}
            </span>
          ) : null}
          <Settings size={13} />
        </button>
      </div>
    </header>
  );
}
