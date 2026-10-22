use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::export::build_preview;
use crate::kernel::{Kernel, KernelError};
use crate::storage::{now_iso, NewHistory, Store};
use crate::types::KernelValidation;
use crate::validation::validate_config;
use crate::verge;
use rulevis_core::model::{ExportCounts, IssueSeverity};

const LIVE_PROFILE_NAME: &str = "Clash RuleVis 实时";
const LIVE_PROFILE_DESC: &str = "由 Clash RuleVis 创建，请勿删除";
const CONTROLLER_KEYS: &[&str] = &[
    "external-controller",
    "secret",
    "external-controller-pipe",
    "external-controller-cors",
    "external-controller-tls",
    "external-ui",
    "external-ui-name",
    "external-ui-url",
];
const MANAGED_KEYS: &[&str] = &[
    "proxies",
    "proxy-groups",
    "proxy-providers",
    "rule-providers",
    "rules",
];
const COMPANION_DEFAULTS: &[(&str, &str, &str)] = &[
    (
        "merge",
        ".yaml",
        "# Profile Enhancement Merge Template for Clash Verge\n",
    ),
    (
        "script",
        ".js",
        "// Define main function (script entry)\n\nfunction main(config, profileName) {\n  return config;\n}\n",
    ),
    (
        "rules",
        ".yaml",
        "# Profile Enhancement Rules Template for Clash Verge\n\nprepend: []\n\nappend: []\n\ndelete: []\n",
    ),
    (
        "proxies",
        ".yaml",
        "# Profile Enhancement Proxies Template for Clash Verge\n\nprepend: []\n\nappend: []\n\ndelete: []\n",
    ),
    (
        "groups",
        ".yaml",
        "# Profile Enhancement Groups Template for Clash Verge\n\nprepend: []\n\nappend: []\n\ndelete: []\n",
    ),
];

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveProfileRef {
    pub uid: String,
    pub name: String,
    pub file: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveModeState {
    #[serde(default = "safe_mode")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<LiveProfileRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<LiveProfileRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profiles_backup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_backup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_applied_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_applied_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_backup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

fn safe_mode() -> String {
    "safe".to_string()
}

impl Default for LiveModeState {
    fn default() -> Self {
        Self {
            mode: safe_mode(),
            live: None,
            original: None,
            profiles_backup: None,
            seed_backup: None,
            last_applied_at: None,
            last_applied_hash: None,
            last_backup: None,
            last_error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveModeView {
    pub mode: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_profile: Option<LiveProfileRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_profile: Option<LiveProfileRef>,
    pub current_matches: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_applied_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_backup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct LiveApplyPlan {
    pub live_profile: LiveProfileRef,
    pub live_path: PathBuf,
    pub yaml: String,
    pub old_yaml: String,
    pub old_hash: String,
    pub new_hash: String,
    pub backup_path: String,
    pub counts: ExportCounts,
    pub validation: KernelValidation,
}

struct ProfilesDoc {
    dir: PathBuf,
    path: PathBuf,
    root: Value,
}

impl ProfilesDoc {
    fn load(dir: &Path) -> Result<Self, String> {
        let path = dir.join("profiles.yaml");
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("无法读取 Verge profiles.yaml：{}", error))?;
        let root = yaml_to_json(&raw)?;
        if !root.is_object() {
            return Err("Verge profiles.yaml 格式无效".to_string());
        }
        Ok(Self {
            dir: dir.to_path_buf(),
            path,
            root,
        })
    }

    fn items(&self) -> Result<&Vec<Value>, String> {
        self.root
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| "Verge profiles.yaml 缺少 items".to_string())
    }

    fn items_mut(&mut self) -> Result<&mut Vec<Value>, String> {
        self.root
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Verge profiles.yaml 缺少 items".to_string())
    }

    fn current_uid(&self) -> Option<String> {
        self.root
            .get("current")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    fn item(&self, uid: &str) -> Option<&Value> {
        self.items()
            .ok()?
            .iter()
            .find(|item| item.get("uid").and_then(Value::as_str) == Some(uid))
    }

    fn current_item(&self) -> Option<&Value> {
        let uid = self.current_uid()?;
        self.item(&uid)
    }

    fn set_current(&mut self, uid: &str) {
        if let Some(object) = self.root.as_object_mut() {
            object.insert("current".to_string(), Value::String(uid.to_string()));
        }
    }

    fn save(&self) -> Result<(), String> {
        let yaml = json_to_yaml(&self.root)?;
        atomic_write(&self.path, yaml.as_bytes())
    }

    fn profile_path(&self, item: &Value) -> Option<PathBuf> {
        let file = item.get("file").and_then(Value::as_str)?;
        let name = Path::new(file).file_name()?.to_string_lossy().to_string();
        Some(self.dir.join("profiles").join(name))
    }
}

pub fn status(store: &Store) -> LiveModeView {
    let state = load_state(store);
    let dir = verge::verge_dir();
    let mut view = LiveModeView {
        mode: state.mode.clone(),
        available: false,
        live_profile: state.live.clone(),
        original_profile: state.original.clone(),
        current_matches: false,
        last_applied_at: state.last_applied_at.clone(),
        last_backup: state.last_backup.clone(),
        error: state.last_error.clone(),
    };
    let Some(dir) = dir else {
        view.error = Some("未检测到 Clash Verge 数据目录".to_string());
        return view;
    };
    let Ok(doc) = ProfilesDoc::load(&dir) else {
        view.error = Some("无法读取 Clash Verge profiles.yaml".to_string());
        return view;
    };
    view.available = true;
    if state.mode == "live" {
        if let Some(live) = state.live.as_ref() {
            let exists = live_ready(&doc, live);
            if let Some(item) = doc.item(&live.uid) {
                view.live_profile = profile_ref(&doc, item);
            }
            view.current_matches =
                exists && doc.current_uid().as_deref() == Some(live.uid.as_str());
            if !exists {
                view.error =
                    Some("实时 profile 文件已被删除，请先在 Verge 中切回原 profile".to_string());
            } else if !view.current_matches {
                view.error = Some("Verge 当前 profile 已被切换，实时模式已暂停".to_string());
            }
        } else {
            view.error = Some("实时模式缺少本地 profile 信息".to_string());
        }
    }
    view
}

pub fn enable(store: &Store) -> Result<LiveModeView, String> {
    let dir = verge::verge_dir().ok_or_else(|| "未检测到 Clash Verge 数据目录".to_string())?;
    let mut doc = ProfilesDoc::load(&dir)?;
    let mut state = load_state(store);
    if state.mode == "live" {
        if let Some(live) = state.live.clone() {
            if live_ready(&doc, &live) {
                let backup = backup_copy(store, &doc.path, "profiles")?;
                doc.set_current(&live.uid);
                doc.save()?;
                state.profiles_backup = Some(backup);
                state.last_error = None;
                save_state(store, &state)?;
                return Ok(status(store));
            }
        }
    }
    if let Some(live) = state.live.clone() {
        if live_ready(&doc, &live) {
            let backup = backup_copy(store, &doc.path, "profiles")?;
            doc.set_current(&live.uid);
            doc.save()?;
            state.mode = "live".to_string();
            state.profiles_backup = Some(backup);
            state.last_error = None;
            save_state(store, &state)?;
            return Ok(status(store));
        }
    }

    let original_item = doc
        .current_item()
        .cloned()
        .ok_or_else(|| "未找到 Verge 当前 profile".to_string())?;
    let original = profile_ref(&doc, &original_item)
        .ok_or_else(|| "Verge 当前 profile 缺少文件信息".to_string())?;
    let active_path = PathBuf::from(&original.path);
    let runtime_path = dir.join("config.yaml");
    let seed = seed_yaml(&active_path, &runtime_path)?;
    let profiles_backup = backup_copy(store, &doc.path, "profiles")?;

    let created = create_live_profile(&mut doc, &seed, original_item.get("selected").cloned())?;
    let seed_hash = sha256(seed.as_bytes());
    let seed_backup = backup_bytes(store, "live-seed", seed.as_bytes())?;
    state.mode = "live".to_string();
    state.live = Some(created.clone());
    state.original = Some(original);
    state.profiles_backup = Some(profiles_backup.clone());
    state.seed_backup = Some(seed_backup);
    state.last_applied_hash = Some(seed_hash);
    state.last_error = None;
    if let Err(error) = save_state(store, &state) {
        let _ = fs::copy(&profiles_backup, &doc.path);
        return Err(error);
    }
    Ok(status(store))
}

fn create_live_profile(
    doc: &mut ProfilesDoc,
    seed: &str,
    selected: Option<Value>,
) -> Result<LiveProfileRef, String> {
    let uid = format!("rv{}", &Uuid::new_v4().simple().to_string()[..8]);
    let profile_file = format!("{}.yaml", uid);
    let profile_path = doc.dir.join("profiles").join(&profile_file);
    let stamp = chrono::Utc::now().timestamp();
    let mut option = Map::new();
    let mut companions = Vec::new();
    let mut written = Vec::new();
    for (kind, ext, content) in COMPANION_DEFAULTS {
        let companion_uid = Uuid::new_v4().simple().to_string()[..12].to_string();
        let file = format!("{}{}", companion_uid, ext);
        let path = doc.dir.join("profiles").join(&file);
        atomic_write(&path, content.as_bytes())?;
        written.push(path);
        companions.push(json!({
            "uid": companion_uid,
            "type": kind,
            "name": Value::Null,
            "file": file,
            "updated": stamp
        }));
        option.insert((*kind).to_string(), Value::String(companion_uid));
    }
    let mut item = json!({
        "uid": uid.clone(),
        "type": "local",
        "name": LIVE_PROFILE_NAME,
        "file": profile_file,
        "desc": LIVE_PROFILE_DESC,
        "updated": stamp,
        "option": Value::Object(option)
    });
    if let Some(selected) = selected {
        if let Some(object) = item.as_object_mut() {
            object.insert("selected".to_string(), selected);
        }
    }
    atomic_write(&profile_path, seed.as_bytes())?;
    written.push(profile_path.clone());
    let items = doc.items_mut()?;
    items.extend(companions);
    items.push(item.clone());
    doc.set_current(&uid);
    if let Err(error) = doc.save() {
        for path in &written {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    profile_ref(doc, &item).ok_or_else(|| "无法创建实时 profile".to_string())
}

pub fn prepare_apply(store: &Store) -> Result<LiveApplyPlan, String> {
    let state = load_state(store);
    if state.mode != "live" {
        return Err("当前是安全模式".to_string());
    }
    let live = state
        .live
        .clone()
        .ok_or_else(|| "实时模式缺少本地 profile 信息".to_string())?;
    let dir = verge::verge_dir().ok_or_else(|| "未检测到 Clash Verge 数据目录".to_string())?;
    let doc = ProfilesDoc::load(&dir)?;
    if doc.current_uid().as_deref() != Some(live.uid.as_str()) {
        return Err("Verge 当前 profile 已被切换，请重新开启实时模式".to_string());
    }
    let live_path = PathBuf::from(&live.path);
    if !live_path.is_file() {
        return Err("实时 profile 文件不存在".to_string());
    }
    let old_yaml = fs::read_to_string(&live_path)
        .map_err(|error| format!("无法读取实时 profile：{}", error))?;
    let old_hash = sha256(old_yaml.as_bytes());
    if let Some(expected) = state.last_applied_hash.as_deref() {
        if expected != old_hash {
            return Err("实时 profile 已被外部修改，已阻止覆盖".to_string());
        }
    }
    let preview = build_preview(store)?;
    if preview
        .issues
        .iter()
        .any(|issue| issue.severity == IssueSeverity::Error)
    {
        return Err("配置校验未通过，请先修复错误".to_string());
    }
    let merged = merge_live_yaml(&old_yaml, &preview.yaml)?;
    let validation = validate_config(&store.data_dir, &merged);
    if validation.available && !validation.ok {
        return Err("mihomo 内核校验未通过，已取消应用".to_string());
    }
    let backup_path = backup_bytes(store, "live-before-apply", old_yaml.as_bytes())?;
    atomic_write(&live_path, merged.as_bytes())?;
    let new_hash = sha256(merged.as_bytes());
    Ok(LiveApplyPlan {
        live_profile: live,
        live_path,
        yaml: merged,
        old_yaml,
        old_hash,
        new_hash,
        backup_path,
        counts: preview.counts,
        validation,
    })
}

pub fn finish_apply(store: &mut Store, plan: &LiveApplyPlan) -> Result<Value, String> {
    let at = now_iso();
    let counts = plan.counts.clone();
    let (_, workspace) = store
        .mutate(|workspace| {
            for route in &mut workspace.routes {
                match route {
                    rulevis_core::model::Route::Rule(rule) => {
                        rule.pending = None;
                        rule.applied_at = Some(at.clone());
                    }
                    rulevis_core::model::Route::Ruleset(rule) => {
                        rule.pending = None;
                        rule.applied_at = Some(at.clone());
                    }
                }
            }
            Ok(())
        })
        .map_err(|error| format!("无法保存工作区：{:?}", error))?;
    let entry = store
        .add_history(
            NewHistory {
                label: "应用到 Clash Verge".to_string(),
                kind: "manual".to_string(),
                export_path: Some(plan.live_path.to_string_lossy().to_string()),
                file_name: plan
                    .live_path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string()),
                counts: Some(counts.clone()),
                note: Some("实时模式：写入 Clash RuleVis 本地 profile".to_string()),
                at: None,
            },
            &workspace,
        )
        .map_err(|error| format!("无法记录实时应用历史：{}", error))?;
    let mut state = load_state(store);
    state.last_applied_at = Some(at.clone());
    state.last_applied_hash = Some(plan.new_hash.clone());
    state.last_backup = Some(plan.backup_path.clone());
    state.last_error = None;
    save_state(store, &state)?;
    Ok(json!({
        "profile": plan.live_profile,
        "backupPath": plan.backup_path,
        "counts": counts,
        "validation": plan.validation.clone(),
        "appliedAt": at,
        "workspace": workspace,
        "historyId": entry.id
    }))
}

pub fn rollback_apply(store: &Store, plan: &LiveApplyPlan, error: &str) -> Result<(), String> {
    atomic_write(&plan.live_path, plan.old_yaml.as_bytes())?;
    let mut state = load_state(store);
    state.last_applied_hash = Some(plan.old_hash.clone());
    state.last_error = Some(error.to_string());
    save_state(store, &state)
}

pub fn prepare_disable(store: &Store) -> Result<(String, LiveProfileRef), String> {
    let state = load_state(store);
    if state.mode != "live" {
        return Err("当前不是实时模式".to_string());
    }
    let original = state
        .original
        .clone()
        .ok_or_else(|| "缺少原始 profile 信息".to_string())?;
    let dir = verge::verge_dir().ok_or_else(|| "未检测到 Clash Verge 数据目录".to_string())?;
    let mut doc = ProfilesDoc::load(&dir)?;
    if doc.item(&original.uid).is_none() {
        return Err("原始 Verge profile 已不存在".to_string());
    }
    let seed = state
        .seed_backup
        .as_deref()
        .and_then(|path| fs::read_to_string(path).ok())
        .ok_or_else(|| "实时模式缺少恢复备份".to_string())?;
    backup_copy(store, &doc.path, "profiles-before-restore")?;
    doc.set_current(&original.uid);
    doc.save()?;
    Ok((seed, original))
}

pub fn finish_disable(store: &Store) -> Result<LiveModeView, String> {
    let mut state = load_state(store);
    state.mode = "safe".to_string();
    state.last_error = None;
    save_state(store, &state)?;
    Ok(status(store))
}

pub fn fail_disable(store: &Store, error: &str) {
    let mut state = load_state(store);
    state.last_error = Some(error.to_string());
    let _ = save_state(store, &state);
}

pub fn reload(kernel: &mut Kernel, yaml: &str) -> Result<(), KernelError> {
    kernel.reload_config(yaml)
}

fn load_state(store: &Store) -> LiveModeState {
    let path = state_path(store);
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<LiveModeState>(&raw).ok())
        .unwrap_or_default()
}

fn save_state(store: &Store, state: &LiveModeState) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    atomic_write(&state_path(store), &json)
}

fn state_path(store: &Store) -> PathBuf {
    store.data_dir.join("verge-live.json")
}

fn profile_ref(doc: &ProfilesDoc, item: &Value) -> Option<LiveProfileRef> {
    let uid = item.get("uid").and_then(Value::as_str)?.to_string();
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Clash Verge profile")
        .to_string();
    let file = item.get("file").and_then(Value::as_str)?.to_string();
    let path = doc.profile_path(item)?;
    Some(LiveProfileRef {
        uid,
        name,
        file,
        path: path.to_string_lossy().to_string(),
    })
}

fn live_ready(doc: &ProfilesDoc, live: &LiveProfileRef) -> bool {
    doc.item(&live.uid)
        .and_then(|item| doc.profile_path(item))
        .is_some_and(|path| path.is_file())
}

fn seed_yaml(active_path: &Path, runtime_path: &Path) -> Result<String, String> {
    let active = fs::read_to_string(active_path)
        .map_err(|error| format!("无法读取 Verge 当前 profile：{}", error))?;
    let mut document = yaml_to_json(&active)?;
    if !document.is_object() {
        return Err("Verge 当前 profile 不是 YAML 对象".to_string());
    }
    if let Ok(runtime) = fs::read_to_string(runtime_path) {
        if let Ok(runtime) = yaml_to_json(&runtime) {
            if let (Some(document), Some(runtime)) = (document.as_object_mut(), runtime.as_object())
            {
                for (key, value) in runtime {
                    document.insert(key.clone(), value.clone());
                }
            }
        }
    }
    json_to_yaml(&document)
}

fn merge_live_yaml(current: &str, generated: &str) -> Result<String, String> {
    let mut live = yaml_to_json(current)?;
    let generated = yaml_to_json(generated)?;
    let (Some(live), Some(generated)) = (live.as_object_mut(), generated.as_object()) else {
        return Err("实时配置不是 YAML 对象".to_string());
    };
    for key in MANAGED_KEYS {
        live.remove(*key);
    }
    for (key, value) in generated {
        if CONTROLLER_KEYS.contains(&key.as_str()) {
            continue;
        }
        live.insert(key.clone(), value.clone());
    }
    json_to_yaml(&Value::Object(live.clone()))
}

fn yaml_to_json(raw: &str) -> Result<Value, String> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(raw).map_err(|error| format!("YAML 解析失败：{}", error))?;
    serde_json::to_value(yaml).map_err(|error| format!("YAML 转换失败：{}", error))
}

fn json_to_yaml(value: &Value) -> Result<String, String> {
    let yaml: serde_yaml::Value = serde_json::from_value(value.clone())
        .map_err(|error| format!("YAML 转换失败：{}", error))?;
    serde_yaml::to_string(&yaml).map_err(|error| format!("YAML 序列化失败：{}", error))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{}", error))?;
    }
    let temp = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("yaml")
    ));
    fs::write(&temp, bytes).map_err(|error| format!("无法写入临时文件：{}", error))?;
    fs::rename(&temp, path).map_err(|error| format!("无法替换文件：{}", error))
}

fn backup_copy(store: &Store, source: &Path, label: &str) -> Result<String, String> {
    let bytes = fs::read(source).map_err(|error| format!("无法读取备份源：{}", error))?;
    backup_bytes(store, label, &bytes)
}

fn backup_bytes(store: &Store, label: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = store.data_dir.join("verge-backups");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建备份目录：{}", error))?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f");
    let suffix = &Uuid::new_v4().simple().to_string()[..6];
    let path = dir.join(format!("{}-{}-{}.yaml", label, stamp, suffix));
    fs::write(&path, bytes).map_err(|error| format!("无法写入备份：{}", error))?;
    prune_backups(&dir);
    Ok(path.to_string_lossy().to_string())
}

fn prune_backups(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("yaml"))
        .filter(|path| {
            !path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("live-seed-"))
        })
        .collect();
    files.sort();
    if files.len() > 20 {
        let remove = files.len().saturating_sub(20);
        for path in files.into_iter().take(remove) {
            let _ = fs::remove_file(path);
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rulevis-live-{}-{}",
            label,
            &Uuid::new_v4().simple().to_string()[..8]
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn merge_replaces_managed_sections_and_keeps_controller() {
        let current = r#"
mixed-port: 7897
external-controller: 127.0.0.1:9090
external-controller-pipe: \\.\pipe\verge
secret: keep-me
dns:
  enable: true
custom-key: keep
proxies:
  - name: old-node
    type: socks5
    server: 127.0.0.1
    port: 1080
rules:
  - MATCH,DIRECT
"#;
        let generated = r#"
mixed-port: 7897
external-controller: 0.0.0.0:9999
proxies:
  - name: new-node
    type: socks5
    server: 127.0.0.1
    port: 1081
proxy-groups:
  - name: PROXY
    type: select
    proxies: [new-node]
rules:
  - DOMAIN-SUFFIX,example.com,PROXY
  - MATCH,PROXY
"#;
        let merged =
            yaml_to_json(&merge_live_yaml(current, generated).expect("merge")).expect("yaml");
        let merged = merged.as_object().expect("object");
        assert_eq!(merged["external-controller"], "127.0.0.1:9090");
        assert_eq!(merged["external-controller-pipe"], "\\\\.\\pipe\\verge");
        assert_eq!(merged["secret"], "keep-me");
        assert_eq!(merged["custom-key"], "keep");
        assert_eq!(merged["dns"]["enable"], true);
        assert_eq!(merged["proxies"][0]["name"], "new-node");
        assert_eq!(merged["rules"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn yaml_with_bom_is_accepted() {
        let value = yaml_to_json("\u{feff}mixed-port: 7897\n").expect("parse bom yaml");
        assert_eq!(value["mixed-port"], 7897);
    }

    #[test]
    fn seed_overlays_runtime_controller_and_keeps_profile_routes() {
        let dir = temp_dir("seed");
        let active = dir.join("active.yaml");
        let runtime = dir.join("config.yaml");
        fs::write(
            &active,
            "mixed-port: 1111\nproxy-providers:\n  remote:\n    type: http\n    url: https://example.com/sub\nrules:\n  - MATCH,DIRECT\n",
        )
        .unwrap();
        fs::write(
            &runtime,
            "mixed-port: 7897\nexternal-controller: 127.0.0.1:9090\nsecret: token\n",
        )
        .unwrap();
        let seed = seed_yaml(&active, &runtime).expect("seed");
        let value = yaml_to_json(&seed).expect("yaml");
        let value = value.as_object().unwrap();
        assert_eq!(value["mixed-port"], 7897);
        assert_eq!(value["external-controller"], "127.0.0.1:9090");
        assert_eq!(value["secret"], "token");
        assert!(value["proxy-providers"].is_object());
        assert_eq!(value["rules"].as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn create_profile_attaches_companions_and_switches_current() {
        let dir = temp_dir("profile");
        fs::write(
            dir.join("profiles.yaml"),
            "current: remote1\nitems:\n  - uid: remote1\n    type: remote\n    name: Lina\n    file: remote1.yaml\n",
        )
        .unwrap();
        let seed = "mixed-port: 7897\nrules:\n  - MATCH,DIRECT\n";
        let mut doc = ProfilesDoc::load(&dir).expect("load profiles");
        let selected = json!([{ "name": "PROXY", "now": "subscription-node" }]);
        let live =
            create_live_profile(&mut doc, seed, Some(selected.clone())).expect("create profile");

        let saved = ProfilesDoc::load(&dir).expect("reload profiles");
        assert_eq!(saved.current_uid().as_deref(), Some(live.uid.as_str()));
        let item = saved.item(&live.uid).expect("live item");
        assert_eq!(item["type"], "local");
        assert_eq!(item["name"], LIVE_PROFILE_NAME);
        assert_eq!(item["selected"], selected);
        let option = item["option"].as_object().expect("option");
        assert_eq!(option.len(), COMPANION_DEFAULTS.len());
        for (kind, _, _) in COMPANION_DEFAULTS {
            let uid = option[*kind].as_str().expect("companion uid");
            let companion = saved.item(uid).expect("companion item");
            let file = companion["file"].as_str().expect("companion file");
            assert!(dir.join("profiles").join(file).is_file());
        }
        assert_eq!(fs::read_to_string(&live.path).expect("live file"), seed);
        let _ = fs::remove_dir_all(dir);
    }
}
