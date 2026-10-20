use std::fmt;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use url::Url;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeLinkError {
    pub message: String,
}

impl NodeLinkError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for NodeLinkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for NodeLinkError {}

impl From<&str> for NodeLinkError {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

type Result<T> = std::result::Result<T, NodeLinkError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedShareNode {
    #[serde(rename = "type")]
    pub kind: String,
    pub server: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cipher: Option<String>,
    pub tls: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sni: Option<String>,
    pub network: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<String>,
    pub extras: Map<String, Value>,
    pub warnings: Vec<String>,
}

fn safe_decode(value: &str) -> String {
    percent_decode_str(value)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn decode_base64_text(value: &str) -> Result<String> {
    let normalized: String = value
        .trim()
        .replace('-', "+")
        .replace('_', "/")
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let padding = (4 - normalized.len() % 4) % 4;
    let padded = format!("{}{}", normalized, "=".repeat(padding));
    let bytes = STANDARD
        .decode(padded.as_bytes())
        .map_err(|_| NodeLinkError::new("链接中的 Base64 数据无法解析"))?;
    String::from_utf8(bytes).map_err(|_| NodeLinkError::new("链接中的 Base64 数据无法解析"))
}

fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64().filter(|number| number.is_finite()),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            trimmed
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
        }
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

fn integer_port(value: f64) -> Option<u16> {
    if value.fract() != 0.0 || !(1.0..=65535.0).contains(&value) {
        return None;
    }
    Some(value as u16)
}

fn parse_host_port(value: &str) -> Result<(String, u16)> {
    let input = value.trim();
    let (host, port_text) = if let Some(rest) = input.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(NodeLinkError::new("节点地址格式不正确"));
        };
        let host = &rest[..end];
        let tail = &rest[end + 1..];
        (host, tail.strip_prefix(':').unwrap_or(tail))
    } else {
        let Some(colon) = input.rfind(':') else {
            return Err(NodeLinkError::new("节点地址缺少端口"));
        };
        if colon == 0 {
            return Err(NodeLinkError::new("节点地址缺少端口"));
        }
        (&input[..colon], &input[colon + 1..])
    };
    if host.trim().is_empty() {
        return Err(NodeLinkError::new("节点地址为空"));
    }
    let port_text = port_text.trim();
    let port_value: f64 = port_text
        .parse()
        .map_err(|_| NodeLinkError::new("节点端口无效"))?;
    let Some(port) = integer_port(port_value) else {
        return Err(NodeLinkError::new("节点端口无效"));
    };
    Ok((host.trim().to_string(), port))
}

fn parse_port_from_url(url: &Url) -> Result<u16> {
    let Some(port) = url.port() else {
        return Err(NodeLinkError::new("节点链接缺少有效端口"));
    };
    if port == 0 {
        return Err(NodeLinkError::new("节点链接缺少有效端口"));
    }
    Ok(port)
}

fn fragment_name(url: &Url) -> Option<String> {
    let name = url
        .fragment()
        .map(safe_decode)
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn build_name(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        _ => None,
    }
}

fn read_network(value: Option<&str>, warnings: &mut Vec<String>) -> String {
    let network = value.unwrap_or("tcp").to_lowercase();
    match network.as_str() {
        "ws" | "websocket" => "ws".to_string(),
        "grpc" => "grpc".to_string(),
        "tcp" | "none" | "" => "tcp".to_string(),
        _ => {
            warnings.push(format!(
                "传输方式 {} 暂不在手动表单中，已按 TCP 填充，请核对配置。",
                network
            ));
            "tcp".to_string()
        }
    }
}

fn is_enabled(value: Option<&str>) -> bool {
    matches!(value, Some("1")) || matches!(value, Some(text) if text.to_lowercase() == "true")
}

fn query_param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn query_params_from_text(text: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(text.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn query_get<'a>(params: &'a [(String, String)], name: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn reality_extras(url: &Url) -> (Map<String, Value>, Vec<String>) {
    let mut extras = Map::new();
    let mut warnings = Vec::new();
    let public_key = query_param(url, "pbk");
    let short_id = query_param(url, "sid");
    let fingerprint = query_param(url, "fp");

    let mut reality = Map::new();
    if let Some(public_key) = public_key.as_deref().filter(|value| !value.is_empty()) {
        reality.insert(
            "public-key".to_string(),
            Value::String(public_key.to_string()),
        );
    }
    if let Some(short_id) = short_id.as_deref().filter(|value| !value.is_empty()) {
        reality.insert("short-id".to_string(), Value::String(short_id.to_string()));
    }
    extras.insert("reality-opts".to_string(), Value::Object(reality));
    extras.insert(
        "client-fingerprint".to_string(),
        Value::String(
            fingerprint
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("chrome")
                .to_string(),
        ),
    );
    if public_key.as_deref().unwrap_or("").is_empty() {
        warnings.push("Reality 链接缺少 public-key，导入后需要在节点配置中补充。".to_string());
    }
    (extras, warnings)
}

fn parse_shadowsocks(text: &str) -> Result<ParsedShareNode> {
    let body = text.get(5..).unwrap_or("");
    let (main_with_query, name) = match body.find('#') {
        Some(index) => {
            let decoded = safe_decode(&body[index + 1..]);
            (
                &body[..index],
                if decoded.is_empty() {
                    None
                } else {
                    Some(decoded)
                },
            )
        }
        None => (body, None),
    };
    let (main, query) = match main_with_query.find('?') {
        Some(index) => (
            &main_with_query[..index],
            Some(&main_with_query[index + 1..]),
        ),
        None => (main_with_query, None),
    };

    let (user_part, host_part) = if let Some(at) = main.rfind('@') {
        (main[..at].to_string(), main[at + 1..].to_string())
    } else {
        let decoded = decode_base64_text(main)?;
        let Some(at) = decoded.rfind('@') else {
            return Err(NodeLinkError::new("Shadowsocks 链接缺少节点地址"));
        };
        (decoded[..at].to_string(), decoded[at + 1..].to_string())
    };

    let decoded_user_part = safe_decode(&user_part);
    let (cipher, password) = if let Some(colon) = decoded_user_part.find(':') {
        (
            decoded_user_part[..colon].to_string(),
            decoded_user_part[colon + 1..].to_string(),
        )
    } else {
        let decoded = decode_base64_text(&decoded_user_part)?;
        let Some(colon) = decoded.find(':') else {
            return Err(NodeLinkError::new("Shadowsocks 用户信息格式不正确"));
        };
        (
            decoded[..colon].to_string(),
            decoded[colon + 1..].to_string(),
        )
    };
    let (server, port) = parse_host_port(&host_part)?;
    if cipher.is_empty() || password.is_empty() {
        return Err(NodeLinkError::new("Shadowsocks 链接缺少加密方式或密码"));
    }

    let mut warnings = Vec::new();
    if let Some(query) = query {
        let params = query_params_from_text(query);
        if query_get(&params, "plugin").is_some_and(|value| !value.is_empty()) {
            warnings.push(
                "链接包含 Shadowsocks 插件参数；基本连接信息已填充，插件请使用 YAML 粘贴导入。"
                    .to_string(),
            );
        }
    }

    Ok(ParsedShareNode {
        kind: "ss".to_string(),
        server,
        port,
        name,
        uuid: None,
        username: None,
        password: Some(password),
        cipher: Some(cipher),
        tls: false,
        sni: None,
        network: "tcp".to_string(),
        path: None,
        host: None,
        service: None,
        flow: None,
        extras: Map::new(),
        warnings,
    })
}

fn decode_query_base64(value: &str) -> Option<String> {
    decode_base64_text(value).ok()
}

fn parse_ssr(text: &str) -> Result<ParsedShareNode> {
    let payload = text
        .get(6..)
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .trim();
    let decoded = decode_base64_text(payload)?;
    let (main, query_text) = match decoded.split_once("/?") {
        Some((main, query)) => (main, query),
        None => (decoded.as_str(), ""),
    };
    let parts: Vec<&str> = main.split(':').collect();
    if parts.len() < 6 {
        return Err(NodeLinkError::new("SSR 链接字段不完整"));
    }
    let server = parts[0].trim();
    let port_value: f64 = parts[1]
        .trim()
        .parse()
        .map_err(|_| NodeLinkError::new("SSR 链接缺少有效的服务器或端口"))?;
    let Some(port) = integer_port(port_value) else {
        return Err(NodeLinkError::new("SSR 链接缺少有效的服务器或端口"));
    };
    if server.is_empty() {
        return Err(NodeLinkError::new("SSR 链接缺少有效的服务器或端口"));
    }
    let protocol = parts[2];
    let cipher = parts[3];
    let obfs = parts[4];
    let encoded_password = parts[5];
    if cipher.is_empty() || encoded_password.is_empty() {
        return Err(NodeLinkError::new("SSR 链接缺少加密方式或密码"));
    }

    let params = query_params_from_text(query_text);
    let decode_param = |name: &str| -> Option<String> {
        let raw = query_get(&params, name)?;
        if raw.is_empty() {
            return None;
        }
        Some(decode_query_base64(raw).unwrap_or_else(|| raw.to_string()))
    };

    let mut extras = Map::new();
    extras.insert(
        "protocol".to_string(),
        Value::String(
            if protocol.is_empty() {
                "origin"
            } else {
                protocol
            }
            .to_string(),
        ),
    );
    extras.insert(
        "obfs".to_string(),
        Value::String(if obfs.is_empty() { "plain" } else { obfs }.to_string()),
    );
    if let Some(protocol_param) = decode_param("protoparam") {
        extras.insert("protocol-param".to_string(), Value::String(protocol_param));
    }
    if let Some(obfs_param) = decode_param("obfsparam") {
        extras.insert("obfs-param".to_string(), Value::String(obfs_param));
    }

    Ok(ParsedShareNode {
        kind: "ssr".to_string(),
        server: server.to_string(),
        port,
        name: decode_param("remarks"),
        uuid: None,
        username: None,
        password: Some(decode_base64_text(encoded_password)?),
        cipher: Some(cipher.to_string()),
        tls: false,
        sni: None,
        network: "tcp".to_string(),
        path: None,
        host: None,
        service: None,
        flow: None,
        extras,
        warnings: Vec::new(),
    })
}

fn parse_socks5(text: &str) -> Result<ParsedShareNode> {
    let normalized = if text.to_lowercase().starts_with("socks://") {
        format!("socks5://{}", text.get(8..).unwrap_or(""))
    } else {
        text.to_string()
    };
    let url = Url::parse(&normalized).map_err(|_| NodeLinkError::new("SOCKS5 链接格式不正确"))?;
    let server = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    if server.is_empty() {
        return Err(NodeLinkError::new("SOCKS5 链接缺少服务器地址"));
    }
    let port = parse_port_from_url(&url)?;
    let username = safe_decode(url.username());
    let password = safe_decode(url.password().unwrap_or(""));

    Ok(ParsedShareNode {
        kind: "socks5".to_string(),
        server,
        port,
        name: fragment_name(&url),
        uuid: None,
        username: if username.is_empty() {
            None
        } else {
            Some(username)
        },
        password: if password.is_empty() {
            None
        } else {
            Some(password)
        },
        cipher: None,
        tls: false,
        sni: None,
        network: "tcp".to_string(),
        path: None,
        host: None,
        service: None,
        flow: None,
        extras: Map::new(),
        warnings: Vec::new(),
    })
}

fn parse_vmess(text: &str) -> Result<ParsedShareNode> {
    let payload = text.get(8..).unwrap_or("").split('#').next().unwrap_or("");
    let decoded = decode_base64_text(payload)
        .map_err(|_| NodeLinkError::new("VMess 链接内容无法解析，请确认链接完整"))?;
    let json: Value = serde_json::from_str(&decoded)
        .map_err(|_| NodeLinkError::new("VMess 链接内容无法解析，请确认链接完整"))?;
    let Some(object) = json.as_object() else {
        return Err(NodeLinkError::new("VMess 链接缺少有效的服务器或端口"));
    };

    let server = object
        .get("add")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let port = object
        .get("port")
        .and_then(js_number)
        .and_then(integer_port);
    let uuid = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let Some(port) = port.filter(|_| !server.is_empty()) else {
        return Err(NodeLinkError::new("VMess 链接缺少有效的服务器或端口"));
    };
    if uuid.is_empty() {
        return Err(NodeLinkError::new("VMess 链接缺少 UUID"));
    }

    let mut warnings = Vec::new();
    let network = read_network(object.get("net").and_then(Value::as_str), &mut warnings);
    let path = object.get("path").and_then(Value::as_str);
    let host = object.get("host").and_then(Value::as_str);
    let tls = object
        .get("tls")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase()
        == "tls";
    let serialized_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if !serialized_type.is_empty() && serialized_type != "none" {
        warnings.push(format!(
            "VMess 头部类型 {} 未在表单中展示，已忽略。",
            object.get("type").and_then(Value::as_str).unwrap_or("")
        ));
    }
    let mut extras = Map::new();
    let alter_id = object.get("aid").and_then(js_number).unwrap_or(0.0);
    if alter_id > 0.0 {
        if alter_id.fract() == 0.0 {
            extras.insert(
                "alterId".to_string(),
                Value::Number(Number::from(alter_id as i64)),
            );
        } else {
            extras.insert(
                "alterId".to_string(),
                Number::from_f64(alter_id)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            );
        }
    }

    Ok(ParsedShareNode {
        kind: "vmess".to_string(),
        server,
        port,
        name: build_name(object.get("ps")),
        uuid: Some(uuid),
        username: None,
        password: None,
        cipher: None,
        tls,
        sni: object
            .get("sni")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        network: network.clone(),
        path: if network == "ws" {
            Some(
                path.filter(|value| !value.is_empty())
                    .unwrap_or("/")
                    .to_string(),
            )
        } else {
            None
        },
        host: if network == "ws" {
            host.map(str::to_string)
        } else {
            None
        },
        service: if network == "grpc" {
            path.map(str::to_string)
        } else {
            None
        },
        flow: None,
        extras,
        warnings,
    })
}

fn parse_url_node(text: &str, kind: &str) -> Result<ParsedShareNode> {
    let url = Url::parse(text).map_err(|_| NodeLinkError::new("节点链接格式不正确"))?;
    let server = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    if server.is_empty() {
        return Err(NodeLinkError::new("节点链接缺少服务器地址"));
    }
    let port = parse_port_from_url(&url)?;
    let warnings: Vec<String> = Vec::new();
    let uuid = safe_decode(url.username());
    let password = safe_decode(url.password().unwrap_or(""));
    let sni = query_param(&url, "sni")
        .or_else(|| query_param(&url, "servername"))
        .or_else(|| query_param(&url, "peer"));
    let security = query_param(&url, "security")
        .unwrap_or_default()
        .to_lowercase();
    let mut extra = Map::new();
    if is_enabled(query_param(&url, "allowInsecure").as_deref())
        || is_enabled(query_param(&url, "insecure").as_deref())
    {
        extra.insert("skip-cert-verify".to_string(), Value::Bool(true));
    }

    match kind {
        "vless" => {
            if uuid.is_empty() {
                return Err(NodeLinkError::new("VLESS 链接缺少 UUID"));
            }
            let mut warnings = warnings;
            let network = read_network(query_param(&url, "type").as_deref(), &mut warnings);
            let tls = security == "tls" || security == "reality";
            if security == "reality" {
                let (reality, reality_warnings) = reality_extras(&url);
                for (key, value) in reality {
                    extra.insert(key, value);
                }
                warnings.extend(reality_warnings);
            }
            let ws_path = query_param(&url, "path")
                .filter(|value| !value.is_empty())
                .or_else(|| Some("/".to_string()));
            let grpc_service =
                query_param(&url, "serviceName").or_else(|| query_param(&url, "service"));
            Ok(ParsedShareNode {
                kind: kind.to_string(),
                server,
                port,
                name: fragment_name(&url),
                uuid: Some(uuid),
                username: None,
                password: None,
                cipher: None,
                tls,
                sni,
                network: network.clone(),
                path: if network == "ws" { ws_path } else { None },
                host: if network == "ws" {
                    query_param(&url, "host")
                } else {
                    None
                },
                service: if network == "grpc" {
                    grpc_service
                } else {
                    None
                },
                flow: query_param(&url, "flow"),
                extras: extra,
                warnings,
            })
        }
        "trojan" => {
            let password_value = if password.is_empty() {
                uuid.clone()
            } else {
                format!("{}:{}", uuid, password)
            };
            if password_value.is_empty() {
                return Err(NodeLinkError::new("Trojan 链接缺少密码"));
            }
            let mut warnings = warnings;
            let network = read_network(query_param(&url, "type").as_deref(), &mut warnings);
            let ws_path = query_param(&url, "path")
                .filter(|value| !value.is_empty())
                .or_else(|| Some("/".to_string()));
            let grpc_service =
                query_param(&url, "serviceName").or_else(|| query_param(&url, "service"));
            Ok(ParsedShareNode {
                kind: kind.to_string(),
                server,
                port,
                name: fragment_name(&url),
                uuid: None,
                username: None,
                password: Some(password_value),
                cipher: None,
                tls: security != "none",
                sni,
                network: network.clone(),
                path: if network == "ws" { ws_path } else { None },
                host: if network == "ws" {
                    query_param(&url, "host")
                } else {
                    None
                },
                service: if network == "grpc" {
                    grpc_service
                } else {
                    None
                },
                flow: None,
                extras: extra,
                warnings,
            })
        }
        "hysteria2" => {
            let password_value = if password.is_empty() {
                uuid.clone()
            } else {
                format!("{}:{}", uuid, password)
            };
            if password_value.is_empty() {
                return Err(NodeLinkError::new("Hysteria2 链接缺少认证密码"));
            }
            let mut warnings = warnings;
            if let Some(obfs) = query_param(&url, "obfs").filter(|value| !value.is_empty()) {
                extra.insert("obfs".to_string(), Value::String(obfs));
                match query_param(&url, "obfs-password").filter(|value| !value.is_empty()) {
                    Some(obfs_password) => {
                        extra.insert("obfs-password".to_string(), Value::String(obfs_password));
                    }
                    None => warnings
                        .push("Hysteria2 启用了 obfs，但链接没有提供 obfs-password。".to_string()),
                }
            }
            if query_param(&url, "mport").is_some_and(|value| !value.is_empty())
                || query_param(&url, "ports").is_some_and(|value| !value.is_empty())
            {
                warnings.push("链接包含端口跳跃参数，表单仅保留单一端口。".to_string());
            }
            Ok(ParsedShareNode {
                kind: kind.to_string(),
                server,
                port,
                name: fragment_name(&url),
                uuid: None,
                username: None,
                password: Some(password_value),
                cipher: None,
                tls: true,
                sni,
                network: "tcp".to_string(),
                path: None,
                host: None,
                service: None,
                flow: None,
                extras: extra,
                warnings,
            })
        }
        "tuic" => {
            if uuid.is_empty() {
                return Err(NodeLinkError::new("TUIC 链接缺少 UUID"));
            }
            if password.is_empty() {
                return Err(NodeLinkError::new("TUIC 链接缺少密码"));
            }
            Ok(ParsedShareNode {
                kind: kind.to_string(),
                server,
                port,
                name: fragment_name(&url),
                uuid: Some(uuid),
                username: None,
                password: Some(password),
                cipher: None,
                tls: true,
                sni,
                network: "tcp".to_string(),
                path: None,
                host: None,
                service: None,
                flow: None,
                extras: extra,
                warnings,
            })
        }
        _ => Err(NodeLinkError::new("暂不支持该链接协议")),
    }
}

pub fn parse_share_link(input: &str) -> Result<ParsedShareNode> {
    let trimmed = input.trim();
    let mut text = trimmed;
    if text.starts_with('\'') || text.starts_with('"') {
        text = &text[1..];
    }
    if text.ends_with('\'') || text.ends_with('"') {
        text = &text[..text.len().saturating_sub(1)];
    }
    if text.is_empty() {
        return Err(NodeLinkError::new("请粘贴节点分享链接"));
    }
    if text.contains('\r') || text.contains('\n') {
        return Err(NodeLinkError::new("一次只能识别一个节点链接"));
    }
    let before_hash = text.split('#').next().unwrap_or(text);
    if before_hash.chars().any(char::is_whitespace) {
        return Err(NodeLinkError::new(
            "链接中间含有空白字符，请检查是否被换行截断",
        ));
    }
    let lower = text.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Err(NodeLinkError::new(
            "这是订阅或网页链接，请切换到「订阅」标签导入",
        ));
    }
    if lower.starts_with("ssr://") {
        return parse_ssr(text);
    }
    if lower.starts_with("ss://") {
        return parse_shadowsocks(text);
    }
    if lower.starts_with("vmess://") {
        return parse_vmess(text);
    }
    if lower.starts_with("vless://") {
        return parse_url_node(text, "vless");
    }
    if lower.starts_with("trojan://") {
        return parse_url_node(text, "trojan");
    }
    if lower.starts_with("hysteria2://") || lower.starts_with("hy2://") {
        let normalized = if lower.starts_with("hy2://") {
            format!("hysteria2://{}", text.get(6..).unwrap_or(""))
        } else {
            text.to_string()
        };
        return parse_url_node(&normalized, "hysteria2");
    }
    if lower.starts_with("tuic://") {
        return parse_url_node(text, "tuic");
    }
    if lower.starts_with("socks5://") || lower.starts_with("socks://") {
        return parse_socks5(text);
    }
    Err(NodeLinkError::new(
        "暂不支持该链接协议；支持 ss / ssr / vmess / vless / trojan / hysteria2 / tuic / socks5",
    ))
}

pub fn share_node_display_name(node: &ParsedShareNode) -> String {
    node.name
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("{} {}", node.kind.to_uppercase(), node.server))
}

pub fn share_node_to_proxy(node: &ParsedShareNode) -> Map<String, Value> {
    let mut proxy = node.extras.clone();
    proxy.insert(
        "name".to_string(),
        Value::String(share_node_display_name(node)),
    );
    proxy.insert("type".to_string(), Value::String(node.kind.clone()));
    proxy.insert("server".to_string(), Value::String(node.server.clone()));
    proxy.insert(
        "port".to_string(),
        Value::Number(Number::from(u64::from(node.port))),
    );

    match node.kind.as_str() {
        "ss" | "ssr" => {
            if let Some(cipher) = &node.cipher {
                proxy.insert("cipher".to_string(), Value::String(cipher.clone()));
            }
            if let Some(password) = &node.password {
                proxy.insert("password".to_string(), Value::String(password.clone()));
            }
        }
        "socks5" => {
            if let Some(username) = &node.username {
                proxy.insert("username".to_string(), Value::String(username.clone()));
            }
            if let Some(password) = &node.password {
                proxy.insert("password".to_string(), Value::String(password.clone()));
            }
        }
        "vmess" => {
            if let Some(uuid) = &node.uuid {
                proxy.insert("uuid".to_string(), Value::String(uuid.clone()));
            }
            proxy.insert("cipher".to_string(), Value::String("auto".to_string()));
        }
        "vless" => {
            if let Some(uuid) = &node.uuid {
                proxy.insert("uuid".to_string(), Value::String(uuid.clone()));
            }
            if let Some(flow) = &node.flow {
                proxy.insert("flow".to_string(), Value::String(flow.clone()));
            }
        }
        "trojan" | "hysteria2" => {
            if let Some(password) = &node.password {
                proxy.insert("password".to_string(), Value::String(password.clone()));
            }
        }
        "tuic" => {
            if let Some(uuid) = &node.uuid {
                proxy.insert("uuid".to_string(), Value::String(uuid.clone()));
            }
            if let Some(password) = &node.password {
                proxy.insert("password".to_string(), Value::String(password.clone()));
            }
        }
        _ => {}
    }

    let simple = matches!(node.kind.as_str(), "ss" | "ssr" | "socks5");
    if !simple && node.tls {
        proxy.insert("tls".to_string(), Value::Bool(true));
    }
    if let Some(sni) = node.sni.as_deref().filter(|value| !value.is_empty()) {
        let key = if matches!(node.kind.as_str(), "hysteria2" | "tuic") {
            "sni"
        } else if !simple {
            "servername"
        } else {
            ""
        };
        if !key.is_empty() {
            proxy.insert(key.to_string(), Value::String(sni.to_string()));
        }
    }

    if !matches!(node.kind.as_str(), "hysteria2" | "tuic") && node.network != "tcp" {
        proxy.insert("network".to_string(), Value::String(node.network.clone()));
        if node.network == "ws" {
            let mut ws_opts = Map::new();
            ws_opts.insert(
                "path".to_string(),
                Value::String(
                    node.path
                        .clone()
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "/".to_string()),
                ),
            );
            if let Some(host) = node.host.as_deref().filter(|value| !value.is_empty()) {
                let mut headers = Map::new();
                headers.insert("Host".to_string(), Value::String(host.to_string()));
                ws_opts.insert("headers".to_string(), Value::Object(headers));
            }
            proxy.insert("ws-opts".to_string(), Value::Object(ws_opts));
        }
        if node.network == "grpc" {
            let mut grpc_opts = Map::new();
            grpc_opts.insert(
                "grpc-service-name".to_string(),
                Value::String(node.service.clone().unwrap_or_default()),
            );
            proxy.insert("grpc-opts".to_string(), Value::Object(grpc_opts));
        }
    }
    proxy
}
