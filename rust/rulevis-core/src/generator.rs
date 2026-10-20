use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{Map, Value};

use crate::model::{
    ConfigIssue, Exit, ExportCounts, IssueSeverity, ProxyNode, Route, Source, Workspace,
};
use crate::resolve::{
    find_covering_route, find_duplicate_route, node_display_name, provider_slug, resolve_exit,
};

const RESERVED_NAMES: &[&str] = &[
    "DIRECT",
    "REJECT",
    "GLOBAL",
    "PASS",
    "COMPATIBLE",
    "REJECT-DROP",
];
const GROUP_TYPES: &[&str] = &["select", "url-test", "fallback", "load-balance"];
const SUPPORTED_RULE_TYPES: &[&str] = &[
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
    "MATCH",
];

pub struct GeneratedConfig {
    pub yaml: String,
    pub issues: Vec<ConfigIssue>,
    pub counts: ExportCounts,
}

#[derive(Default)]
pub struct GenerateOptions {
    pub base_settings: Option<Map<String, Value>>,
}

fn has_control_chars(value: &str) -> bool {
    value.contains('\r') || value.contains('\n')
}

fn is_reserved(value: &str) -> bool {
    let upper = value.to_uppercase();
    RESERVED_NAMES.contains(&upper.as_str())
}

fn validate_ip_cidr(payload: &str) -> bool {
    crate::resolve::validate_ip_cidr(payload)
}

fn proxy_object(node: &ProxyNode, name: &str) -> Value {
    let mut raw = node.raw.clone();
    raw.insert("name".to_string(), Value::String(name.to_string()));
    Value::Object(raw)
}

fn provider_extension(format: &str) -> &'static str {
    match format {
        "mrs" => "mrs",
        "yaml" => "yaml",
        _ => "txt",
    }
}

struct IssueCollector {
    issues: Vec<ConfigIssue>,
    keys: HashSet<String>,
}

impl IssueCollector {
    fn new() -> Self {
        Self {
            issues: Vec::new(),
            keys: HashSet::new(),
        }
    }

    fn add(
        &mut self,
        severity: IssueSeverity,
        code: &str,
        message: String,
        route_id: Option<&str>,
        exit_id: Option<&str>,
    ) {
        let key = format!(
            "{:?}|{}|{}|{}|{}",
            severity,
            code,
            message,
            route_id.unwrap_or(""),
            exit_id.unwrap_or("")
        );
        if !self.keys.insert(key) {
            return;
        }
        self.issues.push(ConfigIssue {
            severity,
            code: code.to_string(),
            message,
            route_id: route_id.map(str::to_string),
            exit_id: exit_id.map(str::to_string),
        });
    }

    fn error(&mut self, code: &str, message: String) {
        self.add(IssueSeverity::Error, code, message, None, None);
    }

    fn warning(&mut self, code: &str, message: String) {
        self.add(IssueSeverity::Warning, code, message, None, None);
    }
}

fn node_name_for(
    node: &ProxyNode,
    sources_by_id: &HashMap<&str, &Source>,
    node_names: &HashMap<&str, String>,
) -> String {
    node_names
        .get(node.id.as_str())
        .cloned()
        .unwrap_or_else(|| {
            node_display_name(node, sources_by_id.get(node.source_id.as_str()).copied())
        })
}

#[allow(clippy::too_many_arguments)]
fn target_name(
    workspace: &Workspace,
    sources_by_id: &HashMap<&str, &Source>,
    node_names: &HashMap<&str, String>,
    exits_by_id: &HashMap<&str, &Exit>,
    active_exits: &[&Exit],
    issues: &mut IssueCollector,
    route: &Route,
    label: &str,
) -> Option<String> {
    if let Route::Rule(rule) = route {
        if let Some(target_id) = rule
            .target_node_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            let Some(node) = workspace.nodes.iter().find(|node| node.id == target_id) else {
                issues.add(
                    IssueSeverity::Error,
                    "missing-node",
                    format!("{}指向的节点已不存在", label),
                    Some(route.id()),
                    None,
                );
                return None;
            };
            if !node.enabled {
                issues.add(
                    IssueSeverity::Error,
                    "disabled-node",
                    format!("{}指向的节点已禁用", label),
                    Some(route.id()),
                    None,
                );
                return None;
            }
            return Some(node_name_for(node, sources_by_id, node_names));
        }
    }

    let Some(exit) = exits_by_id.get(route.exit_id()).copied() else {
        issues.add(
            IssueSeverity::Error,
            "missing-exit",
            format!("{}指向的出口已不存在", label),
            Some(route.id()),
            None,
        );
        return None;
    };
    if !exit.is_builtin() && !active_exits.iter().any(|active| active.id == exit.id) {
        issues.add(
            IssueSeverity::Error,
            "missing-exit",
            format!("{}指向的出口已不存在", label),
            Some(route.id()),
            None,
        );
        return None;
    }
    Some(exit.name.clone())
}

fn provider_key_for(route: &crate::model::RuleSetRoute, used: &mut HashSet<String>) -> String {
    let provider_name = route
        .provider_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(&route.name);
    let mut base = provider_slug(provider_name);
    if base == "ruleset" {
        let prefix: String = route.id.chars().take(4).collect();
        base = format!("ruleset-{}", prefix);
    }
    let mut key = base.clone();
    let mut index = 2;
    while used.contains(&key) {
        key = format!("{}-{}", base, index);
        index += 1;
    }
    used.insert(key.clone());
    key
}

pub fn generate_config(workspace: &Workspace, options: &GenerateOptions) -> GeneratedConfig {
    let mut issues = IssueCollector::new();
    let sources_by_id: HashMap<&str, &Source> = workspace
        .sources
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();

    let mut exits: Vec<&Exit> = workspace.exits.iter().collect();
    exits.sort_by(|left, right| {
        left.order
            .cmp(&right.order)
            .then_with(|| left.name.cmp(&right.name))
    });
    let exits_by_id: HashMap<&str, &Exit> =
        exits.iter().map(|exit| (exit.id.as_str(), *exit)).collect();
    let enabled_nodes: Vec<&ProxyNode> =
        workspace.nodes.iter().filter(|node| node.enabled).collect();
    let ctx = crate::resolve::ResolveContext {
        nodes: &workspace.nodes,
        exits: &workspace.exits,
        sources: &workspace.sources,
    };

    let mut node_names: HashMap<&str, String> = HashMap::new();
    let mut used_names: HashMap<String, String> = HashMap::new();
    for node in &enabled_nodes {
        let name = node_display_name(node, sources_by_id.get(node.source_id.as_str()).copied());
        node_names.insert(node.id.as_str(), name.clone());
        if name.trim().is_empty() {
            issues.error("empty-node-name", format!("节点「{}」没有名称", node.id));
            continue;
        }
        if has_control_chars(&name) || name.contains(',') {
            issues.error(
                "invalid-node-name",
                format!("节点名「{}」包含换行或逗号，无法写入规则/配置", name),
            );
        }
        if is_reserved(&name) {
            issues.error(
                "reserved-node-name",
                format!("节点名「{}」与内置出站冲突", name),
            );
        }
        let lower = name.to_lowercase();
        if let std::collections::hash_map::Entry::Vacant(entry) = used_names.entry(lower) {
            entry.insert(name);
        } else {
            issues.error(
                "duplicate-node-name",
                format!("节点导出名重复：「{}」", name),
            );
        }
    }

    for node in &enabled_nodes {
        let Some(chain) = node.chain.as_ref() else {
            continue;
        };
        let label = node_names
            .get(node.id.as_str())
            .cloned()
            .unwrap_or_else(|| node.name.clone());
        match workspace
            .nodes
            .iter()
            .find(|candidate| candidate.id == chain.relay_node_id)
        {
            None => issues.error(
                "chain-relay-missing",
                format!("链式节点「{}」的中转节点已不存在", label),
            ),
            Some(relay) if !relay.enabled => issues.error(
                "chain-relay-disabled",
                format!("链式节点「{}」的中转节点「{}」已禁用", label, relay.name),
            ),
            Some(_) => {}
        }
    }

    let active_exits: Vec<&Exit> = exits
        .iter()
        .copied()
        .filter(|exit| !exit.is_builtin())
        .collect();
    let mut group_names_lower: HashMap<String, &Exit> = HashMap::new();
    for exit in &active_exits {
        if !GROUP_TYPES.contains(&exit.kind.as_str()) {
            issues.add(
                IssueSeverity::Error,
                "invalid-exit-type",
                format!("出口「{}」的类型不受支持", exit.name),
                None,
                Some(exit.id.as_str()),
            );
        }
        if exit.name.trim().is_empty() || has_control_chars(&exit.name) || exit.name.contains(',') {
            issues.add(
                IssueSeverity::Error,
                "invalid-exit-name",
                format!("出口名「{}」包含换行、逗号或为空", exit.name),
                None,
                Some(exit.id.as_str()),
            );
        }
        if is_reserved(&exit.name) {
            issues.add(
                IssueSeverity::Error,
                "reserved-exit-name",
                format!("出口名「{}」与内置出站冲突", exit.name),
                None,
                Some(exit.id.as_str()),
            );
        }
        let lower = exit.name.to_lowercase();
        if group_names_lower.contains_key(&lower) {
            issues.add(
                IssueSeverity::Error,
                "duplicate-exit-name",
                format!("出口名称重复：「{}」", exit.name),
                None,
                Some(exit.id.as_str()),
            );
        } else {
            group_names_lower.insert(lower.clone(), exit);
        }
        if used_names.contains_key(&lower) {
            issues.add(
                IssueSeverity::Error,
                "exit-node-collision",
                format!("出口「{}」与节点重名，内核会拒绝该配置", exit.name),
                None,
                Some(exit.id.as_str()),
            );
        }
        let resolution = resolve_exit(exit, &ctx);
        if resolution.member_names.is_empty() {
            issues.add(
                IssueSeverity::Error,
                "empty-exit",
                format!("出口「{}」没有可用成员", exit.name),
                None,
                Some(exit.id.as_str()),
            );
        }
        for missing in &resolution.missing {
            issues.add(
                IssueSeverity::Error,
                "missing-member",
                format!(
                    "出口「{}」：{}（{}）",
                    exit.name, missing.reason, missing.value
                ),
                None,
                Some(exit.id.as_str()),
            );
        }
        for member_name in &resolution.member_names {
            if has_control_chars(member_name) || member_name.contains(',') {
                issues.add(
                    IssueSeverity::Error,
                    "invalid-member-name",
                    format!("出口「{}」的成员名包含换行或逗号", exit.name),
                    None,
                    Some(exit.id.as_str()),
                );
            }
        }
    }

    let proxies: Vec<Value> = enabled_nodes
        .iter()
        .map(|node| {
            let name = node_names
                .get(node.id.as_str())
                .cloned()
                .unwrap_or_else(|| node.name.clone());
            proxy_object(node, &name)
        })
        .collect();

    let mut groups: Vec<Value> = Vec::new();
    for exit in &active_exits {
        let resolution = resolve_exit(exit, &ctx);
        let mut group = Map::new();
        group.insert("name".to_string(), Value::String(exit.name.clone()));
        group.insert("type".to_string(), Value::String(exit.kind.clone()));
        group.insert(
            "proxies".to_string(),
            Value::Array(
                resolution
                    .member_names
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
        if exit.kind != "select" {
            group.insert(
                "url".to_string(),
                Value::String(
                    exit.test_url
                        .clone()
                        .unwrap_or_else(|| workspace.settings.test_url.clone()),
                ),
            );
            group.insert(
                "interval".to_string(),
                Value::Number((exit.interval.unwrap_or(300)).into()),
            );
            if exit.kind == "url-test" {
                group.insert(
                    "tolerance".to_string(),
                    Value::Number((exit.tolerance.unwrap_or(50)).into()),
                );
            }
        }
        groups.push(Value::Object(group));
    }

    let mut provider_keys: HashSet<String> = HashSet::new();
    let mut providers = Map::new();
    let mut rule_lines: Vec<String> = Vec::new();
    let match_route = workspace.routes.iter().find(|route| route.is_match());

    let mut duplicates: HashSet<String> = HashSet::new();
    for (index, route) in workspace.routes.iter().enumerate() {
        if !route.enabled() {
            continue;
        }
        if route.is_match() {
            continue;
        }

        let label = match route {
            Route::Rule(_) => "规则",
            Route::Ruleset(_) => "规则集",
        };
        let target = target_name(
            workspace,
            &sources_by_id,
            &node_names,
            &exits_by_id,
            &active_exits,
            &mut issues,
            route,
            label,
        );

        match route {
            Route::Rule(rule) => {
                if !SUPPORTED_RULE_TYPES.contains(&rule.rule_type.as_str())
                    || rule.rule_type == "MATCH"
                {
                    issues.add(
                        IssueSeverity::Error,
                        "unsupported-rule",
                        format!("不支持的规则类型：{}", rule.rule_type),
                        Some(rule.id.as_str()),
                        None,
                    );
                    continue;
                }
                if rule.rule_type == "RULE-SET" {
                    issues.add(
                        IssueSeverity::Error,
                        "manual-ruleset",
                        "RULE-SET 规则需要通过「规则集」页面创建，才能生成对应的 provider"
                            .to_string(),
                        Some(rule.id.as_str()),
                        None,
                    );
                    continue;
                }
                if rule.payload.trim().is_empty() {
                    issues.add(
                        IssueSeverity::Error,
                        "empty-rule-payload",
                        format!("规则 {} 的内容为空", rule.rule_type),
                        Some(rule.id.as_str()),
                        None,
                    );
                    continue;
                }
                if has_control_chars(&rule.payload) || rule.payload.contains(',') {
                    issues.add(
                        IssueSeverity::Error,
                        "invalid-rule-payload",
                        format!("规则内容包含换行或逗号：{}", rule.payload),
                        Some(rule.id.as_str()),
                        None,
                    );
                    continue;
                }
                if (rule.rule_type == "IP-CIDR" || rule.rule_type == "IP-CIDR6")
                    && !validate_ip_cidr(&rule.payload)
                {
                    issues.add(
                        IssueSeverity::Error,
                        "invalid-cidr",
                        format!("IP 规则格式无效：{}", rule.payload),
                        Some(rule.id.as_str()),
                        None,
                    );
                    continue;
                }
                if let Some((cover_index, _)) = find_covering_route(&workspace.routes, index) {
                    issues.add(
                        IssueSeverity::Warning,
                        "shadowed-rule",
                        format!(
                            "第 {} 条规则「{},{}」被第 {} 条完全覆盖",
                            index + 1,
                            rule.rule_type,
                            rule.payload,
                            cover_index + 1
                        ),
                        Some(rule.id.as_str()),
                        None,
                    );
                }
                if let Some(duplicate_index) = find_duplicate_route(
                    &workspace.routes,
                    &rule.rule_type,
                    &rule.payload,
                    Some(rule.id.as_str()),
                ) {
                    if !duplicates.contains(&rule.id) {
                        duplicates.insert(rule.id.clone());
                        issues.add(
                            IssueSeverity::Warning,
                            "duplicate-rule",
                            format!(
                                "第 {} 条规则与第 {} 条重复（{},{}）",
                                index + 1,
                                duplicate_index + 1,
                                rule.rule_type,
                                rule.payload
                            ),
                            Some(rule.id.as_str()),
                            None,
                        );
                    }
                }
                let Some(target) = target else {
                    continue;
                };
                let suffix = if rule.no_resolve.unwrap_or(false) {
                    ",no-resolve"
                } else {
                    ""
                };
                rule_lines.push(format!(
                    "{},{},{}{}",
                    rule.rule_type, rule.payload, target, suffix
                ));
            }
            Route::Ruleset(rule) => {
                let Some(target) = target else {
                    continue;
                };
                if rule.inline {
                    let inline_rules = rule.inline_rules.clone().unwrap_or_default();
                    if inline_rules.is_empty() {
                        issues.add(
                            IssueSeverity::Error,
                            "empty-inline-ruleset",
                            format!(
                                "规则集「{}」已设为内联，但没有展开内容，请刷新规则集",
                                rule.name
                            ),
                            Some(rule.id.as_str()),
                            None,
                        );
                        continue;
                    }
                    for inline in &inline_rules {
                        if !SUPPORTED_RULE_TYPES.contains(&inline.rule_type.as_str()) {
                            issues.add(
                                IssueSeverity::Error,
                                "unsupported-inline-rule",
                                format!(
                                    "规则集「{}」包含不支持的规则类型 {}",
                                    rule.name, inline.rule_type
                                ),
                                Some(rule.id.as_str()),
                                None,
                            );
                            continue;
                        }
                        if (inline.rule_type == "IP-CIDR" || inline.rule_type == "IP-CIDR6")
                            && !validate_ip_cidr(&inline.payload)
                        {
                            issues.add(
                                IssueSeverity::Error,
                                "invalid-cidr",
                                format!(
                                    "规则集「{}」包含无效 IP 规则：{}",
                                    rule.name, inline.payload
                                ),
                                Some(rule.id.as_str()),
                                None,
                            );
                            continue;
                        }
                        let suffix = if inline.no_resolve.unwrap_or(false) {
                            ",no-resolve"
                        } else {
                            ""
                        };
                        rule_lines.push(format!(
                            "{},{},{}{}",
                            inline.rule_type, inline.payload, target, suffix
                        ));
                    }
                    continue;
                }

                if rule.format == "mrs" && rule.behavior == "classical" {
                    issues.add(
                        IssueSeverity::Warning,
                        "mrs-classical",
                        format!(
                            "规则集「{}」使用 MRS 与 classical，内核可能不支持",
                            rule.name
                        ),
                        Some(rule.id.as_str()),
                        None,
                    );
                }
                if rule.source.kind == "file" && !Path::new(&rule.source.value).exists() {
                    issues.add(
                        IssueSeverity::Error,
                        "missing-ruleset-file",
                        format!(
                            "规则集文件不存在：{}",
                            rule.source
                                .file_name
                                .clone()
                                .unwrap_or_else(|| rule.source.value.clone())
                        ),
                        Some(rule.id.as_str()),
                        None,
                    );
                    continue;
                }
                let source_url = rule.source.value.to_lowercase();
                if rule.source.kind == "url"
                    && !(source_url.starts_with("http://") || source_url.starts_with("https://"))
                {
                    issues.add(
                        IssueSeverity::Error,
                        "invalid-ruleset-url",
                        format!("规则集「{}」的来源地址无效", rule.name),
                        Some(rule.id.as_str()),
                        None,
                    );
                    continue;
                }

                let key = provider_key_for(rule, &mut provider_keys);
                let mut provider = Map::new();
                provider.insert(
                    "type".to_string(),
                    Value::String(if rule.source.kind == "url" {
                        "http".to_string()
                    } else {
                        "file".to_string()
                    }),
                );
                provider.insert("behavior".to_string(), Value::String(rule.behavior.clone()));
                provider.insert("format".to_string(), Value::String(rule.format.clone()));
                if rule.source.kind == "url" {
                    provider.insert("url".to_string(), Value::String(rule.source.value.clone()));
                    provider.insert(
                        "path".to_string(),
                        Value::String(format!(
                            "./rule-sets/{}.{}",
                            key,
                            provider_extension(&rule.format)
                        )),
                    );
                    provider.insert(
                        "interval".to_string(),
                        Value::Number((rule.interval.unwrap_or(86400)).into()),
                    );
                } else {
                    provider.insert(
                        "path".to_string(),
                        Value::String(rule.source.value.replace('\\', "/")),
                    );
                }
                providers.insert(key.clone(), Value::Object(provider));
                let suffix = if rule.no_resolve.unwrap_or(false) {
                    ",no-resolve"
                } else {
                    ""
                };
                rule_lines.push(format!("RULE-SET,{},{}{}", key, target, suffix));
            }
        }
    }

    if let Some(match_route) = match_route {
        if let Some(target) = target_name(
            workspace,
            &sources_by_id,
            &node_names,
            &exits_by_id,
            &active_exits,
            &mut issues,
            match_route,
            "MATCH 规则",
        ) {
            rule_lines.push(format!("MATCH,{}", target));
        }
    } else {
        issues.warning(
            "missing-match",
            "工作区没有 MATCH 兜底规则，未匹配流量将使用内核默认行为".to_string(),
        );
    }

    if enabled_nodes.is_empty() {
        issues.warning(
            "no-nodes",
            "当前没有启用节点，导出的配置不包含 proxies".to_string(),
        );
    }

    let mut document = options.base_settings.clone().unwrap_or_default();
    for key in ["proxies", "proxy-groups", "rule-providers", "rules"] {
        document.remove(key);
    }
    let group_count = groups.len();
    if !proxies.is_empty() {
        document.insert("proxies".to_string(), Value::Array(proxies));
    }
    if !groups.is_empty() {
        document.insert("proxy-groups".to_string(), Value::Array(groups));
    }
    if !providers.is_empty() {
        document.insert("rule-providers".to_string(), Value::Object(providers));
    }
    document.insert(
        "rules".to_string(),
        Value::Array(rule_lines.iter().cloned().map(Value::String).collect()),
    );

    let yaml_body = serde_yaml::to_string(&document).expect("serialize generated config");
    let has_base = options
        .base_settings
        .as_ref()
        .map(|settings| !settings.is_empty())
        .unwrap_or(false);
    let base_note = if has_base {
        "基础设置来自 Clash Verge 当前配置（不含控制器与密钥）"
    } else {
        "仅包含节点、出口、规则集与规则，不含端口 / DNS / TUN"
    };
    let yaml = format!(
        "# Generated by Clash Route Desk\n# {}\n{}",
        base_note, yaml_body
    );

    let mut issue_list = issues.issues;
    issue_list.sort_by_key(|issue| match issue.severity {
        IssueSeverity::Error => 0,
        IssueSeverity::Warning => 1,
    });

    GeneratedConfig {
        yaml,
        issues: issue_list,
        counts: ExportCounts {
            nodes: enabled_nodes.len(),
            exits: group_count,
            providers: provider_keys.len(),
            rules: rule_lines.len(),
        },
    }
}
