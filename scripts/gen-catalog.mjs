import fs from 'node:fs';
import path from 'node:path';

const temp = process.env.TEMP || process.env.TMP || '.';
const geositeTree = JSON.parse(fs.readFileSync(path.join(temp, 'catalog', 'geosite.json'), 'utf8'));
const geoipTree = JSON.parse(fs.readFileSync(path.join(temp, 'catalog', 'geoip.json'), 'utf8'));
const geosite = geositeTree.tree.filter((x) => x.type === 'blob' && x.path.endsWith('.mrs')).map((x) => x.path.replace(/\.mrs$/, '')).sort();
const geoip = geoipTree.tree.filter((x) => x.type === 'blob' && x.path.endsWith('.mrs')).map((x) => x.path.replace(/\.mrs$/, '')).sort();

const CUSTOM = {
  'openai': ['OpenAI / ChatGPT', 'ChatGPT、API、Sora 等 OpenAI 服务域名。', 'AI'],
  'anthropic': ['Anthropic / Claude', 'Claude 与 Anthropic API 域名。', 'AI'],
  'google-gemini': ['Google Gemini', 'Gemini 网页、API 与相关服务。', 'AI'],
  'perplexity': ['Perplexity', 'AI 搜索服务。', 'AI'],
  'poe': ['Poe', 'Quora 的 AI 聊天聚合服务。', 'AI'],
  'xai': ['xAI / Grok', 'Grok 与 xAI 服务。', 'AI'],
  'huggingface': ['Hugging Face', '模型、数据集与推理服务。', '开发'],
  'cursor': ['Cursor', 'AI 编程编辑器及更新服务。', '开发'],
  'category-ai-chat-!cn': ['AI 聊天（海外）', '海外 AI 聊天类网站集合。', 'AI'],
  'category-ai-!cn': ['AI 服务（海外）', '海外 AI 产品域名集合。', 'AI'],
  'youtube': ['YouTube', '视频、直播与相关 CDN。', '流媒体'],
  'netflix': ['Netflix', '流媒体视频与 CDN。', '流媒体'],
  'disney': ['Disney+', '迪士尼流媒体服务。', '流媒体'],
  'hbo': ['HBO Max', 'HBO 流媒体服务。', '流媒体'],
  'primevideo': ['Prime Video', '亚马逊流媒体服务。', '流媒体'],
  'tiktok': ['TikTok', '短视频与直播。', '流媒体'],
  'spotify': ['Spotify', '音乐流媒体。', '流媒体'],
  'twitch': ['Twitch', '游戏直播。', '流媒体'],
  'hulu': ['Hulu', '美国流媒体服务。', '流媒体'],
  'category-media': ['流媒体分类', '常见流媒体与音视频站点集合。', '流媒体'],
  'telegram': ['Telegram', '即时通讯、频道与 API。', '社交'],
  'twitter': ['X / Twitter', '社交平台与图片 CDN。', '社交'],
  'facebook': ['Facebook', 'Meta 社交平台。', '社交'],
  'instagram': ['Instagram', 'Meta 图片社交平台。', '社交'],
  'whatsapp': ['WhatsApp', 'Meta 即时通讯。', '社交'],
  'discord': ['Discord', '语音、社区与 CDN。', '社交'],
  'reddit': ['Reddit', '社区论坛。', '社交'],
  'linkedin': ['LinkedIn', '职业社交平台。', '社交'],
  'pinterest': ['Pinterest', '图片灵感社区。', '社交'],
  'category-communication': ['通讯工具分类', '即时通讯与语音服务集合。', '社交'],
  'github': ['GitHub', '代码托管、Pages 与 API。', '开发'],
  'gitlab': ['GitLab', '代码托管与 CI。', '开发'],
  'docker': ['Docker', '镜像仓库与容器服务。', '开发'],
  'jetbrains': ['JetBrains', 'IDE、插件市场与更新。', '开发'],
  'cloudflare': ['Cloudflare', 'CDN、DNS 与 Workers。', '开发'],
  'vercel': ['Vercel', '前端托管与部署服务。', '开发'],
  'stackoverflow': ['Stack Overflow', '开发者问答社区。', '开发'],
  'google': ['Google 服务', '搜索、账号、Gmail、地图等 Google 域名。', 'Google'],
  'google-gemini': ['Google Gemini', 'Gemini 网页、API 与相关服务。', 'AI'],
  'apple': ['Apple 服务', 'Apple 账号、iCloud、App Store 等。', 'Apple'],
  'apple-cn': ['Apple 中国', 'Apple 在中国大陆使用的服务域名。', 'Apple'],
  'microsoft': ['Microsoft 服务', '微软账号、Office、OneDrive 等。', 'Microsoft'],
  'win-update': ['Windows 更新', 'Windows Update 与相关下载。', 'Microsoft'],
  'onedrive': ['OneDrive', '微软云盘。', 'Microsoft'],
  'xbox': ['Xbox', 'Xbox 账号、商店与联机服务。', '游戏'],
  'steam': ['Steam', 'Steam 商店、社区与下载 CDN。', '游戏'],
  'epicgames': ['Epic Games', 'Epic 商店与游戏服务。', '游戏'],
  'playstation': ['PlayStation', '索尼 PSN 与商店。', '游戏'],
  'nintendo': ['Nintendo', '任天堂账号与商店。', '游戏'],
  'category-games': ['游戏分类', '常见游戏平台与游戏服务集合。', '游戏'],
  'category-games@cn': ['国内游戏', '国内游戏平台与下载服务。', '游戏'],
  'category-porn': ['成人内容', '成人网站与相关域名。', '其他'],
  'category-ads-all': ['全量广告拦截', '常见广告、追踪与统计域名。', '广告拦截'],
  'category-ads': ['广告域名', '广告与追踪域名集合。', '广告拦截'],
  'geolocation-cn': ['中国大陆网站', '面向中国大陆用户的网站域名集合。', '国内'],
  'geolocation-!cn': ['海外网站', '中国大陆以外的网站域名集合。', '海外'],
  'cn': ['中国常用网站', '国内常见网站与服务域名。', '国内'],
  'private': ['私有网络', '局域网、内网与本地服务域名。', '系统'],
  'tld-cn': ['中国域名后缀', '以 .cn / .中国 等结尾的域名。', '国内'],
  'tld-!cn': ['海外域名后缀', '常见海外顶级域名集合。', '海外'],
  'bilibili': ['哔哩哔哩', 'B 站视频、直播与 CDN。', '国内'],
  'iqiyi': ['爱奇艺', '爱奇艺视频服务。', '国内'],
  'youku': ['优酷', '优酷视频服务。', '国内'],
  'zhihu': ['知乎', '知乎问答与图片 CDN。', '国内'],
  'douyin': ['抖音', '抖音短视频与直播。', '国内'],
  'kuaishou': ['快手', '快手短视频与直播。', '国内'],
  'xiaohongshu': ['小红书', '小红书社区与图片 CDN。', '国内'],
  'jd': ['京东', '京东商城与物流服务。', '购物'],
  'baidu': ['百度', '搜索、网盘与相关服务。', '国内'],
  'netease': ['网易', '网易新闻、邮箱与游戏服务。', '国内'],
  'amazon': ['Amazon', '亚马逊商城与 AWS 相关域名。', '购物'],
  'taobao': ['淘宝', '淘宝商城与阿里 CDN。', '购物'],
  'tmall': ['天猫', '天猫商城。', '购物'],
  'alibaba': ['阿里巴巴', '阿里巴巴国际站与云服务。', '购物'],
  'aliexpress': ['AliExpress', '速卖通。', '购物'],
  'ebay': ['eBay', 'eBay 商城。', '购物'],
  'shopee': ['Shopee', '东南亚电商平台。', '购物'],
  'lazada': ['Lazada', '东南亚电商平台。', '购物'],
  'booking': ['Booking.com', '酒店与旅行预订。', '旅行'],
  'airbnb': ['Airbnb', '民宿与旅行住宿。', '旅行'],
  'expedia': ['Expedia', '旅行与机票预订。', '旅行'],
  'coursera': ['Coursera', '在线课程平台。', '教育'],
  'udemy': ['Udemy', '在线课程平台。', '教育'],
  'khanacademy': ['Khan Academy', '免费教育平台。', '教育'],
  'edx': ['edX', '在线课程平台。', '教育'],
  'binance': ['Binance', '加密货币交易所。', '金融'],
  'coinbase': ['Coinbase', '加密货币交易所。', '金融'],
  'okx': ['OKX', '加密货币交易所。', '金融'],
  'slack': ['Slack', '团队协作与消息。', '工具'],
  'notion': ['Notion', '笔记与协作。', '工具'],
  'figma': ['Figma', '设计协作工具。', '工具'],
  'zoom': ['Zoom', '视频会议。', '工具'],
  'dropbox': ['Dropbox', '云盘与文件同步。', '工具'],
  'onedrive': ['OneDrive', '微软云盘。', 'Microsoft'],
  'tor': ['Tor 网络', 'Tor 节点与相关 IP。', '隐私'],
  'torproject': ['Tor Project', 'Tor 官网与软件下载。', '隐私'],
  'category-scholar-!cn': ['海外学术', '海外学术与论文网站集合。', '教育'],
  'category-entertainment': ['娱乐分类', '娱乐与休闲网站集合。', '娱乐'],
  'category-social-media-!cn': ['海外社交媒体', '海外社交平台域名集合。', '社交'],
  'category-ip-geo': ['IP 地理位置', '按地区划分的 IP 段集合。', '地区 IP'],
};

const POPULAR = new Set([
  'openai', 'anthropic', 'google-gemini', 'perplexity', 'poe', 'xai', 'huggingface', 'cursor',
  'category-ai-chat-!cn', 'category-ai-!cn', 'youtube', 'netflix', 'disney', 'hbo', 'primevideo',
  'tiktok', 'spotify', 'twitch', 'telegram', 'twitter', 'facebook', 'instagram', 'whatsapp',
  'discord', 'reddit', 'github', 'gitlab', 'docker', 'jetbrains', 'cloudflare', 'vercel',
  'google', 'apple', 'apple-cn', 'microsoft', 'win-update', 'onedrive', 'xbox', 'steam',
  'epicgames', 'playstation', 'nintendo', 'category-games', 'category-ads-all', 'geolocation-cn',
  'geolocation-!cn', 'cn', 'private', 'tld-cn', 'tld-!cn', 'category-media', 'category-communication',
  'bilibili', 'iqiyi', 'youku', 'zhihu', 'douyin', 'kuaishou', 'xiaohongshu', 'jd', 'baidu',
  'netease', 'amazon', 'category-porn',
]);

const GEOIP_CUSTOM = {
  google: ['Google IP', 'Google 服务的公网 IP 段。', '服务 IP'],
  cloudflare: ['Cloudflare IP', 'Cloudflare CDN 与 DNS 的公网 IP 段。', '服务 IP'],
  cloudfront: ['CloudFront IP', 'AWS CloudFront CDN 的 IP 段。', '服务 IP'],
  facebook: ['Facebook IP', 'Meta 服务使用的公网 IP 段。', '服务 IP'],
  fastly: ['Fastly IP', 'Fastly CDN 的 IP 段。', '服务 IP'],
  netflix: ['Netflix IP', 'Netflix 流媒体 CDN 的 IP 段。', '服务 IP'],
  telegram: ['Telegram IP', 'Telegram 数据中心的 IP 段。', '服务 IP'],
  tor: ['Tor IP', 'Tor 出口/中继节点 IP 段。', '服务 IP'],
  twitter: ['X / Twitter IP', 'X 服务使用的公网 IP 段。', '服务 IP'],
  private: ['私有网络 IP', '局域网与保留地址的 IP 段。', '系统 IP'],
  cn: ['中国大陆 IP', '中国大陆的公网 IP 段。', '地区 IP'],
  hk: ['香港 IP', '香港的公网 IP 段。', '地区 IP'],
  tw: ['台湾 IP', '台湾的公网 IP 段。', '地区 IP'],
  jp: ['日本 IP', '日本的公网 IP 段。', '地区 IP'],
  sg: ['新加坡 IP', '新加坡的公网 IP 段。', '地区 IP'],
  us: ['美国 IP', '美国的公网 IP 段。', '地区 IP'],
  kr: ['韩国 IP', '韩国的公网 IP 段。', '地区 IP'],
};

const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
function countryName(code) {
  if (code.length !== 2) return null;
  try {
    const name = regionNames.of(code.toUpperCase());
    return name && name !== code.toUpperCase() ? name : null;
  } catch {
    return null;
  }
}

function humanize(slug) {
  const base = slug.replace(/@ads$/i, '').replace(/@cn$/i, '').replace(/@!cn$/i, '');
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 && /^[a-z]+$/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function geositeMeta(slug) {
  const custom = CUSTOM[slug];
  if (custom) return { nameZh: custom[0], descriptionZh: custom[1], category: custom[2] };
  if (slug.endsWith('@ads')) {
    return { nameZh: `${humanize(slug)} · 广告`, descriptionZh: '该站点的广告与追踪域名。', category: '广告拦截' };
  }
  if (slug.startsWith('category-')) {
    return { nameZh: `分类 · ${humanize(slug.slice(9))}`, descriptionZh: '按主题聚合的域名规则集。', category: '分类规则' };
  }
  if (slug.startsWith('geolocation-')) {
    return { nameZh: `地区 · ${humanize(slug.slice(12))}`, descriptionZh: '按地区聚合的网站域名规则集。', category: '地区' };
  }
  if (slug.startsWith('tld-')) {
    return { nameZh: `域名后缀 · ${humanize(slug.slice(4))}`, descriptionZh: '按顶级域名聚合的规则集。', category: '域名后缀' };
  }
  return { nameZh: humanize(slug), descriptionZh: '该站点及其关联服务的域名规则集。', category: '站点' };
}

function geoipMeta(slug) {
  const custom = GEOIP_CUSTOM[slug];
  if (custom) return { nameZh: custom[0], descriptionZh: custom[1], category: custom[2] };
  const country = countryName(slug);
  if (country) {
    return { nameZh: `${country} IP`, descriptionZh: `${country}的公网 IPv4/IPv6 地址段。`, category: '地区 IP' };
  }
  return { nameZh: `${humanize(slug)} IP`, descriptionZh: '该服务的公网 IP 段。', category: '服务 IP' };
}

function providerName(kind, slug) {
  const base = kind === 'geoip' ? `${slug}-ip` : slug;
  const safe = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || (kind === 'geoip' ? `ip-${slug}` : `site-${slug}`);
}

const entries = [];
for (const slug of geosite) {
  const meta = geositeMeta(slug);
  entries.push({
    id: `geosite:${slug}`,
    kind: 'geosite',
    slug,
    providerName: providerName('geosite', slug),
    nameZh: meta.nameZh,
    nameEn: humanize(slug),
    descriptionZh: meta.descriptionZh,
    category: meta.category,
    behavior: 'domain',
    format: 'mrs',
    url: `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/${slug}.mrs`,
    popular: POPULAR.has(slug),
  });
}
for (const slug of geoip) {
  const meta = geoipMeta(slug);
  entries.push({
    id: `geoip:${slug}`,
    kind: 'geoip',
    slug,
    providerName: providerName('geoip', slug),
    nameZh: meta.nameZh,
    nameEn: humanize(slug),
    descriptionZh: meta.descriptionZh,
    category: meta.category,
    behavior: 'ipcidr',
    format: 'mrs',
    url: `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/${slug}.mrs`,
    popular: POPULAR.has(slug) || ['google', 'telegram', 'netflix', 'private', 'cn'].includes(slug),
  });
}

const byId = new Map(entries.map((entry) => [entry.id, entry]));
const comboSpecs = [
  {
    id: 'ai',
    nameZh: 'AI 服务',
    description: 'ChatGPT、Claude、Gemini 等海外 AI 产品，适合整体交给 AI 出口。',
    category: 'AI',
    entries: ['geosite:openai', 'geosite:anthropic', 'geosite:google-gemini', 'geosite:category-ai-chat-!cn', 'geosite:perplexity', 'geosite:poe'],
  },
  {
    id: 'streaming',
    nameZh: '流媒体',
    description: 'YouTube、Netflix、Disney+、TikTok、Spotify 等视频与音乐服务。',
    category: '流媒体',
    entries: ['geosite:youtube', 'geosite:netflix', 'geosite:disney', 'geosite:hbo', 'geosite:primevideo', 'geosite:tiktok', 'geosite:spotify', 'geosite:twitch'],
  },
  {
    id: 'social',
    nameZh: '海外社交',
    description: 'Telegram、X、Facebook、Instagram、Discord 等社交平台。',
    category: '社交',
    entries: ['geosite:telegram', 'geosite:twitter', 'geosite:facebook', 'geosite:instagram', 'geosite:whatsapp', 'geosite:discord', 'geosite:reddit'],
  },
  {
    id: 'dev',
    nameZh: '开发工具',
    description: 'GitHub、GitLab、Docker、Hugging Face、Vercel 等开发者服务。',
    category: '开发',
    entries: ['geosite:github', 'geosite:gitlab', 'geosite:docker', 'geosite:jetbrains', 'geosite:huggingface', 'geosite:cloudflare', 'geosite:vercel'],
  },
  {
    id: 'google',
    nameZh: 'Google 全套',
    description: 'Google 域名 + Google 公网 IP，适合走固定的海外出口。',
    category: 'Google',
    entries: ['geosite:google', 'geoip:google'],
  },
  {
    id: 'telegram',
    nameZh: 'Telegram 全套',
    description: 'Telegram 域名 + 数据中心 IP，避免只代理域名导致图片/语音失败。',
    category: '社交',
    entries: ['geosite:telegram', 'geoip:telegram'],
  },
  {
    id: 'cn-direct',
    nameZh: '国内直连',
    description: '中国大陆网站与 IP 段，通常指向 DIRECT 或国内家宽。',
    category: '国内',
    entries: ['geosite:geolocation-cn', 'geosite:cn', 'geoip:cn'],
  },
  {
    id: 'ads',
    nameZh: '广告拦截',
    description: '常见广告、追踪与统计域名，通常指向 REJECT。',
    category: '广告拦截',
    entries: ['geosite:category-ads-all'],
  },
  {
    id: 'games',
    nameZh: '游戏平台',
    description: 'Steam、Epic、PlayStation、Xbox、任天堂等游戏服务。',
    category: '游戏',
    entries: ['geosite:category-games', 'geosite:steam', 'geosite:epicgames', 'geosite:playstation', 'geosite:xbox', 'geosite:nintendo'],
  },
  {
    id: 'private',
    nameZh: '私有网络',
    description: '局域网、本地设备与保留 IP，通常指向 DIRECT。',
    category: '系统',
    entries: ['geosite:private', 'geoip:private'],
  },
  {
    id: 'apple',
    nameZh: 'Apple 服务',
    description: 'Apple 账号、iCloud、App Store 与中国区服务。',
    category: 'Apple',
    entries: ['geosite:apple', 'geosite:apple-cn'],
  },
  {
    id: 'microsoft',
    nameZh: '微软服务',
    description: 'Microsoft 账号、OneDrive、Windows 更新与 Xbox。',
    category: 'Microsoft',
    entries: ['geosite:microsoft', 'geosite:win-update', 'geosite:onedrive', 'geosite:xbox'],
  },
];
const combos = comboSpecs.map((combo) => ({
  ...combo,
  entries: combo.entries.filter((id) => byId.has(id)),
  entryCount: combo.entries.filter((id) => byId.has(id)).length,
})).filter((combo) => combo.entryCount > 0);

const header = `/* Generated from MetaCubeX/meta-rules-dat (branch meta). Do not edit by hand. */\n`;
const ts = `${header}export type RuleCatalogKind = 'geosite' | 'geoip';

export interface RuleCatalogEntry {
  id: string;
  kind: RuleCatalogKind;
  slug: string;
  providerName: string;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  category: string;
  behavior: 'domain' | 'ipcidr';
  format: 'mrs';
  url: string;
  popular: boolean;
}

export interface RuleCombo {
  id: string;
  nameZh: string;
  description: string;
  category: string;
  entries: string[];
  entryCount: number;
}

export const RULE_CATALOG: RuleCatalogEntry[] = JSON.parse(${JSON.stringify(JSON.stringify(entries))}) as RuleCatalogEntry[];

export const RULE_COMBOS: RuleCombo[] = JSON.parse(${JSON.stringify(JSON.stringify(combos))}) as RuleCombo[];

export const CATALOG_BY_ID: ReadonlyMap<string, RuleCatalogEntry> = new Map<string, RuleCatalogEntry>(
  RULE_CATALOG.map((entry): [string, RuleCatalogEntry] => [entry.id, entry]),
);
`;
fs.mkdirSync('src/data', { recursive: true });
fs.writeFileSync('src/data/rule-catalog.ts', ts);
console.log('generated', entries.length, 'entries', combos.length, 'combos', 'bytes', ts.length);
console.log('combo counts', combos.map((c) => `${c.nameZh}:${c.entryCount}`).join(', '));
console.log('popular', entries.filter((e) => e.popular).length);
