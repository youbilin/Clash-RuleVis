use std::fs;
use std::path::PathBuf;

use rulevis_app::types::ApiFailure;
use rulevis_app::{handle_request, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("clash-rulevis-test-{}-{}", label, Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> PathBuf {
        self.0.clone()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn call(
    state: &AppState,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ApiFailure> {
    handle_request(state, method, path, body)
}

fn workspace_of(state: &AppState) -> Value {
    call(state, "GET", "/api/workspace", None).unwrap()["workspace"].clone()
}

fn put_workspace(state: &AppState, workspace: Value, base_revision: u64) -> Value {
    call(
        state,
        "PUT",
        "/api/workspace",
        Some(json!({ "workspace": workspace, "baseRevision": base_revision })),
    )
    .unwrap()["workspace"]
        .clone()
}

fn disable_base_template(state: &AppState) -> Value {
    let mut workspace = workspace_of(state);
    let revision = workspace["revision"].as_u64().unwrap();
    workspace["settings"]["includeBaseTemplate"] = json!(false);
    put_workspace(state, workspace, revision)
}

fn add_manual_node(state: &AppState, name: &str, server: &str) -> Value {
    call(
        state,
        "POST",
        "/api/sources/manual",
        Some(json!({
            "name": name,
            "proxy": {
                "name": name,
                "type": "ss",
                "server": server,
                "port": 8388,
                "cipher": "aes-256-gcm",
                "password": "secret"
            }
        })),
    )
    .unwrap()["workspace"]
        .clone()
}

fn node_id_by_name(workspace: &Value, name: &str) -> String {
    workspace["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == name)
        .and_then(|node| node["id"].as_str())
        .unwrap()
        .to_string()
}

#[test]
fn api_failure_serializes_payload_for_the_frontend() {
    let failure = ApiFailure::new(409, "冲突")
        .with_code("REVISION_CONFLICT")
        .with_value("workspace", json!({ "revision": 3 }));
    let value = serde_json::to_value(failure).unwrap();
    assert_eq!(value["status"], json!(409));
    assert_eq!(value["error"], json!("冲突"));
    assert_eq!(value["code"], json!("REVISION_CONFLICT"));
    assert_eq!(value["workspace"]["revision"], json!(3));
}

#[test]
fn workspace_save_persists_and_reports_revision_conflicts() {
    let dir = TempDir::new("workspace");
    let state = AppState::load(dir.path()).unwrap();
    let mut workspace = workspace_of(&state);
    assert_eq!(workspace["revision"], json!(0));
    assert_eq!(workspace["exits"].as_array().unwrap().len(), 4);

    workspace["nodes"] = json!([{
        "id": "node-1",
        "sourceId": "missing-source",
        "name": "测试节点",
        "raw": { "name": "测试节点", "type": "ss", "server": "a.example.com", "port": 443 },
        "tags": [],
        "enabled": true,
        "addedAt": "2026-10-20T00:00:00.000Z"
    }]);
    let saved = put_workspace(&state, workspace.clone(), 0);
    assert_eq!(saved["revision"], json!(1));
    assert_eq!(saved["nodes"].as_array().unwrap().len(), 1);

    let conflict = handle_request(
        &state,
        "PUT",
        "/api/workspace",
        Some(json!({ "workspace": workspace, "baseRevision": 0 })),
    )
    .unwrap_err();
    assert_eq!(conflict.status, 409);
    assert_eq!(
        conflict.extra.get("workspace").unwrap()["revision"],
        json!(1)
    );

    drop(state);
    let reloaded = AppState::load(dir.path()).unwrap();
    let workspace = workspace_of(&reloaded);
    assert_eq!(workspace["revision"], json!(1));
    assert_eq!(workspace["nodes"][0]["name"], json!("测试节点"));
    assert!(dir.path().join("workspace.json").is_file());
}

#[test]
fn manual_nodes_chain_export_history_and_restore_work_end_to_end() {
    let dir = TempDir::new("export");
    let state = AppState::load(dir.path()).unwrap();
    disable_base_template(&state);

    let workspace = add_manual_node(&state, "东京 01", "tokyo.example.com");
    assert_eq!(workspace["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(workspace["sources"][0]["name"], json!("节点链接"));
    assert_eq!(workspace["sources"][0]["note"], json!("manual-link"));

    let workspace = add_manual_node(&state, "洛杉矶 01", "la.example.com");
    assert_eq!(workspace["nodes"].as_array().unwrap().len(), 2);

    let relay_id = node_id_by_name(&workspace, "东京 01");
    let landing_id = node_id_by_name(&workspace, "洛杉矶 01");
    let chain = call(
        &state,
        "POST",
        "/api/chains",
        Some(json!({
            "relayNodeId": relay_id,
            "landingNodeId": landing_id,
            "name": "东京 → 洛杉矶"
        })),
    )
    .unwrap();
    let workspace = chain["workspace"].clone();
    assert_eq!(workspace["nodes"].as_array().unwrap().len(), 3);
    let chain_node = workspace["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "东京 → 洛杉矶")
        .unwrap();
    assert_eq!(chain_node["raw"]["dialer-proxy"], json!("东京 01"));
    assert_eq!(chain_node["chain"]["relayNodeId"], json!(relay_id));

    let preview = call(&state, "GET", "/api/export/preview", None).unwrap();
    assert_eq!(preview["counts"]["nodes"], json!(3));
    assert_eq!(preview["counts"]["rules"], json!(1));
    assert!(preview["issues"]
        .as_array()
        .unwrap()
        .iter()
        .all(|issue| issue["severity"] != "error"));
    assert!(preview["yaml"]
        .as_str()
        .unwrap()
        .contains("dialer-proxy: 东京 01"));

    let exported = call(&state, "POST", "/api/export", None).unwrap();
    let export_path = exported["path"].as_str().unwrap().to_string();
    assert!(PathBuf::from(&export_path).is_file());
    assert!(export_path.ends_with(".yaml"));
    let yaml = fs::read_to_string(&export_path).unwrap();
    assert!(yaml.contains("东京 → 洛杉矶"));
    assert_eq!(exported["validation"]["available"], json!(false));
    assert_eq!(exported["workspace"]["lastExport"]["nodeCount"], json!(3));
    let history_id = exported["historyId"].as_str().unwrap().to_string();

    let history = call(&state, "GET", "/api/history", None).unwrap();
    assert!(history["entries"].as_array().unwrap().len() >= 4);
    let exported_yaml = call(
        &state,
        "GET",
        &format!("/api/history/{}/export", history_id),
        None,
    )
    .unwrap();
    assert!(exported_yaml["yaml"]
        .as_str()
        .unwrap()
        .contains("洛杉矶 01"));

    let snapshot = call(
        &state,
        "POST",
        "/api/history/snapshot",
        Some(json!({ "label": "测试快照" })),
    )
    .unwrap();
    let snapshot_id = snapshot["entry"]["id"].as_str().unwrap().to_string();

    let mut cleared = exported["workspace"].clone();
    let revision = cleared["revision"].as_u64().unwrap();
    cleared["nodes"] = json!([]);
    let cleared = put_workspace(&state, cleared, revision);
    assert_eq!(cleared["nodes"].as_array().unwrap().len(), 0);

    let restored = call(
        &state,
        "POST",
        &format!("/api/history/{}/restore", snapshot_id),
        None,
    )
    .unwrap();
    assert_eq!(restored["workspace"]["nodes"].as_array().unwrap().len(), 3);
    assert!(restored["undoEntry"]["id"].is_string());

    let summary = call(
        &state,
        "GET",
        &format!("/api/history/{}/summary", snapshot_id),
        None,
    )
    .unwrap();
    assert_eq!(summary["summary"]["current"]["nodes"], json!(3));

    drop(state);
    let reloaded = AppState::load(dir.path()).unwrap();
    assert_eq!(
        workspace_of(&reloaded)["nodes"].as_array().unwrap().len(),
        3
    );
}

#[test]
fn ruleset_batch_create_dedupes_and_deletes() {
    let dir = TempDir::new("rulesets");
    let state = AppState::load(dir.path()).unwrap();
    let workspace = disable_base_template(&state);
    let exit_id = workspace["exits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|exit| exit["name"] == "自动选择")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let payload = json!({
        "exitId": exit_id,
        "items": [
            {
                "name": "OpenAI",
                "providerName": "openai",
                "url": "https://example.com/geosite/openai.mrs",
                "behavior": "domain",
                "format": "mrs"
            },
            {
                "name": "YouTube",
                "providerName": "youtube",
                "url": "https://example.com/geosite/youtube.mrs",
                "behavior": "domain",
                "format": "mrs"
            }
        ]
    });
    let created = call(
        &state,
        "POST",
        "/api/rule-sets/create-batch",
        Some(payload.clone()),
    )
    .unwrap();
    assert_eq!(created["added"], json!(2));
    let workspace = created["workspace"].clone();
    let route_id = workspace["routes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|route| route["name"] == "OpenAI")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let duplicate = call(&state, "POST", "/api/rule-sets/create-batch", Some(payload)).unwrap();
    assert_eq!(duplicate["added"], json!(0));
    assert_eq!(duplicate["skipped"].as_array().unwrap().len(), 2);

    let preview = call(&state, "GET", "/api/export/preview", None).unwrap();
    assert_eq!(preview["counts"]["providers"], json!(2));
    assert_eq!(preview["counts"]["rules"], json!(3));

    let deleted = call(
        &state,
        "DELETE",
        &format!("/api/rule-sets/{}", route_id),
        None,
    )
    .unwrap();
    assert_eq!(
        deleted["workspace"]["routes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|route| route["kind"] == "ruleset")
            .count(),
        1
    );
}

#[test]
fn source_patch_delete_and_unsupported_endpoints_are_explicit() {
    let dir = TempDir::new("sources");
    let state = AppState::load(dir.path()).unwrap();
    let workspace = add_manual_node(&state, "东京 01", "tokyo.example.com");
    let source_id = workspace["sources"][0]["id"].as_str().unwrap().to_string();

    let patched = call(
        &state,
        "PATCH",
        &format!("/api/sources/{}", source_id),
        Some(json!({ "name": "手动机场", "prefix": "M-", "keepRules": true })),
    )
    .unwrap();
    assert_eq!(
        patched["workspace"]["sources"][0]["name"],
        json!("手动机场")
    );
    assert_eq!(patched["workspace"]["sources"][0]["prefix"], json!("M-"));

    let deleted = call(
        &state,
        "DELETE",
        &format!("/api/sources/{}", source_id),
        None,
    )
    .unwrap();
    assert_eq!(deleted["workspace"]["sources"].as_array().unwrap().len(), 0);
    assert_eq!(deleted["workspace"]["nodes"].as_array().unwrap().len(), 0);

    let subscription = call(
        &state,
        "POST",
        "/api/sources/subscription",
        Some(json!({ "url": "https://example.com/sub" })),
    )
    .unwrap_err();
    assert_eq!(subscription.status, 501);
    assert_eq!(subscription.code.as_deref(), Some("DESKTOP_UNAVAILABLE"));

    let delay = call(
        &state,
        "POST",
        "/api/delay",
        Some(json!({ "names": ["x"] })),
    )
    .unwrap_err();
    assert_eq!(delay.status, 501);

    let live = call(&state, "GET", "/api/live", None).unwrap();
    assert_eq!(live["kernel"]["connected"], json!(false));
    assert_eq!(live["connections"], json!([]));
}

#[test]
fn workspace_backup_import_creates_undo_snapshot() {
    let dir = TempDir::new("import");
    let state = AppState::load(dir.path()).unwrap();
    let workspace = add_manual_node(&state, "东京 01", "tokyo.example.com");

    let mut backup = workspace.clone();
    backup["nodes"] = json!([]);
    backup["sources"] = json!([]);
    let imported = call(
        &state,
        "POST",
        "/api/workspace/import",
        Some(json!({ "backup": { "workspace": backup, "workspaceVersion": 2 } })),
    )
    .unwrap();
    assert_eq!(imported["workspace"]["nodes"].as_array().unwrap().len(), 0);
    assert!(imported["undoEntry"]["id"].is_string());

    let restored = call(
        &state,
        "POST",
        &format!(
            "/api/history/{}/restore",
            imported["undoEntry"]["id"].as_str().unwrap()
        ),
        None,
    )
    .unwrap();
    assert_eq!(restored["workspace"]["nodes"].as_array().unwrap().len(), 1);
}
