// MCP Streamable HTTP 监听：只绑 127.0.0.1，固定端口(用户可配)，Bearer 令牌，无会话(stateless JSON 响应)。
// 鉴权在 rmcp 的内容协商之前完成，未带令牌的请求一律 401；GET/DELETE 由 rmcp 按无会话模式回 405。
use std::sync::Arc;

use axum::Router;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::auth::{self, AuthState};
use super::bridge::WindowBridge;
use super::server::McpServer;
use super::{McpState, Running};

// 请求体上限：工具参数只可能是短字符串(hex 数据另有更小的业务上限)
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;

// 生产与测试共用同一套 router：测试覆盖的就是真实中间件与 rmcp 配置
pub fn build_router(
    state: McpState,
    bridge: Arc<dyn WindowBridge>,
    app: Option<AppHandle>,
    port: u16,
    shutdown: &CancellationToken,
    auth_state: AuthState,
) -> Router {
    let service = StreamableHttpService::new(
        {
            let state = state.clone();
            let bridge = bridge.clone();
            let app = app.clone();
            move || Ok::<_, std::io::Error>(McpServer::new(state.clone(), bridge.clone(), app.clone()))
        },
        LocalSessionManager::default().into(),
        // 无会话、优先 application/json：本地单客户端场景不需要 SSE 续传
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_cancellation_token(shutdown.child_token())
            .with_allowed_hosts([format!("127.0.0.1:{port}"), format!("localhost:{port}")])
            .with_max_request_body_bytes(MAX_REQUEST_BODY_BYTES)
            // 空白名单 + 强制校验：任何带 Origin 头的请求(浏览器页面)都被拒绝，本地 agent 客户端不发 Origin
            .enforce_origin_validation(),
    );
    Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(auth_state, auth::require_token))
}

pub async fn start(
    app: AppHandle,
    state: McpState,
    bridge: Arc<dyn WindowBridge>,
    port: u16,
    auth_state: AuthState,
) -> Result<Running, String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|_| format!("端口 {port} 绑定失败(可能已被占用)"))?;
    let shutdown = CancellationToken::new();
    let router = build_router(state, bridge, Some(app), port, &shutdown, auth_state);
    let ct = shutdown.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { ct.cancelled_owned().await })
            .await;
    });
    Ok(Running::new(port, shutdown, task))
}

#[cfg(test)]
pub mod support {
    use std::sync::Arc;

    use serde_json::{json, Value};
    use tokio_util::sync::CancellationToken;

    use crate::mcp::auth::AuthState;
    use crate::mcp::bridge::mock::MockBridge;
    use crate::mcp::settings::new_token;
    use crate::mcp::{McpState, WindowReg};

    pub struct TestServer {
        pub port: u16,
        pub token: String,
    }

    impl TestServer {
        pub fn url(&self) -> String {
            format!("http://127.0.0.1:{}/mcp", self.port)
        }
    }

    // 真实 HTTP 监听 + 假窗口桥：与生产用同一个 build_router
    pub async fn start(script: Arc<dyn Fn(&str, &Value) -> (bool, Value) + Send + Sync>, commit: bool) -> TestServer {
        let state = McpState::default();
        let token = new_token();
        let token_arc = Arc::new(std::sync::RwLock::new(token.clone()));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        state.mark_running_for_test(port);
        state.register_window_for_test(
            "main",
            WindowReg { bridge_epoch: "e1".into(), authed: true, mode: "single".into(), app_version: "test".into() },
        );
        let bridge = Arc::new(MockBridge::new(state.clone(), commit, script));
        let shutdown = CancellationToken::new();
        let router = super::build_router(state.clone(), bridge, None, port, &shutdown, AuthState::new(token_arc));
        let ct = shutdown.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move { ct.cancelled_owned().await })
                .await;
        });
        let _ = &shutdown;
        TestServer { port, token }
    }

    fn host_of(port: u16, extra: &[(&str, &str)]) -> String {
        extra
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("host"))
            .map(|(_, v)| (*v).to_string())
            .unwrap_or_else(|| format!("127.0.0.1:{port}"))
    }

    // 直接打 HTTP：用于鉴权 / Host / Origin / 方法 / 体积等协议层断言
    pub async fn raw_post(server: &TestServer, token: Option<&str>, body: &str, extra: &[(&str, &str)]) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", server.port)).await.unwrap();
        let mut req = format!(
            "POST /mcp HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
            host_of(server.port, extra),
            body.len()
        );
        if let Some(t) = token {
            req.push_str(&format!("Authorization: Bearer {t}\r\n"));
        }
        for (k, v) in extra {
            if !k.eq_ignore_ascii_case("host") {
                req.push_str(&format!("{k}: {v}\r\n"));
            }
        }
        req.push_str("\r\n");
        req.push_str(body);
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        let text = String::from_utf8_lossy(&buf).to_string();
        let status = text.split(' ').nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
        (status, text)
    }

    pub async fn raw_request(server: &TestServer, method: &str, token: Option<&str>, extra: &[(&str, &str)]) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", server.port)).await.unwrap();
        let mut req = format!(
            "{method} /mcp HTTP/1.1\r\nHost: {}\r\nAccept: text/event-stream\r\nConnection: close\r\n",
            host_of(server.port, extra)
        );
        if let Some(t) = token {
            req.push_str(&format!("Authorization: Bearer {t}\r\n"));
        }
        for (k, v) in extra {
            if !k.eq_ignore_ascii_case("host") {
                req.push_str(&format!("{k}: {v}\r\n"));
            }
        }
        req.push_str("\r\n");
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        let text = String::from_utf8_lossy(&buf).to_string();
        let status = text.split(' ').nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
        (status, text)
    }

    pub fn init_body() -> String {
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "test-client", "version": "1.0" }
            }
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{json, Value};

    use super::support::{init_body, raw_post, raw_request, start};

    fn script() -> Arc<dyn Fn(&str, &Value) -> (bool, Value) + Send + Sync> {
        Arc::new(|tool: &str, params: &Value| match tool {
            "serial_write" => (false, json!({ "code": "serial_not_open", "message": "串口未打开" })),
            _ => (true, json!({ "tool": tool, "window": params.get("window").cloned().unwrap_or(Value::Null) })),
        })
    }

    fn tools_list_body() -> String {
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string()
    }

    fn call_body(tool: &str, args: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": tool, "arguments": args } }).to_string()
    }

    #[tokio::test]
    async fn missing_or_wrong_token_is_401() {
        let server = start(script(), true).await;
        let (status, _) = raw_post(&server, None, &init_body(), &[]).await;
        assert_eq!(status, 401);
        let (status, _) = raw_post(&server, Some("wrong"), &init_body(), &[]).await;
        assert_eq!(status, 401);
        let (status, body) = raw_post(&server, Some(&server.token), &init_body(), &[]).await;
        assert_eq!(status, 200, "{body}");
    }

    #[tokio::test]
    async fn browser_origin_and_foreign_host_are_rejected() {
        let server = start(script(), true).await;
        let (status, _) = raw_post(&server, Some(&server.token), &init_body(), &[("Origin", "http://evil.example")]).await;
        assert_eq!(status, 403);
        let (status, _) = raw_post(&server, Some(&server.token), &init_body(), &[("Host", "evil.example")]).await;
        assert_eq!(status, 403);
    }

    #[tokio::test]
    async fn get_is_405_with_allow_post() {
        let server = start(script(), true).await;
        let (status, text) = raw_request(&server, "GET", Some(&server.token), &[]).await;
        assert_eq!(status, 405);
        assert!(text.to_ascii_lowercase().contains("allow: post"), "{text}");
    }

    #[tokio::test]
    async fn oversized_body_is_rejected() {
        let server = start(script(), true).await;
        let big = "x".repeat(super::MAX_REQUEST_BODY_BYTES + 1024);
        let body = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": { "pad": big } }).to_string();
        let (status, _) = raw_post(&server, Some(&server.token), &body, &[]).await;
        assert_eq!(status, 413);
    }

    #[tokio::test]
    async fn stateless_json_initialize_and_tools_list() {
        let server = start(script(), true).await;
        let (status, body) = raw_post(&server, Some(&server.token), &init_body(), &[]).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.to_ascii_lowercase().contains("application/json"), "{body}");
        assert!(body.contains("serial-debug"), "{body}");
        let (status, body) = raw_post(&server, Some(&server.token), &tools_list_body(), &[]).await;
        assert_eq!(status, 200, "{body}");
        for name in [
            "windows_list",
            "serial_state",
            "serial_open",
            "serial_close",
            "serial_write",
            "serial_read",
            "serial_ports_list",
            "serial_select",
            "serial_configure",
            "blu_state",
            "blu_set_power",
            "blu_set_voltage",
            "blu_capture_start",
            "blu_capture_stop",
            "blu_capture_summary",
        ] {
            assert!(body.contains(&format!("\"{name}\"")), "缺少工具 {name}: {body}");
        }
    }

    #[tokio::test]
    async fn tool_call_success_and_domain_error() {
        let server = start(script(), true).await;
        let (status, body) = raw_post(&server, Some(&server.token), &call_body("serial_state", json!({ "window": "main" })), &[]).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("\"isError\":false"), "{body}");
        assert!(body.contains("\"structuredContent\""), "{body}");

        let (status, body) = raw_post(
            &server,
            Some(&server.token),
            &call_body("serial_write", json!({ "window": "main", "lane": "S", "data": "00" })),
            &[],
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("\"isError\":true"), "{body}");
        assert!(body.contains("serial_not_open"), "{body}");
    }

    #[tokio::test]
    async fn rmcp_client_interop() {
        use rmcp::model::CallToolRequestParams;
        use rmcp::transport::streamable_http_client::{StreamableHttpClientTransport, StreamableHttpClientTransportConfig};
        use rmcp::ServiceExt;

        let server = start(script(), true).await;
        let mut config = StreamableHttpClientTransportConfig::with_uri(server.url());
        // rmcp 的 reqwest 客户端自己加 "Bearer " 前缀，这里只给裸令牌
        config.auth_header = Some(server.token.clone());
        let transport = StreamableHttpClientTransport::with_client(reqwest::Client::new(), config);
        let client = ().serve(transport).await.expect("MCP 客户端初始化失败");

        let tools = client.list_tools(None).await.expect("tools/list 失败");
        assert_eq!(tools.tools.len(), 39);
        for name in ["ble_state", "ble_ports", "ble_open", "ble_scan_start", "ble_scan_stop", "ble_connect", "ble_gatt", "ble_write", "ble_pair", "ble_passkey"] {
            assert!(tools.tools.iter().any(|t| t.name == name), "missing typed BLE tool: {name}");
        }

        for name in ["classic_state", "classic_devices", "classic_discover", "classic_pair", "classic_connect", "classic_close", "classic_read", "classic_write"] {
            assert!(tools.tools.iter().any(|t| t.name == name), "missing typed Classic tool: {name}");
        }

        let mut args = serde_json::Map::new();
        args.insert("window".into(), json!("main"));
        let result = client
            .call_tool(CallToolRequestParams::new("serial_state").with_arguments(args))
            .await
            .expect("tools/call 失败");
        assert_eq!(result.is_error, Some(false));
        assert!(result.structured_content.is_some());

        client.cancel().await.ok();
    }
}
