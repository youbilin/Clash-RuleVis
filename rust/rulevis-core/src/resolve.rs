use std::collections::{HashMap, HashSet};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::model::{Exit, ProxyNode, Route, RuleRoute, Source, Workspace};

pub fn node_display_name(node: &ProxyNode, source: Option<&Source>) -> String {
    format!(
        "{}{}",
        source.map(|value| value.prefix.as_str()).unwrap_or(""),
        node.name
    )
}

pub fn node_tag_labels(node: &ProxyNode) -> Vec<String> {
    let mut labels = Vec::with_capacity(node.tags.len() + 1);
    if let Some(region) = node.region.as_deref() {
        labels.push(region.to_string());
    }
    labels.extend(node.tags.iter().cloned());
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for label in labels {
        let trimmed = label.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            result.push(trimmed.to_string());
        }
    }
    result
}

pub fn is_ipv4(value: &str) -> bool {
    let parts: Vec<&str> = value.trim().split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|part| {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        if part.len() > 1 && part.starts_with('0') {
            return false;
        }
        part.parse::<u16>()
            .map(|number| number <= 255)
            .unwrap_or(false)
    })
}

pub fn is_ipv6(value: &str) -> bool {
    value.contains(':')
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() || matches!(character, ':' | '.' | '%'))
}

fn number_from_js(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let number: f64 = trimmed.parse().ok()?;
    number.is_finite().then_some(number)
}

pub fn validate_ip_cidr(payload: &str) -> bool {
    let mut parts = payload.split('/');
    let Some(ip) = parts.next() else {
        return false;
    };
    let Some(bits_raw) = parts.next() else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    let Some(bits) = number_from_js(bits_raw) else {
        return false;
    };
    if bits.fract() != 0.0 {
        return false;
    }
    if is_ipv4(ip) {
        return (0.0..=32.0).contains(&bits);
    }
    if is_ipv6(ip) {
        return (0.0..=128.0).contains(&bits);
    }
    false
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MissingRef {
    pub by: String,
    pub value: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default)]
pub struct ExitResolution {
    pub nodes: Vec<ProxyNode>,
    pub nested: Vec<Exit>,
    pub missing: Vec<MissingRef>,
    pub all_node_ids: Vec<String>,
    pub member_names: Vec<String>,
}

pub struct ResolveContext<'a> {
    pub nodes: &'a [ProxyNode],
    pub exits: &'a [Exit],
    pub sources: &'a [Source],
}

fn add_missing(
    missing: &mut Vec<MissingRef>,
    seen: &mut HashSet<String>,
    by: &str,
    value: &str,
    reason: &str,
) {
    let key = format!("{}|{}|{}", by, value, reason);
    if seen.insert(key) {
        missing.push(MissingRef {
            by: by.to_string(),
            value: value.to_string(),
            reason: reason.to_string(),
        });
    }
}

fn build_regex(value: &str) -> Option<Regex> {
    RegexBuilder::new(value).case_insensitive(true).build().ok()
}

#[allow(clippy::too_many_arguments)]
fn walk(
    current: &Exit,
    depth: usize,
    stack: &mut Vec<String>,
    nodes: &[ProxyNode],
    exits_by_id: &HashMap<&str, &Exit>,
    sources_by_id: &HashMap<&str, &Source>,
    direct_nodes: &mut Vec<ProxyNode>,
    nested: &mut Vec<Exit>,
    missing: &mut Vec<MissingRef>,
    missing_seen: &mut HashSet<String>,
    all_node_ids: &mut Vec<String>,
    all_node_id_set: &mut HashSet<String>,
) {
    for member in &current.members {
        match member.by.as_str() {
            "node" => {
                let Some(node) = nodes.iter().find(|node| node.id == member.value) else {
                    add_missing(missing, missing_seen, "node", &member.value, "节点已不存在");
                    continue;
                };
                if !node.enabled {
                    let name = node_display_name(
                        node,
                        sources_by_id.get(node.source_id.as_str()).copied(),
                    );
                    add_missing(missing, missing_seen, "node", &name, "节点已禁用");
                    continue;
                }
                if all_node_id_set.insert(node.id.clone()) {
                    all_node_ids.push(node.id.clone());
                }
                if depth == 0 {
                    direct_nodes.push(node.clone());
                }
            }
            "tag" => {
                let tag = member.value.trim().to_lowercase();
                let matched: Vec<&ProxyNode> = nodes
                    .iter()
                    .filter(|node| {
                        node.enabled
                            && node_tag_labels(node)
                                .iter()
                                .any(|label| label.to_lowercase() == tag)
                    })
                    .collect();
                if matched.is_empty() {
                    add_missing(
                        missing,
                        missing_seen,
                        "tag",
                        &member.value,
                        "没有匹配的已启用节点",
                    );
                    continue;
                }
                for node in matched {
                    if all_node_id_set.insert(node.id.clone()) {
                        all_node_ids.push(node.id.clone());
                    }
                    if depth == 0 {
                        direct_nodes.push(node.clone());
                    }
                }
            }
            "regex" => {
                let Some(regex) = build_regex(&member.value) else {
                    add_missing(
                        missing,
                        missing_seen,
                        "regex",
                        &member.value,
                        "正则表达式无效",
                    );
                    continue;
                };
                let matched: Vec<&ProxyNode> = nodes
                    .iter()
                    .filter(|node| {
                        node.enabled
                            && regex.is_match(&node_display_name(
                                node,
                                sources_by_id.get(node.source_id.as_str()).copied(),
                            ))
                    })
                    .collect();
                if matched.is_empty() {
                    add_missing(
                        missing,
                        missing_seen,
                        "regex",
                        &member.value,
                        "没有匹配的已启用节点",
                    );
                    continue;
                }
                for node in matched {
                    if all_node_id_set.insert(node.id.clone()) {
                        all_node_ids.push(node.id.clone());
                    }
                    if depth == 0 {
                        direct_nodes.push(node.clone());
                    }
                }
            }
            "exit" => {
                let Some(child) = exits_by_id.get(member.value.as_str()).copied() else {
                    add_missing(missing, missing_seen, "exit", &member.value, "出口已不存在");
                    continue;
                };
                if stack.iter().any(|id| id == &child.id) {
                    add_missing(missing, missing_seen, "exit", &child.name, "嵌套出口形成环");
                    continue;
                }
                if depth == 0 {
                    nested.push(child.clone());
                }
                stack.push(child.id.clone());
                walk(
                    child,
                    depth + 1,
                    stack,
                    nodes,
                    exits_by_id,
                    sources_by_id,
                    direct_nodes,
                    nested,
                    missing,
                    missing_seen,
                    all_node_ids,
                    all_node_id_set,
                );
                stack.pop();
            }
            _ => {}
        }
    }
}

pub fn resolve_exit(exit: &Exit, ctx: &ResolveContext<'_>) -> ExitResolution {
    let exits_by_id: HashMap<&str, &Exit> = ctx
        .exits
        .iter()
        .map(|candidate| (candidate.id.as_str(), candidate))
        .collect();
    let sources_by_id: HashMap<&str, &Source> = ctx
        .sources
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();

    let mut direct_nodes = Vec::new();
    let mut nested = Vec::new();
    let mut missing = Vec::new();
    let mut missing_seen = HashSet::new();
    let mut all_node_ids = Vec::new();
    let mut all_node_id_set = HashSet::new();
    let mut stack = vec![exit.id.clone()];

    walk(
        exit,
        0,
        &mut stack,
        ctx.nodes,
        &exits_by_id,
        &sources_by_id,
        &mut direct_nodes,
        &mut nested,
        &mut missing,
        &mut missing_seen,
        &mut all_node_ids,
        &mut all_node_id_set,
    );

    let mut seen_nodes = HashSet::new();
    let unique_nodes: Vec<ProxyNode> = direct_nodes
        .into_iter()
        .filter(|node| seen_nodes.insert(node.id.clone()))
        .collect();

    let mut member_names = Vec::new();
    let mut seen_names = HashSet::new();
    for node in &unique_nodes {
        let name = node_display_name(node, sources_by_id.get(node.source_id.as_str()).copied());
        if seen_names.insert(name.clone()) {
            member_names.push(name);
        }
    }
    for child in &nested {
        if seen_names.insert(child.name.clone()) {
            member_names.push(child.name.clone());
        }
    }

    ExitResolution {
        nodes: unique_nodes,
        nested,
        missing,
        all_node_ids,
        member_names,
    }
}

pub fn provider_slug(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut slug = String::new();
    let mut pending_dash = false;
    for character in lower.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(character);
        } else {
            pending_dash = true;
        }
    }
    if slug.is_empty() {
        "ruleset".to_string()
    } else {
        slug
    }
}

fn normalize_domain(value: &str) -> String {
    let trimmed = value.trim().to_lowercase();
    trimmed
        .trim_start_matches(['*', '+', '.'])
        .trim_end_matches('.')
        .to_string()
}

fn ipv4_to_number(ip: &str) -> Option<u32> {
    if !is_ipv4(ip) {
        return None;
    }
    let mut value: u32 = 0;
    for part in ip.split('.') {
        value = (value << 8) + part.parse::<u32>().ok()?;
    }
    Some(value)
}

#[derive(Clone, Copy, Debug)]
struct ParsedCidr {
    base: u32,
    bits: u8,
}

fn parse_cidr(value: &str) -> Option<ParsedCidr> {
    let (ip, bits_raw) = value.split_once('/').unwrap_or((value, "32"));
    let base = ipv4_to_number(ip)?;
    let bits = number_from_js(bits_raw)?;
    if bits.fract() != 0.0 || !(0.0..=32.0).contains(&bits) {
        return None;
    }
    let bits = bits as u8;
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(bits))
    };
    Some(ParsedCidr {
        base: base & mask,
        bits,
    })
}

fn cidr_contains(outer: &str, inner: &str) -> bool {
    let Some(a) = parse_cidr(outer) else {
        return false;
    };
    let Some(b) = parse_cidr(inner) else {
        return false;
    };
    if b.bits < a.bits {
        return false;
    }
    let mask = if a.bits == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(a.bits))
    };
    (b.base & mask) == a.base
}

pub fn covers_rule(earlier: &RuleRoute, later: &RuleRoute) -> bool {
    if !earlier.enabled || !later.enabled {
        return false;
    }
    if earlier.rule_type == "MATCH" {
        return later.rule_type != "MATCH";
    }
    if later.rule_type == "MATCH" {
        return false;
    }

    let a = normalize_domain(&earlier.payload);
    let b = normalize_domain(&later.payload);

    match earlier.rule_type.as_str() {
        "DOMAIN" => match later.rule_type.as_str() {
            "DOMAIN" => a == b,
            "DOMAIN-KEYWORD" => b.contains(&a),
            _ => false,
        },
        "DOMAIN-SUFFIX" => match later.rule_type.as_str() {
            "DOMAIN" | "DOMAIN-SUFFIX" => {
                b == a || (!a.is_empty() && b.ends_with(&format!(".{}", a)))
            }
            _ => false,
        },
        "DOMAIN-KEYWORD" => match later.rule_type.as_str() {
            "DOMAIN" | "DOMAIN-SUFFIX" | "DOMAIN-KEYWORD" => b.contains(&a),
            _ => false,
        },
        "IP-CIDR" if later.rule_type == "IP-CIDR" => {
            cidr_contains(&earlier.payload, &later.payload)
        }
        "PROCESS-NAME" if later.rule_type == "PROCESS-NAME" => a == b,
        _ => earlier.rule_type == later.rule_type && a == b,
    }
}

pub fn find_covering_route(routes: &[Route], index: usize) -> Option<(usize, &Route)> {
    let route = routes.get(index)?;
    let Route::Rule(rule) = route else {
        return None;
    };
    if rule.rule_type == "MATCH" {
        return None;
    }
    for (candidate_index, candidate) in routes.iter().take(index).enumerate() {
        if let Route::Rule(candidate_rule) = candidate {
            if covers_rule(candidate_rule, rule) {
                return Some((candidate_index, candidate));
            }
        }
    }
    None
}

pub fn find_duplicate_route(
    routes: &[Route],
    rule_type: &str,
    payload: &str,
    except_id: Option<&str>,
) -> Option<usize> {
    routes.iter().position(|route| {
        if Some(route.id()) == except_id {
            return false;
        }
        match route {
            Route::Rule(rule) => {
                rule.rule_type == rule_type
                    && rule.payload.trim().to_lowercase() == payload.trim().to_lowercase()
            }
            Route::Ruleset(_) => false,
        }
    })
}

pub fn workspace_resolve_context(workspace: &Workspace) -> ResolveContext<'_> {
    ResolveContext {
        nodes: &workspace.nodes,
        exits: &workspace.exits,
        sources: &workspace.sources,
    }
}
