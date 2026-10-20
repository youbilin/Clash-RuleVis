import type { RulesetBehavior, RulesetFormat } from './types';

export interface RecommendedRuleSet {
  id: string;
  name: string;
  url: string;
  behavior: RulesetBehavior;
  format: RulesetFormat;
  category: string;
  note: string;
  size: number;
}

const RAW = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo';

export const RECOMMENDED_RULE_SETS: RecommendedRuleSet[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    url: `${RAW}/geosite/openai.mrs`,
    behavior: 'domain',
    format: 'mrs',
    category: 'AI',
    note: 'MetaCubeX · 2026-10-20 实测可用',
    size: 421,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    url: `${RAW}/geosite/anthropic.mrs`,
    behavior: 'domain',
    format: 'mrs',
    category: 'AI',
    note: 'MetaCubeX · 2026-10-20 实测可用',
    size: 194,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    url: `${RAW}/geosite/youtube.mrs`,
    behavior: 'domain',
    format: 'mrs',
    category: '流媒体',
    note: 'MetaCubeX · 2026-10-20 实测可用',
    size: 1366,
  },
  {
    id: 'google',
    name: 'Google',
    url: `${RAW}/geosite/google.mrs`,
    behavior: 'domain',
    format: 'mrs',
    category: '常用服务',
    note: 'MetaCubeX · 2026-10-20 实测可用',
    size: 8927,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    url: `${RAW}/geosite/telegram.mrs`,
    behavior: 'domain',
    format: 'mrs',
    category: '社交',
    note: 'MetaCubeX · 2026-10-20 实测可用',
    size: 274,
  },
  {
    id: 'category-ai-chat',
    name: 'AI 聊天服务',
    url: `${RAW}/geosite/category-ai-chat-!cn.mrs`,
    behavior: 'domain',
    format: 'mrs',
    category: 'AI',
    note: 'MetaCubeX · 2026-10-20 实测可用',
    size: 2075,
  },
  {
    id: 'category-ads-all',
    name: '全量广告拦截',
    url: `${RAW}/geosite/category-ads-all.mrs`,
    behavior: 'domain',
    format: 'mrs',
    category: '拦截',
    note: 'MetaCubeX · 2026-10-20 实测可用',
    size: 8197,
  },
  {
    id: 'cn-ip',
    name: '中国大陆 IP',
    url: `${RAW}/geoip/cn.mrs`,
    behavior: 'ipcidr',
    format: 'mrs',
    category: '国内直连',
    note: 'MetaCubeX · 2026-10-20 实测可用',
    size: 38586,
  },
];
