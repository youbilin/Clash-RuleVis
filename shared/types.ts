export const WORKSPACE_VERSION = 2;

export type SourceType = 'subscription' | 'file' | 'paste' | 'manual' | 'verge';

export interface SubscriptionUserinfo {
  used: number;
  total: number;
  expire?: number;
}

export interface Source {
  id: string;
  type: SourceType;
  name: string;
  url?: string;
  prefix: string;
  keepRules: boolean;
  updatedAt?: string;
  userinfo?: SubscriptionUserinfo;
  note?: string;
}

export interface ProxyNode {
  id: string;
  sourceId: string;
  name: string;
  raw: Record<string, unknown>;
  region?: string;
  tags: string[];
  enabled: boolean;
  addedAt: string;
  updatedAt?: string;
}

export type ExitType = 'select' | 'url-test' | 'fallback' | 'load-balance';

export interface ExitMember {
  by: 'node' | 'tag' | 'regex' | 'exit';
  value: string;
}

export interface Exit {
  id: string;
  name: string;
  type: ExitType;
  members: ExitMember[];
  builtin?: boolean;
  sourceId?: string;
  order: number;
  testUrl?: string;
  interval?: number;
  tolerance?: number;
}

export type EdgeRuleType =
  | 'DOMAIN'
  | 'DOMAIN-SUFFIX'
  | 'DOMAIN-KEYWORD'
  | 'IP-CIDR'
  | 'IP-CIDR6'
  | 'PROCESS-NAME'
  | 'PROCESS-PATH'
  | 'GEOSITE'
  | 'GEOIP'
  | 'DST-PORT';

export type RuleType = EdgeRuleType | 'RULE-SET' | 'MATCH';

export interface RuleRoute {
  id: string;
  kind: 'rule';
  type: RuleType;
  payload: string;
  exitId: string;
  targetNodeId?: string;
  noResolve?: boolean;
  origin: 'drag' | 'manual' | 'source';
  sourceId?: string;
  note?: string;
  enabled: boolean;
  pending?: boolean;
  appliedAt?: string;
}

export type RulesetBehavior = 'domain' | 'ipcidr' | 'classical';
export type RulesetFormat = 'yaml' | 'text' | 'mrs';

export interface InlineRule {
  type: EdgeRuleType;
  payload: string;
  noResolve?: boolean;
}

export interface RuleSetSource {
  type: 'url' | 'file';
  value: string;
  fileName?: string;
  size?: number;
}

export interface RuleSetRoute {
  id: string;
  kind: 'ruleset';
  name: string;
  providerName?: string;
  behavior: RulesetBehavior;
  format: RulesetFormat;
  source: RuleSetSource;
  inline: boolean;
  inlineRules?: InlineRule[];
  ruleCount?: number;
  exitId: string;
  noResolve?: boolean;
  enabled: boolean;
  interval?: number;
  updatedAt?: string;
  origin?: 'manual' | 'recommended' | 'source' | 'catalog';
  sourceId?: string;
  pending?: boolean;
  appliedAt?: string;
}

export type Route = RuleRoute | RuleSetRoute;

export interface WorkspaceSettings {
  onboarded: boolean;
  testUrl: string;
  retentionMinutes: number;
  subscriptionUserAgent: string;
  useProxyForFetch: boolean;
  defaultRuleType: 'DOMAIN-SUFFIX' | 'DOMAIN' | 'DOMAIN-KEYWORD';
  includeBaseTemplate: boolean;
  favoriteExitIds: string[];
}

export interface ExportRecord {
  id: string;
  at: string;
  path: string;
  revision: number;
  bytes: number;
  ruleCount: number;
  nodeCount: number;
  exitCount: number;
  providerCount: number;
}

export interface Workspace {
  version: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sources: Source[];
  nodes: ProxyNode[];
  exits: Exit[];
  routes: Route[];
  settings: WorkspaceSettings;
  lastExport?: ExportRecord;
}

export interface KernelStatus {
  connected: boolean;
  transport?: 'pipe' | 'tcp';
  endpoint?: string;
  version?: string;
  mode?: string;
  mixedPort?: number;
  error?: string;
  discovering?: boolean;
  lastSeenAt?: number;
}

export interface KernelGroupStatus {
  name: string;
  type: string;
  now: string | null;
  memberCount: number;
  delay?: number;
}

export interface KernelProviderStatus {
  name: string;
  behavior: string;
  format: string;
  ruleCount: number;
  updatedAt?: string;
  vehicleType: string;
  hitCount?: number;
}

export interface LiveVariant {
  rule: string;
  ruleType: string;
  rulePayload: string;
  exitName: string | null;
  nodeName: string | null;
  count: number;
  lastSeen: number;
}

export interface LiveDomainConnection {
  key: string;
  host: string;
  displayHost: string;
  isIp: boolean;
  destinationIp?: string;
  destinationPort?: string;
  network?: string;
  inbound?: string;
  rule: string;
  ruleType: string;
  rulePayload: string;
  chains: string[];
  exitName: string | null;
  nodeName: string | null;
  processes: string[];
  processPaths: string[];
  download: number;
  upload: number;
  rateDown: number;
  rateUp: number;
  history: number[];
  count: number;
  active: number;
  firstSeen: number;
  lastSeen: number;
  variants: LiveVariant[];
}

export interface LiveStats {
  activeConnections: number;
  domains: number;
  downRate: number;
  upRate: number;
  totalDown: number;
  totalUp: number;
}

export interface LiveSnapshot {
  generatedAt: number;
  connections: LiveDomainConnection[];
  stats: LiveStats;
  kernel: KernelStatus;
  groups: Record<string, KernelGroupStatus>;
  providers: Record<string, KernelProviderStatus>;
  ruleHits: Record<string, number>;
  proxyHits: Record<string, number>;
}

export interface ConfigIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  routeId?: string;
  exitId?: string;
}

export interface ExportCounts {
  nodes: number;
  exits: number;
  providers: number;
  rules: number;
}

export interface BaseTemplateInfo {
  included: boolean;
  source?: string;
  keys: string[];
  warning?: string;
}

export interface KernelValidation {
  available: boolean;
  ok: boolean;
  binary?: string;
  durationMs?: number;
  output?: string;
  error?: string;
}

export interface ExportPreview {
  yaml: string;
  issues: ConfigIssue[];
  counts: ExportCounts;
  generatedAt: string;
  fileName: string;
  diff?: string | null;
  previousExportAt?: string | null;
  baseSettings?: BaseTemplateInfo;
}

export interface ExportResult extends ExportPreview {
  path: string;
  historyId: string;
  workspace: Workspace;
  validation?: KernelValidation;
}

export interface HistoryEntry {
  id: string;
  at: string;
  label: string;
  kind: 'export' | 'manual' | 'restore';
  exportPath?: string;
  fileName?: string;
  counts?: ExportCounts;
  note?: string;
}

export interface ImportSummary {
  workspace: Workspace;
  added: number;
  deduped: number;
  groups: number;
  rules: number;
  skippedRules: number;
  warnings: string[];
}

export interface RefreshSummary extends ImportSummary {
  removed: number;
  changed: number;
}

export interface RuleSetInspect {
  format: RulesetFormat;
  behavior: RulesetBehavior;
  ruleCount?: number;
  sample: string[];
  size: number;
  textAvailable: boolean;
  fileName?: string;
  storedPath?: string;
  sourceType: 'url' | 'file';
  sourceValue: string;
}

export interface AppStatus {
  kernel: KernelStatus;
  version: string;
  dataDir: string;
  exportsDir: string;
  workspace: {
    revision: number;
    lastExport?: ExportRecord;
    counts: { sources: number; nodes: number; exits: number; routes: number; pending: number };
  };
  vergeProfile?: string;
}

export interface KernelSettingsView {
  mode: 'auto' | 'pipe' | 'tcp';
  endpoint?: string;
  hasSecret: boolean;
}

export interface DelayResult {
  name: string;
  delay?: number;
  error?: string;
}
