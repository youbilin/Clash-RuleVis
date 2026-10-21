import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import type { Exit, ProxyNode, RuleRoute, RuleSetRoute, Source, Workspace } from '../../shared/types';
import { createDefaultWorkspace, ensureWorkspaceShape } from '../defaults';
import { generateConfig, ruleTypeLabel } from '../generator';
import { extractBaseSettings } from '../base-template';

const NOW = '2026-10-20T00:00:00.000Z';

function makeWorkspace(overrides: {
  nodeMembers?: Exit['members'];
  rules?: Array<RuleRoute | RuleSetRoute>;
  inlineRules?: RuleSetRoute['inlineRules'];
} = {}): Workspace {
  const workspace = createDefaultWorkspace();
  const source: Source = {
    id: 's1',
    type: 'file',
    name: 'Test',
    prefix: 'T-',
    keepRules: false,
    updatedAt: NOW,
  };
  const node = (id: string, name: string): ProxyNode => ({
    id,
    sourceId: 's1',
    name,
    raw: { name, type: 'ss', server: 'a.example.com', port: 443, cipher: 'aes-256-gcm', password: 'secret' },
    region: '日本',
    tags: ['家宽'],
    enabled: true,
    addedAt: NOW,
  });
  const home: Exit = {
    id: 'home',
    name: '家宽',
    type: 'select',
    members: overrides.nodeMembers ?? [{ by: 'tag', value: '家宽' }],
    order: 0,
  };
  const auto: Exit = {
    id: 'auto',
    name: '自动选择',
    type: 'url-test',
    members: [{ by: 'regex', value: '.*' }],
    order: 1,
    interval: 300,
    tolerance: 50,
  };
  const ruleset: RuleSetRoute = {
    id: 'rs1',
    kind: 'ruleset',
    name: 'openai',
    behavior: 'domain',
    format: 'mrs',
    source: { type: 'url', value: 'https://example.com/geosite/openai.mrs' },
    inline: Boolean(overrides.inlineRules),
    inlineRules: overrides.inlineRules,
    ruleCount: 9,
    exitId: 'auto',
    enabled: true,
    interval: 86400,
  };
  const customRule: RuleRoute = {
    id: 'r1',
    kind: 'rule',
    type: 'DOMAIN-SUFFIX',
    payload: 'example.com',
    exitId: 'home',
    origin: 'manual',
    enabled: true,
  };
  const match: RuleRoute = {
    id: 'match',
    kind: 'rule',
    type: 'MATCH',
    payload: '',
    exitId: 'auto',
    origin: 'manual',
    enabled: true,
  };
  workspace.sources = [source];
  workspace.nodes = [node('n1', '日本 01'), node('n2', '日本 02')];
  workspace.exits = [
    ...workspace.exits.filter((exit) => exit.builtin),
    home,
    auto,
  ];
  workspace.routes = overrides.rules ?? [customRule, ruleset, match];
  return workspace;
}

test('generator statically expands members and writes valid YAML', () => {
  const generated = generateConfig(makeWorkspace());
  assert.equal(generated.issues.filter((issue) => issue.severity === 'error').length, 0);
  const doc = parseYaml(generated.yaml) as {
    proxies: Array<Record<string, unknown>>;
    'proxy-groups': Array<Record<string, unknown>>;
    'rule-providers': Record<string, Record<string, unknown>>;
    rules: string[];
  };
  assert.deepEqual(doc.proxies.map((proxy) => proxy.name), ['T-日本 01', 'T-日本 02']);
  const home = doc['proxy-groups'].find((group) => group.name === '家宽');
  assert.deepEqual(home?.proxies, ['T-日本 01', 'T-日本 02']);
  const auto = doc['proxy-groups'].find((group) => group.name === '自动选择');
  assert.equal(auto?.type, 'url-test');
  assert.equal(auto?.url, 'https://www.gstatic.com/generate_204');
  assert.equal(auto?.tolerance, 50);
  const provider = doc['rule-providers'].openai;
  assert.equal(provider?.type, 'http');
  assert.equal(provider?.format, 'mrs');
  assert.equal(provider?.path, './rule-sets/openai.mrs');
  assert.ok(doc.rules.includes('DOMAIN-SUFFIX,example.com,家宽'));
  assert.ok(doc.rules.includes('RULE-SET,openai,自动选择'));
  assert.equal(doc.rules.at(-1), 'MATCH,自动选择');
  assert.deepEqual(generated.counts, { nodes: 2, exits: 2, providers: 1, rules: 3 });
});

test('empty exits and missing members block export', () => {
  const generated = generateConfig(makeWorkspace({ nodeMembers: [] }));
  assert.ok(generated.issues.some((issue) => issue.code === 'empty-exit' && issue.severity === 'error'));

  const missing = generateConfig(
    makeWorkspace({ nodeMembers: [{ by: 'node', value: 'missing-node' }] }),
  );
  assert.ok(missing.issues.some((issue) => issue.code === 'missing-member'));
  assert.ok(missing.issues.some((issue) => issue.code === 'empty-exit'));
});

test('inline rulesets expand into ordinary rules', () => {
  const generated = generateConfig(
    makeWorkspace({
      inlineRules: [{ type: 'DOMAIN-SUFFIX', payload: 'openai.com' }],
    }),
  );
  const doc = parseYaml(generated.yaml) as { rules: string[]; 'rule-providers'?: unknown };
  assert.equal(doc['rule-providers'], undefined);
  assert.ok(doc.rules.includes('DOMAIN-SUFFIX,openai.com,自动选择'));
  assert.deepEqual(generated.counts, { nodes: 2, exits: 2, providers: 0, rules: 3 });
});

test('nested exit cycles are reported', () => {
  const workspace = makeWorkspace();
  const a: Exit = { id: 'a', name: 'A', type: 'select', members: [{ by: 'exit', value: 'b' }], order: 2 };
  const b: Exit = { id: 'b', name: 'B', type: 'select', members: [{ by: 'exit', value: 'a' }], order: 3 };
  workspace.exits.push(a, b);
  const generated = generateConfig(workspace);
  assert.ok(generated.issues.some((issue) => issue.message.includes('形成环')));
});

test('shadowed rules produce a warning but not an error', () => {
  const workspace = makeWorkspace();
  const late: RuleRoute = {
    id: 'r2',
    kind: 'rule',
    type: 'DOMAIN',
    payload: 'www.example.com',
    exitId: 'home',
    origin: 'manual',
    enabled: true,
  };
  const match = workspace.routes.at(-1);
  workspace.routes = [workspace.routes[0]!, late, ...(match ? [match] : []), workspace.routes[1]!];
  const generated = generateConfig(workspace);
  assert.ok(generated.issues.some((issue) => issue.code === 'shadowed-rule' && issue.severity === 'warning'));
  assert.equal(generated.issues.filter((issue) => issue.severity === 'error').length, 0);
});

test('rule type labels are localized', () => {
  assert.equal(ruleTypeLabel('DOMAIN-SUFFIX'), '域名后缀');
  assert.equal(ruleTypeLabel('MATCH'), '兜底');
});

test('base template only extracts network settings and never controller secrets', () => {
  const { values, keys } = extractBaseSettings({
    'mixed-port': 7897,
    'external-controller': '127.0.0.1:9090',
    secret: 'top-secret',
    tun: { enable: true },
    dns: { enable: true },
    proxies: [{ name: 'leak' }],
    rules: ['MATCH,DIRECT'],
  });
  assert.ok(keys.includes('mixed-port'));
  assert.ok(keys.includes('tun'));
  assert.ok(keys.includes('dns'));
  assert.equal('secret' in values, false);
  assert.equal('external-controller' in values, false);
  assert.equal('proxies' in values, false);
  assert.equal('rules' in values, false);
});

test('generator merges base settings but keeps its own sections', () => {
  const generated = generateConfig(makeWorkspace(), {
    baseSettings: {
      'mixed-port': 17897,
      'allow-lan': false,
      tun: { enable: true, stack: 'gvisor' },
      proxies: [{ name: 'stale' }],
      rules: ['MATCH,STALE'],
    },
  });
  const doc = parseYaml(generated.yaml) as {
    'mixed-port': number;
    tun: { enable: boolean };
    proxies: Array<{ name: string }>;
    rules: string[];
  };
  assert.equal(doc['mixed-port'], 17897);
  assert.equal(doc.tun.enable, true);
  assert.deepEqual(doc.proxies.map((proxy) => proxy.name), ['T-日本 01', 'T-日本 02']);
  assert.equal(doc.rules.at(-1), 'MATCH,自动选择');
  assert.ok(!doc.rules.includes('MATCH,STALE'));
});

test('chain nodes export as independent proxies with dialer-proxy', () => {
  const workspace = makeWorkspace();
  const chainSource: Source = {
    id: 'chain-source',
    type: 'chain',
    name: '链式代理',
    prefix: '',
    keepRules: false,
    updatedAt: NOW,
  };
  const chainNode: ProxyNode = {
    id: 'chain-node',
    sourceId: chainSource.id,
    name: '日本中转 · 日本落地',
    raw: {
      ...workspace.nodes[1]!.raw,
      name: '日本中转 · 日本落地',
      'dialer-proxy': 'T-日本 01',
    },
    tags: ['链式'],
    enabled: true,
    addedAt: NOW,
    chain: { relayNodeId: 'n1', landingNodeId: 'n2' },
  };
  workspace.sources.push(chainSource);
  workspace.nodes.push(chainNode);
  const generated = generateConfig(workspace);
  assert.equal(generated.issues.filter((issue) => issue.severity === 'error').length, 0);
  const doc = parseYaml(generated.yaml) as { proxies: Array<Record<string, unknown>> };
  const chainProxy = doc.proxies.find((proxy) => proxy.name === '日本中转 · 日本落地');
  assert.equal(chainProxy?.['dialer-proxy'], 'T-日本 01');
  assert.equal(chainProxy?.server, 'a.example.com');
  assert.equal(chainProxy?.type, 'ss');

  workspace.sources[0]!.prefix = 'X-';
  ensureWorkspaceShape(workspace);
  assert.equal(chainNode.raw['dialer-proxy'], 'X-日本 01');
});

test('manual link sources are split into one source per node', () => {
  const workspace = makeWorkspace();
  workspace.sources.push(
    { id: 'm1', type: 'manual', name: '节点链接', prefix: '', keepRules: true },
    { id: 'empty-manual', type: 'manual', name: '空来源', prefix: '', keepRules: false },
  );
  workspace.nodes.push(
    {
      id: 'mn1',
      sourceId: 'm1',
      name: 'Relay-A',
      raw: { name: 'Relay-A', type: 'ss', server: 'relay.example.com', port: 8388 },
      tags: [],
      enabled: true,
      addedAt: NOW,
    },
    {
      id: 'mn2',
      sourceId: 'm1',
      name: 'Landing-B',
      raw: { name: 'Landing-B', type: 'ss', server: 'landing.example.com', port: 8389 },
      tags: [],
      enabled: true,
      addedAt: NOW,
    },
  );
  ensureWorkspaceShape(workspace);
  const manualSources = workspace.sources.filter((source) => source.type === 'manual');
  assert.equal(manualSources.length, 2);
  assert.deepEqual(manualSources.map((source) => source.name).sort(), ['Landing-B', 'Relay-A']);
  assert.ok(manualSources.every((source) => source.note === 'manual-link'));
  assert.ok(!workspace.sources.some((source) => source.id === 'empty-manual'));
  const manualNodes = workspace.nodes.filter((node) => node.id === 'mn1' || node.id === 'mn2');
  assert.equal(new Set(manualNodes.map((node) => node.sourceId)).size, 2);
  assert.ok(manualNodes.every((node) => manualSources.some((source) => source.id === node.sourceId)));
});

test('disabling a node prunes its direct exit membership', () => {
  const workspace = makeWorkspace();
  const home = workspace.exits.find((exit) => exit.name === '家宽')!;
  home.members = [
    { by: 'node', value: 'n1' },
    { by: 'node', value: 'n2' },
    { by: 'node', value: 'missing-node' },
  ];
  workspace.nodes[0]!.enabled = false;
  ensureWorkspaceShape(workspace);
  assert.deepEqual(home.members, [{ by: 'node', value: 'n2' }]);
  const generated = generateConfig(workspace);
  assert.equal(
    generated.issues.filter(
      (issue) =>
        issue.severity === 'error' &&
        (issue.code === 'missing-member' || issue.code === 'empty-exit'),
    ).length,
    0,
  );
});

test('chain nodes with missing relays block export', () => {
  const workspace = makeWorkspace();
  workspace.sources.push({
    id: 'chain-source',
    type: 'chain',
    name: '链式代理',
    prefix: '',
    keepRules: false,
  });
  workspace.nodes.push({
    id: 'chain-node',
    sourceId: 'chain-source',
    name: '失效链路',
    raw: { ...workspace.nodes[0]!.raw, 'dialer-proxy': 'T-日本 01' },
    tags: ['链式'],
    enabled: true,
    addedAt: NOW,
    chain: { relayNodeId: 'missing', landingNodeId: 'n2' },
  });
  const generated = generateConfig(workspace);
  assert.ok(generated.issues.some((issue) => issue.code === 'chain-relay-missing' && issue.severity === 'error'));
});

test('generated YAML never contains subscription URLs', () => {
  const workspace = makeWorkspace();
  workspace.sources[0] = {
    ...workspace.sources[0]!,
    type: 'subscription',
    url: 'https://secret-provider.example.com/sub?token=top-secret',
  };
  const generated = generateConfig(workspace);
  assert.ok(!generated.yaml.includes('secret-provider.example.com'));
  assert.ok(!generated.yaml.includes('top-secret'));
});

test('rules can target a single node directly', () => {
  const workspace = makeWorkspace();
  workspace.routes = [
    {
      id: 'node-rule',
      kind: 'rule',
      type: 'DOMAIN-SUFFIX',
      payload: 'example.com',
      exitId: '',
      targetNodeId: 'n1',
      origin: 'manual',
      enabled: true,
    },
    workspace.routes.find((route) => route.kind === 'rule' && route.type === 'MATCH')!,
  ];
  const generated = generateConfig(workspace);
  assert.equal(generated.issues.filter((issue) => issue.severity === 'error').length, 0);
  const doc = parseYaml(generated.yaml) as { rules: string[] };
  assert.ok(doc.rules.includes('DOMAIN-SUFFIX,example.com,T-日本 01'));
});

test('missing or disabled node targets block export', () => {
  const workspace = makeWorkspace();
  const match = workspace.routes.find((route) => route.kind === 'rule' && route.type === 'MATCH')!;
  workspace.routes = [
    {
      id: 'node-rule',
      kind: 'rule',
      type: 'DOMAIN-SUFFIX',
      payload: 'example.com',
      exitId: '',
      targetNodeId: 'missing',
      origin: 'manual',
      enabled: true,
    },
    match,
  ];
  const missing = generateConfig(workspace);
  assert.ok(missing.issues.some((issue) => issue.code === 'missing-node'));

  workspace.routes[0] = { ...workspace.routes[0], targetNodeId: 'n1' } as RuleRoute;
  workspace.nodes = workspace.nodes.map((node) => ({ ...node, enabled: false }));
  const disabled = generateConfig(workspace);
  assert.ok(disabled.issues.some((issue) => issue.code === 'disabled-node'));
});
