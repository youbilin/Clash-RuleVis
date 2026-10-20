use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub fn probe_through_proxy(
    host: &str,
    port: u16,
    mixed_port: u16,
    timeout: Duration,
) -> Result<(), String> {
    if host.is_empty()
        || host.len() > 253
        || !host.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '_' | ':' | '[' | ']' | '-')
        })
    {
        return Err("主机名格式无效".to_string());
    }
    let mut stream = TcpStream::connect(("127.0.0.1", mixed_port))
        .map_err(|error| format!("无法连接内核代理：{}", error))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "CONNECT {}:{} HTTP/1.1\r\nHost: {}:{}\r\nProxy-Connection: Keep-Alive\r\n\r\n",
        host, port, host, port
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发送探测请求失败：{}", error))?;
    let mut buffer = [0u8; 4096];
    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| format!("探测失败：{}", error))?;
        if read == 0 {
            return Err("连接被关闭".to_string());
        }
        if buffer[..read]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            return Ok(());
        }
    }
}
