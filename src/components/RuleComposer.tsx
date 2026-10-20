import { useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowRight, Check, Layers, X } from 'lucide-react';
import type { Exit, LiveDomainConnection, RuleRoute, RuleType } from '../../shared/types';
import {
  findCoveringRoute,
  findDuplicateRoute,
  insertRouteOrdered,
  isIPv6,
  nodeDisplayName,
  resolveExit,
  suggestRootDomain,
} from '../../shared/model';
import { useWorkspace } from '../store/workspace';
import { toast } from '../store/ui';
import { useEscape } from '../lib/hooks';
import { cx } from '../lib/misc';
import { ruleTypeLabel } from '../lib/labels';
import { Modal } from './Overlay';
import { RuleTargetSelect } from './RuleTargetSelect';

type DomainRuleChoice = 'DOMAIN-SUFFIX' | 'DOMAIN' | 'DOMAIN-KEYWORD';

interface RectLike {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface RuleComposerProps {
  entries: LiveDomainConnection[];
  initialExitId?: string;
  initialNodeId?: string;
  anchorRect?: RectLike;
  onClose: () => void;
  onDone?: () => void;
}

interface Proposal {
  host: string;
  type: RuleType;
  payload: string;
  noResolve?: boolean;
  duplicate: boolean;
  covering: number | null;
}

function buildProposals(entries: LiveDomainConnection[], domainType: DomainRuleChoice, noResolve: boolean): Proposal[] {
  const proposals: Proposal[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let type: RuleType;
    let payload: string;
    let flag = false;
    if (entry.isIp) {
      const ipv6 = isIPv6(entry.host);
      type = ipv6 ? 'IP-CIDR6' : 'IP-CIDR';
      payload = `${entry.host}/${ipv6 ? 128 : 32}`;
      flag = noResolve;
    } else {
      type = domainType;
      payload = suggestRootDomain(entry.host);
    }
    if (!payload) continue;
    const key = `${type}|${payload.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push({ host: entry.host, type, payload, noResolve: flag, duplicate: false, covering: null });
  }
  return proposals;
}

function RuleComposerContent({
  entries,
  initialExitId,
  initialNodeId,
  onClose,
  onDone,
  modal,
  anchorStyle,
}: RuleComposerProps & { modal?: boolean; anchorStyle?: CSSProperties }) {
  const workspace = useWorkspace((state) => state.workspace);
  const addPendingRules = useWorkspace((state) => state.addPendingRules);

  const availableExits = useMemo<Exit[]>(() => {
    if (!workspace) return [];
    return workspace.exits
      .filter((exit) => !exit.builtin)
      .sort((a, b) => a.order - b.order)
      .concat(workspace.exits.filter((exit) => exit.builtin));
  }, [workspace?.exits]);

  const sourcesById = useMemo(
    () => new Map((workspace?.sources ?? []).map((source) => [source.id, source])),
    [workspace?.sources],
  );

  const [exitId, setExitId] = useState(
    initialNodeId ? '' : initialExitId ?? availableExits.find((exit) => !exit.builtin)?.id ?? 'direct',
  );
  const [targetNodeId, setTargetNodeId] = useState<string | undefined>(initialNodeId);
  const [domainType, setDomainType] = useState<DomainRuleChoice>(
    workspace?.settings.defaultRuleType ?? 'DOMAIN-SUFFIX',
  );
  const [noResolve, setNoResolve] = useState(true);

  useEscape(onClose);

  const exit = targetNodeId ? undefined : workspace?.exits.find((item) => item.id === exitId);
  const node = targetNodeId ? workspace?.nodes.find((item) => item.id === targetNodeId) : undefined;
  const source = node ? sourcesById.get(node.sourceId) : undefined;
  const targetLabel = node ? nodeDisplayName(node, source) : exit?.name ?? '请选择目标';
  const hasIp = entries.some((entry) => entry.isIp);

  const resolution = useMemo(() => {
    if (!workspace || !exit) return null;
    return resolveExit(exit, {
      nodes: workspace.nodes,
      exits: workspace.exits,
      sources: workspace.sources,
    });
  }, [exit, workspace?.nodes, workspace?.exits, workspace?.sources]);

  const proposals = useMemo(() => {
    if (!workspace) return [];
    const base = buildProposals(entries, domainType, noResolve);
    const existing = base.map((proposal) => ({
      ...proposal,
      duplicate: findDuplicateRoute(workspace.routes, proposal) >= 0,
    }));
    const proposedRoutes: RuleRoute[] = existing.map((proposal) => ({
      id: `proposal-${proposal.type}-${proposal.payload}`,
      kind: 'rule',
      type: proposal.type,
      payload: proposal.payload,
      exitId,
      targetNodeId,
      noResolve: proposal.noResolve,
      origin: 'drag',
      enabled: true,
    }));
    let temp = [...workspace.routes];
    for (const proposed of proposedRoutes) temp = insertRouteOrdered(temp, proposed);
    return existing.map((proposal) => {
      const id = `proposal-${proposal.type}-${proposal.payload}`;
      const index = temp.findIndex((route) => route.id === id);
      const covering = index >= 0 ? findCoveringRoute(temp, index) : null;
      return { ...proposal, covering: covering ? covering.index + 1 : null };
    });
  }, [entries, domainType, noResolve, workspace?.routes, exitId, targetNodeId]);

  if (!workspace) return null;

  const addCount = proposals.filter((proposal) => !proposal.duplicate).length;
  const missingCount = resolution?.missing.length ?? 0;
  const emptyExit = Boolean(exit && !exit.builtin && (resolution?.allNodeIds.length ?? 0) === 0);

  const confirm = () => {
    if (!exit && !node) return;
    const inputs = proposals
      .filter((proposal) => !proposal.duplicate)
      .map((proposal) => ({
        type: proposal.type as RuleRoute['type'],
        payload: proposal.payload,
        exitId: exit?.id ?? '',
        targetNodeId: node?.id,
        noResolve: proposal.noResolve,
        origin: 'drag' as const,
        note: entries.length > 1 ? `${entries.length} 个域名拖拽生成` : undefined,
      }));
    const result = addPendingRules(inputs);
    if (result.added > 0) {
      toast(
        'success',
        `已加入待应用 · ${result.added} 条`,
        `目标${node ? '节点' : '出口'}「${targetLabel}」${result.skipped ? `，${result.skipped} 条已存在` : ''}`,
      );
    } else {
      toast('info', '没有新增规则', '这些规则已经存在于工作区');
    }
    onDone?.();
    onClose();
  };

  const body = (
    <>
      <div className="composer-block">
        <div className="composer-label">目标出口 / 节点</div>
        <div className="composer-exit">
          <span className={cx('dot', node || !exit?.builtin ? 'green' : 'blue')} />
          <strong>{targetLabel}</strong>
          <span className="badge">{node ? '节点' : exit?.type ?? '—'}</span>
          <span className="composer-exit-meta">
            {node
              ? node.region ?? '直接使用该节点'
              : resolution
                ? `${resolution.allNodeIds.length} 个展开节点`
                : ''}
          </span>
          {emptyExit ? <span className="badge badge-red">无成员</span> : null}
        </div>
        <div style={{ marginTop: 8 }}>
          <RuleTargetSelect
            exitId={exitId}
            targetNodeId={targetNodeId}
            exits={availableExits}
            nodes={workspace.nodes}
            sources={workspace.sources}
            onChange={(target) => {
              setExitId(target.exitId);
              setTargetNodeId(target.targetNodeId);
            }}
          />
        </div>
        {missingCount > 0 && resolution ? (
          <div className="composer-missing">
            <AlertTriangle size={12} />
            {resolution.missing.length} 个成员引用已失效，导出前需要修复
          </div>
        ) : null}
        {node ? (
          <div className="composer-hint">规则会直接指向这个节点，不再经过出口策略组。</div>
        ) : null}
      </div>

      <div className="composer-block">
        <div className="composer-label">域名规则类型</div>
        <div className="segmented">
          {([
            ['DOMAIN-SUFFIX', '后缀'],
            ['DOMAIN', '精确'],
            ['DOMAIN-KEYWORD', '关键字'],
          ] as Array<[DomainRuleChoice, string]>).map(([value, label]) => (
            <button
              key={value}
              className={cx(domainType === value && 'active')}
              onClick={() => setDomainType(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="composer-hint">
          {domainType === 'DOMAIN-SUFFIX'
            ? '按公共后缀归并到根域名，例如 www.bilibili.com → bilibili.com'
            : domainType === 'DOMAIN'
              ? '只匹配完整的当前域名，不包含子域'
              : '匹配包含该关键词的域名，范围最大'}
        </div>
        {hasIp ? (
          <label className="checkbox-row" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={noResolve} onChange={(event) => setNoResolve(event.target.checked)} />
            <span>IP 规则带 no-resolve</span>
          </label>
        ) : null}
      </div>

      <div className="composer-block">
        <div className="composer-label">
          将生成 <span className="number-badge">{proposals.length}</span> 条规则
          {proposals.some((proposal) => proposal.duplicate) ? <span className="faint">（自动跳过重复）</span> : null}
        </div>
        <div className="proposal-list">
          {proposals.map((proposal) => (
            <div
              className={cx('proposal-line', proposal.duplicate && 'duplicate')}
              key={`${proposal.type}-${proposal.payload}`}
            >
              <span className="proposal-host mono truncate" title={proposal.host}>{proposal.host}</span>
              <ArrowRight size={11} />
              <span className={cx('badge', (proposal.type === 'IP-CIDR' || proposal.type === 'IP-CIDR6') && 'badge-blue')} title={proposal.type}>
                {ruleTypeLabel(proposal.type)}
              </span>
              <span className="proposal-value mono truncate" title={proposal.payload}>{proposal.payload}</span>
              {proposal.duplicate ? <span className="badge badge-plain">已存在</span> : null}
              {proposal.covering ? (
                <span className="badge badge-amber" title="已有更早的规则会先命中该域名">
                  被 #{proposal.covering} 优先
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {emptyExit ? (
        <div className="callout warn">
          <AlertTriangle size={14} />
          <span>该出口当前没有可用成员，规则仍可创建，但导出会被校验阻止。请先到出口页补充成员。</span>
        </div>
      ) : null}

      <div className="composer-actions">
        <span className="composer-summary">
          <Layers size={12} /> 确认后进入底部待应用托盘
        </span>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={confirm} disabled={!addCount || (!exit && !node)}>
          <Check size={13} /> 加入待应用 · {addCount}
        </button>
      </div>
    </>
  );

  if (modal) {
    return (
      <Modal title="生成规则" subtitle="确认规则类型与目标出口或节点" size="md" onClose={onClose}>
        {body}
      </Modal>
    );
  }

  return createPortal(
    <div
      className="composer-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="composer-panel" style={anchorStyle} role="dialog" aria-label="确认规则">
        <div className="composer-head">
          <div>
            <div className="composer-title">生成路由规则</div>
            <div className="composer-sub">
              {entries.length} 个域名 → 「{targetLabel}」
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="composer-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}

export function RuleComposer(props: RuleComposerProps) {
  if (!props.anchorRect) {
    return <RuleComposerContent {...props} modal />;
  }
  const anchor = props.anchorRect;
  const width = 402;
  let left = anchor.left - width - 14;
  if (left < 12) left = Math.min(window.innerWidth - width - 12, anchor.right + 14);
  const estimatedHeight = 470;
  const top = Math.min(
    Math.max(12, anchor.top - 8),
    Math.max(12, window.innerHeight - estimatedHeight - 12),
  );
  return <RuleComposerContent {...props} anchorStyle={{ position: 'fixed', left, top, width }} />;
}
