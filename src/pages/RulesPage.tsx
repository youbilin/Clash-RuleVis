import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpDown,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  Globe,
  GripVertical,
  Layers,
  ListChecks,
  ListOrdered,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type { Exit, ProxyNode, Route, RuleRoute, RuleSetRoute, RuleType, Source, Workspace } from '../../shared/types';
import {
  findCoveringRoute,
  findDuplicateRoute,
  insertRouteOrdered,
  routeTargetInfo,
  suggestRootDomain,
} from '../../shared/model';
import { api, copyToClipboard, openExternal } from '../api';
import { useWorkspace } from '../store/workspace';
import { useUi, toast } from '../store/ui';
import { useLive } from '../store/live';
import type { RouteDisplayInfo } from '../lib/catalog';
import { behaviorLabel, formatLabel, ruleOriginLabel, rulesetOriginLabel, ruleTypeLabel } from '../lib/labels';
import { EmptyState, PageHeader, Spinner, Switch } from '../components/Common';
import { Modal } from '../components/Overlay';
import { formatCompact, formatRelative } from '../lib/format';
import { cx, repositoryUrl } from '../lib/misc';
import { notifyRemoved } from '../lib/undo';
import { RuleTargetSelect } from '../components/RuleTargetSelect';
import { Select } from '../components/Select';
const RuleCatalogDialog = lazy(() =>
  import('../components/RuleCatalogDialog').then((module) => ({ default: module.RuleCatalogDialog })),
);
const RuleSetWizard = lazy(() =>
  import('./RuleSetsPage').then((module) => ({ default: module.RuleSetWizard })),
);

type FilterKind = 'all' | 'single' | 'ruleset' | 'source';

const FILTER_LABELS: Array<{ id: FilterKind; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'single', label: '单条规则' },
  { id: 'ruleset', label: '规则集' },
  { id: 'source', label: '订阅自带' },
];

const RULE_TYPE_OPTIONS: Array<{ value: RuleType; label: string }> = [
  { value: 'DOMAIN-SUFFIX', label: 'DOMAIN-SUFFIX · 域名后缀' },
  { value: 'DOMAIN', label: 'DOMAIN · 精确域名' },
  { value: 'DOMAIN-KEYWORD', label: 'DOMAIN-KEYWORD · 域名关键字' },
  { value: 'IP-CIDR', label: 'IP-CIDR · IPv4 网段' },
  { value: 'IP-CIDR6', label: 'IP-CIDR6 · IPv6 网段' },
  { value: 'PROCESS-NAME', label: 'PROCESS-NAME · 进程名' },
  { value: 'PROCESS-PATH', label: 'PROCESS-PATH · 进程路径' },
  { value: 'GEOSITE', label: 'GEOSITE · 域名集合' },
  { value: 'GEOIP', label: 'GEOIP · 国家/地区' },
  { value: 'DST-PORT', label: 'DST-PORT · 目标端口' },
];

function isSource(route: Route): boolean {
  return Boolean(route.sourceId) || route.origin === 'source';
}

function routeTitle(route: Route): string {
  if (route.kind === 'ruleset') return route.name;
  if (route.type === 'MATCH') return 'MATCH · 兜底';
  return `${route.type} · ${route.payload}`;
}

interface RecentHit {
  host: string;
  exitName: string | null;
  nodeName: string | null;
  count: number;
  lastSeen: number;
}

interface RuleRowProps {
  route: Route;
  index: number;
  display?: RouteDisplayInfo;
  exits: Exit[];
  nodes: ProxyNode[];
  sources: Source[];
  dragDisabled: boolean;
  issue?: { cover?: number; duplicate?: number };
  providerHits?: number;
  recentHit?: RecentHit;
  onShowHits?: () => void;
  selectMode: boolean;
  checked: boolean;
  onToggleSelect: () => void;
  refreshing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: (() => void) | null;
  onShowSource?: () => void;
  onTargetChange: (target: { exitId: string; targetNodeId?: string }) => void;
  onToggle: (enabled: boolean) => void;
}

function RuleRow({
  route,
  index,
  display,
  exits,
  nodes,
  sources,
  dragDisabled,
  issue,
  providerHits,
  recentHit,
  onShowHits,
  selectMode,
  checked,
  onToggleSelect,
  refreshing,
  onEdit,
  onDelete,
  onRefresh,
  onShowSource,
  onTargetChange,
  onToggle,
}: RuleRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: route.id,
    disabled: dragDisabled,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const targetNode = route.kind === 'rule' && route.targetNodeId
    ? nodes.find((node) => node.id === route.targetNodeId)
    : undefined;
  const targetExists = route.kind === 'rule' && route.targetNodeId
    ? Boolean(targetNode?.enabled)
    : exits.some((exit) => exit.id === route.exitId);
  const isSourceRoute = Boolean(route.sourceId) || route.origin === 'source';
  const origin = route.kind === 'ruleset'
    ? rulesetOriginLabel(route)
    : ruleOriginLabel(route.origin);
  const issueText = issue
    ? issue.duplicate !== undefined
      ? `与第 ${issue.duplicate + 1} 条重复`
      : `被第 ${(issue.cover ?? 0) + 1} 条完全覆盖`
    : '';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx('rule-row', !route.enabled && 'disabled', isDragging && 'dragging', route.kind === 'ruleset' && 'is-ruleset', selectMode && checked && 'selected')}
      onClick={() => {
        if (selectMode) onToggleSelect();
        else if (route.kind === 'rule') onEdit();
        else onShowSource?.();
      }}
    >
      <button
        className="rule-grip"
        {...attributes}
        {...listeners}
        onClick={(event) => event.stopPropagation()}
        disabled={dragDisabled}
        title={dragDisabled ? '清除筛选后可拖动排序' : '拖动调整优先级'}
      >
        <GripVertical size={13} />
      </button>
      <span className="rule-index mono">
        {selectMode ? (
          <input
            className="rule-select"
            type="checkbox"
            checked={checked}
            onClick={(event) => event.stopPropagation()}
            onChange={onToggleSelect}
            aria-label={`选择第 ${index + 1} 条规则`}
          />
        ) : (
          index + 1
        )}
      </span>

      <div className="rule-kind">
        {route.kind === 'ruleset' ? (
          <span className="badge badge-blue"><Layers size={9} /> 规则集</span>
        ) : (
          <span className={cx('badge', route.type === 'MATCH' ? 'badge-amber' : '')} title={route.type}>
            {ruleTypeLabel(route.type)}
          </span>
        )}
      </div>

      <div className="rule-content">
        {route.kind === 'rule' ? (
          <>
            <div className="rule-main-line">
              <span className="rule-payload mono truncate" title={route.payload}>{route.payload}</span>
              {route.noResolve ? <span className="badge badge-plain">不解析 DNS</span> : null}
            </div>
            {route.note ? <div className="rule-note truncate">{route.note}</div> : null}
          </>
        ) : (
          <>
            <div className="rule-main-line">
              <span className="rule-name truncate" title={display?.slug || route.name}>{display?.name || route.name}</span>
              <span className="badge">{behaviorLabel(route.behavior)}</span>
              <span className="badge">{formatLabel(route.format)}</span>
              {route.inline ? <span className="badge badge-green">内联</span> : <span className="badge badge-blue">在线更新</span>}
            </div>
            <div className="rule-note-line">
              <span className="rule-note truncate" title={display?.description}>
                {display?.description}
                {route.ruleCount ? ` · ${formatCompact(route.ruleCount)} 条` : ''}
                {providerHits ? ` · 命中 ${formatCompact(providerHits)}` : ''}
              </span>
              {recentHit ? (
                <button
                  className="rule-recent"
                  onClick={(event) => {
                    event.stopPropagation();
                    onShowHits?.();
                  }}
                  title={`最近命中 ${recentHit.host} → ${recentHit.nodeName ?? recentHit.exitName ?? 'DIRECT'} · ${formatRelative(recentHit.lastSeen)}`}
                >
                  <Activity size={10} />
                  <span className="rule-recent-host truncate">{recentHit.host}</span>
                  <ArrowRight size={9} />
                  <span className="rule-recent-node truncate">{recentHit.nodeName ?? recentHit.exitName ?? 'DIRECT'}</span>
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>

      <div className="rule-target" data-control onClick={(event) => event.stopPropagation()}>
        {route.kind === 'rule' ? (
          <RuleTargetSelect
            exitId={route.exitId}
            targetNodeId={route.targetNodeId}
            exits={exits}
            nodes={nodes}
            sources={sources}
            compact
            onChange={onTargetChange}
          />
        ) : (
          <Select
            compact
            className={cx(!targetExists && 'invalid')}
            value={route.exitId}
            onChange={(value) => onTargetChange({ exitId: value })}
            ariaLabel="目标出口"
            options={[
              ...(!targetExists
                ? [{ value: route.exitId, label: '⚠ 出口已丢失', disabled: true }]
                : []),
              ...exits.map((exit) => ({ value: exit.id, label: exit.name })),
            ]}
          />
        )}      </div>

      <div className="rule-origin">
        <span className={cx('badge', isSourceRoute ? 'badge-plain' : route.origin === 'catalog' ? 'badge-green' : '')}>{origin}</span>
      </div>

      <div className="rule-marks">
        {issue ? (
          <span className="rule-warning" title={issueText}>
            <AlertTriangle size={13} />
          </span>
        ) : !targetExists ? (
          <span
            className="rule-warning"
            title={
              route.kind === 'rule' && route.targetNodeId
                ? targetNode
                  ? '目标节点已禁用'
                  : '目标节点已不存在'
                : '目标出口已不存在'
            }
          >
            <AlertTriangle size={13} />
          </span>
        ) : null}
      </div>

      <div className="rule-toggle" data-control onClick={(event) => event.stopPropagation()}>
        <Switch checked={route.enabled} onChange={onToggle} label="启用规则" />
      </div>

      <div className="rule-actions" data-control onClick={(event) => event.stopPropagation()}>
        {route.kind === 'rule' ? (
          <button className="icon-btn" title="编辑规则" onClick={onEdit}>
            <Pencil size={12} />
          </button>
        ) : (
          <>
            <button className="icon-btn" title="查看来源与源仓库" onClick={onShowSource}>
              <Globe size={12} />
            </button>
            {onRefresh ? (
              <button className="icon-btn" title="刷新规则集" onClick={onRefresh} disabled={refreshing}>
                {refreshing ? <Spinner /> : <RefreshCw size={12} />}
              </button>
            ) : null}
          </>
        )}
        <button className="icon-btn danger" title="删除" onClick={onDelete}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

export function RulesPage() {
  const workspace = useWorkspace((state) => state.workspace);
  const update = useWorkspace((state) => state.update);
  const createUndoPoint = useWorkspace((state) => state.createUndoPoint);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const confirm = useUi((state) => state.confirm);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKind>('all');
  const [query, setQuery] = useState('');
  const [onlyInvalid, setOnlyInvalid] = useState(false);
  const [onlyZeroHit, setOnlyZeroHit] = useState(false);
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; id: string } | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const snapshot = useLive((state) => state.snapshot);
  const [hitDetail, setHitDetail] = useState<{ route: RuleSetRoute; hits: RecentHit[] } | null>(null);
  const [sourceDetail, setSourceDetail] = useState<RuleSetRoute | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupBySource, setGroupBySource] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [catalogDisplay, setCatalogDisplay] = useState<((route: RuleSetRoute) => RouteDisplayInfo) | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    const editId = params.get('edit');
    if (!editId) return;
    const route = useWorkspace.getState().workspace?.routes.find((item) => item.id === editId);
    if (route && route.kind === 'rule' && route.type !== 'MATCH') setEditing({ mode: 'edit', id: editId });
  }, [params]);

  useEffect(() => {
    const q = params.get('q');
    const openCatalog = params.get('catalog') === '1';
    if (q) setQuery(q);
    if (openCatalog) setCatalogOpen(true);
    if (!q && !openCatalog) return;
    const next = new URLSearchParams(params);
    next.delete('q');
    next.delete('catalog');
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [filter, query, groupBySource, onlyInvalid, onlyZeroHit]);

  useEffect(() => {
    let active = true;
    void import('../lib/catalog').then((module) => {
      if (active) setCatalogDisplay(() => module.routeDisplayInfo);
    });
    return () => {
      active = false;
    };
  }, []);

  const routes = workspace?.routes ?? [];
  const matchRoute = routes.find((route): route is RuleRoute => route.kind === 'rule' && route.type === 'MATCH');
  const sortableRoutes = routes.filter((route) => !(route.kind === 'rule' && route.type === 'MATCH'));
  const editingRoute = editing?.mode === 'edit'
    ? routes.find(
        (route): route is RuleRoute => route.id === editing.id && route.kind === 'rule' && route.type !== 'MATCH',
      )
    : undefined;

  const issues = useMemo(() => {
    const map = new Map<string, { cover?: number; duplicate?: number }>();
    routes.forEach((route, index) => {
      if (route.kind !== 'rule' || route.type === 'MATCH' || !route.enabled) return;
      const cover = findCoveringRoute(routes, index);
      const duplicate = findDuplicateRoute(routes, route, route.id);
      if (cover || duplicate >= 0) {
        map.set(route.id, {
          cover: cover?.index,
          duplicate: duplicate >= 0 ? duplicate : undefined,
        });
      }
    });
    return map;
  }, [routes]);

  if (!workspace) return null;

  const exits = [...workspace.exits].sort(
    (a, b) => Number(Boolean(a.builtin)) - Number(Boolean(b.builtin)) || a.order - b.order,
  );
  const customSingle = sortableRoutes.filter((route) => route.kind === 'rule' && !isSource(route)).length;
  const rulesetTotal = sortableRoutes.filter((route) => route.kind === 'ruleset').length;
  const sourceCount = sortableRoutes.filter(isSource).length;
  const ruleHitCount = (route: Route): number => {
    if (route.kind === 'ruleset') {
      const keys = [route.providerName || route.name, route.providerName, route.name].filter(Boolean);
      for (const key of keys) {
        const hits = snapshot?.ruleHits[`RULE-SET|${key}`];
        if (typeof hits === 'number') return hits;
      }
      return 0;
    }
    return snapshot?.ruleHits[`${route.type}|${route.payload}`] ?? 0;
  };
  const invalidTargets = sortableRoutes.filter((route) => !routeTargetInfo(route, workspace).available);
  const describeRoute = (route: RuleSetRoute): RouteDisplayInfo =>
    catalogDisplay?.(route) ?? {
      name: route.name,
      description: route.source.type === 'url' ? '远程规则集' : route.source.fileName ?? '本地规则集',
      providerName: route.providerName || route.name,
      entry: null,
    };
  const filtered = sortableRoutes.filter((route) => {
    if (filter === 'single' && !(route.kind === 'rule' && !isSource(route))) return false;
    if (filter === 'ruleset' && route.kind !== 'ruleset') return false;
    if (filter === 'source' && !isSource(route)) return false;
    if (onlyInvalid && routeTargetInfo(route, workspace).available) return false;
    if (onlyZeroHit && (!route.enabled || ruleHitCount(route) > 0)) return false;
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    const targetName = routeTargetInfo(route, workspace).name;
    if (route.kind === 'rule') {
      return (
        route.type.toLowerCase().includes(q) ||
        route.payload.toLowerCase().includes(q) ||
        targetName.toLowerCase().includes(q) ||
        (route.note ?? '').toLowerCase().includes(q)
      );
    }
    const display = describeRoute(route);
    return (
      route.name.toLowerCase().includes(q) ||
      display.name.toLowerCase().includes(q) ||
      display.description.toLowerCase().includes(q) ||
      route.behavior.includes(q) ||
      route.format.includes(q) ||
      targetName.toLowerCase().includes(q) ||
      route.source.value.toLowerCase().includes(q)
    );
  });
  const issuesCount = issues.size;
  const zeroHitCount = snapshot
    ? sortableRoutes.filter((route) => route.enabled && ruleHitCount(route) === 0).length
    : 0;
  const dragDisabled = filter !== 'all' || Boolean(query.trim()) || onlyInvalid || onlyZeroHit;

  const ruleGroups = (() => {
    if (!groupBySource) return [];
    const map = new Map<string, { key: string; label: string; hint: string; routes: Route[] }>();
    for (const route of filtered) {
      const key = route.sourceId ?? '__local__';
      const source = route.sourceId ? workspace.sources.find((item) => item.id === route.sourceId) : undefined;
      const existing = map.get(key);
      if (existing) existing.routes.push(route);
      else {
        map.set(key, {
          key,
          label: source?.name ?? (route.sourceId ? '来源已删除' : '本地 / 手动'),
          hint: source ? (source.type === 'subscription' ? '订阅' : source.type === 'verge' ? 'Verge' : '导入') : '自定义',
          routes: [route],
        });
      }
    }
    return [...map.values()];
  })();

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const selectAllVisible = () => {
    setSelectedIds(new Set(filtered.map((route) => route.id)));
  };

  const setSelectedEnabled = (enabled: boolean) => {
    if (!selectedIds.size) return;
    update((draft) => {
      for (const route of draft.routes) {
        if (selectedIds.has(route.id)) route.enabled = enabled;
      }
    });
    toast('success', enabled ? '已启用所选规则' : '已停用所选规则', `${selectedIds.size} 项`);
  };

  const deleteSelected = async () => {
    if (!selectedIds.size) return;
    const confirmed = await confirm({
      title: '批量删除规则',
      message: `将删除选中的 ${selectedIds.size} 条规则或规则集。此操作可以通过历史记录恢复。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    const undo = await createUndoPoint(`批量删除规则 · ${selectedIds.size} 项`);
    update((draft) => {
      draft.routes = draft.routes.filter((route) => !selectedIds.has(route.id));
    });
    notifyRemoved(undo, `已删除 ${selectedIds.size} 项`, '可在历史中恢复');
    exitSelectMode();
  };

  const renderRuleRow = (route: Route) => (
    <RuleRow
      key={route.id}
      route={route}
      index={routes.findIndex((item) => item.id === route.id)}
      display={route.kind === 'ruleset' ? describeRoute(route) : undefined}
      exits={exits}
      nodes={workspace.nodes}
      sources={workspace.sources}
      dragDisabled={dragDisabled || groupBySource || selectMode}
      issue={issues.get(route.id)}
      providerHits={route.kind === 'ruleset' ? providerHitsFor(route) : undefined}
      recentHit={route.kind === 'ruleset' ? recentHitsFor(route)[0] : undefined}
      onShowHits={route.kind === 'ruleset' ? () => setHitDetail({ route, hits: recentHitsFor(route) }) : undefined}
      refreshing={refreshingId === route.id}
      selectMode={selectMode}
      checked={selectedIds.has(route.id)}
      onToggleSelect={() => toggleSelected(route.id)}
      onEdit={() => setEditing({ mode: 'edit', id: route.id })}
      onDelete={() => void deleteRoute(route)}
      onRefresh={route.kind === 'ruleset' ? () => void refreshRuleSet(route) : null}
      onShowSource={route.kind === 'ruleset' ? () => setSourceDetail(route) : undefined}
      onTargetChange={(target) =>
        updateRoute(route.id, (draft) => {
          draft.exitId = target.exitId;
          if (draft.kind === 'rule') draft.targetNodeId = target.targetNodeId;
        })
      }
      onToggle={(enabled) =>
        updateRoute(route.id, (draft) => {
          draft.enabled = enabled;
        })
      }
    />
  );

  const providerKeyForRoute = (route: RuleSetRoute): string => route.providerName || route.name;

  const providerHitsFor = (route: RuleSetRoute): number => {
    const keys = [providerKeyForRoute(route), route.providerName, route.name].filter(Boolean);
    for (const key of keys) {
      const hits = snapshot?.ruleHits[`RULE-SET|${key}`];
      if (typeof hits === 'number') return hits;
    }
    return 0;
  };

  const recentHitsByProvider = useMemo(() => {
    const map = new Map<string, Map<string, RecentHit>>();
    for (const entry of snapshot?.connections ?? []) {
      for (const variant of entry.variants) {
        if (variant.ruleType !== 'RULE-SET') continue;
        const key = variant.rulePayload.toLowerCase();
        const rows = map.get(key) ?? new Map<string, RecentHit>();
        const hitKey = `${entry.displayHost}|${variant.nodeName ?? ''}|${variant.exitName ?? ''}`;
        const existing = rows.get(hitKey);
        if (existing) {
          existing.count += variant.count;
          existing.lastSeen = Math.max(existing.lastSeen, entry.lastSeen);
        } else {
          rows.set(hitKey, {
            host: entry.displayHost,
            exitName: variant.exitName,
            nodeName: variant.nodeName,
            count: variant.count,
            lastSeen: entry.lastSeen,
          });
        }
        map.set(key, rows);
      }
    }
    return map;
  }, [snapshot?.connections]);

  const recentHitsFor = (route: RuleSetRoute): RecentHit[] => {
    const keys = [providerKeyForRoute(route), route.providerName, route.name]
      .filter(Boolean)
      .map((key) => key!.toLowerCase());
    for (const key of keys) {
      const rows = recentHitsByProvider.get(key);
      if (rows?.size) {
        return [...rows.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      }
    }
    return [];
  };

  const updateRoute = (id: string, mutate: (draft: Route) => void) => {
    update((draft) => {
      const target = draft.routes.find((route) => route.id === id);
      if (target) mutate(target);
    });
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || dragDisabled) return;
    const ids = sortableRoutes.map((route) => route.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const moved = arrayMove(sortableRoutes, oldIndex, newIndex);
    update((draft) => {
      const match = draft.routes.find((route) => route.kind === 'rule' && route.type === 'MATCH');
      draft.routes = match ? [...moved, match] : moved;
    });
  };

  const organise = () => {
    update((draft) => {
      const match = draft.routes.find((route) => route.kind === 'rule' && route.type === 'MATCH');
      const singles = draft.routes.filter((route) => route.kind === 'rule' && route.type !== 'MATCH' && !isSource(route));
      const rulesets = draft.routes.filter((route) => route.kind === 'ruleset' && !isSource(route));
      const source = draft.routes.filter(isSource);
      draft.routes = [...singles, ...rulesets, ...source, ...(match ? [match] : [])];
    });
    toast('success', '已按默认顺序整理', '单条规则 → 规则集 → 订阅规则 → MATCH');
  };

  const refreshRuleSet = async (route: RuleSetRoute) => {
    setRefreshingId(route.id);
    try {
      const result = await api<{ workspace: Workspace; route: RuleSetRoute }>(
        `/api/rule-sets/${route.id}/refresh`,
        { method: 'POST' },
      );
      applyServerWorkspace(result.workspace);
      toast('success', '规则集已刷新', describeRoute(route).name);
    } catch (error) {
      toast('error', '刷新规则集失败', (error as Error).message);
    } finally {
      setRefreshingId(null);
    }
  };

  const cleanInvalidTargets = async () => {
    if (!invalidTargets.length) return;
    const confirmed = await confirm({
      title: '清理失效目标规则',
      message: `将删除 ${invalidTargets.length} 条目标节点或出口已失效的规则。此操作可以通过历史记录恢复。`,
      confirmLabel: '清理',
      danger: true,
    });
    if (!confirmed) return;
    const undo = await createUndoPoint('清理失效目标规则');
    const ids = new Set(invalidTargets.map((route) => route.id));
    update((draft) => {
      draft.routes = draft.routes.filter((route) => !ids.has(route.id));
    });
    setOnlyInvalid(false);
    if (selectMode) exitSelectMode();
    notifyRemoved(undo, '失效规则已清理', `${ids.size} 条`);
  };

  const deleteRoute = async (route: Route) => {
    const isRuleSet = route.kind === 'ruleset';
    const confirmed = await confirm({
      title: isRuleSet ? '删除规则集' : '删除规则',
      message: [
        `${isRuleSet ? `规则集「${(route as RuleSetRoute).name}」` : `规则「${routeTitle(route)}」`}将从有序列表移除。`,
        isSource(route) ? '这是订阅自带内容，刷新订阅后可能会重新出现。' : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    const label = route.kind === 'ruleset' ? describeRoute(route).name : routeTitle(route);
    const undo = await createUndoPoint((isRuleSet ? '删除规则集 · ' : '删除规则 · ') + label);
    update((draft) => {
      draft.routes = draft.routes.filter((item) => item.id !== route.id);
    });
    notifyRemoved(undo, isRuleSet ? '规则集已删除' : '规则已删除', label);
  };

  return (
    <div className="page rules-page">
      <PageHeader
        kicker="RULESET / PRIORITY"
        title="规则集"
        subtitle={`${rulesetTotal} 个规则集 · ${sourceCount} 条订阅规则${customSingle ? ` · ${customSingle} 条自定义` : ''} · 拖动排序`}
        actions={
          <>
            <button className="btn btn-ghost" onClick={organise} title="按单条规则 → 规则集 → 订阅规则 → MATCH 重排">
              <ListOrdered size={13} /> 整理顺序
            </button>
            <button className="btn btn-outline" onClick={() => setAdvancedOpen(true)}>
              <Upload size={13} /> 高级导入
            </button>
            <button className="btn btn-outline" onClick={() => setEditing({ mode: 'new' })}>
              <Plus size={13} /> 手写规则
            </button>
            <button className="btn btn-primary" onClick={() => setCatalogOpen(true)}>
              <BookOpen size={13} /> 从规则库添加
            </button>
          </>
        }
      />

      <div className="rule-toolbar">
        <div className="rule-filter-tabs">
          {FILTER_LABELS.map((item) => {
            const count =
              item.id === 'all'
                ? sortableRoutes.length
                : item.id === 'single'
                  ? customSingle
                  : item.id === 'ruleset'
                    ? rulesetTotal
                    : sourceCount;
            return (
              <button
                key={item.id}
                className={cx('rule-filter-tab', filter === item.id && 'active')}
                onClick={() => {
                  setFilter(item.id);
                  setOnlyInvalid(false);
                  setOnlyZeroHit(false);
                }}
              >
                {item.label}
                <span className="number-badge">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="search-box" style={{ flex: '0 1 260px' }}>
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索中文规则名、域名、出口或来源" />
        </div>
        {invalidTargets.length ? (
          <button
            className={cx('rule-view-btn', onlyInvalid && 'active')}
            onClick={() => setOnlyInvalid((value) => !value)}
            title="只显示目标节点或出口已失效的规则"
          >
            <AlertTriangle size={12} /> 失效 {invalidTargets.length}
          </button>
        ) : null}
        {snapshot ? (
          <button
            className={cx('rule-view-btn', onlyZeroHit && 'active')}
            onClick={() => setOnlyZeroHit((value) => !value)}
            title="只显示已启用、内核累计命中为 0 的规则；需先应用当前配置"
          >
            零命中 {zeroHitCount}
          </button>
        ) : null}
        {invalidTargets.length ? (
          <button className="rule-view-btn" onClick={() => void cleanInvalidTargets()} title="删除目标已失效的规则">
            <Trash2 size={12} /> 清理失效
          </button>
        ) : null}
        <button
          className={cx('rule-view-btn', selectMode && 'active')}
          onClick={() => {
            if (selectMode) exitSelectMode();
            else setSelectMode(true);
          }}
          title="批量选择规则"
        >
          <ListChecks size={12} /> 批量
        </button>
        <button
          className={cx('rule-view-btn', groupBySource && 'active')}
          onClick={() => setGroupBySource((value) => !value)}
          title="按来源分组折叠"
        >
          <Layers size={12} /> 按来源
        </button>
        {issuesCount ? (
          <span className="rule-issue-count" title="存在被覆盖或重复的规则">
            <AlertTriangle size={12} /> {issuesCount} 条需要注意
          </span>
        ) : null}
        {(dragDisabled || selectMode || groupBySource) ? <span className="faint" style={{ fontSize: 11.5 }}>{selectMode ? '选择模式' : groupBySource ? '分组视图' : '筛选时不可拖动排序'}</span> : null}
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 11.5 }}>{filtered.length} / {sortableRoutes.length}</span>
      </div>

      {selectMode ? (
        <div className="rule-bulk-bar">
          <span><strong>{selectedIds.size}</strong> 项已选</span>
          <button className="btn btn-sm btn-ghost" onClick={selectAllVisible}>全选当前</button>
          <button className="btn btn-sm btn-outline" disabled={!selectedIds.size} onClick={() => setSelectedEnabled(true)}>启用</button>
          <button className="btn btn-sm btn-outline" disabled={!selectedIds.size} onClick={() => setSelectedEnabled(false)}>停用</button>
          <button className="btn btn-sm btn-danger" disabled={!selectedIds.size} onClick={() => void deleteSelected()}>删除</button>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={exitSelectMode}>完成</button>
        </div>
      ) : null}

      <div className="rule-list-panel panel">
        <div className="rule-list-head">
          <span />
          <span>#</span>
          <span>类型</span>
          <span>规则 / 来源</span>
          <span>目标</span>
          <span>来源</span>
          <span>状态</span>
          <span>启用</span>
          <span />
        </div>

        {sortableRoutes.length === 0 ? (
          <EmptyState
            icon={<ArrowUpDown size={20} />}
            title="还没有分流规则"
            description="从规则库选择组合，或在实时连接页把域名拖到出口/节点。"
            actions={
              <>
                <button className="btn btn-primary btn-sm" onClick={() => setCatalogOpen(true)}>
                  <BookOpen size={12} /> 从规则库添加
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => setEditing({ mode: 'new' })}>
                  <Plus size={12} /> 手写规则
                </button>
              </>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Search size={20} />} title="没有匹配的规则" description="试试其他关键词或筛选条件。" />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={filtered.map((route) => route.id)} strategy={verticalListSortingStrategy}>
              {groupBySource ? (
                <div className="rule-groups">
                  {ruleGroups.map((group) => {
                    const collapsed = collapsedGroups.has(group.key);
                    return (
                      <div className="rule-group" key={group.key}>
                        <button
                          className="rule-group-head"
                          onClick={() =>
                            setCollapsedGroups((current) => {
                              const next = new Set(current);
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            })
                          }
                        >
                          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                          <strong>{group.label}</strong>
                          <span className="number-badge">{group.routes.length}</span>
                          <span className="rule-group-hint">{group.hint}</span>
                        </button>
                        {collapsed ? null : group.routes.map(renderRuleRow)}
                      </div>
                    );
                  })}
                </div>
              ) : (
                filtered.map(renderRuleRow)
              )}
            </SortableContext>
          </DndContext>
        )}

        {matchRoute ? (
          <div className="rule-row match-row">
            <span className="rule-grip locked"><Lock size={12} /></span>
            <span className="rule-index mono">{routes.length}</span>
            <div className="rule-kind"><span className="badge badge-amber" title="MATCH">兜底</span></div>
            <div className="rule-content">
              <div className="rule-main-line"><span className="rule-name">兜底规则</span></div>
              <div className="rule-note">未命中以上任何规则的流量会走这里，始终固定在列表末尾。</div>
            </div>
            <div className="rule-target">
              <RuleTargetSelect
                exitId={matchRoute.exitId}
                targetNodeId={matchRoute.targetNodeId}
                exits={exits}
                nodes={workspace.nodes}
                sources={workspace.sources}
                compact
                onChange={(target) =>
                  updateRoute(matchRoute.id, (draft) => {
                    draft.exitId = target.exitId;
                    if (draft.kind === 'rule') draft.targetNodeId = target.targetNodeId;
                  })
                }
              />
            </div>
            <div className="rule-origin"><span className="badge badge-plain">固定</span></div>
            <div className="rule-marks" />
            <div className="rule-toggle"><span className="badge badge-green">必需</span></div>
            <div className="rule-actions" />
          </div>
        ) : null}

        <div className="rule-list-foot">
          <span>拖动排序 · 自动保存</span>
          <span className="spacer" />
          <button className="inline-link" onClick={() => navigate('/export')}>去导出预览</button>
        </div>
      </div>

      {catalogOpen ? (
        <Suspense fallback={<div className="modal-backdrop"><Spinner /></div>}>
          <RuleCatalogDialog
            onClose={() => setCatalogOpen(false)}
            onAdvanced={() => {
              setCatalogOpen(false);
              setAdvancedOpen(true);
            }}
          />
        </Suspense>
      ) : null}

      {advancedOpen ? (
        <Suspense fallback={<div className="modal-backdrop"><Spinner /></div>}>
          <RuleSetWizard initialTab="recommended" onClose={() => setAdvancedOpen(false)} />
        </Suspense>
      ) : null}

      {editing ? (
        <RuleEditDialog
          key={editing.mode === 'edit' ? editing.id : 'new'}
          rule={editingRoute}
          onClose={() => setEditing(null)}
          onDelete={
            editingRoute
              ? async () => {
                  await deleteRoute(editingRoute);
                  setEditing(null);
                }
              : undefined
          }
        />
      ) : null}

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
                <strong>{behaviorLabel(sourceDetail.behavior)} / {formatLabel(sourceDetail.format)}</strong>
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
                : '本地文件来源没有远程仓库地址，可在规则集目录中查看文件。'}
            </div>
          </div>
        </Modal>
      ) : null}

      {hitDetail ? (
        <Modal
          title="最近命中"
          subtitle={`${describeRoute(hitDetail.route).name} · ${hitDetail.hits.length} 个域名`}
          size="md"
          onClose={() => setHitDetail(null)}
        >
          <div className="hit-detail-list">
            {hitDetail.hits.slice(0, 20).map((hit) => (
              <div className="hit-detail-row" key={`${hit.host}-${hit.nodeName}-${hit.exitName}`}>
                <span className="hit-detail-host mono truncate" title={hit.host}>{hit.host}</span>
                <ArrowRight size={11} />
                <span className="hit-detail-target truncate">{hit.nodeName ?? 'DIRECT'}</span>
                <span className="hit-detail-exit truncate">{hit.exitName ?? '—'}</span>
                <span className="hit-detail-count mono">{formatCompact(hit.count)}</span>
                <span className="hit-detail-time faint">{formatRelative(hit.lastSeen)}</span>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function RuleEditDialog({
  rule,
  onClose,
  onDelete,
}: {
  rule?: RuleRoute;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const workspace = useWorkspace((state) => state.workspace);
  const update = useWorkspace((state) => state.update);
  const [type, setType] = useState<RuleType>(rule?.type ?? 'DOMAIN-SUFFIX');
  const [payload, setPayload] = useState(rule?.payload ?? '');
  const [exitId, setExitId] = useState(
    rule?.targetNodeId ? '' : rule?.exitId ?? workspace?.exits.find((exit) => !exit.builtin)?.id ?? 'direct',
  );
  const [targetNodeId, setTargetNodeId] = useState<string | undefined>(rule?.targetNodeId);
  const [noResolve, setNoResolve] = useState(Boolean(rule?.noResolve));
  const [note, setNote] = useState(rule?.note ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [error, setError] = useState('');

  const exits = [...(workspace?.exits ?? [])].sort(
    (a, b) => Number(Boolean(a.builtin)) - Number(Boolean(b.builtin)) || a.order - b.order,
  );
  const rootSuggestion = /^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD)$/.test(type) ? suggestRootDomain(payload) : '';
  const inferredIssues = useMemo(() => {
    if (!workspace) return null;
    const trimmed = payload.trim();
    if (!trimmed || type === 'MATCH') return null;
    const duplicate = findDuplicateRoute(workspace.routes, { type, payload: trimmed }, rule?.id);
    const candidate: RuleRoute = {
      id: rule?.id ?? 'draft-rule',
      kind: 'rule',
      type,
      payload: trimmed,
      exitId,
      targetNodeId,
      noResolve: noResolve || undefined,
      origin: rule?.origin ?? 'manual',
      sourceId: rule?.sourceId,
      enabled,
      pending: rule?.pending,
      appliedAt: rule?.appliedAt,
    };
    const temp = rule
      ? workspace.routes.map((item) => (item.id === rule.id ? candidate : item))
      : insertRouteOrdered(workspace.routes, candidate);
    const index = temp.findIndex((item) => item.id === candidate.id);
    const cover = index >= 0 ? findCoveringRoute(temp, index) : null;
    return {
      duplicate: duplicate >= 0 ? duplicate : null,
      cover: cover ? cover.index : null,
    };
  }, [workspace?.routes, type, payload, exitId, targetNodeId, noResolve, enabled, rule]);

  if (!workspace) return null;

  const save = () => {
    const trimmed = payload.trim();
    if (!trimmed) {
      setError('请填写规则内容');
      return;
    }
    if (/[\r\n,]/.test(trimmed)) {
      setError('规则内容不能包含换行或逗号');
      return;
    }
    if (inferredIssues?.duplicate !== null && inferredIssues?.duplicate !== undefined) {
      setError(`与第 ${inferredIssues.duplicate + 1} 条规则重复`);
      return;
    }
    const saved: RuleRoute = {
      id: rule?.id ?? crypto.randomUUID(),
      kind: 'rule',
      type,
      payload: trimmed,
      exitId,
      targetNodeId,
      noResolve: noResolve || undefined,
      origin: rule?.origin ?? 'manual',
      sourceId: rule?.sourceId,
      note: note.trim() || undefined,
      enabled,
      pending: rule ? rule.pending : true,
      appliedAt: rule?.appliedAt,
    };
    update((draft) => {
      const index = draft.routes.findIndex((item) => item.id === saved.id);
      if (index >= 0) draft.routes[index] = saved;
      else draft.routes = insertRouteOrdered(draft.routes, saved);
    });
    toast('success', rule ? '规则已更新' : '规则已添加', `${type} · ${trimmed}`);
    onClose();
  };

  return (
    <Modal
      title={rule ? '编辑规则' : '添加规则'}
      subtitle="单条规则默认排在规则集与订阅规则之前"
      size="md"
      onClose={onClose}
      footer={
        <>
          {onDelete ? (
            <button className="btn btn-danger" onClick={onDelete} style={{ marginRight: 'auto' }}>
              <Trash2 size={13} /> 删除
            </button>
          ) : null}
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={save}>
            <Check size={13} /> {rule ? '保存修改' : '添加规则'}
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span className="field-label">规则类型</span>
          <Select
            value={type}
            onChange={(value) => setType(value as RuleType)}
            ariaLabel="规则类型"
            options={RULE_TYPE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          />
        </label>

        <label className="field">
          <span className="field-label">规则内容</span>
          <input
            className="input mono"
            autoFocus
            value={payload}
            onChange={(event) => {
              setPayload(event.target.value);
              setError('');
            }}
            placeholder={
              type.startsWith('DOMAIN')
                ? 'example.com'
                : type.startsWith('IP-CIDR')
                  ? '1.2.3.0/24'
                  : type === 'PROCESS-NAME'
                    ? 'chrome.exe'
                    : type === 'DST-PORT'
                      ? '443'
                      : '例如 google'
            }
          />
          {error ? <span className="error-text">{error}</span> : null}
          {rootSuggestion && rootSuggestion !== payload && type === 'DOMAIN-SUFFIX' ? (
            <button className="inline-link" style={{ fontSize: 11.5, alignSelf: 'flex-start' }} onClick={() => setPayload(rootSuggestion)}>
              使用根域名：{rootSuggestion}
            </button>
          ) : null}
        </label>

        <div className="form-grid">
          <label className="field">
            <span className="field-label">目标出口 / 节点</span>
            <RuleTargetSelect
              exitId={exitId}
              targetNodeId={targetNodeId}
              exits={exits}
              nodes={workspace.nodes}
              sources={workspace.sources}
              onChange={(target) => {
                setExitId(target.exitId);
                setTargetNodeId(target.targetNodeId);
              }}
            />
          </label>
          <div className="field">
            <span className="field-label">状态</span>
            <div className="node-enabled-row">
              <Switch checked={enabled} onChange={setEnabled} label="启用规则" />
              <span className="hint">{enabled ? '参与匹配与导出' : '保留但不导出'}</span>
            </div>
          </div>
        </div>

        <label className="checkbox-row">
          <input type="checkbox" checked={noResolve} onChange={(event) => setNoResolve(event.target.checked)} />
          <span>no-resolve<span className="hint">IP 规则不进行 DNS 解析，通常建议开启。</span></span>
        </label>

        <label className="field">
          <span className="field-label">备注 <span className="optional">可选</span></span>
          <input className="input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：从 B 站拖拽生成" />
        </label>

        {inferredIssues?.cover !== null && inferredIssues?.cover !== undefined ? (
          <div className="callout warn">
            <AlertTriangle size={14} />
            <span>这条规则会被前面的第 {inferredIssues.cover + 1} 条规则完全覆盖，实际不会生效。可以调整排序或修改内容。</span>
          </div>
        ) : null}
        {inferredIssues?.duplicate !== null && inferredIssues?.duplicate !== undefined ? (
          <div className="callout danger">
            <AlertTriangle size={14} />
            <span>与第 {inferredIssues.duplicate + 1} 条规则重复，请直接修改已有规则。</span>
          </div>
        ) : null}

        <div className="callout info">
          <ListOrdered size={14} />
          <span>新单条规则会插入到所有规则集与订阅规则之前。保存后可在规则列表中拖动调整优先级。</span>
        </div>
      </div>
    </Modal>
  );
}
