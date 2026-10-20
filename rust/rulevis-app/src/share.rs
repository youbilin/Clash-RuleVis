use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use uuid::Uuid;

const SHARE_TTL_MS: u64 = 30 * 60_000;

struct ShareEntry {
    yaml: String,
    expires_at: u64,
}

pub struct ShareInfo {
    pub url: String,
    pub scheme_url: String,
    pub expires_at: u64,
}

pub struct ShareServer {
    entries: Arc<Mutex<HashMap<String, ShareEntry>>>,
    port: Option<u16>,
}

impl Default for ShareServer {
    fn default() -> Self {
        Self::new()
    }
}

impl ShareServer {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            port: None,
        }
    }

    pub fn publish(&mut self, yaml: String) -> Result<ShareInfo, String> {
        let now = now_millis();
        {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "分享服务锁不可用".to_string())?;
            entries.retain(|_, entry| entry.expires_at > now);
            let token = Uuid::new_v4().simple().to_string();
            let expires_at = now + SHARE_TTL_MS;
            entries.insert(token.clone(), ShareEntry { yaml, expires_at });
            if self.port.is_none() {
                let listener = TcpListener::bind(("127.0.0.1", 0))
                    .map_err(|error| format!("无法启动本地分享服务：{}", error))?;
                let port = listener
                    .local_addr()
                    .map_err(|error| format!("无法读取分享服务端口：{}", error))?
                    .port();
                self.port = Some(port);
                let entries = self.entries.clone();
                std::thread::Builder::new()
                    .name("rulevis-share".to_string())
                    .spawn(move || serve(listener, entries))
                    .map_err(|error| format!("无法启动分享线程：{}", error))?;
            }
            let url = format!(
                "http://127.0.0.1:{}/share/clash/{}.yaml",
                self.port.unwrap_or(0),
                token
            );
            let scheme_url = format!(
                "clash://install-config?url={}",
                percent_encoding::utf8_percent_encode(&url, percent_encoding::NON_ALPHANUMERIC)
            );
            Ok(ShareInfo {
                url,
                scheme_url,
                expires_at,
            })
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn serve(listener: TcpListener, entries: Arc<Mutex<HashMap<String, ShareEntry>>>) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let entries = entries.clone();
                let _ = std::thread::Builder::new()
                    .name("rulevis-share-request".to_string())
                    .spawn(move || handle_request(stream, entries));
            }
            Err(_) => break,
        }
    }
}

fn handle_request(mut stream: TcpStream, entries: Arc<Mutex<HashMap<String, ShareEntry>>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut buffer = [0u8; 8192];
    let read = stream.read(&mut buffer).unwrap_or(0);
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut parts = request.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let token = path
        .strip_prefix("/share/clash/")
        .and_then(|rest| rest.strip_suffix(".yaml"))
        .unwrap_or("");
    let now = now_millis();
    let entry = entries.lock().ok().and_then(|entries| {
        entries
            .get(token)
            .filter(|entry| entry.expires_at > now)
            .map(|entry| entry.yaml.clone())
    });
    let Some(yaml) = entry else {
        let body = "分享链接已失效";
        let response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        return;
    };
    if method == "HEAD" {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/yaml; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
            yaml.len()
        );
        let _ = stream.write_all(response.as_bytes());
        return;
    }
    if method != "GET" {
        let body = "Method Not Allowed";
        let response = format!(
            "HTTP/1.1 405 Method Not Allowed\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        return;
    }
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/yaml; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{}",
        yaml.len(),
        yaml
    );
    let _ = stream.write_all(response.as_bytes());
}
