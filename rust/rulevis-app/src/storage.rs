use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{SecondsFormat, Utc};
use rulevis_core::defaults::{create_default_workspace, ensure_workspace_shape};
use rulevis_core::model::{ExportCounts, Workspace};
use uuid::Uuid;

use crate::types::{HistoryEntry, HistoryFile};

const HISTORY_LIMIT: usize = 40;

#[derive(Debug)]
pub enum StoreError {
    Conflict(Box<Workspace>),
    Message(String),
}

impl StoreError {
    pub fn message(error: impl Into<String>) -> Self {
        Self::Message(error.into())
    }
}

pub struct NewHistory {
    pub label: String,
    pub kind: String,
    pub note: Option<String>,
    pub export_path: Option<String>,
    pub file_name: Option<String>,
    pub counts: Option<ExportCounts>,
    pub at: Option<String>,
}

pub struct Store {
    pub(crate) workspace: Workspace,
    pub(crate) data_dir: PathBuf,
    pub(crate) exports_dir: PathBuf,
    pub(crate) history_dir: PathBuf,
    workspace_path: PathBuf,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn now_millis() -> u64 {
    Utc::now().timestamp_millis().max(0) as u64
}

pub fn stamp_local() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

pub(crate) fn write_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
    atomic_write(path, content)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("路径无效".to_string());
    };
    fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{}", error))?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "write".to_string()),
        Uuid::new_v4()
    ));
    fs::write(&tmp, content).map_err(|error| format!("无法写入临时文件：{}", error))?;
    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("无法保存文件：{}", error)
    })
}

impl Store {
    pub fn load(data_dir: PathBuf) -> Result<Self, String> {
        let exports_dir = data_dir.join("exports");
        let history_dir = data_dir.join("history");
        for dir in [
            &data_dir,
            &exports_dir,
            &history_dir,
            &data_dir.join("rule-sets"),
        ] {
            fs::create_dir_all(dir).map_err(|error| format!("无法创建数据目录：{}", error))?;
        }
        let workspace_path = data_dir.join("workspace.json");

        let mut created = false;
        let mut workspace = match fs::read_to_string(&workspace_path) {
            Ok(raw) => match serde_json::from_str::<Workspace>(&raw) {
                Ok(workspace) => workspace,
                Err(error) => {
                    let stamp = now_iso().replace([':', '.'], "-");
                    let corrupt = data_dir.join(format!("workspace.corrupt-{}.json", stamp));
                    let _ = fs::rename(&workspace_path, corrupt);
                    eprintln!("[desktop] 工作区解析失败，已备份并重建：{}", error);
                    created = true;
                    create_default_workspace(now_iso())
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                created = true;
                create_default_workspace(now_iso())
            }
            Err(error) => return Err(format!("无法读取工作区：{}", error)),
        };
        ensure_workspace_shape(&mut workspace);
        if workspace.created_at.is_empty() {
            workspace.created_at = now_iso();
        }

        let store = Self {
            workspace,
            data_dir,
            exports_dir,
            history_dir,
            workspace_path,
        };
        if created {
            store.persist()?;
        }
        Ok(store)
    }

    pub fn persist(&self) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(&self.workspace)
            .map_err(|error| format!("工作区序列化失败：{}", error))?;
        atomic_write(&self.workspace_path, &json)
    }

    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }

    pub fn mutate<T>(
        &mut self,
        mutate: impl FnOnce(&mut Workspace) -> Result<T, StoreError>,
    ) -> Result<(T, Workspace), StoreError> {
        let mut draft = self.workspace.clone();
        let value = mutate(&mut draft)?;
        ensure_workspace_shape(&mut draft);
        draft.revision = self.workspace.revision + 1;
        draft.updated_at = now_iso();
        let json = serde_json::to_vec_pretty(&draft)
            .map_err(|error| StoreError::message(format!("工作区序列化失败：{}", error)))?;
        atomic_write(&self.workspace_path, &json).map_err(StoreError::message)?;
        self.workspace = draft;
        Ok((value, self.workspace.clone()))
    }

    pub fn replace_workspace(
        &mut self,
        next: Workspace,
        base_revision: Option<u64>,
    ) -> Result<Workspace, StoreError> {
        if let Some(base_revision) = base_revision {
            if base_revision != self.workspace.revision {
                return Err(StoreError::Conflict(Box::new(self.workspace.clone())));
            }
        }
        let (_, workspace) = self.mutate(|draft| {
            draft.sources = next.sources;
            draft.nodes = next.nodes;
            draft.exits = next.exits;
            draft.routes = next.routes;
            draft.settings = next.settings;
            draft.last_export = next.last_export;
            if !next.created_at.is_empty() {
                draft.created_at = next.created_at;
            }
            Ok(())
        })?;
        Ok(workspace)
    }

    pub fn add_history(
        &mut self,
        input: NewHistory,
        workspace: &Workspace,
    ) -> Result<HistoryEntry, String> {
        let at = input.at.unwrap_or_else(now_iso);
        let id = format!(
            "{}-{}",
            Utc::now().timestamp_millis(),
            &Uuid::new_v4().simple().to_string()[..6]
        );
        let entry = HistoryEntry {
            id: id.clone(),
            at,
            label: input.label,
            kind: input.kind,
            export_path: input.export_path,
            file_name: input.file_name,
            counts: input.counts,
            note: input.note,
        };
        let payload = HistoryFile {
            entry: entry.clone(),
            workspace: workspace.clone(),
        };
        let json = serde_json::to_vec_pretty(&payload)
            .map_err(|error| format!("历史快照序列化失败：{}", error))?;
        atomic_write(&self.history_dir.join(format!("{}.json", id)), &json)?;
        self.prune_history()?;
        Ok(entry)
    }

    fn prune_history(&self) -> Result<(), String> {
        let mut entries = self.list_history();
        if entries.len() <= HISTORY_LIMIT {
            return Ok(());
        }
        entries.sort_by(|left, right| right.at.cmp(&left.at));
        for entry in entries.into_iter().skip(HISTORY_LIMIT) {
            let _ = fs::remove_file(self.history_dir.join(format!("{}.json", entry.id)));
        }
        Ok(())
    }

    pub fn list_history(&self) -> Vec<HistoryEntry> {
        let mut entries = Vec::new();
        let Ok(files) = fs::read_dir(&self.history_dir) else {
            return entries;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(data) = serde_json::from_str::<HistoryFile>(&raw) {
                entries.push(data.entry);
            }
        }
        entries.sort_by(|left, right| right.at.cmp(&left.at).then_with(|| right.id.cmp(&left.id)));
        let mut seen = HashSet::new();
        entries.retain(|entry| seen.insert(entry.id.clone()));
        entries
    }

    pub fn clear_history(&self) -> Result<usize, String> {
        let count = self.list_history().len();
        let files = fs::read_dir(&self.history_dir)
            .map_err(|error| format!("无法读取历史目录：{}", error))?;
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                fs::remove_file(&path).map_err(|error| format!("无法删除历史快照：{}", error))?;
            }
        }
        Ok(count)
    }

    fn export_files(&self) -> Vec<PathBuf> {
        let Ok(files) = fs::read_dir(&self.exports_dir) else {
            return Vec::new();
        };
        files
            .flatten()
            .filter(|entry| {
                entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
            })
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml")
                    })
            })
            .collect()
    }

    pub fn export_stats(&self) -> (usize, u64) {
        let files = self.export_files();
        let bytes = files
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum();
        (files.len(), bytes)
    }

    pub fn cleanup_exports(&self, keep_days: u64) -> Result<(usize, u64, usize, u64), String> {
        let mut protected: HashSet<PathBuf> = self
            .list_history()
            .into_iter()
            .filter_map(|entry| entry.export_path.map(PathBuf::from))
            .collect();
        if let Some(record) = self.workspace.last_export.as_ref() {
            protected.insert(PathBuf::from(&record.path));
        }
        let mut removed = 0;
        let mut freed = 0;
        for path in self.export_files() {
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            let expired = keep_days == 0
                || metadata
                    .modified()
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .map(|age| age >= Duration::from_secs(keep_days.saturating_mul(86_400)))
                    .unwrap_or(false);
            if !expired || protected.contains(&path) {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                removed += 1;
                freed += metadata.len();
            }
        }
        let (remaining, bytes) = self.export_stats();
        Ok((removed, freed, remaining, bytes))
    }

    pub fn read_history(&self, id: &str) -> Option<HistoryFile> {
        if !is_valid_history_id(id) {
            return None;
        }
        let raw = fs::read_to_string(self.history_dir.join(format!("{}.json", id))).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn snapshot(&mut self, label: String, note: String) -> Result<HistoryEntry, String> {
        let workspace = self.workspace.clone();
        self.add_history(
            NewHistory {
                label,
                kind: "manual".to_string(),
                note: Some(note),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        )
    }

    pub fn restore_history(
        &mut self,
        id: &str,
    ) -> Result<Option<(Workspace, HistoryEntry)>, String> {
        let Some(data) = self.read_history(id) else {
            return Ok(None);
        };
        let undo = self.snapshot(
            format!("恢复前快照 · {}", data.entry.label),
            "恢复工作区前自动创建".to_string(),
        )?;
        let mut restored = data.workspace;
        ensure_workspace_shape(&mut restored);
        let (_, workspace) = self
            .mutate(|draft| {
                draft.sources = restored.sources;
                draft.nodes = restored.nodes;
                draft.exits = restored.exits;
                draft.routes = restored.routes;
                draft.settings = restored.settings;
                draft.last_export = restored.last_export;
                Ok(())
            })
            .map_err(|error| match error {
                StoreError::Message(message) => message,
                StoreError::Conflict(_) => "工作区在恢复过程中发生变化，请重试".to_string(),
            })?;
        self.add_history(
            NewHistory {
                label: format!("恢复自 {}", data.entry.label),
                kind: "restore".to_string(),
                note: Some(now_iso()),
                export_path: None,
                file_name: None,
                counts: None,
                at: None,
            },
            &workspace,
        )?;
        Ok(Some((workspace, undo)))
    }

    pub fn read_export(&self, entry: &HistoryEntry) -> Option<String> {
        self.read_export_path(entry.export_path.as_deref()?)
    }

    pub fn read_export_path(&self, path: &str) -> Option<String> {
        let path = PathBuf::from(path);
        let canonical_parent = self.exports_dir.canonicalize().ok()?;
        let canonical = path.canonicalize().ok()?;
        if !canonical.starts_with(canonical_parent) {
            return None;
        }
        fs::read_to_string(canonical).ok()
    }
}

fn is_valid_history_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}
