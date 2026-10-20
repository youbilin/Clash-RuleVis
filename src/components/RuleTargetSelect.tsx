import type { Exit, ProxyNode, Source } from '../../shared/types';
import { nodeDisplayName } from '../../shared/model';
import { Select, type SelectGroup } from './Select';

interface RuleTargetSelectProps {
  exitId: string;
  targetNodeId?: string;
  exits: Exit[];
  nodes: ProxyNode[];
  sources: Source[];
  onChange: (target: { exitId: string; targetNodeId?: string }) => void;
  compact?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}

export function RuleTargetSelect({
  exitId,
  targetNodeId,
  exits,
  nodes,
  sources,
  onChange,
  compact,
  disabled,
  title = '规则目标',
  ariaLabel = '规则目标',
}: RuleTargetSelectProps) {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const currentExit = exits.find((exit) => exit.id === exitId);
  const currentNode = targetNodeId ? nodes.find((node) => node.id === targetNodeId) : undefined;
  const enabledNodes = nodes
    .filter((node) => node.enabled)
    .sort((a, b) =>
      nodeDisplayName(a, sourcesById.get(a.sourceId)).localeCompare(
        nodeDisplayName(b, sourcesById.get(b.sourceId)),
        'zh-Hans-CN',
      ),
    );
  const value = targetNodeId ? `node:${targetNodeId}` : `exit:${exitId}`;
  const unresolved = targetNodeId ? !currentNode : !currentExit;
  const disabledTarget = Boolean(currentNode && !currentNode.enabled);
  const groups: SelectGroup[] = [];

  if (unresolved || disabledTarget) {
    groups.push({
      label: '当前',
      options: [
        {
          value,
          label: targetNodeId
            ? currentNode
              ? `⚠ ${nodeDisplayName(currentNode, sourcesById.get(currentNode.sourceId))}（已禁用）`
              : '⚠ 节点已丢失'
            : currentExit
              ? currentExit.name
              : exitId
                ? '⚠ 出口已丢失'
                : '请选择目标',
          disabled: true,
        },
      ],
    });
  }

  const customExits = exits.filter((exit) => !exit.builtin);
  const builtinExits = exits.filter((exit) => exit.builtin);

  groups.push({
    label: '出口',
    options: customExits.map((exit) => ({
      value: `exit:${exit.id}`,
      label: exit.name,
    })),
  });

  if (builtinExits.length) {
    groups.push({
      label: '内置',
      options: builtinExits.map((exit) => ({
        value: `exit:${exit.id}`,
        label: exit.name,
      })),
    });
  }

  if (enabledNodes.length) {
    groups.push({
      label: '节点',
      options: enabledNodes.map((node) => ({
        value: `node:${node.id}`,
        label: nodeDisplayName(node, sourcesById.get(node.sourceId)),
      })),
    });
  }

  return (
    <Select
      value={value}
      groups={groups}
      onChange={(next) => {
        if (next.startsWith('node:')) {
          onChange({ exitId: '', targetNodeId: next.slice(5) });
        } else {
          onChange({ exitId: next.slice(5), targetNodeId: undefined });
        }
      }}
      placeholder="请选择目标"
      compact={compact}
      disabled={disabled}
      title={title}
      ariaLabel={ariaLabel}
    />
  );
}
