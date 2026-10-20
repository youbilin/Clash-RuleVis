import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check,
  ClipboardPaste,
  DownloadCloud,
  FileText,
  GitBranch,
  Link2,
  Pencil,
  Plus,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import type { DelayResult, ProxyNode, RefreshSummary, Source, SourceType, Workspace } from '../../shared/types';
import { collectTags, nodeDisplayName, nodeTagLabels } from '../../shared/model';
import { regionEmoji } from '../../shared/regions';
import { api, isDesktopRuntime } from '../api';
import { useWorkspace } from '../store/workspace';
import { useUi, toast } from '../store/ui';
import { EmptyState, PageHeader, Spinner, Switch } from '../components/Common';
import { ImportSourceDialog } from '../components/ImportSourceDialog';
import { NodeEditor } from '../components/NodeEditor';
import { Modal } from '../components/Overlay';
import { Select } from '../components/Select';
import { delayTone, expiresIn, formatDateTime, formatDelay, formatRelative, formatTrafficAmount } from '../lib/format';
import { cx } from '../lib/misc';
import { offerUndo } from '../lib/undo';

const TYPE_META: Record<SourceType, { label: string; icon: typeof Link2 }> = {
  subscription: { label: '订阅链接', icon: Link2 },
  file: { label: '本地 YAML', icon: FileText },
  paste: { label: '粘贴内容', icon: ClipboardPaste },
  manual: { label: '节点链接', icon: Plug },
  verge: { label: 'Clash Verge', icon: DownloadCloud },
  chain: { label: '链式代理', icon: GitBranch },
};

interface NodeHealth {
  delay?: number;
  error?: string;
  at: number;
}

const NODE_HEALTH_KEY = 'crs.node-health.v1';

interface RefreshReport {
  sourceName: string;
  added: number;
  removed: number;
  changed: number;
  groups: number;
  rules: number;
  warnings: string[];
}

export function NodesPage() {
  const workspace = useWorkspace((state) => state.workspace);
  const update = useWorkspace((state) => state.update);
  const createUndoPoint = useWorkspace((state) => state.createUndoPoint);
  const saveNow = useWorkspace((state) => state.saveNow);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const kernel = useWorkspace((state) => state.status?.kernel);
  const confirm = useUi((state) => state.confirm);
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsSourceId, setSettingsSourceId] = useState<string | null>(null);
  const [refreshingSource, setRefreshingSource] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshReport, setRefreshReport] = useState<RefreshReport | null>(null);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [nodeHealth, setNodeHealth] = useState<Record<string, NodeHealth>>(() => {
    try {
      const raw = localStorage.getItem(NODE_HEALTH_KEY);
      return raw ? (JSON.parse(raw) as Record<string, NodeHealth>) : {};
    } catch {
      return {};
    }
  });
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [onlyDisabled, setOnlyDisabled] = useState(false);
  const [onlyDuplicate, setOnlyDuplicate] = useState(false);
  const [testingNodeId, setTestingNodeId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const add = params.get('add');
    const q = params.get('q');
    if (!add && !q) return;
    if (q) setQuery(q);
    if (add) setImportOpen(true);
    const next = new URLSearchParams(params);
    next.delete('add');
    next.delete('q');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const sourcesById = useMemo(() => new Map((workspace?.sources ?? []).map((s) => [s.id, s])), [workspace?.sources]);
  const sourceNodeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of workspace?.nodes ?? []) {
      counts.set(node.sourceId, (counts.get(node.sourceId) ?? 0) + 1);
    }
    return counts;
  }, [workspace?.nodes]);

  const duplicateInfo = useMemo(() => {
    const groups = new Map<string, ProxyNode[]>();
    for (const node of workspace?.nodes ?? []) {
      if (node.chain) continue;
      const key = duplicateKey(node);
      groups.set(key, [...(groups.get(key) ?? []), node]);
    }
    const duplicated = [...groups.values()].filter((group) => group.length > 1);
    const ids = new Set(duplicated.flatMap((group) => group.map((node) => node.id)));
    return { groups: duplicated, ids };
  }, [workspace?.nodes]);

  const nodes = useMemo(() => {
    const list = [...(workspace?.nodes ?? [])].sort((a, b) =>
      nodeDisplayName(a, sourcesById.get(a.sourceId)).localeCompare(
        nodeDisplayName(b, sourcesById.get(b.sourceId)),
        'zh-Hans-CN',
      ),
    );
    return list.filter((node) => {
      if (sourceFilter && node.sourceId !== sourceFilter) return false;
      if (tagFilter) {
        const labels = nodeTagLabels(node).map((label) => label.toLowerCase());
        if (!labels.includes(tagFilter.toLowerCase())) return false;
      }
      if (onlyFailed && !nodeHealth[node.id]?.error) return false;
      if (onlyDisabled && node.enabled) return false;
      if (onlyDuplicate && !duplicateInfo.ids.has(node.id)) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const display = nodeDisplayName(node, sourcesById.get(node.sourceId)).toLowerCase();
        const server = String((node.raw as Record<string, unknown>).server ?? '').toLowerCase();
        const tags = nodeTagLabels(node).join(' ').toLowerCase();
        if (!display.includes(q) && !server.includes(q) && !tags.includes(q)) return false;
      }
      return true;
    });
  }, [workspace?.nodes, sourcesById, sourceFilter, tagFilter, query, onlyFailed, onlyDisabled, onlyDuplicate, duplicateInfo, nodeHealth]);

  const failedCount = (workspace?.nodes ?? []).filter((node) => nodeHealth[node.id]?.error).length;
  const disabledCount = (workspace?.nodes ?? []).filter((node) => !node.enabled).length;

  useEffect(() => {
    try {
      localStorage.setItem(NODE_HEALTH_KEY, JSON.stringify(nodeHealth));
    } catch {
      // storage may be unavailable
    }
  }, [nodeHealth]);

  useEffect(() => {
    if (!failedCount && onlyFailed) setOnlyFailed(false);
  }, [failedCount, onlyFailed]);

  useEffect(() => {
    if (!disabledCount && onlyDisabled) setOnlyDisabled(false);
  }, [disabledCount, onlyDisabled]);

  useEffect(() => {
    if (!duplicateInfo.ids.size && onlyDuplicate) setOnlyDuplicate(false);
  }, [duplicateInfo, onlyDuplicate]);

  useEffect(() => {
    const valid = new Set((workspace?.nodes ?? []).map((node) => node.id));
    setNodeHealth((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => valid.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [workspace?.nodes]);

  useEffect(() => {
    const visible = new Set(nodes.map((node) => node.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [sourceFilter, tagFilter, query, onlyFailed, onlyDisabled, onlyDuplicate]);

  if (!workspace) return null;

  const tags = collectTags(workspace.nodes);
  const editingNode = editingNodeId ? workspace.nodes.find((node) => node.id === editingNodeId) : undefined;
  const settingsSource = settingsSourceId ? workspace.sources.find((source) => source.id === settingsSourceId) : undefined;
  const allSelected = nodes.length > 0 && nodes.every((node) => selected.has(node.id));
  const someSelected = nodes.some((node) => selected.has(node.id)) && !allSelected;
  if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) for (const node of nodes) next.delete(node.id);
      else for (const node of nodes) next.add(node.id);
      return next;
    });
  };

  const deleteNode = async (node: Workspace['nodes'][number]) => {
    const source = sourcesById.get(node.sourceId);
    const display = nodeDisplayName(node, source);
    const chainRefs = workspace.nodes.filter(
      (item) =>
        item.chain &&
        (item.chain.relayNodeId === node.id || item.chain.landingNodeId === node.id),
    );
    if (chainRefs.length) {
      toast('warn', '该节点被链路引用', `请先在链路页删除 ${chainRefs.length} 条相关链路`);
      return;
    }
    const targetRules = workspace.routes.filter(
      (route) => route.kind === 'rule' && route.targetNodeId === node.id,
    ).length;
    const confirmed = await confirm({
      title: '删除节点',
      message: [
        `将删除节点「${display}」，并自动从出口的直接成员中移除。`,
        targetRules ? `引用它的 ${targetRules} 条规则会一起删除。` : '',
        '删除前会自动创建工作区快照。',
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmLabel: '删除节点',
      danger: true,
    });
    if (!confirmed) return;
    const undo = await createUndoPoint('删除节点 · ' + display);
    update((draft) => {
      draft.nodes = draft.nodes.filter((item) => item.id !== node.id);
      draft.routes = draft.routes.filter(
        (route) => !(route.kind === 'rule' && route.targetNodeId === node.id),
      );
      if (!draft.nodes.some((item) => item.sourceId === node.sourceId)) {
        draft.sources = draft.sources.filter(
          (item) => item.id !== node.sourceId || (item.type !== 'manual' && item.type !== 'chain'),
        );
      }
    });
    offerUndo(undo, '节点已删除', display);
  };

  const setNodesEnabled = (enabled: boolean) => {
    update((draft) => {
      for (const node of draft.nodes) if (selected.has(node.id)) node.enabled = enabled;
    });
    toast('success', enabled ? '已启用所选节点' : '已禁用所选节点', `${selected.size} 个节点`);
  };

  const applyBulkTag = () => {
    const values = bulkTagInput
      .split(/[,，\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!values.length) {
      toast('warn', '请输入标签');
      return;
    }
    update((draft) => {
      for (const node of draft.nodes) {
        if (selected.has(node.id)) node.tags = [...new Set([...node.tags, ...values])];
      }
    });
    setBulkTagOpen(false);
    setBulkTagInput('');
    toast('success', '标签已添加', values.join('、'));
  };

  const mergeDuplicates = async () => {
    if (!duplicateInfo.groups.length) return;
    const removeCount = duplicateInfo.groups.reduce((sum, group) => sum + group.length - 1, 0);
    const confirmed = await confirm({
      title: '合并重复节点',
      message: [
        `发现 ${duplicateInfo.groups.length} 组重复节点，将保留每组中的一个节点并移除 ${removeCount} 个副本。`,
        '引用副本的规则、出口成员和链路关系会改指向保留节点。',
        '中转和落地节点本身不会被修改。',
      ].join('\n\n'),
      confirmLabel: '合并',
      danger: true,
    });
    if (!confirmed) return;
    const idMap = new Map<string, string>();
    for (const group of duplicateInfo.groups) {
      const keep = group.find((node) => node.enabled) ?? group[0];
      for (const node of group) {
        if (node.id !== keep.id) idMap.set(node.id, keep.id);
      }
    }
    const undo = await createUndoPoint('合并重复节点');
    update((draft) => {
      for (const route of draft.routes) {
        if (route.kind === 'rule' && route.targetNodeId && idMap.has(route.targetNodeId)) {
          route.targetNodeId = idMap.get(route.targetNodeId);
        }
      }
      for (const exit of draft.exits) {
        for (const member of exit.members) {
          if (member.by === 'node' && idMap.has(member.value)) member.value = idMap.get(member.value)!;
        }
      }
      for (const node of draft.nodes) {
        if (!node.chain) continue;
        const relay = idMap.get(node.chain.relayNodeId);
        if (relay) node.chain.relayNodeId = relay;
        const landing = idMap.get(node.chain.landingNodeId);
        if (landing) node.chain.landingNodeId = landing;
      }
      draft.nodes = draft.nodes.filter((node) => !idMap.has(node.id));
    });
    offerUndo(undo, '重复节点已合并', `移除 ${removeCount} 个副本`);
  };

  const refreshAllSources = async () => {
    const targets = workspace?.sources.filter(
      (source) => source.type === 'subscription' || source.type === 'verge',
    ) ?? [];
    if (!targets.length) return;
    setRefreshingAll(true);
    const summary: RefreshReport = {
      sourceName: `全部来源 · ${targets.length}`,
      added: 0,
      removed: 0,
      changed: 0,
      groups: 0,
      rules: 0,
      warnings: [],
    };
    const failures: string[] = [];
    try {
      await saveNow();
      if (useWorkspace.getState().saveState === 'error') {
        throw new Error('工作区尚未保存，已取消刷新');
      }
      for (const source of targets) {
        try {
          const result = await api<RefreshSummary>(`/api/sources/${source.id}/refresh`, { method: 'POST' });
          applyServerWorkspace(result.workspace);
          summary.added += result.added;
          summary.removed += result.removed;
          summary.changed += result.changed;
          summary.groups += result.groups;
          summary.rules += result.rules;
          summary.warnings.push(...result.warnings);
        } catch (error) {
          failures.push(`${source.name}：${(error as Error).message}`);
        }
      }
      setNodeHealth({});
      summary.warnings.push(...failures);
      setRefreshReport(summary);
      if (failures.length) {
        toast('warn', '部分来源刷新失败', `${targets.length - failures.length}/${targets.length} 个来源已更新`);
      } else {
        toast('success', '全部来源已刷新', `新增 ${summary.added} · 消失 ${summary.removed} · 变化 ${summary.changed}`);
      }
    } finally {
      setRefreshingAll(false);
    }
  };

  const refreshSource = async (source: Source) => {
    if (source.type !== 'subscription' && source.type !== 'verge') {
      toast('info', '该来源不支持刷新', '请重新导入文件或粘贴内容');
      return;
    }
    setRefreshingSource(source.id);
    try {
      await saveNow();
      const result = await api<RefreshSummary>(`/api/sources/${source.id}/refresh`, { method: 'POST' });
      applyServerWorkspace(result.workspace);
      setNodeHealth({});
      setRefreshReport({
        sourceName: source.name,
        added: result.added,
        removed: result.removed,
        changed: result.changed,
        groups: result.groups,
        rules: result.rules,
        warnings: result.warnings,
      });
      toast('success', '来源已刷新', `新增 ${result.added} · 消失 ${result.removed} · 变化 ${result.changed}`);
    } catch (error) {
      toast('error', '刷新失败', (error as Error).message);
    } finally {
      setRefreshingSource(null);
    }
  };

  const deleteSource = async (source: Source) => {
    const nodeCount = sourceNodeCounts.get(source.id) ?? 0;
    const routeCount = workspace.routes.filter((route) => route.sourceId === source.id).length;
    const confirmed = await confirm({
      title: '删除来源',
      message: [
        `将删除来源「${source.name}」以及它的 ${nodeCount} 个节点。`,
        routeCount ? `同时会移除 ${routeCount} 条由该来源导入的规则。` : '',
        '引用这些节点的出口会显示失效成员，但不会被自动删除。',
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmLabel: '删除来源',
      danger: true,
    });
    if (!confirmed) return;
    const undo = await createUndoPoint('删除来源 · ' + source.name);
    try {
      const result = await api<{ workspace: Workspace }>(`/api/sources/${source.id}`, { method: 'DELETE' });
      if (result.workspace) applyServerWorkspace(result.workspace);
      if (sourceFilter === source.id) setSourceFilter('');
      offerUndo(undo, '来源已删除', source.name);
    } catch (error) {
      toast('error', '删除失败', (error as Error).message);
    }
  };

  const enabledCount = workspace.nodes.filter((node) => node.enabled).length;
  const hasFilters = Boolean(tagFilter || query || sourceFilter || onlyFailed || onlyDisabled || onlyDuplicate);
  const clearFilters = () => {
    setTagFilter('');
    setQuery('');
    setSourceFilter('');
    setOnlyFailed(false);
    setOnlyDisabled(false);
    setOnlyDuplicate(false);
  };
  const selectedSource = sourceFilter ? workspace.sources.find((source) => source.id === sourceFilter) : undefined;
  const refreshableSources = workspace.sources.filter(
    (source) => source.type === 'subscription' || source.type === 'verge',
  );
  const latestSourceUpdate = refreshableSources.reduce<number | null>((latest, source) => {
    if (!source.updatedAt) return latest;
    const time = new Date(source.updatedAt).getTime();
    return Number.isNaN(time) ? latest : Math.max(latest ?? 0, time);
  }, null);
  const sourceStatus = selectedSource
    ? [
        selectedSource.updatedAt
          ? `${selectedSource.name} 更新 ${formatRelative(new Date(selectedSource.updatedAt).getTime())}`
          : null,
        selectedSource.userinfo
          ? `剩余 ${formatTrafficAmount(Math.max(0, selectedSource.userinfo.total - selectedSource.userinfo.used))}`
          : null,
        selectedSource.userinfo ? expiresIn(selectedSource.userinfo.expire) : null,
      ].filter(Boolean).join(' · ')
    : latestSourceUpdate
      ? `最近来源更新 ${formatRelative(latestSourceUpdate)}`
      : '';

  const requestDelays = async (targets: Workspace['nodes']) => {
    const nameToNodes = new Map<string, Workspace['nodes']>();
    for (const node of targets) {
      const name = nodeDisplayName(node, sourcesById.get(node.sourceId));
      nameToNodes.set(name, [...(nameToNodes.get(name) ?? []), node]);
    }
    const names = [...nameToNodes.keys()];
    for (let offset = 0; offset < names.length; offset += 40) {
      const batch = names.slice(offset, offset + 40);
      const response = await api<{ results: DelayResult[] }>('/api/delay', {
        method: 'POST',
        body: { names: batch },
      });
      const byName = new Map(response.results.map((result) => [result.name, result]));
      setNodeHealth((current) => {
        const next = { ...current };
        for (const name of batch) {
          const result = byName.get(name);
          if (!result) continue;
          for (const node of nameToNodes.get(name) ?? []) {
            next[node.id] = result.error
              ? { error: result.error, at: Date.now() }
              : result.delay
                ? { delay: result.delay, at: Date.now() }
                : { error: '测速无响应', at: Date.now() };
          }
        }
        return next;
      });
    }
  };

  const testAllNodes = async () => {
    if (!kernel?.connected) {
      toast('warn', '内核未连接', '连接内核后才能测速');
      return;
    }
    const targets = workspace.nodes.filter((node) => node.enabled);
    if (!targets.length) {
      toast('info', '没有可用节点');
      return;
    }
    setTestingAll(true);
    try {
      await requestDelays(targets);
      toast('success', '测速完成', `已测试 ${targets.length} 个节点`);
    } catch (error) {
      toast('error', '测速失败', (error as Error).message);
    } finally {
      setTestingAll(false);
    }
  };

  const testSingleNode = async (node: Workspace['nodes'][number]) => {
    if (!node.enabled || testingNodeId) return;
    setTestingNodeId(node.id);
    try {
      await requestDelays([node]);
    } catch (error) {
      toast('error', '测速失败', (error as Error).message);
    } finally {
      setTestingNodeId(null);
    }
  };

  return (
    <div className="page nodes-page">
      <PageHeader
        kicker="NODES & SOURCES"
        title="节点与订阅"
        subtitle={`${workspace.nodes.length} 个节点 · ${enabledCount} 个启用 · ${workspace.sources.length} 个来源${sourceStatus ? ` · ${sourceStatus}` : ''}`}
        actions={
          <div className="nodes-source-filter">
            <span className="nodes-source-label">来源</span>
            <Select
              compact
              className="source-filter-select"
              value={sourceFilter}
              onChange={setSourceFilter}
              ariaLabel="筛选来源"
              options={[
                { value: '', label: `全部节点 · ${workspace.nodes.length}` },
                ...workspace.sources.map((source) => ({
                  value: source.id,
                  label: `${source.name} · ${sourceNodeCounts.get(source.id) ?? 0}`,
                })),
              ]}
            />
            {refreshableSources.length ? (
              <button
                className="node-test-all node-refresh-all"
                onClick={() => void refreshAllSources()}
                disabled={refreshingAll || Boolean(refreshingSource)}
                title="刷新全部订阅与 Verge 来源"
                aria-label="刷新全部来源"
              >
                {refreshingAll ? <Spinner /> : <RefreshCw size={14} />}
              </button>
            ) : null}
            <button
              className="node-test-all"
              onClick={() => void testAllNodes()}
              disabled={testingAll || !enabledCount || !kernel?.connected}
              title={kernel?.connected ? '测试全部启用节点' : '内核未连接，无法测速'}
              aria-label="测试全部启用节点"
            >
              {testingAll ? <Spinner /> : <Zap size={14} />}
            </button>
            {selectedSource ? (
              <div className="source-actions">
                {selectedSource.type === 'subscription' || selectedSource.type === 'verge' ? (
                  <button
                    className="icon-btn"
                    title="刷新来源"
                    disabled={refreshingSource === selectedSource.id}
                    onClick={() => void refreshSource(selectedSource)}
                  >
                    {refreshingSource === selectedSource.id ? <Spinner /> : <RefreshCw size={12} />}
                  </button>
                ) : null}
                <button className="icon-btn" title="来源设置" onClick={() => setSettingsSourceId(selectedSource.id)}>
                  <Settings2 size={12} />
                </button>
                <button className="icon-btn danger" title="删除来源" onClick={() => void deleteSource(selectedSource)}>
                  <Trash2 size={12} />
                </button>
              </div>
            ) : null}
          </div>
        }
      />

        <section className="nodes-main panel">
          <div className="node-toolbar">
            <div className="search-box" style={{ flex: '1 1 220px' }}>
              <Search size={13} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索节点名、服务器或标签"
                aria-label="搜索节点"
              />
              <span className="search-clear-slot">
                {hasFilters ? (
                  <button className="icon-btn" onClick={clearFilters} title="清除筛选" aria-label="清除筛选">
                    <X size={12} />
                  </button>
                ) : null}
              </span>
            </div>
            <Select
              compact
              className="node-tag-filter"
              value={tagFilter}
              onChange={setTagFilter}
              ariaLabel="按标签筛选"
              options={[
                { value: '', label: '全部标签' },
                ...tags.map((tag) => ({ value: tag, label: tag })),
              ]}
            />
            {failedCount > 0 || onlyFailed ? (
              <button
                className={cx('node-fail-filter', onlyFailed && 'active')}
                onClick={() => setOnlyFailed((value) => !value)}
                title="只显示测速失败节点"
              >
                <TriangleAlert size={12} /> 失败 {failedCount}
              </button>
            ) : null}
            {disabledCount > 0 || onlyDisabled ? (
              <button
                className={cx('node-muted-filter', onlyDisabled && 'active')}
                onClick={() => setOnlyDisabled((value) => !value)}
                title="只显示已禁用节点"
              >
                禁用 {disabledCount}
              </button>
            ) : null}
            {duplicateInfo.ids.size > 0 || onlyDuplicate ? (
              <button
                className={cx('node-muted-filter', onlyDuplicate && 'active')}
                onClick={() => setOnlyDuplicate((value) => !value)}
                title="只显示配置重复的节点"
              >
                重复 {duplicateInfo.ids.size}
              </button>
            ) : null}
            {duplicateInfo.groups.length ? (
              <button
                className="btn btn-sm btn-ghost node-merge-btn"
                onClick={() => void mergeDuplicates()}
                title="合并配置完全相同的节点，并保留一个"
              >
                合并 {duplicateInfo.groups.length} 组
              </button>
            ) : null}
            <span className="spacer" />
            <button
              className="btn btn-sm btn-outline nodes-add-source"
              onClick={() => setImportOpen(true)}
              title="从订阅、文件、节点链接或 Verge 添加来源"
            >
              <Plus size={12} /> 添加来源
            </button>
            <span className="node-count faint">
              {nodes.length} / {workspace.nodes.length}
            </span>
          </div>

          {selected.size > 0 ? (
            <div className="bulk-bar">
              <span className="selection-count mono">{selected.size}</span>
              <span>个节点已勾选</span>
              <button className="btn btn-sm btn-outline" onClick={() => setNodesEnabled(true)}>启用</button>
              <button className="btn btn-sm btn-outline" onClick={() => setNodesEnabled(false)}>禁用</button>
              <button className="btn btn-sm btn-outline" onClick={() => setBulkTagOpen(true)}>添加标签</button>
              <span className="spacer" />
              <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>清除选择</button>
            </div>
          ) : null}

          <div className="node-table">
            <div className="node-head">
              <div className="node-check">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="全选节点"
                />
              </div>
              <div />
              <div>节点</div>
              <div>类型</div>
              <div>地址</div>
              <div>标签</div>
              <div>延迟</div>
              <div />
            </div>

            {nodes.length === 0 ? (
              <EmptyState
                icon={<ServerIcon />}
                title={workspace.nodes.length ? '没有匹配的节点' : '节点池是空的'}
                description={
                  workspace.nodes.length
                    ? '试试清除搜索、标签或来源筛选。'
                    : isDesktopRuntime()
                      ? '桌面预览版请先用「添加来源」导入节点链接；订阅与 YAML 导入将在下一阶段接入。'
                      : '从 Verge 当前配置读取，或导入订阅 / 粘贴 Clash 配置。'
                }
                actions={
                  workspace.nodes.length ? (
                    <button className="btn btn-sm btn-outline" onClick={clearFilters}>
                      清除筛选
                    </button>
                  ) : null
                }
              />
            ) : (
              nodes.map((node) => {
                const source = sourcesById.get(node.sourceId);
                const display = nodeDisplayName(node, source);
                return (
                  <div
                    key={node.id}
                    className={cx('node-row', !node.enabled && 'disabled', selected.has(node.id) && 'selected')}
                    onClick={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(node.id)) next.delete(node.id);
                        else next.add(node.id);
                        return next;
                      })
                    }
                  >
                    <div className="node-check" data-control onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(node.id)}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(node.id)) next.delete(node.id);
                            else next.add(node.id);
                            return next;
                          })
                        }
                        aria-label={`选择 ${display}`}
                      />
                    </div>
                    <div data-control onClick={(event) => event.stopPropagation()}>
                      <Switch
                        checked={node.enabled}
                        label={`${node.enabled ? '禁用' : '启用'} ${display}`}
                        onChange={(enabled) => {
                          update((draft) => {
                            const target = draft.nodes.find((item) => item.id === node.id);
                            if (target) target.enabled = enabled;
                          });
                        }}
                      />
                    </div>
                    <div className="node-name-cell">
                      <span className="node-flag">{regionEmoji(node.region) ?? '·'}</span>
                      <div className="node-name-copy">
                        <div className="node-name" title={display}>
                          {display}
                          {!node.enabled ? <span className="badge badge-plain">禁用</span> : null}
                          {duplicateInfo.ids.has(node.id) ? <span className="badge badge-amber">重复</span> : null}
                          {node.chain ? <span className="badge badge-blue">链式</span> : null}
                        </div>
                        <div className="node-name-sub">
                          {source?.name ?? '未知来源'}
                          {source?.prefix ? <span className="faint"> · 原名 {node.name}</span> : null}
                        </div>
                      </div>
                    </div>
                    <div className="node-type mono">{String((node.raw as Record<string, unknown>).type ?? '—')}</div>
                    <div className="node-address mono truncate" title={`${String((node.raw as Record<string, unknown>).server ?? '')}:${String((node.raw as Record<string, unknown>).port ?? '')}`}>
                      {String((node.raw as Record<string, unknown>).server ?? '—')}:{String((node.raw as Record<string, unknown>).port ?? '—')}
                    </div>
                    <div className="node-tag-list">
                      {node.region ? <span className="tag accent">{node.region}</span> : null}
                      {node.tags.slice(0, 2).map((tag) => <span className="tag" key={tag}>{tag}</span>)}
                      {node.tags.length > 2 ? <span className="tag">+{node.tags.length - 2}</span> : null}
                    </div>
                    <div className="node-delay" data-control onClick={(event) => event.stopPropagation()}>
                      {!node.enabled ? (
                        <span className="faint">—</span>
                      ) : testingNodeId === node.id ? (
                        <Spinner />
                      ) : nodeHealth[node.id]?.error ? (
                        <button
                          className="node-latency bad"
                          onClick={() => void testSingleNode(node)}
                          title={`${nodeHealth[node.id]?.error} · ${formatRelative(nodeHealth[node.id]?.at ?? Date.now())}`}
                        >
                          失败
                        </button>
                      ) : nodeHealth[node.id]?.delay ? (
                        <button
                          className={cx('node-latency', delayTone(nodeHealth[node.id]?.delay))}
                          onClick={() => void testSingleNode(node)}
                          title={`测速于 ${formatRelative(nodeHealth[node.id]?.at ?? Date.now())}，点击重测`}
                        >
                          {formatDelay(nodeHealth[node.id]?.delay)}
                        </button>
                      ) : (
                        <button
                          className="node-latency empty"
                          onClick={() => void testSingleNode(node)}
                          title="测试延迟"
                        >
                          <Zap size={10} /> 测速
                        </button>
                      )}
                    </div>
                    <div className="node-row-actions" data-control onClick={(event) => event.stopPropagation()}>
                      <button className="icon-btn" title="编辑节点" onClick={() => setEditingNodeId(node.id)}>
                        <Pencil size={12} />
                      </button>
                      <button className="icon-btn danger" title="删除节点" onClick={() => void deleteNode(node)}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="node-foot">
            <span className="spacer" />
            <span>{enabledCount} 个节点进入节点池</span>
          </div>
        </section>

      {importOpen ? <ImportSourceDialog onClose={() => setImportOpen(false)} /> : null}

      {editingNode ? <NodeEditor node={editingNode} onClose={() => setEditingNodeId(null)} /> : null}

      {settingsSource ? (
        <SourceSettingsDialog source={settingsSource} onClose={() => setSettingsSourceId(null)} />
      ) : null}

      {refreshReport ? (
        <Modal
          title="来源已刷新"
          subtitle={refreshReport.sourceName}
          size="sm"
          onClose={() => setRefreshReport(null)}
          footer={<button className="btn btn-primary" onClick={() => setRefreshReport(null)}>完成</button>}
        >
          <div className="import-result-stats">
            <div><span>新增</span><strong className="mono">{refreshReport.added}</strong></div>
            <div><span>消失</span><strong className="mono">{refreshReport.removed}</strong></div>
            <div><span>变化</span><strong className="mono">{refreshReport.changed}</strong></div>
            <div><span>出口</span><strong className="mono">{refreshReport.groups}</strong></div>
            <div><span>规则</span><strong className="mono">{refreshReport.rules}</strong></div>
          </div>
          {refreshReport.warnings.length ? (
            <div className="import-warnings">
              {refreshReport.warnings.slice(0, 10).map((warning) => (
                <div className="import-warning-row" key={warning}>{warning}</div>
              ))}
            </div>
          ) : (
            <div className="callout success" style={{ marginTop: 10 }}>
              <Check size={14} /> 没有需要处理的差异。
            </div>
          )}
        </Modal>
      ) : null}

      {bulkTagOpen ? (
        <Modal
          title="批量添加标签"
          subtitle={`将标签添加到选中的 ${selected.size} 个节点`}
          size="sm"
          onClose={() => setBulkTagOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setBulkTagOpen(false)}>取消</button>
              <button className="btn btn-primary" onClick={applyBulkTag}>添加标签</button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">标签</span>
            <input
              className="input"
              autoFocus
              value={bulkTagInput}
              onChange={(event) => setBulkTagInput(event.target.value)}
              placeholder="家宽、原生 IP、流媒体（用逗号分隔）"
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyBulkTag();
              }}
            />
            <span className="hint">已有标签会保留，只新增缺少的。</span>
          </label>
        </Modal>
      ) : null}
    </div>
  );
}

function duplicateKey(node: ProxyNode): string {
  const raw = node.raw as Record<string, unknown>;
  return JSON.stringify(
    Object.entries(raw)
      .filter(([key]) => key !== 'name')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function ServerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
    </svg>
  );
}

function SourceSettingsDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const saveNow = useWorkspace((state) => state.saveNow);
  const [name, setName] = useState(source.name);
  const [prefix, setPrefix] = useState(source.prefix);
  const [keepRules, setKeepRules] = useState(source.keepRules);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await saveNow();
      const result = await api<{ workspace: Workspace }>(`/api/sources/${source.id}`, {
        method: 'PATCH',
        body: { name: name.trim(), prefix, keepRules },
      });
      applyServerWorkspace(result.workspace);
      toast('success', '来源设置已保存');
      onClose();
    } catch (error) {
      toast('error', '保存失败', (error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="来源设置"
      subtitle={`${source.name} · ${TYPE_META[source.type].label}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner onAccent /> : null} 保存
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span className="field-label">来源名称</span>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">节点前缀</span>
          <input className="input mono" value={prefix} onChange={(event) => setPrefix(event.target.value)} maxLength={24} />
          <span className="hint">留空不加前缀。修改后所有该来源节点的导出名会立即变化。</span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={keepRules} onChange={(event) => setKeepRules(event.target.checked)} />
          <span>
            刷新时保留来源自带的策略组与规则
            <span className="hint">下次刷新生效。关闭不会自动删除已经导入的规则。</span>
          </span>
        </label>
        {source.url ? (
          <div className="callout info">
            <Link2 size={14} />
            <span className="truncate" title={source.url}>订阅地址只保存在本地，不会写入导出的 YAML。</span>
          </div>
        ) : null}
        {source.updatedAt ? <span className="hint">最近更新：{formatDateTime(source.updatedAt)}</span> : null}
      </div>
    </Modal>
  );
}
