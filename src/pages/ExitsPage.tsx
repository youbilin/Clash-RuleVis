import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown,
  Copy,
  GripVertical,
  Layers,
  Lock,
  Pencil,
  Plus,
  Star,
  Waypoints,
  Zap,
} from 'lucide-react';
import type { Exit, ExitMember, ExitType } from '../../shared/types';
import { resolveExit } from '../../shared/model';
import { api } from '../api';
import { useWorkspace } from '../store/workspace';
import { useLive } from '../store/live';
import { toast, useUi } from '../store/ui';
import { EmptyState, PageHeader, Spinner } from '../components/Common';
import { ExitEditor } from '../components/ExitEditor';
import { formatCompact, formatDelay, delayTone } from '../lib/format';
import { exitTypeLabel } from '../lib/labels';
import { cx } from '../lib/misc';
import { offerUndo } from '../lib/undo';

interface ExitTemplate {
  id: string;
  name: string;
  type: ExitType;
  members: ExitMember[];
  hint: string;
}

const TEMPLATES: ExitTemplate[] = [
  { id: 'home', name: '家宽', type: 'select', members: [{ by: 'tag', value: '家宽' }], hint: '按「家宽」标签收人' },
  { id: 'stream', name: '看视频', type: 'url-test', members: [{ by: 'tag', value: '流媒体' }], hint: '流媒体节点自动测速' },
  { id: 'ai', name: 'AI', type: 'select', members: [{ by: 'tag', value: 'AI' }], hint: '按「AI」标签收人' },
  { id: 'download', name: '下载', type: 'select', members: [{ by: 'tag', value: '下载' }], hint: '按「下载」标签收人' },
  { id: 'auto', name: '自动选择', type: 'url-test', members: [{ by: 'regex', value: '.*' }], hint: '全部启用节点中测速最快' },
  { id: 'all', name: '全部节点', type: 'select', members: [{ by: 'regex', value: '.*' }], hint: '包含所有启用节点' },
];

interface EditingState {
  mode: 'create' | 'edit';
  exitId?: string;
}

interface ExitRowProps {
  exit: Exit;
  resolution: ReturnType<typeof resolveExit>;
  group?: { now: string | null; delay?: number; memberCount: number };
  hits: number;
  testing: boolean;
  favorite: boolean;
  onToggleFavorite: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onTest: () => void;
}

function ExitRow({
  exit,
  resolution,
  group,
  hits,
  testing,
  favorite,
  onToggleFavorite,
  onEdit,
  onDuplicate,
  onTest,
}: ExitRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: exit.id });
  const empty = resolution.allNodeIds.length === 0;
  const missing = resolution.missing.length;
  const tone = delayTone(group?.delay);
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-type={exit.type}
      className={cx('exit-row', empty && 'empty', isDragging && 'dragging')}
      onClick={onEdit}
    >
      <button
        className="exit-row-grip"
        {...attributes}
        {...listeners}
        onClick={(event) => event.stopPropagation()}
        title="拖动调整显示顺序"
      >
        <GripVertical size={13} />
      </button>
      <button
        className={cx('favorite-btn', favorite && 'active')}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite();
        }}
        title={favorite ? '取消收藏' : '收藏，实时页置顶显示'}
      >
        <Star size={12} fill={favorite ? 'currentColor' : 'none'} />
      </button>
      <span className="badge exit-row-type">{exitTypeLabel(exit.type)}</span>
      <div className="exit-row-main">
        <div className="exit-row-name">
          <span className={cx('dot', empty ? 'red' : 'green')} />
          <strong className="truncate">{exit.name}</strong>
          {empty ? <span className="badge badge-red">无成员</span> : null}
          {!empty && missing ? <span className="badge badge-amber">{missing} 个失效</span> : null}
          {group ? <span className="exit-live-flag">LIVE</span> : null}
        </div>
      </div>
      <span className={cx('exit-row-members', empty && 'danger')}>
        {resolution.allNodeIds.length} 个节点
      </span>
      <span className="exit-row-current truncate" title={group?.now ?? '该出口尚未进入内核'}>
        {group?.now ?? '未进入内核'}
      </span>
      <span className={cx('exit-row-delay', tone)}>{formatDelay(group?.delay)}</span>
      <span className="exit-row-hits"><Zap size={10} /> {formatCompact(hits)}</span>
      <div className="exit-row-actions" onClick={(event) => event.stopPropagation()}>
        <button
          className="icon-btn"
          title={group ? '测速' : '尚未进入内核'}
          disabled={!group || testing}
          onClick={onTest}
        >
          {testing ? <Spinner /> : <Zap size={12} />}
        </button>
        <button className="icon-btn" title="复制出口" onClick={onDuplicate}>
          <Copy size={12} />
        </button>
        <button className="icon-btn" title="编辑出口" onClick={onEdit}>
          <Pencil size={12} />
        </button>
      </div>
    </div>
  );
}

function BuiltinExitRow({ exit, hits }: { exit: Exit; hits: number }) {
  return (
    <div className="exit-row builtin">
      <span className="exit-row-grip locked"><Lock size={11} /></span>
      <span className="exit-row-star-placeholder" />
      <span className="badge exit-row-type badge-plain">内置</span>
      <div className="exit-row-main">
        <div className="exit-row-name">
          <span className="dot blue" />
          <strong>{exit.name}</strong>
          <span className="faint exit-row-desc">{exit.name === 'DIRECT' ? '不经过代理，直接连接目标' : '直接拒绝匹配的连接'}</span>
        </div>
      </div>
      <span className="exit-row-members">—</span>
      <span className="exit-row-current">—</span>
      <span className="exit-row-delay">—</span>
      <span className="exit-row-hits"><Zap size={10} /> {formatCompact(hits)}</span>
      <div className="exit-row-actions" />
    </div>
  );
}

export function ExitsPage() {
  const workspace = useWorkspace((state) => state.workspace);
  const update = useWorkspace((state) => state.update);
  const createUndoPoint = useWorkspace((state) => state.createUndoPoint);
  const confirm = useUi((state) => state.confirm);
  const snapshot = useLive((state) => state.snapshot);
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [testingExit, setTestingExit] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const templateRef = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    if (!params.get('edit') && params.get('new') !== '1') return;
    const edit = params.get('edit');
    setEditing(edit ? { mode: 'edit', exitId: edit } : { mode: 'create' });
    const next = new URLSearchParams(params);
    next.delete('edit');
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    if (!templateOpen) return;
    const close = (event: MouseEvent) => {
      if (!templateRef.current?.contains(event.target as Node)) setTemplateOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [templateOpen]);

  const exits = useMemo(
    () => [...(workspace?.exits ?? [])].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [workspace?.exits],
  );
  const customExits = exits.filter((exit) => !exit.builtin);
  const builtinExits = exits.filter((exit) => exit.builtin);
  const resolutions = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveExit>>();
    if (!workspace) return map;
    for (const exit of workspace.exits) {
      map.set(
        exit.id,
        resolveExit(exit, { nodes: workspace.nodes, exits: workspace.exits, sources: workspace.sources }),
      );
    }
    return map;
  }, [workspace?.nodes, workspace?.exits, workspace?.sources]);

  if (!workspace) return null;

  const currentEditorExit = editing?.mode === 'edit' ? workspace.exits.find((exit) => exit.id === editing.exitId) : undefined;
  const groups = snapshot?.groups ?? {};
  const proxyHits = snapshot?.proxyHits ?? {};
  const enabledNodes = workspace.nodes.filter((node) => node.enabled).length;
  const emptyCount = customExits.filter((exit) => (resolutions.get(exit.id)?.allNodeIds.length ?? 0) === 0).length;

  const hitsFor = (exit: Exit) => {
    const kernelHits = proxyHits[exit.name];
    if (typeof kernelHits === 'number' && kernelHits > 0) return kernelHits;
    return snapshot?.connections.filter((entry) => entry.exitName === exit.name).length ?? 0;
  };

  const uniqueName = (base: string): string => {
    let candidate = base;
    let index = 2;
    while (workspace.exits.some((exit) => exit.name.toLowerCase() === candidate.toLowerCase())) {
      candidate = `${base} ${index}`;
      index += 1;
    }
    return candidate;
  };

  const addTemplate = (template: ExitTemplate) => {
    const name = uniqueName(template.name);
    const order = workspace.exits.reduce((max, exit) => Math.max(max, exit.order), 0) + 1;
    update((draft) => {
      draft.exits.push({
        id: crypto.randomUUID(),
        name,
        type: template.type,
        members: template.members,
        order,
        testUrl: template.type === 'select' ? undefined : draft.settings.testUrl,
        interval: template.type === 'select' ? undefined : 300,
        tolerance: template.type === 'url-test' ? 50 : undefined,
      });
    });
    setTemplateOpen(false);
    toast('success', `已添加出口「${name}」`, template.hint);
  };

  const duplicateExit = (exit: Exit) => {
    const name = uniqueName(`${exit.name} 副本`);
    const order = workspace.exits.reduce((max, item) => Math.max(max, item.order), 0) + 1;
    update((draft) => {
      draft.exits.push({
        ...structuredClone(exit),
        id: crypto.randomUUID(),
        name,
        builtin: false,
        sourceId: undefined,
        order,
      });
    });
    toast('success', '已复制出口', name);
  };

  const testExit = async (exit: Exit) => {
    const group = groups[exit.name];
    if (!group) {
      toast('info', '该出口尚未进入内核', '安全模式下不会自动应用配置。把导出的 YAML 导入 Verge 后即可测速。');
      return;
    }
    setTestingExit(exit.id);
    try {
      const result = await api<{ delays: Record<string, number> }>('/api/delay/group', {
        method: 'POST',
        body: { name: exit.name },
      });
      const ranked = Object.entries(result.delays)
        .filter(([, delay]) => delay > 0)
        .sort((a, b) => a[1] - b[1]);
      if (!ranked.length) toast('warn', '测速没有返回可用结果');
      else
        toast(
          'success',
          `${exit.name} 测速完成`,
          `最快 ${ranked[0][0]} · ${ranked[0][1]} ms · 共 ${ranked.length} 个结果`,
        );
    } catch (error) {
      toast('error', '测速失败', (error as Error).message);
    } finally {
      setTestingExit(null);
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = customExits.map((exit) => exit.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(customExits, oldIndex, newIndex);
    update((draft) => {
      for (const exit of draft.exits) {
        if (exit.builtin) continue;
        const index = reordered.findIndex((item) => item.id === exit.id);
        if (index >= 0) exit.order = index;
      }
    });
  };

  const removeUnused = async () => {
    const unused = customExits.filter((exit) => {
      const referenced = workspace.routes.some((route) => route.exitId === exit.id);
      const nested = workspace.exits.some(
        (item) => item.id !== exit.id && item.members.some((member) => member.by === 'exit' && member.value === exit.id),
      );
      return !referenced && !nested;
    });
    if (!unused.length) {
      toast('info', '没有未被引用的出口');
      return;
    }
    const confirmed = await confirm({
      title: '清理空出口',
      message: `将删除 ${unused.length} 个没有被规则或嵌套引用的出口：${unused.map((exit) => exit.name).join('、')}`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    const undo = await createUndoPoint('清理未引用出口');
    const ids = new Set(unused.map((exit) => exit.id));
    update((draft) => {
      draft.exits = draft.exits.filter((exit) => !ids.has(exit.id));
    });
    offerUndo(undo, `已删除 ${unused.length} 个出口`, '可在历史中恢复');
  };

  return (
    <div className="page exits-page">
      <PageHeader
        kicker="EXITS / POLICY GROUPS"
        title="出口"
        subtitle={`${customExits.length} 个出口 · ${enabledNodes} 个节点${emptyCount ? ` · ${emptyCount} 个待修复` : ''}`}
        actions={
          <>
            <div className="template-wrap" ref={templateRef}>
              <button className="btn btn-outline" onClick={() => setTemplateOpen((open) => !open)}>
                <Layers size={13} /> 从模板新建 <ChevronDown size={12} />
              </button>
              {templateOpen ? (
                <div className="template-menu">
                  <div className="ctx-label">PRESETS</div>
                  {TEMPLATES.map((template) => (
                    <button className="template-item" key={template.id} onClick={() => addTemplate(template)}>
                      <span className="template-item-name">{template.name}</span>
                      <span className="template-item-hint">{template.hint}</span>
                      <span className="badge">{exitTypeLabel(template.type)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="btn btn-primary" onClick={() => setEditing({ mode: 'create' })}>
              <Plus size={13} /> 新建出口
            </button>
          </>
        }
      />

      <div className="exits-body">
        <div className="exit-section-heading">
          <div className="section-title" style={{ margin: 0 }}>
            自定义出口
          </div>
          {customExits.some((exit) => !workspace.routes.some((route) => route.exitId === exit.id)) ? (
            <button className="btn btn-sm btn-ghost" onClick={() => void removeUnused()}>清理未引用出口</button>
          ) : null}
        </div>

        {customExits.length ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={customExits.map((exit) => exit.id)} strategy={verticalListSortingStrategy}>
              <div className="panel exit-list-panel exit-custom-panel">
                <div className="exit-list-head">
                  <span />
                  <span />
                  <span>类型</span>
                  <span>出口</span>
                  <span>成员</span>
                  <span>当前节点</span>
                  <span>延迟</span>
                  <span>命中</span>
                  <span>操作</span>
                </div>
                {customExits.map((exit) => (
                  <ExitRow
                    key={exit.id}
                    exit={exit}
                    resolution={resolutions.get(exit.id)!}
                    group={groups[exit.name]}
                    hits={hitsFor(exit)}
                    testing={testingExit === exit.id}
                    onEdit={() => setEditing({ mode: 'edit', exitId: exit.id })}
                    onDuplicate={() => duplicateExit(exit)}
                    onTest={() => void testExit(exit)}
                    favorite={(workspace.settings.favoriteExitIds ?? []).includes(exit.id)}
                    onToggleFavorite={() =>
                      update((draft) => {
                        const list = draft.settings.favoriteExitIds ?? [];
                        draft.settings.favoriteExitIds = list.includes(exit.id)
                          ? list.filter((item) => item !== exit.id)
                          : [...list, exit.id];
                      })
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div className="panel exit-empty-panel">
            <EmptyState
              icon={<Waypoints size={20} />}
              title="还没有自定义出口"
              description="出口是拖拽规则的落点。可以用模板快速创建「家宽」「看视频」等，再按标签收集节点。"
              actions={
                <button className="btn btn-primary btn-sm" onClick={() => setEditing({ mode: 'create' })}>
                  <Plus size={12} /> 新建出口
                </button>
              }
            />
          </div>
        )}

        <div className="exit-section-heading exit-builtin-heading">
          <div className="section-title" style={{ margin: 0 }}>
            内置出站
            <span className="eyebrow">BUILT-IN</span>
          </div>
        </div>
        <div className="panel exit-list-panel exit-builtin-panel">
          <div className="exit-list-head">
            <span />
            <span />
            <span>类型</span>
            <span>出口</span>
            <span>成员</span>
            <span>当前节点</span>
            <span>延迟</span>
            <span>命中</span>
            <span>操作</span>
          </div>
          {builtinExits.map((exit) => (
            <BuiltinExitRow key={exit.id} exit={exit} hits={hitsFor(exit)} />
          ))}
        </div>
      </div>

      {editing ? (
        <ExitEditor
          key={editing.mode === 'edit' ? editing.exitId : 'new'}
          exit={currentEditorExit}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
