// 桌面客户端 eSIM SM-DP+ (GSMA SGP.22 ES9+) HTTPS 代理命令：
// 浏览器因 CORS 无法直接向 SM-DP+ 发起带自定义请求头的 POST，桌面端由此命令转发原始字节；
// 默认保留系统/WebPKI TLS 证书校验，仅在显式开启 allow_insecure_tls 时跳过服务端证书与主机名校验
// （用于 GSMA Live/Test CI 签发或测试环境 SAN 不一致的 SM-DP+ 证书；eUICC 仍在应用层校验 SM-DP+ 签名）；
// 始终强制 HTTPS、HTTP/1.1 短连接、禁止重定向、限定 ES9+ 路径，不重排 JSON、不记录任何请求/响应体或凭证。
use serde::{Deserialize, Serialize};
use std::error::Error;
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
	#[serde(default)]
	pub allow_insecure_tls: bool,
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

pub(crate) fn build_smdp_client(allow_insecure_tls: bool) -> Result<reqwest::Client, String> {
	// 每次新建 HTTP/1.1 短连接客户端（不复用连接池，避免 HTTP/2 与 Connection: close 冲突），禁止重定向且仅限 HTTPS
	let mut builder = reqwest::Client::builder()
		.pool_max_idle_per_host(0)
		.http1_only()
		.redirect(reqwest::redirect::Policy::none())
		.https_only(true)
		.timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));
	if allow_insecure_tls {
		// rustls 下启用 NoVerifier：放行非 WebPKI 的 GSMA CI 证书与测试环境 SAN 不一致证书
		builder = builder.tls_danger_accept_invalid_certs(true);
	}
	builder
		.build()
		.map_err(|e| format!("初始化 HTTPS 客户端失败: {}", format_error_chain(&e)))
}

pub(crate) fn format_error_chain(err: &dyn Error) -> String {
	let mut parts: Vec<String> = Vec::new();
	let mut cur: Option<&dyn Error> = Some(err);
	while let Some(e) = cur {
		let text = e.to_string();
		if !text.is_empty() && parts.last().map(|p| p != &text).unwrap_or(true) {
			parts.push(text);
		}
		cur = e.source();
	}
	parts.join(" -> ")
}

fn looks_like_tls_cert_error(chain: &str) -> bool {
	let lower = chain.to_ascii_lowercase();
	lower.contains("invalid peer certificate")
		|| lower.contains("unknownissuer")
		|| lower.contains("unknown issuer")
		|| lower.contains("notvalidforname")
		|| lower.contains("not valid for name")
		|| lower.contains("certificate verify failed")
		|| lower.contains("self signed certificate")
		|| lower.contains("self-signed certificate")
		|| lower.contains("badcertificate")
		|| lower.contains("invalid certificate")
}

pub(crate) fn format_smdp_request_error(err: &dyn Error, allow_insecure_tls: bool) -> String {
	let chain = format_error_chain(err);
	if !allow_insecure_tls && looks_like_tls_cert_error(&chain) {
		return format!(
			"请求 SM-DP+ 失败: {chain}（TLS 证书校验未通过：GSMA CI 或测试 SM-DP+ 证书通常不在系统根证书库或域名不匹配，可在 eSIM 面板开启「允许 GSMA CI / 测试 SM-DP+ 证书」后重试）"
		);
	}
	format!("请求 SM-DP+ 失败: {chain}")
}

#[tauri::command]
pub async fn esim_smdp_post(req: EsimSmdpPostReq) -> Result<EsimSmdpPostResp, String> {
	let url = validate_smdp_url(&req.url)?;
	if req.body_bytes.len() > MAX_REQ_BYTES {
		return Err(format!("请求体超出上限 ({} 字节)", MAX_REQ_BYTES));
	}

	let client = build_smdp_client(req.allow_insecure_tls)?;

	let resp = client
		.post(url)
		.header("X-Admin-Protocol", "gsma/rsp/v2.2.0")
		.header("Content-Type", "application/json")
		.header("User-Agent", "gsma-rsp-lpad")
		.header("Connection", "close")
		.body(req.body_bytes)
		.send()
		.await
		.map_err(|e| format_smdp_request_error(&e, req.allow_insecure_tls))?;

	let status = resp.status().as_u16();
	if let Some(len) = resp.content_length() {
		if len as usize > MAX_RESP_BYTES {
			return Err(format!("SM-DP+ 响应超出上限 ({} 字节)", MAX_RESP_BYTES));
		}
	}
	let bytes = resp
		.bytes()
		.await
		.map_err(|e| format!("读取 SM-DP+ 响应失败: {}", format_error_chain(&e)))?;
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
	use std::fmt;

	#[derive(Debug)]
	struct FakeErr {
		msg: &'static str,
		src: Option<Box<FakeErr>>,
	}

	impl fmt::Display for FakeErr {
		fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
			write!(f, "{}", self.msg)
		}
	}

	impl Error for FakeErr {
		fn source(&self) -> Option<&(dyn Error + 'static)> {
			self.src.as_deref().map(|e| e as &dyn Error)
		}
	}

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

	#[test]
	fn req_deserializes_allow_insecure_tls_with_safe_default() {
		let legacy: EsimSmdpPostReq = serde_json::from_str(
			r#"{"url":"https://smdp.example.com/gsma/rsp2/es9plus/initiateAuthentication","bodyBytes":[123,125]}"#,
		)
		.expect("legacy payload should deserialize");
		assert!(!legacy.allow_insecure_tls);

		let opted_in: EsimSmdpPostReq = serde_json::from_str(
			r#"{"url":"https://smdp.example.com/gsma/rsp2/es9plus/initiateAuthentication","bodyBytes":[],"allowInsecureTls":true}"#,
		)
		.expect("allowInsecureTls payload should deserialize");
		assert!(opted_in.allow_insecure_tls);
	}

	#[test]
	fn builds_strict_and_insecure_http1_clients() {
		assert!(build_smdp_client(false).is_ok());
		assert!(build_smdp_client(true).is_ok());
	}

	#[test]
	fn formats_error_chain_and_appends_tls_hint_only_when_strict() {
		let cert_err = FakeErr {
			msg: "error sending request for url (https://smdp.test.invalid/gsma/rsp2/es9plus/initiateAuthentication)",
			src: Some(Box::new(FakeErr {
				msg: "client error (Connect)",
				src: Some(Box::new(FakeErr {
					msg: "invalid peer certificate: UnknownIssuer",
					src: None,
				})),
			})),
		};

		let strict_msg = format_smdp_request_error(&cert_err, false);
		assert!(strict_msg.contains("invalid peer certificate: UnknownIssuer"));
		assert!(strict_msg.contains("TLS 证书校验未通过"));

		let insecure_msg = format_smdp_request_error(&cert_err, true);
		assert!(insecure_msg.contains("invalid peer certificate: UnknownIssuer"));
		assert!(!insecure_msg.contains("TLS 证书校验未通过"));

		let dns_err = FakeErr {
			msg: "error sending request",
			src: Some(Box::new(FakeErr {
				msg: "dns error: failed to lookup address information",
				src: None,
			})),
		};
		let dns_msg = format_smdp_request_error(&dns_err, false);
		assert!(dns_msg.contains("dns error"));
		assert!(!dns_msg.contains("TLS 证书校验未通过"));
	}
}
