import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import type { HistoryEntry, KernelStatus, Workspace } from '../../shared/types';
import { api, copyToClipboard, downloadText } from '../api';
import { Drawer } from './Overlay';
import { Spinner } from './Common';
import { Select } from './Select';
import { useUi, toast } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { useLive } from '../store/live';
import { cx } from '../lib/misc';
import { formatBytes, formatRelative } from '../lib/format';
import { notifyRemoved } from '../lib/undo';

export function SettingsDrawer() {
  const open = useUi((state) => state.settingsOpen);
  if (!open) return null;
  return <SettingsContent />;
}

function SettingsContent() {
  const setOpen = useUi((state) => state.setSettingsOpen);
  const confirm = useUi((state) => state.confirm);
  const workspace = useWorkspace((state) => state.workspace);
  const status = useWorkspace((state) => state.status);
  const update = useWorkspace((state) => state.update);
  const refreshStatus = useWorkspace((state) => state.refreshStatus);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const liveKernel = useLive((state) => state.snapshot?.kernel);
  const kernel: KernelStatus | undefined = liveKernel ?? status?.kernel;

  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'auto' | 'pipe' | 'tcp'>('auto');
  const [endpoint, setEndpoint] = useState('');
  const [secret, setSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [savingKernel, setSavingKernel] = useState(false);
  const [rediscovering, setRediscovering] = useState(false);
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);

  const [testUrl, setTestUrl] = useState(workspace?.settings.testUrl ?? '');
  const [retention, setRetention] = useState(String(workspace?.settings.retentionMinutes ?? 5));
  const [defaultRuleType, setDefaultRuleType] = useState(workspace?.settings.defaultRuleType ?? 'DOMAIN-SUFFIX');
  const [useProxy, setUseProxy] = useState(workspace?.settings.useProxyForFetch ?? true);
  const [copied, setCopied] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [exportStats, setExportStats] = useState<{ count: number; bytes: number; keepDays: number } | null>(null);
  const [cleaningExports, setCleaningExports] = useState(false);
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ count: number; bytes: number; keepDays: number }>('/api/exports/stats')
      .then((data) => {
        if (!cancelled) setExportStats(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ mode: 'auto' | 'pipe' | 'tcp'; endpoint: string; hasSecret: boolean; status: KernelStatus }>(
      '/api/kernel/settings',
    )
      .then((data) => {
        if (cancelled) return;
        setMode(data.mode);
        setEndpoint(data.endpoint);
        setHasSecret(data.hasSecret);
      })
      .catch((error) => {
        toast('error', '读取内核设置失败', (error as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workspace) return;
    setTestUrl(workspace.settings.testUrl);
    setRetention(String(workspace.settings.retentionMinutes));
    setDefaultRuleType(workspace.settings.defaultRuleType);
    setUseProxy(workspace.settings.useProxyForFetch);
  }, [workspace?.settings.testUrl, workspace?.settings.retentionMinutes, workspace?.settings.defaultRuleType, workspace?.settings.useProxyForFetch]);

  const copy = async (label: string, value: string) => {
    await copyToClipboard(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1600);
  };

  const saveKernel = async () => {
    setSavingKernel(true);
    setTestState(null);
    try {
      const payload: Record<string, unknown> = { mode, endpoint };
      if (secret.trim()) payload.secret = secret.trim();
      await api('/api/kernel/settings', { method: 'PUT', body: payload });
      setSecret('');
      setHasSecret((current) => current || Boolean(secret.trim()));
      await refreshStatus();
      toast('success', '内核连接设置已更新');
    } catch (error) {
      toast('error', '保存连接设置失败', (error as Error).message);
    } finally {
      setSavingKernel(false);
    }
  };

  const testConnection = async () => {
    setTestState(null);
    try {
      const result = await api<{ ok: boolean; version?: string; connection?: string; error?: string }>(
        '/api/kernel/test',
        {
          method: 'POST',
          body: { mode, endpoint, secret: secret.trim() || undefined },
        },
      );
      setTestState({
        ok: result.ok,
        message: result.ok
          ? `连接成功 · ${result.version ?? ''} · ${result.connection ?? ''}`
          : result.error ?? '连接失败',
      });
    } catch (error) {
      setTestState({ ok: false, message: (error as Error).message });
    }
  };

  const rediscover = async () => {
    setRediscovering(true);
    setTestState(null);
    try {
      await api('/api/kernel/rediscover', { method: 'POST' });
      await refreshStatus();
      toast('success', '已重新探测内核');
    } catch (error) {
      toast('error', '重新探测失败', (error as Error).message);
    } finally {
      setRediscovering(false);
    }
  };

  const cleanupExportFiles = async () => {
    const stats = exportStats;
    if (!stats) return;
    const confirmed = await confirm({
      title: '清理旧导出文件',
      message: `当前导出目录有 ${stats.count} 个文件，共 ${formatBytes(stats.bytes)}。\n将删除 ${stats.keepDays} 天前且未被历史记录引用的 YAML；最近导出和历史引用的文件会保留。`,
      confirmLabel: '清理',
      danger: true,
    });
    if (!confirmed) return;
    setCleaningExports(true);
    try {
      const result = await api<{
        removed: number;
        freedBytes: number;
        count: number;
        bytes: number;
        keepDays: number;
      }>('/api/exports/cleanup', { method: 'POST', body: { keepDays: stats.keepDays } });
      setExportStats(result);
      if (result.removed) {
        toast('success', `已清理 ${result.removed} 个旧文件`, `释放 ${formatBytes(result.freedBytes)}`);
      } else {
        toast('info', '没有可清理的旧文件');
      }
    } catch (error) {
      toast('error', '清理导出文件失败', (error as Error).message);
    } finally {
      setCleaningExports(false);
    }
  };

  const exportBackup = () => {
    if (!workspace) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = {
      app: 'Clash RuleVis',
      backupVersion: 1,
      workspaceVersion: workspace.version,
      exportedAt: new Date().toISOString(),
      workspace,
    };
    downloadText(`clash-rulevis-backup-${stamp}.json`, JSON.stringify(backup, null, 2));
    toast('success', '工作区备份已导出', '备份包含订阅地址与节点凭据，请只保存在本机');
  };

  const importBackup = async (file: File | undefined) => {
    if (!file || importing) return;
    try {
      const parsed = JSON.parse(await file.text()) as {
        backup?: { workspace?: Workspace; workspaceVersion?: number };
        workspace?: Workspace;
      } & Workspace;
      const candidate = parsed.backup?.workspace ?? parsed.workspace ?? parsed;
      if (!Array.isArray(candidate.sources) || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.exits) || !Array.isArray(candidate.routes)) {
        throw new Error('备份文件结构无效');
      }
      const confirmed = await confirm({
        title: '导入工作区备份',
        message: [
          `将当前工作区替换为「${file.name}」中的配置。`,
          `备份内容：${candidate.sources.length} 个来源 · ${candidate.nodes.length} 个节点 · ${candidate.exits.filter((exit) => !exit.builtin).length} 个出口 · ${candidate.routes.length} 条规则。`,
          '导入前会自动创建当前工作区的快照。',
        ].join('\n\n'),
        confirmLabel: '导入备份',
        danger: true,
      });
      if (!confirmed) return;
      setImporting(true);
      await useWorkspace.getState().saveNow();
      const result = await api<{ workspace: Workspace; undoEntry: HistoryEntry }>('/api/workspace/import', {
        method: 'POST',
        body: { backup: parsed },
      });
      applyServerWorkspace(result.workspace);
      await refreshStatus();
      notifyRemoved(result.undoEntry, '备份已导入', '可通过历史恢复导入前的状态');
      toast('success', '工作区备份已导入', file.name);
    } catch (error) {
      toast('error', '导入备份失败', (error as Error).message);
    } finally {
      setImporting(false);
      if (backupInputRef.current) backupInputRef.current.value = '';
    }
  };

  const savePreferences = () => {
    const minutes = Math.min(60, Math.max(1, Number(retention) || 5));
    update((draft) => {
      draft.settings.testUrl = testUrl.trim() || 'https://www.gstatic.com/generate_204';
      draft.settings.retentionMinutes = minutes;
      draft.settings.defaultRuleType = defaultRuleType as typeof draft.settings.defaultRuleType;
      draft.settings.useProxyForFetch = useProxy;
    });
    setRetention(String(minutes));
    toast('success', '偏好设置已保存');
  };

  return (
    <Drawer
      title="设置"
      subtitle="内核连接、数据位置与工作台偏好"
      onClose={() => setOpen(false)}
      footer={
        <>
          <span className="foot-note">所有设置只保存在本机</span>
          <button className="btn btn-primary" onClick={() => setOpen(false)}>
            完成
          </button>
        </>
      }
    >
      <section className="settings-section">
        <div className="section-title">
          内核连接
          <span className={cx('badge', kernel?.connected ? 'badge-green' : 'badge-red')}>
            {kernel?.connected ? '在线' : '离线'}
          </span>
        </div>
        <div className="settings-summary">
          <div>
            <span className="muted">控制器</span>
            <strong>{kernel?.connected ? kernel.endpoint : '未发现'}</strong>
          </div>
          <div>
            <span className="muted">版本</span>
            <strong>{kernel?.version ?? '—'}</strong>
          </div>
          <div>
            <span className="muted">最近通信</span>
            <strong>{kernel?.lastSeenAt ? formatRelative(kernel.lastSeenAt) : '—'}</strong>
          </div>
        </div>
        {kernel?.error ? <div className="callout warn" style={{ marginTop: 10 }}>{kernel.error}</div> : null}

        {loading ? (
          <div className="loading-block">
            <Spinner /> 正在读取连接设置…
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 14 }}>
            <label className="field">
              <span className="field-label">探测方式</span>
              <Select
                value={mode}
                onChange={(value) => setMode(value as typeof mode)}
                ariaLabel="探测方式"
                options={[
                  { value: 'auto', label: '自动探测（推荐）' },
                  { value: 'tcp', label: '手动 TCP 控制器' },
                  { value: 'pipe', label: '手动命名管道' },
                ]}
              />
              <span className="hint">
                Verge 的控制器通常走命名管道，且每次启动名称可能变化；自动探测会读取配置并枚举当前管道。
              </span>
            </label>
            {mode !== 'auto' ? (
              <label className="field">
                <span className="field-label">控制器地址</span>
                <input
                  className="input mono"
                  placeholder={mode === 'tcp' ? '127.0.0.1:9090' : '\\\\.\\pipe\\verge-mihomo-...'}
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                />
              </label>
            ) : null}
            <label className="field">
              <span className="field-label">
                密钥
                {hasSecret ? <span className="badge badge-green badge-plain">已保存</span> : null}
              </span>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                placeholder="留空沿用 Verge 配置中的 secret"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
            {testState ? (
              <div className={cx('callout', testState.ok ? 'success' : 'danger')}>
                {testState.ok ? <Check size={14} /> : <span className="dot red" />}
                <span>{testState.message}</span>
              </div>
            ) : null}
            <div className="row" style={{ marginTop: 4 }}>
              <button className="btn btn-outline" onClick={testConnection}>
                测试连接
              </button>
              <button className="btn btn-outline" onClick={rediscover} disabled={rediscovering}>
                {rediscovering ? <Spinner /> : <RefreshCw size={13} />}
                重新探测
              </button>
              <span className="spacer" />
              <button className="btn btn-primary" onClick={saveKernel} disabled={savingKernel}>
                {savingKernel ? <Spinner onAccent /> : null}
                保存并连接
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="settings-section">
        <div className="section-title">工作台偏好</div>
        <div className="stack">
          <label className="field">
            <span className="field-label">测速地址</span>
            <input className="input mono" value={testUrl} onChange={(event) => setTestUrl(event.target.value)} />
            <span className="hint">用于 url-test / fallback 出口和手动测速，默认为 generate_204。</span>
          </label>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">连接保留时长</span>
              <div className="inline" style={{ gap: 6 }}>
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={60}
                  value={retention}
                  onChange={(event) => setRetention(event.target.value)}
                  style={{ width: 82 }}
                />
                <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>分钟</span>
              </div>
            </label>
            <label className="field">
              <span className="field-label">拖拽默认规则</span>
              <Select
                value={defaultRuleType}
                onChange={(value) => setDefaultRuleType(value as typeof defaultRuleType)}
                ariaLabel="拖拽默认规则"
                options={[
                  { value: 'DOMAIN-SUFFIX', label: 'DOMAIN-SUFFIX' },
                  { value: 'DOMAIN', label: 'DOMAIN' },
                  { value: 'DOMAIN-KEYWORD', label: 'DOMAIN-KEYWORD' },
                ]}
              />
            </label>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={useProxy} onChange={(event) => setUseProxy(event.target.checked)} />
            <span>
              订阅与规则集直连失败时走内核代理
              <span className="hint">使用当前 mihomo 混合端口重试，适合需要代理才能访问的机场。</span>
            </span>
          </label>
          <button className="btn btn-outline" onClick={savePreferences} style={{ alignSelf: 'flex-start' }}>
            保存偏好
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">数据位置</div>
        <div className="path-row">
          <span className="muted">工作区</span>
          <code>{status?.dataDir ?? '—'}</code>
          <button className="icon-btn" onClick={() => copy('data', status?.dataDir ?? '')} title="复制路径">
            {copied === 'data' ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <div className="path-row">
          <span className="muted">导出目录</span>
          <code>{status?.exportsDir ?? '—'}</code>
          <button className="icon-btn" onClick={() => copy('exports', status?.exportsDir ?? '')} title="复制路径">
            {copied === 'exports' ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <div className="path-row">
          <span className="muted">导出文件</span>
          <code>{exportStats ? `${exportStats.count} 个 · ${formatBytes(exportStats.bytes)}` : '—'}</code>
          <button
            className="inline-link"
            onClick={() => void cleanupExportFiles()}
            disabled={cleaningExports || !exportStats}
            title={`清理 ${exportStats?.keepDays ?? 30} 天前且未被历史引用的 YAML`}
          >
            {cleaningExports ? <Spinner /> : <Trash2 size={11} />} 清理旧文件
          </button>
        </div>
        <div className="settings-backup">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-outline" onClick={exportBackup} disabled={!workspace}>
              <Download size={13} /> 导出工作区 JSON
            </button>
            <button className="btn btn-outline" onClick={() => backupInputRef.current?.click()} disabled={importing}>
              {importing ? <Spinner /> : <Upload size={13} />} 导入备份
            </button>
            <input
              ref={backupInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => void importBackup(event.target.files?.[0])}
            />
          </div>
          <p className="hint">
            备份包含来源、节点凭据、规则与设置，只保存在本机文件；导入会先自动创建当前工作区快照。
          </p>
        </div>
        {status?.vergeProfile ? (
          <div className="callout info" style={{ marginTop: 10 }}>
            <ExternalLink size={14} />
            <span>检测到 Clash Verge 当前配置：<strong>{status.vergeProfile}</strong>，可在节点页一键导入。</span>
          </div>
        ) : null}
      </section>

      <section className="settings-section">
        <div className="section-title">
          <ShieldCheck size={14} /> 本地与安全
        </div>
        <p className="hint" style={{ lineHeight: 1.8 }}>
          本地服务只监听 127.0.0.1，用一次性 Cookie 保护接口。本工具不会改写 Clash Verge 的
          profiles.yaml，也不会重载内核；导出文件只写入上方导出目录。
        </p>
        <p className="hint" style={{ marginTop: 8 }}>路由台 v{status?.version ?? '0.3.3'}</p>
      </section>
    </Drawer>
  );
}
