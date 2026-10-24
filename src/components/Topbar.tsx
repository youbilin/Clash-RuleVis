import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity,
  FileOutput,
  GitBranch,
  Layers,
  RadioTower,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Upload,
  Waypoints,
} from 'lucide-react';
import { useWorkspace } from '../store/workspace';
import { useLive } from '../store/live';
import { useUi, toast } from '../store/ui';
import { useApplyMode } from '../store/applyMode';
import { formatRelative } from '../lib/format';
import { cx } from '../lib/misc';
import { isDesktopRuntime, openExternal } from '../api';

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.73.5.9 5.33.9 11.6c0 4.9 3.17 9.05 7.57 10.5.55.1.75-.24.75-.53v-1.86c-3.08.67-3.73-1.48-3.73-1.48-.5-1.28-1.23-1.62-1.23-1.62-1-.69.08-.67.08-.67 1.11.08 1.69 1.14 1.69 1.14.98 1.68 2.58 1.2 3.2.92.1-.71.39-1.2.7-1.47-2.46-.28-5.05-1.23-5.05-5.47 0-1.21.43-2.2 1.14-2.97-.11-.28-.5-1.41.11-2.94 0 0 .93-.3 3.05 1.13a10.6 10.6 0 0 1 2.78-.37c.94 0 1.89.13 2.78.37 2.12-1.43 3.05-1.13 3.05-1.13.61 1.53.22 2.66.11 2.94.71.77 1.14 1.76 1.14 2.97 0 4.25-2.6 5.19-5.07 5.46.4.35.76 1.03.76 2.08v3.08c0 .29.2.63.76.52 4.4-1.45 7.56-5.6 7.56-10.5C23.1 5.33 18.27.5 12 .5z" />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: '/live', label: '实时连接', icon: Activity },
  { to: '/nodes', label: '节点与订阅', icon: Server },
  { to: '/exits', label: '出口', icon: Waypoints },
  { to: '/chains', label: '链路', icon: GitBranch },
  { to: '/rulesets', label: '规则集', icon: Layers },
  { to: '/export', label: '导出', icon: FileOutput },
];

export function Topbar() {
  const workspace = useWorkspace((state) => state.workspace);
  const status = useWorkspace((state) => state.status);
  const saveState = useWorkspace((state) => state.saveState);
  const lastSavedAt = useWorkspace((state) => state.lastSavedAt);
  const saveNow = useWorkspace((state) => state.saveNow);
  const snapshot = useLive((state) => state.snapshot);
  const setSettingsOpen = useUi((state) => state.setSettingsOpen);
  const setCommandOpen = useUi((state) => state.setCommandOpen);
  const confirm = useUi((state) => state.confirm);
  const paused = useLive((state) => state.paused);
  const setPaused = useLive((state) => state.setPaused);
  const liveStatus = useApplyMode((state) => state.status);
  const liveBusy = useApplyMode((state) => state.busy);
  const refreshLive = useApplyMode((state) => state.refresh);
  const enableLive = useApplyMode((state) => state.enable);
  const disableLive = useApplyMode((state) => state.disable);
  const applyLive = useApplyMode((state) => state.applyNow);
  const location = useLocation();
  const currentPage = NAV_ITEMS.find((item) => location.pathname.startsWith(item.to))?.label ?? '';

  const kernel = snapshot?.kernel ?? status?.kernel;
  const pending = workspace?.routes.filter((route) => route.pending).length ?? 0;
  const connected = Boolean(kernel?.connected);

  const retrySave = async () => {
    await saveNow();
    if (useWorkspace.getState().saveState === 'error') {
      toast('error', '仍然无法保存', '请检查本地服务是否在运行');
    }
  };

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void refreshLive();
    const timer = window.setInterval(() => {
      if (!useApplyMode.getState().busy) void refreshLive();
    }, 30_000);
    const onFocus = () => {
      if (!useApplyMode.getState().busy) void refreshLive();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshLive]);

  const toggleLiveMode = async () => {
    if (!liveStatus?.available) {
      toast('warn', '实时模式不可用', liveStatus?.error ?? '未检测到 Clash Verge');
      return;
    }
    if (liveStatus.mode === 'live') {
      const confirmed = await confirm({
        title: '关闭实时模式',
        message: [
          `将把 Verge 当前 profile 恢复为「${liveStatus.originalProfile?.name ?? '原 profile'}」。`,
          'Clash RuleVis 创建的本地 profile 会保留，之后可以重新开启实时模式。',
        ].join('\n\n'),
        confirmLabel: '恢复并关闭',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await disableLive();
        toast('success', '已关闭实时模式', 'Verge profile 已切回原配置');
      } catch (error) {
        toast('error', '关闭实时模式失败', (error as Error).message);
      }
      return;
    }
    const confirmed = await confirm({
      title: '开启实时模式',
      message: [
        '将创建并切换到一个 Clash RuleVis 本地 Verge profile，不会修改订阅 profile。',
        '实时模式会复制当前节点与规则；订阅更新后请在节点页刷新并重新应用到 Verge。',
        '开启后仍需点击「应用到 Clash Verge」才会写入规则；写入时会重载内核，可能短暂断线。',
        'Verge 界面可能需要重启后同步，但内核和本地 profile 会立即更新。',
      ].join('\n\n'),
      confirmLabel: '开启实时模式',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await enableLive();
      toast('success', '实时模式已开启', '点击「应用到 Clash Verge」写入当前配置');
    } catch (error) {
      toast('error', '开启实时模式失败', (error as Error).message);
    }
  };

  const applyToVerge = async () => {
    await saveNow();
    if (useWorkspace.getState().saveState === 'error') {
      toast('error', '工作区尚未保存', '请先重试保存，再应用到 Clash Verge');
      return;
    }
    try {
      const result = await applyLive();
      useWorkspace.getState().applyServerWorkspace(result.workspace);
      toast(
        'success',
        '已应用到 Clash Verge',
        `${result.profile.name} · 已备份并重载内核`,
      );
    } catch (error) {
      toast('error', '应用到 Clash Verge 失败', (error as Error).message);
      void refreshLive();
    }
  };

  const resumeLive = async () => {
    const confirmed = await confirm({
      title: '恢复实时模式',
      message: [
        'Verge 当前 profile 已被切换到其他配置。',
        '恢复会把当前 profile 切回 Clash RuleVis 的专用实时 profile；内核不会自动重载，恢复后请点击「应用到 Clash Verge」写入最新配置。',
      ].join('\n\n'),
      confirmLabel: '恢复实时模式',
    });
    if (!confirmed) return;
    try {
      await enableLive();
      toast('success', '已恢复实时模式', '点击「应用到 Clash Verge」写入最新配置');
    } catch (error) {
      toast('error', '恢复实时模式失败', (error as Error).message);
    }
  };

  return (
    <header className="topbar">
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
              {item.to === '/live' && pending > 0 ? <span className="nav-count">{pending}</span> : null}
            </NavLink>
          );
        })}
        <span className="topnav-divider" aria-hidden />
        <button
          type="button"
          role="switch"
          aria-checked={!paused}
          className={cx('stream-toggle', (paused || !connected) && 'paused')}
          onClick={() => setPaused(!paused)}
          disabled={!connected}
          title={!connected ? '内核未连接' : paused ? '继续实时数据' : '暂停实时数据'}
          aria-label={!connected ? '内核未连接' : paused ? '继续实时数据' : '暂停实时数据'}
        >
          <RadioTower size={16} />
          <span className="stream-track">
            <span className="stream-knob" />
          </span>
        </button>
      </nav>

      <div className="topbar-status">
        <span className="topbar-current" key={currentPage} aria-live="polite">{currentPage}</span>
        <button className="command-chip" onClick={() => setCommandOpen(true)} title="全局搜索 (Ctrl+K)" aria-label="全局搜索">
          <Search size={15} />
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
        {isDesktopRuntime() && liveStatus ? (
          <>
            <button
              type="button"
              className={cx('apply-mode-chip', liveStatus.mode === 'live' && 'live')}
              onClick={() => void toggleLiveMode()}
              disabled={Boolean(liveBusy) || !liveStatus.available}
              title={
                !liveStatus.available
                  ? liveStatus.error ?? '实时模式不可用'
                  : liveStatus.mode === 'live'
                    ? liveStatus.currentMatches
                      ? `实时模式（手动应用） · ${liveStatus.liveProfile?.name ?? '本地 profile'}`
                      : liveStatus.error ?? 'Verge 当前 profile 已被切换'
                    : '切换到实时模式'
              }
            >
              {liveStatus.mode === 'live' ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
              {liveStatus.mode === 'live'
                ? liveStatus.currentMatches
                  ? '实时模式'
                  : '实时已暂停'
                : '安全模式'}
            </button>
            {liveStatus.mode === 'live' ? (
              liveStatus.currentMatches ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary apply-to-verge"
                  onClick={() => void applyToVerge()}
                  disabled={Boolean(liveBusy) || !connected}
                  title={
                    !connected
                      ? '内核未连接，无法重载实时配置'
                      : '写入 Clash RuleVis 本地 profile 并重载内核'
                  }
                >
                  <Upload size={13} />
                  {liveBusy === 'apply' ? '应用中…' : '应用到 Clash Verge'}
                  {pending > 0 ? <span className="apply-count">{pending}</span> : null}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary apply-to-verge"
                  onClick={() => void resumeLive()}
                  disabled={Boolean(liveBusy)}
                  title={liveStatus.error ?? '把 Verge 当前 profile 切回 Clash RuleVis 实时 profile'}
                >
                  <RotateCcw size={13} />
                  恢复实时模式
                </button>
              )
            ) : null}
          </>
        ) : null}
        <button
          type="button"
          className="topbar-github"
          title="GitHub 仓库"
          aria-label="打开 GitHub 仓库"
          onClick={() => {
            void openExternal('https://github.com/youbilin/Clash-RuleVis').catch((error) => {
              toast('error', '打开 GitHub 失败', (error as Error).message);
            });
          }}
        >
          <GitHubMark />
        </button>
      </div>
    </header>
  );
}
