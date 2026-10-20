use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const WORKSPACE_VERSION: u32 = 2;

fn default_true() -> bool {
    true
}

fn default_workspace_version() -> u32 {
    WORKSPACE_VERSION
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionUserinfo {
    #[serde(default)]
    pub used: u64,
    #[serde(default)]
    pub total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expire: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub keep_rules: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub userinfo: Option<SubscriptionUserinfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainMeta {
    pub relay_node_id: String,
    pub landing_node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNode {
    pub id: String,
    pub source_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub raw: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub added_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<ChainMeta>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitMember {
    pub by: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exit {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub members: Vec<ExitMember>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default)]
    pub order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tolerance: Option<i64>,
}

impl Exit {
    pub fn is_builtin(&self) -> bool {
        self.builtin.unwrap_or(false)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleRoute {
    pub id: String,
    #[serde(rename = "type")]
    pub rule_type: String,
    #[serde(default)]
    pub payload: String,
    #[serde(default)]
    pub exit_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_resolve: Option<bool>,
    #[serde(default = "default_rule_origin")]
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
}

fn default_rule_origin() -> String {
    "manual".to_string()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineRule {
    #[serde(rename = "type")]
    pub rule_type: String,
    pub payload: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_resolve: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetSource {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetRoute {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    pub behavior: String,
    pub format: String,
    pub source: RuleSetSource,
    #[serde(default)]
    pub inline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_rules: Option<Vec<InlineRule>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_count: Option<u64>,
    #[serde(default)]
    pub exit_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_resolve: Option<bool>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Route {
    Rule(RuleRoute),
    Ruleset(RuleSetRoute),
}

impl Route {
    pub fn id(&self) -> &str {
        match self {
            Route::Rule(route) => &route.id,
            Route::Ruleset(route) => &route.id,
        }
    }

    pub fn enabled(&self) -> bool {
        match self {
            Route::Rule(route) => route.enabled,
            Route::Ruleset(route) => route.enabled,
        }
    }

    pub fn exit_id(&self) -> &str {
        match self {
            Route::Rule(route) => &route.exit_id,
            Route::Ruleset(route) => &route.exit_id,
        }
    }

    pub fn is_match(&self) -> bool {
        matches!(self, Route::Rule(route) if route.rule_type == "MATCH")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceSettings {
    pub onboarded: bool,
    pub test_url: String,
    pub retention_minutes: u32,
    pub subscription_user_agent: String,
    pub use_proxy_for_fetch: bool,
    pub default_rule_type: String,
    pub include_base_template: bool,
    pub favorite_exit_ids: Vec<String>,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            onboarded: false,
            test_url: "https://www.gstatic.com/generate_204".to_string(),
            retention_minutes: 5,
            subscription_user_agent: "clash-verge/v2.5.8".to_string(),
            use_proxy_for_fetch: true,
            default_rule_type: "DOMAIN-SUFFIX".to_string(),
            include_base_template: true,
            favorite_exit_ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub rule_count: usize,
    #[serde(default)]
    pub node_count: usize,
    #[serde(default)]
    pub exit_count: usize,
    #[serde(default)]
    pub provider_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default = "default_workspace_version")]
    pub version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub nodes: Vec<ProxyNode>,
    #[serde(default)]
    pub exits: Vec<Exit>,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default)]
    pub settings: WorkspaceSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_export: Option<ExportRecord>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Error,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigIssue {
    pub severity: IssueSeverity,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCounts {
    pub nodes: usize,
    pub exits: usize,
    pub providers: usize,
    pub rules: usize,
}
