import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import type { ProxyNode, Source } from '../../shared/types';
import { nodeDisplayName } from '../../shared/model';
import { Modal } from './Overlay';
import { cx } from '../lib/misc';

interface NodePickerDialogProps {
  nodes: ProxyNode[];
  sources: Source[];
  existingIds: Set<string>;
  onClose: () => void;
  onAdd: (ids: string[]) => void;
}

export function NodePickerDialog({ nodes, sources, existingIds, onClose, onAdd }: NodePickerDialogProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sourcesById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...nodes]
      .filter((node) => {
        if (!q) return true;
        const name = nodeDisplayName(node, sourcesById.get(node.sourceId)).toLowerCase();
        const server = String((node.raw as Record<string, unknown>).server ?? '').toLowerCase();
        return name.includes(q) || server.includes(q);
      })
      .sort((a, b) =>
        nodeDisplayName(a, sourcesById.get(a.sourceId)).localeCompare(
          nodeDisplayName(b, sourcesById.get(b.sourceId)),
          'zh-Hans-CN',
        ),
      );
  }, [nodes, query, sourcesById]);

  const selectable = visible.filter((node) => !existingIds.has(node.id));
  const allSelected = selectable.length > 0 && selectable.every((node) => selected.has(node.id));

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) {
        for (const node of selectable) next.delete(node.id);
      } else {
        for (const node of selectable) next.add(node.id);
      }
      return next;
    });
  };

  return (
    <Modal
      title="批量选择节点"
      subtitle={selected.size ? `已选择 ${selected.size} 个节点` : '勾选要加入出口的已有节点'}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={!selected.size}
            onClick={() => onAdd([...selected])}
          >
            <Check size={13} /> 添加 {selected.size || ''} 个节点
          </button>
        </>
      }
    >
      <div className="node-picker-toolbar">
        <div className="search-box">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点名或服务器"
            aria-label="搜索节点"
            autoFocus
          />
        </div>
        <button className="btn btn-sm btn-ghost" onClick={toggleAll} disabled={!selectable.length}>
          {allSelected ? '取消全选' : `全选 ${selectable.length}`}
        </button>
      </div>
      <div className="node-picker-list">
        {visible.length ? (
          visible.map((node) => {
            const added = existingIds.has(node.id);
            const checked = added || selected.has(node.id);
            const source = sourcesById.get(node.sourceId);
            const display = nodeDisplayName(node, source);
            return (
              <label className={cx('node-picker-row', added && 'added')} key={node.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={added}
                  onChange={() => toggle(node.id)}
                  aria-label={`选择 ${display}`}
                />
                <span className="node-picker-name" title={display}>{display}</span>
                {node.region ? <span className="tag accent">{node.region}</span> : null}
                <span className="node-picker-source" title={source?.name}>{source?.name ?? '未知来源'}</span>
                {!node.enabled ? <span className="badge badge-plain">禁用</span> : null}
                {added ? <span className="badge badge-plain">已加入</span> : null}
              </label>
            );
          })
        ) : (
          <div className="node-picker-empty">没有匹配的节点</div>
        )}
      </div>
    </Modal>
  );
}
