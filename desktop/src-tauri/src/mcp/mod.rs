// 桌面客户端的本地 MCP 服务(默认关闭)：标准 MCP Streamable HTTP(rmcp)，只绑 127.0.0.1 固定端口 + Bearer 令牌。
// 工具本身不含设备逻辑：全部经 js/mcp-bridge.js 在「确切的那个窗口」里复用页面既有的串口 / 功耗业务路径。
// 生命周期：偏好(启用/端口/令牌)存应用数据目录；上次启用过也要等应用初始化且至少一个已登录的桌面窗口注册后才启动。
mod auth;
mod bridge;
mod http;
mod server;
mod settings;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use auth::AuthState;
use bridge::{BridgeError, WindowBridge, SERVICE_EVENT};
use settings::Settings;

// 单次工具调用的默认等待；读串口按参数另算
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(20);
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PENDING_PER_WINDOW: usize = 4;
const MAX_PENDING_TOTAL: usize = 16;
// 页面回执上限：工具结果只应是短 JSON
const MAX_REPLY_BYTES: usize = 1024 * 1024;
// 设备源电压范围，与 js/blu-protocol.js 的 VDD_LOW_MV / VDD_HIGH_MV 一致
pub const VOLTAGE_MIN_MV: u32 = 500;
pub const VOLTAGE_MAX_MV: u32 = 5000;

pub struct WindowReg {
    pub bridge_epoch: String,
    pub authed: bool,
    pub mode: String,
    pub app_version: String,
}

struct Pending {
    label: String,
    bridge_epoch: String,
    epoch: u64,
    deadline: Instant,
    committed: bool,
    tx: Option<oneshot::Sender<(bool, Value)>>,
}

pub struct Running {
    pub port: u16,
    shutdown: tokio_util::sync::CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Running {
    pub fn new(port: u16, shutdown: tokio_util::sync::CancellationToken, task: tauri::async_runtime::JoinHandle<()>) -> Self {
        Running { port, shutdown, task }
    }
    fn stop(self) {
        self.shutdown.cancel();
        self.task.abort();
    }
}

struct Inner {
    settings: Settings,
    token: Arc<RwLock<String>>,
    running: Option<Running>,
    starting: bool,
    // 每次 stop / 改端口 / 换令牌都 +1：绑定期间状态变了就丢弃这次启动
    start_generation: u64,
    start_on_ready: bool,
    windows: HashMap<String, WindowReg>,
    pending: HashMap<String, Pending>,
    seq: u64,
    epoch: u64,
    last_error: Option<String>,
}

#[derive(Clone)]
pub struct McpState {
    inner: Arc<Mutex<Inner>>,
    // 生命周期串行化：enable / disable / 自动启动 / 换令牌不并发改状态
    lifecycle: Arc<tokio::sync::Mutex<()>>,
}

impl Default for McpState {
    fn default() -> Self {
        McpState {
            inner: Arc::new(Mutex::new(Inner {
                settings: Settings::default(),
                token: Arc::new(RwLock::new(String::new())),
                running: None,
                starting: false,
                start_generation: 0,
                start_on_ready: false,
                windows: HashMap::new(),
                pending: HashMap::new(),
                seq: 0,
                epoch: 0,
                last_error: None,
            })),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}

fn lock(state: &McpState) -> std::sync::MutexGuard<'_, Inner> {
    state.inner.lock().unwrap_or_else(|e| e.into_inner())
}

// 终结一个在飞请求：明确区分「未执行」与「已开始、结果未知」
fn terminal_result(code: &str, committed: bool) -> Value {
    let message = match (code, committed) {
        ("service_stopped", false) => "本地 MCP 服务已停止，操作未执行",
        ("service_stopped", true) => "本地 MCP 服务在操作开始后停止，结果未知",
        ("window_reloaded", false) => "窗口已刷新或关闭，操作未执行",
        ("window_reloaded", true) => "窗口在操作开始后刷新或关闭，结果未知",
        ("update_preparing", false) => "应用开始准备升级，操作未执行",
        ("update_preparing", true) => "应用在操作开始后开始准备升级，结果未知",
        ("token_rotated", false) => "MCP 令牌已更换，旧请求未执行",
        ("token_rotated", true) => "MCP 令牌在操作开始后更换，结果未知",
        ("window_locked", false) => "窗口已退出登录，操作未执行",
        ("window_locked", true) => "窗口在操作开始后退出登录，结果未知",
        (_, false) => "请求已取消，操作未执行",
        (_, true) => "请求在操作开始后取消，结果未知",
    };
    json!({
        "code": code,
        "message": message,
        "executed": if committed { json!("unknown") } else { json!(false) },
    })
}

fn finish_with_terminal(inner: &mut Inner, id: &str, code: &str, committed: bool) {
    if let Some(mut p) = inner.pending.remove(id) {
        if let Some(tx) = p.tx.take() {
            let _ = tx.send((false, terminal_result(code, committed)));
        }
    }
}

impl Inner {
    // 取走全部在飞请求并给出终态回执(不再静默丢弃 oneshot)
    fn fail_pending(&mut self, code: &str) -> Vec<(String, String)> {
        let drained: Vec<(String, Pending)> = self.pending.drain().collect();
        let mut cancelled = Vec::with_capacity(drained.len());
        for (id, mut p) in drained {
            if let Some(tx) = p.tx.take() {
                let _ = tx.send((false, terminal_result(code, p.committed)));
            }
            cancelled.push((p.label, id));
        }
        cancelled
    }

    fn fail_pending_for(&mut self, label: &str, bridge_epoch: Option<&str>, code: &str) -> Vec<(String, String)> {
        let ids: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| {
                p.label == label && bridge_epoch.map(|e| p.bridge_epoch == e).unwrap_or(true)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut cancelled = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(mut p) = self.pending.remove(&id) {
                if let Some(tx) = p.tx.take() {
                    let _ = tx.send((false, terminal_result(code, p.committed)));
                }
                cancelled.push((p.label, id));
            }
        }
        cancelled
    }
}

fn emit_cancels(app: &AppHandle, cancelled: Vec<(String, String)>, reason: &str) {
    if cancelled.is_empty() {
        return;
    }
    let bridge = bridge::TauriBridge::new(app.clone());
    for (label, id) in cancelled {
        let _ = bridge.send_cancel(&label, json!({ "id": id, "reason": reason }));
    }
}

impl McpState {
    // 启动时读设置；上次是启用状态时只登记「等已登录窗口」，不立刻监听
    pub fn init(&self, app: &AppHandle) {
        let loaded = settings::load(app);
        let mut inner = lock(self);
        inner.start_on_ready = loaded.enabled;
        inner.settings = loaded;
        let token_arc = inner.token.clone();
        let token = inner.settings.token.clone();
        let _ = token_arc.write().map(|mut t| *t = token);
    }

    pub fn token(&self) -> String {
        lock(self).settings.token.clone()
    }

    pub fn status(&self) -> Value {
        let inner = lock(self);
        let port = inner.running.as_ref().map(|r| r.port).unwrap_or(inner.settings.port);
        json!({
            "supported": true,
            "enabled": inner.settings.enabled,
            "running": inner.running.is_some(),
            "starting": inner.starting,
            "port": port,
            "url": format!("http://127.0.0.1:{port}/mcp"),
            "hasToken": !inner.settings.token.is_empty(),
            "lastError": inner.last_error,
            "waitingForLogin": inner.start_on_ready && inner.running.is_none(),
        })
    }

    fn authed_window_count(&self) -> usize {
        lock(self).windows.values().filter(|w| w.authed).count()
    }

    // 返回需要发 cancel 事件的 (label, id)
    fn register_window(&self, label: &str, reg: WindowReg) -> Vec<(String, String)> {
        let mut inner = lock(self);
        let same_epoch = inner.windows.get(label).map(|w| w.bridge_epoch == reg.bridge_epoch).unwrap_or(false);
        // 新文档(新桥代次)：旧文档的在飞请求作废
        let cancelled = if same_epoch { Vec::new() } else { inner.fail_pending_for(label, None, "window_reloaded") };
        inner.windows.insert(label.to_string(), reg);
        cancelled
    }

    fn update_window(&self, label: &str, bridge_epoch: &str, authed: bool, mode: Option<String>) -> Vec<(String, String)> {
        let mut inner = lock(self);
        let mut cancelled = Vec::new();
        match inner.windows.get_mut(label) {
            Some(w) if w.bridge_epoch == bridge_epoch => {
                w.authed = authed;
                if let Some(m) = mode {
                    w.mode = m;
                }
                if !authed {
                    cancelled = inner.fail_pending_for(label, Some(bridge_epoch), "window_locked");
                }
            }
            // 旧文档迟到的状态更新：忽略，不动新文档
            _ => {}
        }
        cancelled
    }

    // 只认当前文档的注销；迟到的旧 pagehide 不能注销新文档
    fn unregister_window(&self, label: &str, bridge_epoch: &str) -> Vec<(String, String)> {
        let mut inner = lock(self);
        if inner.windows.get(label).map(|w| w.bridge_epoch == bridge_epoch).unwrap_or(false) {
            inner.windows.remove(label);
        }
        inner.fail_pending_for(label, Some(bridge_epoch), "window_reloaded")
    }

    // 窗口销毁：登记与在飞请求一并作废
    fn release_window(&self, label: &str) -> Vec<(String, String)> {
        let mut inner = lock(self);
        inner.windows.remove(label);
        inner.fail_pending_for(label, None, "window_reloaded")
    }

    pub fn window_epoch(&self, label: &str) -> Option<String> {
        lock(self).windows.get(label).map(|w| w.bridge_epoch.clone())
    }

    pub(crate) fn list_windows(&self) -> Value {
        let inner = lock(self);
        let mut windows: Vec<Value> = inner
            .windows
            .iter()
            .map(|(label, w)| {
                let lanes = if w.mode == "dual" { json!(["A", "B"]) } else { json!(["S"]) };
                // 不返回窗口标题：标题里带设备名/别名，未登录的窗口不该把设备身份透给调用方
                json!({
                    "window": label,
                    "mode": w.mode,
                    "lanes": lanes,
                    "authed": w.authed,
                    "appVersion": w.app_version,
                })
            })
            .collect();
        windows.sort_by(|a, b| a["window"].as_str().unwrap_or("").cmp(b["window"].as_str().unwrap_or("")));
        json!({ "windows": windows })
    }

    // 登记一次工具调用；失败是「调用方/状态」类错误，直接返回领域错误
    pub(crate) fn begin(
        &self,
        label: &str,
        tool: &str,
        timeout: Duration,
    ) -> Result<(String, oneshot::Receiver<(bool, Value)>), BridgeError> {
        let mut inner = lock(self);
        if inner.running.is_none() {
            return Err(BridgeError::new("service_not_running", "本地 MCP 服务未运行"));
        }
        let Some(reg) = inner.windows.get(label) else {
            return Err(BridgeError::new("unknown_window", format!("窗口 {label} 未注册(可能已关闭或尚未加载完成)")));
        };
        if !reg.authed {
            return Err(BridgeError::new("window_locked", format!("窗口 {label} 未登录，MCP 不代登录")));
        }
        let bridge_epoch = reg.bridge_epoch.clone();
        if inner.pending.len() >= MAX_PENDING_TOTAL
            || inner.pending.values().filter(|p| p.label == label).count() >= MAX_PENDING_PER_WINDOW
        {
            return Err(BridgeError::new("bridge_busy", "该窗口的 MCP 请求过多，请稍后重试"));
        }
        inner.seq += 1;
        let id = format!("r{}-{}", inner.epoch, inner.seq);
        let epoch = inner.epoch;
        let (tx, rx) = oneshot::channel();
        inner.pending.insert(
            id.clone(),
            Pending {
                label: label.to_string(),
                bridge_epoch,
                epoch,
                deadline: Instant::now() + timeout,
                committed: false,
                tx: Some(tx),
            },
        );
        let _ = tool;
        Ok((id, rx))
    }

    // 页面在真正执行前调用：必须仍存活、仍是同一个窗口/桥代次、已登录、未冻结，且只能 commit 一次。
    // 身份不符(别的窗口 / 旧文档)一律拒绝且不动这条请求：只有请求的主人能推进它。
    pub(crate) fn commit(&self, label: &str, id: &str, bridge_epoch: &str) -> Result<(), BridgeError> {
        let mut inner = lock(self);
        let (owned, committed, expired, running) = {
            let Some(p) = inner.pending.get(id) else {
                return Err(BridgeError::new("request_expired", "请求已超时或被取消，未执行"));
            };
            (
                p.label == label && p.bridge_epoch == bridge_epoch && p.epoch == inner.epoch,
                p.committed,
                Instant::now() > p.deadline,
                inner.running.is_some(),
            )
        };
        if !owned {
            return Err(BridgeError::new("request_expired", "该请求不属于此窗口，未执行"));
        }
        if committed {
            return Err(BridgeError::new("already_committed", "该请求已提交执行，不能重复提交"));
        }
        let reg = inner.windows.get(label).map(|w| (w.bridge_epoch == bridge_epoch, w.authed)).unwrap_or((false, false));
        if expired || !running || !reg.0 || !reg.1 {
            let code = if expired {
                "request_expired"
            } else if !running {
                "service_stopped"
            } else {
                "window_locked"
            };
            finish_with_terminal(&mut inner, id, code, false);
            return Err(BridgeError::new(code, "请求所属窗口或服务已变化，未执行"));
        }
        if let Some(p) = inner.pending.get_mut(id) {
            p.committed = true;
        }
        Ok(())
    }

    pub(crate) fn complete(&self, label: &str, id: &str, bridge_epoch: &str, ok: bool, result: Value) -> bool {
        let mut inner = lock(self);
        let (owned, expired, committed) = {
            let Some(p) = inner.pending.get(id) else { return false };
            (
                p.label == label && p.bridge_epoch == bridge_epoch && p.epoch == inner.epoch,
                Instant::now() > p.deadline,
                p.committed,
            )
        };
        // 迟到的旧文档 / 别的窗口：丢弃回执，但绝不动这条请求(它的主人还能继续)
        if !owned {
            return false;
        }
        let reg_ok = inner.windows.get(label).map(|w| w.bridge_epoch == bridge_epoch).unwrap_or(false);
        if !reg_ok {
            return false;
        }
        if expired {
            finish_with_terminal(&mut inner, id, "request_expired", committed);
            return false;
        }
        let Some(mut p) = inner.pending.remove(id) else { return false };
        if let Some(tx) = p.tx.take() {
            let _ = tx.send((ok, result));
        }
        true
    }

    pub(crate) fn expire(&self, id: &str) -> Option<bool> {
        let mut inner = lock(self);
        inner.pending.remove(id).map(|p| p.committed)
    }

    fn drain_pending(&self, code: &str) -> Vec<(String, String)> {
        let mut inner = lock(self);
        inner.epoch += 1;
        inner.fail_pending(code)
    }
}

// ---------- 服务生命周期 ----------

fn emit_service(app: &AppHandle, state: &McpState) {
    let _ = app.emit(SERVICE_EVENT, state.status());
}

async fn start_service(app: &AppHandle, state: &McpState) -> Result<u16, String> {
    {
        let mut inner = lock(state);
        if let Some(r) = &inner.running {
            return Ok(r.port);
        }
        if inner.starting {
            return Err("MCP 服务正在启动".to_string());
        }
        if inner.settings.token.is_empty() {
            let token = settings::new_token();
            if token.is_empty() {
                return Err("无法生成安全令牌(系统熵源不可用)".to_string());
            }
            inner.settings.token = token;
            let token_arc = inner.token.clone();
            let token_value = inner.settings.token.clone();
            let _ = token_arc.write().map(|mut t| *t = token_value);
            settings::save(app, &inner.settings)?;
        }
        inner.starting = true;
    }
    let (port, token_arc, generation) = {
        let inner = lock(state);
        (inner.settings.port, inner.token.clone(), inner.start_generation)
    };
    let bridge: Arc<dyn WindowBridge> = Arc::new(bridge::TauriBridge::new(app.clone()));
    let started = http::start(app.clone(), state.clone(), bridge, port, AuthState::new(token_arc)).await;
    let mut inner = lock(state);
    inner.starting = false;
    // 绑定期间被停止 / 改端口 / 换令牌：这次启动作废，不装进状态
    if inner.start_generation != generation {
        drop(inner);
        if let Ok(running) = started {
            running.stop();
        }
        return Err("MCP 服务启动被取消".to_string());
    }
    match started {
        Ok(running) => {
            inner.running = Some(running);
            inner.start_on_ready = false;
            inner.last_error = None;
            inner.epoch += 1;
            Ok(port)
        }
        Err(e) => {
            inner.last_error = Some(e.clone());
            Err(e)
        }
    }
}

fn stop_service(state: &McpState) -> Vec<(String, String)> {
    let (running, cancelled) = {
        let mut inner = lock(state);
        inner.epoch += 1;
        inner.start_generation += 1;
        inner.start_on_ready = false;
        let cancelled = inner.fail_pending("service_stopped");
        (inner.running.take(), cancelled)
    };
    if let Some(r) = running {
        r.stop();
    }
    cancelled
}

// 应用更新冻结：作废全部在飞请求并给出终态，页面在下一次 await 边界停下；监听保持，工具调用返回 update_preparing
pub fn quiesce(app: &AppHandle, state: &McpState) {
    let cancelled = state.drain_pending("update_preparing");
    emit_cancels(app, cancelled, "app_busy");
}

pub fn release_window(app: &AppHandle, state: &McpState, label: &str) {
    let cancelled = state.release_window(label);
    emit_cancels(app, cancelled, "window_closed");
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub fn mcp_status(state: State<'_, McpState>) -> Value {
    state.status()
}

#[tauri::command]
pub async fn mcp_enable(app: AppHandle, state: State<'_, McpState>, port: Option<u16>) -> Result<Value, String> {
    let _guard = state.lifecycle.lock().await;
    if let Some(p) = port {
        if !settings::valid_port(p) {
            return Err(format!("端口必须在 {} 到 65535 之间", settings::MIN_PORT));
        }
        let mut inner = lock(&state);
        if inner.running.is_some() {
            return Err("服务正在运行，请先停止再改端口".to_string());
        }
        inner.settings.port = p;
        settings::save(&app, &inner.settings)?;
    }
    {
        let mut inner = lock(&state);
        inner.settings.enabled = true;
        inner.start_on_ready = true;
        settings::save(&app, &inner.settings)?;
    }
    // 只有已登录的桌面窗口注册过才真正开始监听(登录遮罩未通过时保持等待)
    if state.authed_window_count() > 0 {
        if let Err(e) = start_service(&app, &state).await {
            emit_service(&app, &state);
            return Err(e);
        }
    }
    let status = state.status();
    emit_service(&app, &state);
    Ok(status)
}

#[tauri::command]
pub async fn mcp_disable(app: AppHandle, state: State<'_, McpState>) -> Result<Value, String> {
    let _guard = state.lifecycle.lock().await;
    let cancelled = stop_service(&state);
    {
        let mut inner = lock(&state);
        inner.settings.enabled = false;
        inner.last_error = None;
        settings::save(&app, &inner.settings)?;
    }
    emit_cancels(&app, cancelled, "service_stopped");
    let status = state.status();
    emit_service(&app, &state);
    Ok(status)
}

#[tauri::command]
pub fn mcp_reveal_token(state: State<'_, McpState>) -> Result<String, String> {
    let token = state.token();
    if token.is_empty() {
        return Err("尚未生成令牌".to_string());
    }
    Ok(token)
}

#[tauri::command]
pub async fn mcp_regenerate_token(app: AppHandle, state: State<'_, McpState>) -> Result<Value, String> {
    let _guard = state.lifecycle.lock().await;
    let token = settings::new_token();
    if token.is_empty() {
        return Err("无法生成安全令牌(系统熵源不可用)".to_string());
    }
    // 旧令牌下已登记的在飞请求一并作废：换令牌后不允许旧授权继续执行
    let cancelled = state.drain_pending("token_rotated");
    {
        let mut inner = lock(&state);
        inner.settings.token = token.clone();
        let token_arc = inner.token.clone();
        {
            if let Ok(mut t) = token_arc.write() {
                *t = token;
            }
        }
        settings::save(&app, &inner.settings)?;
    }
    emit_cancels(&app, cancelled, "token_rotated");
    emit_service(&app, &state);
    Ok(state.status())
}

#[tauri::command]
pub async fn mcp_register(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, McpState>,
    bridge_epoch: String,
    authed: bool,
    mode: String,
    app_version: String,
) -> Result<Value, String> {
    if bridge_epoch.is_empty() || bridge_epoch.len() > 64 || mode.len() > 16 || app_version.len() > 32 {
        return Err("窗口注册信息无效".to_string());
    }
    if mode != "single" && mode != "dual" {
        return Err("窗口模式无效".to_string());
    }
    let label = webview.label().to_string();
    let cancelled = state.register_window(
        &label,
        WindowReg { bridge_epoch, authed, mode, app_version },
    );
    emit_cancels(&app, cancelled, "window_reloaded");
    if authed && state.authed_window_count() > 0 {
        let should_start = {
            let inner = lock(&state);
            inner.settings.enabled && inner.running.is_none()
        };
        if should_start {
            let _guard = state.lifecycle.lock().await;
            let still_needed = {
                let inner = lock(&state);
                inner.settings.enabled && inner.running.is_none()
            };
            if still_needed {
                let _ = start_service(&app, &state).await;
                emit_service(&app, &state);
            }
        }
    }
    Ok(state.status())
}

// 模式切换 / 登录态变化：只更新已注册窗口的记录，不重新登记(桥代次不变)
#[tauri::command]
pub fn mcp_window_state(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, McpState>,
    bridge_epoch: String,
    authed: bool,
    mode: Option<String>,
) -> Result<(), String> {
    if let Some(m) = &mode {
        if m != "single" && m != "dual" {
            return Err("窗口模式无效".to_string());
        }
    }
    let cancelled = state.update_window(webview.label(), &bridge_epoch, authed, mode);
    emit_cancels(&app, cancelled, "window_locked");
    Ok(())
}

#[tauri::command]
pub fn mcp_unregister(app: AppHandle, webview: tauri::Webview, state: State<'_, McpState>, bridge_epoch: String) {
    let cancelled = state.unregister_window(webview.label(), &bridge_epoch);
    emit_cancels(&app, cancelled, "window_reloaded");
}

#[tauri::command]
pub fn mcp_commit(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, McpState>,
    id: String,
    bridge_epoch: String,
) -> Value {
    if crate::updater::frozen(&app) {
        return json!({ "ok": false, "code": "update_preparing" });
    }
    match state.commit(webview.label(), &id, &bridge_epoch) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "code": e.code }),
    }
}

#[tauri::command]
pub fn mcp_reply(
    webview: tauri::Webview,
    state: State<'_, McpState>,
    id: String,
    bridge_epoch: String,
    ok: bool,
    result: Value,
) -> Result<(), String> {
    if serde_json::to_vec(&result).map(|v| v.len()).unwrap_or(usize::MAX) > MAX_REPLY_BYTES {
        return Err("回执过大".to_string());
    }
    // 迟到 / 越权 / 过期的回执一律丢弃(不报错给页面)
    let _ = state.complete(webview.label(), &id, &bridge_epoch, ok, result);
    Ok(())
}

#[cfg(test)]
impl McpState {
    pub fn register_window_for_test(&self, label: &str, reg: WindowReg) {
        let _ = self.register_window(label, reg);
    }
    pub fn mark_running_for_test(&self, port: u16) {
        let shutdown = tokio_util::sync::CancellationToken::new();
        let task = tauri::async_runtime::spawn(async {});
        lock(self).running = Some(Running::new(port, shutdown, task));
    }
    pub fn pending_count_for_test(&self) -> usize {
        lock(self).pending.len()
    }
    pub fn set_authed_for_test(&self, label: &str, authed: bool) {
        if let Some(w) = lock(self).windows.get_mut(label) {
            w.authed = authed;
        }
    }
    pub fn epoch_for_test(&self) -> u64 {
        lock(self).epoch
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    fn state_with(epoch: &str) -> McpState {
        let s = McpState::default();
        s.mark_running_for_test(38991);
        s.register_window_for_test(
            "main",
            WindowReg { bridge_epoch: epoch.into(), authed: true, mode: "single".into(), app_version: "t".into() },
        );
        s
    }

    fn other_window(s: &McpState) {
        s.register_window_for_test(
            "main-2",
            WindowReg { bridge_epoch: "e2".into(), authed: true, mode: "single".into(), app_version: "t".into() },
        );
    }

    #[tokio::test]
    async fn begin_requires_registered_authed_window() {
        let s = state_with("e1");
        assert!(s.begin("nope", "serial_state", READ_TIMEOUT).is_err());
        s.set_authed_for_test("main", false);
        let err = s.begin("main", "serial_state", READ_TIMEOUT).unwrap_err();
        assert_eq!(err.code, "window_locked");
        s.set_authed_for_test("main", true);
        assert!(s.begin("main", "serial_state", READ_TIMEOUT).is_ok());
    }

    // 别的窗口提交/回执：拒绝但绝不能删掉合法请求
    #[tokio::test]
    async fn wrong_window_commit_and_reply_do_not_touch_the_request() {
        let s = state_with("e1");
        other_window(&s);
        let (id, mut rx) = s.begin("main", "serial_write", TOOL_TIMEOUT).unwrap();

        assert_eq!(s.commit("main-2", &id, "e1").unwrap_err().code, "request_expired");
        assert_eq!(s.pending_count_for_test(), 1);
        assert!(!s.complete("main-2", &id, "e1", true, json!({ "stolen": true })));

        // 原请求仍然可以正常推进
        assert!(s.commit("main", &id, "e1").is_ok());
        assert!(s.complete("main", &id, "e1", true, json!({ "ok": true })));
        let (ok, value) = rx.try_recv().unwrap();
        assert!(ok);
        assert_eq!(value["ok"], json!(true));
    }

    // 旧文档(旧 bridgeEpoch)的回执被忽略，请求仍由新文档完成
    #[tokio::test]
    async fn stale_epoch_reply_is_ignored() {
        let s = state_with("e1");
        let (id, _rx) = s.begin("main", "serial_state", TOOL_TIMEOUT).unwrap();
        // 新文档注册：旧请求作废(终态回执)，随后旧回执不再影响任何东西
        s.register_window_for_test(
            "main",
            WindowReg { bridge_epoch: "e9".into(), authed: true, mode: "single".into(), app_version: "t".into() },
        );
        assert_eq!(s.pending_count_for_test(), 0);
        assert!(!s.complete("main", &id, "e1", true, json!({})));
        assert_eq!(s.commit("main", &id, "e1").unwrap_err().code, "request_expired");
    }

    // 迟到的旧 pagehide 不能注销新文档
    #[tokio::test]
    async fn stale_unregister_keeps_new_document() {
        let s = state_with("e1");
        s.register_window_for_test(
            "main",
            WindowReg { bridge_epoch: "e2".into(), authed: true, mode: "single".into(), app_version: "t".into() },
        );
        let (id, _rx) = s.begin("main", "serial_state", TOOL_TIMEOUT).unwrap();
        s.unregister_window("main", "e1");
        assert_eq!(s.window_epoch("main").as_deref(), Some("e2"));
        assert_eq!(s.pending_count_for_test(), 1);
        assert!(s.commit("main", &id, "e2").is_ok());
    }

    #[tokio::test]
    async fn commit_is_single_use() {
        let s = state_with("e1");
        let (id, _rx) = s.begin("main", "blu_set_power", TOOL_TIMEOUT).unwrap();
        assert!(s.commit("main", &id, "e1").is_ok());
        assert_eq!(s.commit("main", &id, "e1").unwrap_err().code, "already_committed");
    }

    #[tokio::test]
    async fn expired_request_is_reported_with_terminal_result() {
        let s = state_with("e1");
        let (id, mut rx) = s.begin("main", "serial_write", Duration::from_millis(1)).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(s.commit("main", &id, "e1").unwrap_err().code, "request_expired");
        let (ok, value) = rx.try_recv().unwrap();
        assert!(!ok);
        assert_eq!(value["code"], json!("request_expired"));
        assert_eq!(value["executed"], json!(false));
        assert_eq!(s.pending_count_for_test(), 0);
    }

    // 停止服务：未提交 → 未执行；已提交 → 结果未知(不谎称未执行)
    #[tokio::test]
    async fn stop_reports_terminal_state_preserving_commit() {
        let s = state_with("e1");
        let (a, mut ra) = s.begin("main", "serial_write", TOOL_TIMEOUT).unwrap();
        let (b, mut rb) = s.begin("main", "serial_open", TOOL_TIMEOUT).unwrap();
        assert!(s.commit("main", &b, "e1").is_ok());
        let cancelled = s.drain_pending("service_stopped");
        assert_eq!(cancelled.len(), 2);
        let (_, va) = ra.try_recv().unwrap();
        let (_, vb) = rb.try_recv().unwrap();
        assert_eq!(va["code"], json!("service_stopped"));
        assert_eq!(va["executed"], json!(false));
        assert_eq!(vb["executed"], json!("unknown"));
        assert_eq!(s.pending_count_for_test(), 0);
        let _ = a;
    }

    #[tokio::test]
    async fn token_rotation_invalidates_queued_requests() {
        let s = state_with("e1");
        let (id, mut rx) = s.begin("main", "serial_write", TOOL_TIMEOUT).unwrap();
        let epoch_before = s.epoch_for_test();
        s.drain_pending("token_rotated");
        assert!(s.epoch_for_test() > epoch_before);
        let (_, value) = rx.try_recv().unwrap();
        assert_eq!(value["code"], json!("token_rotated"));
        assert_eq!(s.commit("main", &id, "e1").unwrap_err().code, "request_expired");
    }

    #[tokio::test]
    async fn pending_is_capped_per_window() {
        let s = state_with("e1");
        for _ in 0..MAX_PENDING_PER_WINDOW {
            assert!(s.begin("main", "serial_read", READ_TIMEOUT).is_ok());
        }
        assert_eq!(s.begin("main", "serial_read", READ_TIMEOUT).unwrap_err().code, "bridge_busy");
    }
}
