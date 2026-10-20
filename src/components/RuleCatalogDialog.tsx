import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BookOpen, Check, Layers, Search, Sparkles, Upload } from 'lucide-react';
import type { Workspace } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../store/workspace';
import { toast } from '../store/ui';
import { Modal } from './Overlay';
import { Spinner } from './Common';
import { Select } from './Select';
import {
  RULE_CATALOG,
  RULE_COMBOS,
  catalogEntryById,
  comboTargetHint,
  type RuleCatalogEntry,
  type RuleCombo,
} from '../lib/catalog';
import { cx } from '../lib/misc';
import { exitTypeLabel } from '../lib/labels';

interface RuleCatalogDialogProps {
  onClose: () => void;
  onAdvanced?: () => void;
}

type CatalogTab = 'combos' | 'all';

export function RuleCatalogDialog({ onClose, onAdvanced }: RuleCatalogDialogProps) {
  const workspace = useWorkspace((state) => state.workspace);
  const applyServerWorkspace = useWorkspace((state) => state.applyServerWorkspace);
  const exits = useMemo(
    () => [...(workspace?.exits ?? [])].sort(
      (a, b) => Number(Boolean(a.builtin)) - Number(Boolean(b.builtin)) || a.order - b.order,
    ),
    [workspace?.exits],
  );
  const defaultExit = exits.find((exit) => !exit.builtin)?.id ?? 'direct';
  const [tab, setTab] = useState<CatalogTab>('combos');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exitId, setExitId] = useState(defaultExit);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const categories = useMemo(
    () => [...new Set(RULE_CATALOG.map((entry) => entry.category))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    [],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return RULE_CATALOG.filter((entry) => {
      if (category && entry.category !== category) return false;
      if (!query) return true;
      return (
        entry.nameZh.toLowerCase().includes(query) ||
        entry.nameEn.toLowerCase().includes(query) ||
        entry.slug.toLowerCase().includes(query) ||
        entry.category.toLowerCase().includes(query) ||
        entry.descriptionZh.toLowerCase().includes(query)
      );
    }).sort((a, b) => {
      if (a.popular !== b.popular) return a.popular ? -1 : 1;
      return a.nameZh.localeCompare(b.nameZh, 'zh-Hans-CN');
    });
  }, [search, category]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 42,
    overscan: 10,
  });

  if (!workspace) return null;

  const selectedEntries = [...selected]
    .map((id) => catalogEntryById(id))
    .filter((entry): entry is RuleCatalogEntry => Boolean(entry));
  const selectedNames = selectedEntries.slice(0, 5).map((entry) => entry.nameZh);
  const selectedCount = selectedEntries.length;
  const activeCombo = RULE_COMBOS.find((combo) => combo.entries.length === selected.size && combo.entries.every((id) => selected.has(id)));

  const chooseCombo = (combo: RuleCombo) => {
    setSelected(new Set(combo.entries));
    const hint = comboTargetHint(combo, exits.map((exit) => exit.name));
    if (hint) {
      const target = exits.find((exit) => exit.name === hint);
      if (target) setExitId(target.id);
    }
  };

  const toggleEntry = (entryId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const add = async () => {
    if (!selectedCount) return;
    setAdding(true);
    try {
      const items = selectedEntries.map((entry) => ({
        name: entry.nameZh,
        providerName: entry.providerName,
        url: entry.url,
        behavior: entry.behavior,
        format: entry.format,
      }));
      const result = await api<{ workspace: Workspace; added: number; skipped: string[] }>(
        '/api/rule-sets/create-batch',
        { method: 'POST', body: { items, exitId } },
      );
      applyServerWorkspace(result.workspace);
      if (result.added) {
        toast(
          'success',
          `已添加 ${result.added} 个规则集`,
          result.skipped.length ? `${result.skipped.length} 个已存在，已跳过` : '可在规则列表中拖动调整顺序',
        );
      } else {
        toast('info', '没有新增规则集', '选中的规则集已经在工作区里');
      }
      onClose();
    } catch (error) {
      toast('error', '添加规则集失败', (error as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal
      title="从规则库添加"
      subtitle="内置 MetaCubeX 规则 · 选好后指定出口。"
      size="xl"
      onClose={onClose}
      footer={
        <>
          {onAdvanced ? (
            <button className="btn btn-ghost" onClick={onAdvanced} style={{ marginRight: 'auto' }}>
              <Upload size={13} /> URL / 文件高级导入
            </button>
          ) : null}
          <span className="foot-note">节点在「出口」页管理</span>
          <button className="btn btn-primary" onClick={() => void add()} disabled={!selectedCount || adding}>
            {adding ? <Spinner onAccent /> : <Check size={13} />}
            {selectedCount ? `添加 ${selectedCount} 个规则集` : '添加规则集'}
          </button>
        </>
      }
    >
      <div className="catalog-layout">
        <div className="catalog-main">
          <div className="import-tabs catalog-tabs">
            <button className={cx('import-tab', tab === 'combos' && 'active')} onClick={() => setTab('combos')}>
              <Sparkles size={13} /> 推荐组合
            </button>
            <button className={cx('import-tab', tab === 'all' && 'active')} onClick={() => setTab('all')}>
              <BookOpen size={13} /> 全部规则 <span className="catalog-total">{RULE_CATALOG.length}</span>
            </button>
          </div>

          {tab === 'combos' ? (
            <div className="combo-grid">
              {RULE_COMBOS.map((combo) => {
                const active = activeCombo?.id === combo.id;
                return (
                  <button
                    className={cx('combo-card', active && 'active')}
                    key={combo.id}
                    onClick={() => chooseCombo(combo)}
                  >
                    <div className="combo-card-top">
                      <span className="combo-category">{combo.category}</span>
                      <span className="combo-count">{combo.entryCount} 个规则集</span>
                    </div>
                    <strong>{combo.nameZh}</strong>
                    <p>{combo.description}</p>
                    <span className="combo-select">
                      {active ? <><Check size={11} /> 已选择</> : '点击选择整组'}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="catalog-all">
              <div className="catalog-filters">
                <div className="search-box" style={{ flex: 1 }}>
                  <Search size={13} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索中文名、英文名或站点，例如：Google、游戏、广告"
                  />
                </div>
                <Select
                  compact
                  value={category}
                  onChange={setCategory}
                  ariaLabel="规则分类"
                  options={[
                    { value: '', label: '全部分类' },
                    ...categories.map((item) => ({ value: item, label: item })),
                  ]}
                />
              </div>
              <div className="catalog-list" ref={listRef}>
                {filtered.length === 0 ? (
                  <div className="catalog-empty">没有匹配的规则，换个关键词试试。</div>
                ) : (
                  <div className="virtual-canvas" style={{ height: virtualizer.getTotalSize() }}>
                    {virtualizer.getVirtualItems().map((item) => {
                      const entry = filtered[item.index];
                      if (!entry) return null;
                      const isSelected = selected.has(entry.id);
                      return (
                        <div
                          className={cx('catalog-row', isSelected && 'selected')}
                          key={entry.id}
                          data-index={item.index}
                          ref={virtualizer.measureElement}
                          style={{ transform: `translateY(${item.start}px)` }}
                          onClick={() => toggleEntry(entry.id)}
                        >
                          <input type="checkbox" checked={isSelected} readOnly />
                          <div className="catalog-row-main">
                            <span className="catalog-row-name">
                              {entry.nameZh}
                              {entry.popular ? <span className="catalog-popular">常用</span> : null}
                            </span>
                            <span className="catalog-row-slug">{entry.nameEn} · {entry.slug}</span>
                          </div>
                          <span className={cx('badge', entry.kind === 'geoip' ? 'badge-amber' : '')}>
                            {entry.kind === 'geoip' ? 'IP 段' : '域名'}
                          </span>
                          <span className="catalog-row-category">{entry.category}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="catalog-hint">共 {filtered.length} 条 · 冷门站点保留上游英文名称，常用服务均已中文标注</div>
            </div>
          )}
        </div>

        <aside className={cx('catalog-side', !selectedCount && 'is-empty')}>
          <div className="catalog-side-title">
            <Layers size={13} /> 已选择
            <span className="number-badge">{selectedCount}</span>
            {selectedCount ? (
              <button className="inline-link" style={{ marginLeft: 'auto', fontSize: 13 }} onClick={() => setSelected(new Set())}>
                清空
              </button>
            ) : null}
          </div>
          {selectedCount ? (
            <>
              <div className="catalog-selected-names">
                {selectedNames.map((name) => <span key={name} className="tag">{name}</span>)}
                {selectedCount > selectedNames.length ? <span className="tag">+{selectedCount - selectedNames.length}</span> : null}
              </div>
              <label className="field catalog-target">
                <span className="field-label">规则指向的出口</span>
                <Select
                  value={exitId}
                  onChange={setExitId}
                  ariaLabel="规则指向的出口"
                  options={exits.map((exit) => ({
                    value: exit.id,
                    label: `${exit.name} · ${exitTypeLabel(exit.type)}`,
                  }))}
                />
              </label>
              <p className="hint">节点在「出口」页管理。</p>
              {activeCombo ? (
                <div className="callout info" style={{ marginTop: 10 }}>
                  {activeCombo.description}
                </div>
              ) : null}
            </>
          ) : (
            <div className="catalog-side-empty">
              <Layers size={20} />
              <p>从左侧选择规则组合或分类。</p>
              <span>已内置 {RULE_CATALOG.length} 条规则</span>
            </div>
          )}
        </aside>
      </div>
    </Modal>
  );
}
