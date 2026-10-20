import type { RuleSetRoute } from '../../shared/types';
import {
  CATALOG_BY_ID,
  RULE_CATALOG,
  RULE_COMBOS,
  type RuleCatalogEntry,
  type RuleCombo,
} from '../data/rule-catalog';

export { RULE_CATALOG, RULE_COMBOS, CATALOG_BY_ID };
export type { RuleCatalogEntry, RuleCombo };

const byProvider = new Map<string, RuleCatalogEntry>();
const bySlug = new Map<string, RuleCatalogEntry>();
for (const entry of RULE_CATALOG) {
  byProvider.set(entry.providerName.toLowerCase(), entry);
  bySlug.set(entry.slug.toLowerCase(), entry);
  bySlug.set(`${entry.kind}:${entry.slug.toLowerCase()}`, entry);
}

export function catalogEntryById(id: string | undefined): RuleCatalogEntry | null {
  return id ? CATALOG_BY_ID.get(id) ?? null : null;
}

export function catalogEntryForRoute(route: RuleSetRoute): RuleCatalogEntry | null {
  if (route.providerName) {
    const entry = byProvider.get(route.providerName.toLowerCase());
    if (entry) return entry;
  }
  if (route.source.type === 'url') {
    try {
      const parts = new URL(route.source.value).pathname.split('/').filter(Boolean);
      const fileName = parts.pop() ?? '';
      const slug = fileName.replace(/\.mrs$/i, '').toLowerCase();
      const kind = parts.includes('geoip') ? 'geoip' : parts.includes('geosite') ? 'geosite' : '';
      if (kind && bySlug.has(`${kind}:${slug}`)) return bySlug.get(`${kind}:${slug}`) ?? null;
      if (byProvider.has(slug)) return byProvider.get(slug) ?? null;
      if (bySlug.has(slug)) return bySlug.get(slug) ?? null;
    } catch {
      // 保持原有名称
    }
  }
  const name = route.name.toLowerCase();
  return byProvider.get(name) ?? bySlug.get(name) ?? null;
}

export interface RouteDisplayInfo {
  name: string;
  description: string;
  providerName: string;
  slug?: string;
  entry: RuleCatalogEntry | null;
}

export function routeDisplayInfo(route: RuleSetRoute): RouteDisplayInfo {
  const entry = catalogEntryForRoute(route);
  if (entry) {
    return {
      name: entry.nameZh,
      description: entry.descriptionZh,
      providerName: entry.providerName,
      slug: entry.slug,
      entry,
    };
  }
  return {
    name: route.name,
    description:
      route.source.type === 'url'
        ? '来自远程规则集，指向当前选择的出口。'
        : route.source.fileName ?? '本地规则集',
    providerName: route.providerName || route.name,
    entry: null,
  };
}

export function providerKeyForRoute(route: RuleSetRoute): string {
  return route.providerName || route.name;
}

export function comboTargetHint(combo: RuleCombo, exitNames: string[]): string | undefined {
  const byCategory: Record<string, RegExp> = {
    AI: /ai|智能/i,
    流媒体: /视频|流媒体|影音|youtube/i,
    社交: /社交|telegram|电报/i,
    广告拦截: /广告|reject|拦截/i,
    国内: /国内|直连|direct|家宽/i,
    游戏: /游戏|game/i,
    开发: /开发|dev|代码/i,
  };
  const pattern = byCategory[combo.category];
  if (!pattern) return undefined;
  return exitNames.find((name) => pattern.test(name));
}
