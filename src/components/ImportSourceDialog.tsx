import { useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  DownloadCloud,
  FileText,
  Link2,
  Plug,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import type { ImportSummary } from '../../shared/types';
import { api, isDesktopRuntime } from '../api';
import { Spinner } from './Common';
import { Modal } from './Overlay';
import { useWorkspace } from '../store/workspace';
import { toast } from '../store/ui';
import { parseShareLink, shareNodeDisplayName, shareNodeToProxy } from '../lib/node-link';
import { cx } from '../lib/misc';

type RowKind = 'empty' | 'subscription' | 'yaml' | 'links' | 'unknown';

interface ImportRow {
  id: string;
  value: string;
  fileName?: string;
  error?: string;
}

const KIND_META: Record<RowKind, { label: string; icon: typeof Link2 }> = {
  empty: { label: '新来源', icon: ClipboardPaste },
  subscription: { label: '订阅链接', icon: Link2 },
  yaml: { label: 'YAML 配置', icon: FileText },
  links: { label: '节点链接', icon: Plug },
  unknown: { label: '来源', icon: ClipboardPaste },
};

function detectKind(value: string): RowKind {
  const text = value.trim();
  if (!text) return 'empty';
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 1 && /^https?:\/\/\S+$/i.test(lines[0])) return 'subscription';
  const shareLink = /^(ssr?|vmess|vless|trojan|hysteria2?|hy2|tuic|socks5?):\/\//i;
  if (lines.length > 0 && lines.every((line) => shareLink.test(line))) return 'links';
  if (/^\s*(proxies|proxy-groups|rules|rule-providers)\s*:/im.test(text)) return 'yaml';
  if (/\r?\n/.test(text)) return 'yaml';
  return 'unknown';
}

function freshRow(): ImportRow {
  return { id: crypto.randomUUID(), value: '' };
}

export function ImportSourceDialog({ onClose }: { onClose: () => void }) {
  const saveNow = useWorkspace((state) => state.saveNow);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const [rows, setRows] = useState<ImportRow[]>(() => [freshRow()]);
  const [importing, setImporting] = useState(false);
  const [vergeLoading, setVergeLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTextAreaElement | null>());

  const patchRow = (id: string, patch: Partial<ImportRow>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addRow = (seed?: Partial<ImportRow>) => {
    const row = { ...freshRow(), ...seed };
    setRows((current) => [...current, row]);
    requestAnimationFrame(() => rowRefs.current.get(row.id)?.focus());
    return row.id;
  };

  const removeRow = (id: string) => {
    setRows((current) => {
      if (current.length <= 1) return [freshRow()];
      return current.filter((row) => row.id !== id);
    });
  };

  const pendingRows = rows.filter((row) => row.value.trim());
  const canImport = pendingRows.length > 0 && !importing;

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      toast('error', '文件过大', '上限 20MB');
      return;
    }
    if (!/\.(ya?ml|txt)$/i.test(file.name)) {
      toast('error', '文件格式不支持', '请选择 .yaml / .yml / .txt');
      return;
    }
    const content = await file.text();
    const emptyRow = [...rows].reverse().find((row) => !row.value.trim());
    if (emptyRow) {
      patchRow(emptyRow.id, { value: content, fileName: file.name, error: undefined });
    } else {
      addRow({ value: content, fileName: file.name });
    }
  };

  const importVerge = async () => {
    if (vergeLoading) return;
    setVergeLoading(true);
    try {
      await saveNow();
      if (useWorkspace.getState().saveState === 'error') throw new Error('工作区尚未保存，已取消读取');
      const result = await api<ImportSummary>('/api/sources/verge', { method: 'POST', body: {} });
      applyServerWorkspace(result.workspace);
      toast('success', '已读取 Verge 当前配置', `新增 ${result.added} 个节点`);
    } catch (error) {
      toast('error', '读取 Verge 失败', (error as Error).message);
    } finally {
      setVergeLoading(false);
    }
  };

  const importAll = async () => {
    if (!canImport) return;
    setImporting(true);
    let added = 0;
    let importedSources = 0;
    const failed: ImportRow[] = [];
    try {
      await saveNow();
      if (useWorkspace.getState().saveState === 'error') {
        throw new Error('工作区尚未保存，已取消导入');
      }
      for (const row of pendingRows) {
        const value = row.value.trim();
        const kind = detectKind(value);
        try {
          if (kind === 'subscription') {
            if (/\r?\n/.test(value)) {
              throw new Error('每行只放一个订阅链接；要添加多个订阅，请点下方 + 继续添加');
            }
            const result = await api<ImportSummary>('/api/sources/subscription', {
              method: 'POST',
              body: { url: value },
            });
            applyServerWorkspace(result.workspace);
            added += result.added;
            importedSources += 1;
          } else if (kind === 'yaml') {
            const sourceName = row.fileName?.replace(/\.(ya?ml|txt)$/i, '') || '粘贴配置';
            const result = await api<ImportSummary>('/api/sources/paste', {
              method: 'POST',
              body: { name: sourceName, content: value },
            });
            applyServerWorkspace(result.workspace);
            added += result.added;
            importedSources += 1;
          } else if (kind === 'links') {
            const links = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            const parsed = links.map((link, index) => {
              try {
                return parseShareLink(link);
              } catch (error) {
                throw new Error(`第 ${index + 1} 行：${(error as Error).message}`);
              }
            });
            for (const node of parsed) {
              const result = await api<ImportSummary>('/api/sources/manual', {
                method: 'POST',
                body: { name: shareNodeDisplayName(node), proxy: shareNodeToProxy(node) },
              });
              applyServerWorkspace(result.workspace);
              added += result.added;
              importedSources += 1;
            }
          } else {
            throw new Error('无法识别内容。可以直接粘贴订阅链接、YAML 配置或节点分享链接。');
          }
        } catch (error) {
          failed.push({ ...row, error: (error as Error).message });
        }
      }
      if (failed.length) {
        setRows(failed);
        toast('warn', '部分来源未添加', `${failed.length} 个来源需要检查`);
      } else {
        toast('success', '来源已添加', `${importedSources} 个来源 · 新增 ${added} 个节点`);
        onClose();
      }
    } catch (error) {
      toast('error', '导入失败', (error as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      title="添加来源"
      size="lg"
      onClose={importing ? () => {} : onClose}
      hideClose={importing}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={importing}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void importAll()} disabled={!canImport}>
            {importing ? <Spinner onAccent /> : <Check size={13} />}
            {importing ? '导入中…' : pendingRows.length > 1 ? `导入全部 · ${pendingRows.length}` : '导入'}
          </button>
        </>
      }
    >
      <div className="source-batch">
        {isDesktopRuntime() ? (
          <div className="hint">桌面预览版当前仅支持节点链接；订阅与 YAML 导入将在下一阶段接入。</div>
        ) : null}
        <div className="source-batch-list">
          {rows.map((row, index) => {
            const kind = detectKind(row.value);
            const meta = KIND_META[kind];
            const Icon = meta.icon;
            return (
              <div className="source-row" key={row.id}>
                <div className="source-row-head">
                  <span className={cx('source-row-kind', kind)}>
                    <Icon size={12} />
                    {meta.label}
                    <span className="source-row-index">#{index + 1}</span>
                  </span>
                  {row.fileName ? <span className="source-row-file truncate">{row.fileName}</span> : null}
                  <span className="spacer" />
                  <button
                    className="icon-btn"
                    onClick={() => removeRow(row.id)}
                    title={rows.length > 1 ? '移除这一行' : '清空'}
                    aria-label={rows.length > 1 ? '移除这一行' : '清空'}
                    disabled={importing}
                  >
                    <X size={12} />
                  </button>
                </div>
                <textarea
                  ref={(element) => {
                    rowRefs.current.set(row.id, element);
                  }}
                  className={cx('source-row-input', `kind-${kind}`)}
                  rows={kind === 'yaml' ? 5 : kind === 'links' ? 3 : 1}
                  value={row.value}
                  onChange={(event) => patchRow(row.id, { value: event.target.value, error: undefined })}
                  placeholder={index === 0 ? '粘贴订阅链接、节点链接或 YAML 配置' : '继续粘贴内容'}
                  aria-label={`${meta.label} #${index + 1}`}
                  spellCheck={false}
                  disabled={importing}
                />
                {row.error ? (
                  <div className="source-row-error">
                    <AlertTriangle size={11} />
                    <span>{row.error}</span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <button className="source-row-add" onClick={() => addRow()} disabled={importing}>
          <Plus size={13} /> 添加订阅/节点源
        </button>
        <div className="source-row-quick">
          <button className="inline-link" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            <Upload size={12} /> 导入本地文件
          </button>
          {isDesktopRuntime() ? null : (
            <>
              <span className="meta-sep">·</span>
              <button className="inline-link" onClick={() => void importVerge()} disabled={importing || vergeLoading}>
                {vergeLoading ? <Spinner /> : <DownloadCloud size={12} />} 从 Verge 读取
              </button>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml,.txt"
          hidden
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>
    </Modal>
  );
}
