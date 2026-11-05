// 本地 MCP 服务的鉴权：loopback 绑定 + Bearer 令牌(常量时间比较) + Origin/Host 校验(由 rmcp 配置负责)。
// 令牌只在用户显式「显示 / 复制」时经命令返回，不写日志、不进页面存储。
use std::sync::{Arc, RwLock};

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use subtle::ConstantTimeEq;

#[derive(Clone, Default)]
pub struct AuthState {
    pub token: Arc<RwLock<String>>,
}

impl AuthState {
    pub fn new(token: Arc<RwLock<String>>) -> Self {
        AuthState { token }
    }
    pub fn current(&self) -> String {
        self.token.read().map(|t| t.clone()).unwrap_or_default()
    }
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

// 只认 `Authorization: Bearer <token>`，其它 scheme 一律拒绝
pub fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    let Some(value) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else { return false };
    let Some((scheme, token)) = value.split_once(' ') else { return false };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    constant_time_eq(token.trim(), expected)
}

pub async fn require_token(State(auth): State<AuthState>, req: Request, next: Next) -> Response {
    if bearer_matches(req.headers(), &auth.current()) {
        next.run(req).await
    } else {
        unauthorized()
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer realm=\"serial-debug-mcp\"")],
        "Unauthorized",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn constant_time_compare_is_exact() {
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        assert!(!constant_time_eq("abc123", "abc1234"));
        assert!(!constant_time_eq("", ""));
    }

    #[test]
    fn bearer_header_requires_scheme_and_exact_token() {
        let mut h = HeaderMap::new();
        assert!(!bearer_matches(&h, "tok"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer tok"));
        assert!(bearer_matches(&h, "tok"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("bearer tok"));
        assert!(bearer_matches(&h, "tok"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer  tok "));
        assert!(bearer_matches(&h, "tok"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Basic tok"));
        assert!(!bearer_matches(&h, "tok"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer other"));
        assert!(!bearer_matches(&h, "tok"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer "));
        assert!(!bearer_matches(&h, ""));
    }
}
