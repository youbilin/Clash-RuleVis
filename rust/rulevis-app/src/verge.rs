use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::types::BaseTemplateInfo;

const BASE_KEYS: &[&str] = &[
    "mixed-port",
    "port",
    "socks-port",
    "redir-port",
    "tproxy-port",
    "allow-lan",
    "bind-address",
    "mode",
    "log-level",
    "ipv6",
    "unified-delay",
    "tcp-concurrent",
    "find-process-mode",
    "geodata-mode",
    "geodata-loader",
    "geo-auto-update",
    "interface-name",
    "routing-mark",
    "hosts",
    "dns",
    "profile",
    "sniffer",
    "tun",
];

pub struct BaseTemplate {
    pub values: Map<String, Value>,
    pub info: BaseTemplateInfo,
}

struct VergeInfo {
    dir: PathBuf,
    runtime: Option<Map<String, Value>>,
    profile_name: Option<String>,
    profile: Option<Map<String, Value>>,
}

fn verge_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(app_data) = env::var_os("APPDATA") {
        let root = PathBuf::from(app_data);
        for name in [
            "io.github.clash-verge-rev.clash-verge-rev",
            "top.gydi.clashverge",
            "clash-verge",
            "clash-verge-rev",
        ] {
            dirs.push(root.join(name));
        }
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local_app_data).join("io.github.clash-verge-rev.clash-verge-rev"));
    }
    dirs
}

fn parse_yaml_file(path: &Path) -> Option<Map<String, Value>> {
    let raw = fs::read_to_string(path).ok()?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&raw).ok()?;
    let value = serde_json::to_value(yaml).ok()?;
    value.as_object().cloned()
}

fn read_verge_info() -> Option<VergeInfo> {
    for dir in verge_dirs() {
        let config_path = dir.join("config.yaml");
        if !config_path.is_file() {
            continue;
        }
        let runtime = parse_yaml_file(&config_path);
        let mut profile_name = None;
        let mut profile = None;

        if let Some(profiles) = parse_yaml_file(&dir.join("profiles.yaml")) {
            let current = profiles.get("current").and_then(Value::as_str);
            if let Some(items) = profiles.get("items").and_then(Value::as_array) {
                let active = items.iter().find(|item| {
                    current.is_some() && item.get("uid").and_then(Value::as_str) == current
                });
                if let Some(active) = active {
                    profile_name = active
                        .get("name")
                        .and_then(Value::as_str)
                        .or(current)
                        .map(str::to_string);
                    if let Some(file) = active.get("file").and_then(Value::as_str) {
                        if let Some(file_name) = Path::new(file).file_name() {
                            profile = parse_yaml_file(&dir.join("profiles").join(file_name));
                        }
                    }
                }
            }
        }

        return Some(VergeInfo {
            dir,
            runtime,
            profile_name,
            profile,
        });
    }
    None
}

fn apply_keys(values: &mut Map<String, Value>, config: &Map<String, Value>) {
    for key in BASE_KEYS {
        if !values.contains_key(*key) {
            if let Some(value) = config.get(*key) {
                values.insert((*key).to_string(), value.clone());
            }
        }
    }
}

pub fn read_base_template() -> BaseTemplate {
    let mut values = Map::new();
    let mut source = "Clash Verge 运行时配置".to_string();

    if let Some(verge) = read_verge_info() {
        if let Some(runtime) = &verge.runtime {
            apply_keys(&mut values, runtime);
        }
        if let Some(profile) = &verge.profile {
            apply_keys(&mut values, profile);
            source = if verge.runtime.is_some() {
                "Clash Verge 运行时配置 + 当前配置".to_string()
            } else {
                verge
                    .profile_name
                    .clone()
                    .unwrap_or_else(|| "Clash Verge 当前配置".to_string())
            };
        }
        if let Some(dns_config) = parse_yaml_file(&verge.dir.join("dns_config.yaml")) {
            if let Some(dns) = dns_config.get("dns").filter(|value| value.is_object()) {
                values.insert("dns".to_string(), dns.clone());
            }
        }
    }

    let keys: Vec<String> = BASE_KEYS
        .iter()
        .filter(|key| values.contains_key(**key))
        .map(|key| (*key).to_string())
        .collect();
    if keys.is_empty() {
        return BaseTemplate {
            values,
            info: BaseTemplateInfo {
                included: false,
                source: None,
                keys,
                warning: Some("未找到 Clash Verge 当前生效配置".to_string()),
            },
        };
    }
    BaseTemplate {
        values,
        info: BaseTemplateInfo {
            included: true,
            source: Some(source),
            keys,
            warning: None,
        },
    }
}

pub fn active_profile_name() -> Option<String> {
    read_verge_info().and_then(|verge| verge.profile_name)
}
