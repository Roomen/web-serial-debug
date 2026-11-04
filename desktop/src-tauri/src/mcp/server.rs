// MCP 工具层：只有参数校验 + 把调用转给目标窗口的页面桥。设备逻辑全部在 js/mcp-bridge.js 里复用页面既有路径。
use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig};
use schemars::JsonSchema;
use rmcp::{tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use super::bridge::{BridgeError, WindowBridge};
use super::{McpState, READ_TIMEOUT, TOOL_TIMEOUT, VOLTAGE_MAX_MV, VOLTAGE_MIN_MV};

// 单次读 / 写的业务上限，和页面侧 mcp-ring.js 保持一致
const MAX_READ_BYTES: u32 = 65536;
const MAX_READ_TIMEOUT_MS: u32 = 30000;
const MAX_WRITE_HEX_CHARS: usize = 2 * 16384 + 16384;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WindowParams {
    /// Window label from windows_list (e.g. "main"). Never implicit: pass the exact window.
    pub window: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaneParams {
    /// Window label from windows_list.
    pub window: String,
    /// Lane: "S" in single mode, "A" or "B" in dual mode.
    pub lane: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WriteParams {
    /// Window label from windows_list.
    pub window: String,
    /// Lane: "S", "A" or "B" (must be the lane visible in the current mode).
    pub lane: String,
    /// Payload: hex digits (whitespace allowed) when encoding=hex, otherwise UTF-8 text.
    pub data: String,
    /// "hex" (default) or "text".
    pub encoding: Option<String>,
    /// Append CRLF after the payload (default false; the app's own CRLF preference is not used).
    pub append_crlf: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadParams {
    /// Window label from windows_list.
    pub window: String,
    /// Lane: "S", "A" or "B".
    pub lane: String,
    /// Opaque cursor returned by the previous read; omit to read from the oldest retained byte.
    pub cursor: Option<String>,
    /// Maximum bytes to return (1..65536, default 4096).
    pub max_bytes: Option<u32>,
    /// Wait this long for new bytes (0..30000, default 0 = return immediately).
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PowerParams {
    /// Window label from windows_list (the window that owns the BLU analyzer connection).
    pub window: String,
    /// true = DUT powered, false = DUT unpowered. Idempotent on the last commanded state.
    pub on: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoltageParams {
    /// Window label from windows_list.
    pub window: String,
    /// Source voltage in mV (500..5000). Out-of-range values are rejected, not clamped.
    pub millivolts: u32,
}

#[derive(Clone)]
pub struct McpServer {
    state: McpState,
    bridge: Arc<dyn WindowBridge>,
    app: Option<AppHandle>,
}

impl McpServer {
    pub fn new(state: McpState, bridge: Arc<dyn WindowBridge>, app: Option<AppHandle>) -> Self {
        McpServer { state, bridge, app }
    }

    fn version(&self) -> String {
        self.app.as_ref().map(|a| a.package_info().version.to_string()).unwrap_or_else(|| "dev".to_string())
    }

    fn frozen(&self) -> bool {
        self.app.as_ref().map(crate::updater::frozen).unwrap_or(false)
    }

    async fn call(&self, window: &str, tool: &str, params: Value, timeout: Duration) -> Result<Value, BridgeError> {
        if self.frozen() {
            return Err(BridgeError::new("update_preparing", "应用正在准备升级，MCP 不执行设备操作"));
        }
        let (id, rx) = self.state.begin(window, tool, timeout)?;
        let epoch = self.state.window_epoch(window).unwrap_or_default();
        let payload = json!({
            "id": id,
            "tool": tool,
            "params": params,
            "deadlineMs": timeout.as_millis() as u64,
            "epoch": epoch,
        });
        if let Err(e) = self.bridge.send_request(window, payload) {
            let _ = self.state.expire(&id);
            return Err(BridgeError::new("window_unreachable", e));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok((true, value))) => Ok(value),
            Ok(Ok((false, value))) => Err(BridgeError::from_page_result(&value)),
            Ok(Err(_)) => {
                let _ = self.state.expire(&id);
                Err(BridgeError::new("bridge_failed", "窗口没有返回结果"))
            }
            Err(_) => {
                let committed = self.state.expire(&id).unwrap_or(false);
                let _ = self.bridge.send_cancel(window, json!({ "id": id, "reason": "timeout" }));
                if committed {
                    Err(BridgeError::new(
                        "unknown_after_commit",
                        "请求已超时；该操作已在页面上开始执行，结果未知(不要重试同一操作)",
                    ))
                } else {
                    Err(BridgeError::new("expired_before_commit", "请求已超时，操作未执行"))
                }
            }
        }
    }
}

fn ok_result(value: Value) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::structured(value))
}

fn err_result(e: BridgeError) -> Result<CallToolResult, McpError> {
    let mut body = json!({ "code": e.code, "message": e.message });
    if let Some(v) = e.executed {
        body["executed"] = v;
    }
    Ok(CallToolResult::structured_error(body))
}

fn check_lane(lane: &str) -> Result<(), BridgeError> {
    if lane == "S" || lane == "A" || lane == "B" {
        Ok(())
    } else {
        Err(BridgeError::new("invalid_lane", format!("lane 必须是 S / A / B，收到 {lane}")))
    }
}

#[tool_router]
impl McpServer {
    #[tool(
        name = "windows_list",
        description = "List desktop windows that have the MCP bridge loaded, with mode (single/dual), addressable lanes and whether the window is logged in. Start here: every other tool needs an explicit window label.",
        annotations(title = "List windows", read_only_hint = true)
    )]
    async fn windows_list(&self) -> Result<CallToolResult, McpError> {
        ok_result(self.state.list_windows())
    }

    #[tool(
        name = "serial_state",
        description = "Per-lane serial state of one window: selected device (name/product/alias/VID:PID), open/opening, protocol, tx/rx byte counters, whether a protocol transaction is pinning the lane and whether the app is preparing an update. Read-only.",
        annotations(title = "Serial state", read_only_hint = true)
    )]
    async fn serial_state(&self, Parameters(p): Parameters<WindowParams>) -> Result<CallToolResult, McpError> {
        match self.call(&p.window, "serial_state", json!({ "window": p.window }), READ_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "serial_open",
        description = "Open the device already selected for that lane (no device selection here). Rejects when no device is selected, the lane is not visible in the current mode, a protocol transaction pins the lane, another task is running, or the app is preparing an update.",
        annotations(title = "Open serial lane", read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn serial_open(&self, Parameters(p): Parameters<LaneParams>) -> Result<CallToolResult, McpError> {
        if let Err(e) = check_lane(&p.lane) {
            return err_result(e);
        }
        let params = json!({ "window": p.window, "lane": p.lane });
        match self.call(&p.window, "serial_open", params, TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "serial_close",
        description = "Close the lane's serial connection. Idempotent (changed=false when already closed). Rejects while a protocol transaction pins the lane.",
        annotations(title = "Close serial lane", read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn serial_close(&self, Parameters(p): Parameters<LaneParams>) -> Result<CallToolResult, McpError> {
        if let Err(e) = check_lane(&p.lane) {
            return err_result(e);
        }
        let params = json!({ "window": p.window, "lane": p.lane });
        match self.call(&p.window, "serial_close", params, TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "serial_write",
        description = "Write raw bytes to the lane (hex or text). No CRLF unless append_crlf=true; the app's own send preferences are not applied. Success means the write completed locally, NOT that the device acknowledged it. Max 16384 bytes per call.",
        annotations(title = "Write serial lane", read_only_hint = false, destructive_hint = true)
    )]
    async fn serial_write(&self, Parameters(p): Parameters<WriteParams>) -> Result<CallToolResult, McpError> {
        if let Err(e) = check_lane(&p.lane) {
            return err_result(e);
        }
        let encoding = p.encoding.as_deref().unwrap_or("hex");
        if encoding != "hex" && encoding != "text" {
            return err_result(BridgeError::new("invalid_encoding", "encoding 必须是 hex 或 text"));
        }
        if encoding == "hex" && p.data.len() > MAX_WRITE_HEX_CHARS {
            return err_result(BridgeError::new("payload_too_large", "单次写入最多 16384 字节"));
        }
        if encoding == "text" && p.data.len() > 16384 {
            return err_result(BridgeError::new("payload_too_large", "单次写入最多 16384 字节"));
        }
        let params = json!({
            "window": p.window,
            "lane": p.lane,
            "data": p.data,
            "encoding": encoding,
            "appendCrlf": p.append_crlf.unwrap_or(false),
        });
        match self.call(&p.window, "serial_write", params, TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "serial_read",
        description = "Read received bytes for a lane from a bounded per-lane ring buffer (never the log view). Returns an opaque cursor + generation; a cursor from an older connection is rejected (invalid_cursor) so bytes from another device can never be read. dropped>0 means the ring overwrote bytes before the cursor.",
        annotations(title = "Read serial lane", read_only_hint = true)
    )]
    async fn serial_read(&self, Parameters(p): Parameters<ReadParams>) -> Result<CallToolResult, McpError> {
        if let Err(e) = check_lane(&p.lane) {
            return err_result(e);
        }
        let max_bytes = p.max_bytes.unwrap_or(4096);
        if max_bytes == 0 || max_bytes > MAX_READ_BYTES {
            return err_result(BridgeError::new("bad_params", format!("max_bytes 必须在 1..={MAX_READ_BYTES} 之间")));
        }
        let timeout_ms = p.timeout_ms.unwrap_or(0);
        if timeout_ms > MAX_READ_TIMEOUT_MS {
            return err_result(BridgeError::new("bad_params", format!("timeout_ms 必须在 0..={MAX_READ_TIMEOUT_MS} 之间")));
        }
        let params = json!({
            "window": p.window,
            "lane": p.lane,
            "cursor": p.cursor,
            "maxBytes": max_bytes,
            "timeoutMs": timeout_ms,
        });
        // 读等待可能用满 timeout_ms，留 3s 余量给桥与页面
        let timeout = Duration::from_millis(u64::from(timeout_ms)) + Duration::from_secs(3);
        match self.call(&p.window, "serial_read", params, timeout).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "blu_state",
        description = "BLU power analyzer state of one window: connected, sampling, source voltage, record mode, sample count and the DUT power state. Power state has no hardware read-back: source is \"probed\" right after connect, \"commanded\" after a successful command, \"unknown\" otherwise.",
        annotations(title = "BLU state", read_only_hint = true)
    )]
    async fn blu_state(&self, Parameters(p): Parameters<WindowParams>) -> Result<CallToolResult, McpError> {
        match self.call(&p.window, "blu_state", json!({ "window": p.window }), READ_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "blu_set_power",
        description = "Set DUT power explicitly (on=true powers up, on=false powers down). Idempotent only against the last commanded state; a probed/unknown state is never used to skip the command. Power-on writes the source voltage first and aborts if that write fails. There is no hardware acknowledgement: the result reports the commanded state.",
        annotations(title = "Set DUT power", read_only_hint = false, destructive_hint = true, idempotent_hint = true)
    )]
    async fn blu_set_power(&self, Parameters(p): Parameters<PowerParams>) -> Result<CallToolResult, McpError> {
        let params = json!({ "window": p.window, "on": p.on });
        match self.call(&p.window, "blu_set_power", params, TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "blu_set_voltage",
        description = "Set the analyzer source voltage in mV (500..5000). Out-of-range values are rejected. The device write result is checked; the result reports requested and applied values.",
        annotations(title = "Set source voltage", read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn blu_set_voltage(&self, Parameters(p): Parameters<VoltageParams>) -> Result<CallToolResult, McpError> {
        if p.millivolts < VOLTAGE_MIN_MV || p.millivolts > VOLTAGE_MAX_MV {
            return err_result(BridgeError::new(
                "out_of_range",
                format!("millivolts 必须在 {VOLTAGE_MIN_MV}..={VOLTAGE_MAX_MV} 之间，收到 {}", p.millivolts),
            ));
        }
        let params = json!({ "window": p.window, "millivolts": p.millivolts });
        match self.call(&p.window, "blu_set_voltage", params, TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "blu_capture_start",
        description = "Start a capture on the connected analyzer (requires a known source voltage). Reuses the app's existing sampler and storage; no extra sampler is created. Fails with capture_start_failed when the device command fails.",
        annotations(title = "Start capture", read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn blu_capture_start(&self, Parameters(p): Parameters<WindowParams>) -> Result<CallToolResult, McpError> {
        match self.call(&p.window, "blu_capture_start", json!({ "window": p.window }), TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "blu_capture_stop",
        description = "Stop the running capture. Reports whether the stop command was written; sampling is stopped locally even if the write fails, and the result then says the device may still be measuring.",
        annotations(title = "Stop capture", read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn blu_capture_stop(&self, Parameters(p): Parameters<WindowParams>) -> Result<CallToolResult, McpError> {
        match self.call(&p.window, "blu_capture_stop", json!({ "window": p.window }), TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "blu_capture_summary",
        description = "Statistics of the captured samples using the app's own stored per-chunk sums (no resampling): retained vs total sample counts, span seconds, current avg/min/max in uA, charge in uC and integrated energy in uWh. ready=false with a reason when nothing was captured.",
        annotations(title = "Capture summary", read_only_hint = true)
    )]
    async fn blu_capture_summary(&self, Parameters(p): Parameters<WindowParams>) -> Result<CallToolResult, McpError> {
        match self.call(&p.window, "blu_capture_summary", json!({ "window": p.window }), TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }
}

#[tool_handler(
    name = "serial-debug",
    instructions = "Local desktop Serial Debug app. Call windows_list first, then pass the exact window label to every other tool. Mutations are serialized per window/lane and are refused while a protocol transaction pins the lane, while the app prepares an update, or when the window is not logged in."
)]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("serial-debug", self.version()))
            .with_instructions("Local desktop Serial Debug app. Call windows_list first, then pass the exact window label to every other tool.")
    }
}
