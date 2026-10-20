import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type {
  EdgeRuleType,
  ExitMember,
  ExitType,
  ProxyNode,
  RuleRoute,
  RuleSetRoute,
  RulesetBehavior,
  RulesetFormat,
  Source,
  Workspace,
} from '../shared/types';
import { detectRegion } from '../shared/regions';
import { nodeDisplayName } from '../shared/model';

export interface ParsedGroup {
  name: string;
  type: ExitType;
  proxies: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
}

export interface ParsedProvider {
  name: string;
  url?: string;
  path?: string;
  behavior?: RulesetBehavior;
  format?: RulesetFormat;
  interval?: number;
  type?: string;
}

export interface ParsedConfig {
  proxies: Record<string, unknown>[];
  groups: ParsedGroup[];
  rules: string[];
  providers: Record<string, ParsedProvider>;
  warnings: string[];
}

export interface ApplyOptions {
  workspace: Workspace;
  source: Source;
  parsed: ParsedConfig;
  isRefresh: boolean;
  keepRules: boolean;
}

export interface ApplyResult {
  added: number;
  removed: number;
  changed: number;
  deduped: number;
  groups: number;
  rules: number;
  skippedRules: number;
  warnings: string[];
}

const EXIT_TYPES = new Set<string>(['select', 'url-test', 'fallback', 'load-balance']);
const RULE_TYPES = new Set<string>([
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
]);

function maybeDecodeBase64(text: string): string {
  const compact = text.trim();
  if (compact.length < 20 || /[:{}[\]]/.test(compact)) return text;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(compact)) return text;
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    if (/proxies\s*:/.test(decoded)) return decoded;
  } catch {
    // 不是 base64，继续按原文解析
  }
  return text;
}

function normalizeFormat(value: unknown, hint = ''): RulesetFormat {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'mrs') return 'mrs';
  if (raw === 'yaml' || raw === 'yml') return 'yaml';
  if (raw === 'text') return 'text';
  if (/\.mrs(?:$|\?)/i.test(hint)) return 'mrs';
  if (/\.ya?ml(?:$|\?)/i.test(hint)) return 'yaml';
  return 'text';
}

function normalizeBehavior(value: unknown, hint = ''): RulesetBehavior {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'domain' || raw === 'ipcidr' || raw === 'classical') return raw;
  if (/ip|geoip/i.test(hint)) return 'ipcidr';
  return 'domain';
}

export function parseConfigText(input: string): ParsedConfig {
  const warnings: string[] = [];
  const text = maybeDecodeBase64(input).replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new Error(`YAML 解析失败：${(error as Error).message.split('\n')[0]}`);
  }

  let rawProxies: unknown[] = [];
  let rawGroups: unknown[] = [];
  let rawRules: unknown[] = [];
  let rawProviders: Record<string, unknown> = {};

  if (Array.isArray(parsed)) {
    rawProxies = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.proxies)) rawProxies = obj.proxies;
    if (Array.isArray(obj['proxy-groups'])) rawGroups = obj['proxy-groups'];
    if (Array.isArray(obj.rules)) rawRules = obj.rules;
    if (obj['rule-providers'] && typeof obj['rule-providers'] === 'object') {
      rawProviders = obj['rule-providers'] as Record<string, unknown>;
    }
    if (!rawProxies.length && obj['proxy-providers']) {
      throw new Error('这是 proxy-providers 直通配置，请在订阅设置中使用静态导入');
    }
  }

  if (!rawProxies.length) {
    throw new Error('没有找到可导入的 proxies，请检查订阅内容或文件格式');
  }

  const proxies: Record<string, unknown>[] = [];
  for (const item of rawProxies) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name.trim()) continue;
    if (typeof record.type !== 'string' || !record.type.trim()) continue;
    if (!('server' in record) || !('port' in record)) continue;
    proxies.push(record);
  }
  if (!proxies.length) throw new Error('proxies 中没有有效的节点定义');
  if (proxies.length < rawProxies.length) {
    warnings.push(`忽略了 ${rawProxies.length - proxies.length} 个缺少名称、类型或地址的节点`);
  }

  const groups: ParsedGroup[] = [];
  for (const item of rawGroups) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (!name || !EXIT_TYPES.has(type)) continue;
    const members = Array.isArray(record.proxies)
      ? record.proxies.filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
      : [];
    groups.push({
      name,
      type: type as ExitType,
      proxies: members,
      url: typeof record.url === 'string' ? record.url : undefined,
      interval: typeof record.interval === 'number' ? record.interval : undefined,
      tolerance: typeof record.tolerance === 'number' ? record.tolerance : undefined,
    });
  }

  const rules = rawRules
    .filter((v): v is string => typeof v === 'string')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));

  const providers: Record<string, ParsedProvider> = {};
  for (const [name, value] of Object.entries(rawProviders)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url : undefined;
    const localPath = typeof record.path === 'string' && record.type === 'file' ? record.path : undefined;
    providers[name] = {
      name,
      url,
      path: localPath,
      behavior: normalizeBehavior(record.behavior, name),
      format: normalizeFormat(record.format, url || localPath || ''),
      interval: typeof record.interval === 'number' ? record.interval : undefined,
      type: typeof record.type === 'string' ? record.type : undefined,
    };
  }

  return { proxies, groups, rules, providers, warnings };
}

export function dedupeKey(raw: Record<string, unknown>): string {
  const fields = [
    'type',
    'server',
    'port',
    'uuid',
    'password',
    'private-key',
    'psk',
    'auth',
    'cipher',
    'username',
  ];
  const parts = fields.map((field) => {
    const value = raw[field];
    return typeof value === 'string' || typeof value === 'number'
      ? String(value).trim().toLowerCase()
      : '';
  });
  const key = parts.join('|');
  return key === '|||||||||' ? `name:${String(raw.name ?? '')}` : key;
}

export interface ParsedRuleLine {
  type: string;
  payload: string;
  target: string;
  noResolve: boolean;
}

export function parseRuleLine(line: string): ParsedRuleLine | null {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 2) return null;
  const type = parts[0].toUpperCase();
  const noResolve = parts.slice(2).some((p) => p.toLowerCase() === 'no-resolve');
  if (type === 'MATCH') {
    const target = parts[1];
    if (!target) return null;
    return { type, payload: '', target, noResolve: false };
  }
  const payload = parts[1];
  const target = parts[2];
  if (!payload || !target || target === 'no-resolve') return null;
  return { type, payload, target, noResolve };
}

function sourceMapFor(workspace: Workspace): Map<string, Source> {
  return new Map(workspace.sources.map((s) => [s.id, s]));
}

function uniqueBaseName(base: string, prefix: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (used.has(`${prefix}${candidate}`.toLowerCase())) {
    candidate = `${base} ${index}`;
    index += 1;
  }
  return candidate;
}

export function applyParsedConfig(options: ApplyOptions): ApplyResult {
  const { workspace, source, parsed, isRefresh, keepRules } = options;
  const warnings = [...parsed.warnings];
  const now = new Date().toISOString();
  const sourceMap = sourceMapFor(workspace);
  const result: ApplyResult = {
    added: 0,
    removed: 0,
    changed: 0,
    deduped: 0,
    groups: 0,
    rules: 0,
    skippedRules: 0,
    warnings,
  };

  const sourceNodes = workspace.nodes.filter((n) => n.sourceId === source.id);
  const otherKeys = new Set(
    workspace.nodes.filter((n) => n.sourceId !== source.id).map((n) => dedupeKey(n.raw)),
  );
  const existingByKey = new Map(sourceNodes.map((n) => [dedupeKey(n.raw), n]));
  const seenKeys = new Set<string>();
  const usedNames = new Set(workspace.nodes.map((n) => nodeDisplayName(n, sourceMap.get(n.sourceId)).toLowerCase()));
  const importedNodes: ProxyNode[] = [];

  for (const raw of parsed.proxies) {
    const key = dedupeKey(raw);
    if (seenKeys.has(key)) {
      result.deduped += 1;
      continue;
    }
    if (otherKeys.has(key)) {
      result.deduped += 1;
      continue;
    }
    seenKeys.add(key);
    const existing = existingByKey.get(key);
    const baseName = String(raw.name ?? '').trim() || '未命名节点';
    if (existing) {
      const before = JSON.stringify(existing.raw);
      existing.raw = structuredClone(raw);
      existing.updatedAt = now;
      if (!existing.region) existing.region = detectRegion(baseName);
      if (before !== JSON.stringify(existing.raw)) result.changed += 1;
      importedNodes.push(existing);
    } else {
      const displayBase = uniqueBaseName(baseName, source.prefix, usedNames);
      const node: ProxyNode = {
        id: randomUUID(),
        sourceId: source.id,
        name: displayBase,
        raw: structuredClone(raw),
        region: detectRegion(baseName),
        tags: [],
        enabled: true,
        addedAt: now,
        updatedAt: undefined,
      };
      workspace.nodes.push(node);
      usedNames.add(nodeDisplayName(node, source).toLowerCase());
      importedNodes.push(node);
      result.added += 1;
    }
  }

  if (isRefresh) {
    for (const node of sourceNodes) {
      const key = dedupeKey(node.raw);
      if (!seenKeys.has(key)) {
        workspace.nodes = workspace.nodes.filter((n) => n.id !== node.id);
        result.removed += 1;
      }
    }
  }

  const nodeByRawName = new Map<string, ProxyNode>();
  const nodeByDisplayName = new Map<string, ProxyNode>();
  for (const node of importedNodes) {
    const rawName = typeof node.raw.name === 'string' ? node.raw.name.trim() : '';
    if (rawName) nodeByRawName.set(rawName.toLowerCase(), node);
    const display = nodeDisplayName(node, sourceMap.get(node.sourceId) ?? source);
    nodeByDisplayName.set(display.toLowerCase(), node);
    nodeByDisplayName.set(node.name.toLowerCase(), node);
  }

  const matchRoute = workspace.routes.find(
    (route): route is RuleRoute => route.kind === 'rule' && route.type === 'MATCH',
  );

  if (isRefresh || keepRules) {
    const before = workspace.routes.length;
    workspace.routes = workspace.routes.filter((route) => route.sourceId !== source.id);
    if (workspace.routes.length !== before && !keepRules) {
      // 关闭保留订阅规则时，仅移除旧来源规则
    }
  }

  if (keepRules) {
    const groupMap = new Map<string, string>();
    let order = workspace.exits.reduce((max, exit) => Math.max(max, exit.order), 0);

    for (const group of parsed.groups) {
      let exit = workspace.exits.find((e) => e.sourceId === source.id && e.name === group.name);
      if (!exit) {
        const userExit = workspace.exits.find((e) => !e.builtin && e.name === group.name);
        if (userExit) {
          groupMap.set(group.name.toLowerCase(), userExit.id);
          warnings.push(`出口「${group.name}」已存在，沿用现有成员`);
          continue;
        }
        exit = {
          id: randomUUID(),
          name: group.name,
          type: group.type,
          members: [],
          sourceId: source.id,
          order: ++order,
          testUrl: group.url,
          interval: group.interval,
          tolerance: group.tolerance,
        };
        workspace.exits.push(exit);
        result.groups += 1;
      } else {
        exit.type = group.type;
        exit.testUrl = group.url;
        exit.interval = group.interval;
        exit.tolerance = group.tolerance;
        result.groups += 1;
      }
      groupMap.set(group.name.toLowerCase(), exit.id);
    }

    const builtin = (name: string) => workspace.exits.find((e) => e.builtin && e.name === name);
    for (const group of parsed.groups) {
      const exit = workspace.exits.find((e) => e.sourceId === source.id && e.name === group.name);
      if (!exit) continue;
      const members: ExitMember[] = [];
      const memberKeys = new Set<string>();
      for (const target of group.proxies) {
        const key = target.toLowerCase();
        let member: ExitMember | null = null;
        if (key === 'direct' || key === 'reject') {
          const targetExit = builtin(target.toUpperCase());
          if (targetExit) member = { by: 'exit', value: targetExit.id };
        } else if (groupMap.has(key)) {
          const targetId = groupMap.get(key)!;
          if (targetId !== exit.id) member = { by: 'exit', value: targetId };
        } else if (nodeByRawName.has(key)) {
          member = { by: 'node', value: nodeByRawName.get(key)!.id };
        } else if (nodeByDisplayName.has(key)) {
          member = { by: 'node', value: nodeByDisplayName.get(key)!.id };
        }
        if (!member) {
          warnings.push(`「${group.name}」中的成员「${target}」未找到，已跳过`);
          continue;
        }
        const memberKey = `${member.by}|${member.value}`;
        if (memberKeys.has(memberKey)) continue;
        memberKeys.add(memberKey);
        members.push(member);
      }
      exit.members = members;
    }

    const newRoutes: Array<RuleRoute | RuleSetRoute> = [];
    for (const line of parsed.rules) {
      const rule = parseRuleLine(line);
      if (!rule) {
        result.skippedRules += 1;
        continue;
      }
      const targetId =
        rule.target.toUpperCase() === 'DIRECT'
          ? builtin('DIRECT')?.id
          : rule.target.toUpperCase() === 'REJECT'
            ? builtin('REJECT')?.id
            : groupMap.get(rule.target.toLowerCase()) ??
              workspace.exits.find((e) => !e.builtin && e.name === rule.target)?.id;
      const targetNode =
        nodeByRawName.get(rule.target.toLowerCase()) ?? nodeByDisplayName.get(rule.target.toLowerCase());
      if (!targetId && !targetNode) {
        result.skippedRules += 1;
        warnings.push(`规则目标「${rule.target}」不存在，已跳过`);
        continue;
      }
      if (rule.type === 'MATCH') {
        if (matchRoute) {
          matchRoute.exitId = targetNode ? '' : targetId!;
          matchRoute.targetNodeId = targetNode?.id;
        }
        result.rules += 1;
        continue;
      }
      if (rule.type === 'RULE-SET') {
        if (!targetId) {
          result.skippedRules += 1;
          warnings.push(`规则集「${rule.payload}」指向节点时不支持导入，已跳过`);
          continue;
        }
        const provider = parsed.providers[rule.payload];
        if (!provider?.url) {
          result.skippedRules += 1;
          warnings.push(`规则集「${rule.payload}」没有可用的远程地址，已跳过`);
          continue;
        }
        newRoutes.push({
          id: randomUUID(),
          kind: 'ruleset',
          name: provider.name,
          behavior: provider.behavior ?? normalizeBehavior(undefined, provider.url),
          format: provider.format ?? normalizeFormat(undefined, provider.url),
          source: { type: 'url', value: provider.url },
          inline: false,
          exitId: targetId,
          noResolve: rule.noResolve,
          enabled: true,
          interval: provider.interval ?? 86400,
          updatedAt: now,
          origin: 'source',
          sourceId: source.id,
        });
        result.rules += 1;
        continue;
      }
      if (!RULE_TYPES.has(rule.type)) {
        result.skippedRules += 1;
        continue;
      }
      newRoutes.push({
        id: randomUUID(),
        kind: 'rule',
        type: rule.type as EdgeRuleType,
        payload: rule.payload,
        exitId: targetNode ? '' : targetId!,
        targetNodeId: targetNode?.id,
        noResolve: rule.noResolve,
        origin: 'source',
        sourceId: source.id,
        enabled: true,
      });
      result.rules += 1;
    }

    const withoutMatch = workspace.routes.filter(
      (route) => !(route.kind === 'rule' && route.type === 'MATCH'),
    );
    const match = workspace.routes.find(
      (route): route is RuleRoute => route.kind === 'rule' && route.type === 'MATCH',
    );
    workspace.routes = match ? [...withoutMatch, ...newRoutes, match] : [...withoutMatch, ...newRoutes];
  }

  if (isRefresh && !keepRules) {
    // 刷新且未保留规则时，来源规则已在上面移除，成员节点已同步
  }

  result.warnings = [...new Set(warnings)];
  return result;
}

export function suggestPrefix(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 4);
  return cleaned ? `${cleaned}-` : '';
}
