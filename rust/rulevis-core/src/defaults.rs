use std::collections::HashSet;

use serde_json::Value;
use uuid::Uuid;

use crate::model::{Exit, Route, RuleRoute, Source, Workspace, WORKSPACE_VERSION};

pub const MANUAL_SOURCE_NAME: &str = "节点链接";
pub const MANUAL_SOURCE_NOTE: &str = "manual-link";

pub fn create_default_workspace(created_at: String) -> Workspace {
    let auto_id = Uuid::new_v4().to_string();
    let all_id = Uuid::new_v4().to_string();
    let mut exits = create_builtin_exits();
    exits.push(Exit {
        id: auto_id.clone(),
        name: "自动选择".to_string(),
        kind: "url-test".to_string(),
        members: vec![crate::model::ExitMember {
            by: "regex".to_string(),
            value: ".*".to_string(),
        }],
        builtin: None,
        source_id: None,
        order: 0,
        test_url: None,
        interval: Some(300),
        tolerance: None,
    });
    exits.push(Exit {
        id: all_id,
        name: "全部节点".to_string(),
        kind: "select".to_string(),
        members: vec![crate::model::ExitMember {
            by: "regex".to_string(),
            value: ".*".to_string(),
        }],
        builtin: None,
        source_id: None,
        order: 1,
        test_url: None,
        interval: None,
        tolerance: None,
    });
    let match_route = RuleRoute {
        id: Uuid::new_v4().to_string(),
        rule_type: "MATCH".to_string(),
        payload: String::new(),
        exit_id: auto_id,
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
        version: WORKSPACE_VERSION,
        revision: 0,
        created_at: created_at.clone(),
        updated_at: created_at,
        sources: Vec::new(),
        nodes: Vec::new(),
        exits,
        routes: vec![Route::Rule(match_route)],
        settings: Default::default(),
        last_export: None,
    }
}

pub fn create_builtin_exits() -> Vec<Exit> {
    vec![
        Exit {
            id: "direct".to_string(),
            name: "DIRECT".to_string(),
            kind: "select".to_string(),
            members: Vec::new(),
            builtin: Some(true),
            source_id: None,
            order: -2,
            test_url: None,
            interval: None,
            tolerance: None,
        },
        Exit {
            id: "reject".to_string(),
            name: "REJECT".to_string(),
            kind: "select".to_string(),
            members: Vec::new(),
            builtin: Some(true),
            source_id: None,
            order: -1,
            test_url: None,
            interval: None,
            tolerance: None,
        },
    ]
}

pub fn normalize_manual_sources(workspace: &mut Workspace) {
    let manual_sources: Vec<Source> = workspace
        .sources
        .iter()
        .filter(|source| source.kind == "manual")
        .cloned()
        .collect();
    if manual_sources.is_empty() {
        return;
    }
    let mut empty_ids = HashSet::new();
    for source in manual_sources {
        let node_indexes: Vec<usize> = workspace
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| node.source_id == source.id)
            .map(|(index, _)| index)
            .collect();
        if node_indexes.is_empty() {
            empty_ids.insert(source.id.clone());
            continue;
        }
        if let Some(target) = workspace
            .sources
            .iter_mut()
            .find(|item| item.id == source.id)
        {
            target.note = Some(MANUAL_SOURCE_NOTE.to_string());
        }
        if node_indexes.len() == 1 {
            continue;
        }
        let first_name = if workspace.nodes[node_indexes[0]].name.is_empty() {
            MANUAL_SOURCE_NAME.to_string()
        } else {
            workspace.nodes[node_indexes[0]].name.clone()
        };
        if let Some(target) = workspace
            .sources
            .iter_mut()
            .find(|item| item.id == source.id)
        {
            target.name = first_name;
            target.keep_rules = false;
        }
        for index in &node_indexes[1..] {
            let node_id = workspace.nodes[*index].id.clone();
            let node_name = if workspace.nodes[*index].name.is_empty() {
                MANUAL_SOURCE_NAME.to_string()
            } else {
                workspace.nodes[*index].name.clone()
            };
            let mut source_id = format!("manual-{}", node_id);
            let mut suffix = 2;
            while workspace.sources.iter().any(|item| item.id == source_id) {
                source_id = format!("manual-{}-{}", node_id, suffix);
                suffix += 1;
            }
            let mut next = source.clone();
            next.id = source_id.clone();
            next.name = node_name;
            next.keep_rules = false;
            next.note = Some(MANUAL_SOURCE_NOTE.to_string());
            workspace.sources.push(next);
            workspace.nodes[*index].source_id = source_id;
        }
    }
    workspace
        .sources
        .retain(|source| !empty_ids.contains(&source.id));
}

fn sync_chain_dialer_proxies(workspace: &mut Workspace) {
    for index in 0..workspace.nodes.len() {
        let Some(chain) = workspace.nodes[index].chain.clone() else {
            continue;
        };
        let Some(relay_index) = workspace
            .nodes
            .iter()
            .position(|node| node.id == chain.relay_node_id)
        else {
            continue;
        };
        let prefix = workspace
            .sources
            .iter()
            .find(|source| source.id == workspace.nodes[relay_index].source_id)
            .map(|source| source.prefix.as_str())
            .unwrap_or("");
        let relay_name = format!("{}{}", prefix, workspace.nodes[relay_index].name);
        workspace.nodes[index]
            .raw
            .insert("dialer-proxy".to_string(), Value::String(relay_name));
    }
}

pub fn prune_unavailable_exit_members(workspace: &mut Workspace) {
    let enabled: HashSet<String> = workspace
        .nodes
        .iter()
        .filter(|node| node.enabled)
        .map(|node| node.id.clone())
        .collect();
    for exit in &mut workspace.exits {
        if !exit.members.iter().any(|member| member.by == "node") {
            continue;
        }
        exit.members
            .retain(|member| member.by != "node" || enabled.contains(&member.value));
    }
}

fn find_match_route(workspace: &Workspace) -> Option<&RuleRoute> {
    workspace.routes.iter().find_map(|route| match route {
        Route::Rule(rule) if rule.rule_type == "MATCH" => Some(rule),
        _ => None,
    })
}

pub fn ensure_workspace_shape(workspace: &mut Workspace) {
    workspace.version = WORKSPACE_VERSION;
    normalize_manual_sources(workspace);
    sync_chain_dialer_proxies(workspace);
    prune_unavailable_exit_members(workspace);

    for builtin in create_builtin_exits() {
        if !workspace.exits.iter().any(|exit| exit.id == builtin.id) {
            workspace.exits.push(builtin);
        }
    }

    let match_route = find_match_route(workspace).cloned().unwrap_or_else(|| {
        let fallback_exit = workspace
            .exits
            .iter()
            .find(|exit| !exit.is_builtin())
            .or_else(|| workspace.exits.first());
        RuleRoute {
            id: Uuid::new_v4().to_string(),
            rule_type: "MATCH".to_string(),
            payload: String::new(),
            exit_id: fallback_exit
                .map(|exit| exit.id.clone())
                .unwrap_or_else(|| "direct".to_string()),
            target_node_id: None,
            no_resolve: None,
            origin: "manual".to_string(),
            source_id: None,
            note: None,
            enabled: true,
            pending: None,
            applied_at: None,
        }
    });

    workspace.routes.retain(|route| !route.is_match());
    workspace.routes.push(Route::Rule(match_route));
}
