import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  Download,
  FileOutput,
  GitCompare,
  History,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  X,
} from 'lucide-react';
import type {
  ExportCounts,
  ExportPreview,
  ExportResult,
  HistoryEntry,
  HistorySummary,
  KernelValidation,
  Workspace,
} from '../../shared/types';
import { ApiError, api, copyToClipboard, downloadText } from '../api';
import { useWorkspace } from '../store/workspace';
import { useUi, toast } from '../store/ui';
import { EmptyState, PageHeader, Spinner, Switch } from '../components/Common';
import { YamlView, DiffView } from '../components/CodeView';
import { Modal, useDialogFocus } from '../components/Overlay';
import { formatBytes, formatDateTime, formatRelative } from '../lib/format';
import { useBodyLock, useEscape } from '../lib/hooks';
import { baseName, cx } from '../lib/misc';
import { notifyRemoved } from '../lib/undo';

type ExportTab = 'yaml' | 'diff';

export function ExportPage() {
  const workspace = useWorkspace((state) => state.workspace);
  const status = useWorkspace((state) => state.status);
  const saveNow = useWorkspace((state) => state.saveNow);
  const update = useWorkspace((state) => state.update);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const refreshStatus = useWorkspace((state) => state.refreshStatus);
  const confirm = useUi((state) => state.confirm);
  const [params] = useSearchParams();
  const historyFocusId = params.get('history');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [previewError, setPreviewError] = useState('');
  const [tab, setTab] = useState<ExportTab>('yaml');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [validation, setValidation] = useState<KernelValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [success, setSuccess] = useState<{
    path: string;
    counts: ExportCounts;
  } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exportName, setExportName] = useState('');
  const [exportIntent, setExportIntent] = useState<'export' | 'verge'>('export');
  const [shareInfo, setShareInfo] = useState<{
    url: string;
    schemeUrl: string;
    expiresAt: string;
    opened: boolean;
  } | null>(null);
  const [viewing, setViewing] = useState<{ entry: HistoryEntry; yaml: string } | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const requestId = useRef(0);
  const historyMenuRef = useRef<HTMLDivElement | null>(null);
  const detailsRef = useRef<HTMLElement | null>(null);

  useBodyLock(detailsOpen);
  useEscape(() => setDetailsOpen(false), detailsOpen);
  useEscape(() => setHistoryMenuOpen(false), historyMenuOpen);
  useDialogFocus(detailsRef, detailsOpen);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const result = await api<{ entries: HistoryEntry[] }>('/api/history');
      setHistory(result.entries);
    } catch (error) {
      toast('error', '读取导出历史失败', (error as Error).message);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  const loadPreview = useCallback(async (flush = true) => {
    const id = ++requestId.current;
    setLoadingPreview(true);
    setPreviewError('');
    try {
      if (flush) await saveNow();
      if (useWorkspace.getState().saveState === 'error') {
        throw new Error('工作区保存失败，预览可能不是最新状态');
      }
      const result = await api<ExportPreview>('/api/export/preview');
      if (requestId.current === id) setPreview(result);
    } catch (error) {
      if (requestId.current === id) setPreviewError((error as Error).message);
    } finally {
      if (requestId.current === id) setLoadingPreview(false);
    }
  }, [saveNow]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!workspace) return;
    const timer = window.setTimeout(() => void loadPreview(), 400);
    return () => window.clearTimeout(timer);
  }, [
    workspace?.revision,
    workspace?.nodes.length,
    workspace?.exits.length,
    workspace?.routes.length,
    workspace?.lastExport?.id,
    workspace?.settings.includeBaseTemplate,
  ]);

  useEffect(() => {
    setValidation(null);
  }, [preview?.yaml]);

  if (!workspace) return null;

  const errors = preview?.issues.filter((issue) => issue.severity === 'error') ?? [];
  const warnings = preview?.issues.filter((issue) => issue.severity === 'warning') ?? [];
  const hasDiff = Boolean(preview?.diff && /^[+-](?!\+\+|--)/m.test(preview.diff));
  const includeBase = workspace.settings.includeBaseTemplate !== false;
  const baseIncluded = Boolean(preview?.baseSettings?.included);
  const neverExported = !workspace.lastExport;
  const exportStatusText = neverExported
    ? '尚未导出'
    : workspace.lastExport
      ? `上次导出 ${formatRelative(new Date(workspace.lastExport.at).getTime())}`
      : '';
  const dirtySinceExport = neverExported
    ? true
    : preview
      ? hasDiff
      : workspace.revision > (workspace.lastExport?.revision ?? 0);
  const counts = preview?.counts;
  const selectedHistory = history.find((entry) => entry.id === selectedHistoryId) ?? null;

  const openExportConfirm = () => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    setExportName(
      `clash-rulevis-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.yaml`,
    );
    setConfirmOpen(true);
  };

  const normalizeExportName = (value: string) => {
    const stem = value
      .trim()
      .replace(/\.ya?ml$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 80);
    return stem ? `${stem}.yaml` : '';
  };

  const exportNow = async (intent: 'export' | 'verge') => {
    const fileName = normalizeExportName(exportName);
    if (!fileName) {
      toast('error', '文件名无效', '请输入至少一个字符');
      return;
    }
    setExportIntent(intent);
    setExporting(true);
    try {
      await saveNow();
      if (useWorkspace.getState().saveState === 'error') {
        throw new Error('工作区尚未保存，已取消导出');
      }
      const result = await api<ExportResult>('/api/export', {
        method: 'POST',
        body: { fileName },
      });
      applyServerWorkspace(result.workspace);
      setValidation(result.validation ?? null);
      setShareInfo(null);
      setConfirmOpen(false);
      setSuccess({
        path: result.path,
        counts: result.counts,
      });
      await Promise.all([loadPreview(false), loadHistory(), refreshStatus()]);
      if (intent === 'verge') {
        await importToVerge(result.path);
      } else {
        toast('success', 'YAML 已导出', result.path);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        const payload = error.payload as { preview?: ExportPreview; validation?: KernelValidation };
        if (payload.preview) setPreview(payload.preview);
        if (payload.validation) setValidation(payload.validation);
      }
      toast('error', '导出失败', (error as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const importToVerge = async (path: string) => {
    try {
      const result = await api<{
        url: string;
        schemeUrl: string;
        expiresAt: string;
        opened: boolean;
      }>('/api/exports/import-to-verge', {
        method: 'POST',
        body: { path },
      });
      setShareInfo(result);
      if (result.opened) {
        toast('success', '已发送到 Clash Verge', '如未出现导入窗口，可复制下方地址手动添加');
      } else {
        toast('warn', '请手动导入', '已生成临时订阅地址，复制到 Clash Verge 添加配置');
      }
    } catch (error) {
      toast('error', '导入 Clash Verge 失败', (error as Error).message);
    }
  };

  const runValidation = async () => {
    setValidating(true);
    try {
      await saveNow();
      const result = await api<{ validation: KernelValidation }>('/api/export/validate', {
        method: 'POST',
      });
      setValidation(result.validation);
      if (!result.validation.available) {
        toast('warn', '内核校验不可用', result.validation.error);
      } else if (!result.validation.ok) {
        toast('error', '内核校验未通过', '请查看校验输出并修复配置');
      } else {
        toast('success', '内核校验通过', `${result.validation.binary ?? 'mihomo'} · ${result.validation.durationMs ?? 0}ms`);
      }
    } catch (error) {
      toast('error', '运行内核校验失败', (error as Error).message);
    } finally {
      setValidating(false);
    }
  };

  const toggleBaseTemplate = (checked: boolean) => {
    update((draft) => {
      draft.settings.includeBaseTemplate = checked;
    });
    setValidation(null);
  };

  const createSnapshot = async () => {
    setSnapshotting(true);
    try {
      await saveNow();
      await api('/api/history/snapshot', { method: 'POST' });
      await loadHistory();
      toast('success', '已创建手动快照');
    } catch (error) {
      toast('error', '创建快照失败', (error as Error).message);
    } finally {
      setSnapshotting(false);
    }
  };

  const viewHistoryExport = async (entry: HistoryEntry) => {
    if (!entry.exportPath) return;
    try {
      const result = await api<{ entry: HistoryEntry; yaml: string }>(`/api/history/${entry.id}/export`);
      setViewing(result);
    } catch (error) {
      toast('error', '读取历史 YAML 失败', (error as Error).message);
    }
  };

  const restore = async (entry: HistoryEntry) => {
    await saveNow();
    let summary: HistorySummary | null = null;
    try {
      const result = await api<{ summary: HistorySummary }>(`/api/history/${entry.id}/summary`);
      summary = result.summary;
    } catch {
      summary = null;
    }
    const summaryLines = summary
      ? [
          `恢复后：节点 ${summary.snapshot.nodes} · 出口 ${summary.snapshot.exits} · 规则 ${summary.snapshot.rules}`,
          `当前：节点 ${summary.current.nodes} · 出口 ${summary.current.exits} · 规则 ${summary.current.rules}`,
        ].join('\n')
      : '';
    const confirmed = await confirm({
      title: '恢复工作区',
      message: [
        `将当前工作区替换为「${entry.label}」的快照（${formatDateTime(entry.at)}）。`,
        summaryLines,
        '当前配置会被覆盖，建议先创建一个手动快照。',
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmLabel: '恢复此快照',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await api<{ workspace: Workspace; undoEntry: HistoryEntry }>(
        `/api/history/${entry.id}/restore`,
        { method: 'POST' },
      );
      applyServerWorkspace(result.workspace);
      await Promise.all([loadPreview(false), loadHistory()]);
      setHistoryMenuOpen(false);
      setSelectedHistoryId(null);
      notifyRemoved(result.undoEntry, '工作区已恢复', entry.label);
    } catch (error) {
      toast('error', '恢复失败', (error as Error).message);
    }
  };

  useEffect(() => {
    if (!errors.length && !previewError) return;
    setDetailsOpen(true);
  }, [errors.length, previewError]);

  useEffect(() => {
    if (!historyFocusId || loadingHistory) return;
    setSelectedHistoryId(historyFocusId);
    setHistoryMenuOpen(true);
  }, [historyFocusId, loadingHistory]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!historyMenuRef.current?.contains(event.target as Node)) setHistoryMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [historyMenuOpen]);

  useEffect(() => {
    if (!historyMenuOpen || !selectedHistoryId) return;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`.export-history-option[data-history-id="${selectedHistoryId}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, [historyMenuOpen, selectedHistoryId, history]);

  useEffect(() => {
    if (selectedHistoryId && !history.some((entry) => entry.id === selectedHistoryId)) {
      setSelectedHistoryId(null);
    }
  }, [history, selectedHistoryId]);

  const onHistoryKeyDown = (event: ReactKeyboardEvent) => {
    if (!history.length) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!historyMenuOpen) setHistoryMenuOpen(true);
    const currentIndex = history.findIndex((entry) => entry.id === selectedHistoryId);
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = history.length - 1;
    else if (currentIndex < 0) next = event.key === 'ArrowDown' ? 0 : history.length - 1;
    else next = (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + history.length) % history.length;
    setSelectedHistoryId(history[next].id);
  };

  return (
    <div className="page export-page">
      <PageHeader
        kicker="EXPORT / SAFE MODE"
        title="导出"
        subtitle={`完整 YAML · 安全模式只写入工具目录 · ${exportStatusText}${!neverExported && dirtySinceExport ? ' · 有未导出的改动' : ''}`}
        actions={
          <>
            <div className="export-history-select" ref={historyMenuRef}>
              <button
                className={cx('btn btn-outline', historyMenuOpen && 'active')}
                onClick={() => setHistoryMenuOpen((open) => !open)}
                onKeyDown={onHistoryKeyDown}
                aria-expanded={historyMenuOpen}
                aria-haspopup="dialog"
              >
                <History size={13} /> 历史快照
                <span className="number-badge">{history.length}</span>
                <ChevronDown size={12} />
              </button>
              {historyMenuOpen ? (
                <div className="export-history-menu" role="dialog" aria-label="历史快照" onKeyDown={onHistoryKeyDown}>
                  <div className="export-history-menu-head">
                    <span>选择快照后恢复 · ↑↓ 选择</span>
                    <button className="btn btn-sm btn-outline" onClick={() => void createSnapshot()} disabled={snapshotting}>
                      {snapshotting ? <Spinner /> : <Camera size={12} />} 创建工作区快照
                    </button>
                  </div>
                  <div className="export-history-menu-list" role="listbox" aria-label="历史快照列表">
                    {loadingHistory ? (
                      <div className="export-history-menu-note"><Spinner /> 读取历史…</div>
                    ) : history.length ? (
                      history.map((entry) => {
                        const active = selectedHistoryId === entry.id;
                        return (
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={cx('export-history-option', active && 'selected')}
                            key={entry.id}
                            data-history-id={entry.id}
                            onClick={() => setSelectedHistoryId(entry.id)}
                          >
                            <span className={cx('history-kind', entry.kind)}>
                              {entry.kind === 'export' ? 'EXPORT' : entry.kind === 'restore' ? 'RESTORE' : 'SNAPSHOT'}
                            </span>
                            <span className="export-history-option-copy">
                              <strong className="truncate" title={entry.label}>{entry.label}</strong>
                              <span className="truncate">
                                {formatRelative(new Date(entry.at).getTime())}
                                {entry.counts ? ` · ${entry.counts.nodes} 节点 · ${entry.counts.rules} 规则` : ''}
                                {entry.fileName ? ` · ${baseName(entry.fileName)}` : ''}
                              </span>
                            </span>
                            {active ? <Check size={13} className="export-history-check" /> : null}
                          </button>
                        );
                      })
                    ) : (
                      <div className="export-history-menu-note">还没有历史记录。创建工作区快照或导出配置后会显示在这里。</div>
                    )}
                  </div>
                  <div className="export-history-menu-foot">
                    <span className="export-history-selection truncate" title={selectedHistory?.label}>
                      {selectedHistory ? `已选择：${selectedHistory.label}` : '选择一个快照'}
                    </span>
                    {selectedHistory?.exportPath ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setHistoryMenuOpen(false);
                          void viewHistoryExport(selectedHistory);
                        }}
                      >
                        <FileOutput size={11} /> 查看 YAML
                      </button>
                    ) : null}
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => selectedHistory && void restore(selectedHistory)}
                      disabled={!selectedHistory}
                    >
                      <RotateCcw size={11} /> 恢复
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <button
              className={cx('btn btn-outline', detailsOpen && 'active')}
              onClick={() => setDetailsOpen((open) => !open)}
              aria-expanded={detailsOpen}
              aria-controls="export-details"
            >
              <SlidersHorizontal size={13} /> 导出详情
              {errors.length ? <span className="export-error-count">{errors.length}</span> : null}
            </button>
            <button className="btn btn-primary" onClick={openExportConfirm} disabled={exporting || Boolean(errors.length) || loadingPreview}>
              {exporting ? <Spinner onAccent /> : <FileOutput size={13} />} 导出配置
            </button>
          </>
        }
      />

      <section className="panel yaml-panel">
        <div className="yaml-toolbar">
          <div className="tabs" style={{ borderBottom: 0 }}>
            <button className={cx('tab', tab === 'yaml' && 'active')} onClick={() => setTab('yaml')}>
              完整 YAML
            </button>
            <button className={cx('tab', tab === 'diff' && 'active')} onClick={() => setTab('diff')}>
              与上次的差异 {hasDiff ? <span className="diff-dot" /> : null}
            </button>
          </div>
          <span className="spacer" />
          {preview ? <span className="yaml-file mono truncate" title={preview.fileName}>{preview.fileName}</span> : null}
          <button className="icon-btn" title="刷新预览" onClick={() => void loadPreview()} disabled={loadingPreview}>
            <RefreshCw size={13} />
          </button>
          <button
            className="icon-btn"
            title="复制 YAML"
            disabled={!preview}
            onClick={() => preview && void copyToClipboard(preview.yaml)}
          >
            <ClipboardCopy size={13} />
          </button>
          <button
            className="icon-btn"
            title="下载 YAML"
            disabled={!preview}
            onClick={() => preview && downloadText(preview.fileName, preview.yaml)}
          >
            <Download size={13} />
          </button>
        </div>

        <div className="yaml-content">
          {loadingPreview && !preview ? (
            <div className="loading-block"><Spinner /> 正在生成 YAML…</div>
          ) : previewError && !preview ? (
            <div className="empty-state">
              <AlertTriangle size={20} />
              <h3>预览生成失败</h3>
              <p>{previewError}</p>
              <button className="btn btn-outline btn-sm" onClick={() => void loadPreview()}>重试</button>
            </div>
          ) : preview ? (
            tab === 'yaml' ? (
              <YamlView yaml={preview.yaml} />
            ) : preview.diff ? (
              hasDiff ? (
                <DiffView diff={preview.diff} />
              ) : (
                <EmptyState
                  icon={<GitCompare size={20} />}
                  title="与上次导出完全一致"
                  description="当前配置和上一次导出的 YAML 没有差异。"
                />
              )
            ) : (
              <EmptyState
                icon={<GitCompare size={20} />}
                title="还没有可对比的历史"
                description="完成第一次导出后，这里会显示与上一版的差异。"
              />
            )
          ) : null}
        </div>

        <div className="yaml-foot">
          <span className="mono">{preview ? `${preview.yaml.split('\n').length} 行 · ${formatBytes(new Blob([preview.yaml]).size)}` : ''}</span>
          <span className="spacer" />
          <span>导出前请确认 YAML 中不包含你不想写入的节点</span>
        </div>
      </section>

      {detailsOpen
        ? createPortal(
            <div
              className="export-details-layer"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setDetailsOpen(false);
              }}
            >
              <aside
                ref={detailsRef}
                id="export-details"
                className="export-details-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="export-details-title"
              >
                <div className="export-details-head">
                  <div>
                    <div className="export-details-title" id="export-details-title">导出详情</div>
                    <div className="export-details-sub">配置校验 · 配置规模 · 基础设置 · 内核校验</div>
                  </div>
                  <button className="icon-btn" onClick={() => setDetailsOpen(false)} aria-label="关闭导出详情">
                    <X size={15} />
                  </button>
                </div>
                <div className="export-details-scroll">
                  <section className={cx('panel export-card', errors.length > 0 && 'validation-alert')}>
                    <div className="panel-header">
                      <div className="panel-title"><ShieldCheck size={13} /> 配置校验</div>
                      <span className={cx('badge', errors.length ? 'badge-red' : warnings.length ? 'badge-amber' : 'badge-green')}>
                        {errors.length ? `${errors.length} 错误` : warnings.length ? `${warnings.length} 警告` : '通过'}
                      </span>
                    </div>
                    <div className="validation-list">
                      {loadingPreview ? (
                        <div className="loading-block"><Spinner /> 正在校验…</div>
                      ) : previewError ? (
                        <div className="callout danger"><AlertTriangle size={14} /><span>{previewError}</span></div>
                      ) : preview?.issues.length ? (
                        preview.issues.map((issue, index) => (
                          <div className={cx('validation-item', issue.severity)} key={`${issue.code}-${issue.message}-${index}`}>
                            <span className="validation-dot" />
                            <div>
                              <div>{issue.message}</div>
                              {issue.severity === 'error' ? <span className="validation-tag">阻止导出</span> : null}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="validation-empty">
                          <CheckCircle2 size={15} />
                          所有出口、成员、规则集与 MATCH 均通过检查。
                        </div>
                      )}
                    </div>
                    {errors.length ? (
                      <div className="validation-foot">
                        <AlertTriangle size={12} /> 修复错误后才能导出。
                      </div>
                    ) : null}
                  </section>

                  <section className="panel export-card">
                    <div className="panel-header">
                      <div className="panel-title"><FileOutput size={13} /> 配置规模</div>
                      {preview?.previousExportAt ? (
                        <span className="faint" style={{ fontSize: 9 }}>对比 {formatDateTime(preview.previousExportAt)}</span>
                      ) : null}
                    </div>
                    <div className="export-counts">
                      <div><span>节点</span><strong className="mono">{counts?.nodes ?? '—'}</strong></div>
                      <div><span>出口</span><strong className="mono">{counts?.exits ?? '—'}</strong></div>
                      <div><span>规则集</span><strong className="mono">{counts?.providers ?? '—'}</strong></div>
                      <div><span>规则行</span><strong className="mono">{counts?.rules ?? '—'}</strong></div>
                    </div>
                    <div className="export-path">
                      <span className="muted">导出目录</span>
                      <code title={status?.exportsDir}>{status?.exportsDir ?? '—'}</code>
                      <button className="icon-btn" title="复制路径" onClick={() => copyToClipboard(status?.exportsDir ?? '')}>
                        <ClipboardCopy size={12} />
                      </button>
                    </div>
                  </section>

                  <section className="panel export-card base-card">
                    <div className="panel-header">
                      <div className="panel-title"><Settings2 size={13} /> 基础设置</div>
                      <span className={cx('badge', includeBase && baseIncluded ? 'badge-green' : 'badge-amber')}>
                        {includeBase && baseIncluded ? '已合并' : '未合并'}
                      </span>
                    </div>
                    <div className="base-card-body">
                      <div className="base-switch-row">
                        <div>
                          <strong>合并 Verge 端口 / DNS / TUN</strong>
                          <span>读取当前运行时基础键，让导出的配置可以直接切换</span>
                        </div>
                        <Switch checked={includeBase} onChange={toggleBaseTemplate} label="合并 Verge 基础设置" />
                      </div>
                    </div>
                  </section>

                  <section className="panel export-card validator-card">
                    <div className="panel-header">
                      <div className="panel-title"><Terminal size={13} /> 内核校验</div>
                      <span
                        className={cx(
                          'badge',
                          validating
                            ? ''
                            : !validation
                              ? ''
                              : !validation.available
                                ? 'badge-amber'
                                : validation.ok
                                  ? 'badge-green'
                                  : 'badge-red',
                        )}
                      >
                        {validating ? '校验中' : !validation ? '未运行' : !validation.available ? '不可用' : validation.ok ? '通过' : '失败'}
                      </span>
                    </div>
                    <div className="validator-body">
                      <div className="validator-row">
                        <div>
                          <strong>{validation?.available && validation.ok ? 'mihomo 已接受这份配置' : '导出前用 mihomo -t 检查'}</strong>
                          <span className="hint">
                            {validation?.available
                              ? `${validation.binary ?? 'mihomo'} · ${validation.durationMs ?? 0}ms`
                              : '导出时会自动运行；这里可以提前检查语法、引用与基础设置。'}
                          </span>
                        </div>
                        <button className="btn btn-sm btn-outline" onClick={() => void runValidation()} disabled={validating}>
                          {validating ? <Spinner /> : <RefreshCw size={12} />}
                          {validation ? '重新校验' : '运行校验'}
                        </button>
                      </div>
                      {validation && !validation.available ? (
                        <div className="validator-unavailable">{validation.error ?? '未找到 mihomo 可执行文件'}</div>
                      ) : null}
                      {validation?.available && !validation.ok ? (
                        <pre className="validator-output">{validation.output || validation.error || '内核校验失败'}</pre>
                      ) : null}
                      {validation?.available && validation.ok ? (
                        <div className="validator-pass"><CheckCircle2 size={13} /> 语法、引用与基础设置均通过内核校验</div>
                      ) : null}
                    </div>
                  </section>
                </div>
              </aside>
            </div>,
            document.body,
          )
        : null}

      {confirmOpen ? (
        <Modal
          title="导出配置"
          subtitle="写入工具目录，不会修改 Clash Verge 配置"
          size="sm"
          closeOnBackdrop={!exporting}
          hideClose={exporting}
          onClose={() => {
            if (!exporting) setConfirmOpen(false);
          }}
          footer={
            <>
              <button
                className="btn btn-outline"
                onClick={() => void exportNow('export')}
                disabled={exporting}
              >
                {exporting && exportIntent === 'export' ? <Spinner /> : <FileOutput size={13} />} 确认导出
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void exportNow('verge')}
                disabled={exporting}
              >
                {exporting && exportIntent === 'verge' ? <Spinner onAccent /> : <Download size={13} />} 导入到 Clash Verge
              </button>
            </>
          }
        >
          <div className="export-confirm">
            <label className="field">
              <span className="field-label">文件名</span>
              <input
                className="input"
                value={exportName}
                spellCheck={false}
                autoFocus
                onChange={(event) => setExportName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void exportNow('export');
                }}
              />
            </label>
            <div className="export-confirm-meta">
              <span>节点 {preview?.counts.nodes ?? '—'}</span>
              <span>出口 {preview?.counts.exits ?? '—'}</span>
              <span>规则集 {preview?.counts.providers ?? '—'}</span>
              <span>规则 {preview?.counts.rules ?? '—'}</span>
            </div>
          </div>
        </Modal>
      ) : null}

      {success ? (
        <Modal
          title="导出完成"
          subtitle="文件已写入工具目录，Verge 配置未发生任何变化"
          size="sm"
          onClose={() => setSuccess(null)}
          footer={
            <button className="btn btn-primary" onClick={() => setSuccess(null)}>
              完成
            </button>
          }
        >
          <div className="export-success-panel">
            <div className="export-success-icon"><Check size={22} /></div>
            <h3>YAML 已保存</h3>
            <p>节点 {success.counts.nodes} · 出口 {success.counts.exits} · 规则集 {success.counts.providers} · 规则 {success.counts.rules}</p>
            <div className="export-success-path">
              <code>{success.path}</code>
              <button
                className="icon-btn"
                title="复制文件路径"
                aria-label="复制文件路径"
                onClick={() => {
                  void copyToClipboard(success.path).then(() => toast('success', '文件路径已复制'));
                }}
              >
                <ClipboardCopy size={12} />
              </button>
            </div>
            {shareInfo ? (
              <div className="export-share">
                <div className="export-share-head">
                  <span>临时订阅地址</span>
                  <span className="faint">30 分钟内有效</span>
                </div>
                <div className="export-share-row">
                  <code>{shareInfo.url}</code>
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={() => {
                      void copyToClipboard(shareInfo.url).then(() => toast('success', '订阅地址已复制'));
                    }}
                  >
                    <ClipboardCopy size={12} /> 复制
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {viewing ? (
        <Modal
          title="历史 YAML"
          subtitle={`${viewing.entry.label} · ${formatDateTime(viewing.entry.at)}`}
          size="xl"
          onClose={() => setViewing(null)}
          footer={
            <>
              <button className="btn btn-outline" onClick={() => copyToClipboard(viewing.yaml)}>
                <ClipboardCopy size={13} /> 复制
              </button>
              <button
                className="btn btn-outline"
                onClick={() => downloadText(viewing.entry.fileName ?? 'clash-export.yaml', viewing.yaml)}
              >
                <Download size={13} /> 下载
              </button>
              <button className="btn btn-primary" onClick={() => setViewing(null)}>关闭</button>
            </>
          }
        >
          <YamlView yaml={viewing.yaml} maxHeight="60vh" />
        </Modal>
      ) : null}
    </div>
  );
}
