use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use rulevis_core::model::{ConfigIssue, ExportCounts, ExportRecord, Workspace};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub at: String,
    pub label: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts: Option<ExportCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryFile {
    pub entry: HistoryEntry,
    pub workspace: Workspace,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseTemplateInfo {
    pub included: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelValidation {
    pub available: bool,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl KernelValidation {
    pub fn unavailable(message: &str) -> Self {
        Self {
            available: false,
            ok: false,
            binary: None,
            duration_ms: None,
            output: None,
            error: Some(message.to_string()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStatus {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixed_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovering: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<u64>,
}

impl KernelStatus {
    pub fn disconnected(error: Option<String>, discovering: bool) -> Self {
        Self {
            connected: false,
            transport: None,
            endpoint: None,
            version: None,
            mode: None,
            mixed_port: None,
            error,
            discovering: Some(discovering),
            last_seen_at: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCounts {
    pub sources: usize,
    pub nodes: usize,
    pub exits: usize,
    pub rules: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusWorkspace {
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_export: Option<ExportRecord>,
    pub counts: StatusCounts,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCounts {
    pub sources: usize,
    pub nodes: usize,
    pub exits: usize,
    pub routes: usize,
    pub pending: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelGroupStatus {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub now: Option<String>,
    pub member_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelProviderStatus {
    pub name: String,
    pub behavior: String,
    pub format: String,
    pub rule_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub vehicle_type: String,
    pub hit_count: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveVariant {
    pub rule: String,
    pub rule_type: String,
    pub rule_payload: String,
    pub exit_name: Option<String>,
    pub node_name: Option<String>,
    pub count: u64,
    pub last_seen: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDomainConnection {
    pub key: String,
    pub host: String,
    pub display_host: String,
    pub is_ip: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inbound: Option<String>,
    pub rule: String,
    pub rule_type: String,
    pub rule_payload: String,
    pub chains: Vec<String>,
    pub exit_name: Option<String>,
    pub node_name: Option<String>,
    pub processes: Vec<String>,
    pub process_paths: Vec<String>,
    pub download: u64,
    pub upload: u64,
    pub rate_down: u64,
    pub rate_up: u64,
    pub history: Vec<u64>,
    pub count: u64,
    pub active: u64,
    pub first_seen: u64,
    pub last_seen: u64,
    pub variants: Vec<LiveVariant>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStats {
    pub active_connections: u64,
    pub domains: usize,
    pub down_rate: u64,
    pub up_rate: u64,
    pub total_down: u64,
    pub total_up: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub generated_at: u64,
    pub connections: Vec<LiveDomainConnection>,
    pub stats: LiveStats,
    pub kernel: KernelStatus,
    pub groups: std::collections::HashMap<String, KernelGroupStatus>,
    pub providers: std::collections::HashMap<String, KernelProviderStatus>,
    pub rule_hits: std::collections::HashMap<String, u64>,
    pub proxy_hits: std::collections::HashMap<String, u64>,
}

impl LiveSnapshot {
    pub fn offline(kernel: KernelStatus) -> Self {
        Self {
            generated_at: u64::try_from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis())
                    .unwrap_or(0),
            )
            .unwrap_or(0),
            connections: Vec::new(),
            stats: LiveStats {
                active_connections: 0,
                domains: 0,
                down_rate: 0,
                up_rate: 0,
                total_down: 0,
                total_up: 0,
            },
            kernel,
            groups: std::collections::HashMap::new(),
            providers: std::collections::HashMap::new(),
            rule_hits: std::collections::HashMap::new(),
            proxy_hits: std::collections::HashMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub kernel: KernelStatus,
    pub version: String,
    pub data_dir: String,
    pub exports_dir: String,
    pub workspace: StatusWorkspace,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verge_profile: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetInspect {
    pub format: String,
    pub behavior: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_count: Option<u64>,
    pub sample: Vec<String>,
    pub size: u64,
    pub text_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored_path: Option<String>,
    pub source_type: String,
    pub source_value: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub yaml: String,
    pub issues: Vec<ConfigIssue>,
    pub counts: ExportCounts,
    pub generated_at: String,
    pub file_name: String,
    pub diff: Option<String>,
    pub previous_export_at: Option<String>,
    pub base_settings: BaseTemplateInfo,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    #[serde(flatten)]
    pub preview: ExportPreview,
    pub path: String,
    pub history_id: String,
    pub workspace: Workspace,
    pub validation: KernelValidation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub snapshot: WorkspaceCounts,
    pub current: WorkspaceCounts,
}

#[derive(Debug, Serialize)]
pub struct ApiFailure {
    pub status: u16,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(flatten)]
    pub extra: Box<Map<String, Value>>,
}

impl ApiFailure {
    pub fn new(status: u16, error: impl Into<String>) -> Self {
        Self {
            status,
            error: error.into(),
            code: None,
            extra: Box::new(Map::new()),
        }
    }

    pub fn bad_request(error: impl Into<String>) -> Self {
        Self::new(400, error)
    }

    pub fn not_found(error: impl Into<String>) -> Self {
        Self::new(404, error)
    }

    pub fn unavailable(error: impl Into<String>) -> Self {
        Self::new(501, error).with_code("DESKTOP_UNAVAILABLE")
    }

    pub fn internal(error: impl Into<String>) -> Self {
        Self::new(500, error)
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn with_value(mut self, key: &str, value: Value) -> Self {
        self.extra.insert(key.to_string(), value);
        self
    }
}
