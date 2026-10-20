const FLAG_REGIONS: Record<string, string> = {
  HK: '香港',
  TW: '台湾',
  JP: '日本',
  SG: '新加坡',
  US: '美国',
  KR: '韩国',
  GB: '英国',
  UK: '英国',
  DE: '德国',
  FR: '法国',
  NL: '荷兰',
  CA: '加拿大',
  AU: '澳大利亚',
  RU: '俄罗斯',
  TR: '土耳其',
  IN: '印度',
  MY: '马来西亚',
  TH: '泰国',
  PH: '菲律宾',
  VN: '越南',
  BR: '巴西',
  AR: '阿根廷',
  AE: '阿联酋',
  CH: '瑞士',
  SE: '瑞典',
  IT: '意大利',
  ES: '西班牙',
  PL: '波兰',
  FI: '芬兰',
  NO: '挪威',
  DK: '丹麦',
  IE: '爱尔兰',
  NZ: '新西兰',
  ZA: '南非',
  ID: '印度尼西亚',
  MO: '澳门',
  CN: '中国',
};

export const REGION_EMOJI: Record<string, string> = {
  香港: '🇭🇰',
  台湾: '🇹🇼',
  日本: '🇯🇵',
  新加坡: '🇸🇬',
  美国: '🇺🇸',
  韩国: '🇰🇷',
  英国: '🇬🇧',
  德国: '🇩🇪',
  法国: '🇫🇷',
  荷兰: '🇳🇱',
  加拿大: '🇨🇦',
  澳大利亚: '🇦🇺',
  俄罗斯: '🇷🇺',
  土耳其: '🇹🇷',
  印度: '🇮🇳',
  马来西亚: '🇲🇾',
  泰国: '🇹🇭',
  菲律宾: '🇵🇭',
  越南: '🇻🇳',
  巴西: '🇧🇷',
  阿根廷: '🇦🇷',
  阿联酋: '🇦🇪',
  瑞士: '🇨🇭',
  瑞典: '🇸🇪',
  意大利: '🇮🇹',
  西班牙: '🇪🇸',
  波兰: '🇵🇱',
  芬兰: '🇫🇮',
  挪威: '🇳🇴',
  丹麦: '🇩🇰',
  爱尔兰: '🇮🇪',
  新西兰: '🇳🇿',
  南非: '🇿🇦',
  印度尼西亚: '🇮🇩',
  澳门: '🇲🇴',
  中国: '🇨🇳',
};

const TOKEN_REGIONS: Array<[RegExp, string]> = [
  [/香港|港区|沪港|深港|\bHK\b|\bHKG\b|Hong\s?Kong/i, '香港'],
  [/台湾|台灣|台北|台中|高雄|新北|\bTW\b|\bTWN\b|Taiwan/i, '台湾'],
  [/日本|东京|東京|大阪|埼玉|名古屋|福冈|福岡|\bJP\b|\bJPN\b|Japan|Tokyo|Osaka/i, '日本'],
  [/新加坡|狮城|獅城|\bSG\b|\bSGP\b|Singapore/i, '新加坡'],
  [/美国|美國|洛杉矶|聖荷西|圣何塞|硅谷|西雅图|纽约|紐約|达拉斯|芝加哥|迈阿密|\bUS\b|\bUSA\b|United\s?States|Los\s?Angeles|San\s?Jose|Seattle|New\s?York/i, '美国'],
  [/韩国|韓國|首尔|首爾|釜山|\bKR\b|\bKOR\b|Korea|Seoul/i, '韩国'],
  [/英国|英國|伦敦|倫敦|\bUK\b|\bGB\b|\bGBR\b|London|United\s?Kingdom/i, '英国'],
  [/德国|德國|法兰克福|法蘭克福|柏林|\bDE\b|\bDEU\b|Germany|Frankfurt/i, '德国'],
  [/法国|法國|巴黎|\bFR\b|\bFRA\b|France|Paris/i, '法国'],
  [/荷兰|荷蘭|阿姆斯特丹|\bNL\b|\bNLD\b|Netherlands|Amsterdam/i, '荷兰'],
  [/加拿大|多伦多|多倫多|温哥华|溫哥華|\bCA\b|\bCAN\b|Canada|Toronto|Vancouver/i, '加拿大'],
  [/澳大利亚|澳洲|悉尼|雪梨|\bAU\b|\bAUS\b|Australia|Sydney/i, '澳大利亚'],
  [/俄罗斯|俄羅斯|莫斯科|\bRU\b|\bRUS\b|Russia|Moscow/i, '俄罗斯'],
  [/土耳其|伊斯坦布尔|\bTR\b|\bTUR\b|Turkey|Istanbul/i, '土耳其'],
  [/印度尼西亚|印尼|雅加达|\bID\b|\bIDN\b|Indonesia|Jakarta/i, '印度尼西亚'],
  [/马来西亚|馬來西亞|吉隆坡|\bMY\b|\bMYS\b|Malaysia/i, '马来西亚'],
  [/泰国|泰國|曼谷|\bTH\b|\bTHA\b|Thailand|Bangkok/i, '泰国'],
  [/菲律宾|菲律賓|马尼拉|馬尼拉|\bPH\b|\bPHL\b|Philippines|Manila/i, '菲律宾'],
  [/越南|胡志明|\bVN\b|\bVNM\b|Vietnam/i, '越南'],
  [/印度|孟买|孟買|\bIN\b|\bIND\b|India|Mumbai/i, '印度'],
  [/巴西|圣保罗|聖保羅|\bBR\b|\bBRA\b|Brazil/i, '巴西'],
  [/阿根廷|\bAR\b|\bARG\b|Argentina/i, '阿根廷'],
  [/阿联酋|阿聯酋|迪拜|\bAE\b|\bARE\b|Dubai|Emirates/i, '阿联酋'],
  [/瑞士|苏黎世|蘇黎世|\bCH\b|\bCHE\b|Switzerland|Zurich/i, '瑞士'],
  [/瑞典|斯德哥尔摩|\bSE\b|\bSWE\b|Sweden|Stockholm/i, '瑞典'],
  [/意大利|\bIT\b|\bITA\b|Italy/i, '意大利'],
  [/西班牙|\bES\b|\bESP\b|Spain/i, '西班牙'],
  [/波兰|波蘭|\bPL\b|\bPOL\b|Poland/i, '波兰'],
  [/芬兰|芬蘭|\bFI\b|\bFIN\b|Finland/i, '芬兰'],
  [/挪威|\bNO\b|\bNOR\b|Norway/i, '挪威'],
  [/丹麦|丹麥|\bDK\b|\bDNK\b|Denmark/i, '丹麦'],
  [/爱尔兰|愛爾蘭|\bIE\b|\bIRL\b|Ireland/i, '爱尔兰'],
  [/新西兰|新西蘭|\bNZ\b|\bNZL\b|New\s?Zealand/i, '新西兰'],
  [/南非|\bZA\b|\bZAF\b|South\s?Africa/i, '南非'],
  [/澳门|澳門|\bMO\b|\bMAC\b|Macau|Macao/i, '澳门'],
  [/中国|中國|回国|回國|\bCN\b|\bCHN\b|China/i, '中国'],
];

function flagToCode(text: string): string | undefined {
  for (let i = 0; i < text.length - 1; i++) {
    const a = text.codePointAt(i);
    const b = text.codePointAt(i + 1);
    if (a === undefined || b === undefined) continue;
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      return String.fromCharCode(a - 0x1f1e6 + 65, b - 0x1f1e6 + 65);
    }
  }
  return undefined;
}

export function detectRegion(name: string): string | undefined {
  const code = flagToCode(name);
  if (code && FLAG_REGIONS[code]) return FLAG_REGIONS[code];
  for (const [re, label] of TOKEN_REGIONS) {
    if (re.test(name)) return label;
  }
  return undefined;
}

export function regionEmoji(region?: string): string | undefined {
  return region ? REGION_EMOJI[region] : undefined;
}
