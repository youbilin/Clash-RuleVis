import { randomUUID } from 'node:crypto';
import type { Exit, RuleRoute, Workspace, WorkspaceSettings } from '../shared/types';
import { WORKSPACE_VERSION } from '../shared/types';
import { nodeDisplayName, pruneUnavailableExitMembers } from '../shared/model';

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  onboarded: false,
  testUrl: 'https://www.gstatic.com/generate_204',
  retentionMinutes: 5,
  subscriptionUserAgent: 'clash-verge/v2.5.8',
  useProxyForFetch: true,
  defaultRuleType: 'DOMAIN-SUFFIX',
  includeBaseTemplate: true,
  favoriteExitIds: [],
};

export function createBuiltinExits(): Exit[] {
  return [
    { id: 'direct', name: 'DIRECT', type: 'select', members: [], builtin: true, order: -2 },
    { id: 'reject', name: 'REJECT', type: 'select', members: [], builtin: true, order: -1 },
  ];
}

export function createDefaultWorkspace(): Workspace {
  const now = new Date().toISOString();
  const autoId = randomUUID();
  const allId = randomUUID();
  const exits: Exit[] = [
    ...createBuiltinExits(),
    {
      id: autoId,
      name: '自动选择',
      type: 'url-test',
      members: [{ by: 'regex', value: '.*' }],
      order: 0,
      interval: 300,
    },
    {
      id: allId,
      name: '全部节点',
      type: 'select',
      members: [{ by: 'regex', value: '.*' }],
      order: 1,
    },
  ];
  const match: RuleRoute = {
    id: randomUUID(),
    kind: 'rule',
    type: 'MATCH',
    payload: '',
    exitId: autoId,
    origin: 'manual',
    enabled: true,
  };
  return {
    version: WORKSPACE_VERSION,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    sources: [],
    nodes: [],
    exits,
    routes: [match],
    settings: { ...DEFAULT_SETTINGS },
  };
}

export const MANUAL_SOURCE_NAME = '节点链接';
export const MANUAL_SOURCE_NOTE = 'manual-link';

export function normalizeManualSources(workspace: Workspace): void {
  const manualSources = workspace.sources.filter((source) => source.type === 'manual');
  if (!manualSources.length) return;
  const canonical =
    manualSources.find((source) => source.note === MANUAL_SOURCE_NOTE) ?? manualSources[0];
  const others = manualSources.filter((source) => source.id !== canonical.id);
  if (!others.length && canonical.note === MANUAL_SOURCE_NOTE) return;
  canonical.name = MANUAL_SOURCE_NAME;
  canonical.note = MANUAL_SOURCE_NOTE;
  canonical.keepRules = false;
  const mergedIds = new Set(others.map((source) => source.id));
  for (const node of workspace.nodes) {
    if (mergedIds.has(node.sourceId)) node.sourceId = canonical.id;
  }
  if (mergedIds.size) {
    workspace.sources = workspace.sources.filter((source) => !mergedIds.has(source.id));
  }
}

export function findMatchRoute(workspace: Workspace): RuleRoute | undefined {
  return workspace.routes.find((r): r is RuleRoute => r.kind === 'rule' && r.type === 'MATCH');
}

export function ensureWorkspaceShape(workspace: Workspace): Workspace {
  if (!Array.isArray(workspace.sources)) workspace.sources = [];
  if (!Array.isArray(workspace.nodes)) workspace.nodes = [];
  if (!Array.isArray(workspace.exits)) workspace.exits = [];
  if (!Array.isArray(workspace.routes)) workspace.routes = [];
  workspace.settings = { ...DEFAULT_SETTINGS, ...(workspace.settings ?? {}) };
  workspace.version = WORKSPACE_VERSION;
  normalizeManualSources(workspace);

  const sourcesById = new Map(workspace.sources.map((source) => [source.id, source]));
  for (const node of workspace.nodes) {
    if (!node.chain) continue;
    const relay = workspace.nodes.find((item) => item.id === node.chain!.relayNodeId);
    if (relay) {
      node.raw = {
        ...node.raw,
        'dialer-proxy': nodeDisplayName(relay, sourcesById.get(relay.sourceId)),
      };
    }
  }

  pruneUnavailableExitMembers(workspace);

  const builtins = createBuiltinExits();
  for (const b of builtins) {
    if (!workspace.exits.some((e) => e.id === b.id)) workspace.exits.push(b);
  }

  let match = findMatchRoute(workspace);
  if (!match) {
    const fallbackExit =
      workspace.exits.find((e) => !e.builtin) ?? workspace.exits[0] ?? null;
    match = {
      id: randomUUID(),
      kind: 'rule',
      type: 'MATCH',
      payload: '',
      exitId: fallbackExit?.id ?? 'direct',
      origin: 'manual',
      enabled: true,
    };
  }
  const withoutMatch = workspace.routes.filter(
    (r) => !(r.kind === 'rule' && r.type === 'MATCH'),
  );
  workspace.routes = [...withoutMatch, match];
  return workspace;
}
