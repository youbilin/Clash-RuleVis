use std::collections::HashSet;

use serde_json::Value;
use uuid::Uuid;

use crate::model::{Exit, Route, RuleRoute, Workspace, WORKSPACE_VERSION};

pub const MANUAL_SOURCE_NAME: &str = "节点链接";
pub const MANUAL_SOURCE_NOTE: &str = "manual-link";

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
    let manual_ids: Vec<String> = workspace
        .sources
        .iter()
        .filter(|source| source.kind == "manual")
        .map(|source| source.id.clone())
        .collect();
    if manual_ids.is_empty() {
        return;
    }

    let canonical_id = workspace
        .sources
        .iter()
        .find(|source| {
            source.kind == "manual" && source.note.as_deref() == Some(MANUAL_SOURCE_NOTE)
        })
        .map(|source| source.id.clone())
        .unwrap_or_else(|| manual_ids[0].clone());
    let merged_ids: HashSet<String> = manual_ids
        .iter()
        .filter(|id| **id != canonical_id)
        .cloned()
        .collect();

    let canonical_has_note = workspace
        .sources
        .iter()
        .find(|source| source.id == canonical_id)
        .and_then(|source| source.note.as_deref())
        == Some(MANUAL_SOURCE_NOTE);
    if merged_ids.is_empty() && canonical_has_note {
        return;
    }

    if let Some(canonical) = workspace
        .sources
        .iter_mut()
        .find(|source| source.id == canonical_id)
    {
        canonical.name = MANUAL_SOURCE_NAME.to_string();
        canonical.note = Some(MANUAL_SOURCE_NOTE.to_string());
        canonical.keep_rules = false;
    }

    for node in &mut workspace.nodes {
        if merged_ids.contains(&node.source_id) {
            node.source_id = canonical_id.clone();
        }
    }
    workspace
        .sources
        .retain(|source| !merged_ids.contains(&source.id));
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
