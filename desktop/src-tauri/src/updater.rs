// 原生应用升级。更新对象只存于 Rust，不接受页面提供的 URL / 签名。
use std::{collections::HashMap, sync::{Condvar, Mutex}, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
struct Inner {
    busy: bool,
    frozen: bool,
    operation: u64,
    device_operations: usize,
    update: Option<Update>,
    acknowledgments: HashMap<String, Option<bool>>,
    sessions: HashMap<String, HashMap<String, String>>,
}
#[derive(Default)]
pub struct UpdateState { inner: Mutex<Inner>, changed: Condvar }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo { version: String, current_version: String, body: Option<String> }

pub fn frozen(app: &AppHandle) -> bool {
    app.state::<UpdateState>().inner.lock().unwrap().frozen
}

// 把已经开始的原生操作纳入准备屏障。检查冻结与增加计数必须在同一把锁里，
// 否则 open 在冻结检查后暂停，所有窗口确认后才登记句柄，就会逃过最终释放。
pub struct DeviceOperation(AppHandle);
pub fn begin_device_operation(app: &AppHandle) -> Result<DeviceOperation, String> {
    let state = app.state::<UpdateState>();
    let mut inner = state.inner.lock().unwrap();
    if inner.frozen { return Err("应用正在准备升级".into()); }
    inner.device_operations += 1;
    Ok(DeviceOperation(app.clone()))
}
impl Drop for DeviceOperation {
    fn drop(&mut self) {
        let state = self.0.state::<UpdateState>();
        let mut inner = state.inner.lock().unwrap();
        inner.device_operations -= 1;
        state.changed.notify_all();
    }
}

// 与准备阶段使用同一把锁，避免窗口恰在快照之后创建。
pub fn with_window_creation<T>(app: &AppHandle, create: impl FnOnce() -> tauri::Result<T>) -> tauri::Result<T> {
    let state = app.state::<UpdateState>();
    let inner = state.inner.lock().unwrap();
    if inner.frozen { return Err(std::io::Error::other("应用正在准备升级").into()); }
    create()
}

fn progress(app: &AppHandle, id: u64, state: &str, downloaded: u64, total: Option<u64>) {
    let _ = app.emit("app-update-progress", serde_json::json!({
        "operationId": id, "state": state, "downloaded": downloaded, "total": total
    }));
}
fn configured(app: &AppHandle) -> bool {
    let config = app.config().plugins.0.get("updater");
    config.and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()).is_some_and(|s| !s.trim().is_empty())
        && config.and_then(|v| v.get("endpoints")).and_then(|v| v.as_array()).is_some_and(|a| !a.is_empty())
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<UpdateInfo>, String> {
    if !configured(&app) { return Err("此版本尚未配置应用更新，请从发布页下载新版本".into()); }
    {
        let mut inner = state.inner.lock().unwrap();
        if inner.busy { return Err("应用更新正在进行，请稍后再试".into()); }
        inner.busy = true;
    }
    let result = async {
        let updater = app.updater_builder().timeout(Duration::from_secs(30)).build()
            .map_err(|_| "更新配置不可用，请从发布页下载新版本".to_string())?;
        updater.check().await.map_err(|_| "检查更新失败，请检查网络后重试".to_string())
    }.await;
    let mut inner = state.inner.lock().unwrap();
    inner.busy = false;
    match result {
        Ok(update) => {
            let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), current_version: u.current_version.clone(), body: u.body.clone() });
            inner.update = update;
            Ok(info)
        }
        Err(e) => { inner.update = None; Err(e) }
    }
}

#[tauri::command]
pub fn app_update_ack(webview: Webview, state: State<'_, UpdateState>, operation_id: u64, ready: bool, session: Option<HashMap<String, String>>) {
    let mut inner = state.inner.lock().unwrap();
    let snapshot = session.and_then(sanitize_session);
    let ready = ready && snapshot.is_some();
    if acknowledge(&mut inner, webview.label(), operation_id, ready) {
        if ready { inner.sessions.insert(webview.label().to_string(), snapshot.unwrap()); }
        state.changed.notify_all();
    }
}

fn acknowledge(inner: &mut Inner, label: &str, operation_id: u64, ready: bool) -> bool {
    if !inner.frozen || inner.operation != operation_id { return false; }
    let Some(ack) = inner.acknowledgments.get_mut(label) else { return false; };
    // 每个窗口只能回应一次，忙碌回应不能随后被覆盖。
    if ack.is_some() { return false; }
    *ack = Some(ready);
    true
}

fn wait_ready(app: &AppHandle, id: u64) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut inner = state.inner.lock().unwrap();
    loop {
        if inner.operation != id || inner.acknowledgments.values().any(|v| *v == Some(false)) {
            return Err("有窗口正在执行任务，请结束任务后再安装更新".into());
        }
        if ready_to_install(&inner) { return Ok(()); }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err("有窗口未能完成升级准备，请稍后重试".into()); }
        inner = state.changed.wait_timeout(inner, remaining).unwrap().0;
    }
}

fn ready_to_install(inner: &Inner) -> bool {
    inner.device_operations == 0 && inner.acknowledgments.values().all(|v| *v == Some(true))
}

const SESSION_LIMIT: usize = 25 * 1024 * 1024;
const HANDOFF_LIMIT: u64 = 100 * 1024 * 1024;
const SESSION_KEYS: &[&str] = &[
    "appInstanceId", "serialHubMode", "serialActiveSendId", "serialSessionLabelA", "serialSessionLabelB",
    "serialLogCache", "serialWantOpen", "serialWantOpenS", "serialWantOpenA", "serialWantOpenB",
    "serialWantPortKeyA", "serialWantPortKeyS", "serialWantPortKeyDualA", "serialWantPortKeyB",
];
fn sanitize_session(session: HashMap<String, String>) -> Option<HashMap<String, String>> {
    if session.len() > 64 { return None; }
    let filtered: HashMap<_, _> = session.into_iter().filter(|(k, _)| SESSION_KEYS.contains(&k.as_str())).collect();
    let size: usize = filtered.iter().map(|(k, v)| k.len().saturating_add(v.len())).sum();
    (size <= SESSION_LIMIT).then_some(filtered)
}

#[derive(Serialize, Deserialize)]
pub struct SessionHandoff {
    version: u8,
    pub windows: HashMap<String, HashMap<String, String>>,
}
fn handoff_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join("update-session.json"))
}
pub fn read_handoff(app: &AppHandle) -> Option<SessionHandoff> {
    let path = handoff_path(app)?;
    if std::fs::metadata(&path).ok()?.len() > HANDOFF_LIMIT { return None; }
    let mut handoff: SessionHandoff = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if handoff.version != 1 || handoff.windows.is_empty() || handoff.windows.len() > 64 { return None; }
    for (label, session) in &mut handoff.windows {
        if label != "main" && !label.strip_prefix("main-").is_some_and(|n| n.parse::<u32>().is_ok_and(|n| n >= 2)) { return None; }
        *session = sanitize_session(std::mem::take(session))?;
    }
    Some(handoff)
}
pub fn remove_handoff(app: &AppHandle) {
    if let Some(path) = handoff_path(app) {
        let _ = std::fs::remove_file(path.with_extension("tmp"));
        let _ = std::fs::remove_file(path);
    }
}
pub fn session_script(session: &HashMap<String, String>) -> String {
    let json = serde_json::to_string(session).unwrap_or_else(|_| "{}".into())
        .replace('<', "\\u003c").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    let keys = serde_json::to_string(SESSION_KEYS).unwrap();
    format!("(()=>{{const s={json};for(const k of {keys}){{try{{sessionStorage.removeItem(k)}}catch(_){{}}}}for(const [k,v] of Object.entries(s)){{try{{sessionStorage.setItem(k,v)}}catch(_){{}}}}}})();")
}
fn save_handoff(app: &AppHandle, state: &UpdateState) -> Result<(), String> {
    use std::io::Write;
    let windows = state.inner.lock().unwrap().sessions.clone();
    let bytes = serde_json::to_vec(&SessionHandoff { version: 1, windows })
        .map_err(|_| "无法保存升级会话".to_string())?;
    if bytes.len() as u64 > HANDOFF_LIMIT { return Err("会话过大，暂不能安装更新".into()); }
    let path = handoff_path(app).ok_or_else(|| "无法保存升级会话".to_string())?;
    let result = (|| -> std::io::Result<()> {
        let dir = path.parent().unwrap();
        std::fs::create_dir_all(dir)?;
        let temp = path.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if path.exists() { std::fs::remove_file(&path)?; }
        std::fs::rename(temp, path)?;
        Ok(())
    })();
    result.map_err(|_| "无法保存升级会话，请确认应用数据目录可写".to_string())
}

#[tauri::command]
pub async fn app_update_install(app: AppHandle, state: State<'_, UpdateState>, version: String) -> Result<(), String> {
    let (update, id) = {
        let mut inner = state.inner.lock().unwrap();
        if inner.busy { return Err("应用更新正在进行，请稍后再试".into()); }
        let update = inner.update.clone().filter(|u| u.version == version)
            .ok_or_else(|| "更新信息已变化，请重新检查更新".to_string())?;
        if update.download_url.scheme() != "https" { return Err("更新下载地址无效".into()); }
        inner.busy = true;
        inner.operation += 1;
        (update, inner.operation)
    };
    let result = async {
        progress(&app, id, "downloading", 0, None);
        let mut received = 0u64;
        let bytes = update.download(|n, total| {
            received += n as u64;
            progress(&app, id, "downloading", received, total);
        }, || {}).await.map_err(|_| "更新下载或签名验证失败，请重试或从发布页下载".to_string())?;
        {
            let mut inner = state.inner.lock().unwrap();
            inner.frozen = true;
            inner.sessions.clear();
            inner.acknowledgments = app.webview_windows().into_keys().map(|label| (label, None)).collect();
        }
        progress(&app, id, "preparing", received, Some(received));
        app.emit("app-update-prepare", serde_json::json!({ "operationId": id }))
            .map_err(|_| "无法通知窗口准备升级".to_string())?;
        let ready_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || wait_ready(&ready_app, id)).await
            .map_err(|_| "升级准备失败".to_string())??;
        save_handoff(&app, &state)?;
        // 前端已保存日志、停止任务并关闭流；再收回窗口可能残留的原生句柄。
        for label in app.webview_windows().into_keys() {
            crate::serial::release_owner(&app.state::<crate::serial::SerialState>(), &label);
        }
        progress(&app, id, "installing", received, Some(received));
        tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await
            .map_err(|_| "安装更新失败，请重试".to_string())?
            .map_err(|_| "安装更新失败，请重试或从发布页下载".to_string())?;
        Ok(())
    }.await;
    if result.is_ok() {
        let _ = app.emit("app-update-finished", serde_json::json!({ "operationId": id, "success": true }));
        app.restart();
    }
    {
        let mut inner = state.inner.lock().unwrap();
        inner.busy = false;
        inner.frozen = false;
        inner.acknowledgments.clear();
        inner.sessions.clear();
    }
    remove_handoff(&app);
    let _ = app.emit("app-update-finished", serde_json::json!({ "operationId": id, "success": false }));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> Inner {
        Inner { frozen: true, operation: 2,
            acknowledgments: HashMap::from([("main".into(), None), ("main-2".into(), None)]),
            ..Inner::default() }
    }

    #[test]
    fn stale_or_unexpected_windows_cannot_acknowledge() {
        let mut inner = pending();
        assert!(!acknowledge(&mut inner, "main", 1, true));
        assert!(!acknowledge(&mut inner, "main-3", 2, true));
        assert!(inner.acknowledgments.values().all(Option::is_none));
        inner.frozen = false;
        assert!(!acknowledge(&mut inner, "main", 2, true));
    }

    #[test]
    fn busy_window_cannot_replace_rejection_with_ready() {
        let mut inner = pending();
        assert!(acknowledge(&mut inner, "main", 2, false));
        assert!(!acknowledge(&mut inner, "main", 2, true));
        assert_eq!(inner.acknowledgments["main"], Some(false));
        assert_eq!(inner.acknowledgments["main-2"], None);
    }

    #[test]
    fn in_flight_device_operation_keeps_installation_blocked_after_all_acknowledgments() {
        let mut inner = pending();
        assert!(acknowledge(&mut inner, "main", 2, true));
        assert!(!ready_to_install(&inner));
        assert!(acknowledge(&mut inner, "main-2", 2, true));
        inner.device_operations = 1;
        assert!(!ready_to_install(&inner));
        inner.device_operations = 0;
        assert!(ready_to_install(&inner));
    }

    #[test]
    fn session_handoff_only_keeps_allowed_runtime_keys_and_checks_size() {
        let input = HashMap::from([("serialHubMode".into(), "dual".into()), ("unrelated".into(), "discard".into())]);
        let saved = sanitize_session(input).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved["serialHubMode"], "dual");
        assert!(sanitize_session(HashMap::from([("serialLogCache".into(), "x".repeat(SESSION_LIMIT))])).is_none());
    }

    #[test]
    fn initialization_script_serializes_session_values_as_data() {
        let value = "</script>\u{2028}'\\\"";
        let script = session_script(&HashMap::from([("serialLogCache".into(), value.into())]));
        assert!(!script.contains("</script>"));
        assert!(!script.contains('\u{2028}'));
        assert!(script.contains("\\u003c/script>"));
    }
}
