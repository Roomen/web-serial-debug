// MCP 工具层：只有参数校验 + 把调用转给目标窗口的页面桥。设备逻辑全部在 js/mcp-bridge.js 里复用页面既有路径。
use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig};
use schemars::JsonSchema;
use rmcp::{tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelectParams {
    /// Window label from windows_list.
    pub window: String,
    /// Lane: "S", "A" or "B".
    pub lane: String,
    /// Opaque device id from a fresh serial_ports_list (document-scoped; stale after reload/replug). Exactly one of deviceId / sn is required.
    pub device_id: Option<String>,
    /// USB serial number string, matched exactly against the sn field of serial_ports_list entries. Use it across reconnects.
    pub sn: Option<String>,
}

// serial_configure 的 options：六个键与页面 serialLanes.configure 一一对应。
// 未知键在 schema 边界拒绝(deny_unknown_fields)，值的逐项合法性由页面归一化校验(报 invalid_options)。
#[derive(Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialOptionsPatch {
    /// Baud rate in bit/s (>0, e.g. 115200).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baud_rate: Option<u32>,
    /// Data bits: 7 or 8.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_bits: Option<u32>,
    /// Stop bits: 1 or 2.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_bits: Option<u32>,
    /// Parity: "none" | "even" | "odd".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parity: Option<String>,
    /// RX buffer size in bytes (1..16777216).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer_size: Option<u32>,
    /// Flow control: "none" | "hardware".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_control: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureParams {
    /// Window label from windows_list.
    pub window: String,
    /// Lane: "S", "A" or "B".
    pub lane: String,
    /// Options to apply (any subset, at least one field). Omit to READ the lane's effective options.
    pub options: Option<SerialOptionsPatch>,
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
        name = "serial_ports_list",
        description = "List the serial devices currently present for one window. Each entry has an opaque deviceId (valid only for that window's current document; stale after reload/replug), port/product/alias names, vid/pid/sn/slot, persistence flags and which lanes currently hold it. Read-only: no access is granted here, grant happens at serial_select.",
        annotations(title = "List serial ports", read_only_hint = true)
    )]
    async fn serial_ports_list(&self, Parameters(p): Parameters<WindowParams>) -> Result<CallToolResult, McpError> {
        match self.call(&p.window, "serial_ports_list", json!({ "window": p.window }), READ_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "serial_select",
        description = "Select a device for a lane WITHOUT opening it (call serial_open next). Pass exactly one of deviceId (from a fresh serial_ports_list) or sn. The port is re-enumerated inside the lane's mutation queue after commit, so a stale deviceId or an unplugged device is rejected rather than silently picking another unit; an ambiguous sn returns candidates instead of guessing.",
        annotations(title = "Select serial device", read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn serial_select(&self, Parameters(p): Parameters<SelectParams>) -> Result<CallToolResult, McpError> {
        if let Err(e) = check_lane(&p.lane) {
            return err_result(e);
        }
        // 与页面 handler 同口径：deviceId 只去空串，sn 先 trim；二选一在两侧都查，先拦的不进桥
        let device_id = p.device_id.unwrap_or_default();
        let sn = p.sn.map(|s| s.trim().to_string()).unwrap_or_default();
        if device_id.is_empty() && sn.is_empty() {
            return err_result(BridgeError::new("bad_params", "必须给 deviceId(来自 serial_ports_list)或 sn"));
        }
        if !device_id.is_empty() && !sn.is_empty() {
            return err_result(BridgeError::new("bad_params", "deviceId 与 sn 只能给一个"));
        }
        let params = json!({ "window": p.window, "lane": p.lane, "deviceId": device_id, "sn": sn });
        match self.call(&p.window, "serial_select", params, TOOL_TIMEOUT).await {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        }
    }

    #[tool(
        name = "serial_configure",
        description = "Read or write a lane's serial parameters. Omit options to READ the effective options + summary; pass an options object (any subset of baudRate/dataBits/stopBits/parity/bufferSize/flowControl, at least one field) to WRITE: the values are persisted and, when the lane is open, applied by reopening it. A reopen failure after a successful save reports executed=partial (reopen_failed), so the saved values are already in effect for the next open.",
        annotations(title = "Configure serial lane", read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn serial_configure(&self, Parameters(p): Parameters<ConfigureParams>) -> Result<CallToolResult, McpError> {
        if let Err(e) = check_lane(&p.lane) {
            return err_result(e);
        }
        let options = p.options.as_ref().map(|o| serde_json::to_value(o).unwrap_or_default()).unwrap_or_default();
        let params = json!({ "window": p.window, "lane": p.lane, "options": options });
        match self.call(&p.window, "serial_configure", params, TOOL_TIMEOUT).await {
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    use super::*;
    use crate::mcp::bridge::mock::MockBridge;
    use crate::mcp::WindowReg;

    // 记录转发到页面桥的 params，回执原样回传，便于断言 camelCase 字段与只读/写语义
    fn recording_server() -> (McpServer, Arc<Mutex<Vec<Value>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let rec = calls.clone();
        let state = McpState::default();
        state.mark_running_for_test(38991);
        state.register_window_for_test(
            "main",
            WindowReg { bridge_epoch: "e1".into(), authed: true, mode: "dual".into(), app_version: "t".into() },
        );
        let script = Arc::new(move |_tool: &str, p: &Value| {
            rec.lock().unwrap().push(p.clone());
            (true, json!({ "ok": true }))
        });
        let bridge = Arc::new(MockBridge::new(state.clone(), true, script));
        (McpServer::new(state, bridge, None), calls)
    }

    fn structured(r: &CallToolResult) -> &Value {
        r.structured_content.as_ref().expect("应有 structured_content")
    }

    #[tokio::test]
    async fn ports_list_forwards_window_and_is_read_only_shape() {
        let (s, calls) = recording_server();
        let r = s.serial_ports_list(Parameters(WindowParams { window: "main".into() })).await.unwrap();
        assert_eq!(r.is_error, Some(false));
        assert_eq!(calls.lock().unwrap()[0], json!({ "window": "main" }));
    }

    #[tokio::test]
    async fn select_requires_exactly_one_of_device_id_or_sn() {
        let (s, calls) = recording_server();
        // 都不给 / 两个都给 / 空白串，都在桥前拦成 bad_params
        for (device_id, sn) in [
            (None, None),
            (Some("e1-d1".to_string()), Some("x".to_string())),
            (Some(String::new()), Some("  ".to_string())),
        ] {
            let r = s
                .serial_select(Parameters(SelectParams { window: "main".into(), lane: "S".into(), device_id, sn }))
                .await
                .unwrap();
            assert_eq!(r.is_error, Some(true));
            assert_eq!(structured(&r)["code"], json!("bad_params"));
        }
        // 非法 lane 同样在桥前拦截
        let r = s
            .serial_select(Parameters(SelectParams {
                window: "main".into(),
                lane: "X".into(),
                device_id: Some("e1-d1".into()),
                sn: None,
            }))
            .await
            .unwrap();
        assert_eq!(structured(&r)["code"], json!("invalid_lane"));
        assert!(calls.lock().unwrap().is_empty(), "被拒绝的请求不该进桥");

        // sn 去空白后透传，空 deviceId 按「未给」处理(页面同口径)
        let r = s
            .serial_select(Parameters(SelectParams {
                window: "main".into(),
                lane: "A".into(),
                device_id: Some(String::new()),
                sn: Some(" SN42 ".into()),
            }))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(false));
        assert_eq!(
            calls.lock().unwrap()[0],
            json!({ "window": "main", "lane": "A", "deviceId": "", "sn": "SN42" })
        );
    }

    #[tokio::test]
    async fn configure_read_sends_null_options_write_forwards_only_given_fields() {
        let (s, calls) = recording_server();
        // 省略 options = 读
        let r = s
            .serial_configure(Parameters(ConfigureParams { window: "main".into(), lane: "B".into(), options: None }))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(false));
        // 写：只透传已给的字段，键为 camelCase
        let r = s
            .serial_configure(Parameters(ConfigureParams {
                window: "main".into(),
                lane: "A".into(),
                options: Some(SerialOptionsPatch {
                    baud_rate: Some(9600),
                    flow_control: Some("hardware".into()),
                    ..Default::default()
                }),
            }))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(false));
        let sent = calls.lock().unwrap();
        assert_eq!(sent[0], json!({ "window": "main", "lane": "B", "options": null }));
        assert_eq!(sent[1]["options"], json!({ "baudRate": 9600, "flowControl": "hardware" }));
        assert_eq!(sent[1]["lane"], json!("A"));
    }

    // 反序列化边界：schema 层先拦形状(未知键 / 错类型 / 非对象)，页面层再查值
    #[test]
    fn new_params_deserialization_boundaries() {
        // options 未知键(含大小写笔误)被 deny_unknown_fields 拒绝
        let err = serde_json::from_value::<ConfigureParams>(json!({
            "window": "main", "lane": "S", "options": { "baudrate": 9600 }
        }))
        .unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
        // options 非对象 / 字段错类型 / deviceId 非字符串：同样拒绝
        for bad in [
            json!({ "window": "main", "lane": "S", "options": "x" }),
            json!({ "window": "main", "lane": "S", "options": { "baudRate": "x" } }),
        ] {
            assert!(serde_json::from_value::<ConfigureParams>(bad).is_err());
        }
        assert!(serde_json::from_value::<SelectParams>(json!({
            "window": "main", "lane": "S", "deviceId": 5
        }))
        .is_err());
        // 合法形状：空 options 对象(页面报 bad_params「不能为空」)、省略 options(读)
        assert!(serde_json::from_value::<ConfigureParams>(json!({
            "window": "main", "lane": "S", "options": {}
        }))
        .is_ok());
        let p = serde_json::from_value::<ConfigureParams>(json!({ "window": "main", "lane": "S" })).unwrap();
        assert!(p.options.is_none());
        // 六字段的 camelCase 序列化/反序列化互认，未给的键不出现在转发里
        let patch: SerialOptionsPatch =
            serde_json::from_value(json!({ "dataBits": 8, "stopBits": 2, "parity": "odd" })).unwrap();
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            json!({ "dataBits": 8, "stopBits": 2, "parity": "odd" })
        );
    }
}
