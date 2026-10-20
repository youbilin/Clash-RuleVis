import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  DownloadCloud,
  FileText,
  Link2,
  Plug,
  Upload,
  X,
} from 'lucide-react';
import type { ImportSummary } from '../../shared/types';
import { api } from '../api';
import { Spinner } from './Common';
import { Modal } from './Overlay';
import { useWorkspace } from '../store/workspace';
import { toast } from '../store/ui';
import { parseShareLink, shareNodeDisplayName, shareNodeToProxy } from '../lib/node-link';
import { cx } from '../lib/misc';

type ImportTab = 'subscription' | 'file' | 'paste' | 'manual' | 'verge';
type ManualType = 'ss' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic';

const TABS: Array<{ id: ImportTab; label: string; icon: typeof Link2 }> = [
  { id: 'subscription', label: '订阅', icon: Link2 },
  { id: 'file', label: '文件', icon: FileText },
  { id: 'paste', label: '粘贴', icon: ClipboardPaste },
  { id: 'manual', label: '节点链接', icon: Plug },
  { id: 'verge', label: '从 Verge', icon: DownloadCloud },
];

const MANUAL_TYPES: Array<{ value: ManualType; label: string }> = [
  { value: 'ss', label: 'Shadowsocks' },
  { value: 'vmess', label: 'VMess' },
  { value: 'vless', label: 'VLESS' },
  { value: 'trojan', label: 'Trojan' },
  { value: 'hysteria2', label: 'Hysteria2' },
  { value: 'tuic', label: 'TUIC' },
];

interface ImportResultState {
  label: string;
  added: number;
  deduped: number;
  groups: number;
  rules: number;
  skippedRules: number;
  removed?: number;
  changed?: number;
  warnings: string[];
}

export function ImportSourceDialog({
  initialTab = 'subscription',
  onClose,
}: {
  initialTab?: ImportTab;
  onClose: () => void;
}) {
  const workspace = useWorkspace((state) => state.workspace);
  const saveNow = useWorkspace((state) => state.saveNow);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const [tab, setTab] = useState<ImportTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResultState | null>(null);

  const [subName, setSubName] = useState('');
  const [subUrl, setSubUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileText, setFileText] = useState('');
  const [fileDragging, setFileDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pasteName, setPasteName] = useState('');
  const [pasteText, setPasteText] = useState('');

  const [manualLink, setManualLink] = useState('');
  const manualParse = useMemo(() => {
    const text = manualLink.trim();
    if (!text) return { node: null, error: '', warnings: [] as string[] };
    try {
      const node = parseShareLink(text);
      return { node, error: '', warnings: node.warnings };
    } catch (caught) {
      return { node: null, error: (caught as Error).message, warnings: [] as string[] };
    }
  }, [manualLink]);

  useEffect(() => {
    setError('');
  }, [tab]);

  const runImport = async (request: () => Promise<ImportSummary>, label: string) => {
    setLoading(true);
    setError('');
    try {
      await saveNow();
      if (useWorkspace.getState().saveState === 'error') {
        throw new Error('工作区还有未保存的修改，请先重试保存');
      }
      const response = await request();
      applyServerWorkspace(response.workspace);
      setResult({
        label,
        added: response.added,
        deduped: response.deduped,
        groups: response.groups,
        rules: response.rules,
        skippedRules: response.skippedRules,
        removed: (response as ImportSummary & { removed?: number }).removed,
        changed: (response as ImportSummary & { changed?: number }).changed,
        warnings: response.warnings,
      });
      toast('success', '导入完成', `${label} · 新增 ${response.added} 个节点`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const submitSubscription = () => {
    if (!subUrl.trim()) {
      setError('请填写订阅链接');
      return;
    }
    const name = subName.trim() || (() => {
      try {
        return new URL(subUrl).hostname;
      } catch {
        return '订阅';
      }
    })();
    void runImport(
      () =>
        api<ImportSummary>('/api/sources/subscription', {
          method: 'POST',
          body: { name, url: subUrl.trim() },
        }),
      name,
    );
  };

  const readFile = async (selected: File) => {
    setError('');
    if (selected.size > 20 * 1024 * 1024) {
      setError('文件超过 20MB 上限');
      return;
    }
    if (!/\.(ya?ml|txt)$/i.test(selected.name)) {
      setError('请选择 .yaml / .yml / .txt 配置文件');
      return;
    }
    const text = await selected.text();
    setFile(selected);
    setFileText(text);
    if (!fileName.trim()) setFileName(selected.name.replace(/\.(ya?ml|txt)$/i, ''));
  };

  const submitFile = () => {
    if (!fileText.trim()) {
      setError('请选择配置文件');
      return;
    }
    const name = fileName.trim() || file?.name?.replace(/\.(ya?ml|txt)$/i, '') || '本地配置';
    void runImport(
      () =>
        api<ImportSummary>('/api/sources/file', {
          method: 'POST',
          body: { name, content: fileText },
        }),
      name,
    );
  };

  const submitPaste = () => {
    if (!pasteText.trim()) {
      setError('请粘贴 Clash 配置或 proxies 片段');
      return;
    }
    const name = pasteName.trim() || '粘贴配置';
    void runImport(
      () =>
        api<ImportSummary>('/api/sources/paste', {
          method: 'POST',
          body: { name, content: pasteText },
        }),
      name,
    );
  };

  const submitManual = () => {
    const node = manualParse.node;
    if (!node) {
      setError(manualParse.error || '请粘贴节点链接');
      return;
    }
    const proxy = shareNodeToProxy(node);
    const name = shareNodeDisplayName(node);
    void runImport(
      () =>
        api<ImportSummary>('/api/sources/manual', {
          method: 'POST',
          body: { name, proxy },
        }),
      name,
    );
  };

  const submitVerge = () => {
    void runImport(
      () =>
        api<ImportSummary>('/api/sources/verge', {
          method: 'POST',
          body: {},
        }),
      'Clash Verge 当前配置',
    );
  };

  const submit = () => {
    if (loading) return;
    if (tab === 'subscription') submitSubscription();
    else if (tab === 'file') submitFile();
    else if (tab === 'paste') submitPaste();
    else if (tab === 'manual') submitManual();
    else submitVerge();
  };

  const startAnother = () => {
    setResult(null);
    setError('');
    setSubName('');
    setSubUrl('');
    setFileName('');
    setFile(null);
    setFileText('');
    setPasteName('');
    setPasteText('');
    setManualLink('');
  };

  const actionLabel = tab === 'manual' ? '添加节点' : tab === 'verge' ? '读取 Verge' : '导入';

  return (
    <Modal
      title={result ? '导入完成' : '添加来源'}
      subtitle={result ? result.label : '内容只在本机解析'}
      size="lg"
      onClose={onClose}
      footer={
        result ? (
          <>
            <button className="btn btn-ghost" onClick={startAnother}>继续添加</button>
            <button className="btn btn-primary" onClick={onClose}>完成</button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={loading || (tab === 'manual' && !manualParse.node)}
            >
              {loading ? <Spinner onAccent /> : <Check size={13} />}
              {actionLabel}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="import-result">
          <div className="import-result-hero">
            <div className="export-success-icon"><Check size={20} /></div>
            <div>
              <strong>{result.label}</strong>
              <p>已写入本地工作区，可继续导入或前往节点表查看。</p>
            </div>
          </div>
          <div className="import-result-stats">
            <div><span>新增节点</span><strong className="mono">{result.added}</strong></div>
            <div><span>去重跳过</span><strong className="mono">{result.deduped}</strong></div>
            {result.removed !== undefined ? <div><span>消失节点</span><strong className="mono">{result.removed}</strong></div> : null}
            {result.changed !== undefined ? <div><span>内容变化</span><strong className="mono">{result.changed}</strong></div> : null}
            <div><span>导入出口</span><strong className="mono">{result.groups}</strong></div>
            <div><span>导入规则</span><strong className="mono">{result.rules}</strong></div>
          </div>
          {result.skippedRules ? (
            <div className="callout warn" style={{ marginTop: 10 }}>
              <AlertTriangle size={14} />
              <span>{result.skippedRules} 条规则因为目标出口缺失或类型不支持被跳过。</span>
            </div>
          ) : null}
          {result.warnings.length ? (
            <div className="import-warnings">
              <div className="eyebrow">WARNINGS · {result.warnings.length}</div>
              {result.warnings.slice(0, 12).map((warning) => (
                <div className="import-warning-row" key={warning}>{warning}</div>
              ))}
              {result.warnings.length > 12 ? <div className="import-warning-row">还有 {result.warnings.length - 12} 条提示…</div> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="import-dialog">
          <div className="import-tabs">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={cx('import-tab', tab === item.id && 'active')}
                  onClick={() => {
                    setTab(item.id);
                    setResult(null);
                  }}
                >
                  <Icon size={13} />
                  {item.label}
                </button>
              );
            })}
          </div>

          {error ? (
            <div className="callout danger" style={{ marginTop: 12 }}>
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          ) : null}

          {tab === 'subscription' ? (
            <div className="import-form">
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">来源名称 <span className="optional">可选</span></span>
                  <input className="input" value={subName} onChange={(event) => setSubName(event.target.value)} placeholder="例如：雨燕云" />
                </label>
                <label className="field">
                  <span className="field-label">订阅链接</span>
                  <input
                    className="input mono"
                    value={subUrl}
                    onChange={(event) => setSubUrl(event.target.value)}
                    placeholder="https://example.com/sub"
                  />
                </label>
              </div>
            </div>
          ) : null}

          {tab === 'file' ? (
            <div className="import-form">
              <div
                className={cx('dropzone', fileDragging && 'over')}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setFileDragging(true);
                }}
                onDragLeave={() => setFileDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setFileDragging(false);
                  const selected = event.dataTransfer.files?.[0];
                  if (selected) void readFile(selected);
                }}
              >
                <Upload size={20} />
                <strong>{file ? file.name : '拖入 YAML 配置文件'}</strong>
                <span>{file ? `${(file.size / 1024).toFixed(1)} KB` : '或点击选择 .yaml / .yml / .txt'}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".yaml,.yml,.txt"
                  onChange={(event) => {
                    const selected = event.target.files?.[0];
                    if (selected) void readFile(selected);
                  }}
                />
              </div>
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">来源名称</span>
                  <input className="input" value={fileName} onChange={(event) => setFileName(event.target.value)} />
                </label>
                <div />
              </div>
            </div>
          ) : null}

          {tab === 'paste' ? (
            <div className="import-form">
              <label className="field">
                <span className="field-label">来源名称</span>
                <input className="input" value={pasteName} onChange={(event) => setPasteName(event.target.value)} placeholder="例如：剪贴板节点" />
              </label>
              <label className="field">
                <span className="field-label">配置内容</span>
                <textarea
                  className="textarea"
                  rows={9}
                  value={pasteText}
                  onChange={(event) => setPasteText(event.target.value)}
                  placeholder={'proxies:\n  - name: 日本 01\n    type: ss\n    server: ...'}
                />
              </label>
            </div>
          ) : null}

          {tab === 'manual' ? (
            <div className="import-form manual-link-form">
              <label className="field">
                <span className="field-label">节点链接</span>
                <div className="input-with-action">
                  <input
                    className="input mono"
                    autoFocus
                    value={manualLink}
                    onChange={(event) => {
                      setManualLink(event.target.value);
                      if (error) setError('');
                    }}
                    placeholder="粘贴 ss://、vmess://、vless://、trojan://、hysteria2:// 或 tuic:// 链接"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="节点分享链接"
                    title={manualLink || undefined}
                  />
                  {manualLink ? (
                    <button
                      className="icon-btn"
                      type="button"
                      onClick={() => {
                        setManualLink('');
                        setError('');
                      }}
                      aria-label="清空分享链接"
                    >
                      <X size={12} />
                    </button>
                  ) : null}
                </div>
              </label>

              {manualParse.node ? (
                <div className="manual-preview">
                  <div className="manual-preview-main">
                    <span className="badge badge-green">
                      {MANUAL_TYPES.find((item) => item.value === manualParse.node?.type)?.label ?? manualParse.node.type}
                    </span>
                    <strong className="truncate">{shareNodeDisplayName(manualParse.node)}</strong>
                    <span className="manual-preview-addr mono">{manualParse.node.server}:{manualParse.node.port}</span>
                  </div>
                  <div className="manual-preview-meta">
                    {manualParse.node.tls ? 'TLS' : '无 TLS'}
                    <span>·</span>
                    {manualParse.node.network.toUpperCase()}
                    {manualParse.node.sni ? <><span>·</span>SNI {manualParse.node.sni}</> : null}
                  </div>
                  {manualParse.warnings.length ? (
                    <div className="manual-preview-warn">{manualParse.warnings[0]}</div>
                  ) : null}
                </div>
              ) : manualParse.error ? (
                <div className="manual-link-error">{manualParse.error}</div>
              ) : (
                <p className="hint">粘贴后自动识别，不需要填写协议或参数。</p>
              )}
            </div>
          ) : null}

          {tab === 'verge' ? (
            <div className="import-form">
              <div className="verge-import-panel">
                <div className="verge-import-icon"><DownloadCloud size={18} /></div>
                <div>
                  <strong>Clash Verge 当前配置</strong>
                  <p>
                    {workspace?.sources.some((source) => source.type === 'verge')
                      ? '工作区已经有一个 Verge 来源，再次读取会按节点去重并更新差异。'
                      : '直接读取 Verge 正在使用的配置，把节点和策略组复制到工作区，不修改原文件。'}
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
