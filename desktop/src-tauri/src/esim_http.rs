// 桌面客户端 eSIM SM-DP+ (GSMA SGP.22 ES9+) HTTPS 代理命令：
// 浏览器因 CORS 无法直接向 SM-DP+ 发起带自定义请求头的 POST，桌面端由此命令转发原始字节，
// 保持 TLS 证书校验、不重排 JSON、不记录任何请求/响应体或凭证。
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_REQ_BYTES: usize = 64 * 1024;
const MAX_RESP_BYTES: usize = 256 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 30;
const ES9_PATH_PREFIX: &str = "/gsma/rsp2/es9plus/";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EsimSmdpPostReq {
	pub url: String,
	pub body_bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EsimSmdpPostResp {
	pub status: u16,
	pub body_bytes: Vec<u8>,
}

pub fn validate_smdp_url(raw_url: &str) -> Result<reqwest::Url, String> {
	let parsed = reqwest::Url::parse(raw_url.trim()).map_err(|_| "SM-DP+ URL 格式无效".to_string())?;
	if parsed.scheme() != "https" {
		return Err("SM-DP+ 仅允许 HTTPS 协议".to_string());
	}
	if parsed.host_str().map(|h| h.is_empty()).unwrap_or(true) {
		return Err("SM-DP+ URL 缺少主机名".to_string());
	}
	let path = parsed.path();
	if !path.starts_with(ES9_PATH_PREFIX) || path.contains("..") {
		return Err("仅允许转发 GSMA ES9+ (/gsma/rsp2/es9plus/) 路径".to_string());
	}
	Ok(parsed)
}

#[tauri::command]
pub async fn esim_smdp_post(req: EsimSmdpPostReq) -> Result<EsimSmdpPostResp, String> {
	let url = validate_smdp_url(&req.url)?;
	if req.body_bytes.len() > MAX_REQ_BYTES {
		return Err(format!("请求体超出上限 ({} 字节)", MAX_REQ_BYTES));
	}

	// 每次新建短连接客户端（不复用连接池），保留默认系统/webpki TLS 证书校验，禁止重定向且仅限 HTTPS
	let client = reqwest::Client::builder()
		.pool_max_idle_per_host(0)
		.redirect(reqwest::redirect::Policy::none())
		.https_only(true)
		.timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
		.build()
		.map_err(|e| format!("初始化 HTTPS 客户端失败: {e}"))?;

	let resp = client
		.post(url)
		.header("X-Admin-Protocol", "gsma/rsp/v2.2.0")
		.header("Content-Type", "application/json")
		.header("User-Agent", "gsma-rsp-lpad")
		.header("Connection", "close")
		.body(req.body_bytes)
		.send()
		.await
		.map_err(|e| format!("请求 SM-DP+ 失败: {e}"))?;

	let status = resp.status().as_u16();
	if let Some(len) = resp.content_length() {
		if len as usize > MAX_RESP_BYTES {
			return Err(format!("SM-DP+ 响应超出上限 ({} 字节)", MAX_RESP_BYTES));
		}
	}
	let bytes = resp.bytes().await.map_err(|e| format!("读取 SM-DP+ 响应失败: {e}"))?;
	if bytes.len() > MAX_RESP_BYTES {
		return Err(format!("SM-DP+ 响应超出上限 ({} 字节)", MAX_RESP_BYTES));
	}

	Ok(EsimSmdpPostResp {
		status,
		body_bytes: bytes.to_vec(),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn accepts_valid_es9plus_https_urls() {
		for path in [
			"initiateAuthentication",
			"authenticateClient",
			"getBoundProfilePackage",
			"handleNotification",
		] {
			let u = format!("https://smdp.example.com/gsma/rsp2/es9plus/{path}");
			assert!(validate_smdp_url(&u).is_ok(), "should accept {u}");
		}
	}

	#[test]
	fn rejects_non_https_or_non_es9_paths() {
		assert!(validate_smdp_url("http://smdp.example.com/gsma/rsp2/es9plus/initiateAuthentication").is_err());
		assert!(validate_smdp_url("https://smdp.example.com/other/path").is_err());
		assert!(validate_smdp_url("https://smdp.example.com/gsma/rsp2/es9plus/../secret").is_err());
		assert!(validate_smdp_url("https:///gsma/rsp2/es9plus/initiateAuthentication").is_err());
	}
}
