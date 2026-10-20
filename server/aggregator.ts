import type {
  KernelGroupStatus,
  KernelProviderStatus,
  LiveDomainConnection,
  LiveSnapshot,
  LiveVariant,
} from '../shared/types';
import { isIpAddress } from '../shared/model';
import {
  kernel,
  type MihomoConnection,
  type MihomoConnections,
  type MihomoProvider,
  type MihomoProxy,
  type MihomoRule,
} from './kernel';
import { redactLog } from './logging';

const RULE_TYPE_MAP: Record<string, string> = {
  Domain: 'DOMAIN',
  DomainSuffix: 'DOMAIN-SUFFIX',
  DomainKeyword: 'DOMAIN-KEYWORD',
  DomainRegex: 'DOMAIN-REGEX',
  GeoSite: 'GEOSITE',
  GeoIP: 'GEOIP',
  IPCIDR: 'IP-CIDR',
  IPCIDR6: 'IP-CIDR6',
  SrcIPCIDR: 'SRC-IP-CIDR',
  ProcessName: 'PROCESS-NAME',
  ProcessPath: 'PROCESS-PATH',
  RuleSet: 'RULE-SET',
  Match: 'MATCH',
  DstPort: 'DST-PORT',
  SrcPort: 'SRC-PORT',
  Network: 'NETWORK',
  InPort: 'IN-PORT',
};

export function normalizeRuleType(raw: string): string {
  if (!raw) return 'UNKNOWN';
  if (RULE_TYPE_MAP[raw]) return RULE_TYPE_MAP[raw];
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toUpperCase();
}

interface Agg {
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
  processes: Set<string>;
  processPaths: Set<string>;
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

interface LedgerEntry {
  download: number;
  upload: number;
}

const HISTORY_POINTS = 40;

function processName(conn: MihomoConnection): string | undefined {
  const raw = conn.metadata.processPath || conn.metadata.process;
  if (!raw) return undefined;
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] || raw;
}

function connectionHost(conn: MihomoConnection): { host: string; isIp: boolean; displayHost: string; destinationIp?: string } {
  const host = (conn.metadata.host || conn.metadata.sniffHost || '').trim();
  const destinationIp = (conn.metadata.remoteDestination || conn.metadata.destinationIP || '').trim() || undefined;
  if (host) {
    return { host, isIp: isIpAddress(host), displayHost: host, destinationIp };
  }
  if (destinationIp) {
    return { host: destinationIp, isIp: true, displayHost: destinationIp, destinationIp };
  }
  return { host: '', isIp: false, displayHost: '未知目标', destinationIp: undefined };
}

export class LiveAggregator {
  private aggs = new Map<string, Agg>();
  private ledger = new Map<string, LedgerEntry>();
  private groups: Record<string, KernelGroupStatus> = {};
  private providers: Record<string, KernelProviderStatus> = {};
  private ruleHits: Record<string, number> = {};
  private proxyHits: Record<string, number> = {};
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastPollAt = 0;
  private lastAuxPoll = 0;
  private lastRulesPoll = 0;
  private snapshot: LiveSnapshot;
  private onSnapshot: ((snapshot: LiveSnapshot) => void) | null = null;
  private retentionMinutes: () => number;

  constructor(retentionMinutes: () => number) {
    this.retentionMinutes = retentionMinutes;
    this.snapshot = this.buildSnapshot();
  }

  start(onSnapshot: (snapshot: LiveSnapshot) => void): void {
    this.onSnapshot = onSnapshot;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getSnapshot(): LiveSnapshot {
    return this.snapshot;
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    await this.poll().catch((error) => {
      console.warn('[live] 轮询失败：', redactLog(error));
    });
    if (!this.running) return;
    this.timer = setTimeout(() => void this.loop(), 1000);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    const startedAt = Date.now();
    const elapsed = this.lastPollAt ? Math.max(0.2, (startedAt - this.lastPollAt) / 1000) : 1;
    this.lastPollAt = startedAt;

    let connections: MihomoConnections | null = null;
    try {
      connections = await kernel.getConnections();
    } catch {
      connections = null;
    }

    if (connections) {
      this.ingest(connections, startedAt, elapsed);
      await this.pollAux(startedAt);
    }

    this.snapshot = this.buildSnapshot();
    this.onSnapshot?.(this.snapshot);
  }

  private ingest(connections: MihomoConnections, now: number, elapsed: number): void {
    const nextLedger = new Map<string, LedgerEntry>();
    const variants = new Map<string, Map<string, { variant: LiveVariant; count: number }>>();
    const activeByKey = new Map<string, number>();

    for (const conn of connections.connections) {
      const target = connectionHost(conn);
      const key = target.host ? `host:${target.host.toLowerCase()}` : 'host:unknown';
      let agg = this.aggs.get(key);
      if (!agg) {
        agg = {
          key,
          host: target.host,
          displayHost: target.displayHost,
          isIp: target.isIp,
          destinationIp: target.destinationIp,
          destinationPort: conn.metadata.destinationPort,
          network: conn.metadata.network,
          inbound: conn.metadata.inboundName,
          rule: conn.rule,
          ruleType: normalizeRuleType(conn.rule),
          rulePayload: conn.rulePayload,
          chains: conn.chains ?? [],
          exitName: null,
          nodeName: null,
          processes: new Set(),
          processPaths: new Set(),
          download: 0,
          upload: 0,
          rateDown: 0,
          rateUp: 0,
          history: new Array(HISTORY_POINTS).fill(0),
          count: 0,
          active: 0,
          firstSeen: now,
          lastSeen: now,
          variants: [],
        };
        this.aggs.set(key, agg);
      }

      const prev = this.ledger.get(conn.id);
      const isNew = !prev;
      const downDelta = isNew ? conn.download : Math.max(0, conn.download - prev.download);
      const upDelta = isNew ? conn.upload : Math.max(0, conn.upload - prev.upload);
      agg.download += downDelta;
      agg.upload += upDelta;
      if (!isNew) {
        const downRate = downDelta / elapsed;
        const upRate = upDelta / elapsed;
        agg.rateDown = agg.rateDown * 0.55 + downRate * 0.45;
        agg.rateUp = agg.rateUp * 0.55 + upRate * 0.45;
      }
      if (isNew) agg.count += 1;

      nextLedger.set(conn.id, { download: conn.download, upload: conn.upload });

      agg.displayHost = target.displayHost;
      agg.isIp = target.isIp;
      agg.destinationIp = target.destinationIp ?? agg.destinationIp;
      agg.destinationPort = conn.metadata.destinationPort || agg.destinationPort;
      agg.network = conn.metadata.network || agg.network;
      agg.inbound = conn.metadata.inboundName || agg.inbound;
      agg.rule = conn.rule || agg.rule;
      agg.ruleType = normalizeRuleType(conn.rule || agg.rule);
      agg.rulePayload = conn.rulePayload ?? agg.rulePayload;
      agg.chains = conn.chains ?? agg.chains;
      agg.exitName = agg.chains.length > 1 ? agg.chains[agg.chains.length - 1] : null;
      agg.nodeName = agg.chains[0] ?? null;
      const proc = processName(conn);
      if (proc) agg.processes.add(proc);
      if (conn.metadata.processPath) agg.processPaths.add(conn.metadata.processPath);
      agg.lastSeen = now;
      agg.active = (activeByKey.get(key) ?? 0) + 1;
      activeByKey.set(key, agg.active);

      const variantKey = `${agg.ruleType}|${agg.rulePayload}|${agg.exitName ?? ''}|${agg.nodeName ?? ''}`;
      let byAgg = variants.get(key);
      if (!byAgg) {
        byAgg = new Map();
        variants.set(key, byAgg);
      }
      const existing = byAgg.get(variantKey);
      if (existing) existing.count += 1;
      else {
        byAgg.set(variantKey, {
          count: 1,
          variant: {
            rule: agg.rule,
            ruleType: agg.ruleType,
            rulePayload: agg.rulePayload,
            exitName: agg.exitName,
            nodeName: agg.nodeName,
            count: 1,
            lastSeen: now,
          },
        });
      }
    }

    this.ledger = nextLedger;

    for (const agg of this.aggs.values()) {
      const active = activeByKey.get(agg.key) ?? 0;
      agg.active = active;
      if (!active) {
        agg.rateDown *= 0.35;
        agg.rateUp *= 0.35;
        if (agg.rateDown < 1) agg.rateDown = 0;
        if (agg.rateUp < 1) agg.rateUp = 0;
      }
      agg.history.push(Math.round(agg.rateDown + agg.rateUp));
      if (agg.history.length > HISTORY_POINTS) agg.history.splice(0, agg.history.length - HISTORY_POINTS);
      const byAgg = variants.get(agg.key);
      if (byAgg) {
        agg.variants = [...byAgg.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 6)
          .map((item) => ({ ...item.variant, count: item.count }));
      }
    }

    const cutoff = now - this.retentionMinutes() * 60_000;
    for (const [key, agg] of this.aggs) {
      if (!agg.active && agg.lastSeen < cutoff) this.aggs.delete(key);
    }
  }

  private async pollAux(now: number): Promise<void> {
    if (now - this.lastAuxPoll > 5000) {
      this.lastAuxPoll = now;
      try {
        const proxies = await kernel.getProxies();
        this.updateGroups(proxies.proxies);
      } catch {
        // 分组信息在断线时保留上一次结果
      }
    }
    if (now - this.lastRulesPoll > 10_000) {
      this.lastRulesPoll = now;
      try {
        const [rules, providers] = await Promise.all([kernel.getRules(), kernel.getRuleProviders()]);
        this.updateRules(rules.rules);
        this.updateProviders(providers.providers);
      } catch {
        // 规则统计在断线时保留上一次结果
      }
    }
  }

  private updateGroups(proxies: Record<string, MihomoProxy>): void {
    const next: Record<string, KernelGroupStatus> = {};
    for (const [name, proxy] of Object.entries(proxies)) {
      if (!['Selector', 'URLTest', 'Fallback', 'LoadBalance'].includes(proxy.type)) continue;
      const lastDelay = proxy.history?.[proxy.history.length - 1]?.delay;
      next[name] = {
        name,
        type: proxy.type,
        now: proxy.now ?? null,
        memberCount: proxy.all?.length ?? 0,
        delay: lastDelay && lastDelay > 0 ? lastDelay : undefined,
      };
    }
    this.groups = next;
  }

  private updateRules(rules: MihomoRule[]): void {
    const hits: Record<string, number> = {};
    const proxyHits: Record<string, number> = {};
    for (const rule of rules) {
      const type = normalizeRuleType(rule.type);
      const count = rule.extra?.hitCount ?? 0;
      hits[`${type}|${rule.payload}`] = (hits[`${type}|${rule.payload}`] ?? 0) + count;
      if (rule.proxy) proxyHits[rule.proxy] = (proxyHits[rule.proxy] ?? 0) + count;
    }
    this.ruleHits = hits;
    this.proxyHits = proxyHits;
  }

  private updateProviders(providers: Record<string, MihomoProvider>): void {
    const next: Record<string, KernelProviderStatus> = {};
    for (const [name, provider] of Object.entries(providers)) {
      next[name] = {
        name,
        behavior: provider.behavior ?? '',
        format: provider.format ?? '',
        ruleCount: provider.ruleCount ?? 0,
        updatedAt: provider.updatedAt,
        vehicleType: provider.vehicleType ?? '',
        hitCount: this.ruleHits[`RULE-SET|${name}`] ?? 0,
      };
    }
    this.providers = next;
  }

  private buildSnapshot(): LiveSnapshot {
    const connections: LiveDomainConnection[] = [...this.aggs.values()]
      .map((agg) => ({
        key: agg.key,
        host: agg.host,
        displayHost: agg.displayHost,
        isIp: agg.isIp,
        destinationIp: agg.destinationIp,
        destinationPort: agg.destinationPort,
        network: agg.network,
        inbound: agg.inbound,
        rule: agg.rule,
        ruleType: agg.ruleType,
        rulePayload: agg.rulePayload,
        chains: [...agg.chains],
        exitName: agg.exitName,
        nodeName: agg.nodeName,
        processes: [...agg.processes],
        processPaths: [...agg.processPaths],
        download: Math.round(agg.download),
        upload: Math.round(agg.upload),
        rateDown: Math.round(agg.rateDown),
        rateUp: Math.round(agg.rateUp),
        history: [...agg.history],
        count: agg.count,
        active: agg.active,
        firstSeen: agg.firstSeen,
        lastSeen: agg.lastSeen,
        variants: agg.variants.map((v) => ({ ...v })),
      }))
      .sort((a, b) => {
        if (a.active !== b.active) return b.active - a.active;
        return b.lastSeen - a.lastSeen;
      });

    const activeConnections = connections.reduce((sum, c) => sum + c.active, 0);
    const downRate = connections.reduce((sum, c) => sum + c.rateDown, 0);
    const upRate = connections.reduce((sum, c) => sum + c.rateUp, 0);
    const totalDown = connections.reduce((sum, c) => sum + c.download, 0);
    const totalUp = connections.reduce((sum, c) => sum + c.upload, 0);

    return {
      generatedAt: Date.now(),
      connections,
      stats: {
        activeConnections,
        domains: connections.length,
        downRate,
        upRate,
        totalDown,
        totalUp,
      },
      kernel: kernel.getStatus(),
      groups: this.groups,
      providers: this.providers,
      ruleHits: this.ruleHits,
      proxyHits: this.proxyHits,
    };
  }
}
