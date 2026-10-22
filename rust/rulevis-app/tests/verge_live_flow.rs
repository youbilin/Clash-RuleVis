use std::fs;
use std::path::{Path, PathBuf};

use rulevis_app::storage::Store;
use rulevis_app::verge_live;
use sha2::{Digest, Sha256};

fn temp_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "rulevis-live-{}-{}",
        label,
        &uuid::Uuid::new_v4().simple().to_string()[..10]
    ));
    fs::create_dir_all(&root).expect("create temp root");
    root
}

fn sha256(path: &Path) -> String {
    let bytes = fs::read(path).expect("read hash source");
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[test]
fn live_mode_flow_writes_only_the_managed_profile() {
    let root = temp_root("flow");
    let app_data = root.join("appdata");
    let verge_dir = app_data.join("io.github.clash-verge-rev.clash-verge-rev");
    fs::create_dir_all(verge_dir.join("profiles")).expect("create verge dirs");

    fs::write(
        verge_dir.join("config.yaml"),
        r#"mixed-port: 7897
external-controller: 127.0.0.1:9097
secret: runtime-secret
external-controller-pipe: \\.\pipe\verge-test
tun:
  enable: true
"#,
    )
    .expect("write runtime config");

    fs::write(
        verge_dir.join("profiles").join("remote1.yaml"),
        r#"mixed-port: 1111
external-controller: 127.0.0.1:1111
proxy-providers:
  airport:
    type: http
    url: https://example.com/subscribe
    path: ./airport.yaml
proxies:
  - name: subscription-node
    type: socks5
    server: 127.0.0.1
    port: 1080
proxy-groups:
  - name: PROXY
    type: select
    proxies: [subscription-node]
rules:
  - DOMAIN-SUFFIX,subscription.test,PROXY
  - MATCH,DIRECT
"#,
    )
    .expect("write remote profile");
    fs::write(
        verge_dir.join("profiles.yaml"),
        "current: remote1\nitems:\n  - uid: remote1\n    type: remote\n    name: 机场订阅\n    file: remote1.yaml\n    selected:\n      - name: PROXY\n        now: subscription-node\n",
    )
    .expect("write profiles.yaml");

    let data_dir = root.join("data");
    fs::create_dir_all(&data_dir).expect("create data dir");
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../demo/workspace.json"),
        data_dir.join("workspace.json"),
    )
    .expect("copy demo workspace");
    let mut store = Store::load(data_dir.clone()).expect("load store");

    std::env::set_var("APPDATA", &app_data);
    std::env::set_var("LOCALAPPDATA", &app_data);

    let original_hash = sha256(&verge_dir.join("profiles").join("remote1.yaml"));
    let view = verge_live::status(&store);
    assert!(view.available);
    assert_eq!(view.mode, "safe");

    let view = verge_live::enable(&store).expect("enable live mode");
    assert_eq!(view.mode, "live");
    assert!(view.current_matches);
    let live = view.live_profile.clone().expect("live profile ref");
    let original = view.original_profile.clone().expect("original ref");
    assert_eq!(original.name, "机场订阅");
    assert_ne!(live.uid, original.uid);

    let profiles_doc: serde_yaml::Value = serde_yaml::from_str(
        &fs::read_to_string(verge_dir.join("profiles.yaml")).expect("read profiles"),
    )
    .expect("profiles yaml");
    let live_item = profiles_doc["items"]
        .as_sequence()
        .expect("items")
        .iter()
        .find(|item| item["uid"].as_str() == Some(live.uid.as_str()))
        .expect("live item");
    assert_eq!(
        live_item["selected"][0]["now"].as_str(),
        Some("subscription-node")
    );

    let live_yaml = fs::read_to_string(&live.path).expect("read live seed");
    let seed: serde_yaml::Value = serde_yaml::from_str(&live_yaml).expect("seed yaml");
    let seed = seed.as_mapping().expect("seed mapping");
    assert_eq!(
        seed.get("external-controller")
            .and_then(serde_yaml::Value::as_str),
        Some("127.0.0.1:9097")
    );
    assert_eq!(
        seed.get("external-controller-pipe")
            .and_then(serde_yaml::Value::as_str),
        Some("\\\\.\\pipe\\verge-test")
    );
    assert_eq!(
        seed.get("secret").and_then(serde_yaml::Value::as_str),
        Some("runtime-secret")
    );
    assert!(seed.get("proxy-providers").is_some());

    let plan = verge_live::prepare_apply(&store).expect("prepare apply");
    assert!(plan.yaml.contains("东京 01"));
    let merged: serde_yaml::Value = serde_yaml::from_str(&plan.yaml).expect("merged yaml");
    let merged = merged.as_mapping().expect("merged mapping");
    assert_eq!(
        merged
            .get("external-controller")
            .and_then(serde_yaml::Value::as_str),
        Some("127.0.0.1:9097")
    );
    assert_eq!(
        merged.get("tun").and_then(|tun| tun.get("enable")),
        Some(&serde_yaml::Value::Bool(true))
    );

    let result = verge_live::finish_apply(&mut store, &plan).expect("finish apply");
    assert!(result.get("historyId").is_some());
    assert!(!store.workspace().routes.iter().any(|route| matches!(
        route,
        rulevis_core::model::Route::Rule(rule) if rule.pending.is_some()
    )));
    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(data_dir.join("verge-live.json")).expect("read state"),
    )
    .expect("state json");
    assert_eq!(state["mode"], "live");
    assert_eq!(state["lastAppliedHash"], plan.new_hash);

    let (seed_backup, restored) = verge_live::prepare_disable(&store).expect("prepare disable");
    assert_eq!(restored.uid, original.uid);
    let current_doc = fs::read_to_string(verge_dir.join("profiles.yaml")).expect("read profiles");
    assert!(current_doc.contains("current: remote1"));
    assert!(seed_backup.contains("subscription-node"));

    let view = verge_live::finish_disable(&store).expect("finish disable");
    assert_eq!(view.mode, "safe");
    assert_eq!(sha256(Path::new(&original.path)), original_hash);
    assert!(Path::new(&live.path).is_file());
    assert!(Path::new(&plan.backup_path).is_file());

    let _ = fs::remove_dir_all(root);
}
