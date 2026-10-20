import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { Exit, ExitMember, ExitType } from '../../shared/types';
import { collectTags, nodeDisplayName, nodeTagLabels, resolveExit } from '../../shared/model';
import { useWorkspace } from '../store/workspace';
import { toast, useUi } from '../store/ui';
import { Drawer } from './Overlay';
import { Select } from './Select';
import { cx } from '../lib/misc';
import { offerUndo } from '../lib/undo';
import { exitTypeLabel } from '../lib/labels';

interface DraftMember extends ExitMember {
  key: string;
}

interface ExitEditorProps {
  exit?: Exit;
  onClose: () => void;
}

const MEMBER_KIND_LABELS: Record<ExitMember['by'], string> = {
  node: '节点',
  tag: '标签',
  regex: '正则',
  exit: '出口',
};

const TYPE_OPTIONS: Array<{ value: ExitType; label: string; hint: string }> = [
  { value: 'select', label: '手动选择', hint: '由你决定，行为最稳定' },
  { value: 'url-test', label: '自动测速', hint: '自动使用延迟最低的成员' },
  { value: 'fallback', label: '故障转移', hint: '按顺序尝试，失败切换' },
  { value: 'load-balance', label: '负载均衡', hint: '在可用成员之间分流' },
];

export function ExitEditor({ exit, onClose }: ExitEditorProps) {
  const workspace = useWorkspace((state) => state.workspace);
  const update = useWorkspace((state) => state.update);
  const createUndoPoint = useWorkspace((state) => state.createUndoPoint);
  const confirm = useUi((state) => state.confirm);

  const [name, setName] = useState(exit?.name ?? '');
  const [type, setType] = useState<ExitType>(exit?.type ?? 'select');
  const [testUrl, setTestUrl] = useState(exit?.testUrl ?? workspace?.settings.testUrl ?? '');
  const [interval, setIntervalValue] = useState(String(exit?.interval ?? 300));
  const [tolerance, setTolerance] = useState(String(exit?.tolerance ?? 50));
  const [members, setMembers] = useState<DraftMember[]>(
    (exit?.members ?? []).map((member) => ({ ...member, key: crypto.randomUUID() })),
  );
  const [nameError, setNameError] = useState('');

  const sourcesById = useMemo(() => new Map((workspace?.sources ?? []).map((s) => [s.id, s])), [workspace?.sources]);
  const sortedNodes = useMemo(
    () =>
      [...(workspace?.nodes ?? [])].sort((a, b) =>
        nodeDisplayName(a, sourcesById.get(a.sourceId)).localeCompare(
          nodeDisplayName(b, sourcesById.get(b.sourceId)),
          'zh-Hans-CN',
        ),
      ),
    [workspace?.nodes, sourcesById],
  );
  const tagOptions = useMemo(() => collectTags(workspace?.nodes ?? []), [workspace?.nodes]);

  const draftExit: Exit = useMemo(
    () => ({
      id: exit?.id ?? 'draft',
      name: name || '未命名出口',
      type,
      members: members.filter((member) => member.value.trim()).map(({ key: _key, ...member }) => member),
      order: exit?.order ?? 9999,
      testUrl,
      interval: Number(interval) || 300,
      tolerance: Number(tolerance) || 50,
    }),
    [exit?.id, exit?.order, name, type, members, testUrl, interval, tolerance],
  );

  const resolution = useMemo(() => {
    if (!workspace) return null;
    return resolveExit(draftExit, {
      nodes: workspace.nodes,
      exits: workspace.exits,
      sources: workspace.sources,
    });
  }, [workspace?.nodes, workspace?.exits, workspace?.sources, draftExit]);

  if (!workspace) return null;

  const resolvedNames = (resolution?.allNodeIds ?? [])
    .map((id) => {
      const node = workspace.nodes.find((item) => item.id === id);
      return node ? nodeDisplayName(node, sourcesById.get(node.sourceId)) : null;
    })
    .filter((value): value is string => Boolean(value));

  const memberMatchCount = (member: DraftMember): number | null => {
    if (!member.value.trim()) return null;
    if (member.by === 'node') {
      const node = workspace.nodes.find((item) => item.id === member.value);
      return node && node.enabled ? 1 : 0;
    }
    if (member.by === 'tag') {
      const tag = member.value.trim().toLowerCase();
      return workspace.nodes.filter(
        (node) => node.enabled && nodeTagLabels(node).some((label) => label.toLowerCase() === tag),
      ).length;
    }
    if (member.by === 'regex') {
      try {
        const re = new RegExp(member.value, 'i');
        return workspace.nodes.filter(
          (node) => node.enabled && re.test(nodeDisplayName(node, sourcesById.get(node.sourceId))),
        ).length;
      } catch {
        return -1;
      }
    }
    const target = workspace.exits.find((item) => item.id === member.value);
    if (!target) return 0;
    return resolveExit(target, {
      nodes: workspace.nodes,
      exits: workspace.exits,
      sources: workspace.sources,
    }).allNodeIds.length;
  };

  const updateMember = (index: number, patch: Partial<DraftMember>) => {
    setMembers((current) =>
      current.map((member, memberIndex) => (memberIndex === index ? { ...member, ...patch } : member)),
    );
  };

  const changeMemberKind = (index: number, by: ExitMember['by']) => {
    const defaultValue = by === 'node' ? sortedNodes.find((node) => node.enabled)?.id ?? '' : '';
    updateMember(index, { by, value: defaultValue });
  };

  const addMember = () => {
    setMembers((current) => [...current, { key: crypto.randomUUID(), by: 'tag', value: '' }]);
  };

  const removeMember = (index: number) => {
    setMembers((current) => current.filter((_, memberIndex) => memberIndex !== index));
  };

  const moveMember = (index: number, direction: -1 | 1) => {
    setMembers((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('请填写出口名称');
      return;
    }
    if (/[\r\n,]/.test(trimmed)) {
      setNameError('出口名不能包含换行或逗号');
      return;
    }
    if (['DIRECT', 'REJECT', 'GLOBAL'].includes(trimmed.toUpperCase())) {
      setNameError('该名称与内置出站冲突');
      return;
    }
    const duplicate = workspace.exits.some(
      (item) => item.id !== exit?.id && item.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (duplicate) {
      setNameError('已存在同名出口');
      return;
    }
    const cleanedMembers = members
      .filter((member) => member.value.trim())
      .map(({ key: _key, ...member }) => ({ ...member, value: member.value.trim() }));
    const order = exit?.order ?? workspace.exits.reduce((max, item) => Math.max(max, item.order), 0) + 1;
    const saved: Exit = {
      id: exit?.id ?? crypto.randomUUID(),
      name: trimmed,
      type,
      members: cleanedMembers,
      order,
      sourceId: exit?.sourceId,
      testUrl: type === 'select' ? undefined : testUrl.trim() || workspace.settings.testUrl,
      interval: type === 'select' ? undefined : Math.max(30, Number(interval) || 300),
      tolerance: type === 'url-test' ? Math.max(1, Number(tolerance) || 50) : undefined,
    };
    update((draft) => {
      const index = draft.exits.findIndex((item) => item.id === exit?.id);
      if (index >= 0) draft.exits[index] = saved;
      else draft.exits.push(saved);
    });
    toast('success', exit ? '出口已更新' : '出口已创建', `${trimmed} · ${cleanedMembers.length} 个成员定义`);
    onClose();
  };

  const deleteExit = async () => {
    if (!exit) return;
    const ruleRefs = workspace.routes.filter((route) => route.exitId === exit.id).length;
    const nestedRefs = workspace.exits.filter(
      (item) => item.id !== exit.id && item.members.some((member) => member.by === 'exit' && member.value === exit.id),
    ).length;
    const confirmed = await confirm({
      title: '删除出口',
      message: [
        `「${exit.name}」将从工作区移除。`,
        ruleRefs ? `有 ${ruleRefs} 条规则指向它，删除后这些规则会失去目标并在导出时被阻止。` : '',
        nestedRefs ? `有 ${nestedRefs} 个出口把它当作嵌套成员，相关引用会被移除。` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmLabel: '删除出口',
      danger: true,
    });
    if (!confirmed) return;
    const undo = await createUndoPoint('删除出口 · ' + exit.name);
    update((draft) => {
      draft.exits = draft.exits.filter((item) => item.id !== exit.id);
      for (const item of draft.exits) {
        if (!item.builtin) {
          item.members = item.members.filter((member) => !(member.by === 'exit' && member.value === exit.id));
        }
      }
    });
    offerUndo(undo, '出口已删除', exit.name);
    onClose();
  };

  return (
    <Drawer
      title={exit ? '编辑出口' : '新建出口'}
      subtitle={exit ? exit.name : '出口对应 mihomo 的策略组，是拖拽规则的落点'}
      onClose={onClose}
      footer={
        <>
          {exit ? (
            <button className="btn btn-danger" onClick={() => void deleteExit()} style={{ marginRight: 'auto' }}>
              <Trash2 size={13} /> 删除
            </button>
          ) : null}
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={save}>{exit ? '保存修改' : '创建出口'}</button>
        </>
      }
    >
      <div className="editor-section">
        <label className="field">
          <span className="field-label">出口名称</span>
          <input
            className="input"
            value={name}
            autoFocus
            placeholder="例如：家宽、看视频、AI"
            onChange={(event) => {
              setName(event.target.value);
              setNameError('');
            }}
          />
          {nameError ? <span className="error-text">{nameError}</span> : null}
        </label>
      </div>

      <div className="editor-section">
        <div className="section-title">类型</div>
        <div className="segmented exit-type-segmented">
          {TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={cx(type === option.value && 'active')}
              onClick={() => setType(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          {TYPE_OPTIONS.find((option) => option.value === type)?.hint}
        </p>
        {type !== 'select' ? (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label className="field span-2">
              <span className="field-label">测速地址</span>
              <input className="input mono" value={testUrl} onChange={(event) => setTestUrl(event.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">间隔（秒）</span>
              <input
                className="input mono"
                type="number"
                min={30}
                value={interval}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
            </label>
            {type === 'url-test' ? (
              <label className="field">
                <span className="field-label">容差（ms）</span>
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  value={tolerance}
                  onChange={(event) => setTolerance(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="editor-section">
        <div className="section-title">
          成员定义
          <span className="eyebrow">MIX & MATCH</span>
          <span className="spacer" />
          <button className="btn btn-sm btn-outline" onClick={addMember}>
            <Plus size={12} /> 添加
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 10 }}>
          可以混用手选节点、标签、名称正则和嵌套出口。标签与正则会在导出时静态展开。
        </p>
        {members.length === 0 ? (
          <div className="member-empty">
            还没有成员。添加一个标签或节点开始。
          </div>
        ) : (
          <div className="member-editor-list">
            {members.map((member, index) => {
              const count = memberMatchCount(member);
              return (
                <div className="member-row" key={member.key}>
                  <Select
                    className="member-kind"
                    value={member.by}
                    onChange={(value) => changeMemberKind(index, value as ExitMember['by'])}
                    ariaLabel="成员类型"
                    options={Object.entries(MEMBER_KIND_LABELS).map(([value, label]) => ({ value, label }))}
                  />

                  {member.by === 'node' ? (
                    <Select
                      className="member-value"
                      value={member.value}
                      onChange={(value) => updateMember(index, { value })}
                      placeholder="选择节点…"
                      ariaLabel="选择节点"
                      options={[
                        { value: '', label: '选择节点…' },
                        ...sortedNodes.map((node) => {
                          const source = sourcesById.get(node.sourceId);
                          return {
                            value: node.id,
                            label: `${nodeDisplayName(node, source)}${node.enabled ? '' : '（已禁用）'}`,
                          };
                        }),
                      ]}
                    />
                  ) : member.by === 'tag' ? (
                    <input
                      className="input member-value"
                      placeholder="标签，例如 家宽"
                      value={member.value}
                      list="exit-member-tags"
                      onChange={(event) => updateMember(index, { value: event.target.value })}
                    />
                  ) : member.by === 'regex' ? (
                    <input
                      className="input member-value mono"
                      placeholder="名称正则，例如 (?i)日本"
                      value={member.value}
                      onChange={(event) => updateMember(index, { value: event.target.value })}
                    />
                  ) : (
                    <Select
                      className="member-value"
                      value={member.value}
                      onChange={(value) => updateMember(index, { value })}
                      placeholder="选择出口…"
                      ariaLabel="选择出口"
                      options={[
                        { value: '', label: '选择出口…' },
                        ...workspace.exits
                          .filter((item) => item.id !== exit?.id)
                          .sort((a, b) => a.order - b.order)
                          .map((item) => ({
                            value: item.id,
                            label: `${item.name} · ${exitTypeLabel(item.type)}`,
                          })),
                      ]}
                    />
                  )}

                  <span className={cx('member-count mono', count === 0 && 'zero', count === -1 && 'invalid')}>
                    {count === null ? '—' : count === -1 ? '无效' : `${count} 个`}
                  </span>

                  <div className="member-actions">
                    <button className="icon-btn" onClick={() => moveMember(index, -1)} disabled={index === 0} title="上移">
                      <ArrowUp size={12} />
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => moveMember(index, 1)}
                      disabled={index === members.length - 1}
                      title="下移"
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button className="icon-btn danger" onClick={() => removeMember(index)} title="移除">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <datalist id="exit-member-tags">
          {tagOptions.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      </div>

      <div className="editor-section">
        <div className="section-title">
          解析预览
          <span className="badge badge-green">{resolvedNames.length} 个展开节点</span>
        </div>
        {resolvedNames.length ? (
          <div className="resolution-chips">
            {resolvedNames.slice(0, 16).map((label) => (
              <span className="tag" key={label}>{label}</span>
            ))}
            {resolvedNames.length > 16 ? <span className="tag">+{resolvedNames.length - 16}</span> : null}
          </div>
        ) : (
          <div className="callout warn">
            <AlertTriangle size={14} />
            <span>该出口没有解析到任何已启用节点。导出前会被校验阻止。</span>
          </div>
        )}
        {resolution?.missing.length ? (
          <div className="missing-list">
            {resolution.missing.map((missing) => (
              <div className="missing-row" key={`${missing.by}-${missing.value}-${missing.reason}`}>
                <span className="dot amber" />
                <span>{MEMBER_KIND_LABELS[missing.by]}「{missing.value}」：{missing.reason}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
