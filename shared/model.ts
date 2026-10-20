import { getDomain } from 'tldts';
import type {
  Exit,
  ExitMember,
  ProxyNode,
  Route,
  RuleRoute,
  RuleType,
  Source,
  Workspace,
} from './types';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(value: string): boolean {
  return IPV4_RE.test(value.trim());
}

export function isIPv6(value: string): boolean {
  return value.includes(':') && /^[0-9a-f:.%]+$/i.test(value);
}

export function isIpAddress(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^[*+.]+\.?/, '').replace(/\.$/, '');
}

export function suggestRootDomain(host: string): string {
  const clean = host.trim().toLowerCase().replace(/\.$/, '');
  if (!clean) return clean;
  if (isIpAddress(clean)) return clean;
  const domain = getDomain(clean, { allowPrivateDomains: true });
  return domain || clean.replace(/^www\./, '');
}

export function nodeDisplayName(node: ProxyNode, source?: Source): string {
  return `${source?.prefix ?? ''}${node.name}`;
}

export function nodeTagLabels(node: ProxyNode): string[] {
  const labels = node.region ? [node.region, ...node.tags] : [...node.tags];
  return [...new Set(labels.map((t) => t.trim()).filter(Boolean))];
}

export interface RouteTargetInfo {
  kind: 'exit' | 'node';
  id: string;
  name: string;
  available: boolean;
  exit?: Exit;
  node?: ProxyNode;
}

export function routeTargetInfo(route: Route, workspace: Workspace): RouteTargetInfo {
  if (route.kind === 'rule' && route.targetNodeId) {
    const node = workspace.nodes.find((item) => item.id === route.targetNodeId);
    if (!node) {
      return { kind: 'node', id: route.targetNodeId, name: '节点已丢失', available: false };
    }
    const source = workspace.sources.find((item) => item.id === node.sourceId);
    return {
      kind: 'node',
      id: node.id,
      name: nodeDisplayName(node, source),
      available: node.enabled,
      node,
    };
  }
  const exit = workspace.exits.find((item) => item.id === route.exitId);
  if (!exit) {
    return { kind: 'exit', id: route.exitId, name: '出口已丢失', available: false };
  }
  return { kind: 'exit', id: exit.id, name: exit.name, available: true, exit };
}

export function pruneUnavailableExitMembers(workspace: Workspace): void {
  const enabledNodeIds = new Set(workspace.nodes.filter((node) => node.enabled).map((node) => node.id));
  for (const exit of workspace.exits) {
    if (!exit.members.some((member) => member.by === 'node')) continue;
    exit.members = exit.members.filter(
      (member) => member.by !== 'node' || enabledNodeIds.has(member.value),
    );
  }
}

export function collectTags(nodes: ProxyNode[]): string[] {
  const seen = new Map<string, string>();
  for (const node of nodes) {
    for (const tag of nodeTagLabels(node)) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

export interface MissingRef {
  by: ExitMember['by'];
  value: string;
  reason: string;
}

export interface ExitResolution {
  nodes: ProxyNode[];
  nested: Exit[];
  missing: MissingRef[];
  allNodeIds: string[];
  memberNames: string[];
}

export interface ResolveContext {
  nodes: ProxyNode[];
  exits: Exit[];
  sources: Source[];
}

export function resolveExit(exit: Exit, ctx: ResolveContext): ExitResolution {
  const nodesById = new Map(ctx.nodes.map((n) => [n.id, n]));
  const exitsById = new Map(ctx.exits.map((e) => [e.id, e]));
  const sourcesById = new Map(ctx.sources.map((s) => [s.id, s]));
  const directNodes: ProxyNode[] = [];
  const nested: Exit[] = [];
  const missing: MissingRef[] = [];
  const allNodeIds = new Set<string>();
  const missingSeen = new Set<string>();

  const addMissing = (by: ExitMember['by'], value: string, reason: string) => {
    const key = `${by}|${value}|${reason}`;
    if (!missingSeen.has(key)) {
      missingSeen.add(key);
      missing.push({ by, value, reason });
    }
  };

  const walk = (current: Exit, stack: Set<string>, depth: number) => {
    for (const member of current.members) {
      if (member.by === 'node') {
        const node = nodesById.get(member.value);
        if (!node) {
          addMissing('node', member.value, '节点已不存在');
          continue;
        }
        if (!node.enabled) {
          addMissing('node', nodeDisplayName(node, sourcesById.get(node.sourceId)), '节点已禁用');
          continue;
        }
        allNodeIds.add(node.id);
        if (depth === 0) directNodes.push(node);
      } else if (member.by === 'tag') {
        const tag = member.value.trim().toLowerCase();
        const matched = ctx.nodes.filter(
          (node) => node.enabled && nodeTagLabels(node).some((t) => t.toLowerCase() === tag),
        );
        if (matched.length === 0) {
          addMissing('tag', member.value, '没有匹配的已启用节点');
          continue;
        }
        for (const node of matched) {
          allNodeIds.add(node.id);
          if (depth === 0) directNodes.push(node);
        }
      } else if (member.by === 'regex') {
        let re: RegExp;
        try {
          re = new RegExp(member.value, 'i');
        } catch {
          addMissing('regex', member.value, '正则表达式无效');
          continue;
        }
        const matched = ctx.nodes.filter(
          (node) => node.enabled && re.test(nodeDisplayName(node, sourcesById.get(node.sourceId))),
        );
        if (matched.length === 0) {
          addMissing('regex', member.value, '没有匹配的已启用节点');
          continue;
        }
        for (const node of matched) {
          allNodeIds.add(node.id);
          if (depth === 0) directNodes.push(node);
        }
      } else if (member.by === 'exit') {
        const child = exitsById.get(member.value);
        if (!child) {
          addMissing('exit', member.value, '出口已不存在');
          continue;
        }
        if (stack.has(child.id)) {
          addMissing('exit', child.name, '嵌套出口形成环');
          continue;
        }
        if (depth === 0) nested.push(child);
        walk(child, new Set([...stack, child.id]), depth + 1);
      }
    }
  };

  walk(exit, new Set([exit.id]), 0);

  const seenNodes = new Set<string>();
  const uniqueNodes = directNodes.filter((n) => {
    if (seenNodes.has(n.id)) return false;
    seenNodes.add(n.id);
    return true;
  });
  const memberNames: string[] = [];
  const seenNames = new Set<string>();
  for (const node of uniqueNodes) {
    const name = nodeDisplayName(node, sourcesById.get(node.sourceId));
    if (!seenNames.has(name)) {
      seenNames.add(name);
      memberNames.push(name);
    }
  }
  for (const child of nested) {
    if (!seenNames.has(child.name)) {
      seenNames.add(child.name);
      memberNames.push(child.name);
    }
  }

  return {
    nodes: uniqueNodes,
    nested,
    missing,
    allNodeIds: [...allNodeIds],
    memberNames,
  };
}

export function builtinExit(exit: Exit): boolean {
  return Boolean(exit.builtin);
}

export function ruleMatchesHost(type: RuleType, payload: string, host: string): boolean {
  const target = host.trim().toLowerCase();
  const value = normalizeDomain(payload);
  if (!target || !value) return false;
  if (type === 'DOMAIN') return target === value;
  if (type === 'DOMAIN-SUFFIX') return target === value || target.endsWith(`.${value}`);
  if (type === 'DOMAIN-KEYWORD') return target.includes(value);
  return false;
}

function ipv4ToNumber(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function parseCidr(value: string): { base: number; bits: number } | null {
  const [ip, bitsRaw] = value.split('/');
  const base = ipv4ToNumber(ip ?? '');
  const bits = Number(bitsRaw ?? '32');
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, bits };
}

function cidrContains(outer: string, inner: string): boolean {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  if (!a || !b) return false;
  if (b.bits < a.bits) return false;
  const mask = a.bits === 0 ? 0 : (0xffffffff << (32 - a.bits)) >>> 0;
  return (b.base & mask) >>> 0 === a.base;
}

export function coversRule(earlier: RuleRoute, later: RuleRoute): boolean {
  if (!earlier.enabled || !later.enabled) return false;
  if (earlier.type === 'MATCH') return later.type !== 'MATCH';
  if (later.type === 'MATCH') return false;

  const e = earlier.type;
  const l = later.type;
  const a = normalizeDomain(earlier.payload);
  const b = normalizeDomain(later.payload);

  if (e === 'DOMAIN') {
    if (l === 'DOMAIN') return a === b;
    if (l === 'DOMAIN-KEYWORD') return b.includes(a);
    return false;
  }
  if (e === 'DOMAIN-SUFFIX') {
    if (l === 'DOMAIN' || l === 'DOMAIN-SUFFIX') return b === a || b.endsWith(`.${a}`);
    return false;
  }
  if (e === 'DOMAIN-KEYWORD') {
    if (l === 'DOMAIN' || l === 'DOMAIN-SUFFIX' || l === 'DOMAIN-KEYWORD') return b.includes(a);
    return false;
  }
  if (e === 'IP-CIDR' && l === 'IP-CIDR') return cidrContains(earlier.payload, later.payload);
  if (e === 'PROCESS-NAME' && l === 'PROCESS-NAME') return a === b;
  if (e === later.type && a === b) return true;
  return false;
}

export function findCoveringRoute(routes: Route[], index: number): { index: number; route: Route } | null {
  const route = routes[index];
  if (!route || route.kind !== 'rule' || route.type === 'MATCH') return null;
  for (let i = 0; i < index; i++) {
    const candidate = routes[i];
    if (candidate?.kind === 'rule' && coversRule(candidate, route)) {
      return { index: i, route: candidate };
    }
  }
  return null;
}

export function findDuplicateRoute(routes: Route[], rule: Pick<RuleRoute, 'type' | 'payload'>, exceptId?: string): number {
  return routes.findIndex(
    (route) =>
      route.id !== exceptId &&
      route.kind === 'rule' &&
      route.type === rule.type &&
      route.payload.trim().toLowerCase() === rule.payload.trim().toLowerCase(),
  );
}

export function providerSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'ruleset';
}

function isSourceRoute(route: Route): boolean {
  if (route.sourceId) return true;
  if (route.kind === 'rule') return route.origin === 'source';
  return route.origin === 'source';
}

export function insertRouteOrdered(routes: Route[], route: Route): Route[] {
  const matchIndex = routes.findIndex((item) => item.kind === 'rule' && item.type === 'MATCH');
  const before = matchIndex >= 0 ? routes.slice(0, matchIndex) : [...routes];
  const match = matchIndex >= 0 ? routes[matchIndex] : null;
  const isCustomSingle = route.kind === 'rule' && route.type !== 'MATCH' && route.origin !== 'source';

  if (isCustomSingle) {
    const index = before.findIndex((item) => item.kind === 'ruleset' || isSourceRoute(item));
    before.splice(index >= 0 ? index : before.length, 0, route);
  } else if (route.kind === 'ruleset' && route.origin !== 'source') {
    const firstSource = before.findIndex(isSourceRoute);
    before.splice(firstSource >= 0 ? firstSource : before.length, 0, route);
  } else {
    before.push(route);
  }

  return match ? [...before, match] : before;
}
