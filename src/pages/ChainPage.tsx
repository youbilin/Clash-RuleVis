import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Circle,
  GitBranch,
  Link2,
  Search,
  Server,
  Trash2,
} from 'lucide-react';
import type { ProxyNode, Source, Workspace } from '../../shared/types';
import { nodeDisplayName } from '../../shared/model';
import { api } from '../api';
import { useWorkspace } from '../store/workspace';
import { useUi, toast } from '../store/ui';
import { PageHeader, Spinner } from '../components/Common';
import { Select } from '../components/Select';
import { cx } from '../lib/misc';
import { offerUndo } from '../lib/undo';

type PickSide = 'relay' | 'landing';

interface PickedNode {
  node: ProxyNode;
  name: string;
  sourceName: string;
}

const RESERVED_NAMES = new Set(['DIRECT', 'REJECT', 'GLOBAL', 'PASS', 'COMPATIBLE', 'REJECT-DROP']);

export function ChainPage() {
  const workspace = useWorkspace((state) => state.workspace);
  const saveNow = useWorkspace((state) => state.saveNow);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const createUndoPoint = useWorkspace((state) => state.createUndoPoint);
  const refreshStatus = useWorkspace((state) => state.refreshStatus);
  const confirm = useUi((state) => state.confirm);
  const navigate = useNavigate();

  const [relayId, setRelayId] = useState<string | null>(null);
  const [landingId, setLandingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [relaySource, setRelaySource] = useState('all');
  const [landingSource, setLandingSource] = useState('all');
  const [relayQuery, setRelayQuery] = useState('');
  const [landingQuery, setLandingQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const sourcesById = useMemo(
    () => new Map((workspace?.sources ?? []).map((source) => [source.id, source])),
    [workspace?.sources],
  );

  const candidates = useMemo(
    () =>
      (workspace?.nodes ?? [])
        .filter((node) => !node.chain)
        .sort((a, b) =>
          nodeDisplayName(a, sourcesById.get(a.sourceId)).localeCompare(
            nodeDisplayName(b, sourcesById.get(b.sourceId)),
            'zh-Hans-CN',
          ),
        ),
    [workspace?.nodes, sourcesById],
  );

  const sourceOptions = useMemo(() => {
    const used = new Set(candidates.map((node) => node.sourceId));
    return [
      { value: 'all', label: `全部来源 · ${candidates.length}` },
      ...(workspace?.sources ?? [])
        .filter((source) => used.has(source.id))
        .map((source) => ({
          value: source.id,
          label: `${source.name} · ${candidates.filter((node) => node.sourceId === source.id).length}`,
        })),
    ];
  }, [candidates, workspace?.sources]);

  const picked = (id: string | null): PickedNode | null => {
    const node = id ? workspace?.nodes.find((item) => item.id === id) : undefined;
    if (!node) return null;
    const source = sourcesById.get(node.sourceId);
    return {
      node,
      name: nodeDisplayName(node, source),
      sourceName: source?.name ?? '手动节点',
    };
  };

  const relay = picked(relayId);
  const landing = picked(landingId);
  const relayList = filterList(candidates, sourcesById, relaySource, relayQuery);
  const landingList = filterList(candidates, sourcesById, landingSource, landingQuery);
  const ready = Boolean(relay && landing && relayId !== landingId && name.trim());

  const trimmedName = name.trim();
  const nameError = useMemo(() => {
    if (!trimmedName) return '';
    if (RESERVED_NAMES.has(trimmedName.toUpperCase())) return '与内置出站重名，请换一个名称';
    if (workspace?.nodes.some(
      (node) => nodeDisplayName(node, sourcesById.get(node.sourceId)).toLowerCase() === trimmedName.toLowerCase(),
    )) {
      return '已有同名节点，请换一个名称';
    }
    if (workspace?.exits.some((exit) => exit.name.toLowerCase() === trimmedName.toLowerCase())) {
      return '与出口重名，请换一个名称';
    }
    return '';
  }, [trimmedName, workspace?.nodes, workspace?.exits, sourcesById]);

  useEffect(() => {
    if (relayId && !workspace?.nodes.some((node) => node.id === relayId && !node.chain)) setRelayId(null);
    if (landingId && !workspace?.nodes.some((node) => node.id === landingId && !node.chain)) setLandingId(null);
  }, [workspace?.nodes, relayId, landingId]);

  useEffect(() => {
    if (!relay || !landing) return;
    const timer = window.setTimeout(() => nameRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [relay?.node.id, landing?.node.id]);

  if (!workspace) return null;

  const chains = [...workspace.nodes]
    .filter((node) => node.chain)
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));

  const choose = (side: PickSide, node: ProxyNode) => {
    if (!node.enabled) {
      toast('info', '节点已禁用', '请先在节点与订阅页启用它');
      return;
    }
    if (side === 'relay' && node.id === landingId) {
      toast('info', '中转和落地不能是同一个节点');
      return;
    }
    if (side === 'landing' && node.id === relayId) {
      toast('info', '中转和落地不能是同一个节点');
      return;
    }
    if (side === 'relay') setRelayId(node.id);
    else setLandingId(node.id);
  };

  const save = async () => {
    if (!relay || !landing || !trimmedName || nameError || saving) return;
    setSaving(true);
    try {
      await saveNow();
      if (useWorkspace.getState().saveState === 'error') {
        throw new Error('工作区尚未保存，已取消生成链路');
      }
      const result = await api<{ workspace: Workspace; nodeId: string }>('/api/chains', {
        method: 'POST',
        body: { relayNodeId: relay.node.id, landingNodeId: landing.node.id, name: trimmedName },
      });
      applyServerWorkspace(result.workspace);
      await refreshStatus();
      toast('success', '链式节点已生成', `${trimmedName} · ${relay.name} → ${landing.name}`);
      setName('');
      setRelayId(null);
      setLandingId(null);
    } catch (error) {
      toast('error', '生成链路失败', (error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeChain = async (node: ProxyNode) => {
    const source = sourcesById.get(node.sourceId);
    const displayName = nodeDisplayName(node, source);
    const relayNode = node.chain ? workspace.nodes.find((item) => item.id === node.chain!.relayNodeId) : undefined;
    const removedRoutes = workspace.routes.filter(
      (route) => route.kind === 'rule' && route.targetNodeId === node.id,
    ).length;
    const confirmed = await confirm({
      title: '删除链式节点',
      message: [
        `将删除链式节点「${displayName}」，中转和落地节点都不会被修改。`,
        removedRoutes ? `引用它的 ${removedRoutes} 条规则会一起移除。` : '',
        relayNode ? `中转节点：${nodeDisplayName(relayNode, sourcesById.get(relayNode.sourceId))}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmLabel: '删除链路',
      danger: true,
    });
    if (!confirmed) return;
    setDeletingId(node.id);
    try {
      const undo = await createUndoPoint('删除链路 · ' + displayName);
      await saveNow();
      const result = await api<{ workspace: Workspace; removedRoutes: number }>(`/api/chains/${node.id}`, {
        method: 'DELETE',
      });
      applyServerWorkspace(result.workspace);
      await refreshStatus();
      offerUndo(undo, '链路已删除', displayName);
      if (selectedContains(node.id)) {
        setRelayId(null);
        setLandingId(null);
      }
    } catch (error) {
      toast('error', '删除链路失败', (error as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const selectedContains = (id: string) => relayId === id || landingId === id;

  const renderColumn = (side: PickSide) => {
    const selected = side === 'relay' ? relay : landing;
    const list = side === 'relay' ? relayList : landingList;
    const sourceFilter = side === 'relay' ? relaySource : landingSource;
    const query = side === 'relay' ? relayQuery : landingQuery;
    const setSourceFilter = side === 'relay' ? setRelaySource : setLandingSource;
    const setQuery = side === 'relay' ? setRelayQuery : setLandingQuery;
    const otherId = side === 'relay' ? landingId : relayId;
    return (
      <section className="chain-column panel">
        <div className="chain-column-head">
          <span className={cx('chain-step', selected && 'filled')}>{side === 'relay' ? '1' : '2'}</span>
          <div className="chain-column-title">
            <strong>{side === 'relay' ? '中转（前置）' : '落地（出口）'}</strong>
            <span>{selected ? selected.name : side === 'relay' ? '选择实际出口前的节点' : '选择最终落地节点'}</span>
          </div>
          <span className="chain-column-count mono">{list.length}</span>
        </div>
        <div className="chain-column-tools">
          <Select
            compact
            className="chain-source-select"
            value={sourceFilter}
            onChange={setSourceFilter}
            ariaLabel={side === 'relay' ? '按来源筛选中转节点' : '按来源筛选落地节点'}
            options={sourceOptions}
          />
          <div className="search-box chain-search">
            <Search size={12} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索节点"
              aria-label={side === 'relay' ? '搜索中转节点' : '搜索落地节点'}
            />
          </div>
        </div>
        <div className="chain-node-list">
          {list.length === 0 ? (
            <div className="chain-node-empty">
              {candidates.length ? '没有匹配的节点' : '还没有可用的前置节点，请先导入节点'}
            </div>
          ) : (
            list.map((node) => {
              const nodeSource = sourcesById.get(node.sourceId);
              const displayName = nodeDisplayName(node, nodeSource);
              const active = (side === 'relay' ? relayId : landingId) === node.id;
              const blocked = node.id === otherId || !node.enabled;
              return (
                <button
                  key={node.id}
                  type="button"
                  className={cx('chain-node', active && 'selected', blocked && !active && 'blocked')}
                  onClick={() => choose(side, node)}
                  aria-pressed={active}
                >
                  <span className={cx('chain-node-mark', active && 'active')}>
                    {active ? <Check size={11} /> : <Circle size={10} />}
                  </span>
                  <span className="chain-node-copy">
                    <span className="chain-node-name">
                      <strong className="truncate">{displayName}</strong>
                      {!node.enabled ? <span className="badge badge-plain">禁用</span> : null}
                      {active ? <span className="badge badge-green">{side === 'relay' ? '中转' : '落地'}</span> : null}
                    </span>
                    <span className="chain-node-meta">
                      <span>{nodeSource?.name ?? '手动节点'}</span>
                      <span className="meta-sep">·</span>
                      <span className="mono">{String((node.raw as Record<string, unknown>).type ?? '—')}</span>
                      {node.region ? (
                        <>
                          <span className="meta-sep">·</span>
                          <span>{node.region}</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="page chain-page">
      <PageHeader
        kicker="CHAIN PROXY"
        title="链式代理"
        subtitle={`${chains.length} 条链路 · 中转 → 落地生成独立节点，不改变原有节点流量`}
        actions={
          <>
            <button className="btn btn-outline" onClick={() => navigate('/nodes')}>
              <Server size={13} /> 节点池
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={!ready || Boolean(nameError) || saving}
              title={ready ? '生成链式节点' : '先选择中转、落地并填写名称'}
            >
              {saving ? <Spinner onAccent /> : <Check size={13} />} 保存链路
            </button>
          </>
        }
      />

      <div className="chain-workspace">
        {renderColumn('relay')}
        <div className="chain-flow-lane" aria-hidden>
          <span className="chain-flow-line" />
          <span className="chain-flow-icon"><ArrowRight size={14} /></span>
          <span className="chain-flow-label">DIALER</span>
        </div>
        {renderColumn('landing')}

        <aside className="chain-composer panel">
          <div className="chain-composer-head">
            <div>
              <div className="section-title" style={{ margin: 0 }}>
                生成节点
              </div>
              <p>新节点会复制落地配置，并只让该节点走中转。</p>
            </div>
            <GitBranch size={16} className="chain-composer-icon" />
          </div>

          <div className="chain-preview">
            <div className={cx('chain-preview-slot', relay && 'filled')}>
              <span className="chain-preview-label">中转</span>
              <strong className="truncate">{relay?.name ?? '未选择'}</strong>
              <span className="chain-preview-meta">{relay?.sourceName ?? '左侧选择节点'}</span>
            </div>
            <ArrowRight size={13} className={cx('chain-preview-arrow', relay && landing && 'ready')} />
            <div className={cx('chain-preview-slot', landing && 'filled')}>
              <span className="chain-preview-label">落地</span>
              <strong className="truncate">{landing?.name ?? '未选择'}</strong>
              <span className="chain-preview-meta">{landing?.sourceName ?? '中间选择节点'}</span>
            </div>
          </div>

          <div className={cx('chain-name-slot', relay && landing && 'active')}>
            {relay && landing ? (
              <>
                <label className="field">
                  <span className="field-label">新节点名称</span>
                  <input
                    ref={nameRef}
                    className={cx('input', nameError && 'invalid')}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：日本中转 · 美国落地"
                    maxLength={120}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void save();
                      }
                    }}
                  />
                </label>
                {nameError ? <span className="error-text">{nameError}</span> : null}
                <span className="hint">生成后可在节点池直接引用，右上角保存。</span>
              </>
            ) : (
              <div className="chain-name-placeholder">
                <Link2 size={15} />
                <span>左右各选一个节点后，在这里输入新节点名称</span>
              </div>
            )}
          </div>

          <p className="chain-safety-note">
            中转节点只是这条链路的前置拨号器，不会改变它原本的规则和流量走向。
          </p>

          <div className="chain-existing">
            <div className="chain-existing-head">
              <span>已生成的链路</span>
              <span className="number-badge">{chains.length}</span>
            </div>
            <div className="chain-existing-list">
              {chains.length === 0 ? (
                <div className="chain-existing-empty">还没有生成过链式节点。</div>
              ) : (
                chains.map((node) => {
                  const source = sourcesById.get(node.sourceId);
                  const chainRelay = node.chain ? workspace.nodes.find((item) => item.id === node.chain!.relayNodeId) : undefined;
                  const chainLanding = node.chain ? workspace.nodes.find((item) => item.id === node.chain!.landingNodeId) : undefined;
                  const relayName = chainRelay
                    ? nodeDisplayName(chainRelay, sourcesById.get(chainRelay.sourceId))
                    : '中转已删除';
                  const landingName = chainLanding
                    ? nodeDisplayName(chainLanding, sourcesById.get(chainLanding.sourceId))
                    : '落地已删除';
                  return (
                    <div className="chain-existing-row" key={node.id}>
                      <div className="chain-existing-copy">
                        <strong className="truncate" title={nodeDisplayName(node, source)}>
                          {nodeDisplayName(node, source)}
                        </strong>
                        <span className="truncate">
                          {relayName} <ArrowRight size={9} /> {landingName}
                        </span>
                      </div>
                      {node.chain && !chainRelay?.enabled ? <span className="badge badge-amber">失效</span> : null}
                      <button
                        className="icon-btn danger"
                        title="删除这条链路"
                        onClick={() => void removeChain(node)}
                        disabled={deletingId === node.id}
                      >
                        {deletingId === node.id ? <Spinner /> : <Trash2 size={12} />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function filterList(
  nodes: ProxyNode[],
  sourcesById: Map<string, Source>,
  sourceId: string,
  query: string,
): ProxyNode[] {
  const q = query.trim().toLowerCase();
  return nodes.filter((node) => {
    if (sourceId !== 'all' && node.sourceId !== sourceId) return false;
    if (!q) return true;
    const display = nodeDisplayName(node, sourcesById.get(node.sourceId)).toLowerCase();
    return (
      display.includes(q) ||
      (node.region ?? '').toLowerCase().includes(q) ||
      node.tags.some((tag) => tag.toLowerCase().includes(q)) ||
      (sourcesById.get(node.sourceId)?.name ?? '').toLowerCase().includes(q) ||
      String((node.raw as Record<string, unknown>).type ?? '').toLowerCase().includes(q)
    );
  });
}
