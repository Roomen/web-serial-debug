// 更新载荷签名校验：与 tauri-plugin-updater 用同一套 minisign 公钥 / 信任注释规则，
// helper 在应用退出后独立再校验一遍，避免只信任应用进程里已经发生过的检查。
use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn decode(value: &str) -> Result<String, String> {
	let text = base64::engine::general_purpose::STANDARD
		.decode(value.trim().as_bytes())
		.map_err(|_| "更新签名或公钥格式无效".to_string())?;
	String::from_utf8(text).map_err(|_| "更新签名或公钥格式无效".to_string())
}

fn signed_version(trusted_comment: &str) -> Option<&str> {
	trusted_comment.split('\t').find_map(|field| field.strip_prefix("version:"))
}

/// 校验载荷签名，并要求签名里记录的版本与计划里的目标版本一致。
/// 公钥为空(本地未配置签名的构建)时直接失败，不做「无签名也放行」的降级。
pub fn verify_payload(data: &[u8], signature_b64: &str, pubkey_b64: &str, expected_version: &str) -> Result<(), String> {
	if pubkey_b64.trim().is_empty() {
		return Err("此版本未配置更新公钥，无法校验更新包".into());
	}
	let public_key = PublicKey::decode(&decode(pubkey_b64)?).map_err(|_| "更新公钥无效".to_string())?;
	let signature = Signature::decode(&decode(signature_b64)?).map_err(|_| "更新签名无效".to_string())?;
	public_key.verify(data, &signature, true).map_err(|_| "更新包签名校验失败".to_string())?;
	// 只有 verify 通过后信任注释才是可信数据
	let Some(version) = signed_version(signature.trusted_comment()) else {
		return Err("更新签名未记录版本，无法确认更新包与版本的对应关系".into());
	};
	if version.trim_start_matches('v') != expected_version.trim_start_matches('v') {
		return Err("更新包签名与目标版本不一致".into());
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use base64::engine::general_purpose::STANDARD;
	use ring::signature::KeyPair;

	// 测试密钥只在本进程里生成，不落盘、与发布签名无关；用于覆盖成功、篡改与版本错配三条路径。
	struct TestKey {
		key_id: [u8; 8],
		pair: ring::signature::Ed25519KeyPair,
	}

	impl TestKey {
		fn new(seed_byte: u8) -> TestKey {
			let mut seed = [0u8; 32];
			for (i, b) in seed.iter_mut().enumerate() {
				*b = seed_byte.wrapping_mul((i as u8).wrapping_add(1)) ^ 0x5a;
			}
			let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
			TestKey { key_id: [1, 2, 3, 4, 5, 6, 7, seed_byte], pair }
		}

		fn pubkey_b64(&self) -> String {
			// 与 .pub 文件同构：注释行 + 一行 base64(算法串 "Ed" + 8 字节 key id + 32 字节公钥)，
			// 整段再 base64 一次——这正是 updater 配置里 pubkey 字段的形态
			let mut bin = Vec::with_capacity(42);
			bin.extend_from_slice(b"Ed");
			bin.extend_from_slice(&self.key_id);
			bin.extend_from_slice(self.pair.public_key().as_ref());
			let text = format!("untrusted comment: minisign public key test\n{}\n", STANDARD.encode(bin));
			STANDARD.encode(text)
		}

		// 未预哈希(legacy)模式：签名覆盖原始数据，全局签名覆盖「签名 + 信任注释」
		fn sign_b64(&self, data: &[u8], trusted: &str) -> String {
			let signature = self.pair.sign(data);
			let mut global_input = Vec::new();
			global_input.extend_from_slice(signature.as_ref());
			global_input.extend_from_slice(trusted.as_bytes());
			let global = self.pair.sign(&global_input);
			let mut bin = Vec::with_capacity(74);
			bin.extend_from_slice(b"Ed");
			bin.extend_from_slice(&self.key_id);
			bin.extend_from_slice(signature.as_ref());
			let text = format!(
				"untrusted comment: rsignature\n{}\ntrusted comment: {}\n{}\n",
				STANDARD.encode(bin),
				trusted,
				STANDARD.encode(global.as_ref())
			);
			STANDARD.encode(text)
		}
	}

	#[test]
	fn a_matching_signature_and_version_is_accepted() {
		let key = TestKey::new(7);
		let data = b"portable payload bytes";
		let sig = key.sign_b64(data, "timestamp:1700000000\tfile:payload.zip\tversion:1.2.3");
		assert_eq!(verify_payload(data, &sig, &key.pubkey_b64(), "1.2.3"), Ok(()));
		// semver 写法上的 v 前缀不算不同版本
		assert_eq!(verify_payload(data, &sig, &key.pubkey_b64(), "v1.2.3"), Ok(()));
	}

	#[test]
	fn tampered_payload_is_rejected() {
		let key = TestKey::new(9);
		let sig = key.sign_b64(b"original", "timestamp:1\tfile:payload.zip\tversion:1.2.3");
		assert!(verify_payload(b"modified", &sig, &key.pubkey_b64(), "1.2.3").is_err());
	}

	#[test]
	fn a_signature_from_another_key_is_rejected() {
		let signer = TestKey::new(11);
		let other = TestKey::new(12);
		let data = b"payload";
		let sig = signer.sign_b64(data, "timestamp:1\tfile:payload.zip\tversion:1.2.3");
		assert!(verify_payload(data, &sig, &other.pubkey_b64(), "1.2.3").is_err());
	}

	#[test]
	fn version_mismatch_and_missing_version_are_rejected() {
		let key = TestKey::new(13);
		let data = b"payload";
		let sig = key.sign_b64(data, "timestamp:1\tfile:payload.zip\tversion:1.2.3");
		let err = verify_payload(data, &sig, &key.pubkey_b64(), "1.2.4").unwrap_err();
		assert!(err.contains("版本不一致"), "{err}");
		let no_version = key.sign_b64(data, "timestamp:1\tfile:payload.zip");
		let err = verify_payload(data, &no_version, &key.pubkey_b64(), "1.2.3").unwrap_err();
		assert!(err.contains("未记录版本"), "{err}");
	}

	#[test]
	fn empty_public_key_fails_closed() {
		assert!(verify_payload(b"payload", "c2ln", "", "1.2.3").is_err());
		assert!(verify_payload(b"payload", "c2ln", "   ", "1.2.3").is_err());
	}

	#[test]
	fn malformed_inputs_are_rejected() {
		assert!(verify_payload(b"payload", "not base64 !!", "c2ln", "1.2.3").is_err());
		assert!(verify_payload(b"payload", "c2ln", "not base64 !!", "1.2.3").is_err());
	}

	#[test]
	fn trusted_comment_version_is_parsed_by_prefix() {
		let comment = "timestamp:1\tfile:x.zip\tversion:1.2.3";
		assert_eq!(signed_version(comment), Some("1.2.3"));
		assert_eq!(signed_version("timestamp:1\tfile:x.zip"), None);
	}
}
