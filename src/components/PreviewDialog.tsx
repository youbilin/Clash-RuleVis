import { useEffect, useState } from 'react';
import { Check, ClipboardCopy, Download, FileWarning, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ExportPreview, ExportResult, KernelValidation } from '../../shared/types';
import { ApiError, api, copyToClipboard, downloadText } from '../api';
import { Modal } from './Overlay';
import { Spinner } from './Common';
import { YamlView } from './CodeView';
import { useWorkspace } from '../store/workspace';
import { toast } from '../store/ui';
import { cx } from '../lib/misc';

export function PreviewDialog({ onClose }: { onClose: () => void }) {
  const saveNow = useWorkspace((state) => state.saveNow);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const refreshStatus = useWorkspace((state) => state.refreshStatus);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [kernelValidation, setKernelValidation] = useState<KernelValidation | null>(null);
  const [exported, setExported] = useState<{
    path: string;
    counts: ExportPreview['counts'];
    baseIncluded: boolean;
    validation?: KernelValidation;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await saveNow();
        const result = await api<ExportPreview>('/api/export/preview');
        if (!cancelled) setPreview(result);
      } catch (error) {
        toast('error', '生成预览失败', (error as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const exportNow = async () => {
    setExporting(true);
    try {
      await saveNow();
      const result = await api<ExportResult>('/api/export', { method: 'POST' });
      applyServerWorkspace(result.workspace);
      await refreshStatus();
      setKernelValidation(result.validation ?? null);
      setExported({
        path: result.path,
        counts: result.counts,
        baseIncluded: Boolean(result.baseSettings?.included),
        validation: result.validation,
      });
      toast('success', '配置已导出', result.path);
    } catch (error) {
      if (error instanceof ApiError) {
        const payload = error.payload as { preview?: ExportPreview; validation?: KernelValidation };
        if (payload.preview) setPreview(payload.preview);
        if (payload.validation) setKernelValidation(payload.validation);
      }
      toast('error', '导出失败', (error as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const errors = preview?.issues.filter((issue) => issue.severity === 'error') ?? [];
  const warnings = preview?.issues.filter((issue) => issue.severity === 'warning') ?? [];

  return (
    <Modal
      title={exported ? '导出完成' : '预览与导出'}
      subtitle={
        exported
          ? '文件已写入工具目录，Clash Verge 的配置没有被修改。'
          : '生成可导入 Verge 的完整 YAML，不会修改 Verge。'
      }
      size="xl"
      onClose={onClose}
      footer={
        exported ? (
          <>
            <span className="foot-note">在 Verge 中：配置 → 导入本地文件</span>
            <button className="btn btn-outline" onClick={() => copyToClipboard(exported.path)}>
              <ClipboardCopy size={13} /> 复制路径
            </button>
            <button className="btn btn-primary" onClick={onClose}>完成</button>
          </>
        ) : (
          <>
            <span className="foot-note">
              {errors.length
                ? `有 ${errors.length} 个错误需要先修复`
                : preview?.baseSettings?.included
                  ? '安全模式 · 含端口 / DNS / TUN'
                  : '安全模式 · 不含端口 / DNS / TUN'}
            </span>
            <button
              className="btn btn-outline"
              disabled={!preview}
              onClick={() => preview && downloadText(preview.fileName, preview.yaml)}
            >
              <Download size={13} /> 下载
            </button>
            <button
              className="btn btn-primary"
              disabled={!preview || Boolean(errors.length) || exporting}
              onClick={exportNow}
            >
              {exporting ? <Spinner onAccent /> : <Check size={13} />}
              导出配置
            </button>
          </>
        )
      }
    >
      {loading ? (
        <div className="loading-block">
          <Spinner /> 正在生成 YAML 预览…
        </div>
      ) : exported ? (
        <div className="export-success-panel">
          <div className="export-success-icon"><Check size={22} /></div>
          <h3>YAML 已保存</h3>
          <p>节点 {exported.counts.nodes} · 出口 {exported.counts.exits} · 规则集 {exported.counts.providers} · 规则 {exported.counts.rules}</p>
          <code>{exported.path}</code>
          <div className="callout info">
            <FileWarning size={14} />
            <span>
              文件只写入了工具目录。
              {exported.baseIncluded
                ? ' 已包含端口 / DNS / TUN 等基础设置；切换前仍建议备份 Verge 当前配置。'
                : ' 此 YAML 不含端口 / DNS / TUN，切换前请备份当前配置，并确认 Verge 会沿用自身网络设置。'}
              {exported.validation?.available && exported.validation.ok
                ? ' 内核校验通过。'
                : exported.validation && !exported.validation.available
                  ? ' 未找到 mihomo，已跳过内核校验。'
                  : ''}
            </span>
          </div>
        </div>
      ) : preview ? (
        <div className="preview-dialog">
          <div className="preview-meta">
            <div className="preview-meta-item">
              <span className="eyebrow">NODES</span>
              <strong className="mono">{preview.counts.nodes}</strong>
            </div>
            <div className="preview-meta-item">
              <span className="eyebrow">EXITS</span>
              <strong className="mono">{preview.counts.exits}</strong>
            </div>
            <div className="preview-meta-item">
              <span className="eyebrow">PROVIDERS</span>
              <strong className="mono">{preview.counts.providers}</strong>
            </div>
            <div className="preview-meta-item">
              <span className="eyebrow">RULES</span>
              <strong className="mono">{preview.counts.rules}</strong>
            </div>
            <div className="spacer" />
            <span className={cx('badge', preview.baseSettings?.included ? 'badge-green' : 'badge-amber')}>
              {preview.baseSettings?.included ? '基础设置已合并' : '无基础设置'}
            </span>
            <button className="btn btn-sm btn-outline" onClick={() => copyToClipboard(preview.yaml)}>
              <ClipboardCopy size={12} /> 复制 YAML
            </button>
          </div>

          {kernelValidation && !kernelValidation.available ? (
            <div className="callout warn" style={{ marginBottom: 8 }}>
              <TriangleAlert size={14} />
              <span>{kernelValidation.error ?? '内核校验不可用。'}</span>
            </div>
          ) : kernelValidation && !kernelValidation.ok ? (
            <div className="callout danger" style={{ marginBottom: 8 }}>
              <TriangleAlert size={14} />
              <div>
                <span>{kernelValidation.error ?? 'mihomo 内核校验未通过。'}</span>
                {kernelValidation.output ? <pre className="validator-output">{kernelValidation.output}</pre> : null}
              </div>
            </div>
          ) : preview.baseSettings?.included ? (
            <div className="callout success" style={{ marginBottom: 8 }}>
              <ShieldCheck size={14} />
              <span>已合并 {preview.baseSettings.keys.length} 项 Verge 基础设置（端口 / DNS / TUN），不包含控制器与密钥。</span>
            </div>
          ) : (
            <div className="callout warn" style={{ marginBottom: 8 }}>
              <TriangleAlert size={14} />
              <span>未合并基础设置：YAML 不含端口 / DNS / TUN，导出时会自动运行内核校验。</span>
            </div>
          )}

          {preview.issues.length ? (
            <div className="preview-issues">
              {errors.map((issue) => (
                <div className="preview-issue error" key={`${issue.code}-${issue.message}`}>
                  <TriangleAlert size={13} />
                  <span>{issue.message}</span>
                </div>
              ))}
              {warnings.slice(0, 6).map((issue) => (
                <div className="preview-issue warning" key={`${issue.code}-${issue.message}`}>
                  <TriangleAlert size={13} />
                  <span>{issue.message}</span>
                </div>
              ))}
              {warnings.length > 6 ? <div className="preview-issue more">还有 {warnings.length - 6} 条提示，见导出页</div> : null}
            </div>
          ) : (
            <div className={cx('preview-issues', 'ok')}>
              <div className="preview-issue ok"><Check size={13} /><span>校验通过，没有发现空出口或缺失引用。</span></div>
            </div>
          )}

          <YamlView yaml={preview.yaml} maxHeight="48vh" />
        </div>
      ) : (
        <div className="empty-state">
          <FileWarning size={20} />
          <h3>暂时无法生成预览</h3>
        </div>
      )}
    </Modal>
  );
}
