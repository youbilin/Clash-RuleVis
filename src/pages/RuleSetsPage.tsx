import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ClipboardCopy,
  ExternalLink,
  FileUp,
  Globe,
  Layers,
  Link2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { RuleSetInspect, RuleSetRoute, RulesetBehavior, RulesetFormat, Workspace } from '../../shared/types';
import { providerSlug } from '../../shared/model';
import { RECOMMENDED_RULE_SETS, type RecommendedRuleSet } from '../../shared/recommended';
import { api, copyToClipboard, openExternal } from '../api';
import { useWorkspace } from '../store/workspace';
import { useLive } from '../store/live';
import { useUi, toast } from '../store/ui';
import { EmptyState, PageHeader, Spinner, Switch } from '../components/Common';
import { Select } from '../components/Select';
import { Modal } from '../components/Overlay';
import { formatCompact, formatDateTime, formatRelative } from '../lib/format';
import { baseName, cx, hostFromUrl, repositoryUrl, urlTail } from '../lib/misc';
import { notifyRemoved } from '../lib/undo';
import { exitTypeLabel } from '../lib/labels';
import { useEscape } from '../lib/hooks';

const FORMAT_LABELS: Record<RulesetFormat, string> = { mrs: 'MRS', yaml: 'YAML', text: 'TEXT' };
const BEHAVIOR_LABELS: Record<RulesetBehavior, string> = {
  domain: 'domain',
  ipcidr: 'ipcidr',
  classical: 'classical',
};

export function RuleSetsPage() {
  const workspace = useWorkspace((state) => state.workspace);
  const update = useWorkspace((state) => state.update);
  const createUndoPoint = useWorkspace((state) => state.createUndoPoint);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const confirm = useUi((state) => state.confirm);
  const snapshot = useLive((state) => state.snapshot);
  const navigate = useNavigate();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSource, setWizardSource] = useState<'url' | 'file' | 'recommended'>('url');
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<RuleSetRoute | null>(null);

  const routesets = useMemo(
    () => (workspace?.routes ?? []).filter((route): route is RuleSetRoute => route.kind === 'ruleset'),
    [workspace?.routes],
  );
  const exits = useMemo(
    () => [...(workspace?.exits ?? [])].sort((a, b) => a.order - b.order),
    [workspace?.exits],
  );

  if (!workspace) return null;

  const providerCount = routesets.filter((route) => !route.inline).length;
  const inlineCount = routesets.filter((route) => route.inline).length;
  const liveProviders = snapshot ? Object.keys(snapshot.providers).length : 0;

  const providerFor = (route: RuleSetRoute) => {
    const providers = snapshot?.providers ?? {};
    const slug = providerSlug(route.name);
    return (
      providers[route.name] ??
      providers[slug] ??
      Object.values(providers).find((provider) => provider.name === slug) ??
      null
    );
  };

  const hitsFor = (route: RuleSetRoute) => {
    const key = `${route.name}`;
    const direct = snapshot?.ruleHits[`RULE-SET|${key}`];
    if (typeof direct === 'number') return direct;
    const slug = providerSlug(route.name);
    const bySlug = snapshot?.ruleHits[`RULE-SET|${slug}`];
    if (typeof bySlug === 'number') return bySlug;
    return providerFor(route)?.hitCount ?? 0;
  };

  const refresh = async (route: RuleSetRoute) => {
    setRefreshingId(route.id);
    try {
      const result = await api<{ workspace: Workspace; route: RuleSetRoute }>(
        `/api/rule-sets/${route.id}/refresh`,
        { method: 'POST' },
      );
      applyServerWorkspace(result.workspace);
      toast('success', '规则集已刷新', route.inline ? `已展开 ${result.route.inlineRules?.length ?? 0} 条内联规则` : 'provider 元数据已更新');
    } catch (error) {
      toast('error', '刷新规则集失败', (error as Error).message);
    } finally {
      setRefreshingId(null);
    }
  };

  const remove = async (route: RuleSetRoute) => {
    const confirmed = await confirm({
      title: '删除规则集',
      message: `规则集「${route.name}」将从规则顺序与 rule-providers 中移除。${
        route.sourceId ? '\n\n这是订阅自带内容，刷新订阅后可能重新出现。' : ''
      }`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    const undo = await createUndoPoint('删除规则集 · ' + route.name);
    try {
      const result = await api<{ workspace: Workspace }>(`/api/rule-sets/${route.id}`, { method: 'DELETE' });
      applyServerWorkspace(result.workspace);
      notifyRemoved(undo, '规则集已删除', route.name);
    } catch (error) {
      toast('error', '删除失败', (error as Error).message);
    }
  };

  return (
    <div className="page">
      <PageHeader
        kicker="RULE PROVIDERS"
        title="规则集"
        subtitle={`${routesets.length} 个规则集 · ${providerCount} 个 provider · ${inlineCount} 个内联 · 内核当前加载 ${liveProviders} 个。规则集的匹配顺序在「规则」页调整。`}
        actions={
          <>
            <button className="btn btn-outline" onClick={() => navigate('/rules')}>
              <ArrowRight size={13} /> 去规则排序
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setWizardSource('url');
                setWizardOpen(true);
              }}
            >
              <Plus size={13} /> 添加规则集
            </button>
          </>
        }
      />

      <div className="callout info rulesets-note">
        <Layers size={14} />
        <span>
          URL 规则集写成 <strong>http provider</strong>，由内核定时更新；文件写成 <strong>file provider</strong>；
          小规模文本规则可内联展开成普通规则行，完全确定且不依赖 provider。
        </span>
      </div>

      <div className="ruleset-panel panel">
        <div className="ruleset-head">
          <span>#</span>
          <span>规则集</span>
          <span>出口</span>
          <span>规则 / 命中</span>
          <span>状态</span>
          <span>启用</span>
          <span />
        </div>

        {routesets.length === 0 ? (
          <EmptyState
            icon={<Layers size={20} />}
            title="还没有规则集"
            description="从推荐源、URL 或本地文件导入一批规则，整体指向一个出口。"
            actions={
              <button className="btn btn-primary btn-sm" onClick={() => setWizardOpen(true)}>
                <Plus size={12} /> 添加规则集
              </button>
            }
          />
        ) : (
          routesets.map((route) => {
            const exit = exits.find((item) => item.id === route.exitId);
            const provider = providerFor(route);
            const ruleCount = provider?.ruleCount ?? route.ruleCount ?? route.inlineRules?.length ?? 0;
            const hits = hitsFor(route);
            const index = workspace.routes.findIndex((item) => item.id === route.id) + 1;
            return (
              <div className="ruleset-row" key={route.id}>
                <span className="rule-index mono">{index}</span>
                <div className="ruleset-main">
                  <div className="ruleset-title">
                    <span className="ruleset-icon"><Layers size={12} /></span>
                    <span className="truncate">{route.name}</span>
                    <span className="badge">{BEHAVIOR_LABELS[route.behavior]}</span>
                    <span className="badge">{FORMAT_LABELS[route.format]}</span>
                    {route.inline ? <span className="badge badge-green">内联</span> : <span className="badge badge-blue">PROVIDER</span>}
                  </div>
                  <div className="ruleset-meta">
                    <button
                      type="button"
                      className="ruleset-source-link"
                      onClick={() => setSourceDetail(route)}
                      title="查看完整来源与源仓库"
                    >
                      {route.source.type === 'url' ? <Globe size={10} /> : <FileUp size={10} />}
                      <span className="truncate">
                        {route.source.type === 'url'
                          ? urlTail(route.source.value)
                          : route.source.fileName ?? baseName(route.source.value)}
                      </span>
                    </button>
                    <span className="meta-sep">·</span>
                    <span>{route.inline ? '静态写入 YAML' : `interval ${route.interval ?? 86400}s`}</span>
                  </div>
                </div>
                <div className="ruleset-target">
                  <Select
                    compact
                    className={cx(!exit && 'invalid')}
                    value={route.exitId}
                    onChange={(value) =>
                      update((draft) => {
                        const target = draft.routes.find((item) => item.id === route.id);
                        if (target) target.exitId = value;
                      })
                    }
                    ariaLabel="目标出口"
                    options={[
                      ...(!exit ? [{ value: route.exitId, label: '⚠ 出口已丢失', disabled: true }] : []),
                      ...exits.map((item) => ({ value: item.id, label: item.name })),
                    ]}
                  />
                </div>
                <div className="ruleset-counts">
                  <strong className="mono">{ruleCount ? formatCompact(ruleCount) : '—'}</strong>
                  <span className="mono">命中 {formatCompact(hits)}</span>
                </div>
                <div className="ruleset-status">
                  {route.inline ? (
                    <span className="badge badge-green">内联</span>
                  ) : provider ? (
                    <span className="ruleset-live" title={provider.updatedAt ? `provider 更新于 ${formatDateTime(provider.updatedAt)}` : undefined}>
                      <span className="dot green" /> 内核已加载
                    </span>
                  ) : (
                    <span className="ruleset-offline"><span className="dot red" /> 未进内核</span>
                  )}
                  <span className="ruleset-updated">{route.updatedAt ? formatRelative(new Date(route.updatedAt).getTime()) : '—'}</span>
                </div>
                <div className="ruleset-switch">
                  <Switch
                    checked={route.enabled}
                    onChange={(enabled) =>
                      update((draft) => {
                        const target = draft.routes.find((item) => item.id === route.id);
                        if (target) target.enabled = enabled;
                      })
                    }
                    label="启用规则集"
                  />
                </div>
                <div className="ruleset-actions">
                  <button
                    className="icon-btn"
                    title="查看来源与源仓库"
                    onClick={() => setSourceDetail(route)}
                  >
                    <Globe size={12} />
                  </button>
                  <button
                    className="icon-btn"
                    title="重新下载 / 展开"
                    disabled={refreshingId === route.id}
                    onClick={() => void refresh(route)}
                  >
                    {refreshingId === route.id ? <Spinner /> : <RefreshCw size={12} />}
                  </button>
                  <button className="icon-btn danger" title="删除规则集" onClick={() => void remove(route)}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })
        )}

        <div className="ruleset-foot">
          <span>导入 Verge 配置后，provider 名称与内核一致时可直接看到命中统计。</span>
          <span className="spacer" />
          <button className="inline-link" onClick={() => {
            setWizardSource('recommended');
            setWizardOpen(true);
          }}>
            浏览推荐源
          </button>
        </div>
      </div>

      {sourceDetail ? (
        <Modal
          title="规则集来源"
          subtitle={sourceDetail.name}
          size="md"
          onClose={() => setSourceDetail(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setSourceDetail(null)}>
                关闭
              </button>
              {sourceDetail.source.type === 'url' ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const target = repositoryUrl(sourceDetail.source.value) ?? sourceDetail.source.value;
                    void openExternal(target).catch((error) => {
                      toast('error', '打开来源失败', (error as Error).message);
                    });
                  }}
                >
                  <ExternalLink size={13} />
                  {repositoryUrl(sourceDetail.source.value) ? '打开源仓库' : '打开源地址'}
                </button>
              ) : null}
            </>
          }
        >
          <div className="ruleset-source-dialog">
            <div className="ruleset-source-facts">
              <div>
                <span>provider</span>
                <strong className="mono">{sourceDetail.providerName ?? sourceDetail.name}</strong>
              </div>
              <div>
                <span>类型</span>
                <strong>{BEHAVIOR_LABELS[sourceDetail.behavior]} / {FORMAT_LABELS[sourceDetail.format]}</strong>
              </div>
              <div>
                <span>规则数量</span>
                <strong className="mono">
                  {sourceDetail.ruleCount ?? sourceDetail.inlineRules?.length ?? '—'}
                </strong>
              </div>
              <div>
                <span>运行方式</span>
                <strong>{sourceDetail.inline ? '内联展开' : '内核 provider'}</strong>
              </div>
            </div>
            <div className="ruleset-source-field">
              <span>源地址</span>
              <div className="ruleset-source-value">
                <code>{sourceDetail.source.value}</code>
                <button
                  className="icon-btn"
                  title="复制源地址"
                  aria-label="复制源地址"
                  onClick={() => {
                    void copyToClipboard(sourceDetail.source.value).then(() =>
                      toast('success', '源地址已复制'),
                    );
                  }}
                >
                  <ClipboardCopy size={12} />
                </button>
              </div>
            </div>
            {sourceDetail.source.type === 'url' && repositoryUrl(sourceDetail.source.value) ? (
              <div className="ruleset-source-field">
                <span>源仓库</span>
                <div className="ruleset-source-value">
                  <code>{repositoryUrl(sourceDetail.source.value)}</code>
                  <button
                    className="icon-btn"
                    title="复制仓库地址"
                    aria-label="复制仓库地址"
                    onClick={() => {
                      const repo = repositoryUrl(sourceDetail.source.value);
                      if (!repo) return;
                      void copyToClipboard(repo).then(() => toast('success', '仓库地址已复制'));
                    }}
                  >
                    <ClipboardCopy size={12} />
                  </button>
                </div>
              </div>
            ) : null}
            <div className="hint">
              {sourceDetail.source.type === 'url'
                ? '规则内容由上游仓库维护。打开源地址或源仓库即可查看原始规则。'
                : '本地文件来源没有远程仓库地址，可在导出目录或规则集目录中查看文件。'}
            </div>
          </div>
        </Modal>
      ) : null}

      {wizardOpen ? (
        <RuleSetWizard
          initialTab={wizardSource}
          onClose={() => setWizardOpen(false)}
        />
      ) : null}
    </div>
  );
}

type WizardStep = 'source' | 'confirm';
type SourceTab = 'url' | 'file' | 'recommended';

function guessNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop() ?? '';
    return last.replace(/\.(mrs|ya?ml|txt|list)$/i, '') || new URL(url).hostname;
  } catch {
    return '规则集';
  }
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function RuleSetWizard({ initialTab, onClose }: { initialTab: SourceTab; onClose: () => void }) {
  const workspace = useWorkspace((state) => state.workspace);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const saveNow = useWorkspace((state) => state.saveNow);
  const [step, setStep] = useState<WizardStep>('source');
  const [tab, setTab] = useState<SourceTab>(initialTab);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inspect, setInspect] = useState<RuleSetInspect | null>(null);
  const [name, setName] = useState('');
  const [behavior, setBehavior] = useState<RulesetBehavior>('domain');
  const [format, setFormat] = useState<RulesetFormat>('mrs');
  const [ruleCount, setRuleCount] = useState<number | undefined>();
  const [inline, setInline] = useState(false);
  const [interval, setIntervalValue] = useState('86400');
  const [exitId, setExitId] = useState(
    workspace?.exits.find((exit) => !exit.builtin)?.id ?? 'direct',
  );
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEscape(step === 'confirm' ? () => setStep('source') : onClose);
  if (!workspace) return null;

  const exits = [...workspace.exits].sort((a, b) => a.order - b.order);

  const applyInspect = (result: RuleSetInspect, suggestedName: string) => {
    setInspect(result);
    setName(suggestedName);
    setBehavior(result.behavior);
    setFormat(result.format);
    setRuleCount(result.ruleCount);
    setInline(false);
    setStep('confirm');
    setError('');
  };

  const inspectUrl = async (input: string, suggestedName?: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      setError('请填写规则集 URL');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api<RuleSetInspect>('/api/rule-sets/inspect', {
        method: 'POST',
        body: { url: trimmed },
      });
      applyInspect(result, suggestedName ?? guessNameFromUrl(trimmed));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const inspectFile = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      setError('规则集文件不能超过 10MB');
      return;
    }
    if (!/\.(mrs|ya?ml|txt|list)$/i.test(file.name)) {
      setError('请选择 .mrs / .yaml / .yml / .txt 文件');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const dataBase64 = await fileToBase64(file);
      const result = await api<RuleSetInspect>('/api/rule-sets/inspect', {
        method: 'POST',
        body: { fileName: file.name, dataBase64 },
      });
      applyInspect(result, file.name.replace(/\.(mrs|ya?ml|txt|list)$/i, ''));
      setInspect({ ...result, fileName: file.name });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const chooseRecommended = (item: RecommendedRuleSet) => {
    setUrl(item.url);
    setBehavior(item.behavior);
    setFormat(item.format);
    void inspectUrl(item.url, item.name);
  };

  const create = async () => {
    if (!inspect) return;
    if (!name.trim()) {
      setError('请填写规则集名称');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await saveNow();
      const result = await api<{ workspace: Workspace; route: RuleSetRoute }>('/api/rule-sets/create', {
        method: 'POST',
        body: {
          name: name.trim(),
          sourceType: inspect.sourceType,
          url: inspect.sourceType === 'url' ? inspect.sourceValue : undefined,
          filePath: inspect.sourceType === 'file' ? inspect.sourceValue : undefined,
          fileName: inspect.fileName,
          behavior,
          format,
          exitId,
          inline,
          interval: Math.max(60, Number(interval) || 86400),
        },
      });
      applyServerWorkspace(result.workspace);
      toast(
        'success',
        '规则集已添加',
        inline ? `已内联 ${result.route.inlineRules?.length ?? 0} 条规则` : '已加入工作区；导出后由 provider 拉取',
      );
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const inlineAllowed = Boolean(inspect?.textAvailable) && format !== 'mrs' && !(ruleCount && ruleCount > 500);

  return (
    <Modal
      title="添加规则集"
      subtitle="规则集整体指向一个出口；匹配优先级在规则页调整"
      size="lg"
      onClose={step === 'confirm' ? () => setStep('source') : onClose}
      footer={
        step === 'confirm' ? (
          <>
            <button className="btn btn-ghost" onClick={() => setStep('source')}>上一步</button>
            <button className="btn btn-primary" onClick={() => void create()} disabled={loading}>
              {loading ? <Spinner onAccent /> : <Check size={13} />} 添加规则集
            </button>
          </>
        ) : (
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
        )
      }
    >
      <div className="wizard-steps">
        <div className={cx('wizard-step', step === 'source' && 'active', step === 'confirm' && 'done')}>
          <span className="step-index">1</span>
          <span><strong>选择来源</strong><small>URL / 文件 / 推荐</small></span>
        </div>
        <div className={cx('wizard-step', step === 'confirm' && 'active')}>
          <span className="step-index">2</span>
          <span><strong>识别与确认</strong><small>行为、格式、出口</small></span>
        </div>
      </div>

      {error ? (
        <div className="callout danger" style={{ margin: '12px 0' }}>
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading && step === 'source' ? (
        <div className="wizard-loading">
          <Spinner /> 正在下载并识别规则集…
        </div>
      ) : null}

      {step === 'source' ? (
        <div className="wizard-body">
          <div className="import-tabs">
            <button className={cx('import-tab', tab === 'url' && 'active')} onClick={() => setTab('url')}>
              <Link2 size={13} /> URL
            </button>
            <button className={cx('import-tab', tab === 'file' && 'active')} onClick={() => setTab('file')}>
              <FileUp size={13} /> 本地文件
            </button>
            <button className={cx('import-tab', tab === 'recommended' && 'active')} onClick={() => setTab('recommended')}>
              <Sparkles size={13} /> 推荐源
            </button>
          </div>

          {tab === 'url' ? (
            <div className="wizard-source">
              <label className="field">
                <span className="field-label">规则集 URL</span>
                <input
                  className="input mono"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/geo/geosite/openai.mrs"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void inspectUrl(url);
                  }}
                />
                <span className="hint">支持 text / yaml / mrs；识别 behavior 与 format 后再确认。</span>
              </label>
              <button className="btn btn-primary" onClick={() => void inspectUrl(url)} disabled={loading}>
                {loading ? <Spinner onAccent /> : <Check size={13} />} 识别内容
              </button>
            </div>
          ) : null}

          {tab === 'file' ? (
            <div className="wizard-source">
              <div
                className={cx('dropzone', dragging && 'over')}
                onClick={() => fileRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  const file = event.dataTransfer.files?.[0];
                  if (file) void inspectFile(file);
                }}
              >
                <FileUp size={20} />
                <strong>拖入规则集文件</strong>
                <span>.mrs / .yaml / .yml / .txt / .list，最大 10MB</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".mrs,.yaml,.yml,.txt,.list"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void inspectFile(file);
                  }}
                />
              </div>
              <div className="callout info">
                <Layers size={14} />
                <span>文件会复制到工具自己的 rule-sets 目录，导出时写成 file provider 的绝对路径。内核对本地文件提供者的目录限制尚未在全部版本验证，若加载失败请改用 URL 或内联。</span>
              </div>
            </div>
          ) : null}

          {tab === 'recommended' ? (
            <div className="recommended-grid">
              {RECOMMENDED_RULE_SETS.map((item) => (
                <button className="recommended-card" key={item.id} onClick={() => chooseRecommended(item)}>
                  <div className="recommended-card-top">
                    <span className="recommended-category">{item.category}</span>
                    <span className="badge">{item.format}</span>
                  </div>
                  <strong>{item.name}</strong>
                  <span className="recommended-url mono">{item.url.replace('https://raw.githubusercontent.com/', '')}</span>
                  <span className="recommended-note">{item.note} · {(item.size / 1024).toFixed(1)} KB</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 'confirm' && inspect ? (
        <div className="wizard-body">
          <div className="inspect-summary">
            <div className="inspect-summary-icon"><Check size={16} /></div>
            <div className="grow">
              <strong>{inspect.fileName ?? (inspect.sourceType === 'url' ? hostFromUrl(inspect.sourceValue) : '本地文件')}</strong>
              <div className="inspect-facts">
                <span>{inspect.sourceType === 'url' ? 'URL' : 'FILE'}</span>
                <span className="meta-sep">·</span>
                <span>{FORMAT_LABELS[inspect.format]}</span>
                <span className="meta-sep">·</span>
                <span>{inspect.ruleCount ? `${inspect.ruleCount} 条规则` : 'MRS 无法预读条数'}</span>
              </div>
            </div>
            <button className="btn btn-sm btn-ghost" onClick={() => setStep('source')}>更换</button>
          </div>

          <div className="form-grid">
            <label className="field span-2">
              <span className="field-label">规则集名称</span>
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">behavior</span>
              <Select
                value={behavior}
                onChange={(value) => setBehavior(value as RulesetBehavior)}
                ariaLabel="behavior"
                options={[
                  { value: 'domain', label: 'domain' },
                  { value: 'ipcidr', label: 'ipcidr' },
                  { value: 'classical', label: 'classical' },
                ]}
              />
            </label>
            <label className="field">
              <span className="field-label">format</span>
              <Select
                value={format}
                onChange={(value) => setFormat(value as RulesetFormat)}
                ariaLabel="format"
                options={[
                  { value: 'mrs', label: 'mrs' },
                  { value: 'yaml', label: 'yaml' },
                  { value: 'text', label: 'text' },
                ]}
              />
            </label>
            <label className="field">
              <span className="field-label">目标出口</span>
              <Select
                value={exitId}
                onChange={setExitId}
                ariaLabel="目标出口"
                options={exits.map((exit) => ({
                  value: exit.id,
                  label: `${exit.name} · ${exitTypeLabel(exit.type)}`,
                }))}
              />
            </label>
            <label className="field">
              <span className="field-label">更新间隔（秒）</span>
              <input
                className="input mono"
                type="number"
                min={60}
                value={interval}
                disabled={inline}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
            </label>
          </div>

          <label className={cx('checkbox-row', !inlineAllowed && 'disabled')}>
            <input
              type="checkbox"
              checked={inline}
              disabled={!inlineAllowed}
              onChange={(event) => setInline(event.target.checked)}
            />
            <span>
              内联展开为普通规则
              <span className="hint">
                仅支持文本 / YAML，且不超过 500 条。MRS 为二进制格式，只能作为 provider。
              </span>
            </span>
          </label>

          {behavior === 'classical' && format === 'mrs' ? (
            <div className="callout warn">
              <AlertTriangle size={14} />
              <span>MRS + classical 组合未必被内核支持，建议改用 domain 或 ipcidr。</span>
            </div>
          ) : null}

          {inspect.sample.length ? (
            <div className="sample-preview">
              <div className="eyebrow">SAMPLE · {inspect.sample.length} LINES</div>
              <div className="sample-lines">
                {inspect.sample.map((line, index) => (
                  <div key={index} className="sample-line mono">{line}</div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
