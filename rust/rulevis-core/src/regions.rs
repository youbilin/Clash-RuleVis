use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

const FLAG_REGIONS: &[(&str, &str)] = &[
    ("HK", "香港"),
    ("TW", "台湾"),
    ("JP", "日本"),
    ("SG", "新加坡"),
    ("US", "美国"),
    ("KR", "韩国"),
    ("GB", "英国"),
    ("UK", "英国"),
    ("DE", "德国"),
    ("FR", "法国"),
    ("NL", "荷兰"),
    ("CA", "加拿大"),
    ("AU", "澳大利亚"),
    ("RU", "俄罗斯"),
    ("TR", "土耳其"),
    ("IN", "印度"),
    ("MY", "马来西亚"),
    ("TH", "泰国"),
    ("PH", "菲律宾"),
    ("VN", "越南"),
    ("BR", "巴西"),
    ("AR", "阿根廷"),
    ("AE", "阿联酋"),
    ("CH", "瑞士"),
    ("SE", "瑞典"),
    ("IT", "意大利"),
    ("ES", "西班牙"),
    ("PL", "波兰"),
    ("FI", "芬兰"),
    ("NO", "挪威"),
    ("DK", "丹麦"),
    ("IE", "爱尔兰"),
    ("NZ", "新西兰"),
    ("ZA", "南非"),
    ("ID", "印度尼西亚"),
    ("MO", "澳门"),
    ("CN", "中国"),
];

const TOKEN_REGIONS: &[(&str, &str)] = &[
    (r"香港|港区|沪港|深港|\bHK\b|\bHKG\b|Hong\s?Kong", "香港"),
    (
        r"台湾|台灣|台北|台中|高雄|新北|\bTW\b|\bTWN\b|Taiwan",
        "台湾",
    ),
    (
        r"日本|东京|東京|大阪|埼玉|名古屋|福冈|福岡|\bJP\b|\bJPN\b|Japan|Tokyo|Osaka",
        "日本",
    ),
    (r"新加坡|狮城|獅城|\bSG\b|\bSGP\b|Singapore", "新加坡"),
    (
        r"美国|美國|洛杉矶|聖荷西|圣何塞|硅谷|西雅图|纽约|紐約|达拉斯|芝加哥|迈阿密|\bUS\b|\bUSA\b|United\s?States|Los\s?Angeles|San\s?Jose|Seattle|New\s?York",
        "美国",
    ),
    (
        r"韩国|韓國|首尔|首爾|釜山|\bKR\b|\bKOR\b|Korea|Seoul",
        "韩国",
    ),
    (
        r"英国|英國|伦敦|倫敦|\bUK\b|\bGB\b|\bGBR\b|London|United\s?Kingdom",
        "英国",
    ),
    (
        r"德国|德國|法兰克福|法蘭克福|柏林|\bDE\b|\bDEU\b|Germany|Frankfurt",
        "德国",
    ),
    (r"法国|法國|巴黎|\bFR\b|\bFRA\b|France|Paris", "法国"),
    (
        r"荷兰|荷蘭|阿姆斯特丹|\bNL\b|\bNLD\b|Netherlands|Amsterdam",
        "荷兰",
    ),
    (
        r"加拿大|多伦多|多倫多|温哥华|溫哥華|\bCA\b|\bCAN\b|Canada|Toronto|Vancouver",
        "加拿大",
    ),
    (
        r"澳大利亚|澳洲|悉尼|雪梨|\bAU\b|\bAUS\b|Australia|Sydney",
        "澳大利亚",
    ),
    (
        r"俄罗斯|俄羅斯|莫斯科|\bRU\b|\bRUS\b|Russia|Moscow",
        "俄罗斯",
    ),
    (
        r"土耳其|伊斯坦布尔|\bTR\b|\bTUR\b|Turkey|Istanbul",
        "土耳其",
    ),
    (
        r"印度尼西亚|印尼|雅加达|\bID\b|\bIDN\b|Indonesia|Jakarta",
        "印度尼西亚",
    ),
    (
        r"马来西亚|馬來西亞|吉隆坡|\bMY\b|\bMYS\b|Malaysia|Kuala\s?Lumpur",
        "马来西亚",
    ),
    (r"泰国|泰國|曼谷|\bTH\b|\bTHA\b|Thailand|Bangkok", "泰国"),
    (
        r"菲律宾|菲律賓|马尼拉|馬尼拉|\bPH\b|\bPHL\b|Philippines|Manila",
        "菲律宾",
    ),
    (r"越南|胡志明|\bVN\b|\bVNM\b|Vietnam", "越南"),
    (r"印度|孟买|孟買|\bIN\b|\bIND\b|India|Mumbai", "印度"),
    (r"巴西|圣保罗|聖保羅|\bBR\b|\bBRA\b|Brazil", "巴西"),
    (r"阿根廷|\bAR\b|\bARG\b|Argentina", "阿根廷"),
    (
        r"阿联酋|阿聯酋|迪拜|\bAE\b|\bARE\b|Dubai|Emirates",
        "阿联酋",
    ),
    (
        r"瑞士|苏黎世|蘇黎世|\bCH\b|\bCHE\b|Switzerland|Zurich",
        "瑞士",
    ),
    (r"瑞典|斯德哥尔摩|\bSE\b|\bSWE\b|Sweden|Stockholm", "瑞典"),
    (r"意大利|\bIT\b|\bITA\b|Italy", "意大利"),
    (r"西班牙|\bES\b|\bESP\b|Spain", "西班牙"),
    (r"波兰|波蘭|\bPL\b|\bPOL\b|Poland", "波兰"),
    (r"芬兰|芬蘭|\bFI\b|\bFIN\b|Finland", "芬兰"),
    (r"挪威|\bNO\b|\bNOR\b|Norway", "挪威"),
    (r"丹麦|丹麥|\bDK\b|\bDNK\b|Denmark", "丹麦"),
    (r"爱尔兰|愛爾蘭|\bIE\b|\bIRL\b|Ireland", "爱尔兰"),
    (r"新西兰|新西蘭|\bNZ\b|\bNZL\b|New\s?Zealand", "新西兰"),
    (r"南非|\bZA\b|\bZAF\b|South\s?Africa", "南非"),
    (r"澳门|澳門|\bMO\b|\bMAC\b|Macau|Macao", "澳门"),
    (r"中国|中國|回国|回國|\bCN\b|\bCHN\b|China", "中国"),
];

fn flag_regions() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| FLAG_REGIONS.iter().copied().collect())
}

fn token_regions() -> &'static Vec<(Regex, &'static str)> {
    static LIST: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    LIST.get_or_init(|| {
        TOKEN_REGIONS
            .iter()
            .filter_map(|(pattern, label)| {
                Regex::new(&format!("(?i){}", pattern))
                    .ok()
                    .map(|regex| (regex, *label))
            })
            .collect()
    })
}

fn flag_code(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    for pair in chars.windows(2) {
        let first = pair[0] as u32;
        let second = pair[1] as u32;
        if (0x1f1e6..=0x1f1ff).contains(&first) && (0x1f1e6..=0x1f1ff).contains(&second) {
            let a = char::from_u32(first - 0x1f1e6 + 65)?;
            let b = char::from_u32(second - 0x1f1e6 + 65)?;
            return Some(format!("{}{}", a, b));
        }
    }
    None
}

pub fn detect_region(name: &str) -> Option<String> {
    if let Some(code) = flag_code(name) {
        if let Some(region) = flag_regions().get(code.as_str()) {
            return Some((*region).to_string());
        }
    }
    token_regions()
        .iter()
        .find(|(regex, _)| regex.is_match(name))
        .map(|(_, region)| (*region).to_string())
}

#[cfg(test)]
mod tests {
    use super::detect_region;

    #[test]
    fn detects_region_from_name_and_flag() {
        assert_eq!(detect_region("东京 01").as_deref(), Some("日本"));
        assert_eq!(detect_region("🇺🇸 Los Angeles").as_deref(), Some("美国"));
        assert_eq!(detect_region("Frankfurt-Edge").as_deref(), Some("德国"));
        assert_eq!(detect_region("relay.example.com"), None);
    }
}
