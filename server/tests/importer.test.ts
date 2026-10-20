import test from 'node:test';
import assert from 'node:assert/strict';
import type { Source } from '../../shared/types';
import { createDefaultWorkspace } from '../defaults';
import {
  applyParsedConfig,
  parseConfigText,
  parseRuleLine,
} from '../importer';
import { parseSubscriptionUserinfo } from '../fetcher';

const CONFIG = `proxies:
  - {name: "🇯🇵 日本 01", type: ss, server: a.example.com, port: 443, cipher: aes-256-gcm, password: secret}
  - {name: US-Home, type: ss, server: a.example.com, port: 443, cipher: aes-256-gcm, password: secret}
  - {name: SG, type: trojan, server: b.example.com, port: 443, password: p}
proxy-groups:
  - name: 家宽
    type: select
    proxies: [DIRECT, "🇯🇵 日本 01"]
rules:
  - DOMAIN-SUFFIX,example.com,家宽
  - RULE-SET,openai,家宽
  - MATCH,家宽
rule-providers:
  openai:
    type: http
    behavior: domain
    format: mrs
    url: https://example.com/geosite/openai.mrs
    interval: 86400
`;

test('parseConfigText reads proxies, groups, rules and providers', () => {
  const parsed = parseConfigText(CONFIG);
  assert.equal(parsed.proxies.length, 3);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0]?.name, '家宽');
  assert.equal(parsed.rules.length, 3);
  assert.equal(parsed.providers.openai?.behavior, 'domain');
  assert.equal(parsed.providers.openai?.format, 'mrs');
});

test('parseRuleLine handles MATCH and no-resolve', () => {
  const match = parseRuleLine('MATCH,自动选择');
  assert.equal(match?.type, 'MATCH');
  assert.equal(match?.target, '自动选择');
  const ip = parseRuleLine('IP-CIDR,10.0.0.0/8,家宽,no-resolve');
  assert.equal(ip?.type, 'IP-CIDR');
  assert.equal(ip?.payload, '10.0.0.0/8');
  assert.equal(ip?.target, '家宽');
  assert.equal(ip?.noResolve, true);
});

test('applyParsedConfig dedupes nodes and mirrors groups and rules', () => {
  const workspace = createDefaultWorkspace();
  const source: Source = {
    id: 'source-1',
    type: 'file',
    name: '测试来源',
    prefix: 'T-',
    keepRules: true,
  };
  workspace.sources.push(source);
  const parsed = parseConfigText(CONFIG);
  const result = applyParsedConfig({
    workspace,
    source,
    parsed,
    isRefresh: false,
    keepRules: true,
  });

  assert.equal(result.added, 2);
  assert.equal(result.deduped, 1);
  assert.equal(result.groups, 1);
  assert.equal(result.rules, 3);
  assert.equal(workspace.nodes.length, 2);
  assert.ok(workspace.nodes.every((node) => node.sourceId === 'source-1'));
  assert.equal(workspace.nodes.find((node) => node.name.includes('日本'))?.region, '日本');

  const importedExit = workspace.exits.find((exit) => exit.sourceId === 'source-1');
  assert.ok(importedExit);
  assert.equal(importedExit?.name, '家宽');
  const direct = workspace.exits.find((exit) => exit.name === 'DIRECT');
  assert.ok(importedExit?.members.some((member) => member.by === 'exit' && member.value === direct?.id));
  assert.ok(importedExit?.members.some((member) => member.by === 'node'));

  const match = workspace.routes.at(-1);
  assert.equal(match?.kind, 'rule');
  assert.equal(match?.type, 'MATCH');
  assert.equal(match?.exitId, importedExit?.id);
  assert.ok(workspace.routes.some((route) => route.kind === 'ruleset' && route.name === 'openai'));
  assert.ok(
    workspace.routes.some(
      (route) => route.kind === 'rule' && route.type === 'DOMAIN-SUFFIX' && route.payload === 'example.com',
    ),
  );
});

test('applyParsedConfig without keepRules only imports nodes', () => {
  const workspace = createDefaultWorkspace();
  const source: Source = {
    id: 'source-2',
    type: 'paste',
    name: '仅节点',
    prefix: '',
    keepRules: false,
  };
  workspace.sources.push(source);
  const result = applyParsedConfig({
    workspace,
    source,
    parsed: parseConfigText(CONFIG),
    isRefresh: false,
    keepRules: false,
  });
  assert.equal(result.added, 2);
  assert.equal(workspace.exits.filter((exit) => exit.sourceId === 'source-2').length, 0);
  assert.equal(workspace.routes.filter((route) => route.sourceId === 'source-2').length, 0);
});

test('applyParsedConfig refresh removes disappeared nodes', () => {
  const workspace = createDefaultWorkspace();
  const source: Source = {
    id: 'source-3',
    type: 'file',
    name: '可刷新',
    prefix: '',
    keepRules: true,
  };
  workspace.sources.push(source);
  applyParsedConfig({
    workspace,
    source,
    parsed: parseConfigText(CONFIG),
    isRefresh: false,
    keepRules: true,
  });
  const reduced = CONFIG.replace(
    '  - {name: SG, type: trojan, server: b.example.com, port: 443, password: p}\n',
    '',
  );
  const result = applyParsedConfig({
    workspace,
    source,
    parsed: parseConfigText(reduced),
    isRefresh: true,
    keepRules: true,
  });
  assert.equal(result.removed, 1);
  assert.equal(workspace.nodes.filter((node) => node.sourceId === 'source-3').length, 1);
});

test('subscription-userinfo is parsed', () => {
  const info = parseSubscriptionUserinfo('upload=100; download=200; total=1000; expire=1800000000');
  assert.deepEqual(info, { used: 300, total: 1000, expire: 1800000000 });
  assert.equal(parseSubscriptionUserinfo(undefined), undefined);
});

test('rules targeting a node are imported as node targets', () => {
  const workspace = createDefaultWorkspace();
  const source: Source = {
    id: 'source-node-target',
    type: 'paste',
    name: '节点直连',
    prefix: '',
    keepRules: true,
  };
  workspace.sources.push(source);
  const parsed = parseConfigText(`proxies:
  - {name: US-Home, type: ss, server: a.example.com, port: 443, cipher: aes-256-gcm, password: secret}
rules:
  - DOMAIN-SUFFIX,node.example.com,US-Home
  - MATCH,US-Home
`);
  const result = applyParsedConfig({
    workspace,
    source,
    parsed,
    isRefresh: false,
    keepRules: true,
  });
  assert.equal(result.rules, 2);
  const node = workspace.nodes.find((item) => item.name === 'US-Home');
  assert.ok(node);
  const rule = workspace.routes.find(
    (route) => route.kind === 'rule' && route.type === 'DOMAIN-SUFFIX' && route.payload === 'node.example.com',
  );
  assert.equal(rule?.exitId, '');
  assert.equal(rule?.kind === 'rule' ? rule.targetNodeId : undefined, node?.id);
  const match = workspace.routes.find((route) => route.kind === 'rule' && route.type === 'MATCH');
  assert.equal(match?.kind === 'rule' ? match.targetNodeId : undefined, node?.id);
});
