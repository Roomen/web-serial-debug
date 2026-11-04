// Rust ↔ 页面桥：请求以事件投递到「确切的那个窗口」，页面用命令回执；所有投递都带 bridgeEpoch，
// 迟到的回执(窗口刷新、禁用、超时)一律丢弃。
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub const REQUEST_EVENT: &str = "mcp-request";
pub const CANCEL_EVENT: &str = "mcp-cancel";
pub const SERVICE_EVENT: &str = "mcp-service";

pub trait WindowBridge: Send + Sync + 'static {
    fn send_request(&self, label: &str, payload: Value) -> Result<(), String>;
    fn send_cancel(&self, label: &str, payload: Value) -> Result<(), String>;
}

pub struct TauriBridge {
    app: AppHandle,
}

impl TauriBridge {
    pub fn new(app: AppHandle) -> Self {
        TauriBridge { app }
    }
}

impl WindowBridge for TauriBridge {
    fn send_request(&self, label: &str, payload: Value) -> Result<(), String> {
        self.app.emit_to(label, REQUEST_EVENT, payload).map_err(|e| format!("无法投递到窗口 {label}：{e}"))
    }
    fn send_cancel(&self, label: &str, payload: Value) -> Result<(), String> {
        self.app.emit_to(label, CANCEL_EVENT, payload).map_err(|e| format!("无法投递到窗口 {label}：{e}"))
    }
}

// 领域错误：作为工具级错误(isError)返回，带稳定的 code，让 agent 能区分「没执行」与「执行了但不知道结果」
#[derive(Debug, Clone)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
    pub executed: Option<Value>,
}

impl BridgeError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        BridgeError { code: code.to_string(), message: message.into(), executed: None }
    }
    // 页面回执的错误体：{ code, message, executed? }
    pub fn from_page_result(value: &Value) -> Self {
        let code = value.get("code").and_then(|v| v.as_str()).unwrap_or("operation_failed");
        let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("操作失败");
        let mut e = BridgeError::new(code, message);
        if let Some(v) = value.get("executed") {
            e.executed = Some(v.clone());
        }
        e
    }
}

#[cfg(test)]
pub mod mock {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;

    use crate::mcp::McpState;

    // 测试用桥：模拟页面的「排队 → commit → 执行 → reply」序列，不碰任何真实设备
    pub struct MockBridge {
        pub state: McpState,
        pub script: Arc<dyn Fn(&str, &Value) -> (bool, Value) + Send + Sync>,
        pub commit: bool,
        pub delay: Duration,
    }

    impl MockBridge {
        pub fn new(state: McpState, commit: bool, script: Arc<dyn Fn(&str, &Value) -> (bool, Value) + Send + Sync>) -> Self {
            MockBridge { state, script, commit, delay: Duration::from_millis(0) }
        }
    }

    impl WindowBridge for MockBridge {
        fn send_request(&self, label: &str, payload: Value) -> Result<(), String> {
            let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let tool = payload.get("tool").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let params = payload.get("params").cloned().unwrap_or_else(|| json!({}));
            let state = self.state.clone();
            let script = self.script.clone();
            let label = label.to_string();
            let do_commit = self.commit;
            let delay = self.delay;
            tokio::spawn(async move {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let epoch = state.window_epoch(&label).unwrap_or_default();
                if do_commit {
                    let _ = state.commit(&label, &id, &epoch);
                }
                let (ok, result) = script(&tool, &params);
                state.complete(&label, &id, &epoch, ok, result);
            });
            Ok(())
        }

        fn send_cancel(&self, _label: &str, _payload: Value) -> Result<(), String> {
            Ok(())
        }
    }
}
