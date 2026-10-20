use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use wait_timeout::ChildExt;

use crate::types::KernelValidation;
use crate::verge;

const GEO_FILES: &[&str] = &["geoip.dat", "geosite.dat", "Country.mmdb", "ASN.mmdb"];

static BINARY_CACHE: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);

fn existing_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.is_file())
}

fn process_paths() -> Vec<PathBuf> {
    if !cfg!(target_os = "windows") {
        return Vec::new();
    }
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-Process clash-verge,verge-mihomo -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path)",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags_hidden()
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

trait HiddenCommand {
    fn creation_flags_hidden(&mut self) -> &mut Self;
}

impl HiddenCommand for Command {
    fn creation_flags_hidden(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x08000000);
        }
        self
    }
}

fn which_binary(name: &str) -> Option<PathBuf> {
    let command = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let output = Command::new(command)
        .arg(name)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let path = PathBuf::from(line);
    path.is_file().then_some(path)
}

pub fn find_mihomo_binary() -> Option<PathBuf> {
    if let Ok(cache) = BINARY_CACHE.lock() {
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return value.clone();
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = std::env::var_os("CRS_MIHOMO_BIN") {
        candidates.push(PathBuf::from(explicit));
    }
    if cfg!(target_os = "windows") {
        for process in process_paths() {
            let file_name = process
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if file_name.to_lowercase().starts_with("verge-mihomo")
                && file_name.to_lowercase().ends_with(".exe")
            {
                candidates.push(process.clone());
            }
            if let Some(dir) = process.parent() {
                candidates.push(dir.join("verge-mihomo.exe"));
                candidates.push(dir.join("verge-mihomo-alpha.exe"));
                candidates.push(dir.join("mihomo.exe"));
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let root = PathBuf::from(local).join("Programs");
            candidates.push(root.join("clash-verge").join("verge-mihomo.exe"));
            candidates.push(root.join("Clash Verge").join("verge-mihomo.exe"));
        }
        for name in ["verge-mihomo.exe", "verge-mihomo-alpha.exe", "mihomo.exe"] {
            if let Some(path) = which_binary(name) {
                candidates.push(path);
            }
        }
    } else {
        candidates.push(PathBuf::from("mihomo"));
        candidates.push(PathBuf::from("clash-meta"));
    }
    let found = existing_file(candidates);
    if let Ok(mut cache) = BINARY_CACHE.lock() {
        *cache = Some((Instant::now(), found.clone()));
    }
    found
}

fn ensure_geo_files(data_dir: &Path) -> PathBuf {
    let validation_dir = data_dir.join("validation");
    let _ = fs::create_dir_all(&validation_dir);
    if let Some(verge_dir) = verge::verge_dir() {
        for name in GEO_FILES {
            let target = validation_dir.join(name);
            if target.is_file() {
                continue;
            }
            let _ = fs::copy(verge_dir.join(name), target);
        }
    }
    validation_dir
}

fn sanitize_output(raw: &str) -> String {
    let cleaned: Vec<String> = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            if let Some(index) = line.find("msg=") {
                if line[..index].contains("level=") {
                    return line[index + 4..].trim_matches('"').to_string();
                }
            }
            line.to_string()
        })
        .filter(|line| {
            !line.starts_with("Start initial configuration")
                && !line.starts_with("Geodata Loader")
                && !line.starts_with("Geosite Matcher")
                && !line.starts_with("Initial configuration complete")
        })
        .collect();
    let relevant: Vec<&String> = cleaned
        .iter()
        .filter(|line| !line.to_lowercase().contains("test is successful"))
        .collect();
    let summary = cleaned
        .iter()
        .find(|line| line.to_lowercase().contains("test is "))
        .cloned()
        .unwrap_or_default();
    let start = relevant.len().saturating_sub(16);
    let mut text: Vec<String> = relevant[start..]
        .iter()
        .map(|line| (*line).clone())
        .collect();
    if !summary.is_empty() {
        text.push(summary);
    }
    let text = text.join("\n");
    if text.trim().is_empty() {
        "mihomo 未返回可读输出".to_string()
    } else {
        text.chars().take(4000).collect()
    }
}

pub fn validate_config(data_dir: &Path, yaml: &str) -> KernelValidation {
    let Some(binary) = find_mihomo_binary() else {
        return KernelValidation::unavailable(
            "未找到 mihomo 可执行文件。启动 Clash Verge，或设置 CRS_MIHOMO_BIN 指向 verge-mihomo.exe。",
        );
    };
    let validation_dir = ensure_geo_files(data_dir);
    let file = validation_dir.join(format!(
        "validate-{}-{}.yaml",
        chrono::Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().simple().to_string()[..6]
    ));
    if let Err(error) = fs::write(&file, yaml) {
        return KernelValidation {
            available: true,
            ok: false,
            binary: binary
                .file_name()
                .map(|name| name.to_string_lossy().to_string()),
            duration_ms: Some(0),
            output: None,
            error: Some(format!("无法写入校验文件：{}", error)),
        };
    }
    let started = Instant::now();
    let mut command = Command::new(&binary);
    command
        .args(["-t", "-d"])
        .arg(&validation_dir)
        .arg("-f")
        .arg(&file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .creation_flags_hidden();
    let result = match command.spawn() {
        Ok(mut child) => match child.wait_timeout(Duration::from_secs(15)) {
            Ok(Some(_)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut reader) = child.stdout.take() {
                    let _ = reader.read_to_string(&mut stdout);
                }
                if let Some(mut reader) = child.stderr.take() {
                    let _ = reader.read_to_string(&mut stderr);
                }
                let sanitized = sanitize_output(&format!("{}\n{}", stdout, stderr));
                let failed = sanitized.to_lowercase().contains("test failed");
                Ok((!failed, sanitized, None))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                Ok((false, "校验超时".to_string(), Some("校验超时".to_string())))
            }
            Err(error) => {
                let _ = child.kill();
                Ok((false, String::new(), Some(error.to_string())))
            }
        },
        Err(error) => Ok((false, String::new(), Some(error.to_string()))),
    };
    let _ = fs::remove_file(&file);
    let duration = started.elapsed().as_millis() as u64;
    match result {
        Ok((ok, output, error)) => KernelValidation {
            available: true,
            ok,
            binary: binary
                .file_name()
                .map(|name| name.to_string_lossy().to_string()),
            duration_ms: Some(duration),
            output: Some(output),
            error,
        },
        Err(error) => KernelValidation {
            available: true,
            ok: false,
            binary: None,
            duration_ms: Some(duration),
            output: None,
            error: Some(error),
        },
    }
}
