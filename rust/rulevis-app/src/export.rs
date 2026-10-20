use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rulevis_core::generator::{generate_config, GenerateOptions};
use rulevis_core::model::{ConfigIssue, ExportRecord, IssueSeverity, Route, Workspace};
use similar::TextDiff;

use crate::storage::{now_iso, stamp_local, Store};
use crate::types::{BaseTemplateInfo, ExportPreview, ExportResult, KernelValidation};
use crate::verge;

pub enum ExportError {
    Validation(Box<ExportPreview>),
    Message(String),
}

fn empty_base_info() -> BaseTemplateInfo {
    BaseTemplateInfo {
        included: false,
        source: None,
        keys: Vec::new(),
        warning: None,
    }
}

fn file_name_for(stamp: &str) -> String {
    format!("clash-routedesk-{}.yaml", stamp)
}

fn unique_export_path(store: &Store) -> (String, PathBuf) {
    let base = format!("clash-routedesk-{}", stamp_local());
    let mut name = format!("{}.yaml", base);
    let mut path = store.exports_dir.join(&name);
    let mut index = 2;
    while path.exists() {
        name = format!("{}-{}.yaml", base, index);
        path = store.exports_dir.join(&name);
        index += 1;
    }
    (name, path)
}

fn previous_diff(
    store: &Store,
    workspace: &Workspace,
    next_yaml: &str,
) -> (Option<String>, Option<String>) {
    let Some(record) = workspace.last_export.as_ref() else {
        return (None, None);
    };
    if record.path.is_empty() {
        return (None, None);
    }
    let path = Path::new(&record.path);
    let canonical_parent = match store.exports_dir.canonicalize() {
        Ok(parent) => parent,
        Err(_) => return (None, None),
    };
    let canonical = match path.canonicalize() {
        Ok(path) if path.starts_with(canonical_parent) => path,
        _ => return (None, None),
    };
    let previous = match fs::read_to_string(&canonical) {
        Ok(previous) => previous,
        Err(_) => return (None, None),
    };
    let old_name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "previous-export.yaml".to_string());
    let diff = TextDiff::from_lines(previous.as_str(), next_yaml)
        .unified_diff()
        .context_radius(4)
        .header(&old_name, "next-export.yaml")
        .to_string();
    (Some(diff), Some(record.at.clone()))
}

pub fn build_preview(store: &Store) -> Result<ExportPreview, String> {
    let workspace = store.workspace();
    let include_base = workspace.settings.include_base_template;
    let base = if include_base {
        Some(verge::read_base_template())
    } else {
        None
    };
    let options = GenerateOptions {
        base_settings: base
            .as_ref()
            .filter(|base| base.info.included)
            .map(|base| base.values.clone()),
    };
    let generated = generate_config(workspace, &options);
    let mut issues = generated.issues;
    if include_base {
        if let Some(base) = &base {
            if !base.info.included {
                issues.push(ConfigIssue {
                    severity: IssueSeverity::Warning,
                    code: "base-template-missing".to_string(),
                    message: base.info.warning.clone().unwrap_or_else(|| {
                        "未能读取 Verge 的基础设置，导出将不包含端口 / DNS / TUN".to_string()
                    }),
                    route_id: None,
                    exit_id: None,
                });
            }
        }
    }
    let stamp = stamp_local();
    let (diff, previous_export_at) = previous_diff(store, workspace, &generated.yaml);
    Ok(ExportPreview {
        yaml: generated.yaml,
        issues,
        counts: generated.counts,
        generated_at: now_iso(),
        file_name: file_name_for(&stamp),
        diff,
        previous_export_at,
        base_settings: base.map(|base| base.info).unwrap_or_else(empty_base_info),
    })
}

fn apply_export_state(
    workspace: &mut Workspace,
    path: &Path,
    yaml: &str,
    counts: &rulevis_core::model::ExportCounts,
) -> ExportRecord {
    let at = now_iso();
    for route in &mut workspace.routes {
        match route {
            Route::Rule(rule) => {
                rule.pending = None;
                rule.applied_at = Some(at.clone());
            }
            Route::Ruleset(rule) => {
                rule.pending = None;
                rule.applied_at = Some(at.clone());
            }
        }
    }
    let record = ExportRecord {
        id: format!("{}", Utc::now().timestamp_millis()),
        at,
        path: path.to_string_lossy().to_string(),
        revision: workspace.revision + 1,
        bytes: yaml.len() as u64,
        rule_count: counts.rules,
        node_count: counts.nodes,
        exit_count: counts.exits,
        provider_count: counts.providers,
    };
    workspace.last_export = Some(record.clone());
    record
}

pub fn export_config(store: &mut Store) -> Result<ExportResult, ExportError> {
    let mut preview = build_preview(store).map_err(ExportError::Message)?;
    if preview
        .issues
        .iter()
        .any(|issue| issue.severity == IssueSeverity::Error)
    {
        return Err(ExportError::Validation(Box::new(preview)));
    }
    let validation = KernelValidation::unavailable("桌面版内核适配尚未接入，已跳过内核校验");
    preview.issues.push(ConfigIssue {
        severity: IssueSeverity::Warning,
        code: "kernel-validation-unavailable".to_string(),
        message: validation
            .error
            .clone()
            .unwrap_or_else(|| "无法运行内核校验，已跳过".to_string()),
        route_id: None,
        exit_id: None,
    });

    let (file_name, path) = unique_export_path(store);
    let yaml = preview.yaml.clone();
    fs::create_dir_all(&store.exports_dir)
        .map_err(|error| ExportError::Message(format!("无法创建导出目录：{}", error)))?;
    fs::write(&path, yaml.as_bytes())
        .map_err(|error| ExportError::Message(format!("无法写入导出文件：{}", error)))?;

    let counts = preview.counts.clone();
    let (record, workspace) = store
        .mutate(|draft| Ok(apply_export_state(draft, &path, &yaml, &counts)))
        .map_err(|error| match error {
            crate::storage::StoreError::Message(message) => ExportError::Message(message),
            crate::storage::StoreError::Conflict(_) => {
                ExportError::Message("工作区在导出过程中发生变化，请重试".to_string())
            }
        })?;

    let entry = store
        .add_history(
            crate::storage::NewHistory {
                label: "导出配置".to_string(),
                kind: "export".to_string(),
                export_path: Some(record.path.clone()),
                file_name: Some(file_name.clone()),
                counts: Some(counts),
                note: Some("安全模式：仅写入工具目录，未修改 Clash Verge".to_string()),
                at: None,
            },
            &workspace,
        )
        .map_err(ExportError::Message)?;

    preview.file_name = file_name;
    Ok(ExportResult {
        preview,
        path: record.path,
        history_id: entry.id,
        workspace,
        validation,
    })
}
