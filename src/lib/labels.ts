import type { RulesetBehavior, RuleSetRoute, RuleType } from '../../shared/types';

export const RULE_TYPE_LABELS: Record<RuleType, string> = {
  DOMAIN: '精确域名',
  'DOMAIN-SUFFIX': '域名后缀',
  'DOMAIN-KEYWORD': '域名关键字',
  'IP-CIDR': 'IPv4 网段',
  'IP-CIDR6': 'IPv6 网段',
  'PROCESS-NAME': '进程名',
  'PROCESS-PATH': '进程路径',
  GEOSITE: '域名集合',
  GEOIP: '地区 IP',
  'RULE-SET': '规则集',
  MATCH: '兜底',
  'DST-PORT': '目标端口',
};

export function ruleTypeLabel(type: RuleType | string): string {
  return RULE_TYPE_LABELS[type as RuleType] ?? type;
}

export const BEHAVIOR_LABELS: Record<RulesetBehavior, string> = {
  domain: '域名',
  ipcidr: 'IP 段',
  classical: '完整规则',
};

export function behaviorLabel(behavior: string): string {
  return BEHAVIOR_LABELS[behavior as RulesetBehavior] ?? behavior;
}

export const FORMAT_LABELS: Record<string, string> = {
  mrs: 'MRS',
  yaml: 'YAML',
  text: 'TEXT',
};

export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}

export function rulesetOriginLabel(route: RuleSetRoute): string {
  if (route.origin === 'catalog') return '内置';
  if (route.origin === 'source' || route.sourceId) return '订阅';
  if (route.origin === 'recommended') return '推荐';
  return '自定义';
}

export function ruleOriginLabel(origin: string | undefined): string {
  if (origin === 'source') return '订阅';
  if (origin === 'drag') return '拖拽';
  return '手动';
}

export const EXIT_TYPE_LABELS: Record<string, string> = {
  select: '手动选择',
  'url-test': '自动测速',
  fallback: '故障转移',
  'load-balance': '负载均衡',
};

export function exitTypeLabel(type: string): string {
  return EXIT_TYPE_LABELS[type] ?? type;
}

export const EXIT_TYPE_SHORT: Record<string, string> = {
  select: '手动',
  'url-test': '测速',
  fallback: '故障',
  'load-balance': '均衡',
};

export function exitTypeShort(type: string): string {
  return EXIT_TYPE_SHORT[type] ?? type;
}
