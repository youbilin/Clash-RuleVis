use std::fs;
use std::path::PathBuf;

use rulevis_core::defaults::{ensure_workspace_shape, normalize_manual_sources};
use rulevis_core::generator::{generate_config, GenerateOptions};
use rulevis_core::links::{parse_share_link, share_node_to_proxy};
use rulevis_core::model::{Exit, ExitMember, ProxyNode, Source, Workspace};
use serde_json::{json, Map, Value};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn demo_workspace() -> Workspace {
    let text = fs::read_to_string(fixture_dir().join("../demo/workspace.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn generated_yaml_matches_typescript_fixture() {
    let workspace = demo_workspace();
    let generated = generate_config(&workspace, &GenerateOptions::default());

    let expected_yaml: serde_yaml::Value = serde_yaml::from_str(
        &fs::read_to_string(fixture_dir().join("expected/demo-export.yaml")).unwrap(),
    )
    .unwrap();
    let actual_yaml: serde_yaml::Value = serde_yaml::from_str(&generated.yaml).unwrap();
    assert_eq!(actual_yaml, expected_yaml);

    let expected: Value = serde_json::from_str(
        &fs::read_to_string(fixture_dir().join("expected/demo-export.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&generated.counts).unwrap(),
        expected["counts"]
    );
    assert_eq!(
        serde_json::to_value(&generated.issues).unwrap(),
        expected["issues"]
    );
}

#[test]
fn share_link_parsing_matches_typescript_fixture() {
    let entries: Vec<Value> =
        serde_json::from_str(&fs::read_to_string(fixture_dir().join("links/parsed.json")).unwrap())
            .unwrap();
    for entry in entries {
        let link = entry["link"].as_str().unwrap();
        if let Some(expected) = entry.get("node") {
            let node = parse_share_link(link)
                .unwrap_or_else(|error| panic!("{} should parse: {}", link, error));
            let actual = serde_json::to_value(&node).unwrap();
            assert_eq!(&actual, expected, "link mismatch: {}", link);
        } else {
            let expected_error = entry["error"].as_str().unwrap();
            let error = parse_share_link(link).expect_err("link should fail");
            assert_eq!(error.message, expected_error, "error mismatch: {}", link);
        }
    }
}

#[test]
fn percent_encoded_ss_keeps_password_bytes() {
    let node =
        parse_share_link("ss://aes-128-gcm%3A9NosWuwAmgkVsMlBN0Pvvw%3D%3D@142.91.109.151:23025#ss")
            .unwrap();
    assert_eq!(node.cipher.as_deref(), Some("aes-128-gcm"));
    assert_eq!(node.password.as_deref(), Some("9NosWuwAmgkVsMlBN0Pvvw=="));
    let proxy = share_node_to_proxy(&node);
    assert_eq!(proxy["server"], json!("142.91.109.151"));
    assert_eq!(proxy["port"], json!(23025));
}

#[test]
fn base_settings_keep_unknown_keys_but_replace_generated_sections() {
    let workspace = demo_workspace();
    let mut base = Map::new();
    base.insert("mixed-port".to_string(), json!(7890));
    base.insert("external-controller".to_string(), json!("127.0.0.1:9090"));
    base.insert("proxies".to_string(), json!([{"name": "stale"}]));
    base.insert("rules".to_string(), json!(["MATCH,DIRECT"]));
    let generated = generate_config(
        &workspace,
        &GenerateOptions {
            base_settings: Some(base),
        },
    );
    let parsed: serde_yaml::Value = serde_yaml::from_str(&generated.yaml).unwrap();
    assert_eq!(parsed["mixed-port"], serde_yaml::Value::Number(7890.into()));
    assert_eq!(
        parsed["external-controller"],
        serde_yaml::Value::String("127.0.0.1:9090".to_string())
    );
    assert_eq!(
        parsed["proxies"].as_sequence().unwrap().len(),
        generated.counts.nodes
    );
    assert!(!parsed["rules"]
        .as_sequence()
        .unwrap()
        .iter()
        .any(|rule| rule.as_str() == Some("MATCH,DIRECT")));
}

fn manual_source(id: &str, name: &str) -> Source {
    Source {
        id: id.to_string(),
        kind: "manual".to_string(),
        name: name.to_string(),
        url: None,
        prefix: "P-".to_string(),
        keep_rules: true,
        updated_at: None,
        userinfo: None,
        note: None,
    }
}

fn proxy_node(id: &str, source_id: &str, name: &str, enabled: bool) -> ProxyNode {
    ProxyNode {
        id: id.to_string(),
        source_id: source_id.to_string(),
        name: name.to_string(),
        raw: Map::new(),
        region: None,
        tags: Vec::new(),
        enabled,
        added_at: String::new(),
        updated_at: None,
        chain: None,
    }
}

fn empty_workspace() -> Workspace {
    Workspace {
        version: 2,
        revision: 0,
        created_at: String::new(),
        updated_at: String::new(),
        sources: Vec::new(),
        nodes: Vec::new(),
        exits: Vec::new(),
        routes: Vec::new(),
        settings: Default::default(),
        last_export: None,
    }
}

#[test]
fn partial_settings_are_filled_from_defaults() {
    let workspace: Workspace = serde_json::from_str(
        r#"{
          "version": 2,
          "sources": [],
          "nodes": [],
          "exits": [],
          "routes": [],
          "settings": { "onboarded": true }
        }"#,
    )
    .unwrap();
    assert!(workspace.settings.onboarded);
    assert_eq!(
        workspace.settings.test_url,
        "https://www.gstatic.com/generate_204"
    );
    assert_eq!(workspace.settings.retention_minutes, 5);
    assert!(workspace.settings.use_proxy_for_fetch);
    assert_eq!(workspace.settings.default_rule_type, "DOMAIN-SUFFIX");
}

#[test]
fn default_workspace_has_builtins_auto_all_and_match() {
    let workspace = rulevis_core::create_default_workspace("2026-10-20T00:00:00.000Z".to_string());
    assert_eq!(workspace.version, 2);
    assert_eq!(workspace.exits.len(), 4);
    assert_eq!(workspace.exits[0].id, "direct");
    assert_eq!(workspace.exits[1].id, "reject");
    assert!(workspace.exits[2].name == "自动选择");
    assert!(workspace.exits[3].name == "全部节点");
    assert_eq!(workspace.routes.len(), 1);
    assert!(workspace.routes[0].is_match());
    assert_eq!(workspace.created_at, "2026-10-20T00:00:00.000Z");
}

#[test]
fn normalization_merges_manual_sources_and_repairs_shape() {
    let mut workspace = empty_workspace();
    workspace.sources = vec![
        Source {
            note: Some("manual-link".to_string()),
            ..manual_source("manual-a", "节点链接")
        },
        manual_source("manual-b", "另一个节点链接"),
        manual_source("manual-empty", "空来源"),
    ];
    workspace.nodes = vec![proxy_node("node-1", "manual-b", "节点一", true)];

    normalize_manual_sources(&mut workspace);
    assert_eq!(workspace.sources.len(), 1);
    assert_eq!(workspace.sources[0].id, "manual-a");
    assert_eq!(workspace.nodes[0].source_id, "manual-a");

    ensure_workspace_shape(&mut workspace);
    assert_eq!(workspace.version, 2);
    assert!(workspace.exits.iter().any(|exit| exit.id == "direct"));
    assert!(workspace.exits.iter().any(|exit| exit.id == "reject"));
    assert_eq!(workspace.routes.len(), 1);
    assert!(workspace.routes[0].is_match());
}

#[test]
fn normalization_prunes_disabled_node_members_and_syncs_chain_names() {
    let mut workspace = empty_workspace();
    workspace.sources = vec![manual_source("manual-a", "节点链接")];
    workspace.nodes = vec![
        proxy_node("relay", "manual-a", "中转", true),
        proxy_node("landing", "manual-a", "落地", true),
        {
            let mut node = proxy_node("disabled", "manual-a", "停用", false);
            node.raw.insert("dialer-proxy".to_string(), json!("old"));
            node
        },
    ];
    workspace.nodes[1]
        .raw
        .insert("dialer-proxy".to_string(), json!("old"));
    workspace.nodes[1].chain = Some(rulevis_core::model::ChainMeta {
        relay_node_id: "relay".to_string(),
        landing_node_id: "landing".to_string(),
    });
    workspace.exits = vec![Exit {
        id: "exit-1".to_string(),
        name: "测试出口".to_string(),
        kind: "select".to_string(),
        members: vec![
            ExitMember {
                by: "node".to_string(),
                value: "relay".to_string(),
            },
            ExitMember {
                by: "node".to_string(),
                value: "disabled".to_string(),
            },
        ],
        builtin: None,
        source_id: None,
        order: 0,
        test_url: None,
        interval: None,
        tolerance: None,
    }];

    ensure_workspace_shape(&mut workspace);
    let exit = workspace
        .exits
        .iter()
        .find(|exit| exit.id == "exit-1")
        .unwrap();
    assert_eq!(exit.members.len(), 1);
    assert_eq!(exit.members[0].value, "relay");
    let landing = workspace
        .nodes
        .iter()
        .find(|node| node.id == "landing")
        .unwrap();
    assert_eq!(
        landing.raw.get("dialer-proxy"),
        Some(&Value::String("P-中转".to_string()))
    );
}
