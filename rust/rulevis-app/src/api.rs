use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use rulevis_core::defaults::MANUAL_SOURCE_NOTE;
use rulevis_core::model::{
    ChainMeta, Exit, InlineRule, ProxyNode, Route, RuleSetRoute, RuleSetSource, Source, Workspace,
};
use rulevis_core::resolve::{resolve_exit, ResolveContext};

use crate::export::{build_preview, export_config, ExportError};
use crate::fetcher::{fetch_url, parse_subscription_userinfo};
use crate::importer::{
    apply_parsed_config, dedupe_key, parse_config_text, suggest_prefix, ParsedConfig,
};
use crate::kernel::{test_node_with, Kernel, KernelSettings};
use crate::live::LiveAggregator;
use crate::probe::probe_through_proxy;
use crate::rulesets::{expand_ruleset, inspect_buffer, is_path_inside, store_ruleset_file};
use crate::share::ShareServer;
use crate::storage::{now_iso, NewHistory, Store, StoreError};
use crate::types::{ApiFailure, AppStatus, KernelStatus, StatusCounts, StatusWorkspace};
use crate::validation::validate_config;
use crate::verge;

pub struct AppState {
    store: Arc<Mutex<Store>>,
    kernel: Arc<Mutex<Kernel>>,
    live: Arc<Mutex<LiveAggregator>>,
    share: Mutex<ShareServer>,
}

impl AppState {
    pub fn load(data_dir: std::path::PathBuf) -> Result<Self, String> {
        let store = Store::load(data_dir)?;
        let kernel = Kernel::load(&store.data_dir);
        let live = LiveAggregator::new(kernel.status());
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            kernel: Arc::new(Mutex::new(kernel)),
            live: Arc::new(Mutex::new(live)),
            share: Mutex::new(ShareServer::new()),
        })
    }

    pub fn start_background(&self) {
        let store = self.store.clone();
        let kernel = self.kernel.clone();
        let live = self.live.clone();
        let _ = std::thread::Builder::new()
            .name("rulevis-live".to_string())
            .spawn(move || loop {
                let retention = store
                    .lock()
                    .map(|store| store.workspace().settings.retention_minutes)
                    .unwrap_or(5);
                if let Ok(mut kernel) = kernel.lock() {
                    kernel.ensure_connected();
                    if let Ok(mut live) = live.lock() {
                        live.poll(&mut kernel, retention);
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            });
    }
}

fn store_failure(error: StoreError) -> ApiFailure {
    match error {
        StoreError::Conflict(workspace) => {
            ApiFailure::new(409, "工作区已在其他窗口或后台任务中更新，请重新加载").with_value(
                "workspace",
                serde_json::to_value(*workspace).unwrap_or(Value::Null),
            )
        }
        StoreError::Message(message) => ApiFailure::internal(message),
    }
}

fn serialize<T: serde::Serialize>(value: T) -> Result<Value, ApiFailure> {
    serde_json::to_value(value)
        .map_err(|error| ApiFailure::internal(format!("响应序列化失败：{}", error)))
}

fn with_store<T>(
    state: &AppState,
    handle: impl FnOnce(&mut Store) -> Result<T, ApiFailure>,
) -> Result<T, ApiFailure> {
    let mut store = state
        .store
        .lock()
        .map_err(|_| ApiFailure::internal("工作区锁不可用，请重启应用"))?;
    handle(&mut store)
}

fn with_kernel<T>(
    state: &AppState,
    handle: impl FnOnce(&mut Kernel) -> Result<T, ApiFailure>,
) -> Result<T, ApiFailure> {
    let mut kernel = state
        .kernel
        .lock()
        .map_err(|_| ApiFailure::internal("内核状态锁不可用，请重启应用"))?;
    handle(&mut kernel)
}

fn with_live<T>(
    state: &AppState,
    handle: impl FnOnce(&LiveAggregator) -> Result<T, ApiFailure>,
) -> Result<T, ApiFailure> {
    let live = state
        .live
        .lock()
        .map_err(|_| ApiFailure::internal("实时数据锁不可用，请重启应用"))?;
    handle(&live)
}

fn workspace_counts(workspace: &Workspace) -> crate::types::WorkspaceCounts {
    crate::types::WorkspaceCounts {
        sources: workspace.sources.len(),
        nodes: workspace.nodes.len(),
        exits: workspace
            .exits
            .iter()
            .filter(|exit| !exit.is_builtin())
            .count(),
        rules: workspace.routes.len(),
    }
}

fn status_value(store: &Store, kernel: KernelStatus) -> Result<Value, ApiFailure> {
    let workspace = store.workspace();
    let status = AppStatus {
        kernel,
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: store.data_dir.to_string_lossy().to_string(),
        exports_dir: store.exports_dir.to_string_lossy().to_string(),
        workspace: StatusWorkspace {
            revision: workspace.revision,
            last_export: workspace.last_export.clone(),
            counts: StatusCounts {
                sources: workspace.sources.len(),
                nodes: workspace.nodes.len(),
                exits: workspace
                    .exits
                    .iter()
                    .filter(|exit| !exit.is_builtin())
                    .count(),
                routes: workspace.routes.len(),
                pending: workspace
                    .routes
                    .iter()
                    .filter(|route| match route {
                        Route::Rule(rule) => rule.pending.unwrap_or(false),
                        Route::Ruleset(rule) => rule.pending.unwrap_or(false),
                    })
                    .count(),
            },
        },
        verge_profile: verge::active_profile_name(),
    };
    serialize(status)
}

fn body_object(body: Option<&Value>) -> Map<String, Value> {
    body.and_then(Value::as_object).cloned().unwrap_or_default()
}

fn required_string(
    body: &Map<String, Value>,
    field: &str,
    label: &str,
    max_length: usize,
) -> Result<String, ApiFailure> {
    let value = body
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if value.is_empty() {
        return Err(ApiFailure::bad_request(format!("{}不能为空", label)));
    }
    if value.chars().count() > max_length {
        return Err(ApiFailure::bad_request(format!("{}过长", label)));
    }
    Ok(value.to_string())
}

fn optional_string(body: &Map<String, Value>, field: &str) -> Option<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn path_tail<'a>(path: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    let rest = path.strip_prefix(prefix)?;
    let rest = rest.strip_suffix(suffix)?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest)
}

fn validate_http_url(raw: &str) -> Result<String, ApiFailure> {
    let url = url::Url::parse(raw.trim()).map_err(|_| ApiFailure::bad_request("地址格式无效"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ApiFailure::bad_request("只支持 http / https 地址"));
    }
    Ok(url.to_string())
}

fn normalize_source_name(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(60).collect())
        .unwrap_or_else(|| fallback.to_string())
}

fn normalize_prefix(value: Option<&Value>, fallback: &str) -> Result<String, ApiFailure> {
    let Some(value) = value else {
        return Ok(fallback.to_string());
    };
    let Some(value) = value.as_str() else {
        return Err(ApiFailure::bad_request("节点前缀格式无效"));
    };
    let trimmed = value.trim();
    if trimmed.chars().count() > 24 {
        return Err(ApiFailure::bad_request("节点前缀不能超过 24 个字符"));
    }
    if trimmed.contains(',') || trimmed.contains('\n') || trimmed.contains('\r') {
        return Err(ApiFailure::bad_request("节点前缀不能包含逗号或换行"));
    }
    Ok(trimmed.to_string())
}

fn save_kernel_settings(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let mode = match body.get("mode").and_then(Value::as_str) {
        Some("pipe") => "pipe",
        Some("tcp") => "tcp",
        _ => "auto",
    };
    let endpoint = optional_string(&body, "endpoint");
    if mode != "auto" && endpoint.is_none() {
        return Err(ApiFailure::bad_request("手动模式需要填写控制器地址"));
    }
    with_kernel(state, |kernel| {
        let secret = match body.get("secret").and_then(Value::as_str) {
            Some(secret) => {
                let secret = secret.trim();
                if secret.is_empty() {
                    None
                } else {
                    Some(secret.to_string())
                }
            }
            None => kernel.settings.secret.clone(),
        };
        let next = KernelSettings {
            mode: mode.to_string(),
            endpoint,
            secret,
        };
        kernel
            .save_settings(next)
            .map_err(ApiFailure::bad_request)?;
        Ok(json!({
            "status": kernel.status(),
            "settings": kernel.settings_view()
        }))
    })
}

fn source_fetch_context(state: &AppState) -> (String, Option<u16>) {
    let (user_agent, use_proxy) = with_store(state, |store| {
        Ok((
            store.workspace().settings.subscription_user_agent.clone(),
            store.workspace().settings.use_proxy_for_fetch,
        ))
    })
    .unwrap_or_else(|_| ("clash-verge/v2.5.8".to_string(), false));
    let proxy_port = if use_proxy {
        with_kernel(state, |kernel| Ok(kernel.mixed_port())).unwrap_or(None)
    } else {
        None
    };
    (user_agent, proxy_port)
}

fn test_url_for(state: &AppState) -> String {
    with_store(state, |store| {
        Ok(store.workspace().settings.test_url.clone())
    })
    .unwrap_or_else(|_| "https://www.gstatic.com/generate_204".to_string())
}

fn import_subscription(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let url = validate_http_url(
        body.get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiFailure::bad_request("订阅地址不能为空"))?,
    )?;
    let fallback_name = url::Url::parse(&url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| "订阅".to_string());
    let name = normalize_source_name(body.get("name"), &fallback_name);
    let prefix = normalize_prefix(body.get("prefix"), &suggest_prefix(&name))?;
    let keep_rules = body.get("keepRules").and_then(Value::as_bool) == Some(true);
    let (user_agent, proxy_port) = source_fetch_context(state);
    let fetched = fetch_url(&url, &user_agent, proxy_port, 30_000)
        .map_err(|error| ApiFailure::new(502, error))?;
    let parsed = parse_config_text(&fetched.text).map_err(|error| ApiFailure::new(422, error))?;
    let userinfo = parse_subscription_userinfo(
        fetched
            .headers
            .get("subscription-userinfo")
            .map(String::as_str),
    );
    let source = Source {
        id: Uuid::new_v4().to_string(),
        kind: "subscription".to_string(),
        name: name.clone(),
        url: Some(url),
        prefix,
        keep_rules,
        updated_at: Some(now_iso()),
        userinfo: userinfo.clone(),
        note: None,
    };
    apply_source_import(
        state,
        source,
        parsed,
        keep_rules,
        false,
        userinfo,
        format!("导入订阅 · {}", name),
    )
}

fn import_content(state: &AppState, body: Option<Value>, kind: &str) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let content = body.get("content").and_then(Value::as_str).unwrap_or("");
    if content.trim().is_empty() {
        return Err(ApiFailure::bad_request(if kind == "file" {
            "文件内容为空"
        } else {
            "粘贴内容为空"
        }));
    }
    if content.len() > 20 * 1024 * 1024 {
        return Err(ApiFailure::new(413, "内容过大（上限 20MB）"));
    }
    let fallback_name = if kind == "file" {
        "本地配置"
    } else {
        "粘贴配置"
    };
    let name = normalize_source_name(body.get("name"), fallback_name);
    let prefix = normalize_prefix(body.get("prefix"), "")?;
    let keep_rules = body.get("keepRules").and_then(Value::as_bool) == Some(true);
    let parsed = parse_config_text(content).map_err(|error| ApiFailure::new(422, error))?;
    let source = Source {
        id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        name: name.clone(),
        url: None,
        prefix,
        keep_rules,
        updated_at: Some(now_iso()),
        userinfo: None,
        note: None,
    };
    let label = if kind == "file" {
        format!("导入文件 · {}", name)
    } else {
        format!("粘贴导入 · {}", name)
    };
    apply_source_import(state, source, parsed, keep_rules, false, None, label)
}

fn import_verge(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let Some((profile_name, profile_path)) = verge::active_profile() else {
        return Err(ApiFailure::not_found(
            "未找到 Clash Verge 当前生效的配置文件",
        ));
    };
    let content = std::fs::read_to_string(&profile_path)
        .map_err(|error| ApiFailure::internal(format!("读取 Verge 配置失败：{}", error)))?;
    let parsed = parse_config_text(&content).map_err(|error| ApiFailure::new(422, error))?;
    let existing = with_store(state, |store| {
        Ok(store
            .workspace()
            .sources
            .iter()
            .find(|source| source.kind == "verge")
            .cloned())
    })?;
    let keep_rules = body
        .get("keepRules")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if let Some(mut source) = existing.clone() {
        source.keep_rules = keep_rules;
        if body.get("prefix").is_some() {
            source.prefix = normalize_prefix(body.get("prefix"), &source.prefix)?;
        }
        source.updated_at = Some(now_iso());
        source.note = Some(profile_path.to_string_lossy().to_string());
        return apply_source_import(
            state,
            source,
            parsed,
            keep_rules,
            true,
            None,
            "从 Verge 重新导入".to_string(),
        );
    }
    let prefix = normalize_prefix(body.get("prefix"), "")?;
    let source = Source {
        id: Uuid::new_v4().to_string(),
        kind: "verge".to_string(),
        name: normalize_source_name(body.get("name"), &profile_name),
        url: None,
        prefix,
        keep_rules,
        updated_at: Some(now_iso()),
        userinfo: None,
        note: Some(profile_path.to_string_lossy().to_string()),
    };
    apply_source_import(
        state,
        source,
        parsed,
        keep_rules,
        false,
        None,
        "从 Verge 当前配置导入".to_string(),
    )
}

fn refresh_source(state: &AppState, id: &str, _body: Option<Value>) -> Result<Value, ApiFailure> {
    let source = with_store(state, |store| {
        store
            .workspace()
            .sources
            .iter()
            .find(|source| source.id == id)
            .cloned()
            .ok_or_else(|| ApiFailure::not_found("来源不存在"))
    })?;
    let mut updated = source.clone();
    let parsed = match source.kind.as_str() {
        "subscription" => {
            let url = source
                .url
                .clone()
                .ok_or_else(|| ApiFailure::bad_request("该订阅没有可刷新的地址"))?;
            let (user_agent, proxy_port) = source_fetch_context(state);
            let fetched = fetch_url(&url, &user_agent, proxy_port, 30_000)
                .map_err(|error| ApiFailure::new(502, error))?;
            updated.userinfo = parse_subscription_userinfo(
                fetched
                    .headers
                    .get("subscription-userinfo")
                    .map(String::as_str),
            );
            parse_config_text(&fetched.text).map_err(|error| ApiFailure::new(422, error))?
        }
        "verge" => {
            let Some((_name, path)) = verge::active_profile() else {
                return Err(ApiFailure::not_found("未找到 Clash Verge 当前配置文件"));
            };
            let content = std::fs::read_to_string(&path)
                .map_err(|error| ApiFailure::internal(format!("读取 Verge 配置失败：{}", error)))?;
            parse_config_text(&content).map_err(|error| ApiFailure::new(422, error))?
        }
        _ => return Err(ApiFailure::bad_request("该来源不支持刷新，请重新导入")),
    };
    updated.updated_at = Some(now_iso());
    apply_source_import(
        state,
        updated,
        parsed,
        source.keep_rules,
        true,
        source.userinfo.clone(),
        format!("刷新来源 · {}", source.name),
    )
}

fn apply_source_import(
    state: &AppState,
    source: Source,
    parsed: ParsedConfig,
    keep_rules: bool,
    is_refresh: bool,
    userinfo: Option<rulevis_core::model::SubscriptionUserinfo>,
    history_label: String,
) -> Result<Value, ApiFailure> {
    let name = source.name.clone();
    with_store(state, |store| {
        let (result, workspace) = store
            .mutate(|workspace| {
                let target = if let Some(existing) = workspace
                    .sources
                    .iter_mut()
                    .find(|item| item.id == source.id)
                {
                    existing.updated_at = Some(now_iso());
                    existing.keep_rules = keep_rules;
                    if is_refresh {
                        existing.name = source.name.clone();
                        existing.prefix = source.prefix.clone();
                        existing.note = source.note.clone();
                        existing.url = source.url.clone();
                    }
                    if userinfo.is_some() {
                        existing.userinfo = userinfo.clone();
                    }
                    existing.clone()
                } else {
                    workspace.sources.push(source.clone());
                    source.clone()
                };
                let result =
                    apply_parsed_config(workspace, &target, &parsed, is_refresh, keep_rules);
                Ok(result)
            })
            .map_err(store_failure)?;
        let note = if is_refresh {
            format!(
                "新增 {}，消失 {}，变化 {}",
                result.added, result.removed, result.changed
            )
        } else {
            format!(
                "导入 {} 个节点 / {} 个策略组 / {} 条规则",
                result.added, result.groups, result.rules
            )
        };
        let _ = store.add_history(
            NewHistory {
                label: history_label,
                kind: "manual".to_string(),
                note: Some(note),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        );
        Ok(json!({
            "workspace": workspace,
            "added": result.added,
            "deduped": result.deduped,
            "groups": result.groups,
            "rules": result.rules,
            "skippedRules": result.skipped_rules,
            "warnings": result.warnings,
            "removed": result.removed,
            "changed": result.changed,
            "sourceName": name
        }))
    })
}

fn test_delays(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let names: Vec<String> = body
        .get("names")
        .and_then(Value::as_array)
        .map(|items| {
            let mut seen = HashSet::new();
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .filter(|name| seen.insert(name.to_string()))
                .take(40)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() {
        return Err(ApiFailure::bad_request("请选择要测速的节点"));
    }
    let url = match body.get("url").and_then(Value::as_str) {
        Some(url) if !url.is_empty() => validate_http_url(url)?,
        _ => validate_http_url(&test_url_for(state))?,
    };
    let connection = with_kernel(state, |kernel| {
        kernel
            .connection_snapshot()
            .ok_or_else(|| ApiFailure::new(409, "内核未连接，无法测速"))
    })?;
    let results = Mutex::new(vec![Value::Null; names.len()]);
    let cursor = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..names.len().min(4) {
            let connection = connection.clone();
            let names = &names;
            let url = &url;
            let results = &results;
            let cursor = &cursor;
            scope.spawn(move || loop {
                let index = cursor.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if index >= names.len() {
                    break;
                }
                let name = &names[index];
                let value = match test_node_with(&connection, name, url, 5000) {
                    Ok(Some(delay)) => json!({ "name": name, "delay": delay }),
                    Ok(None) => json!({ "name": name, "error": "测速无响应" }),
                    Err(error) => {
                        let message =
                            if error.code == "KERNEL_HTTP" && error.message.contains("404") {
                                "节点尚未应用到当前内核".to_string()
                            } else {
                                error.message
                            };
                        json!({ "name": name, "error": message })
                    }
                };
                if let Ok(mut results) = results.lock() {
                    results[index] = value;
                }
            });
        }
    });
    let results = results.into_inner().unwrap_or_default();
    Ok(json!({ "results": results }))
}

fn test_group_delay(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let name = required_string(&body, "name", "出口名称", 200)?;
    let url = match body.get("url").and_then(Value::as_str) {
        Some(url) if !url.is_empty() => validate_http_url(url)?,
        _ => validate_http_url(&test_url_for(state))?,
    };
    let connection = with_kernel(state, |kernel| {
        kernel
            .connection_snapshot()
            .ok_or_else(|| ApiFailure::new(409, "内核未连接，无法测速"))
    })?;
    let delays = crate::kernel::test_group_with(&connection, &name, &url, 4000)
        .map_err(|error| ApiFailure::new(502, error.message))?;
    Ok(json!({ "delays": delays }))
}

fn probe_host(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let host = required_string(&body, "host", "域名", 253)?;
    let port = body.get("port").and_then(Value::as_u64).unwrap_or(443);
    if !(1..=65535).contains(&port) {
        return Err(ApiFailure::bad_request("端口无效"));
    }
    let mixed_port = with_kernel(state, |kernel| {
        kernel
            .mixed_port()
            .ok_or_else(|| ApiFailure::new(409, "尚未取得内核混合端口，无法探测"))
    })?;
    probe_through_proxy(&host, port as u16, mixed_port, Duration::from_secs(5))
        .map_err(|error| ApiFailure::new(502, format!("探测失败：{}", error)))?;
    Ok(json!({
        "ok": true,
        "message": "探测连接已发起，请稍后查看连接流"
    }))
}

pub fn handle_request(
    state: &AppState,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ApiFailure> {
    let method = method.to_uppercase();
    let clean = path.split('?').next().unwrap_or(path);

    match (method.as_str(), clean) {
        ("GET", "/api/workspace") => {
            with_store(state, |store| Ok(json!({ "workspace": store.workspace() })))
        }
        ("PUT", "/api/workspace") => {
            let body = body_object(body.as_ref());
            let workspace_value = body
                .get("workspace")
                .cloned()
                .ok_or_else(|| ApiFailure::bad_request("工作区数据无效"))?;
            let next: Workspace = serde_json::from_value(workspace_value).map_err(|error| {
                ApiFailure::bad_request(format!("工作区数据结构无效：{}", error))
            })?;
            let base_revision = body.get("baseRevision").and_then(Value::as_u64);
            with_store(state, |store| {
                let workspace = store
                    .replace_workspace(next, base_revision)
                    .map_err(store_failure)?;
                Ok(json!({ "workspace": workspace }))
            })
        }
        ("POST", "/api/workspace/import") => import_workspace(state, body),
        ("GET", "/api/status") => {
            let status = with_kernel(state, |kernel| Ok(kernel.status()))?;
            with_store(state, |store| status_value(store, status))
        }
        ("GET", "/api/live") => with_live(state, |live| serialize(live.snapshot())),
        ("GET", "/api/kernel/settings") => with_kernel(state, |kernel| {
            let mut view = kernel.settings_view();
            if let Some(object) = view.as_object_mut() {
                object.insert("status".to_string(), serialize(kernel.status())?);
            }
            Ok(view)
        }),
        ("PUT", "/api/kernel/settings") => save_kernel_settings(state, body),
        ("POST", "/api/kernel/test") => {
            let body = body_object(body.as_ref());
            let mode = match body.get("mode").and_then(Value::as_str) {
                Some("pipe") => "pipe",
                Some("tcp") => "tcp",
                _ => "auto",
            };
            let endpoint = optional_string(&body, "endpoint");
            let provided_secret = body
                .get("secret")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|secret| !secret.is_empty())
                .map(str::to_string);
            let stored_secret = with_kernel(state, |kernel| Ok(kernel.settings.secret.clone()))?;
            let settings = KernelSettings {
                mode: mode.to_string(),
                endpoint,
                secret: provided_secret.or(stored_secret),
            };
            Ok(Kernel::probe_settings(&settings))
        }
        ("POST", "/api/kernel/rediscover") => with_kernel(state, |kernel| {
            kernel.discover(true);
            Ok(json!({ "status": kernel.status() }))
        }),
        ("POST", "/api/exports/open") => {
            let exports_dir = with_store(state, |store| Ok(store.exports_dir.clone()))?;
            open_directory(&exports_dir)?;
            Ok(json!({ "ok": true }))
        }
        ("GET", "/api/exports/stats") => with_store(state, |store| {
            let (count, bytes) = store.export_stats();
            Ok(json!({ "count": count, "bytes": bytes, "keepDays": 30 }))
        }),
        ("POST", "/api/exports/cleanup") => {
            let body = body_object(body.as_ref());
            let keep_days = body
                .get("keepDays")
                .and_then(Value::as_u64)
                .unwrap_or(30)
                .min(3650);
            with_store(state, move |store| {
                let (removed, freed, count, bytes) = store
                    .cleanup_exports(keep_days)
                    .map_err(ApiFailure::internal)?;
                Ok(json!({
                    "removed": removed,
                    "freedBytes": freed,
                    "count": count,
                    "bytes": bytes,
                    "keepDays": keep_days
                }))
            })
        }
        ("POST", "/api/exports/import-to-verge") => import_to_verge(state, body),
        ("POST", "/api/open-url") => {
            let body = body_object(body.as_ref());
            let url = required_string(&body, "url", "地址", 2048)?;
            let parsed =
                url::Url::parse(&url).map_err(|_| ApiFailure::bad_request("地址格式无效"))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(ApiFailure::bad_request("只允许打开 http / https 地址"));
            }
            let opened = open_external_url(parsed.as_str());
            Ok(json!({ "ok": opened }))
        }
        ("GET", "/api/export/preview") => with_store(state, |store| {
            let preview = build_preview(store).map_err(ApiFailure::internal)?;
            serialize(preview)
        }),
        ("POST", "/api/export/validate") => with_store(state, |store| {
            let preview = build_preview(store).map_err(ApiFailure::internal)?;
            let validation = validate_config(&store.data_dir, &preview.yaml);
            Ok(json!({ "validation": validation }))
        }),
        ("POST", "/api/export") => {
            let body = body_object(body.as_ref());
            let requested_name = optional_string(&body, "fileName");
            with_store(state, |store| {
                match export_config(store, requested_name.as_deref()) {
                    Ok(result) => serialize(result),
                    Err(ExportError::Validation(preview)) => {
                        Err(ApiFailure::new(422, "配置校验未通过")
                            .with_value("preview", serialize(*preview)?))
                    }
                    Err(ExportError::Message(message)) => Err(ApiFailure::internal(message)),
                }
            })
        }
        ("GET", "/api/history") => with_store(state, |store| {
            Ok(json!({ "entries": store.list_history() }))
        }),
        ("DELETE", "/api/history") => with_store(state, |store| {
            let cleared = store.clear_history().map_err(ApiFailure::internal)?;
            Ok(json!({ "cleared": cleared }))
        }),
        ("POST", "/api/history/snapshot") => {
            let body = body_object(body.as_ref());
            let label = optional_string(&body, "label").unwrap_or_else(|| "手动快照".to_string());
            let note = optional_string(&body, "note")
                .unwrap_or_else(|| "用户手动创建的工作区快照".to_string());
            with_store(state, |store| {
                let entry = store
                    .snapshot(
                        label.chars().take(120).collect(),
                        note.chars().take(400).collect(),
                    )
                    .map_err(ApiFailure::internal)?;
                Ok(json!({ "entry": entry }))
            })
        }
        _ => {
            if let Some(id) = path_tail(clean, "/api/history/", "/summary") {
                return history_summary(state, id);
            }
            if let Some(id) = path_tail(clean, "/api/history/", "/export") {
                return history_export(state, id);
            }
            if let Some(id) = path_tail(clean, "/api/history/", "/restore") {
                return history_restore(state, id);
            }
            if let Some(id) = path_tail(clean, "/api/exits/", "/resolution") {
                return exit_resolution(state, id);
            }
            if let Some(id) = path_tail(clean, "/api/sources/", "/refresh") {
                if method == "POST" {
                    return refresh_source(state, id, body);
                }
            }
            if let Some(id) = path_tail(clean, "/api/sources/", "") {
                if (method == "PATCH" || method == "DELETE")
                    && !matches!(id, "manual" | "subscription" | "file" | "paste" | "verge")
                {
                    return source_routes(state, &method, id, body);
                }
            }
            if let Some(id) = path_tail(clean, "/api/chains/", "") {
                if method == "DELETE" {
                    return delete_chain(state, id);
                }
            }
            if let Some(id) = path_tail(clean, "/api/nodes/", "") {
                if method == "PATCH" && id != "bulk" {
                    return patch_node(state, id, body);
                }
            }
            if let Some(id) = path_tail(clean, "/api/rule-sets/", "/refresh") {
                if method == "POST" {
                    return refresh_ruleset(state, id);
                }
            }
            if let Some(id) = path_tail(clean, "/api/rule-sets/", "") {
                if method == "DELETE" && !matches!(id, "create-batch" | "inspect" | "create") {
                    return delete_ruleset(state, id);
                }
            }
            match (method.as_str(), clean) {
                ("POST", "/api/sources/subscription") => import_subscription(state, body),
                ("POST", "/api/sources/file") => import_content(state, body, "file"),
                ("POST", "/api/sources/paste") => import_content(state, body, "paste"),
                ("POST", "/api/sources/verge") => import_verge(state, body),
                ("POST", "/api/sources/manual") => import_manual_node(state, body),
                ("POST", "/api/chains") => create_chain(state, body),
                ("POST", "/api/nodes/bulk") => bulk_nodes(state, body),
                ("POST", "/api/rule-sets/create-batch") => create_rulesets(state, body),
                ("POST", "/api/rule-sets/inspect") => inspect_ruleset(state, body),
                ("POST", "/api/rule-sets/create") => create_ruleset(state, body),
                ("POST", "/api/delay") => test_delays(state, body),
                ("POST", "/api/delay/group") => test_group_delay(state, body),
                ("POST", "/api/probe") => probe_host(state, body),
                _ => Err(ApiFailure::not_found(format!(
                    "桌面版暂未实现该接口：{} {}",
                    method, clean
                ))),
            }
        }
    }
}

fn import_workspace(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let backup = body.get("backup").and_then(Value::as_object);
    let candidate = backup
        .and_then(|backup| backup.get("workspace"))
        .or_else(|| body.get("workspace"))
        .cloned()
        .unwrap_or(Value::Object(body.clone()));
    let declared_version = backup
        .and_then(|backup| backup.get("workspaceVersion"))
        .or_else(|| candidate.get("version"))
        .and_then(Value::as_u64)
        .unwrap_or(2);
    if declared_version > 2 {
        return Err(ApiFailure::bad_request(format!(
            "备份版本 {} 高于当前工作区版本 2，请升级工具后再导入",
            declared_version
        )));
    }
    let has_arrays = ["sources", "nodes", "exits", "routes"]
        .iter()
        .all(|key| candidate.get(*key).is_some_and(Value::is_array));
    if !has_arrays {
        return Err(ApiFailure::bad_request("备份数据结构无效"));
    }
    let next: Workspace = serde_json::from_value(candidate)
        .map_err(|error| ApiFailure::bad_request(format!("备份数据无法解析：{}", error)))?;
    with_store(state, |store| {
        let undo_entry = store
            .snapshot(
                "导入工作区前的快照".to_string(),
                "导入备份前自动创建".to_string(),
            )
            .map_err(ApiFailure::internal)?;
        let workspace = store.replace_workspace(next, None).map_err(store_failure)?;
        let _ = store.add_history(
            NewHistory {
                label: "导入工作区备份".to_string(),
                kind: "restore".to_string(),
                note: Some(now_iso()),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        );
        Ok(json!({ "workspace": workspace, "undoEntry": undo_entry }))
    })
}

fn history_summary(state: &AppState, id: &str) -> Result<Value, ApiFailure> {
    with_store(state, |store| {
        let Some(data) = store.read_history(id) else {
            return Err(ApiFailure::not_found("历史记录不存在"));
        };
        let current = workspace_counts(store.workspace());
        Ok(json!({
            "summary": {
                "snapshot": workspace_counts(&data.workspace),
                "current": current
            }
        }))
    })
}

fn history_export(state: &AppState, id: &str) -> Result<Value, ApiFailure> {
    with_store(state, |store| {
        let Some(data) = store.read_history(id) else {
            return Err(ApiFailure::not_found("历史记录不存在"));
        };
        let Some(yaml) = store.read_export(&data.entry) else {
            return Err(ApiFailure::not_found("该历史记录没有可查看的 YAML 文件"));
        };
        Ok(json!({ "entry": data.entry, "yaml": yaml }))
    })
}

fn history_restore(state: &AppState, id: &str) -> Result<Value, ApiFailure> {
    with_store(state, |store| {
        let result = store.restore_history(id).map_err(ApiFailure::internal)?;
        let Some((workspace, undo_entry)) = result else {
            return Err(ApiFailure::not_found("历史记录不存在"));
        };
        Ok(json!({ "workspace": workspace, "undoEntry": undo_entry }))
    })
}

fn exit_resolution(state: &AppState, id: &str) -> Result<Value, ApiFailure> {
    with_store(state, |store| {
        let workspace = store.workspace();
        let Some(exit) = workspace.exits.iter().find(|exit| exit.id == id) else {
            return Err(ApiFailure::not_found("出口不存在"));
        };
        let resolution = resolve_exit(
            exit,
            &ResolveContext {
                nodes: &workspace.nodes,
                exits: &workspace.exits,
                sources: &workspace.sources,
            },
        );
        let display_names: Vec<String> = resolution
            .nodes
            .iter()
            .map(|node| {
                let prefix = workspace
                    .sources
                    .iter()
                    .find(|source| source.id == node.source_id)
                    .map(|source| source.prefix.as_str())
                    .unwrap_or("");
                format!("{}{}", prefix, node.name)
            })
            .collect();
        Ok(json!({
            "memberNames": resolution.member_names,
            "nodeIds": resolution.nodes.iter().map(|node| node.id.clone()).collect::<Vec<_>>(),
            "allNodeIds": resolution.all_node_ids,
            "missing": resolution.missing,
            "displayNames": display_names
        }))
    })
}

fn source_routes(
    state: &AppState,
    method: &str,
    id: &str,
    body: Option<Value>,
) -> Result<Value, ApiFailure> {
    match method {
        "PATCH" => patch_source(state, id, body),
        "DELETE" => delete_source(state, id),
        _ => Err(ApiFailure::not_found("接口不存在")),
    }
}

fn patch_source(state: &AppState, id: &str, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    with_store(state, |store| {
        let (_, workspace) = store
            .mutate(|workspace| {
                let Some(source) = workspace.sources.iter_mut().find(|source| source.id == id)
                else {
                    return Err(StoreError::message("来源不存在"));
                };
                if let Some(name) = optional_string(&body, "name") {
                    source.name = name.chars().take(60).collect();
                }
                if let Some(prefix) = body.get("prefix").and_then(Value::as_str) {
                    let prefix = prefix.trim();
                    if prefix.chars().count() > 24 {
                        return Err(StoreError::message("节点前缀不能超过 24 个字符"));
                    }
                    if prefix.contains(',') || prefix.contains('\n') || prefix.contains('\r') {
                        return Err(StoreError::message("节点前缀不能包含逗号或换行"));
                    }
                    source.prefix = prefix.to_string();
                }
                if let Some(keep_rules) = body.get("keepRules").and_then(Value::as_bool) {
                    source.keep_rules = keep_rules;
                }
                Ok(())
            })
            .map_err(store_failure)?;
        Ok(json!({ "workspace": workspace }))
    })
}

fn delete_source(state: &AppState, id: &str) -> Result<Value, ApiFailure> {
    with_store(state, |store| {
        let (name, workspace) = store
            .mutate(|workspace| {
                let Some(source) = workspace.sources.iter().find(|source| source.id == id) else {
                    return Err(StoreError::message("来源不存在"));
                };
                let name = source.name.clone();
                workspace.sources.retain(|source| source.id != id);
                workspace.nodes.retain(|node| node.source_id != id);
                workspace.routes.retain(|route| match route {
                    Route::Rule(rule) => rule.source_id.as_deref() != Some(id),
                    Route::Ruleset(rule) => rule.source_id.as_deref() != Some(id),
                });
                let source_exits: Vec<Exit> = workspace
                    .exits
                    .iter()
                    .filter(|exit| exit.source_id.as_deref() == Some(id))
                    .cloned()
                    .collect();
                let referenced: HashSet<String> = workspace
                    .routes
                    .iter()
                    .map(|route| route.exit_id().to_string())
                    .chain(
                        workspace
                            .exits
                            .iter()
                            .flat_map(|exit| exit.members.iter())
                            .filter(|member| member.by == "exit")
                            .map(|member| member.value.clone()),
                    )
                    .collect();
                for exit in source_exits {
                    if referenced.contains(&exit.id) {
                        if let Some(target) =
                            workspace.exits.iter_mut().find(|item| item.id == exit.id)
                        {
                            target.source_id = None;
                        }
                    } else {
                        workspace.exits.retain(|item| item.id != exit.id);
                    }
                }
                Ok(name)
            })
            .map_err(store_failure)?;
        let _ = store.add_history(
            NewHistory {
                label: format!("删除来源 · {}", name),
                kind: "manual".to_string(),
                note: Some("已移除来源节点、来源规则与未被引用的出口".to_string()),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        );
        Ok(json!({ "workspace": workspace }))
    })
}

fn unique_node_name(base: &str, prefix: &str, used: &HashSet<String>) -> String {
    let mut candidate = base.to_string();
    let mut index = 2;
    while used.contains(&format!("{}{}", prefix, candidate).to_lowercase()) {
        candidate = format!("{} {}", base, index);
        index += 1;
    }
    candidate
}

fn import_manual_node(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let proxy = body
        .get("proxy")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| ApiFailure::bad_request("节点数据无效"))?;
    let proxy_type = proxy.get("type").and_then(Value::as_str).unwrap_or("");
    let server = proxy.get("server").and_then(Value::as_str).unwrap_or("");
    let raw_name = proxy
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if proxy_type.is_empty() || server.is_empty() || raw_name.is_empty() {
        return Err(ApiFailure::bad_request("节点缺少类型、地址或名称"));
    }
    let key = dedupe_key(&proxy);

    with_store(state, |store| {
        let ((added, deduped), workspace) = store
            .mutate(|workspace| {
                if workspace
                    .nodes
                    .iter()
                    .any(|node| dedupe_key(&node.raw) == key)
                {
                    return Ok((0usize, 1usize));
                }
                let now = now_iso();
                let source_id = Uuid::new_v4().to_string();
                let source = Source {
                    id: source_id,
                    kind: "manual".to_string(),
                    name: raw_name.to_string(),
                    url: None,
                    prefix: String::new(),
                    keep_rules: false,
                    updated_at: Some(now.clone()),
                    userinfo: None,
                    note: Some(MANUAL_SOURCE_NOTE.to_string()),
                };
                workspace.sources.push(source.clone());
                let used_names: HashSet<String> = workspace
                    .nodes
                    .iter()
                    .map(|node| {
                        let prefix = workspace
                            .sources
                            .iter()
                            .find(|item| item.id == node.source_id)
                            .map(|item| item.prefix.as_str())
                            .unwrap_or("");
                        format!("{}{}", prefix, node.name).to_lowercase()
                    })
                    .collect();
                let name = unique_node_name(raw_name, &source.prefix, &used_names);
                workspace.nodes.push(ProxyNode {
                    id: Uuid::new_v4().to_string(),
                    source_id: source.id,
                    name,
                    raw: proxy.clone(),
                    region: None,
                    tags: Vec::new(),
                    enabled: true,
                    added_at: now,
                    updated_at: None,
                    chain: None,
                });
                Ok((1usize, 0usize))
            })
            .map_err(store_failure)?;
        let _ = store.add_history(
            NewHistory {
                label: "添加手动节点".to_string(),
                kind: "manual".to_string(),
                note: Some(format!("新增 {} 个节点", added)),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        );
        Ok(json!({
            "workspace": workspace,
            "added": added,
            "deduped": deduped,
            "groups": 0,
            "rules": 0,
            "skippedRules": 0,
            "warnings": []
        }))
    })
}

fn create_chain(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let relay_id = required_string(&body, "relayNodeId", "中转节点", 120)?;
    let landing_id = required_string(&body, "landingNodeId", "落地节点", 120)?;
    let requested_name = required_string(&body, "name", "节点名称", 120)?;
    if relay_id == landing_id {
        return Err(ApiFailure::bad_request("中转和落地不能是同一个节点"));
    }
    if requested_name.contains(',')
        || requested_name.contains('\n')
        || requested_name.contains('\r')
    {
        return Err(ApiFailure::bad_request("节点名称不能包含换行或逗号"));
    }
    with_store(state, |store| {
        let ((node_id, relay_name, landing_name), workspace) = store
            .mutate(|workspace| {
                let relay = workspace
                    .nodes
                    .iter()
                    .find(|node| node.id == relay_id)
                    .cloned()
                    .ok_or_else(|| StoreError::message("节点不存在"))?;
                let landing = workspace
                    .nodes
                    .iter()
                    .find(|node| node.id == landing_id)
                    .cloned()
                    .ok_or_else(|| StoreError::message("节点不存在"))?;
                if relay.chain.is_some() || landing.chain.is_some() {
                    return Err(StoreError::message("链式节点不能再次作为中转或落地"));
                }
                if !relay.enabled {
                    return Err(StoreError::message("中转节点已禁用"));
                }
                if !landing.enabled {
                    return Err(StoreError::message("落地节点已禁用"));
                }
                let display = |node: &ProxyNode, workspace: &Workspace| {
                    let prefix = workspace
                        .sources
                        .iter()
                        .find(|source| source.id == node.source_id)
                        .map(|source| source.prefix.as_str())
                        .unwrap_or("");
                    format!("{}{}", prefix, node.name)
                };
                let relay_name = display(&relay, workspace);
                let landing_name = display(&landing, workspace);
                if workspace.nodes.iter().any(|node| {
                    display(node, workspace).to_lowercase() == requested_name.to_lowercase()
                }) {
                    return Err(StoreError::message(format!(
                        "节点名「{}」已存在",
                        requested_name
                    )));
                }
                if workspace
                    .exits
                    .iter()
                    .any(|exit| exit.name.to_lowercase() == requested_name.to_lowercase())
                {
                    return Err(StoreError::message(format!(
                        "节点名「{}」与出口重名",
                        requested_name
                    )));
                }
                if matches!(
                    requested_name.to_uppercase().as_str(),
                    "DIRECT" | "REJECT" | "GLOBAL" | "PASS" | "COMPATIBLE" | "REJECT-DROP"
                ) {
                    return Err(StoreError::message(format!(
                        "节点名「{}」与内置出站冲突",
                        requested_name
                    )));
                }
                let chain_source_id = if let Some(source) = workspace
                    .sources
                    .iter()
                    .find(|source| source.kind == "chain")
                {
                    source.id.clone()
                } else {
                    let id = Uuid::new_v4().to_string();
                    workspace.sources.push(Source {
                        id: id.clone(),
                        kind: "chain".to_string(),
                        name: "链式代理".to_string(),
                        url: None,
                        prefix: String::new(),
                        keep_rules: false,
                        updated_at: Some(now_iso()),
                        userinfo: None,
                        note: Some("由链路编辑器生成".to_string()),
                    });
                    id
                };
                let mut raw = landing.raw.clone();
                raw.insert("name".to_string(), Value::String(requested_name.clone()));
                raw.insert(
                    "dialer-proxy".to_string(),
                    Value::String(relay_name.clone()),
                );
                let node = ProxyNode {
                    id: Uuid::new_v4().to_string(),
                    source_id: chain_source_id,
                    name: requested_name.clone(),
                    raw,
                    region: None,
                    tags: vec!["链式".to_string()],
                    enabled: true,
                    added_at: now_iso(),
                    updated_at: None,
                    chain: Some(ChainMeta {
                        relay_node_id: relay.id,
                        landing_node_id: landing.id,
                    }),
                };
                let node_id = node.id.clone();
                workspace.nodes.push(node);
                Ok((node_id, relay_name, landing_name))
            })
            .map_err(store_failure)?;
        let _ = store.add_history(
            NewHistory {
                label: format!("链式代理 · {}", requested_name),
                kind: "manual".to_string(),
                note: Some(format!("{} → {}", relay_name, landing_name)),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        );
        Ok(json!({ "workspace": workspace, "nodeId": node_id }))
    })
}

fn delete_chain(state: &AppState, id: &str) -> Result<Value, ApiFailure> {
    with_store(state, |store| {
        let ((name, removed_routes), workspace) = store
            .mutate(|workspace| {
                let Some(node) = workspace
                    .nodes
                    .iter()
                    .find(|node| node.id == id && node.chain.is_some())
                    .cloned()
                else {
                    return Err(StoreError::message("链路节点不存在"));
                };
                let source_id = node.source_id.clone();
                let removed_routes = workspace
                    .routes
                    .iter()
                    .filter(|route| match route {
                        Route::Rule(rule) => rule.target_node_id.as_deref() == Some(id),
                        Route::Ruleset(_) => false,
                    })
                    .count();
                workspace.nodes.retain(|node| node.id != id);
                workspace.routes.retain(|route| match route {
                    Route::Rule(rule) => rule.target_node_id.as_deref() != Some(id),
                    Route::Ruleset(_) => true,
                });
                if !workspace
                    .nodes
                    .iter()
                    .any(|node| node.source_id == source_id)
                    && workspace
                        .sources
                        .iter()
                        .any(|source| source.id == source_id && source.kind == "chain")
                {
                    workspace.sources.retain(|source| source.id != source_id);
                }
                Ok((node.name, removed_routes))
            })
            .map_err(store_failure)?;
        let _ = store.add_history(
            NewHistory {
                label: format!("删除链路 · {}", name),
                kind: "manual".to_string(),
                note: Some(format!("同时移除 {} 条目标规则", removed_routes)),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        );
        Ok(json!({ "workspace": workspace, "removedRoutes": removed_routes }))
    })
}

fn patch_node(state: &AppState, id: &str, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    with_store(state, |store| {
        let (_, workspace) = store
            .mutate(|workspace| {
                let node = workspace
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == id)
                    .ok_or_else(|| StoreError::message("节点不存在"))?;
                if let Some(name) = optional_string(&body, "name") {
                    node.name = name;
                }
                if let Some(tags) = body.get("tags").and_then(Value::as_array) {
                    let mut seen = HashSet::new();
                    node.tags = tags
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|tag| !tag.is_empty())
                        .filter(|tag| seen.insert(tag.to_string()))
                        .map(str::to_string)
                        .collect();
                }
                if let Some(region) = body.get("region") {
                    node.region = region
                        .as_str()
                        .map(str::trim)
                        .filter(|region| !region.is_empty())
                        .map(str::to_string);
                }
                if let Some(enabled) = body.get("enabled").and_then(Value::as_bool) {
                    node.enabled = enabled;
                }
                node.updated_at = Some(now_iso());
                Ok(())
            })
            .map_err(store_failure)?;
        Ok(json!({ "workspace": workspace }))
    })
}

fn bulk_nodes(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let ids: HashSet<String> = body
        .get("ids")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(ApiFailure::bad_request("请选择节点"));
    }
    let enabled = body.get("enabled").and_then(Value::as_bool);
    let add_tags: Vec<String> = body
        .get("addTags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    with_store(state, |store| {
        let (_, workspace) = store
            .mutate(|workspace| {
                for node in &mut workspace.nodes {
                    if !ids.contains(&node.id) {
                        continue;
                    }
                    if let Some(enabled) = enabled {
                        node.enabled = enabled;
                    }
                    for tag in &add_tags {
                        if !node.tags.contains(tag) {
                            node.tags.push(tag.clone());
                        }
                    }
                    node.updated_at = Some(now_iso());
                }
                Ok(())
            })
            .map_err(store_failure)?;
        Ok(json!({ "workspace": workspace }))
    })
}

fn delete_ruleset(state: &AppState, id: &str) -> Result<Value, ApiFailure> {
    with_store(state, |store| {
        let (_, workspace) = store
            .mutate(|workspace| {
                workspace.routes.retain(|route| match route {
                    Route::Ruleset(ruleset) => ruleset.id != id,
                    Route::Rule(_) => true,
                });
                Ok(())
            })
            .map_err(store_failure)?;
        Ok(json!({ "workspace": workspace }))
    })
}

fn url_slug(value: &str) -> String {
    let path = value
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let segment = path.rsplit('/').next().unwrap_or("");
    segment
        .trim_end_matches(".mrs")
        .trim_end_matches(".yaml")
        .trim_end_matches(".yml")
        .trim_end_matches(".txt")
        .to_lowercase()
}

fn create_rulesets(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let exit_id = required_string(&body, "exitId", "出口", 80)?;
    let items = body
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        return Err(ApiFailure::bad_request("请选择要添加的规则集"));
    }
    if items.len() > 80 {
        return Err(ApiFailure::bad_request("一次最多添加 80 个规则集"));
    }
    if !with_store(state, |store| {
        Ok(store
            .workspace()
            .exits
            .iter()
            .any(|exit| exit.id == exit_id))
    })? {
        return Err(ApiFailure::bad_request("目标出口不存在"));
    }

    with_store(state, |store| {
        let ((added, skipped), workspace) = store
            .mutate(|workspace| {
                let mut provider_keys: HashSet<String> = workspace
                    .routes
                    .iter()
                    .filter_map(|route| match route {
                        Route::Ruleset(ruleset) => Some(
                            ruleset
                                .provider_name
                                .clone()
                                .unwrap_or_else(|| ruleset.name.clone())
                                .to_lowercase(),
                        ),
                        Route::Rule(_) => None,
                    })
                    .collect();
                let mut source_slugs: HashSet<String> = workspace
                    .routes
                    .iter()
                    .filter_map(|route| match route {
                        Route::Ruleset(ruleset) if ruleset.source.kind == "url" => {
                            Some(url_slug(&ruleset.source.value))
                        }
                        _ => None,
                    })
                    .filter(|slug| !slug.is_empty())
                    .collect();
                let mut added = 0usize;
                let mut skipped_names = Vec::new();
                for item in &items {
                    let Some(item) = item.as_object() else {
                        continue;
                    };
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    let url = item
                        .get("url")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    let behavior = item
                        .get("behavior")
                        .and_then(Value::as_str)
                        .unwrap_or("domain");
                    let format = item.get("format").and_then(Value::as_str).unwrap_or("mrs");
                    if name.is_empty() || url.is_empty() {
                        skipped_names.push(name.to_string());
                        continue;
                    }
                    let lower_url = url.to_lowercase();
                    if !lower_url.starts_with("http://") && !lower_url.starts_with("https://") {
                        skipped_names.push(name.to_string());
                        continue;
                    }
                    if !matches!(behavior, "domain" | "ipcidr" | "classical")
                        || !matches!(format, "mrs" | "yaml" | "text")
                    {
                        skipped_names.push(name.to_string());
                        continue;
                    }
                    let provider_name = item
                        .get("providerName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            let slug = url_slug(url);
                            if slug.is_empty() {
                                name.to_string()
                            } else {
                                slug
                            }
                        });
                    let provider_key = provider_name.to_lowercase();
                    let slug = url_slug(url);
                    if provider_keys.contains(&provider_key)
                        || (!slug.is_empty() && source_slugs.contains(&slug))
                    {
                        skipped_names.push(name.to_string());
                        continue;
                    }
                    provider_keys.insert(provider_key);
                    if !slug.is_empty() {
                        source_slugs.insert(slug);
                    }
                    let route = RuleSetRoute {
                        id: Uuid::new_v4().to_string(),
                        name: name.to_string(),
                        provider_name: Some(provider_name),
                        behavior: behavior.to_string(),
                        format: format.to_string(),
                        source: RuleSetSource {
                            kind: "url".to_string(),
                            value: url.to_string(),
                            file_name: None,
                            size: None,
                        },
                        inline: false,
                        inline_rules: None::<Vec<InlineRule>>,
                        rule_count: None,
                        exit_id: exit_id.clone(),
                        no_resolve: None,
                        enabled: true,
                        interval: Some(86400),
                        updated_at: Some(now_iso()),
                        origin: Some("catalog".to_string()),
                        source_id: None,
                        pending: None,
                        applied_at: None,
                    };
                    let index = workspace
                        .routes
                        .iter()
                        .position(|route| route.is_match())
                        .unwrap_or(workspace.routes.len());
                    workspace.routes.insert(index, Route::Ruleset(route));
                    added += 1;
                }
                Ok((added, skipped_names))
            })
            .map_err(store_failure)?;
        if added > 0 {
            let _ = store.add_history(
                NewHistory {
                    label: "添加内置规则集".to_string(),
                    kind: "manual".to_string(),
                    note: Some(format!(
                        "新增 {} 个规则集{}",
                        added,
                        if skipped.is_empty() {
                            String::new()
                        } else {
                            format!("，已存在 {} 个", skipped.len())
                        }
                    )),
                    export_path: None,
                    file_name: None,
                    counts: None,
                    at: None,
                },
                &workspace,
            );
        }
        Ok(json!({ "workspace": workspace, "added": added, "skipped": skipped }))
    })
}

fn inspect_ruleset(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let data_dir = with_store(state, |store| Ok(store.data_dir.clone()))?;
    if let Some(url) = body.get("url").and_then(Value::as_str) {
        let url = validate_http_url(url)?;
        let (user_agent, proxy_port) = source_fetch_context(state);
        let fetched = fetch_url(&url, &user_agent, proxy_port, 20_000)
            .map_err(|error| ApiFailure::new(502, error))?;
        if fetched.bytes.len() > 20 * 1024 * 1024 {
            return Err(ApiFailure::new(413, "规则集文件过大"));
        }
        let inspect = inspect_buffer(&fetched.bytes, None, Some(&url));
        return serialize(inspect);
    }
    if let Some(data_base64) = body.get("dataBase64").and_then(Value::as_str) {
        let payload = data_base64
            .split_once(',')
            .map(|(_, rest)| rest)
            .unwrap_or(data_base64);
        let buffer = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|_| ApiFailure::bad_request("规则集文件内容无法解析"))?;
        if buffer.is_empty() {
            return Err(ApiFailure::bad_request("文件内容为空"));
        }
        if buffer.len() > 10 * 1024 * 1024 {
            return Err(ApiFailure::new(413, "文件过大（上限 10MB）"));
        }
        let file_name = crate::rulesets::sanitize_file_name(
            body.get("fileName")
                .and_then(Value::as_str)
                .unwrap_or("ruleset.txt"),
        );
        let stored_path =
            store_ruleset_file(&data_dir, &buffer, &file_name).map_err(ApiFailure::internal)?;
        let mut inspect = inspect_buffer(&buffer, Some(&file_name), None);
        inspect.file_name = Some(file_name);
        inspect.stored_path = Some(stored_path.to_string_lossy().to_string());
        inspect.source_value = stored_path.to_string_lossy().to_string();
        return serialize(inspect);
    }
    Err(ApiFailure::bad_request("请提供规则集地址或文件"))
}

fn ruleset_source(
    state: &AppState,
    body: &Map<String, Value>,
) -> Result<(Vec<u8>, String, Option<String>, String), ApiFailure> {
    let source_type = body
        .get("sourceType")
        .and_then(Value::as_str)
        .unwrap_or("url");
    if source_type == "url" {
        let url = validate_http_url(body.get("url").and_then(Value::as_str).unwrap_or(""))?;
        let (user_agent, proxy_port) = source_fetch_context(state);
        let fetched = fetch_url(&url, &user_agent, proxy_port, 20_000)
            .map_err(|error| ApiFailure::new(502, error))?;
        if fetched.bytes.len() > 20 * 1024 * 1024 {
            return Err(ApiFailure::new(413, "规则集文件过大"));
        }
        return Ok((fetched.bytes, url, None, "url".to_string()));
    }
    let file_path = required_string(body, "filePath", "规则集文件", 512)?;
    let data_dir = with_store(state, |store| Ok(store.data_dir.clone()))?;
    let path = std::path::PathBuf::from(&file_path);
    if !is_path_inside(&data_dir.join("rule-sets"), &path) {
        return Err(ApiFailure::bad_request("规则集文件路径无效"));
    }
    let buffer = std::fs::read(&path).map_err(|_| ApiFailure::not_found("规则集文件不存在"))?;
    if buffer.len() > 20 * 1024 * 1024 {
        return Err(ApiFailure::new(413, "规则集文件过大"));
    }
    let file_name = body
        .get("fileName")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
        });
    Ok((
        buffer,
        path.to_string_lossy().to_string(),
        file_name,
        "file".to_string(),
    ))
}

fn create_ruleset(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let name = required_string(&body, "name", "规则集名称", 80)?;
    let behavior = body
        .get("behavior")
        .and_then(Value::as_str)
        .unwrap_or("domain")
        .to_string();
    let format = body
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("text")
        .to_string();
    if !matches!(behavior.as_str(), "domain" | "ipcidr" | "classical") {
        return Err(ApiFailure::bad_request("behavior 无效"));
    }
    if !matches!(format.as_str(), "yaml" | "text" | "mrs") {
        return Err(ApiFailure::bad_request("format 无效"));
    }
    let exit_id = required_string(&body, "exitId", "出口", 80)?;
    if !with_store(state, |store| {
        Ok(store
            .workspace()
            .exits
            .iter()
            .any(|exit| exit.id == exit_id))
    })? {
        return Err(ApiFailure::bad_request("目标出口不存在"));
    }
    let inline = body.get("inline").and_then(Value::as_bool) == Some(true);
    let interval = body
        .get("interval")
        .and_then(Value::as_i64)
        .unwrap_or(86400)
        .max(60);
    let (buffer, source_value, source_file_name, source_type) = ruleset_source(state, &body)?;
    let mut inline_rules = None;
    if inline {
        if format == "mrs" {
            return Err(ApiFailure::bad_request("MRS 是二进制格式，不能内联展开"));
        }
        let expanded = expand_ruleset(&buffer, &behavior, &format)
            .map_err(|error| ApiFailure::new(422, error))?;
        if expanded.is_empty() {
            return Err(ApiFailure::new(422, "规则集内容为空或格式无法识别"));
        }
        if expanded.len() > 500 {
            return Err(ApiFailure::new(
                422,
                format!("内联规则过多（{} 条），请改用 provider", expanded.len()),
            ));
        }
        inline_rules = Some(expanded);
    }
    let inspect = inspect_buffer(&buffer, source_file_name.as_deref(), Some(&source_value));
    let route = RuleSetRoute {
        id: Uuid::new_v4().to_string(),
        name: name.clone(),
        provider_name: None,
        behavior,
        format,
        source: RuleSetSource {
            kind: source_type,
            value: source_value,
            file_name: source_file_name,
            size: Some(buffer.len() as u64),
        },
        inline,
        inline_rules: inline_rules.clone(),
        rule_count: inspect
            .rule_count
            .or(inline_rules.map(|rules| rules.len() as u64)),
        exit_id,
        no_resolve: None,
        enabled: true,
        interval: Some(interval),
        updated_at: Some(now_iso()),
        origin: Some("manual".to_string()),
        source_id: None,
        pending: None,
        applied_at: None,
    };
    let route_value = serde_json::to_value(Route::Ruleset(route.clone()))
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let workspace = with_store(state, |store| {
        let (_, workspace) = store
            .mutate(|workspace| {
                let index = workspace
                    .routes
                    .iter()
                    .position(|item| item.is_match())
                    .unwrap_or(workspace.routes.len());
                workspace
                    .routes
                    .insert(index, Route::Ruleset(route.clone()));
                Ok(())
            })
            .map_err(store_failure)?;
        let _ = store.add_history(
            NewHistory {
                label: format!("添加规则集 · {}", name),
                kind: "manual".to_string(),
                note: Some(match inspect.rule_count {
                    Some(count) => format!("{} 条规则", count),
                    None => "二进制规则集".to_string(),
                }),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        );
        Ok(workspace)
    })?;
    Ok(json!({ "workspace": workspace, "route": route_value }))
}

fn refresh_ruleset(state: &AppState, id: &str) -> Result<Value, ApiFailure> {
    let route = with_store(state, |store| {
        store
            .workspace()
            .routes
            .iter()
            .find_map(|route| match route {
                Route::Ruleset(ruleset) if ruleset.id == id => Some(ruleset.clone()),
                _ => None,
            })
            .ok_or_else(|| ApiFailure::not_found("规则集不存在"))
    })?;
    let buffer = if route.source.kind == "url" {
        let url = validate_http_url(&route.source.value)?;
        let (user_agent, proxy_port) = source_fetch_context(state);
        fetch_url(&url, &user_agent, proxy_port, 20_000)
            .map_err(|error| ApiFailure::new(502, error))?
            .bytes
    } else {
        let data_dir = with_store(state, |store| Ok(store.data_dir.clone()))?;
        let path = std::path::PathBuf::from(&route.source.value);
        if !is_path_inside(&data_dir.join("rule-sets"), &path) {
            return Err(ApiFailure::bad_request("规则集文件路径无效"));
        }
        std::fs::read(&path).map_err(|_| ApiFailure::not_found("规则集文件不存在"))?
    };
    let inspect = inspect_buffer(
        &buffer,
        route.source.file_name.as_deref(),
        Some(&route.source.value),
    );
    let mut inline_rules = None;
    if route.inline {
        let expanded = expand_ruleset(&buffer, &route.behavior, &route.format)
            .map_err(|error| ApiFailure::new(422, error))?;
        if expanded.is_empty() {
            return Err(ApiFailure::new(422, "规则集内容为空或格式无法识别"));
        }
        if expanded.len() > 500 {
            return Err(ApiFailure::new(422, "内联规则过多"));
        }
        inline_rules = Some(expanded);
    }
    let (workspace, updated) = with_store(state, |store| {
        let (route, workspace) = store
            .mutate(|workspace| {
                let route = workspace
                    .routes
                    .iter_mut()
                    .find_map(|item| match item {
                        Route::Ruleset(ruleset) if ruleset.id == id => Some(ruleset),
                        _ => None,
                    })
                    .ok_or_else(|| StoreError::message("规则集不存在"))?;
                route.rule_count = inspect
                    .rule_count
                    .or(inline_rules.as_ref().map(|rules| rules.len() as u64));
                route.inline_rules = inline_rules.clone();
                route.updated_at = Some(now_iso());
                route.source.size = Some(buffer.len() as u64);
                Ok(route.clone())
            })
            .map_err(store_failure)?;
        let _ = store.add_history(
            NewHistory {
                label: format!("刷新规则集 · {}", route.name),
                kind: "manual".to_string(),
                note: Some(match inspect.rule_count {
                    Some(count) => format!("{} 条规则", count),
                    None => "已更新".to_string(),
                }),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        );
        Ok((workspace, route))
    })?;
    let route_value = serde_json::to_value(Route::Ruleset(updated))
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    Ok(json!({ "workspace": workspace, "route": route_value }))
}

fn import_to_verge(state: &AppState, body: Option<Value>) -> Result<Value, ApiFailure> {
    let body = body_object(body.as_ref());
    let path = if let Some(path) = optional_string(&body, "path") {
        path
    } else {
        with_store(state, |store| {
            store
                .workspace()
                .last_export
                .as_ref()
                .map(|record| record.path.clone())
                .ok_or_else(|| ApiFailure::bad_request("请先导出配置"))
        })?
    };
    let yaml = with_store(state, |store| {
        store
            .read_export_path(&path)
            .ok_or_else(|| ApiFailure::not_found("导出文件不存在，请重新导出"))
    })?;
    let (info, opened) = {
        let mut share = state
            .share
            .lock()
            .map_err(|_| ApiFailure::internal("分享服务锁不可用，请重启应用"))?;
        let info = share.publish(yaml).map_err(ApiFailure::internal)?;
        let opened = if body.get("open").and_then(Value::as_bool) == Some(false) {
            false
        } else {
            open_external_url(&info.scheme_url)
        };
        (info, opened)
    };
    let expires_at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(info.expires_at as i64)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    Ok(json!({
        "url": info.url,
        "schemeUrl": info.scheme_url,
        "expiresAt": expires_at,
        "opened": opened
    }))
}

fn open_external_url(target: &str) -> bool {
    if cfg!(target_os = "windows") {
        return open_windows_url(target);
    }
    if cfg!(target_os = "macos") {
        return Command::new("open").arg(target).spawn().is_ok();
    }
    Command::new("xdg-open").arg(target).spawn().is_ok()
}

#[cfg(target_os = "windows")]
fn open_windows_url(target: &str) -> bool {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new("cmd.exe");
    command.creation_flags(0x08000000);
    command.raw_arg("/c");
    command.raw_arg("start");
    command.raw_arg("\"\"");
    command.raw_arg(format!("\"{}\"", target.replace('"', "%22")));
    command.spawn().is_ok()
}

#[cfg(not(target_os = "windows"))]
fn open_windows_url(_target: &str) -> bool {
    false
}

fn open_directory(path: &Path) -> Result<(), ApiFailure> {
    let command = if cfg!(target_os = "windows") {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(command)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| ApiFailure::internal(format!("无法打开导出目录：{}", error)))
}
