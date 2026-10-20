use std::collections::{HashMap, HashSet};

use rulevis_core::resolve::{is_ipv4, is_ipv6};

use crate::kernel::{Kernel, MihomoConnection, MihomoProvider, MihomoProxy, MihomoRule};
use crate::types::{
    KernelGroupStatus, KernelProviderStatus, KernelStatus, LiveDomainConnection, LiveSnapshot,
    LiveStats, LiveVariant,
};

const HISTORY_POINTS: usize = 40;

#[derive(Clone)]
struct LedgerEntry {
    download: u64,
    upload: u64,
}

struct Agg {
    key: String,
    host: String,
    display_host: String,
    is_ip: bool,
    destination_ip: Option<String>,
    destination_port: Option<String>,
    network: Option<String>,
    inbound: Option<String>,
    rule: String,
    rule_type: String,
    rule_payload: String,
    chains: Vec<String>,
    exit_name: Option<String>,
    node_name: Option<String>,
    processes: HashSet<String>,
    process_paths: HashSet<String>,
    download: f64,
    upload: f64,
    rate_down: f64,
    rate_up: f64,
    history: Vec<u64>,
    count: u64,
    active: u64,
    first_seen: u64,
    last_seen: u64,
    variants: Vec<LiveVariant>,
}

pub struct LiveAggregator {
    aggs: HashMap<String, Agg>,
    ledger: HashMap<String, LedgerEntry>,
    groups: HashMap<String, KernelGroupStatus>,
    providers: HashMap<String, KernelProviderStatus>,
    rule_hits: HashMap<String, u64>,
    proxy_hits: HashMap<String, u64>,
    last_poll_at: u64,
    last_aux_poll: u64,
    last_rules_poll: u64,
    snapshot: LiveSnapshot,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_rule_type(raw: &str) -> String {
    let mapped = match raw {
        "Domain" => Some("DOMAIN"),
        "DomainSuffix" => Some("DOMAIN-SUFFIX"),
        "DomainKeyword" => Some("DOMAIN-KEYWORD"),
        "DomainRegex" => Some("DOMAIN-REGEX"),
        "GeoSite" => Some("GEOSITE"),
        "GeoIP" => Some("GEOIP"),
        "IPCIDR" => Some("IP-CIDR"),
        "IPCIDR6" => Some("IP-CIDR6"),
        "SrcIPCIDR" => Some("SRC-IP-CIDR"),
        "ProcessName" => Some("PROCESS-NAME"),
        "ProcessPath" => Some("PROCESS-PATH"),
        "RuleSet" => Some("RULE-SET"),
        "Match" => Some("MATCH"),
        "DstPort" => Some("DST-PORT"),
        "SrcPort" => Some("SRC-PORT"),
        "Network" => Some("NETWORK"),
        "InPort" => Some("IN-PORT"),
        _ => None,
    };
    if let Some(mapped) = mapped {
        return mapped.to_string();
    }
    if raw.is_empty() {
        return "UNKNOWN".to_string();
    }
    let mut output = String::new();
    let chars: Vec<char> = raw.chars().collect();
    for (index, character) in chars.iter().enumerate() {
        if character.is_uppercase() && index > 0 {
            let previous = chars[index - 1];
            if previous.is_lowercase() || previous.is_ascii_digit() {
                output.push('-');
            }
        }
        output.push(*character);
    }
    output.to_uppercase()
}

fn process_name(connection: &MihomoConnection) -> Option<String> {
    let raw = connection
        .metadata
        .process_path
        .as_deref()
        .or(connection.metadata.process.as_deref())?;
    raw.rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| Some(raw.to_string()))
}

fn connection_host(connection: &MihomoConnection) -> (String, bool, String, Option<String>) {
    let host = connection
        .metadata
        .host
        .as_deref()
        .or(connection.metadata.sniff_host.as_deref())
        .unwrap_or("")
        .trim()
        .to_string();
    let destination_ip = connection
        .metadata
        .remote_destination
        .as_deref()
        .or(connection.metadata.destination_ip.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if !host.is_empty() {
        let is_ip = is_ipv4(&host) || is_ipv6(&host);
        return (host.clone(), is_ip, host, destination_ip);
    }
    if let Some(destination_ip) = destination_ip.clone() {
        return (
            destination_ip.clone(),
            true,
            destination_ip.clone(),
            Some(destination_ip),
        );
    }
    (String::new(), false, "未知目标".to_string(), None)
}

impl LiveAggregator {
    pub fn new(kernel_status: KernelStatus) -> Self {
        Self {
            aggs: HashMap::new(),
            ledger: HashMap::new(),
            groups: HashMap::new(),
            providers: HashMap::new(),
            rule_hits: HashMap::new(),
            proxy_hits: HashMap::new(),
            last_poll_at: 0,
            last_aux_poll: 0,
            last_rules_poll: 0,
            snapshot: LiveSnapshot::offline(kernel_status),
        }
    }

    pub fn snapshot(&self) -> LiveSnapshot {
        self.snapshot.clone()
    }

    pub fn poll(&mut self, kernel: &mut Kernel, retention_minutes: u32) {
        let started_at = now_millis();
        let elapsed = if self.last_poll_at == 0 {
            1.0
        } else {
            ((started_at.saturating_sub(self.last_poll_at)) as f64 / 1000.0).max(0.2)
        };
        self.last_poll_at = started_at;

        let connections = kernel.connections().ok();
        if let Some(connections) = connections {
            self.ingest(
                connections.connections,
                started_at,
                elapsed,
                retention_minutes,
            );
            self.poll_aux(kernel, started_at);
        }
        self.snapshot = self.build_snapshot(kernel.status());
    }

    fn poll_aux(&mut self, kernel: &mut Kernel, now: u64) {
        if now.saturating_sub(self.last_aux_poll) > 5000 {
            self.last_aux_poll = now;
            if let Ok(proxies) = kernel.proxies() {
                self.update_groups(proxies.proxies);
            }
        }
        if now.saturating_sub(self.last_rules_poll) > 10_000 {
            self.last_rules_poll = now;
            if let (Ok(rules), Ok(providers)) = (kernel.rules(), kernel.providers()) {
                self.update_rules(rules.rules);
                self.update_providers(providers.providers);
            }
        }
    }

    fn ingest(
        &mut self,
        connections: Vec<MihomoConnection>,
        now: u64,
        elapsed: f64,
        retention_minutes: u32,
    ) {
        let mut next_ledger = HashMap::new();
        let mut variants: HashMap<String, HashMap<String, (LiveVariant, u64)>> = HashMap::new();
        let mut active_by_key: HashMap<String, u64> = HashMap::new();

        for connection in connections {
            let (host, is_ip, display_host, destination_ip) = connection_host(&connection);
            let key = if host.is_empty() {
                "host:unknown".to_string()
            } else {
                format!("host:{}", host.to_lowercase())
            };
            if !self.aggs.contains_key(&key) {
                self.aggs.insert(
                    key.clone(),
                    Agg {
                        key: key.clone(),
                        host,
                        display_host: display_host.clone(),
                        is_ip,
                        destination_ip: destination_ip.clone(),
                        destination_port: connection.metadata.destination_port.clone(),
                        network: connection.metadata.network.clone(),
                        inbound: connection.metadata.inbound_name.clone(),
                        rule: connection.rule.clone(),
                        rule_type: normalize_rule_type(&connection.rule),
                        rule_payload: connection.rule_payload.clone(),
                        chains: connection.chains.clone(),
                        exit_name: None,
                        node_name: None,
                        processes: HashSet::new(),
                        process_paths: HashSet::new(),
                        download: 0.0,
                        upload: 0.0,
                        rate_down: 0.0,
                        rate_up: 0.0,
                        history: vec![0; HISTORY_POINTS],
                        count: 0,
                        active: 0,
                        first_seen: now,
                        last_seen: now,
                        variants: Vec::new(),
                    },
                );
            }

            let previous = self.ledger.get(&connection.id).cloned();
            let is_new = previous.is_none();
            let down_delta = previous
                .as_ref()
                .map(|previous| connection.download.saturating_sub(previous.download))
                .unwrap_or(connection.download);
            let up_delta = previous
                .as_ref()
                .map(|previous| connection.upload.saturating_sub(previous.upload))
                .unwrap_or(connection.upload);
            next_ledger.insert(
                connection.id.clone(),
                LedgerEntry {
                    download: connection.download,
                    upload: connection.upload,
                },
            );

            let agg = self.aggs.get_mut(&key).expect("aggregate exists");
            agg.download += down_delta as f64;
            agg.upload += up_delta as f64;
            if !is_new {
                agg.rate_down = agg.rate_down * 0.55 + (down_delta as f64 / elapsed) * 0.45;
                agg.rate_up = agg.rate_up * 0.55 + (up_delta as f64 / elapsed) * 0.45;
            }
            if is_new {
                agg.count += 1;
            }
            agg.display_host = display_host;
            agg.is_ip = is_ip;
            if destination_ip.is_some() {
                agg.destination_ip = destination_ip;
            }
            if connection.metadata.destination_port.is_some() {
                agg.destination_port = connection.metadata.destination_port.clone();
            }
            if connection.metadata.network.is_some() {
                agg.network = connection.metadata.network.clone();
            }
            if connection.metadata.inbound_name.is_some() {
                agg.inbound = connection.metadata.inbound_name.clone();
            }
            if !connection.rule.is_empty() {
                agg.rule = connection.rule.clone();
                agg.rule_type = normalize_rule_type(&connection.rule);
            }
            if !connection.rule_payload.is_empty() {
                agg.rule_payload = connection.rule_payload.clone();
            }
            if !connection.chains.is_empty() {
                agg.chains = connection.chains.clone();
            }
            agg.exit_name = if agg.chains.len() > 1 {
                agg.chains.last().cloned()
            } else {
                None
            };
            agg.node_name = agg.chains.first().cloned();
            if let Some(process) = process_name(&connection) {
                agg.processes.insert(process);
            }
            if let Some(path) = &connection.metadata.process_path {
                agg.process_paths.insert(path.clone());
            }
            agg.last_seen = now;
            let active = active_by_key.get(&key).copied().unwrap_or(0) + 1;
            active_by_key.insert(key.clone(), active);
            agg.active = active;

            let variant_key = format!(
                "{}|{}|{}|{}",
                agg.rule_type,
                agg.rule_payload,
                agg.exit_name.clone().unwrap_or_default(),
                agg.node_name.clone().unwrap_or_default()
            );
            let by_agg = variants.entry(key.clone()).or_default();
            if let Some((variant, count)) = by_agg.get_mut(&variant_key) {
                *count += 1;
                variant.count = *count;
            } else {
                by_agg.insert(
                    variant_key,
                    (
                        LiveVariant {
                            rule: agg.rule.clone(),
                            rule_type: agg.rule_type.clone(),
                            rule_payload: agg.rule_payload.clone(),
                            exit_name: agg.exit_name.clone(),
                            node_name: agg.node_name.clone(),
                            count: 1,
                            last_seen: now,
                        },
                        1,
                    ),
                );
            }
        }

        self.ledger = next_ledger;
        for agg in self.aggs.values_mut() {
            let active = active_by_key.get(&agg.key).copied().unwrap_or(0);
            agg.active = active;
            if active == 0 {
                agg.rate_down *= 0.35;
                agg.rate_up *= 0.35;
                if agg.rate_down < 1.0 {
                    agg.rate_down = 0.0;
                }
                if agg.rate_up < 1.0 {
                    agg.rate_up = 0.0;
                }
            }
            agg.history
                .push((agg.rate_down + agg.rate_up).round() as u64);
            if agg.history.len() > HISTORY_POINTS {
                let excess = agg.history.len() - HISTORY_POINTS;
                agg.history.drain(0..excess);
            }
            if let Some(by_agg) = variants.get(&agg.key) {
                let mut entries: Vec<(LiveVariant, u64)> = by_agg.values().cloned().collect();
                entries.sort_by(|left, right| right.1.cmp(&left.1));
                agg.variants = entries
                    .into_iter()
                    .take(6)
                    .map(|(variant, count)| LiveVariant { count, ..variant })
                    .collect();
            }
        }

        let cutoff = now.saturating_sub(u64::from(retention_minutes) * 60_000);
        self.aggs
            .retain(|_, agg| agg.active > 0 || agg.last_seen >= cutoff);
    }

    fn update_groups(&mut self, proxies: HashMap<String, MihomoProxy>) {
        let mut groups = HashMap::new();
        for (map_name, proxy) in proxies {
            if !matches!(
                proxy.kind.as_str(),
                "Selector" | "URLTest" | "Fallback" | "LoadBalance"
            ) {
                continue;
            }
            let delay = proxy
                .history
                .last()
                .map(|item| item.delay)
                .filter(|delay| *delay > 0);
            let name = if proxy.name.is_empty() {
                map_name
            } else {
                proxy.name
            };
            groups.insert(
                name.clone(),
                KernelGroupStatus {
                    name,
                    kind: proxy.kind,
                    now: proxy.now,
                    member_count: proxy.all.len(),
                    delay,
                },
            );
        }
        self.groups = groups;
    }

    fn update_rules(&mut self, rules: Vec<MihomoRule>) {
        let mut hits: HashMap<String, u64> = HashMap::new();
        let mut proxy_hits: HashMap<String, u64> = HashMap::new();
        for rule in rules {
            let kind = normalize_rule_type(&rule.kind);
            let count = rule
                .extra
                .as_ref()
                .and_then(|extra| extra.hit_count)
                .unwrap_or(0);
            *hits
                .entry(format!("{}|{}", kind, rule.payload))
                .or_insert(0) += count;
            if !rule.proxy.is_empty() {
                *proxy_hits.entry(rule.proxy).or_insert(0) += count;
            }
        }
        self.rule_hits = hits;
        self.proxy_hits = proxy_hits;
    }

    fn update_providers(&mut self, providers: HashMap<String, MihomoProvider>) {
        let mut next = HashMap::new();
        for (name, provider) in providers {
            let hit_count = self
                .rule_hits
                .get(&format!("RULE-SET|{}", name))
                .copied()
                .unwrap_or(0);
            next.insert(
                name.clone(),
                KernelProviderStatus {
                    name: if provider.name.is_empty() {
                        name
                    } else {
                        provider.name
                    },
                    behavior: provider.behavior.unwrap_or_default(),
                    format: provider.format.unwrap_or_default(),
                    rule_count: provider.rule_count.unwrap_or(0),
                    updated_at: provider.updated_at,
                    vehicle_type: provider.vehicle_type.unwrap_or_default(),
                    hit_count,
                },
            );
        }
        self.providers = next;
    }

    fn build_snapshot(&self, kernel: KernelStatus) -> LiveSnapshot {
        let mut connections: Vec<LiveDomainConnection> = self
            .aggs
            .values()
            .map(|agg| LiveDomainConnection {
                key: agg.key.clone(),
                host: agg.host.clone(),
                display_host: agg.display_host.clone(),
                is_ip: agg.is_ip,
                destination_ip: agg.destination_ip.clone(),
                destination_port: agg.destination_port.clone(),
                network: agg.network.clone(),
                inbound: agg.inbound.clone(),
                rule: agg.rule.clone(),
                rule_type: agg.rule_type.clone(),
                rule_payload: agg.rule_payload.clone(),
                chains: agg.chains.clone(),
                exit_name: agg.exit_name.clone(),
                node_name: agg.node_name.clone(),
                processes: agg.processes.iter().cloned().collect(),
                process_paths: agg.process_paths.iter().cloned().collect(),
                download: agg.download.round() as u64,
                upload: agg.upload.round() as u64,
                rate_down: agg.rate_down.round() as u64,
                rate_up: agg.rate_up.round() as u64,
                history: agg.history.clone(),
                count: agg.count,
                active: agg.active,
                first_seen: agg.first_seen,
                last_seen: agg.last_seen,
                variants: agg.variants.clone(),
            })
            .collect();
        connections.sort_by(|left, right| {
            right
                .active
                .cmp(&left.active)
                .then_with(|| right.last_seen.cmp(&left.last_seen))
        });

        let active_connections = connections.iter().map(|item| item.active).sum();
        let down_rate = connections.iter().map(|item| item.rate_down).sum();
        let up_rate = connections.iter().map(|item| item.rate_up).sum();
        let total_down = connections.iter().map(|item| item.download).sum();
        let total_up = connections.iter().map(|item| item.upload).sum();
        LiveSnapshot {
            generated_at: now_millis(),
            stats: LiveStats {
                active_connections,
                domains: connections.len(),
                down_rate,
                up_rate,
                total_down,
                total_up,
            },
            connections,
            kernel,
            groups: self.groups.clone(),
            providers: self.providers.clone(),
            rule_hits: self.rule_hits.clone(),
            proxy_hits: self.proxy_hits.clone(),
        }
    }
}
