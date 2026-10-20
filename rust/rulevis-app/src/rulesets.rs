use std::fs;
use std::path::{Component, Path, PathBuf};

use rulevis_core::model::InlineRule;
use rulevis_core::resolve::{is_ipv4, is_ipv6};
use serde_json::Value;
use uuid::Uuid;

use crate::importer::parse_rule_line;
use crate::types::RuleSetInspect;

const INLINE_RULE_TYPES: &[&str] = &[
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

fn looks_binary(buffer: &[u8]) -> bool {
    buffer.iter().take(4096).any(|byte| *byte == 0)
}

fn format_from_hint(hint: &str) -> Option<String> {
    let lower = hint.to_lowercase();
    if lower.contains(".mrs") {
        return Some("mrs".to_string());
    }
    if lower.contains(".yaml") || lower.contains(".yml") {
        return Some("yaml".to_string());
    }
    if lower.contains(".txt") || lower.contains(".list") {
        return Some("text".to_string());
    }
    None
}

fn behavior_from_hint(hint: &str) -> Option<String> {
    let lower = hint.to_lowercase();
    if lower.contains("geoip")
        || lower.contains("ipcidr")
        || lower.contains("ip-list")
        || lower.contains("/ip")
        || lower.contains("cn-ip")
        || lower.contains("ip.")
    {
        return Some("ipcidr".to_string());
    }
    if lower.contains("geosite") || lower.contains("domain") {
        return Some("domain".to_string());
    }
    None
}

fn payload_lines(text: &str, format: &str) -> Vec<String> {
    if format == "yaml" {
        if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(text) {
            if let Ok(value) = serde_json::to_value(yaml) {
                if let Some(items) = value.as_array() {
                    return items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                }
                if let Some(items) = value.get("payload").and_then(Value::as_array) {
                    return items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                }
            }
        }
    }
    text.lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with('#')
                && !line.starts_with("//")
                && !line.starts_with("payload:")
                && !line.starts_with("rules:")
        })
        .map(str::to_string)
        .collect()
}

fn is_classical_rule(line: &str) -> bool {
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    if parts.len() < 2 {
        return false;
    }
    let kind = parts[0].to_uppercase();
    INLINE_RULE_TYPES.contains(&kind.as_str()) || kind == "RULE-SET" || kind == "MATCH"
}

fn count_rules(lines: &[String]) -> u64 {
    if lines.iter().any(|line| is_classical_rule(line)) {
        lines.iter().filter(|line| is_classical_rule(line)).count() as u64
    } else {
        lines.len() as u64
    }
}

fn guess_behavior(lines: &[String], hint: &str) -> String {
    let hinted = behavior_from_hint(hint);
    let sample: Vec<&String> = lines.iter().take(200).collect();
    if sample.iter().any(|line| is_classical_rule(line)) {
        return "classical".to_string();
    }
    let total = sample.len();
    let ip_count = sample
        .iter()
        .filter(|line| {
            let candidate = line.split('/').next().unwrap_or("");
            is_ipv4(line) || is_ipv6(line) || is_ipv4(candidate) || is_ipv6(candidate)
        })
        .count();
    if total > 0 && (ip_count as f64 / total as f64) > 0.5 {
        return "ipcidr".to_string();
    }
    hinted.unwrap_or_else(|| "domain".to_string())
}

pub fn inspect_buffer(buffer: &[u8], file_name: Option<&str>, url: Option<&str>) -> RuleSetInspect {
    let hint = url.or(file_name).unwrap_or("");
    let binary = looks_binary(buffer);
    let hinted_format = format_from_hint(hint);
    let text = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(buffer)
            .trim_start_matches('\u{feff}')
            .to_string()
    };
    let mut format = if binary {
        "mrs".to_string()
    } else {
        hinted_format.clone().unwrap_or_else(|| "text".to_string())
    };
    if !binary && (hinted_format.is_none() || hinted_format.as_deref() == Some("text")) {
        let lower = text.trim_start();
        if lower.starts_with("payload:") || lower.starts_with("rules:") {
            format = "yaml".to_string();
        }
    }
    if format == "mrs" && !binary && hinted_format.as_deref() != Some("mrs") {
        format = "text".to_string();
    }

    if format == "mrs" {
        return RuleSetInspect {
            format,
            behavior: behavior_from_hint(hint).unwrap_or_else(|| "domain".to_string()),
            rule_count: None,
            sample: Vec::new(),
            size: buffer.len() as u64,
            text_available: false,
            file_name: file_name.map(str::to_string),
            stored_path: None,
            source_type: if url.is_some() { "url" } else { "file" }.to_string(),
            source_value: url.unwrap_or("").to_string(),
        };
    }

    let lines = payload_lines(&text, &format);
    RuleSetInspect {
        format,
        behavior: guess_behavior(&lines, hint),
        rule_count: Some(count_rules(&lines)),
        sample: lines.iter().take(6).cloned().collect(),
        size: buffer.len() as u64,
        text_available: true,
        file_name: file_name.map(str::to_string),
        stored_path: None,
        source_type: if url.is_some() { "url" } else { "file" }.to_string(),
        source_value: url.unwrap_or("").to_string(),
    }
}

pub fn expand_ruleset(
    buffer: &[u8],
    behavior: &str,
    format: &str,
) -> Result<Vec<InlineRule>, String> {
    if format == "mrs" {
        return Err("MRS 是二进制格式，无法内联展开".to_string());
    }
    let text = String::from_utf8_lossy(buffer)
        .trim_start_matches('\u{feff}')
        .to_string();
    let lines = payload_lines(&text, format);
    let mut result = Vec::new();
    for line in lines {
        if behavior == "classical" {
            let Some(rule) = parse_rule_line(&line) else {
                continue;
            };
            if !INLINE_RULE_TYPES.contains(&rule.kind.as_str()) {
                continue;
            }
            result.push(InlineRule {
                rule_type: rule.kind,
                payload: rule.payload,
                no_resolve: rule.no_resolve.then_some(true),
            });
            continue;
        }
        if behavior == "domain" {
            let mut payload = line.trim().to_string();
            if payload.is_empty() || payload.starts_with('#') || payload.starts_with("//") {
                continue;
            }
            let mut kind = "DOMAIN".to_string();
            if payload.starts_with("+.") || payload.starts_with("*.") || payload.starts_with('.') {
                payload = payload
                    .trim_start_matches("+.")
                    .trim_start_matches("*.")
                    .trim_start_matches('.')
                    .to_string();
                kind = "DOMAIN-SUFFIX".to_string();
            }
            if payload.is_empty() || payload.contains(' ') || payload.contains('/') {
                continue;
            }
            result.push(InlineRule {
                rule_type: kind,
                payload,
                no_resolve: None,
            });
            continue;
        }
        let payload = line.trim().to_string();
        if payload.is_empty() {
            continue;
        }
        let ip_part = payload.split('/').next().unwrap_or("");
        if is_ipv6(ip_part) {
            result.push(InlineRule {
                rule_type: "IP-CIDR6".to_string(),
                payload,
                no_resolve: Some(true),
            });
        } else if is_ipv4(ip_part) {
            result.push(InlineRule {
                rule_type: "IP-CIDR".to_string(),
                payload,
                no_resolve: Some(true),
            });
        }
    }
    Ok(result)
}

pub fn sanitize_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "ruleset.txt".to_string());
    let cleaned: String = base
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if cleaned.is_empty() {
        "ruleset.txt".to_string()
    } else {
        cleaned
    }
}

pub fn store_ruleset_file(
    data_dir: &Path,
    buffer: &[u8],
    file_name: &str,
) -> Result<PathBuf, String> {
    let directory = data_dir.join("rule-sets");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建规则集目录：{}", error))?;
    let safe = sanitize_file_name(file_name);
    let path = directory.join(format!("{}-{}", Uuid::new_v4(), safe));
    fs::write(&path, buffer).map_err(|error| format!("无法保存规则集文件：{}", error))?;
    Ok(path)
}

pub fn is_path_inside(parent: &Path, child: &Path) -> bool {
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    let Ok(child) = child.canonicalize() else {
        return false;
    };
    if !child.starts_with(&parent) {
        return false;
    }
    child
        .components()
        .all(|component| !matches!(component, Component::ParentDir))
}
