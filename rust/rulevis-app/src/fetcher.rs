use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use url::Url;

pub struct FetchResult {
    pub bytes: Vec<u8>,
    pub text: String,
    pub headers: HashMap<String, String>,
    pub final_url: String,
    pub status: u16,
}

pub fn fetch_url(
    url: &str,
    user_agent: &str,
    proxy_port: Option<u16>,
    timeout_ms: u64,
) -> Result<FetchResult, String> {
    let parsed = Url::parse(url).map_err(|_| "地址格式无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持 http / https 地址".to_string());
    }

    let direct = attempt(url, user_agent, timeout_ms, None);
    match direct {
        Ok(result) => Ok(result),
        Err(direct_error) => {
            if let Some(port) = proxy_port {
                match attempt(
                    url,
                    user_agent,
                    timeout_ms,
                    Some(format!("http://127.0.0.1:{}", port)),
                ) {
                    Ok(result) => Ok(result),
                    Err(proxy_error) => Err(format!(
                        "下载失败：直连 {}；经内核代理 {}",
                        direct_error, proxy_error
                    )),
                }
            } else {
                Err(format!("下载失败：{}", direct_error))
            }
        }
    }
}

fn attempt(
    url: &str,
    user_agent: &str,
    timeout_ms: u64,
    proxy: Option<String>,
) -> Result<FetchResult, String> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(timeout_ms))
        .redirects(6)
        .user_agent(user_agent);
    if let Some(proxy) = proxy {
        builder = builder
            .proxy(ureq::Proxy::new(&proxy).map_err(|error| format!("代理设置无效：{}", error))?);
    }
    let agent = builder.build();
    let response = agent
        .get(url)
        .set("Accept", "*/*")
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(code, _) => format!("HTTP {}", code),
            other => other.to_string(),
        })?;
    let status = response.status();
    let final_url = response.get_url().to_string();
    let mut headers = HashMap::new();
    for name in response.headers_names() {
        if let Some(value) = response.header(&name) {
            headers.insert(name.to_lowercase(), value.to_string());
        }
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取响应失败：{}", error))?;
    if bytes.is_empty() {
        return Err("响应内容为空".to_string());
    }
    let text = String::from_utf8_lossy(&bytes)
        .trim_start_matches('\u{feff}')
        .to_string();
    Ok(FetchResult {
        bytes,
        text,
        headers,
        final_url,
        status,
    })
}

pub fn parse_subscription_userinfo(
    value: Option<&str>,
) -> Option<rulevis_core::model::SubscriptionUserinfo> {
    let value = value?;
    let mut values = HashMap::new();
    for part in value.split(';') {
        let mut pieces = part.splitn(2, '=');
        let key = pieces.next()?.trim();
        let raw = pieces.next()?.trim();
        if key.is_empty() {
            continue;
        }
        if let Ok(number) = raw.parse::<i64>() {
            values.insert(key.to_lowercase(), number);
        }
    }
    let upload = values.get("upload").copied().unwrap_or(0);
    let download = values.get("download").copied().unwrap_or(0);
    let total = values.get("total").copied().unwrap_or(0);
    if total == 0 && upload == 0 && download == 0 {
        return None;
    }
    let expire = values.get("expire").copied().filter(|value| *value > 0);
    Some(rulevis_core::model::SubscriptionUserinfo {
        used: (upload + download).max(0) as u64,
        total: total.max(0) as u64,
        expire,
    })
}
