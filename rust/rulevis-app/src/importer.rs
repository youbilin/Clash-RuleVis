use std::collections::{HashMap, HashSet};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rulevis_core::model::{
    Exit, ExitMember, ProxyNode, Route, RuleRoute, RuleSetRoute, RuleSetSource, Source, Workspace,
};
use rulevis_core::regions::detect_region;
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::storage::now_iso;

const EXIT_TYPES: &[&str] = &["select", "url-test", "fallback", "load-balance"];
const RULE_TYPES: &[&str] = &[
    "DOMAIN",
    "DOMAIN-SUFFIX",
    "DOMAIN-KEYWORD",
    "IP-CIDR",
    "IP-CIDR6",
    "PROCESS-NAME",
    "PROCESS-PATH",
    "GEOSITE",
    "GEOIP",
    "DST-PORT",
];

#[derive(Clone, Debug)]
pub struct ParsedGroup {
    pub name: String,
    pub kind: String,
    pub proxies: Vec<String>,
    pub url: Option<String>,
    pub interval: Option<i64>,
    pub tolerance: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct ParsedProvider {
    pub name: String,
    pub url: Option<String>,
    pub path: Option<String>,
    pub behavior: String,
    pub format: String,
    pub interval: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct ParsedConfig {
    pub proxies: Vec<Map<String, Value>>,
    pub groups: Vec<ParsedGroup>,
    pub rules: Vec<String>,
    pub providers: HashMap<String, ParsedProvider>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ApplyResult {
    pub added: usize,
    pub removed: usize,
    pub changed: usize,
    pub deduped: usize,
    pub groups: usize,
    pub rules: usize,
    pub skipped_rules: usize,
    pub warnings: Vec<String>,
}

fn maybe_decode_base64(text: &str) -> String {
    let compact = text.trim();
    if compact.len() < 20
        || compact.contains(':')
        || compact.contains('{')
        || compact.contains('}')
        || compact.contains('[')
        || compact.contains(']')
    {
        return text.to_string();
    }
    if !compact.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=' | '\r' | '\n')
    }) {
        return text.to_string();
    }
    let normalized: String = compact
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let padding = (4 - normalized.len() % 4) % 4;
    let padded = format!("{}{}", normalized, "=".repeat(padding));
    let Ok(bytes) = STANDARD.decode(padded.as_bytes()) else {
        return text.to_string();
    };
    let decoded = String::from_utf8_lossy(&bytes).to_string();
    if decoded.contains("proxies") && decoded.contains(':') {
        decoded
    } else {
        text.to_string()
    }
}

fn yaml_to_value(input: &str) -> Result<Value, String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(input).map_err(|error| {
        format!(
            "YAML 解析失败：{}",
            error.to_string().lines().next().unwrap_or("格式错误")
        )
    })?;
    serde_json::to_value(yaml).map_err(|error| format!("YAML 解析失败：{}", error))
}

fn normalize_format(value: Option<&Value>, hint: &str) -> String {
    let raw = value.and_then(Value::as_str).unwrap_or("").to_lowercase();
    if raw == "mrs" {
        return "mrs".to_string();
    }
    if raw == "yaml" || raw == "yml" {
        return "yaml".to_string();
    }
    if raw == "text" {
        return "text".to_string();
    }
    let lower = hint.to_lowercase();
    if lower.contains(".mrs") {
        return "mrs".to_string();
    }
    if lower.contains(".yaml") || lower.contains(".yml") {
        return "yaml".to_string();
    }
    "text".to_string()
}

fn normalize_behavior(value: Option<&Value>, hint: &str) -> String {
    let raw = value.and_then(Value::as_str).unwrap_or("").to_lowercase();
    if matches!(raw.as_str(), "domain" | "ipcidr" | "classical") {
        return raw;
    }
    let lower = hint.to_lowercase();
    if lower.contains("geoip") || lower.contains("ipcidr") || lower.contains("ip-list") {
        return "ipcidr".to_string();
    }
    "domain".to_string()
}

fn integer(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number.round() as i64))
}

pub fn parse_config_text(input: &str) -> Result<ParsedConfig, String> {
    let mut warnings = Vec::new();
    let text = maybe_decode_base64(input)
        .trim_start_matches('\u{feff}')
        .to_string();
    let parsed = yaml_to_value(&text)?;

    let (raw_proxies, raw_groups, raw_rules, raw_providers) = if let Some(array) = parsed.as_array()
    {
        (array.clone(), Vec::new(), Vec::new(), Map::new())
    } else if let Some(object) = parsed.as_object() {
        if object
            .get("proxy-providers")
            .is_some_and(|value| value.is_object())
            && !object.get("proxies").is_some_and(Value::is_array)
        {
            return Err("这是 proxy-providers 直通配置，请在订阅设置中使用静态导入".to_string());
        }
        (
            object
                .get("proxies")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            object
                .get("proxy-groups")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            object
                .get("rules")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            object
                .get("rule-providers")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        )
    } else {
        (Vec::new(), Vec::new(), Vec::new(), Map::new())
    };

    if raw_proxies.is_empty() {
        return Err("没有找到可导入的 proxies，请检查订阅内容或文件格式".to_string());
    }

    let mut proxies = Vec::new();
    for item in &raw_proxies {
        let Some(record) = item.as_object() else {
            continue;
        };
        let name = record
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let kind = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if name.is_empty()
            || kind.is_empty()
            || !record.contains_key("server")
            || !record.contains_key("port")
        {
            continue;
        }
        proxies.push(record.clone());
    }
    if proxies.is_empty() {
        return Err("proxies 中没有有效的节点定义".to_string());
    }
    if proxies.len() < raw_proxies.len() {
        warnings.push(format!(
            "忽略了 {} 个缺少名称、类型或地址的节点",
            raw_proxies.len() - proxies.len()
        ));
    }

    let mut groups = Vec::new();
    for item in &raw_groups {
        let Some(record) = item.as_object() else {
            continue;
        };
        let name = record
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let kind = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if name.is_empty() || !EXIT_TYPES.contains(&kind.as_str()) {
            continue;
        }
        let members = record
            .get("proxies")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        groups.push(ParsedGroup {
            name: name.to_string(),
            kind,
            proxies: members,
            url: record
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string),
            interval: integer(record.get("interval")),
            tolerance: integer(record.get("tolerance")),
        });
    }

    let rules = raw_rules
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("//"))
        .map(str::to_string)
        .collect();

    let mut providers = HashMap::new();
    for (name, value) in raw_providers {
        let Some(record) = value.as_object() else {
            continue;
        };
        let url = record
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string);
        let path = record
            .get("path")
            .and_then(Value::as_str)
            .filter(|_| record.get("type").and_then(Value::as_str) == Some("file"))
            .map(str::to_string);
        let hint = url.clone().or_else(|| path.clone()).unwrap_or_default();
        providers.insert(
            name.clone(),
            ParsedProvider {
                name,
                url,
                path,
                behavior: normalize_behavior(record.get("behavior"), &hint),
                format: normalize_format(record.get("format"), &hint),
                interval: integer(record.get("interval")),
            },
        );
    }

    Ok(ParsedConfig {
        proxies,
        groups,
        rules,
        providers,
        warnings,
    })
}

pub fn dedupe_key(raw: &Map<String, Value>) -> String {
    const FIELDS: &[&str] = &[
        "type",
        "server",
        "port",
        "uuid",
        "password",
        "private-key",
        "psk",
        "auth",
        "cipher",
        "username",
    ];
    let parts: Vec<String> = FIELDS
        .iter()
        .map(|field| match raw.get(*field) {
            Some(Value::String(value)) => value.trim().to_lowercase(),
            Some(Value::Number(value)) => value.to_string(),
            _ => String::new(),
        })
        .collect();
    let key = parts.join("|");
    if key == "|||||||||" {
        format!(
            "name:{}",
            raw.get("name").and_then(Value::as_str).unwrap_or("")
        )
    } else {
        key
    }
}

fn unique_base_name(base: &str, prefix: &str, used: &HashSet<String>) -> String {
    let mut candidate = base.to_string();
    let mut index = 2;
    while used.contains(&format!("{}{}", prefix, candidate).to_lowercase()) {
        candidate = format!("{} {}", base, index);
        index += 1;
    }
    candidate
}

pub struct ParsedRuleLine {
    pub kind: String,
    pub payload: String,
    pub target: String,
    pub no_resolve: bool,
}

pub fn parse_rule_line(line: &str) -> Option<ParsedRuleLine> {
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    if parts.len() < 2 {
        return None;
    }
    let kind = parts[0].to_uppercase();
    let no_resolve = parts
        .iter()
        .skip(2)
        .any(|part| part.eq_ignore_ascii_case("no-resolve"));
    if kind == "MATCH" {
        let target = parts.get(1)?.to_string();
        if target.is_empty() {
            return None;
        }
        return Some(ParsedRuleLine {
            kind,
            payload: String::new(),
            target,
            no_resolve: false,
        });
    }
    let payload = parts.get(1)?.to_string();
    let target = parts.get(2)?.to_string();
    if payload.is_empty() || target.is_empty() || target == "no-resolve" {
        return None;
    }
    Some(ParsedRuleLine {
        kind,
        payload,
        target,
        no_resolve,
    })
}

fn display_name(node: &ProxyNode, prefix: &str) -> String {
    format!("{}{}", prefix, node.name)
}

pub fn apply_parsed_config(
    workspace: &mut Workspace,
    source: &Source,
    parsed: &ParsedConfig,
    is_refresh: bool,
    keep_rules: bool,
) -> ApplyResult {
    let mut result = ApplyResult {
        warnings: parsed.warnings.clone(),
        ..ApplyResult::default()
    };
    let now = now_iso();
    let source_prefixes: HashMap<String, String> = workspace
        .sources
        .iter()
        .map(|item| (item.id.clone(), item.prefix.clone()))
        .collect();
    let source_nodes: Vec<(String, String)> = workspace
        .nodes
        .iter()
        .filter(|node| node.source_id == source.id)
        .map(|node| (node.id.clone(), dedupe_key(&node.raw)))
        .collect();
    let other_keys: HashSet<String> = workspace
        .nodes
        .iter()
        .filter(|node| node.source_id != source.id)
        .map(|node| dedupe_key(&node.raw))
        .collect();
    let mut existing_by_key: HashMap<String, usize> = workspace
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.source_id == source.id)
        .map(|(index, node)| (dedupe_key(&node.raw), index))
        .collect();
    let mut seen_keys = HashSet::new();
    let mut used_names: HashSet<String> = workspace
        .nodes
        .iter()
        .map(|node| {
            let prefix = source_prefixes
                .get(&node.source_id)
                .map(String::as_str)
                .unwrap_or("");
            display_name(node, prefix).to_lowercase()
        })
        .collect();
    let mut imported_ids = Vec::new();

    for raw in &parsed.proxies {
        let key = dedupe_key(raw);
        if !seen_keys.insert(key.clone()) {
            result.deduped += 1;
            continue;
        }
        if other_keys.contains(&key) {
            result.deduped += 1;
            continue;
        }
        let base_name = raw
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("未命名节点")
            .to_string();
        if let Some(index) = existing_by_key.get(&key).copied() {
            let before = serde_json::to_string(&workspace.nodes[index].raw).unwrap_or_default();
            workspace.nodes[index].raw = raw.clone();
            workspace.nodes[index].updated_at = Some(now.clone());
            if workspace.nodes[index].region.is_none() {
                workspace.nodes[index].region = detect_region(&base_name);
            }
            let after = serde_json::to_string(&workspace.nodes[index].raw).unwrap_or_default();
            if before != after {
                result.changed += 1;
            }
            imported_ids.push(workspace.nodes[index].id.clone());
        } else {
            let name = unique_base_name(&base_name, &source.prefix, &used_names);
            let node = ProxyNode {
                id: Uuid::new_v4().to_string(),
                source_id: source.id.clone(),
                name,
                raw: raw.clone(),
                region: detect_region(&base_name),
                tags: Vec::new(),
                enabled: true,
                added_at: now.clone(),
                updated_at: None,
                chain: None,
            };
            used_names.insert(display_name(&node, &source.prefix).to_lowercase());
            imported_ids.push(node.id.clone());
            workspace.nodes.push(node);
            existing_by_key.insert(key, workspace.nodes.len() - 1);
            result.added += 1;
        }
    }

    if is_refresh {
        let seen: HashSet<String> = seen_keys;
        let keep_ids: HashSet<&str> = workspace
            .nodes
            .iter()
            .filter(|node| node.source_id == source.id && seen.contains(&dedupe_key(&node.raw)))
            .map(|node| node.id.as_str())
            .collect();
        let removed_ids: HashSet<String> = source_nodes
            .iter()
            .filter(|(id, _)| !keep_ids.contains(id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        if !removed_ids.is_empty() {
            result.removed = removed_ids.len();
            workspace
                .nodes
                .retain(|node| !removed_ids.contains(&node.id));
        }
    }

    let nodes_by_id: HashMap<String, ProxyNode> = workspace
        .nodes
        .iter()
        .filter(|node| imported_ids.contains(&node.id))
        .map(|node| (node.id.clone(), node.clone()))
        .collect();
    let mut node_by_raw_name: HashMap<String, String> = HashMap::new();
    let mut node_by_display_name: HashMap<String, String> = HashMap::new();
    for node in nodes_by_id.values() {
        if let Some(raw_name) = node.raw.get("name").and_then(Value::as_str) {
            let raw_name = raw_name.trim();
            if !raw_name.is_empty() {
                node_by_raw_name.insert(raw_name.to_lowercase(), node.id.clone());
            }
        }
        let prefix = source_prefixes
            .get(&node.source_id)
            .map(String::as_str)
            .unwrap_or(&source.prefix);
        node_by_display_name.insert(display_name(node, prefix).to_lowercase(), node.id.clone());
        node_by_display_name.insert(node.name.to_lowercase(), node.id.clone());
    }

    if is_refresh || keep_rules {
        workspace.routes.retain(|route| match route {
            Route::Rule(rule) => rule.source_id.as_deref() != Some(source.id.as_str()),
            Route::Ruleset(rule) => rule.source_id.as_deref() != Some(source.id.as_str()),
        });
    }

    let mut new_routes: Vec<Route> = Vec::new();
    if keep_rules {
        let mut group_ids: HashMap<String, String> = HashMap::new();
        let mut order = workspace
            .exits
            .iter()
            .map(|exit| exit.order)
            .max()
            .unwrap_or(0);

        for group in &parsed.groups {
            let existing_index = workspace.exits.iter().position(|exit| {
                exit.source_id.as_deref() == Some(source.id.as_str()) && exit.name == group.name
            });
            if let Some(index) = existing_index {
                let exit = &mut workspace.exits[index];
                exit.kind = group.kind.clone();
                exit.test_url = group.url.clone();
                exit.interval = group.interval;
                exit.tolerance = group.tolerance;
                group_ids.insert(group.name.to_lowercase(), exit.id.clone());
                result.groups += 1;
                continue;
            }
            if let Some(user_exit) = workspace
                .exits
                .iter()
                .find(|exit| !exit.is_builtin() && exit.name == group.name)
            {
                group_ids.insert(group.name.to_lowercase(), user_exit.id.clone());
                result
                    .warnings
                    .push(format!("出口「{}」已存在，沿用现有成员", group.name));
                continue;
            }
            order += 1;
            let exit = Exit {
                id: Uuid::new_v4().to_string(),
                name: group.name.clone(),
                kind: group.kind.clone(),
                members: Vec::new(),
                builtin: None,
                source_id: Some(source.id.clone()),
                order,
                test_url: group.url.clone(),
                interval: group.interval,
                tolerance: group.tolerance,
            };
            group_ids.insert(group.name.to_lowercase(), exit.id.clone());
            workspace.exits.push(exit);
            result.groups += 1;
        }

        for group in &parsed.groups {
            let Some(exit_index) = workspace.exits.iter().position(|exit| {
                exit.source_id.as_deref() == Some(source.id.as_str()) && exit.name == group.name
            }) else {
                continue;
            };
            let mut members = Vec::new();
            let mut member_keys = HashSet::new();
            for target in &group.proxies {
                let key = target.to_lowercase();
                let mut member: Option<ExitMember> = None;
                if key == "direct" || key == "reject" {
                    let target_exit = workspace
                        .exits
                        .iter()
                        .find(|exit| exit.is_builtin() && exit.name.eq_ignore_ascii_case(&key));
                    if let Some(target_exit) = target_exit {
                        member = Some(ExitMember {
                            by: "exit".to_string(),
                            value: target_exit.id.clone(),
                        });
                    }
                } else if let Some(target_id) = group_ids.get(&key) {
                    if target_id != &workspace.exits[exit_index].id {
                        member = Some(ExitMember {
                            by: "exit".to_string(),
                            value: target_id.clone(),
                        });
                    }
                } else if let Some(target_id) = node_by_raw_name.get(&key) {
                    member = Some(ExitMember {
                        by: "node".to_string(),
                        value: target_id.clone(),
                    });
                } else if let Some(target_id) = node_by_display_name.get(&key) {
                    member = Some(ExitMember {
                        by: "node".to_string(),
                        value: target_id.clone(),
                    });
                }
                let Some(member) = member else {
                    result.warnings.push(format!(
                        "「{}」中的成员「{}」未找到，已跳过",
                        group.name, target
                    ));
                    continue;
                };
                let member_key = format!("{}|{}", member.by, member.value);
                if member_keys.insert(member_key) {
                    members.push(member);
                }
            }
            workspace.exits[exit_index].members = members;
        }

        let mut match_target: Option<(String, Option<String>)> = None;
        for line in &parsed.rules {
            let Some(rule) = parse_rule_line(line) else {
                result.skipped_rules += 1;
                continue;
            };
            let target_upper = rule.target.to_uppercase();
            let target_exit_id = if target_upper == "DIRECT" || target_upper == "REJECT" {
                workspace
                    .exits
                    .iter()
                    .find(|exit| exit.is_builtin() && exit.name.eq_ignore_ascii_case(&target_upper))
                    .map(|exit| exit.id.clone())
            } else {
                group_ids
                    .get(&rule.target.to_lowercase())
                    .cloned()
                    .or_else(|| {
                        workspace
                            .exits
                            .iter()
                            .find(|exit| {
                                !exit.is_builtin() && exit.name.eq_ignore_ascii_case(&rule.target)
                            })
                            .map(|exit| exit.id.clone())
                    })
            };
            let target_node_id = node_by_raw_name
                .get(&rule.target.to_lowercase())
                .or_else(|| node_by_display_name.get(&rule.target.to_lowercase()))
                .cloned();
            if target_exit_id.is_none() && target_node_id.is_none() {
                result.skipped_rules += 1;
                result
                    .warnings
                    .push(format!("规则目标「{}」不存在，已跳过", rule.target));
                continue;
            }
            if rule.kind == "MATCH" {
                match_target = Some((target_exit_id.unwrap_or_default(), target_node_id));
                result.rules += 1;
                continue;
            }
            if rule.kind == "RULE-SET" {
                let Some(provider) = parsed.providers.get(&rule.payload) else {
                    result.skipped_rules += 1;
                    result.warnings.push(format!(
                        "规则集「{}」没有可用的远程地址，已跳过",
                        rule.payload
                    ));
                    continue;
                };
                let Some(url) = provider.url.clone() else {
                    result.skipped_rules += 1;
                    result.warnings.push(format!(
                        "规则集「{}」没有可用的远程地址，已跳过",
                        rule.payload
                    ));
                    continue;
                };
                let Some(exit_id) = target_exit_id else {
                    result.skipped_rules += 1;
                    result.warnings.push(format!(
                        "规则集「{}」指向节点时不支持导入，已跳过",
                        rule.payload
                    ));
                    continue;
                };
                new_routes.push(Route::Ruleset(RuleSetRoute {
                    id: Uuid::new_v4().to_string(),
                    name: provider.name.clone(),
                    provider_name: None,
                    behavior: provider.behavior.clone(),
                    format: provider.format.clone(),
                    source: RuleSetSource {
                        kind: "url".to_string(),
                        value: url,
                        file_name: None,
                        size: None,
                    },
                    inline: false,
                    inline_rules: None,
                    rule_count: None,
                    exit_id,
                    no_resolve: rule.no_resolve.then_some(true),
                    enabled: true,
                    interval: Some(provider.interval.unwrap_or(86400)),
                    updated_at: Some(now.clone()),
                    origin: Some("source".to_string()),
                    source_id: Some(source.id.clone()),
                    pending: None,
                    applied_at: None,
                }));
                result.rules += 1;
                continue;
            }
            if !RULE_TYPES.contains(&rule.kind.as_str()) {
                result.skipped_rules += 1;
                continue;
            }
            let exit_id = if target_node_id.is_some() {
                String::new()
            } else {
                target_exit_id.clone().unwrap_or_default()
            };
            new_routes.push(Route::Rule(RuleRoute {
                id: Uuid::new_v4().to_string(),
                rule_type: rule.kind,
                payload: rule.payload,
                exit_id,
                target_node_id,
                no_resolve: rule.no_resolve.then_some(true),
                origin: "source".to_string(),
                source_id: Some(source.id.clone()),
                note: None,
                enabled: true,
                pending: None,
                applied_at: None,
            }));
            result.rules += 1;
        }

        if let Some(Route::Rule(rule)) = workspace.routes.iter_mut().find(|route| route.is_match())
        {
            if let Some((exit_id, target_node_id)) = match_target {
                rule.exit_id = exit_id;
                rule.target_node_id = target_node_id;
            }
        }
        let match_clone = workspace
            .routes
            .iter()
            .find(|route| route.is_match())
            .cloned();
        let mut retained: Vec<Route> = workspace
            .routes
            .iter()
            .filter(|route| !route.is_match())
            .cloned()
            .collect();
        retained.extend(new_routes);
        if let Some(match_route) = match_clone {
            retained.push(match_route);
        }
        workspace.routes = retained;
    }

    result.warnings = {
        let mut seen = HashSet::new();
        result
            .warnings
            .into_iter()
            .filter(|warning| seen.insert(warning.clone()))
            .collect()
    };
    result
}

pub fn suggest_prefix(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|character| character.is_alphanumeric())
        .take(4)
        .collect();
    if cleaned.is_empty() {
        String::new()
    } else {
        format!("{}-", cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::{apply_parsed_config, parse_config_text, suggest_prefix};
    use rulevis_core::model::Source;

    const SAMPLE: &str = r#"
proxies:
  - name: 东京 01
    type: ss
    server: tokyo.example.com
    port: 8388
    cipher: aes-256-gcm
    password: secret
proxy-groups:
  - name: 订阅自动
    type: url-test
    proxies: [东京 01, DIRECT]
rules:
  - DOMAIN-SUFFIX,openai.com,订阅自动
  - MATCH,DIRECT
rule-providers:
  openai:
    type: http
    behavior: domain
    url: https://example.com/openai.mrs
    format: mrs
"#;

    fn source() -> Source {
        Source {
            id: "source-1".to_string(),
            kind: "subscription".to_string(),
            name: "测试订阅".to_string(),
            url: None,
            prefix: "T-".to_string(),
            keep_rules: true,
            updated_at: None,
            userinfo: None,
            note: None,
        }
    }

    #[test]
    fn parses_and_applies_clash_yaml() {
        let parsed = parse_config_text(SAMPLE).unwrap();
        assert_eq!(parsed.proxies.len(), 1);
        assert_eq!(parsed.groups.len(), 1);
        assert_eq!(parsed.rules.len(), 2);
        assert_eq!(parsed.providers.len(), 1);

        let mut workspace =
            rulevis_core::create_default_workspace("2026-10-21T00:00:00.000Z".to_string());
        workspace.sources.push(source());
        let result = apply_parsed_config(&mut workspace, &source(), &parsed, false, true);
        assert_eq!(result.added, 1);
        assert_eq!(result.groups, 1);
        assert_eq!(result.rules, 2);
        let node = workspace
            .nodes
            .iter()
            .find(|node| node.name == "东京 01")
            .unwrap();
        assert_eq!(node.region.as_deref(), Some("日本"));
        let exit = workspace
            .exits
            .iter()
            .find(|exit| exit.name == "订阅自动")
            .unwrap();
        assert!(exit.members.iter().any(|member| member.value == "direct"));
        assert!(workspace.routes.iter().any(|route| match route {
            rulevis_core::model::Route::Rule(rule) => rule.payload == "openai.com",
            _ => false,
        }));
        assert!(workspace
            .routes
            .last()
            .is_some_and(|route| route.is_match()));
    }

    #[test]
    fn refresh_removes_missing_nodes_and_suggests_prefix() {
        let parsed = parse_config_text(SAMPLE).unwrap();
        let mut workspace =
            rulevis_core::create_default_workspace("2026-10-21T00:00:00.000Z".to_string());
        workspace.sources.push(source());
        apply_parsed_config(&mut workspace, &source(), &parsed, false, false);
        let mut empty = parsed.clone();
        empty.proxies.clear();
        let result = apply_parsed_config(&mut workspace, &source(), &empty, true, false);
        assert_eq!(result.removed, 1);
        assert_eq!(suggest_prefix("My Home 01"), "MyHo-");
    }
}
