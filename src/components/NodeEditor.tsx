import { useMemo, useState } from 'react';
import { Plus, Server, Tag, X } from 'lucide-react';
import type { ProxyNode } from '../../shared/types';
import { nodeDisplayName } from '../../shared/model';
import { REGION_EMOJI } from '../../shared/regions';
import { useWorkspace } from '../store/workspace';
import { toast } from '../store/ui';
import { Drawer } from './Overlay';
import { Switch } from './Common';
import { cx } from '../lib/misc';

export function NodeEditor({ node, onClose }: { node: ProxyNode; onClose: () => void }) {
  const workspace = useWorkspace((state) => state.workspace);
  const update = useWorkspace((state) => state.update);
  const [name, setName] = useState(node.name);
  const [region, setRegion] = useState(node.region ?? '');
  const [tags, setTags] = useState<string[]>(node.tags);
  const [newTag, setNewTag] = useState('');
  const [enabled, setEnabled] = useState(node.enabled);
  const [error, setError] = useState('');

  const source = workspace?.sources.find((item) => item.id === node.sourceId);
  const displayName = source ? `${source.prefix}${name}` : name;
  const allTags = useMemo(() => {
    const values = new Set<string>();
    for (const item of workspace?.nodes ?? []) {
      for (const tag of item.tags) values.add(tag);
    }
    return [...values].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [workspace?.nodes]);

  if (!workspace) return null;

  const addTag = () => {
    const value = newTag.trim();
    if (!value) return;
    setTags((current) => (current.includes(value) ? current : [...current, value]));
    setNewTag('');
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('节点名称不能为空');
      return;
    }
    const duplicate = workspace.nodes.some(
      (item) =>
        item.id !== node.id &&
        nodeDisplayName(item, workspace.sources.find((sourceItem) => sourceItem.id === item.sourceId)).toLowerCase() ===
          `${source?.prefix ?? ''}${trimmed}`.toLowerCase(),
    );
    if (duplicate) {
      setError('该导出名与其他节点重复，请修改名称或来源前缀');
      return;
    }
    update((draft) => {
      const target = draft.nodes.find((item) => item.id === node.id);
      if (!target) return;
      target.name = trimmed;
      target.region = region.trim() || undefined;
      target.tags = tags;
      target.enabled = enabled;
      target.updatedAt = new Date().toISOString();
    });
    toast('success', '节点已更新', displayName);
    onClose();
  };

  const raw = node.raw as Record<string, unknown>;
  return (
    <Drawer
      title="编辑节点"
      subtitle={source ? `来源：${source.name}` : '节点'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={save}>保存修改</button>
        </>
      }
    >
      <div className="editor-section">
        <div className="node-summary">
          <div className={cx('node-summary-dot', enabled && 'on')}>
            <Server size={16} />
          </div>
          <div className="grow">
            <div className="node-export-name mono truncate" title={displayName}>{displayName}</div>
            <div className="node-summary-meta">
              <span>{String(raw.type ?? '—')}</span>
              <span className="meta-sep">·</span>
              <span className="mono">{String(raw.server ?? '—')}:{String(raw.port ?? '—')}</span>
            </div>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label="启用节点" />
        </div>
      </div>

      <div className="editor-section">
        <label className="field">
          <span className="field-label">节点名称 <span className="optional">不含来源前缀</span></span>
          <input
            className="input"
            value={name}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
              setError('');
            }}
          />
          {error ? <span className="error-text">{error}</span> : null}
          <span className="hint">导出名 = [{source?.prefix || '无前缀'}] + {name || '节点名'}</span>
        </label>
      </div>

      <div className="editor-section">
        <label className="field">
          <span className="field-label">地区</span>
          <input
            className="input"
            list="node-region-options"
            value={region}
            placeholder="自动识别，可覆盖"
            onChange={(event) => setRegion(event.target.value)}
          />
          <datalist id="node-region-options">
            {Object.keys(REGION_EMOJI).map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
          <span className="hint">{enabled ? '节点已启用，会进入节点池并可被出口引用。' : '节点已禁用，导出时会被跳过。'}</span>
        </label>
      </div>

      <div className="editor-section">
        <div className="section-title">
          <Tag size={13} /> 标签
          <span className="eyebrow">CUSTOM TAGS</span>
        </div>
        <p className="hint" style={{ marginBottom: 8 }}>
          地区会自动作为标签参与匹配；这里添加「家宽」「流媒体」「AI」等用途标签，出口可以按标签收人。
        </p>
        <div className="node-tag-editor">
          {tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
              <button onClick={() => setTags((current) => current.filter((item) => item !== tag))} aria-label={`移除 ${tag}`}>
                <X size={10} />
              </button>
            </span>
          ))}
          <div className="node-tag-add">
            <input
              className="input"
              list="node-tag-options"
              value={newTag}
              placeholder="添加标签"
              onChange={(event) => setNewTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag();
                }
              }}
            />
            <button className="icon-btn" onClick={addTag} title="添加标签">
              <Plus size={13} />
            </button>
          </div>
        </div>
        <datalist id="node-tag-options">
          {allTags.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      </div>

      <div className="editor-section">
        <div className="section-title">节点信息</div>
        <div className="node-facts">
          <div><span>类型</span><strong className="mono">{String(raw.type ?? '—')}</strong></div>
          <div><span>服务器</span><strong className="mono">{String(raw.server ?? '—')}</strong></div>
          <div><span>端口</span><strong className="mono">{String(raw.port ?? '—')}</strong></div>
          <div><span>来源</span><strong>{source?.name ?? '—'}</strong></div>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          凭据字段不会在这里显示，也不会写入应用日志。导出的 YAML 会包含内核运行所需的凭据。
        </p>
      </div>
    </Drawer>
  );
}
