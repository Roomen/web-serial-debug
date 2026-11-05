// 本地 MCP 服务的持久化设置：启用偏好、端口、令牌。存在应用数据目录(mcp-service.json)，不进仓库、不进 localStorage。
// 端口固定(默认 38991)是为了让用户复制给 agent 的配置在应用重启后仍然有效；绑定失败只报错，绝不悄悄换端口。
// 令牌只在用户显式「显示 / 复制」时经命令返回，不写日志、不进页面存储；文件从创建起就是 0600，原子替换。
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_PORT: u16 = 38991;
pub const MIN_PORT: u16 = 1024;
pub const SETTINGS_VERSION: u32 = 1;
const FILE_NAME: &str = "mcp-service.json";

// 不实现 Debug：避免令牌被顺手打进日志
#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub version: u32,
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { version: SETTINGS_VERSION, enabled: false, port: DEFAULT_PORT, token: String::new() }
    }
}

pub fn valid_port(port: u16) -> bool {
    port >= MIN_PORT
}

// 令牌格式：32 字节随机数的 hex 表示，正好 64 个小写 hex 字符
pub fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME))
}

pub fn load(app: &AppHandle) -> Settings {
    let Some(p) = path(app) else { return Settings::default() };
    let Ok(raw) = fs::read_to_string(&p) else { return Settings::default() };
    let Ok(mut s) = serde_json::from_str::<Settings>(&raw) else { return Settings::default() };
    if s.version != SETTINGS_VERSION || !valid_port(s.port) {
        return Settings::default();
    }
    // 存档里的令牌不合规(手改/损坏)时换一个：绝不沿用弱令牌
    if !valid_token(&s.token) {
        s.token = new_token();
        let _ = save(app, &s);
    }
    s
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let p = path(app).ok_or_else(|| "找不到应用数据目录".to_string())?;
    let dir = p.parent().ok_or_else(|| "应用数据目录无效".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
    let body = serde_json::to_vec_pretty(settings).map_err(|e| format!("设置序列化失败：{e}"))?;
    // 同目录唯一临时文件 + create_new + 原子替换：新建时就带 0600，不经过「先写再 chmod」的窗口，
    // 也不会覆盖/跟随别人预先放好的同名文件
    let (tmp, mut file) = create_private_temp(dir)?;
    let written = (|| -> Result<(), String> {
        file.write_all(&body).map_err(|_| "无法写入 MCP 设置(磁盘或权限错误)".to_string())?;
        file.flush().map_err(|_| "无法写入 MCP 设置(磁盘或权限错误)".to_string())
    })();
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, &p).map_err(|_| {
        let _ = fs::remove_file(&tmp);
        "无法保存 MCP 设置(磁盘或权限错误)".to_string()
    })
}

// 唯一临时文件名：随机后缀 + create_new，避免并发写与符号链接跟随
fn create_private_temp(dir: &std::path::Path) -> Result<(PathBuf, fs::File), String> {
    for _ in 0..8 {
        let mut suffix = [0u8; 8];
        let name = match getrandom::fill(&mut suffix) {
            Ok(()) => format!("{FILE_NAME}.{}.tmp", suffix.iter().map(|b| format!("{b:02x}")).collect::<String>()),
            Err(_) => format!("{FILE_NAME}.{}.tmp", std::process::id()),
        };
        let tmp = dir.join(name);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&tmp) {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建 MCP 设置文件(权限或磁盘错误)".to_string()),
        }
    }
    Err("无法创建 MCP 设置文件(临时文件冲突)".to_string())
}

// 32 字节随机令牌，hex 表示(64 字符)
pub fn new_token() -> String {
    let mut buf = [0u8; 32];
    if getrandom::fill(&mut buf).is_err() {
        // 系统熵源不可用时不生成可预测的令牌：返回空串，由调用方报错
        return String::new();
    }
    let mut out = String::with_capacity(64);
    for b in buf {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_format_is_checked() {
        assert!(valid_token(&new_token()));
        assert!(!valid_token(""));
        assert!(!valid_token("xyz"));
        assert!(!valid_token(&"A".repeat(64)));
        assert!(!valid_token(&"a".repeat(63)));
    }

    #[test]
    fn port_bounds() {
        assert!(valid_port(1024));
        assert!(valid_port(DEFAULT_PORT));
        assert!(!valid_port(80));
    }
}
