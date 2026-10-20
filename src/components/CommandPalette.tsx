import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  FileOutput,
  History,
  Layers,
  Search,
  Server,
  Settings,
  Waypoints,
} from 'lucide-react';
import type { HistoryEntry } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../store/workspace';
import { useUi } from '../store/ui';
import { formatRelative } from '../lib/format';
import { nodeDisplayName } from '../../shared/model';
import { useBodyLock, useEscape } from '../lib/hooks';
import { useDialogFocus } from './Overlay';
import { cx } from '../lib/misc';

interface CommandItem {
  key: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: typeof Search;
  run: () => void;
}

interface CommandGroup {
  label: string;
  items: CommandItem[];
}

export function CommandPalette() {
  const workspace = useWorkspace((state) => state.workspace);
  const open = useUi((state) => state.commandOpen);
  const setOpen = useUi((state) => state.setCommandOpen);
  const setSettingsOpen = useUi((state) => state.setSettingsOpen);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useBodyLock(open);
  useEscape(() => setOpen(false), open);
  useDialogFocus(panelRef, open);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(!useUi.getState().commandOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    let cancelled = false;
    void api<{ entries: HistoryEntry[] }>('/api/history')
      .then((result) => {
        if (!cancelled) setHistory(result.entries);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const groups = useMemo<CommandGroup[]>(() => {
    if (!workspace) return [];
    const queryText = query.trim().toLowerCase();
    const matches = (value: string) => !queryText || value.toLowerCase().includes(queryText);
    const close = () => setOpen(false);
    const go = (path: string) => {
      close();
      navigate(path);
    };
    const sourcesById = new Map(workspace.sources.map((source) => [source.id, source]));
    const exitName = (id: string) => workspace.exits.find((exit) => exit.id === id)?.name ?? '未设置目标';
    const command = () => close();

    const pages: CommandItem[] = [
      { key: 'page-live', group: '页面', title: '实时连接', subtitle: '查看实时路径与拖拽目标', icon: Activity, run: () => go('/live') },
      { key: 'page-nodes', group: '页面', title: '节点与订阅', subtitle: '导入、测速与整理节点', icon: Server, run: () => go('/nodes') },
      { key: 'page-exits', group: '页面', title: '出口', subtitle: '管理策略组与成员', icon: Waypoints, run: () => go('/exits') },
      { key: 'page-rules', group: '页面', title: '规则集', subtitle: '规则库与匹配顺序', icon: Layers, run: () => go('/rulesets') },
      { key: 'page-export', group: '页面', title: '导出', subtitle: '预览、校验与历史版本', icon: FileOutput, run: () => go('/export') },
      { key: 'page-settings', group: '页面', title: '设置', subtitle: '内核连接与工作台偏好', icon: Settings, run: () => { command(); setSettingsOpen(true); } },
    ].filter((item) => matches(`${item.title} ${item.subtitle ?? ''}`));

    const nodes: CommandItem[] = workspace.nodes
      .filter((node) => matches(`${nodeDisplayName(node, sourcesById.get(node.sourceId))} ${node.region ?? ''} ${node.tags.join(' ')}`))
      .slice(0, 6)
      .map((node) => {
        const name = nodeDisplayName(node, sourcesById.get(node.sourceId));
        return {
          key: `node-${node.id}`,
          group: '节点',
          title: name,
          subtitle: `${node.region ?? '节点'}${node.enabled ? '' : ' · 已禁用'} · 查看`,
          icon: Server,
          run: () => go(`/nodes?q=${encodeURIComponent(name)}`),
        };
      });

    const exits: CommandItem[] = workspace.exits
      .filter((exit) => !exit.builtin && matches(exit.name))
      .slice(0, 6)
      .map((exit) => ({
        key: `exit-${exit.id}`,
        group: '出口',
        title: exit.name,
        subtitle: '打开出口设置',
        icon: Waypoints,
        run: () => go(`/exits?edit=${exit.id}`),
      }));

    const rules: CommandItem[] = workspace.routes
      .filter((route) => route.kind === 'ruleset' || (route.kind === 'rule' && route.type !== 'MATCH'))
      .filter((route) => matches(route.kind === 'ruleset' ? route.name : route.payload))
      .slice(0, 6)
      .map((route) => ({
        key: `route-${route.id}`,
        group: '规则',
        title: route.kind === 'ruleset' ? route.name : route.payload,
        subtitle: route.kind === 'ruleset' ? `规则集 → ${exitName(route.exitId)}` : `${route.type} → ${exitName(route.exitId)}`,
        icon: Layers,
        run: () => go(`/rulesets?q=${encodeURIComponent(route.kind === 'ruleset' ? route.name : route.payload)}`),
      }));

    const histories: CommandItem[] = history
      .filter((entry) => matches(`${entry.label} ${entry.note ?? ''}`))
      .slice(0, queryText ? 6 : 4)
      .map((entry) => ({
        key: `history-${entry.id}`,
        group: '历史',
        title: entry.label,
        subtitle: `${formatRelative(new Date(entry.at).getTime())}${entry.counts ? ` · ${entry.counts.nodes} 节点` : ''}`,
        icon: History,
        run: () => go(`/export?history=${entry.id}#history`),
      }));

    return [
      { label: '页面', items: pages },
      { label: '节点', items: queryText ? nodes : [] },
      { label: '出口', items: queryText ? exits : [] },
      { label: '规则', items: queryText ? rules : [] },
      { label: '历史', items: histories },
    ].filter((group) => group.items.length);
  }, [workspace, query, history, navigate, setOpen, setSettingsOpen]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-command-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open || !workspace) return null;

  const run = (item: CommandItem | undefined) => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  let index = -1;

  return createPortal(
    <div
      className="cmdk-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div ref={panelRef} className="cmdk" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div className="cmdk-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!flat.length) return;
                setActive((current) =>
                  (current + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length,
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                run(flat[active]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
            placeholder="搜索节点、出口、规则或跳转…"
            aria-label="全局搜索"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="kbd">ESC</span>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {groups.length ? (
            groups.map((group) => (
              <div className="cmdk-group" key={group.label}>
                <div className="cmdk-group-label">{group.label}</div>
                {group.items.map((item) => {
                  index += 1;
                  const itemIndex = index;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-command-index={itemIndex}
                      className={cx('cmdk-item', itemIndex === active && 'active')}
                      onMouseEnter={() => setActive(itemIndex)}
                      onClick={() => run(item)}
                    >
                      <Icon size={14} />
                      <span className="cmdk-copy">
                        <strong>{item.title}</strong>
                        {item.subtitle ? <span>{item.subtitle}</span> : null}
                      </span>
                      {itemIndex === active ? <ArrowRight size={12} /> : null}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="cmdk-empty">没有匹配结果</div>
          )}
        </div>
        <div className="cmdk-foot">
          <span><kbd className="kbd">↑↓</kbd> 选择</span>
          <span><kbd className="kbd">↵</kbd> 打开</span>
          <span><kbd className="kbd">ESC</kbd> 关闭</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
