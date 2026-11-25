// 桌面客户端本地协议插件目录（<app_data_dir>/protocols/）：
// 非递归扫描顶层 .json / .js 普通文件（拒绝符号链接目录与文件、隐藏文件、超大文件与非 UTF-8 文件，有界读取），
// 并在后台线程池执行磁盘扫描，同时提供在系统文件管理器中打开该目录的命令。
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_FILES: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolPluginFile {
	pub file_name: String,
	pub kind: String,
	pub size: u64,
	pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolPluginScan {
	pub dir: String,
	pub files: Vec<ProtocolPluginFile>,
	pub truncated: bool,
}

fn classify_extension(file_name: &str) -> Option<&'static str> {
	let ext = Path::new(file_name).extension()?.to_str()?;
	if ext.eq_ignore_ascii_case("json") {
		Some("json")
	} else if ext.eq_ignore_ascii_case("js") {
		Some("js")
	} else {
		None
	}
}

fn read_regular_file_bounded(path: &Path) -> Option<(u64, String)> {
	// 打开前先用 symlink_metadata 排除符号链接与非常规文件
	let pre_meta = std::fs::symlink_metadata(path).ok()?;
	if pre_meta.file_type().is_symlink() || !pre_meta.file_type().is_file() || pre_meta.len() > MAX_FILE_BYTES {
		return None;
	}
	let file = std::fs::File::open(path).ok()?;
	// 打开后再次校验句柄元数据并按 MAX_FILE_BYTES + 1 有界读取
	let meta = file.metadata().ok()?;
	if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
		return None;
	}
	let mut bytes = Vec::with_capacity((meta.len() as usize).min(64 * 1024));
	file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
	let size = bytes.len() as u64;
	if size > MAX_FILE_BYTES {
		return None;
	}
	let content = String::from_utf8(bytes).ok()?;
	Some((size, content))
}

pub fn scan_protocols_dir(dir: &Path) -> Result<ProtocolPluginScan, String> {
	let dir_str = dir.to_string_lossy().to_string();
	let dir_meta = match std::fs::symlink_metadata(dir) {
		Ok(m) => m,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
			return Ok(ProtocolPluginScan {
				dir: dir_str,
				files: Vec::new(),
				truncated: false,
			});
		}
		Err(e) => return Err(format!("读取协议插件目录信息失败: {e}")),
	};
	if dir_meta.file_type().is_symlink() {
		return Err("协议插件目录不允许为符号链接".to_string());
	}
	if !dir_meta.file_type().is_dir() {
		return Err("协议插件路径不是有效目录".to_string());
	}

	let rd = std::fs::read_dir(dir).map_err(|e| format!("读取协议插件目录失败: {e}"))?;
	let mut candidates: Vec<(String, &'static str, PathBuf)> = Vec::new();

	for entry in rd {
		let Ok(entry) = entry else { continue };
		let os_name = entry.file_name();
		let Some(file_name) = os_name.to_str() else { continue };
		if file_name.starts_with('.') {
			continue;
		}
		let Some(kind) = classify_extension(file_name) else { continue };
		let path = entry.path();
		let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
		let ft = meta.file_type();
		if ft.is_symlink() || !ft.is_file() {
			continue;
		}
		if meta.len() > MAX_FILE_BYTES {
			continue;
		}
		candidates.push((file_name.to_string(), kind, path));
	}

	candidates.sort_by(|a, b| a.0.cmp(&b.0));

	let mut files = Vec::new();
	let mut truncated = false;
	for (file_name, kind, path) in candidates {
		if files.len() >= MAX_FILES {
			truncated = true;
			break;
		}
		let Some((size, content)) = read_regular_file_bounded(&path) else { continue };
		files.push(ProtocolPluginFile {
			file_name,
			kind: kind.to_string(),
			size,
			content,
		});
	}

	Ok(ProtocolPluginScan { dir: dir_str, files, truncated })
}

fn protocols_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
	Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("protocols"))
}

#[tauri::command]
pub async fn protocol_plugins_list(app: tauri::AppHandle) -> Result<ProtocolPluginScan, String> {
	let dir = protocols_dir(&app)?;
	tokio::task::spawn_blocking(move || scan_protocols_dir(&dir))
		.await
		.map_err(|e| format!("扫描协议插件目录任务异常: {e}"))?
}

#[tauri::command]
pub fn protocol_plugins_open_dir(app: tauri::AppHandle) -> Result<String, String> {
	let dir = protocols_dir(&app)?;
	if let Ok(meta) = std::fs::symlink_metadata(&dir) {
		if meta.file_type().is_symlink() {
			return Err("协议插件目录不允许为符号链接".to_string());
		}
	}
	std::fs::create_dir_all(&dir).map_err(|e| format!("创建协议插件目录失败: {e}"))?;
	let dir_str = dir.to_string_lossy().to_string();
	app.opener()
		.open_path(dir_str.as_str(), None::<&str>)
		.map_err(|e| format!("打开协议插件目录失败: {e}"))?;
	Ok(dir_str)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::atomic::{AtomicU64, Ordering};

	struct TempDir {
		path: PathBuf,
	}

	impl TempDir {
		fn new(tag: &str) -> Self {
			static SEQ: AtomicU64 = AtomicU64::new(1);
			let n = SEQ.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir().join(format!(
				"serial-debug-proto-plugins-{tag}-{}-{n}",
				std::process::id()
			));
			let _ = std::fs::remove_dir_all(&path);
			std::fs::create_dir_all(&path).expect("create temp dir");
			Self { path }
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.path);
		}
	}

	#[test]
	fn returns_empty_when_dir_does_not_exist() {
		let tmp = TempDir::new("missing");
		let missing = tmp.path.join("protocols");
		let scan = scan_protocols_dir(&missing).expect("missing dir should succeed");
		assert_eq!(scan.dir, missing.to_string_lossy());
		assert!(scan.files.is_empty());
		assert!(!scan.truncated);
	}

	#[test]
	fn scans_json_and_js_sorted_and_filters_invalid_entries() {
		let tmp = TempDir::new("filter");
		std::fs::write(tmp.path.join("b-sensor.json"), "{\"id\":\"b\"}").unwrap();
		std::fs::write(tmp.path.join("a-echo.JS"), "// js").unwrap();
		std::fs::write(tmp.path.join("c-upper.JSON"), "{\"id\":\"c\"}").unwrap();
		std::fs::write(tmp.path.join(".hidden.json"), "{}").unwrap();
		std::fs::write(tmp.path.join(".hidden.js"), "// hidden").unwrap();
		std::fs::write(tmp.path.join("readme.txt"), "ignore").unwrap();
		std::fs::write(tmp.path.join("invalid-utf8.js"), [0xff, 0xfe, 0x00]).unwrap();
		std::fs::write(tmp.path.join("too-big.json"), vec![b' '; (MAX_FILE_BYTES + 1) as usize]).unwrap();
		std::fs::write(tmp.path.join("exact-limit.js"), vec![b'a'; MAX_FILE_BYTES as usize]).unwrap();

		// 子目录（含 .json 结尾目录与内部文件）必须跳过
		let sub = tmp.path.join("nested.json");
		std::fs::create_dir_all(&sub).unwrap();
		std::fs::write(sub.join("inner.json"), "{\"id\":\"inner\"}").unwrap();

		let scan = scan_protocols_dir(&tmp.path).expect("scan should succeed");
		let names: Vec<&str> = scan.files.iter().map(|f| f.file_name.as_str()).collect();
		assert_eq!(names, vec!["a-echo.JS", "b-sensor.json", "c-upper.JSON", "exact-limit.js"]);
		assert!(!scan.truncated);
		assert_eq!(scan.files[0].kind, "js");
		assert_eq!(scan.files[0].content, "// js");
		assert_eq!(scan.files[1].kind, "json");
		assert_eq!(scan.files[2].kind, "json");
		assert_eq!(scan.files[3].size, MAX_FILE_BYTES);
	}

	#[test]
	fn caps_scan_at_64_files_in_lex_order() {
		let tmp = TempDir::new("cap");
		for i in 0..70 {
			std::fs::write(tmp.path.join(format!("p-{i:03}.json")), format!("{{\"i\":{i}}}")).unwrap();
		}
		let scan = scan_protocols_dir(&tmp.path).expect("scan should succeed");
		assert_eq!(scan.files.len(), MAX_FILES);
		assert!(scan.truncated);
		assert_eq!(scan.files.first().unwrap().file_name, "p-000.json");
		assert_eq!(scan.files.last().unwrap().file_name, "p-063.json");
	}

	#[cfg(unix)]
	#[test]
	fn skips_symlinks_and_rejects_symlink_dir() {
		let tmp = TempDir::new("symlink");
		let outside = TempDir::new("outside");
		let target = outside.path.join("real.json");
		std::fs::write(&target, "{\"id\":\"ext\"}").unwrap();
		std::os::unix::fs::symlink(&target, tmp.path.join("link.json")).unwrap();
		std::fs::write(tmp.path.join("local.json"), "{\"id\":\"local\"}").unwrap();

		let scan = scan_protocols_dir(&tmp.path).expect("scan should succeed");
		let names: Vec<&str> = scan.files.iter().map(|f| f.file_name.as_str()).collect();
		assert_eq!(names, vec!["local.json"]);
		assert!(!scan.truncated);

		// 目录自身为符号链接时直接拒绝
		let link_dir = tmp.path.join("dir-link");
		std::os::unix::fs::symlink(&outside.path, &link_dir).unwrap();
		let err = scan_protocols_dir(&link_dir).expect_err("symlink dir must be rejected");
		assert!(err.contains("符号链接"));
	}
}
