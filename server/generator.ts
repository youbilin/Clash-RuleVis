import fs from 'node:fs';
import { stringify } from 'yaml';
import type {
  ConfigIssue,
  EdgeRuleType,
  Exit,
  ExportCounts,
  ProxyNode,
  Route,
  RuleRoute,
  RuleSetRoute,
  RuleType,
  Workspace,
} from '../shared/types';
import {
  findCoveringRoute,
  findDuplicateRoute,
  isIPv4,
  isIPv6,
  nodeDisplayName,
  providerSlug,
  resolveExit,
} from '../shared/model';

const RESERVED_NAMES = new Set(['DIRECT', 'REJECT', 'GLOBAL', 'PASS', 'COMPATIBLE', 'REJECT-DROP']);
const GROUP_TYPES = new Set(['select', 'url-test', 'fallback', 'load-balance']);
const SUPPORTED_RULE_TYPES = new Set<string>([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'GEOSITE',
  'GEOIP',
  'DST-PORT',
  'MATCH',
]);

export interface GeneratedConfig {
  yaml: string;
  issues: ConfigIssue[];
  counts: ExportCounts;
}

function hasControlChars(value: string): boolean {
  return /[\r\n]/.test(value);
}

function validateIpCidr(payload: string): boolean {
  const [ip, bitsRaw] = payload.split('/');
  const bits = Number(bitsRaw);
  if (!ip || !Number.isInteger(bits)) return false;
  if (isIPv4(ip)) return bits >= 0 && bits <= 32;
  if (isIPv6(ip)) return bits >= 0 && bits <= 128;
  return false;
}

function proxyObject(node: ProxyNode, name: string): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(node.raw)) as Record<string, unknown>;
  raw.name = name;
  return raw;
}

function providerExtension(format: string): string {
  if (format === 'mrs') return 'mrs';
  if (format === 'yaml') return 'yaml';
  return 'txt';
}

export interface GenerateOptions {
  baseSettings?: Record<string, unknown>;
}

export function generateConfig(workspace: Workspace, options: GenerateOptions = {}): GeneratedConfig {
  const issues: ConfigIssue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (
    severity: 'error' | 'warning',
    code: string,
    message: string,
    extra: { routeId?: string; exitId?: string } = {},
  ) => {
    const key = `${severity}|${code}|${message}|${extra.routeId ?? ''}|${extra.exitId ?? ''}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ severity, code, message, ...extra });
  };

  const sourcesById = new Map(workspace.sources.map((s) => [s.id, s]));
  const exits = [...workspace.exits].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const exitsById = new Map(exits.map((e) => [e.id, e]));
  const enabledNodes = workspace.nodes.filter((n) => n.enabled);
  const ctx = { nodes: workspace.nodes, exits, sources: workspace.sources };

  const nodeNameById = new Map<string, string>();
  const usedNames = new Map<string, string>();
  for (const node of enabledNodes) {
    const name = nodeDisplayName(node, sourcesById.get(node.sourceId));
    nodeNameById.set(node.id, name);
    if (!name.trim()) {
      addIssue('error', 'empty-node-name', `节点「${node.id}」没有名称`);
      continue;
    }
    if (hasControlChars(name) || name.includes(',')) {
      addIssue('error', 'invalid-node-name', `节点名「${name}」包含换行或逗号，无法写入规则/配置`);
    }
    if (RESERVED_NAMES.has(name.toUpperCase())) {
      addIssue('error', 'reserved-node-name', `节点名「${name}」与内置出站冲突`);
    }
    const lower = name.toLowerCase();
    const duplicated = usedNames.get(lower);
    if (duplicated) {
      addIssue('error', 'duplicate-node-name', `节点导出名重复：「${name}」`);
    } else {
      usedNames.set(lower, name);
    }
  }

  for (const node of enabledNodes) {
    if (!node.chain) continue;
    const label = nodeNameById.get(node.id) ?? node.name;
    const relay = workspace.nodes.find((item) => item.id === node.chain!.relayNodeId);
    if (!relay) {
      addIssue('error', 'chain-relay-missing', `链式节点「${label}」的中转节点已不存在`);
    } else if (!relay.enabled) {
      addIssue('error', 'chain-relay-disabled', `链式节点「${label}」的中转节点「${relay.name}」已禁用`);
    }
  }

  const groupNameByLower = new Map<string, Exit>();
  const activeExits = exits.filter((exit) => !exit.builtin);
  for (const exit of activeExits) {
    if (!GROUP_TYPES.has(exit.type)) {
      addIssue('error', 'invalid-exit-type', `出口「${exit.name}」的类型不受支持`, { exitId: exit.id });
    }
    if (!exit.name.trim() || hasControlChars(exit.name) || exit.name.includes(',')) {
      addIssue('error', 'invalid-exit-name', `出口名「${exit.name}」包含换行、逗号或为空`, { exitId: exit.id });
    }
    if (RESERVED_NAMES.has(exit.name.toUpperCase())) {
      addIssue('error', 'reserved-exit-name', `出口名「${exit.name}」与内置出站冲突`, { exitId: exit.id });
    }
    const lower = exit.name.toLowerCase();
    if (groupNameByLower.has(lower)) {
      addIssue('error', 'duplicate-exit-name', `出口名称重复：「${exit.name}」`, { exitId: exit.id });
    } else {
      groupNameByLower.set(lower, exit);
    }
    if (usedNames.has(lower)) {
      addIssue('error', 'exit-node-collision', `出口「${exit.name}」与节点重名，内核会拒绝该配置`, { exitId: exit.id });
    }
    const resolution = resolveExit(exit, ctx);
    if (resolution.memberNames.length === 0) {
      addIssue('error', 'empty-exit', `出口「${exit.name}」没有可用成员`, { exitId: exit.id });
    }
    for (const missing of resolution.missing) {
      addIssue(
        'error',
        'missing-member',
        `出口「${exit.name}」：${missing.reason}（${missing.value}）`,
        { exitId: exit.id },
      );
    }
    for (const memberName of resolution.memberNames) {
      if (hasControlChars(memberName) || memberName.includes(',')) {
        addIssue('error', 'invalid-member-name', `出口「${exit.name}」的成员名包含换行或逗号`, { exitId: exit.id });
      }
    }
  }

  const proxies = enabledNodes.map((node) => proxyObject(node, nodeNameById.get(node.id) ?? node.name));

  const groups: Record<string, unknown>[] = [];
  for (const exit of activeExits) {
    const resolution = resolveExit(exit, ctx);
    const group: Record<string, unknown> = {
      name: exit.name,
      type: exit.type,
      proxies: resolution.memberNames,
    };
    if (exit.type !== 'select') {
      group.url = exit.testUrl || workspace.settings.testUrl;
      group.interval = exit.interval ?? 300;
      if (exit.type === 'url-test') group.tolerance = exit.tolerance ?? 50;
    }
    groups.push(group);
  }

  const providerKeys = new Set<string>();
  const providerKeyFor = (route: RuleSetRoute, used: Set<string>): string => {
    let base = providerSlug(route.providerName || route.name);
    if (base === 'ruleset') base = `ruleset-${route.id.slice(0, 4)}`;
    let key = base;
    let index = 2;
    while (used.has(key)) {
      key = `${base}-${index}`;
      index += 1;
    }
    used.add(key);
    return key;
  };

  const providers: Record<string, Record<string, unknown>> = {};
  const ruleLines: string[] = [];

  const targetName = (route: Route, label: string): string | null => {
    if (route.kind === 'rule' && route.targetNodeId) {
      const node = workspace.nodes.find((item) => item.id === route.targetNodeId);
      if (!node) {
        addIssue('error', 'missing-node', `${label}指向的节点已不存在`, { routeId: route.id });
        return null;
      }
      if (!node.enabled) {
        addIssue('error', 'disabled-node', `${label}指向的节点已禁用`, { routeId: route.id });
        return null;
      }
      return nodeNameById.get(node.id) ?? nodeDisplayName(node, sourcesById.get(node.sourceId));
    }
    const exit = exitsById.get(route.exitId);
    if (!exit) {
      addIssue('error', 'missing-exit', `${label}指向的出口已不存在`, { routeId: route.id });
      return null;
    }
    if (!exit.builtin && !activeExits.some((e) => e.id === exit.id)) {
      addIssue('error', 'missing-exit', `${label}指向的出口已不存在`, { routeId: route.id });
      return null;
    }
    return exit.name;
  };

  const matchRoute = workspace.routes.find(
    (route): route is RuleRoute => route.kind === 'rule' && route.type === 'MATCH',
  );
  const duplicates = new Set<string>();

  for (let index = 0; index < workspace.routes.length; index++) {
    const route = workspace.routes[index];
    if (!route.enabled) continue;
    if (route.kind === 'rule' && route.type === 'MATCH') continue;

    const target = targetName(route, route.kind === 'rule' ? '规则' : '规则集');

    if (route.kind === 'rule') {
      if (!SUPPORTED_RULE_TYPES.has(route.type) || route.type === 'MATCH') {
        addIssue('error', 'unsupported-rule', `不支持的规则类型：${route.type}`, { routeId: route.id });
        continue;
      }
      if (route.type === 'RULE-SET') {
        addIssue(
          'error',
          'manual-ruleset',
          'RULE-SET 规则需要通过「规则集」页面创建，才能生成对应的 provider',
          { routeId: route.id },
        );
        continue;
      }
      if (!route.payload.trim()) {
        addIssue('error', 'empty-rule-payload', `规则 ${route.type} 的内容为空`, { routeId: route.id });
        continue;
      }
      if (hasControlChars(route.payload) || route.payload.includes(',')) {
        addIssue('error', 'invalid-rule-payload', `规则内容包含换行或逗号：${route.payload}`, { routeId: route.id });
        continue;
      }
      if ((route.type === 'IP-CIDR' || route.type === 'IP-CIDR6') && !validateIpCidr(route.payload)) {
        addIssue('error', 'invalid-cidr', `IP 规则格式无效：${route.payload}`, { routeId: route.id });
        continue;
      }
      const cover = findCoveringRoute(workspace.routes, index);
      if (cover) {
        addIssue(
          'warning',
          'shadowed-rule',
          `第 ${index + 1} 条规则「${route.type},${route.payload}」被第 ${cover.index + 1} 条完全覆盖`,
          { routeId: route.id },
        );
      }
      const duplicateIndex = findDuplicateRoute(workspace.routes, route, route.id);
      if (duplicateIndex >= 0 && !duplicates.has(route.id)) {
        duplicates.add(route.id);
        addIssue(
          'warning',
          'duplicate-rule',
          `第 ${index + 1} 条规则与第 ${duplicateIndex + 1} 条重复（${route.type},${route.payload}）`,
          { routeId: route.id },
        );
      }
      if (!target) continue;
      const suffix = route.noResolve ? ',no-resolve' : '';
      ruleLines.push(`${route.type},${route.payload},${target}${suffix}`);
      continue;
    }

    if (!target) continue;
    if (route.inline) {
      const inlineRules = route.inlineRules ?? [];
      if (!inlineRules.length) {
        addIssue(
          'error',
          'empty-inline-ruleset',
          `规则集「${route.name}」已设为内联，但没有展开内容，请刷新规则集`,
          { routeId: route.id },
        );
        continue;
      }
      for (const rule of inlineRules) {
        if (!SUPPORTED_RULE_TYPES.has(rule.type)) {
          addIssue('error', 'unsupported-inline-rule', `规则集「${route.name}」包含不支持的规则类型 ${rule.type}`, {
            routeId: route.id,
          });
          continue;
        }
        if ((rule.type === 'IP-CIDR' || rule.type === 'IP-CIDR6') && !validateIpCidr(rule.payload)) {
          addIssue('error', 'invalid-cidr', `规则集「${route.name}」包含无效 IP 规则：${rule.payload}`, {
            routeId: route.id,
          });
          continue;
        }
        const suffix = rule.noResolve ? ',no-resolve' : '';
        ruleLines.push(`${rule.type},${rule.payload},${target}${suffix}`);
      }
      continue;
    }

    if (route.format === 'mrs' && route.behavior === 'classical') {
      addIssue('warning', 'mrs-classical', `规则集「${route.name}」使用 MRS 与 classical，内核可能不支持`, {
        routeId: route.id,
      });
    }
    if (route.source.type === 'file' && !fs.existsSync(route.source.value)) {
      addIssue('error', 'missing-ruleset-file', `规则集文件不存在：${route.source.fileName ?? route.source.value}`, {
        routeId: route.id,
      });
      continue;
    }
    if (route.source.type === 'url' && !/^https?:\/\//i.test(route.source.value)) {
      addIssue('error', 'invalid-ruleset-url', `规则集「${route.name}」的来源地址无效`, { routeId: route.id });
      continue;
    }
    const key = providerKeyFor(route, providerKeys);
    const behavior = route.behavior;
    const format = route.format;
    const provider: Record<string, unknown> = {
      type: route.source.type === 'url' ? 'http' : 'file',
      behavior,
      format,
    };
    if (route.source.type === 'url') {
      provider.url = route.source.value;
      provider.path = `./rule-sets/${key}.${providerExtension(format)}`;
      provider.interval = route.interval ?? 86400;
    } else {
      provider.path = route.source.value.replace(/\\/g, '/');
    }
    providers[key] = provider;
    const suffix = route.noResolve ? ',no-resolve' : '';
    ruleLines.push(`RULE-SET,${key},${target}${suffix}`);
  }

  if (!matchRoute) {
    addIssue('warning', 'missing-match', '工作区没有 MATCH 兜底规则，未匹配流量将使用内核默认行为');
  } else {
    const target = targetName(matchRoute, 'MATCH 规则');
    if (target) ruleLines.push(`MATCH,${target}`);
  }

  if (!enabledNodes.length) {
    addIssue('warning', 'no-nodes', '当前没有启用节点，导出的配置不包含 proxies');
  }

  const doc: Record<string, unknown> = { ...(options.baseSettings ?? {}) };
  for (const key of ['proxies', 'proxy-groups', 'rule-providers', 'rules']) delete doc[key];
  if (proxies.length) doc.proxies = proxies;
  if (groups.length) doc['proxy-groups'] = groups;
  if (Object.keys(providers).length) doc['rule-providers'] = providers;
  doc.rules = ruleLines;

  const yamlBody = stringify(doc, { lineWidth: 0, indent: 2, sortMapEntries: false });
  const hasBase = Boolean(options.baseSettings && Object.keys(options.baseSettings).length);
  const baseNote = hasBase
    ? '基础设置来自 Clash Verge 当前配置（不含控制器与密钥）'
    : '仅包含节点、出口、规则集与规则，不含端口 / DNS / TUN';
  const yaml = `# Generated by Clash RuleVis\n# ${baseNote}\n${yamlBody}`;

  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));

  return {
    yaml,
    issues,
    counts: {
      nodes: proxies.length,
      exits: groups.length,
      providers: Object.keys(providers).length,
      rules: ruleLines.length,
    },
  };
}

export function enabledRuleTypes(): RuleType[] {
  return [
    'DOMAIN',
    'DOMAIN-SUFFIX',
    'DOMAIN-KEYWORD',
    'IP-CIDR',
    'IP-CIDR6',
    'PROCESS-NAME',
    'PROCESS-PATH',
    'GEOSITE',
    'GEOIP',
    'DST-PORT',
    'MATCH',
  ];
}

export function ruleTypeLabel(type: EdgeRuleType | RuleType): string {
  const labels: Record<string, string> = {
    DOMAIN: '精确域名',
    'DOMAIN-SUFFIX': '域名后缀',
    'DOMAIN-KEYWORD': '域名关键字',
    'IP-CIDR': 'IPv4 网段',
    'IP-CIDR6': 'IPv6 网段',
    'PROCESS-NAME': '进程名',
    'PROCESS-PATH': '进程路径',
    GEOSITE: 'GeoSite',
    GEOIP: 'GeoIP',
    'RULE-SET': '规则集',
    'DST-PORT': '目标端口',
    MATCH: '兜底',
  };
  return labels[type] ?? type;
}
