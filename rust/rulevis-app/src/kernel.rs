use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::form_urlencoded;

use crate::types::KernelStatus;
use crate::verge;

const PIPE_ROOT: &str = r"\\.\pipe\";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelSettings {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

fn default_mode() -> String {
    "auto".to_string()
}

impl Default for KernelSettings {
    fn default() -> Self {
        Self {
            mode: "auto".to_string(),
            endpoint: None,
            secret: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct KernelConnection {
    pub transport: String,
    pub pipe: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub secret: String,
    pub endpoint_label: String,
}

#[derive(Clone, Debug)]
pub struct KernelError {
    pub code: String,
    pub message: String,
}

impl KernelError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for KernelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub struct RawResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoMetadata {
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default, rename = "destinationIP")]
    pub destination_ip: Option<String>,
    #[serde(default)]
    pub destination_port: Option<String>,
    #[serde(default)]
    pub source_ip: Option<String>,
    #[serde(default)]
    pub source_port: Option<String>,
    #[serde(default)]
    pub inbound_name: Option<String>,
    #[serde(default)]
    pub process_path: Option<String>,
    #[serde(default)]
    pub process: Option<String>,
    #[serde(default)]
    pub special_proxy: Option<String>,
    #[serde(default)]
    pub sniff_host: Option<String>,
    #[serde(default)]
    pub remote_destination: Option<String>,
    #[serde(default)]
    pub dns_mode: Option<String>,
    #[serde(default)]
    pub uid: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoConnection {
    pub id: String,
    #[serde(default)]
    pub upload: u64,
    #[serde(default)]
    pub download: u64,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub chains: Vec<String>,
    #[serde(default)]
    pub rule: String,
    #[serde(default)]
    pub rule_payload: String,
    #[serde(default)]
    pub metadata: MihomoMetadata,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MihomoConnections {
    #[serde(default)]
    pub connections: Vec<MihomoConnection>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MihomoProxyHistory {
    #[serde(default)]
    pub delay: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MihomoProxy {
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub now: Option<String>,
    #[serde(default)]
    pub all: Vec<String>,
    #[serde(default)]
    pub history: Vec<MihomoProxyHistory>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MihomoProxies {
    #[serde(default)]
    pub proxies: HashMap<String, MihomoProxy>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoRuleExtra {
    #[serde(default)]
    pub hit_count: Option<u64>,
    #[serde(default)]
    pub hit_at: Option<String>,
    #[serde(default)]
    pub disabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoRule {
    #[serde(default)]
    pub index: u64,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: String,
    #[serde(default)]
    pub proxy: String,
    #[serde(default)]
    pub extra: Option<MihomoRuleExtra>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MihomoRules {
    #[serde(default)]
    pub rules: Vec<MihomoRule>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MihomoProvider {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub vehicle_type: Option<String>,
    #[serde(default)]
    pub behavior: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub rule_count: Option<u64>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MihomoProviders {
    #[serde(default)]
    pub providers: HashMap<String, MihomoProvider>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MihomoConfigs {
    #[serde(default, rename = "mixed-port")]
    pub mixed_port: Option<u16>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub mode: Option<String>,
}

pub struct Kernel {
    pub settings_path: PathBuf,
    pub settings: KernelSettings,
    connection: Option<KernelConnection>,
    status: KernelStatus,
    version: Option<String>,
    mode: Option<String>,
    mixed_port: Option<u16>,
    verge: Option<verge::VergeKernelInfo>,
    last_discover: Option<Instant>,
    last_refresh: Option<Instant>,
}

impl Kernel {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let settings_path = data_dir.join("kernel-settings.json");
        let settings = fs::read_to_string(&settings_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<KernelSettings>(&raw).ok())
            .unwrap_or_default();
        Self {
            settings_path,
            settings,
            connection: None,
            status: KernelStatus::disconnected(None, true),
            version: None,
            mode: None,
            mixed_port: None,
            verge: None,
            last_discover: None,
            last_refresh: None,
        }
    }

    pub fn status(&self) -> KernelStatus {
        self.status.clone()
    }

    pub fn mixed_port(&self) -> Option<u16> {
        self.mixed_port
    }

    pub fn connection_snapshot(&self) -> Option<KernelConnection> {
        self.connection.clone()
    }

    pub fn settings_view(&self) -> Value {
        serde_json::json!({
            "mode": self.settings.mode,
            "endpoint": self.settings.endpoint.clone().unwrap_or_default(),
            "hasSecret": self.settings.secret.as_deref().is_some_and(|secret| !secret.is_empty())
        })
    }

    pub fn save_settings(&mut self, next: KernelSettings) -> Result<(), String> {
        if !matches!(next.mode.as_str(), "auto" | "pipe" | "tcp") {
            return Err("连接模式无效".to_string());
        }
        if next.mode != "auto" && next.endpoint.as_deref().unwrap_or("").trim().is_empty() {
            return Err("手动模式需要填写控制器地址".to_string());
        }
        if next
            .endpoint
            .as_deref()
            .is_some_and(|endpoint| endpoint.contains('\n') || endpoint.contains('\r'))
        {
            return Err("控制器地址格式无效".to_string());
        }
        let raw = serde_json::to_vec_pretty(&next).map_err(|error| error.to_string())?;
        crate::storage::write_private_file(&self.settings_path, &raw)
            .map_err(|error| format!("无法保存内核设置：{}", error))?;
        self.settings = next;
        self.discover(true);
        Ok(())
    }

    pub fn ensure_connected(&mut self) {
        if self.connection.is_some() {
            if self
                .last_refresh
                .is_none_or(|last| last.elapsed() > Duration::from_secs(10))
            {
                let _ = self.refresh_configs();
            }
            return;
        }
        if self
            .last_discover
            .is_some_and(|last| last.elapsed() < Duration::from_secs(5))
        {
            return;
        }
        self.discover(false);
    }

    pub fn discover(&mut self, _force: bool) {
        if self
            .last_discover
            .is_some_and(|last| last.elapsed() < Duration::from_millis(800))
        {
            return;
        }
        self.last_discover = Some(Instant::now());
        self.status = KernelStatus::disconnected(None, true);
        self.verge = verge::kernel_info();
        let manual = parse_manual_endpoint(&self.settings);
        let secret = self
            .settings
            .secret
            .clone()
            .filter(|secret| !secret.is_empty())
            .or_else(|| {
                self.verge
                    .as_ref()
                    .map(|verge| verge.secret.clone())
                    .filter(|secret| !secret.is_empty())
            })
            .unwrap_or_default();
        let candidates = build_candidates(&self.settings, manual, &secret, self.verge.as_ref());
        let mut last_error = String::new();
        for candidate in candidates {
            match test_connection(&candidate) {
                Ok(version) => {
                    self.connection = Some(candidate);
                    self.version = Some(version);
                    self.mode = None;
                    self.mixed_port = None;
                    let _ = self.refresh_configs();
                    self.status = KernelStatus {
                        connected: true,
                        transport: self
                            .connection
                            .as_ref()
                            .map(|connection| connection.transport.clone()),
                        endpoint: self
                            .connection
                            .as_ref()
                            .map(|connection| connection.endpoint_label.clone()),
                        version: self.version.clone(),
                        mode: self.mode.clone(),
                        mixed_port: self.mixed_port,
                        error: None,
                        discovering: Some(false),
                        last_seen_at: Some(now_millis()),
                    };
                    return;
                }
                Err(error) => {
                    last_error = match error.code.as_str() {
                        "KERNEL_AUTH" => "密钥无效".to_string(),
                        "KERNEL_TIMEOUT" => "连接超时".to_string(),
                        _ => "未发现可用的外部控制器".to_string(),
                    };
                }
            }
        }
        self.connection = None;
        self.status = KernelStatus::disconnected(
            Some(if last_error.is_empty() {
                "未发现 mihomo 外部控制器".to_string()
            } else {
                last_error
            }),
            false,
        );
    }

    pub fn reload_config(&mut self, payload: &str) -> Result<(), KernelError> {
        let connection = self
            .connection
            .clone()
            .ok_or_else(|| KernelError::new("KERNEL_OFFLINE", "内核未连接"))?;
        let body = serde_json::json!({ "payload": payload }).to_string();
        let response = raw_request(
            &connection,
            "PUT",
            "/configs?force=true",
            Some(&body),
            15_000,
        )?;
        if !(200..300).contains(&response.status) {
            let detail = serde_json::from_str::<Value>(&response.body)
                .ok()
                .and_then(|value| {
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| response.body.chars().take(180).collect());
            return Err(KernelError::new(
                "KERNEL_HTTP",
                format!("内核重载失败（{}）：{}", response.status, detail),
            ));
        }
        self.status.connected = true;
        self.status.last_seen_at = Some(crate::storage::now_millis());
        self.status.error = None;
        Ok(())
    }

    pub fn refresh_configs(&mut self) -> Result<(), KernelError> {
        let Some(connection) = self.connection.clone() else {
            return Err(KernelError::new("KERNEL_OFFLINE", "内核未连接"));
        };
        let response = raw_request(&connection, "GET", "/configs", None, 3000)?;
        let configs: MihomoConfigs = parse_body(response)?;
        if let Some(mode) = configs.mode {
            self.mode = Some(mode);
        }
        self.mixed_port = configs.mixed_port.or(configs.port).or(self.mixed_port);
        self.status.connected = true;
        self.status.mode = self.mode.clone();
        self.status.mixed_port = self.mixed_port;
        self.status.last_seen_at = Some(now_millis());
        self.status.error = None;
        self.last_refresh = Some(Instant::now());
        Ok(())
    }

    pub fn request<T: for<'de> Deserialize<'de>>(
        &mut self,
        path: &str,
        timeout_ms: u64,
    ) -> Result<T, KernelError> {
        let Some(connection) = self.connection.clone() else {
            return Err(KernelError::new("KERNEL_OFFLINE", "内核未连接"));
        };
        match raw_request(&connection, "GET", path, None, timeout_ms).and_then(parse_body::<T>) {
            Ok(value) => {
                self.status.last_seen_at = Some(now_millis());
                self.status.connected = true;
                Ok(value)
            }
            Err(error) => {
                if error.code != "KERNEL_HTTP" && error.code != "KERNEL_AUTH" {
                    self.connection = None;
                    self.status =
                        KernelStatus::disconnected(Some("内核连接中断".to_string()), false);
                    self.last_discover = None;
                } else if error.code == "KERNEL_AUTH" {
                    self.status =
                        KernelStatus::disconnected(Some("内核密钥无效".to_string()), false);
                }
                Err(error)
            }
        }
    }

    pub fn connections(&mut self) -> Result<MihomoConnections, KernelError> {
        self.request("/connections", 5000)
    }

    pub fn proxies(&mut self) -> Result<MihomoProxies, KernelError> {
        self.request("/proxies", 5000)
    }

    pub fn rules(&mut self) -> Result<MihomoRules, KernelError> {
        self.request("/rules", 6000)
    }

    pub fn providers(&mut self) -> Result<MihomoProviders, KernelError> {
        self.request("/providers/rules", 6000)
    }

    pub fn test_node(
        &mut self,
        name: &str,
        url: &str,
        timeout_ms: u64,
    ) -> Result<Option<u64>, KernelError> {
        let connection = self
            .connection
            .clone()
            .ok_or_else(|| KernelError::new("KERNEL_OFFLINE", "内核未连接"))?;
        test_node_with(&connection, name, url, timeout_ms)
    }

    pub fn test_group(
        &mut self,
        name: &str,
        url: &str,
        timeout_ms: u64,
    ) -> Result<HashMap<String, u64>, KernelError> {
        let connection = self
            .connection
            .clone()
            .ok_or_else(|| KernelError::new("KERNEL_OFFLINE", "内核未连接"))?;
        test_group_with(&connection, name, url, timeout_ms)
    }

    pub fn probe_settings(settings: &KernelSettings) -> Value {
        let verge = verge::kernel_info();
        let manual = parse_manual_endpoint(settings);
        let secret = settings
            .secret
            .clone()
            .filter(|secret| !secret.is_empty())
            .or_else(|| {
                verge
                    .as_ref()
                    .map(|info| info.secret.clone())
                    .filter(|secret| !secret.is_empty())
            })
            .unwrap_or_default();
        let candidates = build_candidates(settings, manual, &secret, verge.as_ref());
        for candidate in candidates {
            match test_connection(&candidate) {
                Ok(version) => {
                    return serde_json::json!({
                        "ok": true,
                        "version": version,
                        "connection": candidate.endpoint_label
                    });
                }
                Err(error) if error.code == "KERNEL_AUTH" => {
                    return serde_json::json!({ "ok": false, "error": "密钥无效" });
                }
                Err(_) => {}
            }
        }
        serde_json::json!({ "ok": false, "error": "无法连接，请检查控制器地址与密钥" })
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_manual_endpoint(settings: &KernelSettings) -> Option<KernelConnection> {
    let endpoint = settings.endpoint.as_deref()?.trim();
    if endpoint.is_empty() {
        return None;
    }
    if endpoint.starts_with(PIPE_ROOT) || endpoint.starts_with(r"//./pipe/") {
        let pipe = endpoint.replace(r"//./pipe/", PIPE_ROOT);
        return Some(KernelConnection {
            transport: "pipe".to_string(),
            pipe: Some(pipe),
            host: None,
            port: None,
            secret: String::new(),
            endpoint_label: "命名管道".to_string(),
        });
    }
    let cleaned = endpoint
        .strip_prefix("http://")
        .or_else(|| endpoint.strip_prefix("https://"))
        .unwrap_or(endpoint);
    let (host, port) = match cleaned.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()?),
        None => (cleaned, 9090),
    };
    if host.is_empty() {
        return None;
    }
    Some(KernelConnection {
        transport: "tcp".to_string(),
        pipe: None,
        host: Some(host.to_string()),
        port: Some(port),
        secret: String::new(),
        endpoint_label: format!("{}:{}", host, port),
    })
}

fn build_candidates(
    settings: &KernelSettings,
    manual: Option<KernelConnection>,
    secret: &str,
    verge: Option<&verge::VergeKernelInfo>,
) -> Vec<KernelConnection> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |mut candidate: KernelConnection| {
        if candidate.secret.is_empty() {
            candidate.secret = secret.to_string();
        }
        let key = if candidate.transport == "pipe" {
            format!("pipe:{}", candidate.pipe.clone().unwrap_or_default())
        } else {
            format!(
                "tcp:{}:{}",
                candidate.host.clone().unwrap_or_default(),
                candidate.port.unwrap_or(0)
            )
        };
        if seen.insert(key) {
            candidates.push(candidate);
        }
    };

    if let Some(manual) = manual {
        add(manual);
        if settings.mode != "auto" {
            return candidates;
        }
    }

    if let Some(verge) = verge {
        if let Some(controller) = &verge.controller {
            if let Some((host, port)) = controller.rsplit_once(':') {
                if let Ok(port) = port.parse::<u16>() {
                    add(KernelConnection {
                        transport: "tcp".to_string(),
                        pipe: None,
                        host: Some(host.to_string()),
                        port: Some(port),
                        secret: String::new(),
                        endpoint_label: controller.clone(),
                    });
                }
            }
        }
        if let Some(pipe) = &verge.pipe {
            add(KernelConnection {
                transport: "pipe".to_string(),
                pipe: Some(pipe.clone()),
                host: None,
                port: None,
                secret: String::new(),
                endpoint_label: "命名管道".to_string(),
            });
        }
    }

    for pipe in list_mihomo_pipes() {
        add(KernelConnection {
            transport: "pipe".to_string(),
            pipe: Some(pipe),
            host: None,
            port: None,
            secret: String::new(),
            endpoint_label: "命名管道".to_string(),
        });
    }
    for port in [9097u16, 9090u16] {
        add(KernelConnection {
            transport: "tcp".to_string(),
            pipe: None,
            host: Some("127.0.0.1".to_string()),
            port: Some(port),
            secret: String::new(),
            endpoint_label: format!("127.0.0.1:{}", port),
        });
    }
    candidates
}

fn list_mihomo_pipes() -> Vec<String> {
    let Ok(entries) = fs::read_dir(PIPE_ROOT) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.to_lowercase().starts_with("verge-mihomo")
                || name.to_lowercase().starts_with("mihomo")
                || name.to_lowercase().starts_with("clash")
            {
                Some(format!("{}{}", PIPE_ROOT, name))
            } else {
                None
            }
        })
        .collect()
}

fn test_connection(connection: &KernelConnection) -> Result<String, KernelError> {
    let response = raw_request(connection, "GET", "/version", None, 1500)?;
    let data: Value = parse_body(response)?;
    Ok(data
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string())
}

fn parse_body<T: for<'de> Deserialize<'de>>(response: RawResponse) -> Result<T, KernelError> {
    if response.status == 401 || response.status == 403 {
        return Err(KernelError::new("KERNEL_AUTH", "内核密钥无效"));
    }
    if !(200..300).contains(&response.status) {
        let detail = serde_json::from_str::<Value>(&response.body)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| response.body.chars().take(180).collect());
        return Err(KernelError::new(
            "KERNEL_HTTP",
            format!(
                "内核返回 {}{}",
                response.status,
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("：{}", detail)
                }
            ),
        ));
    }
    serde_json::from_str(&response.body)
        .map_err(|_| KernelError::new("KERNEL_PARSE", "内核返回了无法解析的数据"))
}

fn raw_request(
    connection: &KernelConnection,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout_ms: u64,
) -> Result<RawResponse, KernelError> {
    if connection.transport == "pipe" {
        pipe_request(connection, method, path, body, timeout_ms)
    } else {
        tcp_request(connection, method, path, body, timeout_ms)
    }
}

fn tcp_request(
    connection: &KernelConnection,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout_ms: u64,
) -> Result<RawResponse, KernelError> {
    let host = connection.host.as_deref().unwrap_or("127.0.0.1");
    let port = connection.port.unwrap_or(9090);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(timeout_ms))
        .redirects(0)
        .build();
    let url = format!("http://{}:{}{}", host, port, path);
    let mut request = agent
        .request(method, &url)
        .set("Accept", "application/json");
    if !connection.secret.is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", connection.secret));
    }
    let result = if let Some(body) = body {
        request
            .set("Content-Type", "application/json")
            .send_string(body)
    } else {
        request.call()
    };
    match result {
        Ok(response) => {
            let status = response.status();
            let mut body = String::new();
            response
                .into_reader()
                .read_to_string(&mut body)
                .map_err(|error| {
                    KernelError::new("KERNEL_PARSE", format!("读取内核响应失败：{}", error))
                })?;
            Ok(RawResponse { status, body })
        }
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            Ok(RawResponse { status, body })
        }
        Err(error) => {
            let text = error.to_string();
            let code = if text.to_lowercase().contains("timed out")
                || text.to_lowercase().contains("timeout")
            {
                "KERNEL_TIMEOUT"
            } else {
                "KERNEL_TRANSPORT"
            };
            Err(KernelError::new(code, "无法连接内核控制器"))
        }
    }
}

fn pipe_request(
    connection: &KernelConnection,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout_ms: u64,
) -> Result<RawResponse, KernelError> {
    let pipe = connection
        .pipe
        .clone()
        .ok_or_else(|| KernelError::new("KERNEL_TRANSPORT", "命名管道地址无效"))?;
    let mut request = format!(
        "{} {} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n",
        method, path
    );
    if !connection.secret.is_empty() {
        request.push_str(&format!("Authorization: Bearer {}\r\n", connection.secret));
    }
    let body = body.unwrap_or("");
    if !body.is_empty() {
        request.push_str("Content-Type: application/json\r\n");
    }
    request.push_str(&format!("Content-Length: {}\r\n\r\n{}", body.len(), body));
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<RawResponse, String> {
            let mut file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&pipe)
                .map_err(|error| format!("无法打开命名管道：{}", error))?;
            file.write_all(request.as_bytes())
                .map_err(|error| format!("写入命名管道失败：{}", error))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| format!("读取命名管道失败：{}", error))?;
            parse_http_response(&bytes)
        })();
        let _ = sender.send(result);
    });
    match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(KernelError::new("KERNEL_TRANSPORT", error)),
        Err(_) => Err(KernelError::new("KERNEL_TIMEOUT", "内核请求超时")),
    }
}

fn parse_http_response(bytes: &[u8]) -> Result<RawResponse, String> {
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "内核返回了无效的 HTTP 响应".to_string())?;
    let header_text = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header_text.lines();
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
            if name.eq_ignore_ascii_case("transfer-encoding")
                && value.to_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }
    let body_bytes = &bytes[header_end + 4..];
    let body = if chunked {
        decode_chunked(body_bytes)?
    } else if let Some(length) = content_length {
        String::from_utf8_lossy(&body_bytes[..length.min(body_bytes.len())]).to_string()
    } else {
        String::from_utf8_lossy(body_bytes).to_string()
    };
    Ok(RawResponse { status, body })
}

fn decode_chunked(bytes: &[u8]) -> Result<String, String> {
    let mut output = Vec::new();
    let mut cursor = 0;
    loop {
        let line_end = bytes[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "分块响应不完整".to_string())?;
        let size_text = String::from_utf8_lossy(&bytes[cursor..cursor + line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| "分块响应长度无效".to_string())?;
        cursor += line_end + 2;
        if size == 0 {
            break;
        }
        if cursor + size > bytes.len() {
            return Err("分块响应内容不完整".to_string());
        }
        output.extend_from_slice(&bytes[cursor..cursor + size]);
        cursor += size;
        if bytes.get(cursor..cursor + 2) == Some(b"\r\n") {
            cursor += 2;
        }
    }
    Ok(String::from_utf8_lossy(&output).to_string())
}

fn delay_path(prefix: &str, name: &str, url: &str, timeout_ms: u64) -> String {
    let encoded = utf8_percent_encode(name, NON_ALPHANUMERIC).to_string();
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("url", url)
        .append_pair("timeout", &timeout_ms.to_string())
        .finish();
    format!("/{}/{}/delay?{}", prefix, encoded, query)
}

pub fn test_node_with(
    connection: &KernelConnection,
    name: &str,
    url: &str,
    timeout_ms: u64,
) -> Result<Option<u64>, KernelError> {
    let response = raw_request(
        connection,
        "GET",
        &delay_path("proxies", name, url, timeout_ms),
        None,
        timeout_ms + 3000,
    )?;
    let data: Value = parse_body(response)?;
    Ok(data.get("delay").and_then(Value::as_u64))
}

pub fn test_group_with(
    connection: &KernelConnection,
    name: &str,
    url: &str,
    timeout_ms: u64,
) -> Result<HashMap<String, u64>, KernelError> {
    let response = raw_request(
        connection,
        "GET",
        &delay_path("group", name, url, timeout_ms),
        None,
        timeout_ms + 4000,
    )?;
    parse_body(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn header_end(bytes: &[u8]) -> Option<usize> {
        bytes.windows(4).position(|window| window == b"\r\n\r\n")
    }

    #[test]
    fn reload_config_puts_payload_to_controller() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock controller");
        let port = listener.local_addr().expect("address").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("timeout");
            let mut data = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = stream.read(&mut buffer).expect("read request");
                if read == 0 {
                    break;
                }
                data.extend_from_slice(&buffer[..read]);
                let Some(end) = header_end(&data) else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&data[..end]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    break;
                }
            }
            stream
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .expect("write response");
            String::from_utf8_lossy(&data).to_string()
        });

        let dir = std::env::temp_dir().join(format!(
            "rulevis-kernel-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::create_dir_all(&dir).expect("create data dir");
        let mut kernel = Kernel::load(&dir);
        kernel.connection = Some(KernelConnection {
            transport: "tcp".to_string(),
            pipe: None,
            host: Some("127.0.0.1".to_string()),
            port: Some(port),
            secret: "test-secret".to_string(),
            endpoint_label: "mock".to_string(),
        });
        let payload = "mixed-port: 7897\nrules:\n  - MATCH,DIRECT\n";
        kernel.reload_config(payload).expect("reload");
        assert!(kernel.status().connected);

        let request = server.join().expect("server");
        assert!(request.starts_with("PUT /configs?force=true "), "{request}");
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer test-secret"),
            "{request}"
        );
        let body = request.split("\r\n\r\n").nth(1).expect("body");
        let json: Value = serde_json::from_str(body).expect("json body");
        assert_eq!(json["payload"], payload);
        let _ = std::fs::remove_dir_all(dir);
    }
}
