// Windows 实机测试用的夹具：在本机生成一次性密钥、把「便携 ZIP + 计划」写到指定目录，
// 供 Windows VM 里的 helper 真机执行(替换 / 回滚 / 等实例退出)。
// 只有设置 PORTABLE_UPDATE_FIXTURE_DIR 时才产出，平时只是普通回归测试里的验签用例。
// 生成的私钥只存在于本进程的临时目录里，不打印、不落进夹具目录。
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

fn cli() -> Option<PathBuf> {
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules/@tauri-apps/cli/tauri.js");
	path.exists().then_some(path)
}

struct Key {
	dir: PathBuf,
	private: String,
	public: String,
}

fn generate_key(node: &str, cli: &Path) -> Option<Key> {
	let dir = std::env::temp_dir().join(format!("puc-fixture-key-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(&dir).unwrap();
	let file = dir.join("signing-key.txt");
	let out = Command::new(node).arg(cli).args(["signer", "generate", "-w"]).arg(&file).arg("--ci").output().ok()?;
	if !out.status.success() {
		eprintln!("跳过：无法生成一次性测试密钥");
		return None;
	}
	let private = std::fs::read_to_string(&file).ok()?;
	let public = std::fs::read_to_string(file.with_extension("txt.pub")).ok()?;
	Some(Key { dir, private: private.trim().to_string(), public: public.trim().to_string() })
}

fn sign(node: &str, cli: &Path, key: &str, archive: &Path, version: &str) -> Option<String> {
	let out = Command::new(node)
		.arg(cli)
		.args(["signer", "sign", "--app-version", version])
		.arg(archive)
		.env("TAURI_SIGNING_PRIVATE_KEY", key)
		.output()
		.ok()?;
	if !out.status.success() {
		return None;
	}
	let signature = std::fs::read_to_string(archive.with_extension("zip.sig")).ok()?;
	Some(signature.trim().to_string())
}

fn build_zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
	let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
	let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
	for (name, content) in entries {
		writer.start_file(*name, options).unwrap();
		writer.write_all(content).unwrap();
	}
	writer.finish().unwrap().into_inner()
}

// 夹具目录里的三个文件：payload.zip(已签名)、plan.json、pubkey.txt(公开信息)
fn write_fixture(dir: &Path, plan: &portable_update_common::Plan, payload: &[u8]) -> std::io::Result<()> {
	std::fs::write(dir.join("payload.zip"), payload)?;
	std::fs::write(dir.join("plan.json"), serde_json::to_vec_pretty(plan)?)?;
	Ok(())
}

#[test]
fn tauri_cli_signature_verifies_and_wrong_version_is_rejected() {
	let Some(cli) = cli() else {
		eprintln!("跳过：未找到 desktop/node_modules/@tauri-apps/cli/tauri.js");
		return;
	};
	let node = std::env::var("NODE").unwrap_or_else(|_| "node".to_string());
	let dir = std::env::temp_dir().join(format!("puc-interop-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(&dir).unwrap();
	let payload = dir.join("payload.zip");
	std::fs::write(&payload, b"payload bytes for interop test").unwrap();
	let Some(key) = generate_key(&node, &cli) else { return };
	let signature = sign(&node, &cli, &key.private, &payload, "1.2.3").expect("tauri signer sign 失败");
	let data = std::fs::read(&payload).unwrap();
	assert_eq!(portable_update_common::signature::verify_payload(&data, &signature, &key.public, "1.2.3"), Ok(()));
	// 同一份签名配上另一个目标版本必须被拒(与 updater 的 requireSignedVersion 语义一致)
	let err = portable_update_common::signature::verify_payload(&data, &signature, &key.public, "1.2.4").unwrap_err();
	assert!(err.contains("版本不一致"), "{err}");
	// 载荷被替换也要被拒
	assert!(portable_update_common::signature::verify_payload(b"other bytes", &signature, &key.public, "1.2.3").is_err());
	let _ = std::fs::remove_dir_all(&dir);
	let _ = std::fs::remove_dir_all(&key.dir);
}

// 生成 Windows 实机测试夹具(默认跳过)。需要：
//   PORTABLE_UPDATE_FIXTURE_DIR  输出目录(计划与载荷)
//   PORTABLE_UPDATE_INSTALL_DIR  安装目录(Windows 路径字符串，helper 会替换其中的 exe)
//   PORTABLE_UPDATE_PUBKEY_OUT   把公钥写到哪里(给构建 helper 用)
#[test]
fn emit_windows_fixture_when_requested() {
	let Ok(fixture) = std::env::var("PORTABLE_UPDATE_FIXTURE_DIR") else {
		eprintln!("跳过：未设置 PORTABLE_UPDATE_FIXTURE_DIR");
		return;
	};
	let install = std::env::var("PORTABLE_UPDATE_INSTALL_DIR").expect("需要 PORTABLE_UPDATE_INSTALL_DIR");
	let version = std::env::var("PORTABLE_UPDATE_VERSION").unwrap_or_else(|_| "1.2.3".to_string());
	let exe_source = std::env::var("PORTABLE_UPDATE_EXE_SOURCE").ok();
	let new_program = match exe_source {
		Some(path) => std::fs::read(&path).expect("读取待替换的主程序失败"),
		None => b"new-program-bytes".to_vec(),
	};
	let signature_mode = std::env::var("PORTABLE_UPDATE_TAMPER").unwrap_or_default();
	let fixture = PathBuf::from(fixture);
	let _ = std::fs::remove_dir_all(&fixture);
	std::fs::create_dir_all(&fixture).unwrap();
	let node = std::env::var("NODE").unwrap_or_else(|_| "node".to_string());
	let cli = cli().expect("需要 Tauri CLI");
	let key = generate_key(&node, &cli).expect("生成测试密钥失败");
	let mut entries: Vec<(&str, Vec<u8>)> = vec![
		(portable_update_common::EXE_ENTRY, new_program),
		(portable_update_common::README_ENTRY, b"fixture readme".to_vec()),
	];
	// 便携包里的 helper：给了源文件就一起打进载荷，用来验证安装目录里那份也会被替换
	if let Ok(path) = std::env::var("PORTABLE_UPDATE_HELPER_SOURCE") {
		entries.push((portable_update_common::HELPER_FILE, std::fs::read(&path).expect("读取 helper 失败")));
	}
	let zip = build_zip(&entries);
	std::fs::write(fixture.join(portable_update_common::PAYLOAD_FILE), &zip).unwrap();
	let zip_path = fixture.join(portable_update_common::PAYLOAD_FILE);
	// tamper=version: 用另一个版本号签名，模拟「新版本号配旧包」
	let signed_version = if signature_mode == "version" { "1.2.2" } else { &version };
	let mut signature = sign(&node, &cli, &key.private, &zip_path, signed_version).expect("签名失败");
	if signature_mode == "payload" {
		// 签名有效但载荷被换掉
		std::fs::write(fixture.join(portable_update_common::PAYLOAD_FILE), build_zip(&[(portable_update_common::EXE_ENTRY, b"tampered".to_vec()), (portable_update_common::README_ENTRY, b"x".to_vec())])).unwrap();
		let _ = &entries;
	}
	if signature_mode == "garbage" {
		signature = "c2lnbmF0dXJl".into();
	}
	let data_dir = std::env::var("PORTABLE_UPDATE_DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| fixture.join("data"));
	std::fs::create_dir_all(&data_dir).unwrap();
	// 可选：预先放一个「更新进行中」标记(并发场景测试用)
	if std::env::var("PORTABLE_UPDATE_MARKER").is_ok() {
		let marker = portable_update_common::Marker {
			format: portable_update_common::FORMAT,
			operation_id: std::env::var("PORTABLE_UPDATE_OPERATION").unwrap_or_else(|_| "0123456789abcdef".to_string()),
			pid: std::process::id(),
			helper_pid: None,
			at: portable_update_common::unix_ms(),
		};
		portable_update_common::write_marker(&data_dir, &marker).unwrap();
	}
	let plan = portable_update_common::Plan {
		format: portable_update_common::FORMAT,
		operation_id: std::env::var("PORTABLE_UPDATE_OPERATION").unwrap_or_else(|_| "0123456789abcdef".to_string()),
		install_dir: PathBuf::from(&install),
		exe_name: std::env::var("PORTABLE_UPDATE_EXE_NAME").unwrap_or_else(|_| "Serial Debug.exe".to_string()),
		payload: fixture.join(portable_update_common::PAYLOAD_FILE),
		signature,
		data_dir,
		version: version.clone(),
		wait_timeout_ms: std::env::var("PORTABLE_UPDATE_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(2_000),
	};
	write_fixture(&fixture, &plan, &zip).unwrap();
	let pubkey_out = std::env::var("PORTABLE_UPDATE_PUBKEY_OUT").map(PathBuf::from).unwrap_or_else(|_| fixture.join("pubkey.txt"));
	std::fs::write(&pubkey_out, &key.public).unwrap();
	println!("PUBKEY={}", key.public);
	println!("FIXTURE={}", fixture.display());
	println!("PLAN={}", fixture.join(portable_update_common::PLAN_FILE).display());
	let _ = std::fs::remove_dir_all(&key.dir);
}
