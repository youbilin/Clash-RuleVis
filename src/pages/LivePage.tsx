import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Copy,
  GripVertical,
  MousePointerClick,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  Star,
  TriangleAlert,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import type { Exit, LiveDomainConnection, LiveSnapshot, ProxyNode, Source, Workspace } from '../../shared/types';
import { isIPv6, nodeDisplayName, resolveExit, routeTargetInfo, ruleMatchesHost } from '../../shared/model';
import { api, copyToClipboard } from '../api';
import { useLive } from '../store/live';
import { useWorkspace } from '../store/workspace';
import { toast, useUi } from '../store/ui';
import { EmptyState, Spinner } from '../components/Common';
import { Sparkline } from '../components/Sparkline';
import { RuleComposer } from '../components/RuleComposer';
import { RuleTargetSelect } from '../components/RuleTargetSelect';
import { Select } from '../components/Select';
import { PreviewDialog } from '../components/PreviewDialog';
import { Modal } from '../components/Overlay';
import { formatBytes, formatCompact, formatDelay, formatRate, formatRelative, delayTone } from '../lib/format';
import { exitTypeLabel, ruleTypeLabel } from '../lib/labels';
import { cx } from '../lib/misc';
import { useEscape } from '../lib/hooks';

type SortMode = 'recent' | 'traffic' | 'rate' | 'name';
type RowStatusKind = 'pending' | 'verified' | 'exported' | 'missing';

interface RowStatus {
  kind: RowStatusKind;
  title: string;
}

interface ComposerState {
  entries: LiveDomainConnection[];
  exitId?: string;
  targetNodeId?: string;
  rect?: { top: number; left: number; right: number; bottom: number; width: number; height: number };
}

interface ContextState {
  x: number;
  y: number;
  entry: LiveDomainConnection;
}

function statusForEntry(entry: LiveDomainConnection, workspace: Workspace): RowStatus | null {
  let exported: RowStatus | null = null;
  for (const route of workspace.routes) {
    if (route.kind !== 'rule' || !route.enabled || route.type === 'MATCH' || route.type === 'RULE-SET') continue;
    if (!ruleMatchesHost(route.type, route.payload, entry.host)) continue;
    const target = routeTargetInfo(route, workspace);
    if (!target.available) {
      if (route.pending || route.appliedAt) {
        return { kind: 'missing', title: target.kind === 'node' ? '规则目标节点已不存在或已禁用' : '规则目标出口已不存在' };
      }
      continue;
    }
    if (route.pending) {
      return { kind: 'pending', title: '规则已加入待应用托盘' };
    }
    if (route.appliedAt) {
      const liveRuleMatches =
        (target.kind === 'node' ? entry.nodeName === target.name : entry.exitName === target.name) &&
        entry.ruleType === route.type &&
        entry.rulePayload.toLowerCase() === route.payload.toLowerCase();
      if (liveRuleMatches) {
        return { kind: 'verified', title: `实时连接已命中这条规则 · ${target.kind === 'node' ? '节点' : '出口'}「${target.name}」` };
      }
      exported = { kind: 'exported', title: '规则已导出，但实时流尚未命中' };
    }
  }
  return exported;
}

function StatusMark({ status }: { status: RowStatus | null }) {
  if (!status) return <span className="status-mark" />;
  if (status.kind === 'verified') {
    return (
      <span className="status-mark verified" title={status.title}>
        <CheckCircle2 size={14} />
      </span>
    );
  }
  if (status.kind === 'pending') {
    return (
      <span className="status-mark pending" title={status.title}>
        <Clock3 size={13} />
      </span>
    );
  }
  if (status.kind === 'missing') {
    return (
      <span className="status-mark missing" title={status.title}>
        <AlertTriangle size={13} />
      </span>
    );
  }
  return (
    <span className="status-mark exported" title={status.title}>
      <CircleDashed size={13} />
    </span>
  );
}

interface ConnectionRowProps {
  entry: LiveDomainConnection;
  now: number;
  selected: boolean;
  expanded: boolean;
  status: RowStatus | null;
  selectedKeys: Set<string>;
  onToggleSelect: (key: string, event: ReactMouseEvent) => void;
  onToggleExpand: (key: string) => void;
  onContext: (event: ReactMouseEvent, entry: LiveDomainConnection) => void;
  onCompose: (entry: LiveDomainConnection) => void;
  onProcess: (entry: LiveDomainConnection) => void;
}

function ConnectionRow({
  entry,
  now,
  selected,
  expanded,
  status,
  selectedKeys,
  onToggleSelect,
  onToggleExpand,
  onContext,
  onCompose,
  onProcess,
}: ConnectionRowProps) {
  const dragKeys = selected ? [...selectedKeys] : [entry.key];
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: entry.key,
    data: { keys: dragKeys },
  });

  const ruleBadgeClass =
    entry.ruleType === 'RULE-SET'
      ? 'badge-blue'
      : entry.ruleType === 'MATCH'
        ? 'badge-amber'
        : entry.ruleType === 'GEOSITE' || entry.ruleType === 'GEOIP'
          ? 'badge-green'
          : '';

  const chains = [...entry.chains].reverse();

  return (
    <div className={cx('conn-item', isDragging && 'dragging', expanded && 'expanded')}>
      <div
        className={cx('conn-row', selected && 'selected', entry.active === 0 && 'inactive')}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('[data-row-control]')) return;
          if (event.ctrlKey || event.metaKey) {
            onToggleSelect(entry.key, event);
            return;
          }
          onToggleExpand(entry.key);
        }}
        onContextMenu={(event) => onContext(event, entry)}
      >
        <div className="conn-check" data-row-control>
          <input
            type="checkbox"
            checked={selected}
            aria-label={`选择 ${entry.displayHost}`}
            readOnly
            onClick={(event) => {
              event.stopPropagation();
              onToggleSelect(entry.key, event);
            }}
          />
        </div>

        <div
          ref={setNodeRef}
          className="domain-cell domain-dragzone"
          {...listeners}
          {...attributes}
          title="拖到出口或节点创建规则"
        >
          <span className="drag-grip" aria-hidden>
            <GripVertical size={13} />
          </span>
          <span className={cx('live-dot', entry.active > 0 ? 'active' : '')} />
          <div className="domain-copy">
            <div className="domain-line">
              <span className="domain-name mono truncate" title={entry.displayHost}>
                {entry.displayHost}
              </span>
              <StatusMark status={status} />
            </div>
            <div className="domain-meta">
              <span>{entry.active > 0 ? `${entry.active} 条连接` : '已结束'}</span>
              <span className="meta-sep">·</span>
              <span>{formatRelative(entry.lastSeen, now)}</span>
              {entry.isIp ? <span className="badge badge-plain">IP</span> : null}
              <Sparkline data={entry.history} />
            </div>
          </div>
        </div>

        <div className="rule-cell">
          <span className={cx('badge', ruleBadgeClass)} title={entry.ruleType}>{ruleTypeLabel(entry.ruleType)}</span>
          <span className="rule-payload truncate" title={entry.rulePayload || entry.rule}>
            {entry.rulePayload || (entry.ruleType === 'MATCH' ? '兜底规则' : '—')}
          </span>
        </div>

        <div className="path-cell">
          <span className="path-node exit truncate" title={entry.exitName ?? '未知出口'}>
            {entry.exitName ?? '—'}
          </span>
          <ChevronRight size={11} />
          <span className="path-node truncate" title={entry.nodeName ?? '未知节点'}>
            {entry.nodeName ?? '—'}
          </span>
        </div>

        <div className="rate-cell mono">
          <span className="rate-down">↓ {formatRate(entry.rateDown)}</span>
          <span className="rate-up">↑ {formatRate(entry.rateUp)}</span>
        </div>

        <div className="traffic-cell mono">{formatBytes(entry.download + entry.upload)}</div>

        <div className="row-tail" data-row-control>
          <button
            className={cx('icon-btn expand-btn', expanded && 'rotated')}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand(entry.key);
            }}
            aria-label={expanded ? '收起详情' : '展开详情'}
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="row-detail">
          <div className="detail-path">
            <span className="path-chip domain mono">{entry.displayHost}</span>
            <ArrowRight size={12} />
            <span className="path-chip rule" title={entry.ruleType}>
              {ruleTypeLabel(entry.ruleType)}
              {entry.rulePayload ? <span className="path-chip-extra"> · {entry.rulePayload}</span> : null}
            </span>
            {chains.length ? (
              chains.map((chain, index) => (
                <span className="path-chain-part" key={`${chain}-${index}`}>
                  <ArrowRight size={12} />
                  <span
                    className={cx(
                      'path-chip',
                      index === chains.length - 1 ? 'node' : 'exit',
                      index === 0 && 'outer',
                    )}
                  >
                    {chain}
                  </span>
                </span>
              ))
            ) : (
              <span className="faint">无链路信息</span>
            )}
          </div>

          <div className="detail-facts">
            <Fact label="目标 IP" value={entry.destinationIp || '—'} mono />
            <Fact label="端口" value={entry.destinationPort || '—'} mono />
            <Fact label="网络 / 入口" value={`${entry.network ?? '—'} · ${entry.inbound ?? '—'}`} />
            <Fact label="连接记录" value={`${entry.count} 条`} />
            <Fact label="进程" value={entry.processes.length ? entry.processes.join(', ') : '未获取'} />
            <Fact label="首次出现" value={formatRelative(entry.firstSeen, now)} />
            <Fact label="累计流量" value={`↓ ${formatBytes(entry.download)} · ↑ ${formatBytes(entry.upload)}`} />
            <Fact label="规则变体" value={`${entry.variants.length} 种`} />
          </div>

          {entry.variants.length > 1 ? (
            <div className="detail-variants">
              <span className="eyebrow">MATCHED VARIANTS</span>
              <div className="variant-list">
                {entry.variants.map((variant) => (
                  <div className="variant-row" key={`${variant.ruleType}-${variant.rulePayload}-${variant.exitName}-${variant.nodeName}`}>
                    <span className={cx('badge', variant.ruleType === 'RULE-SET' ? 'badge-blue' : variant.ruleType === 'MATCH' ? 'badge-amber' : '')} title={variant.ruleType}>
                      {ruleTypeLabel(variant.ruleType)}
                    </span>
                    <span className="mono truncate">{variant.rulePayload || '兜底'}</span>
                    <ArrowRight size={11} />
                    <span className="truncate">{variant.exitName ?? '—'}</span>
                    <ArrowRight size={11} />
                    <span className="truncate">{variant.nodeName ?? '—'}</span>
                    <span className="faint">{variant.count} 条</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="detail-actions">
            <button className="btn btn-sm btn-outline" onClick={() => onCompose(entry)}>
              <Plus size={12} /> 生成规则
            </button>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => onProcess(entry)}
              disabled={!entry.processes.length && !entry.processPaths.length}
              title={entry.processes.length || entry.processPaths.length ? undefined : '当前连接没有进程信息'}
            >
              按进程生成
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => copyToClipboard(entry.host)}>
              <Copy size={12} /> 复制域名
            </button>
            {entry.destinationIp ? (
              <button className="btn btn-sm btn-ghost" onClick={() => copyToClipboard(entry.destinationIp!)}>
                <Copy size={12} /> 复制 IP
              </button>
            ) : null}
            <span className="spacer" />
            <span className="detail-hint">
              <MousePointerClick size={12} /> 也可以直接拖到右侧出口或节点
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className={cx('fact-value truncate', mono && 'mono')} title={value}>{value}</span>
    </div>
  );
}

interface ExitDropCardProps {
  exit: Exit;
  resolution: ReturnType<typeof resolveExit>;
  group?: LiveSnapshot['groups'][string];
  hits: number;
  testing: boolean;
  favorite: boolean;
  onToggleFavorite: () => void;
  onTest: () => void;
  onManage: () => void;
}

function ExitDropCard({
  exit,
  resolution,
  group,
  hits,
  testing,
  favorite,
  onToggleFavorite,
  onTest,
  onManage,
}: ExitDropCardProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `exit:${exit.id}` });
  const empty = !exit.builtin && resolution.allNodeIds.length === 0;
  const missing = resolution.missing.length > 0;
  const delay = group?.delay;
  const tone = delayTone(delay);
  return (
    <div
      ref={setNodeRef}
      data-exit-id={exit.id}
      className={cx('exit-drop', exit.builtin && 'builtin', empty && 'empty', isOver && 'over')}
    >
      <div className="exit-drop-top">
        <span className="exit-type">{exit.builtin ? '内置出站' : exitTypeLabel(exit.type)}</span>
        <span className="exit-top-right">
          {!exit.builtin ? (
            <button
              className={cx('favorite-btn', favorite && 'active')}
              title={favorite ? '取消收藏' : '收藏出口，置顶显示'}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite();
              }}
            >
              <Star size={11} fill={favorite ? 'currentColor' : 'none'} />
            </button>
          ) : null}
          <span className={cx('exit-delay', tone)}>{formatDelay(delay)}</span>
          {!exit.builtin ? (
            <button
              className="icon-btn exit-tool"
              title={group ? '测速' : '该出口尚未进入内核'}
              onClick={(event) => {
                event.stopPropagation();
                onTest();
              }}
              disabled={!group || testing}
            >
              {testing ? <Spinner /> : <Zap size={12} />}
            </button>
          ) : null}
          <button
            className="icon-btn exit-tool"
            title="在出口页编辑"
            onClick={(event) => {
              event.stopPropagation();
              onManage();
            }}
          >
            <Settings2 size={12} />
          </button>
        </span>
      </div>
      <div className="exit-drop-name">
        <span className={cx('dot', empty ? 'red' : exit.builtin ? 'blue' : 'green')} />
        <strong className="truncate">{exit.name}</strong>
        {isOver ? <span className="drop-ready">释放创建</span> : null}
        {empty ? <span className="exit-warning">无可用成员</span> : missing ? <span className="exit-warning amber">{missing} 个失效</span> : null}
      </div>
      <div className="exit-drop-meta">
        {exit.builtin ? (
          <span>内置出站</span>
        ) : (
          <span>{resolution.allNodeIds.length} 个节点</span>
        )}
        {group?.now ? (
          <>
            <span className="meta-sep">→</span>
            <span className="truncate">{group.now}</span>
          </>
        ) : null}
        <span className="exit-hits mono" title="内核启动以来的命中次数">
          <Zap size={10} /> {formatCompact(hits)}
        </span>
      </div>
    </div>
  );
}

interface NodeDropCardProps {
  node: ProxyNode;
  source?: Source;
  hits: number;
}

function NodeDropCard({ node, source, hits }: NodeDropCardProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `node:${node.id}` });
  const name = nodeDisplayName(node, source);
  return (
    <div
      ref={setNodeRef}
      data-node-id={node.id}
      className={cx('exit-drop', 'node-drop', isOver && 'over')}
      title="拖到这里，规则会直接指向这个节点"
    >
      <div className="exit-drop-top">
        <span className="exit-type">节点</span>
        <span className="node-region">{node.region ?? '代理节点'}</span>
      </div>
      <div className="exit-drop-name">
        <span className="dot green" />
        <strong className="truncate">{name}</strong>
        {isOver ? <span className="drop-ready">释放创建</span> : null}
      </div>
      <div className="exit-drop-meta">
        <span className="truncate">{source?.name ?? '手动节点'}</span>
        <span className="meta-sep">·</span>
        <span className="truncate">{node.tags.slice(0, 2).join(' / ') || '直连此节点'}</span>
        <span className="exit-hits mono" title="当前实时连接中最终走该节点的数量">
          <Zap size={10} /> {formatCompact(hits)}
        </span>
      </div>
    </div>
  );
}

export function LivePage() {
  const workspace = useWorkspace((state) => state.workspace);
  const status = useWorkspace((state) => state.status);
  const update = useWorkspace((state) => state.update);
  const addPendingRules = useWorkspace((state) => state.addPendingRules);
  const refreshStatus = useWorkspace((state) => state.refreshStatus);
  const snapshot = useLive((state) => state.snapshot);
  const socketConnected = useLive((state) => state.socketConnected);
  const paused = useLive((state) => state.paused);
  const pausedAt = useLive((state) => state.pausedAt);
  const pausedUpdates = useLive((state) => state.pausedUpdates);
  const lastMessageAt = useLive((state) => state.lastMessageAt);
  const setPaused = useLive((state) => state.setPaused);
  const navigate = useNavigate();
  const setSettingsOpen = useUi((state) => state.setSettingsOpen);

  const [query, setQuery] = useState('');
  const [exitFilter, setExitFilter] = useState('');
  const [exitQuery, setExitQuery] = useState('');
  const [targetTab, setTargetTab] = useState<'exits' | 'nodes'>('exits');
  const targetScrollRef = useRef<HTMLDivElement | null>(null);
  const [ruleFilter, setRuleFilter] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [context, setContext] = useState<ContextState | null>(null);
  const [processEntry, setProcessEntry] = useState<LiveDomainConnection | null>(null);
  const [testingExit, setTestingExit] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [rediscovering, setRediscovering] = useState(false);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }));
  const now = paused ? pausedAt ?? Date.now() : lastMessageAt || Date.now();

  useEscape(() => setContext(null), Boolean(context));

  useEffect(() => {
    if (!context) return;
    const close = () => setContext(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [context]);

  const entries = snapshot?.connections ?? [];
  const pendingRoutes = workspace?.routes.filter((route) => route.pending) ?? [];

  const filtered = useMemo(() => {
    if (!workspace) return [];
    const q = query.trim().toLowerCase();
    let items = entries.filter((entry) => {
      if (exitFilter && entry.exitName !== exitFilter) return false;
      if (ruleFilter && entry.ruleType !== ruleFilter) return false;
      if (!q) return true;
      return (
        entry.displayHost.toLowerCase().includes(q) ||
        entry.rulePayload.toLowerCase().includes(q) ||
        (entry.exitName ?? '').toLowerCase().includes(q) ||
        (entry.nodeName ?? '').toLowerCase().includes(q) ||
        entry.processes.some((process) => process.toLowerCase().includes(q)) ||
        (entry.destinationIp ?? '').includes(q)
      );
    });
    items = [...items];
    if (sortMode === 'traffic') {
      items.sort((a, b) => b.download + b.upload - (a.download + a.upload));
    } else if (sortMode === 'rate') {
      items.sort((a, b) => b.rateDown + b.rateUp - (a.rateDown + a.rateUp));
    } else if (sortMode === 'name') {
      items.sort((a, b) => a.displayHost.localeCompare(b.displayHost));
    } else {
      items.sort((a, b) => {
        if (a.active !== b.active) return b.active - a.active;
        return b.lastSeen - a.lastSeen;
      });
    }
    return items;
  }, [entries, workspace, query, exitFilter, ruleFilter, sortMode]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (expandedKey === filtered[index]?.key ? 380 : 48),
    overscan: 8,
  });

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [query, exitFilter, ruleFilter, sortMode]);

  useEffect(() => {
    targetScrollRef.current?.scrollTo({ top: 0 });
  }, [targetTab, exitQuery]);

  const exitNames = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) if (entry.exitName) set.add(entry.exitName);
    for (const exit of workspace?.exits ?? []) set.add(exit.name);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [entries, workspace?.exits]);

  const ruleTypes = useMemo(() => {
    return [...new Set(entries.map((entry) => entry.ruleType))].sort();
  }, [entries]);

  const exits = useMemo(() => {
    if (!workspace) return [];
    return [...workspace.exits].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }, [workspace?.exits]);

  const sourcesById = useMemo(
    () => new Map((workspace?.sources ?? []).map((source) => [source.id, source])),
    [workspace?.sources],
  );

  const enabledNodes = useMemo(
    () =>
      (workspace?.nodes ?? [])
        .filter((node) => node.enabled)
        .sort((a, b) =>
          nodeDisplayName(a, sourcesById.get(a.sourceId)).localeCompare(
            nodeDisplayName(b, sourcesById.get(b.sourceId)),
            'zh-Hans-CN',
          ),
        ),
    [workspace?.nodes, sourcesById],
  );

  const resolutions = useMemo(() => {
    if (!workspace) return new Map<string, ReturnType<typeof resolveExit>>();
    const map = new Map<string, ReturnType<typeof resolveExit>>();
    for (const exit of workspace.exits) {
      map.set(
        exit.id,
        resolveExit(exit, { nodes: workspace.nodes, exits: workspace.exits, sources: workspace.sources }),
      );
    }
    return map;
  }, [workspace?.nodes, workspace?.exits, workspace?.sources]);

  useEffect(() => {
    const existing = new Set(entries.map((entry) => entry.key));
    setSelected((current) => {
      const next = new Set([...current].filter((key) => existing.has(key)));
      return next.size === current.size ? current : next;
    });
    if (expandedKey && !existing.has(expandedKey)) setExpandedKey(null);
  }, [entries]);

  useEffect(() => {
    const visible = new Set(filtered.map((entry) => entry.key));
    setSelected((current) => {
      const next = new Set([...current].filter((key) => visible.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [query, exitFilter, ruleFilter]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((entry) => selected.has(entry.key));
  const someSelected = filtered.some((entry) => selected.has(entry.key)) && !allVisibleSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleSelect = (key: string, event: ReactMouseEvent) => {
    if (event.shiftKey) {
      event.preventDefault();
      const keys = filtered.map((entry) => entry.key);
      const from = lastSelectedKey ? keys.indexOf(lastSelectedKey) : -1;
      const to = keys.indexOf(key);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelected((current) => {
          const next = new Set(current);
          for (let i = start; i <= end; i += 1) next.add(keys[i]);
          return next;
        });
        setLastSelectedKey(key);
        return;
      }
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setLastSelectedKey(key);
  };

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const entry of filtered) next.delete(entry.key);
      } else {
        for (const entry of filtered) next.add(entry.key);
      }
      return next;
    });
  };

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.key)),
    [entries, selected],
  );

  const compose = (entry: LiveDomainConnection) => {
    setContext(null);
    setComposer({ entries: [entry] });
  };

  const onDragStart = (event: DragStartEvent) => {
    const keys = (event.active.data.current as { keys?: string[] } | undefined)?.keys ?? [event.active.id as string];
    setActiveKeys(keys);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const keys = activeKeys.length
      ? activeKeys
      : ((event.active.data.current as { keys?: string[] } | undefined)?.keys ?? [event.active.id as string]);
    setActiveKeys([]);
    if (!event.over) return;
    const overId = String(event.over.id);
    const isExit = overId.startsWith('exit:');
    const isNode = overId.startsWith('node:');
    if (!isExit && !isNode) return;
    const targetId = overId.slice(5);
    const draggedEntries = entries.filter((entry) => keys.includes(entry.key));
    if (!draggedEntries.length) return;
    const element = document.querySelector(
      isExit ? `[data-exit-id="${targetId}"]` : `[data-node-id="${targetId}"]`,
    ) as HTMLElement | null;
    const rect = element?.getBoundingClientRect();
    setComposer({
      entries: draggedEntries,
      ...(isExit ? { exitId: targetId } : { targetNodeId: targetId }),
      rect: rect
        ? { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
        : event.over.rect,
    });
  };

  const testExit = async (exit: Exit) => {
    const group = snapshot?.groups[exit.name];
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

  const removePending = (id: string) => {
    update((draft) => {
      draft.routes = draft.routes.filter((route) => route.id !== id);
    });
  };

  const clearPending = () => {
    update((draft) => {
      draft.routes = draft.routes.filter((route) => !route.pending);
    });
  };

  const canProbe = /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(query.trim());
  const probe = async () => {
    if (!canProbe) return;
    setProbing(true);
    try {
      await api('/api/probe', { method: 'POST', body: { host: query.trim() } });
      toast('success', '探测已发起', '连接流出现该域名后即可拖拽生成规则');
    } catch (error) {
      toast('error', '探测失败', (error as Error).message);
    } finally {
      setProbing(false);
    }
  };

  const rediscover = async () => {
    setRediscovering(true);
    try {
      await api('/api/kernel/rediscover', { method: 'POST' });
      await refreshStatus();
      toast('success', '已重新探测内核');
    } catch (error) {
      toast('error', '探测失败', (error as Error).message);
    } finally {
      setRediscovering(false);
    }
  };

  if (!workspace) return null;
  const kernel = snapshot?.kernel ?? status?.kernel;
  const connected = Boolean(kernel?.connected);
  const stats = snapshot?.stats;
  const groups = snapshot?.groups ?? {};
  const proxyHits = snapshot?.proxyHits ?? {};
  const customExits = exits.filter((exit) => !exit.builtin);
  const builtinExits = exits.filter((exit) => exit.builtin);
  const favoriteIds = new Set(workspace.settings.favoriteExitIds ?? []);
  const favoriteCount = customExits.filter((exit) => favoriteIds.has(exit.id)).length;
  const exitSearch = exitQuery.trim().toLowerCase();
  const visibleCustomExits = [...customExits]
    .filter(
      (exit) =>
        !exitSearch ||
        exit.name.toLowerCase().includes(exitSearch) ||
        exit.type.includes(exitSearch),
    )
    .sort(
      (a, b) =>
        Number(favoriteIds.has(b.id)) - Number(favoriteIds.has(a.id)) ||
        a.order - b.order,
    );
  const visibleNodes = enabledNodes.filter((node) => {
    if (!exitSearch) return true;
    const source = sourcesById.get(node.sourceId);
    return (
      nodeDisplayName(node, source).toLowerCase().includes(exitSearch) ||
      (node.region ?? '').toLowerCase().includes(exitSearch) ||
      node.tags.some((tag) => tag.toLowerCase().includes(exitSearch)) ||
      (source?.name ?? '').toLowerCase().includes(exitSearch)
    );
  });
  const toggleFavorite = (id: string) => {
    update((draft) => {
      const list = draft.settings.favoriteExitIds ?? [];
      draft.settings.favoriteExitIds = list.includes(id)
        ? list.filter((item) => item !== id)
        : [...list, id];
    });
  };
  const quickTargets = customExits.filter((exit) => favoriteIds.has(exit.id)).slice(0, 3);

  const quickRule = (entry: LiveDomainConnection, exitId: string, targetName: string) => {
    const type = entry.isIp ? (isIPv6(entry.host) ? 'IP-CIDR6' : 'IP-CIDR') : 'DOMAIN';
    const payload = entry.isIp ? `${entry.host}/${isIPv6(entry.host) ? 128 : 32}` : entry.host;
    const result = addPendingRules([
      {
        type,
        payload,
        exitId,
        origin: 'manual',
        note: '来自实时连接快捷规则',
      },
    ]);
    if (result.added) toast('success', '已加入待应用', `${payload} → ${targetName}`);
    else toast('info', '规则已存在', `${type} · ${payload}`);
    setContext(null);
  };
  const activeEntries = activeKeys
    .map((key) => entries.find((entry) => entry.key === key))
    .filter((entry): entry is LiveDomainConnection => Boolean(entry));

  const hitsFor = (exit: Exit) => {
    const kernelHits = proxyHits[exit.name];
    if (typeof kernelHits === 'number' && kernelHits > 0) return kernelHits;
    return entries.filter((entry) => entry.exitName === exit.name).length;
  };

  const hitsForNode = (node: ProxyNode) => {
    const name = nodeDisplayName(node, sourcesById.get(node.sourceId));
    return entries.filter((entry) => entry.nodeName === name).length;
  };

  return (
    <div className={cx('page live-page', pendingRoutes.length > 0 && 'has-tray')}>
      <h1 className="visually-hidden">实时连接</h1>

      <div className="stat-strip live-stats">
        <div className="stat-block">
          <div className="stat-label"><span className={cx('dot', connected ? 'green' : 'red')} /> 活动连接</div>
          <div className="stat-value">{stats?.activeConnections ?? 0}<small>条</small></div>
        </div>
        <div className="stat-block">
          <div className="stat-label">目标域名 / IP</div>
          <div className="stat-value">{stats?.domains ?? 0}<small>个</small></div>
        </div>
        <div className="stat-block">
          <div className="stat-label">下行速率</div>
          <div className="stat-value"><span className="down">{formatRate(stats?.downRate)}</span></div>
        </div>
        <div className="stat-block">
          <div className="stat-label">上行速率</div>
          <div className="stat-value"><span className="up">{formatRate(stats?.upRate)}</span></div>
        </div>
        <div className="stat-block stats-state">
          <div className="stat-label">STREAM</div>
          <div className="stat-stream">
            <span className="stream-status">
              <span className={cx('dot', socketConnected ? 'green pulse' : 'red')} />
              {paused ? (
                <span className="amber">已暂停 +{pausedUpdates}</span>
              ) : socketConnected ? (
                <span>1s 实时</span>
              ) : (
                <span className="danger">重连中</span>
              )}
            </span>
            <button
              className={cx('stream-pause', paused && 'active')}
              onClick={() => setPaused(!paused)}
              title={paused ? '继续实时数据' : '暂停实时数据'}
              aria-label={paused ? '继续实时数据' : '暂停实时数据'}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
            </button>
          </div>
        </div>
      </div>

      {!connected ? (
        <div className="offline-inline">
          <WifiOff size={14} />
          <span>Clash Verge 未连接，仍可编辑工作区；启动 Verge 后再重新探测。</span>
          <button className="inline-link" onClick={() => setSettingsOpen(true)}>打开连接设置</button>
          <button className="inline-link" onClick={rediscover}>{rediscovering ? '探测中…' : '重新探测'}</button>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveKeys([])}
      >
        <div className="live-grid">
          <div className="live-main">
            <div className="live-toolbar">
              <div className="search-box live-search">
                <Search size={13} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索域名、规则、进程或 IP"
                  aria-label="搜索连接"
                />
                {canProbe ? (
                  <button
                    className="probe-btn"
                    onClick={probe}
                    disabled={probing}
                    title="通过内核混合端口发起一次探测"
                  >
                    {probing ? <Spinner /> : <Radar size={12} />} 探测
                  </button>
                ) : null}
              </div>
              <Select
                compact
                value={exitFilter}
                onChange={setExitFilter}
                ariaLabel="按出口筛选"
                options={[
                  { value: '', label: '全部出口' },
                  ...exitNames.map((name) => ({ value: name, label: name })),
                ]}
              />
              <Select
                compact
                value={ruleFilter}
                onChange={setRuleFilter}
                ariaLabel="按规则类型筛选"
                options={[
                  { value: '', label: '全部规则' },
                  ...ruleTypes.map((type) => ({ value: type, label: ruleTypeLabel(type) })),
                ]}
              />
              <Select
                compact
                value={sortMode}
                onChange={(value) => setSortMode(value as SortMode)}
                ariaLabel="排序"
                options={[
                  { value: 'recent', label: '最近活动' },
                  { value: 'traffic', label: '总流量' },
                  { value: 'rate', label: '当前速率' },
                  { value: 'name', label: '域名' },
                ]}
              />
              {(query || exitFilter || ruleFilter) ? (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setQuery('');
                    setExitFilter('');
                    setRuleFilter('');
                  }}
                >
                  <X size={12} /> 清除
                </button>
              ) : null}
            </div>

            {selected.size > 0 ? (
              <div className="selection-bar">
                <span className="selection-count mono">{selected.size}</span>
                <span>个域名已选择</span>
                <span className="muted">拖到出口或节点，或</span>
                <button className="btn btn-sm btn-outline" onClick={() => setComposer({ entries: selectedEntries })}>
                  <Plus size={12} /> 生成规则
                </button>
                <span className="spacer" />
                <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
                  清除选择
                </button>
              </div>
            ) : null}

            <div className="conn-table">
              <div className="conn-head">
                <div className="conn-check">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="全选可见连接"
                  />
                </div>
                <div>域名 / 最近活动</div>
                <div>命中规则</div>
                <div>出口 → 节点</div>
                <div className="align-right">速率</div>
                <div className="align-right">总流量</div>
                <div />
              </div>

              <div className="conn-body" ref={listRef}>
                {!snapshot ? (
                  <div className="skeleton-list">
                    {Array.from({ length: 8 }).map((_, index) => (
                      <div className="skeleton-row" key={index}>
                        <span className="skeleton" style={{ width: 14, height: 14 }} />
                        <span className="skeleton" style={{ width: `${180 + (index % 4) * 30}px`, height: 12 }} />
                        <span className="skeleton" style={{ width: 92, height: 12 }} />
                        <span className="skeleton" style={{ width: 140, height: 12 }} />
                        <span className="skeleton" style={{ width: 70, height: 12 }} />
                      </div>
                    ))}
                  </div>
                ) : filtered.length === 0 ? (
                  <EmptyState
                    icon={connected ? <Radar size={20} /> : <WifiOff size={20} />}
                    title={connected ? '还没有可显示的连接' : '内核未连接'}
                    description={
                      connected
                        ? entries.length
                          ? '当前筛选条件下没有连接，试试清除搜索或筛选。'
                          : '访问任意网站，或在上方搜索框输入域名并点击「探测」，连接会实时出现在这里。'
                        : '实时流已暂停。打开设置检查控制器地址与密钥；编辑规则不需要内核在线。'
                    }
                    actions={
                      connected ? (
                        <button className="btn btn-outline btn-sm" onClick={() => {
                          setQuery('');
                          setExitFilter('');
                          setRuleFilter('');
                        }}>
                          清除筛选
                        </button>
                      ) : (
                        <>
                          <button className="btn btn-primary btn-sm" onClick={() => setSettingsOpen(true)}>
                            打开设置
                          </button>
                          <button className="btn btn-outline btn-sm" onClick={rediscover} disabled={rediscovering}>
                            <RefreshCw size={12} /> 重新探测
                          </button>
                        </>
                      )
                    }
                  />
                ) : (
                  <div className="virtual-canvas" style={{ height: virtualizer.getTotalSize() }}>
                    {virtualizer.getVirtualItems().map((virtualItem) => {
                      const entry = filtered[virtualItem.index];
                      if (!entry) return null;
                      return (
                        <div
                          key={entry.key}
                          ref={virtualizer.measureElement}
                          data-index={virtualItem.index}
                          className="virtual-row"
                          style={{ transform: `translateY(${virtualItem.start}px)` }}
                        >
                          <ConnectionRow
                            entry={entry}
                            now={now}
                            selected={selected.has(entry.key)}
                            expanded={expandedKey === entry.key}
                            status={statusForEntry(entry, workspace)}
                            selectedKeys={selected}
                            onToggleSelect={toggleSelect}
                            onToggleExpand={(key) => setExpandedKey((current) => (current === key ? null : key))}
                            onContext={(event, item) => {
                              event.preventDefault();
                              setContext({
                                x: Math.min(event.clientX, window.innerWidth - 235),
                                y: Math.min(event.clientY, window.innerHeight - 390),
                                entry: item,
                              });
                            }}
                            onCompose={compose}
                            onProcess={(entry) => setProcessEntry(entry)}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="live-foot">
              <span>{filtered.length} / {entries.length} 个目标</span>
              <span className="meta-sep">·</span>
              <span>拖域名到出口或节点生成规则</span>
            </div>
          </div>

          <aside className="exit-rail">
            <div className="target-tabs" role="tablist" aria-label="拖放目标类型">
              <button
                role="tab"
                aria-selected={targetTab === 'exits'}
                className={cx('target-tab', targetTab === 'exits' && 'active')}
                onClick={() => setTargetTab('exits')}
              >
                出口 <span>{customExits.length + builtinExits.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={targetTab === 'nodes'}
                className={cx('target-tab', targetTab === 'nodes' && 'active')}
                onClick={() => setTargetTab('nodes')}
              >
                节点 <span>{enabledNodes.length}</span>
              </button>
            </div>

            <div className="exit-rail-search">
              <Search size={12} />
              <input
                value={exitQuery}
                onChange={(event) => setExitQuery(event.target.value)}
                placeholder={targetTab === 'exits' ? '搜索出口' : '搜索节点'}
                aria-label={targetTab === 'exits' ? '搜索出口' : '搜索节点'}
              />
              {exitQuery ? (
                <button className="icon-btn" onClick={() => setExitQuery('')} aria-label="清除目标搜索">
                  <X size={11} />
                </button>
              ) : null}
            </div>

            <div className="exit-rail-scroll" ref={targetScrollRef}>
            {targetTab === 'exits' ? (
              <>
                <div className="exit-section">
                  <div className="exit-section-label">
                    自定义出口 <span>{customExits.length} · 常用 {favoriteCount}</span>
                  </div>
                  <div className="exit-list">
                    {visibleCustomExits.map((exit) => {
                      const group = groups[exit.name];
                      return (
                        <ExitDropCard
                          key={exit.id}
                          exit={exit}
                          resolution={resolutions.get(exit.id)!}
                          group={group}
                          hits={hitsFor(exit)}
                          testing={testingExit === exit.id}
                          favorite={favoriteIds.has(exit.id)}
                          onToggleFavorite={() => toggleFavorite(exit.id)}
                          onTest={() => void testExit(exit)}
                          onManage={() => navigate(`/exits?edit=${exit.id}`)}
                        />
                      );
                    })}
                    {visibleCustomExits.length === 0 ? (
                      <div className="exit-rail-empty">{exitQuery ? '没有匹配的出口' : '还没有自定义出口'}</div>
                    ) : null}
                  </div>
                  <button className="exit-add" onClick={() => navigate('/exits?new=1')}>
                    <Plus size={12} /> 新建出口
                  </button>
                </div>

                <div className="exit-section builtin-section">
                  <div className="exit-section-label">内置出站</div>
                  <div className="exit-list">
                    {builtinExits.map((exit) => (
                      <ExitDropCard
                        key={exit.id}
                        exit={exit}
                        resolution={resolutions.get(exit.id)!}
                        group={groups[exit.name]}
                        hits={hitsFor(exit)}
                        testing={false}
                        favorite={false}
                        onToggleFavorite={() => {}}
                        onTest={() => void testExit(exit)}
                        onManage={() => navigate('/exits')}
                      />
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="exit-section">
                <div className="exit-section-label">
                  节点 <span>{enabledNodes.length}</span>
                </div>
                <div className="exit-list">
                  {visibleNodes.map((node) => (
                    <NodeDropCard
                      key={node.id}
                      node={node}
                      source={sourcesById.get(node.sourceId)}
                      hits={hitsForNode(node)}
                    />
                  ))}
                  {visibleNodes.length === 0 ? (
                    <div className="exit-rail-empty">
                      {enabledNodes.length === 0
                        ? '还没有启用节点，先去「节点与订阅」导入'
                        : '没有匹配的节点'}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
            </div>
          </aside>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeEntries.length ? (
            <div className="drag-overlay">
              <GripVertical size={13} />
              <span className="mono truncate">
                {activeEntries.length === 1 ? activeEntries[0].displayHost : `${activeEntries.length} 个域名`}
              </span>
              <span className="badge badge-green">拖到出口 / 节点</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {pendingRoutes.length > 0 ? (
        <div className="tray">
          <div className="tray-head">
            <div className="tray-title">
              <span className="dot amber" />
              待应用改动
              <span className="number-badge">{pendingRoutes.length}</span>
              <span className="tray-sub">导出后写入 YAML · 不自动重载内核</span>
            </div>
            <div className="tray-actions">
              <button className="btn btn-sm btn-ghost" onClick={clearPending}>清空</button>
              <button className="btn btn-sm btn-outline" onClick={() => setShowPreview(true)}>预览 YAML</button>
              <button className="btn btn-sm btn-primary" onClick={() => setShowPreview(true)}>导出配置</button>
            </div>
          </div>
          <div className="tray-list">
            {pendingRoutes.map((route) => {
              const target = routeTargetInfo(route, workspace);
              const payload = route.kind === 'rule' ? route.payload : route.name;
              const type = route.kind === 'rule' ? route.type : 'RULE-SET';
              return (
                <div className="tray-item" key={route.id}>
                  <span className={cx('badge', type === 'RULE-SET' ? 'badge-blue' : 'badge-amber')}>{type}</span>
                  <span className="tray-payload mono truncate" title={payload}>{payload}</span>
                  <ArrowRight size={11} />
                  <span className={cx('tray-exit truncate', !target.available && 'danger')}>{target.name}</span>
                  <button
                    className="icon-btn"
                    title="撤销这条改动"
                    onClick={() => removePending(route.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {composer ? (
        <RuleComposer
          entries={composer.entries}
          initialExitId={composer.exitId}
          initialNodeId={composer.targetNodeId}
          anchorRect={composer.rect}
          onClose={() => setComposer(null)}
          onDone={() => setSelected(new Set())}
        />
      ) : null}

      {showPreview ? <PreviewDialog onClose={() => setShowPreview(false)} /> : null}

      {context ? (
        <div
          className="ctx-menu"
          style={{ left: context.x, top: context.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="ctx-label">{context.entry.displayHost}</div>
          <div className="ctx-label">快速规则</div>
          <button className="ctx-item" onClick={() => quickRule(context.entry, 'direct', 'DIRECT')}>
            <ArrowRight size={13} /> 直连此目标
          </button>
          <button className="ctx-item" onClick={() => quickRule(context.entry, 'reject', 'REJECT')}>
            <Ban size={13} /> 拒绝此目标
          </button>
          {quickTargets.map((exit) => (
            <button className="ctx-item" key={exit.id} onClick={() => quickRule(context.entry, exit.id, exit.name)}>
              <Zap size={13} /> 走「{exit.name}」
            </button>
          ))}
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => compose(context.entry)}>
            <Plus size={13} /> 生成规则…
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setProcessEntry(context.entry);
              setContext(null);
            }}
            disabled={!context.entry.processes.length && !context.entry.processPaths.length}
            title={context.entry.processes.length || context.entry.processPaths.length ? undefined : '当前连接没有进程信息'}
          >
            <Activity size={13} /> 按进程生成规则
          </button>
          <div className="ctx-sep" />
          <button
            className="ctx-item"
            onClick={() => {
              void copyToClipboard(context.entry.host);
              setContext(null);
            }}
          >
            <Copy size={13} /> 复制域名
          </button>
          {context.entry.destinationIp ? (
            <button
              className="ctx-item"
              onClick={() => {
                void copyToClipboard(context.entry.destinationIp!);
                setContext(null);
              }}
            >
              <Copy size={13} /> 复制目标 IP
            </button>
          ) : null}
          <div className="ctx-sep" />
          <button
            className="ctx-item"
            onClick={() => {
              setQuery(context.entry.displayHost);
              setContext(null);
            }}
          >
            <Search size={13} /> 仅看这个域名
          </button>
        </div>
      ) : null}

      {processEntry ? (
        <ProcessRuleDialog entry={processEntry} onClose={() => setProcessEntry(null)} />
      ) : null}
    </div>
  );
}

function ProcessRuleDialog({ entry, onClose }: { entry: LiveDomainConnection; onClose: () => void }) {
  const workspace = useWorkspace((state) => state.workspace);
  const addPendingRules = useWorkspace((state) => state.addPendingRules);
  const [type, setType] = useState<'PROCESS-NAME' | 'PROCESS-PATH'>(
    entry.processes.length ? 'PROCESS-NAME' : 'PROCESS-PATH',
  );
  const options = type === 'PROCESS-NAME' ? entry.processes : entry.processPaths;
  const [value, setValue] = useState(options[0] ?? '');
  const exits = workspace?.exits
    ? [...workspace.exits].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    : [];
  const [exitId, setExitId] = useState(
    exits.find((exit) => !exit.builtin)?.id ?? 'direct',
  );
  const [targetNodeId, setTargetNodeId] = useState<string | undefined>();

  useEffect(() => {
    setValue((type === 'PROCESS-NAME' ? entry.processes : entry.processPaths)[0] ?? '');
  }, [type, entry.processes, entry.processPaths]);

  const submit = () => {
    if (!value.trim()) {
      toast('warn', '请选择或填写进程');
      return;
    }
    const node = targetNodeId ? workspace?.nodes.find((item) => item.id === targetNodeId) : undefined;
    const exit = workspace?.exits.find((item) => item.id === exitId);
    const source = node ? workspace?.sources.find((item) => item.id === node.sourceId) : undefined;
    const targetName = node ? nodeDisplayName(node, source) : exit?.name;
    const result = addPendingRules([
      {
        type,
        payload: value.trim(),
        exitId: node ? '' : exitId,
        targetNodeId: node?.id,
        origin: 'manual',
        note: `来自 ${entry.displayHost} 的进程信息`,
      },
    ]);
    if (result.added) toast('success', '已加入待应用', `${type} · ${value.trim()} → ${targetName ?? ''}`);
    else toast('info', '规则已存在');
    onClose();
  };

  return (
    <Modal
      title="按进程生成规则"
      subtitle={`来自 ${entry.displayHost} 的连接`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit}>加入待应用</button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span className="field-label">规则类型</span>
          <Select
            value={type}
            onChange={(next) => setType(next as typeof type)}
            ariaLabel="规则类型"
            options={[
              { value: 'PROCESS-NAME', label: 'PROCESS-NAME · 进程名' },
              { value: 'PROCESS-PATH', label: 'PROCESS-PATH · 完整路径' },
            ]}
          />
        </label>
        {options.length > 1 ? (
          <label className="field">
            <span className="field-label">进程</span>
            <Select
              value={value}
              onChange={setValue}
              ariaLabel="进程"
              options={options.map((option) => ({ value: option, label: option }))}
            />
          </label>
        ) : (
          <label className="field">
            <span className="field-label">进程</span>
            <input className="input mono" value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field-label">目标出口 / 节点</span>
          <RuleTargetSelect
            exitId={exitId}
            targetNodeId={targetNodeId}
            exits={exits}
            nodes={workspace?.nodes ?? []}
            sources={workspace?.sources ?? []}
            onChange={(target) => {
              setExitId(target.exitId);
              setTargetNodeId(target.targetNodeId);
            }}
          />
        </label>
        {entry.processes.length === 0 ? (
          <div className="callout warn">
            <TriangleAlert size={14} />
            <span>当前连接没有可用的进程名（TUN 模式下常见）。可以手动填写，或改用域名规则。</span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
