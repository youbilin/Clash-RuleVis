use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use serde_json::{json, Map, Value};
use uuid::Uuid;

use rulevis_core::defaults::{MANUAL_SOURCE_NAME, MANUAL_SOURCE_NOTE};
use rulevis_core::model::{
    ChainMeta, Exit, InlineRule, ProxyNode, Route, RuleSetRoute, RuleSetSource, Source, Workspace,
};
use rulevis_core::resolve::{resolve_exit, ResolveContext};

use crate::export::{build_preview, export_config, ExportError};
use crate::storage::{now_iso, now_millis, NewHistory, Store, StoreError};
use crate::types::{
    ApiFailure, AppStatus, KernelStatus, KernelValidation, StatusCounts, StatusWorkspace,
};
use crate::verge;

pub struct AppState {
    store: Mutex<Store>,
}

impl AppState {
    pub fn load(data_dir: std::path::PathBuf) -> Result<Self, String> {
        Ok(Self {
            store: Mutex::new(Store::load(data_dir)?),
        })
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

fn kernel_status() -> KernelStatus {
    KernelStatus::desktop_unavailable()
}

fn status_value(store: &Store) -> Result<Value, ApiFailure> {
    let workspace = store.workspace();
    let status = AppStatus {
        kernel: kernel_status(),
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

fn error_unavailable(feature: &str) -> ApiFailure {
    ApiFailure::unavailable(format!(
        "桌面版尚未接入{}，请先在 Web 版完成，或使用已支持的工作区/导出功能",
        feature
    ))
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
        ("GET", "/api/status") => with_store(state, |store| status_value(store)),
        ("GET", "/api/live") => Ok(json!({
            "generatedAt": now_millis(),
            "connections": [],
            "stats": {
                "activeConnections": 0,
                "domains": 0,
                "downRate": 0,
                "upRate": 0,
                "totalDown": 0,
                "totalUp": 0
            },
            "kernel": kernel_status(),
            "groups": {},
            "providers": {},
            "ruleHits": {},
            "proxyHits": {}
        })),
        ("GET", "/api/kernel/settings") => Ok(json!({
            "mode": "auto",
            "endpoint": "",
            "hasSecret": false,
            "status": kernel_status()
        })),
        ("PUT", "/api/kernel/settings")
        | ("POST", "/api/kernel/test")
        | ("POST", "/api/kernel/rediscover") => Err(error_unavailable("内核适配")),
        ("POST", "/api/exports/open") => {
            let exports_dir = with_store(state, |store| Ok(store.exports_dir.clone()))?;
            open_directory(&exports_dir)?;
            Ok(json!({ "ok": true }))
        }
        ("GET", "/api/export/preview") => with_store(state, |store| {
            let preview = build_preview(store).map_err(ApiFailure::internal)?;
            serialize(preview)
        }),
        ("POST", "/api/export/validate") => Ok(json!({
            "validation": KernelValidation::unavailable("桌面版内核适配尚未接入，暂不能运行 mihomo 校验")
        })),
        ("POST", "/api/export") => with_store(state, |store| match export_config(store) {
            Ok(result) => serialize(result),
            Err(ExportError::Validation(preview)) => {
                Err(ApiFailure::new(422, "配置校验未通过")
                    .with_value("preview", serialize(*preview)?))
            }
            Err(ExportError::Message(message)) => Err(ApiFailure::internal(message)),
        }),
        ("GET", "/api/history") => with_store(state, |store| {
            Ok(json!({ "entries": store.list_history() }))
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
                    return Err(error_unavailable(&format!("来源刷新（{}）", id)));
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
                    return Err(error_unavailable(&format!("规则集刷新（{}）", id)));
                }
            }
            if let Some(id) = path_tail(clean, "/api/rule-sets/", "") {
                if method == "DELETE" && !matches!(id, "create-batch" | "inspect" | "create") {
                    return delete_ruleset(state, id);
                }
            }
            match (method.as_str(), clean) {
                ("POST", "/api/sources/subscription")
                | ("POST", "/api/sources/file")
                | ("POST", "/api/sources/paste")
                | ("POST", "/api/sources/verge") => Err(error_unavailable("订阅 / YAML 导入")),
                ("POST", "/api/sources/manual") => import_manual_node(state, body),
                ("POST", "/api/chains") => create_chain(state, body),
                ("POST", "/api/nodes/bulk") => bulk_nodes(state, body),
                ("POST", "/api/rule-sets/create-batch") => create_rulesets(state, body),
                ("POST", "/api/rule-sets/inspect") | ("POST", "/api/rule-sets/create") => {
                    Err(error_unavailable("手动规则集导入"))
                }
                ("POST", "/api/delay") | ("POST", "/api/delay/group") | ("POST", "/api/probe") => {
                    Err(error_unavailable("内核测速 / 探测"))
                }
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

fn dedupe_key(raw: &Map<String, Value>) -> String {
    let fields = [
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
    let parts: Vec<String> = fields
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
                let source_index = workspace
                    .sources
                    .iter()
                    .position(|source| source.kind == "manual");
                let source_id = if let Some(index) = source_index {
                    workspace.sources[index].updated_at = Some(now.clone());
                    workspace.sources[index].id.clone()
                } else {
                    let id = Uuid::new_v4().to_string();
                    workspace.sources.push(Source {
                        id: id.clone(),
                        kind: "manual".to_string(),
                        name: MANUAL_SOURCE_NAME.to_string(),
                        url: None,
                        prefix: String::new(),
                        keep_rules: false,
                        updated_at: Some(now.clone()),
                        userinfo: None,
                        note: Some(MANUAL_SOURCE_NOTE.to_string()),
                    });
                    id
                };
                let source = workspace
                    .sources
                    .iter()
                    .find(|source| source.id == source_id)
                    .cloned()
                    .unwrap_or(Source {
                        id: source_id.clone(),
                        kind: "manual".to_string(),
                        name: MANUAL_SOURCE_NAME.to_string(),
                        url: None,
                        prefix: String::new(),
                        keep_rules: false,
                        updated_at: None,
                        userinfo: None,
                        note: Some(MANUAL_SOURCE_NOTE.to_string()),
                    });
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
