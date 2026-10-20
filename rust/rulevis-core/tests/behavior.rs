use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rulevis_core::generator::{generate_config, GenerateOptions};
use rulevis_core::links::{parse_share_link, share_node_to_proxy};
use rulevis_core::model::{
    Exit, ExitMember, ProxyNode, Route, RuleRoute, RuleSetRoute, RuleSetSource, Source, Workspace,
};
use serde_json::json;

fn b64(value: &str) -> String {
    STANDARD.encode(value.as_bytes())
}

fn test_workspace() -> Workspace {
    let source = Source {
        id: "s1".to_string(),
        kind: "file".to_string(),
        name: "Test".to_string(),
        url: None,
        prefix: "T-".to_string(),
        keep_rules: false,
        updated_at: None,
        userinfo: None,
        note: None,
    };
    let node = |id: &str, name: &str| ProxyNode {
        id: id.to_string(),
        source_id: "s1".to_string(),
        name: name.to_string(),
        raw: json!({
            "name": name,
            "type": "ss",
            "server": "a.example.com",
            "port": 443,
            "cipher": "aes-256-gcm",
            "password": "secret"
        })
        .as_object()
        .unwrap()
        .clone(),
        region: Some("日本".to_string()),
        tags: vec!["家宽".to_string()],
        enabled: true,
        added_at: String::new(),
        updated_at: None,
        chain: None,
    };
    let home = Exit {
        id: "home".to_string(),
        name: "家宽".to_string(),
        kind: "select".to_string(),
        members: vec![ExitMember {
            by: "tag".to_string(),
            value: "家宽".to_string(),
        }],
        builtin: None,
        source_id: None,
        order: 0,
        test_url: None,
        interval: None,
        tolerance: None,
    };
    let auto = Exit {
        id: "auto".to_string(),
        name: "自动选择".to_string(),
        kind: "url-test".to_string(),
        members: vec![ExitMember {
            by: "regex".to_string(),
            value: ".*".to_string(),
        }],
        builtin: None,
        source_id: None,
        order: 1,
        test_url: None,
        interval: None,
        tolerance: None,
    };
    let custom = RuleRoute {
        id: "r1".to_string(),
        rule_type: "DOMAIN-SUFFIX".to_string(),
        payload: "example.com".to_string(),
        exit_id: "home".to_string(),
        target_node_id: None,
        no_resolve: None,
        origin: "manual".to_string(),
        source_id: None,
        note: None,
        enabled: true,
        pending: None,
        applied_at: None,
    };
    let match_route = RuleRoute {
        id: "match".to_string(),
        rule_type: "MATCH".to_string(),
        payload: String::new(),
        exit_id: "auto".to_string(),
        target_node_id: None,
        no_resolve: None,
        origin: "manual".to_string(),
        source_id: None,
        note: None,
        enabled: true,
        pending: None,
        applied_at: None,
    };
    Workspace {
        version: 2,
        revision: 0,
        created_at: String::new(),
        updated_at: String::new(),
        sources: vec![source],
        nodes: vec![node("n1", "日本 01"), node("n2", "日本 02")],
        exits: vec![home, auto],
        routes: vec![Route::Rule(custom), Route::Rule(match_route)],
        settings: Default::default(),
        last_export: None,
    }
}

fn rules(yaml: &str) -> Vec<String> {
    let document: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
    document["rules"]
        .as_sequence()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn share_links_cover_reality_obfs_and_proxy_conversion() {
    let vless = parse_share_link("vless://11111111-2222-3333-4444-555555555555@vless.example:443?security=reality&type=grpc&serviceName=svc&sni=front.example&pbk=public&sid=abcd&fp=chrome&flow=xtls-rprx-vision#V").unwrap();
    assert_eq!(vless.network, "grpc");
    assert_eq!(vless.service.as_deref(), Some("svc"));
    assert_eq!(vless.flow.as_deref(), Some("xtls-rprx-vision"));
    assert!(vless.tls);
    assert_eq!(
        vless.extras.get("reality-opts"),
        Some(&json!({"public-key": "public", "short-id": "abcd"}))
    );
    let proxy = share_node_to_proxy(&vless);
    assert_eq!(proxy["name"], json!("V"));
    assert_eq!(proxy["servername"], json!("front.example"));
    assert_eq!(proxy["grpc-opts"], json!({"grpc-service-name": "svc"}));
    assert_eq!(
        proxy["reality-opts"],
        json!({"public-key": "public", "short-id": "abcd"})
    );

    let hy2 = parse_share_link("hysteria2://auth@hy.example:8443?sni=front.example&insecure=1&obfs=salamander&obfs-password=secret#H").unwrap();
    assert_eq!(hy2.extras.get("skip-cert-verify"), Some(&json!(true)));
    assert_eq!(hy2.extras.get("obfs"), Some(&json!("salamander")));
    let hy2_proxy = share_node_to_proxy(&hy2);
    assert_eq!(hy2_proxy.get("network"), None);
    assert_eq!(hy2_proxy["sni"], json!("front.example"));

    let ss = parse_share_link(&format!(
        "ss://{}@example.com:8388#{}",
        b64("aes-256-gcm:pass:word"),
        "%F0%9F%87%AF%F0%9F%87%B5%20JP"
    ))
    .unwrap();
    assert_eq!(ss.password.as_deref(), Some("pass:word"));
    assert_eq!(ss.name.as_deref(), Some("🇯🇵 JP"));

    let ssr_payload = b64(&format!(
        "ssr.example:8388:auth_aes128_md5:aes-256-cfb:tls1.2_ticket_auth:{}/?remarks={}&obfsparam={}",
        b64("ssr-pass"),
        b64("SSR 节点"),
        b64("cdn.example")
    ));
    let ssr = parse_share_link(&format!("ssr://{}", ssr_payload)).unwrap();
    assert_eq!(ssr.name.as_deref(), Some("SSR 节点"));
    assert_eq!(ssr.password.as_deref(), Some("ssr-pass"));
    assert_eq!(ssr.extras.get("protocol"), Some(&json!("auth_aes128_md5")));
    assert_eq!(ssr.extras.get("obfs-param"), Some(&json!("cdn.example")));
}

#[test]
fn invalid_share_links_report_actionable_errors() {
    assert_eq!(
        parse_share_link("https://example.com/sub")
            .unwrap_err()
            .message,
        "这是订阅或网页链接，请切换到「订阅」标签导入"
    );
    assert_eq!(
        parse_share_link("vmess://not-base64").unwrap_err().message,
        "VMess 链接内容无法解析，请确认链接完整"
    );
    assert_eq!(
        parse_share_link("vless://uuid@host:443?type=ws path")
            .unwrap_err()
            .message,
        "链接中间含有空白字符，请检查是否被换行截断"
    );
    assert_eq!(
        parse_share_link("").unwrap_err().message,
        "请粘贴节点分享链接"
    );
    assert!(parse_share_link("ss://bad").is_err());
    assert!(parse_share_link("socks5://127.0.0.1#no-port").is_err());
}

#[test]
fn generator_supports_direct_node_targets_and_blocks_broken_targets() {
    let mut workspace = test_workspace();
    workspace.routes.insert(
        0,
        Route::Rule(RuleRoute {
            id: "node-rule".to_string(),
            rule_type: "DOMAIN-SUFFIX".to_string(),
            payload: "direct.example".to_string(),
            exit_id: String::new(),
            target_node_id: Some("n1".to_string()),
            no_resolve: None,
            origin: "manual".to_string(),
            source_id: None,
            note: None,
            enabled: true,
            pending: None,
            applied_at: None,
        }),
    );
    let generated = generate_config(&workspace, &GenerateOptions::default());
    assert!(generated
        .issues
        .iter()
        .all(|issue| issue.severity != rulevis_core::model::IssueSeverity::Error));
    assert!(rules(&generated.yaml).contains(&"DOMAIN-SUFFIX,direct.example,T-日本 01".to_string()));

    workspace.routes[0] = Route::Rule(RuleRoute {
        id: "node-rule".to_string(),
        rule_type: "DOMAIN-SUFFIX".to_string(),
        payload: "direct.example".to_string(),
        exit_id: String::new(),
        target_node_id: Some("missing".to_string()),
        no_resolve: None,
        origin: "manual".to_string(),
        source_id: None,
        note: None,
        enabled: true,
        pending: None,
        applied_at: None,
    });
    let missing = generate_config(&workspace, &GenerateOptions::default());
    assert!(missing
        .issues
        .iter()
        .any(|issue| issue.code == "missing-node"));
}

#[test]
fn generator_reports_chain_relay_and_inline_ruleset_cases() {
    let mut workspace = test_workspace();
    workspace.sources.push(Source {
        id: "chain-source".to_string(),
        kind: "chain".to_string(),
        name: "链式代理".to_string(),
        url: None,
        prefix: String::new(),
        keep_rules: false,
        updated_at: None,
        userinfo: None,
        note: None,
    });
    workspace.nodes.push(ProxyNode {
        id: "chain-node".to_string(),
        source_id: "chain-source".to_string(),
        name: "失效链路".to_string(),
        raw: json!({"type": "ss", "server": "b.example.com", "port": 443})
            .as_object()
            .unwrap()
            .clone(),
        region: None,
        tags: vec!["链式".to_string()],
        enabled: true,
        added_at: String::new(),
        updated_at: None,
        chain: Some(rulevis_core::model::ChainMeta {
            relay_node_id: "missing".to_string(),
            landing_node_id: "n2".to_string(),
        }),
    });
    let generated = generate_config(&workspace, &GenerateOptions::default());
    assert!(generated
        .issues
        .iter()
        .any(|issue| issue.code == "chain-relay-missing"));

    let mut inline_workspace = test_workspace();
    inline_workspace.routes.insert(
        1,
        Route::Ruleset(RuleSetRoute {
            id: "rs1".to_string(),
            name: "openai".to_string(),
            provider_name: None,
            behavior: "domain".to_string(),
            format: "mrs".to_string(),
            source: RuleSetSource {
                kind: "url".to_string(),
                value: "https://example.com/openai.mrs".to_string(),
                file_name: None,
                size: None,
            },
            inline: true,
            inline_rules: Some(vec![rulevis_core::model::InlineRule {
                rule_type: "DOMAIN-SUFFIX".to_string(),
                payload: "openai.com".to_string(),
                no_resolve: None,
            }]),
            rule_count: Some(1),
            exit_id: "auto".to_string(),
            no_resolve: None,
            enabled: true,
            interval: Some(86400),
            updated_at: None,
            origin: Some("manual".to_string()),
            source_id: None,
            pending: None,
            applied_at: None,
        }),
    );
    let inline = generate_config(&inline_workspace, &GenerateOptions::default());
    assert_eq!(inline.counts.providers, 0);
    assert!(rules(&inline.yaml).contains(&"DOMAIN-SUFFIX,openai.com,自动选择".to_string()));
}

#[test]
fn generator_reports_cycles_and_keeps_subscription_urls_private() {
    let mut workspace = test_workspace();
    workspace.exits.push(Exit {
        id: "a".to_string(),
        name: "A".to_string(),
        kind: "select".to_string(),
        members: vec![ExitMember {
            by: "exit".to_string(),
            value: "b".to_string(),
        }],
        builtin: None,
        source_id: None,
        order: 2,
        test_url: None,
        interval: None,
        tolerance: None,
    });
    workspace.exits.push(Exit {
        id: "b".to_string(),
        name: "B".to_string(),
        kind: "select".to_string(),
        members: vec![ExitMember {
            by: "exit".to_string(),
            value: "a".to_string(),
        }],
        builtin: None,
        source_id: None,
        order: 3,
        test_url: None,
        interval: None,
        tolerance: None,
    });
    workspace.sources[0] = Source {
        kind: "subscription".to_string(),
        url: Some("https://secret-provider.example.com/sub?token=top-secret".to_string()),
        ..workspace.sources[0].clone()
    };
    let generated = generate_config(&workspace, &GenerateOptions::default());
    assert!(generated
        .issues
        .iter()
        .any(|issue| issue.message.contains("形成环")));
    assert!(!generated.yaml.contains("secret-provider.example.com"));
    assert!(!generated.yaml.contains("top-secret"));
}

#[test]
fn generator_reports_shadowed_rules_and_empty_exits() {
    let mut workspace = test_workspace();
    workspace.routes.insert(
        1,
        Route::Rule(RuleRoute {
            id: "r2".to_string(),
            rule_type: "DOMAIN".to_string(),
            payload: "www.example.com".to_string(),
            exit_id: "home".to_string(),
            target_node_id: None,
            no_resolve: None,
            origin: "manual".to_string(),
            source_id: None,
            note: None,
            enabled: true,
            pending: None,
            applied_at: None,
        }),
    );
    let generated = generate_config(&workspace, &GenerateOptions::default());
    assert!(generated
        .issues
        .iter()
        .any(|issue| issue.code == "shadowed-rule"));

    workspace.exits[0].members.clear();
    let empty = generate_config(&workspace, &GenerateOptions::default());
    assert!(empty.issues.iter().any(|issue| issue.code == "empty-exit"));
}
