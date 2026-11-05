// Windows 便携版的应用内更新：下载并验签(由 updater 插件完成) → 写私有暂存目录 → 启动 helper → 退出。
// helper(desktop/portable-updater)在主程序退出后替换 EXE 并重启；它自己再用内嵌公钥复核一次签名。
// mac 的安装包更新仍在 updater.rs 里走插件 install，这里只处理便携 ZIP 的替换路径。
use portable_update_common as common;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
	app.path().app_data_dir().map_err(|_| "无法定位应用数据目录".to_string())
}

// 16 字节随机 hex，作为本次更新的目录名与备份后缀；取不到随机数就不继续(不生成可预测的目录名)
fn new_operation_id() -> Result<String, String> {
	let mut buf = [0u8; 16];
	getrandom::fill(&mut buf).map_err(|_| "无法生成更新标识".to_string())?;
	Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

// 便携 ZIP 里必须有主程序与 helper；两者缺一就不能保证「退出后还能换文件并重启」
pub fn payload_supported(bytes: &[u8]) -> bool {
	common::payload::contains_entry(bytes, common::EXE_ENTRY) && common::payload::contains_entry(bytes, common::HELPER_FILE)
}

// 当前主程序所在目录(便携包解压后的目录)，也是要被替换的目录
fn install_dir(_app: &AppHandle) -> Result<PathBuf, String> {
	let exe = std::env::current_exe().map_err(|_| "无法定位程序所在目录".to_string())?;
	exe.parent().map(Path::to_path_buf).ok_or_else(|| "无法定位程序所在目录".to_string())
}

fn exe_name(_app: &AppHandle) -> Result<String, String> {
	let exe = std::env::current_exe().map_err(|_| "无法定位程序文件".to_string())?;
	exe.file_name().and_then(|n| n.to_str()).map(|n| n.to_string()).ok_or_else(|| "无法定位程序文件".to_string())
}

/// 准备暂存目录：写入已验签的载荷、计划文件，以及从载荷里取出的 helper。
/// 返回计划路径。目录里只有本次更新自己写的东西，失败时整体删掉。
fn stage(app: &AppHandle, bytes: &[u8], signature: &str, version: &str) -> Result<(String, PathBuf, PathBuf), String> {
	let data = data_dir(app)?;
	// 先在创建暂存目录之前把安装位置取好：这些取值失败时还没有任何东西落盘，
	// 否则会留下一个装着载荷与 helper 的暂存目录，等到下次成功启动才被清掉
	let target_dir = install_dir(app)?;
	let target_exe = exe_name(app)?;
	let id = new_operation_id()?;
	let staging = common::staging_dir(&data, &id);
	std::fs::create_dir_all(&staging).map_err(|_| "无法创建更新暂存目录，请确认磁盘空间与权限".to_string())?;
	let cleanup = |staging: &Path| common::cleanup_staging(staging);
	let files = match common::payload::extract(bytes, &[common::EXE_ENTRY, common::HELPER_FILE], &common::payload::LIMITS) {
		Ok(files) => files,
		Err(e) => {
			cleanup(&staging);
			return Err(format!("更新包内容无效：{e}"));
		}
	};
	if let Err(e) = std::fs::write(staging.join(common::PAYLOAD_FILE), bytes) {
		cleanup(&staging);
		return Err(format!("无法写入更新包：{e}"));
	}
	// helper 用载荷里那份：旧版本安装目录里可能还没有 helper
	if let Err(e) = std::fs::write(staging.join(common::HELPER_FILE), &files[common::HELPER_FILE]) {
		cleanup(&staging);
		return Err(format!("无法写入更新助手：{e}"));
	}
	let plan = common::Plan {
		format: common::FORMAT,
		operation_id: id.clone(),
		install_dir: target_dir,
		exe_name: target_exe,
		payload: staging.join(common::PAYLOAD_FILE),
		signature: signature.to_string(),
		data_dir: data.clone(),
		version: version.to_string(),
		wait_timeout_ms: common::DEFAULT_WAIT_TIMEOUT_MS,
	};
	if let Err(e) = common::write_plan(&staging, &plan) {
		cleanup(&staging);
		return Err(format!("无法写入更新计划：{e}"));
	}
	let plan = common::plan_path(&staging);
	Ok((id, staging, plan))
}

// 暂存目录里的 helper 必须与我们刚从载荷里取出的字节一致：启动前再核一次，
// 尽量压缩「写好之后被别的进程换掉」的窗口(同用户权限下无法彻底避免，见 DISTRIBUTION.md)。
fn helper_verified(staging: &Path, bytes: &[u8]) -> bool {
	let path = staging.join(common::HELPER_FILE);
	match std::fs::read(&path) {
		Ok(current) => current == bytes,
		Err(_) => false,
	}
}

fn helper_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
	common::payload::extract(bytes, &[common::HELPER_FILE], &common::payload::LIMITS)?
		.remove(common::HELPER_FILE)
		.ok_or_else(|| "更新包里缺少更新助手".to_string())
}

// 启动 helper 并退出：标记文件让期间新起的实例停下来，避免和替换过程抢同一个 EXE
pub fn launch(app: &AppHandle, bytes: &[u8], signature: &str, version: &str) -> Result<(), String> {
	let data = data_dir(app)?;
	let (id, staging, plan) = stage(app, bytes, signature, version)?;
	let helper = staging.join(common::HELPER_FILE);
	let expected = helper_bytes(bytes)?;
	if !helper_verified(&staging, &expected) {
		common::cleanup_staging(&staging);
		return Err("更新助手校验失败，已取消安装".into());
	}
	let marker = common::Marker { format: common::FORMAT, operation_id: id.clone(), pid: std::process::id(), helper_pid: None, at: common::unix_ms() };
	if let Err(e) = common::write_marker(&data, &marker) {
		common::cleanup_staging(&staging);
		return Err(format!("无法写入更新标记：{e}"));
	}
	// 只传一个绝对路径参数；helper 自己校验计划、不接受任何命令行开关
	match std::process::Command::new(&helper).arg(&plan).current_dir(&staging).spawn() {
		Ok(child) => {
			let mut marker = marker;
			marker.helper_pid = Some(child.id());
			marker.at = common::unix_ms();
			// 补写 helper pid 失败不能让安装停住：helper 拿到锁后会用同一个 id 重写标记，
			// 而这段时间(应用退出 → helper 接管)由 MARKER_GRACE_MS 的宽限挡住新实例。
			// 这里只记日志，不假装成功写入了。
			if let Err(e) = common::write_marker(&data, &marker) {
				eprintln!("app-update: 无法记录更新助手进程号({e})，改由助手启动后自行接管标记");
			}
			Ok(())
		}
		Err(e) => {
			common::remove_marker(&data);
			common::cleanup_staging(&staging);
			Err(format!("无法启动更新助手，已取消安装：{e}"))
		}
	}
}

/// 启动时的更新标记闸门：上一次替换还没结束时不要打开窗口。
/// 返回 true 表示可以继续启动；false 表示已经提示用户并应当退出。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn startup_gate(app: &AppHandle) -> bool {
	let Ok(data) = data_dir(app) else { return true };
	gate(&data, common::proc::pid_alive, |text| common::proc::message_box(text), common::unix_ms())
}

/// 闸门的纯逻辑：先判标记，确认没有活动更新后才清理旧暂存目录。
/// 顺序不能反：更新进行中另起一个实例时清掉暂存会删掉正在用的载荷、计划与锁。
pub fn gate(data: &Path, alive: impl Fn(u32) -> Option<bool>, notify: impl Fn(&str), now: u64) -> bool {
	if let Some(marker) = common::read_marker(data) {
		match common::marker_action(&marker, now, &alive) {
			common::MarkerAction::Block => {
				notify("Serial Debug 正在安装更新，请稍候再打开。\n如果长时间没有反应，请重新运行程序：更新过程会在退出后自动完成或回滚。");
				return false;
			}
			// 已失效的标记：先删标记，再按普通启动清理
			common::MarkerAction::Remove => common::remove_marker(data),
		}
	}
	sweep_staging(data);
	true
}

/// 清掉以前留下的暂存目录。只删「本次工具自己创建、且已确认不活动」的操作目录：
/// 锁文件还在说明可能有 helper 正在跑，整个跳过；文件(锁、杂项)与不是操作 id 的名字都不删；
/// 暂存根目录本身也不是本轮创建的，不删。
fn sweep_staging(data: &Path) {
	let root = common::staging_root(data);
	if root.join(common::lock::LOCK_FILE).exists() {
		return;
	}
	let Ok(entries) = std::fs::read_dir(&root) else { return };
	for entry in entries.flatten() {
		let path = entry.path();
		let meta = match entry.metadata() {
			Ok(meta) => meta,
			Err(_) => continue,
		};
		let name = entry.file_name().to_string_lossy().into_owned();
		// 只删名字是本工具那种操作 id 的目录；文件(锁等)与别的名字都不动
		if meta.is_dir() && common::valid_operation_id(&name) {
			let _ = std::fs::remove_dir_all(&path);
		}
	}
}

/// 读取并删除 helper 留下的更新结果(失败原因要在界面上说清楚)
pub fn take_result(app: &AppHandle) -> Option<common::UpdateResult> {
	let data = data_dir(app).ok()?;
	let result = common::read_result(&data);
	common::remove_result(&data);
	result
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn operation_ids_are_random_hex_of_fixed_length() {
		let id = new_operation_id().unwrap();
		assert_eq!(id.len(), 32);
		assert!(common::valid_operation_id(&id));
		assert_ne!(id, new_operation_id().unwrap());
	}

	// 用真实 ZIP 组合验证「载荷里必须同时有主程序和 helper」
	fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
		use std::io::Write;
		let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
		let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
		for (name, content) in entries {
			writer.start_file(*name, options).unwrap();
			writer.write_all(content).unwrap();
		}
		writer.finish().unwrap().into_inner()
	}

	#[test]
	fn payload_requires_both_program_and_helper() {
		assert!(payload_supported(&zip(&[(common::EXE_ENTRY, b"exe"), (common::HELPER_FILE, b"helper")])));
		assert!(!payload_supported(&zip(&[(common::EXE_ENTRY, b"exe")])));
		assert!(!payload_supported(&zip(&[(common::EXE_ENTRY, b"exe"), ("README.txt", b"readme")])));
		assert!(!payload_supported(b"not a zip"));
	}

	// 更新进行中另起实例：标记还活跃时不能碰暂存目录里的载荷、计划与锁
	fn staging_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
		let data = std::env::temp_dir().join(format!("pu-gate-{tag}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&data);
		let staging = common::staging_dir(&data, "0123456789abcdef");
		std::fs::create_dir_all(&staging).unwrap();
		std::fs::write(staging.join(common::PAYLOAD_FILE), b"payload").unwrap();
		std::fs::write(common::plan_path(&staging), b"plan").unwrap();
		std::fs::create_dir_all(common::staging_root(&data)).unwrap();
		std::fs::write(common::staging_root(&data).join(common::lock::LOCK_FILE), b"100").unwrap();
		(data, staging)
	}

	#[test]
	fn startup_while_an_update_is_running_blocks_and_keeps_staging_intact() {
		let (data, staging) = staging_fixture("active");
		let marker = common::Marker { format: common::FORMAT, operation_id: "0123456789abcdef".into(), pid: 100, helper_pid: Some(200), at: 1_000 };
		common::write_marker(&data, &marker).unwrap();
		let notified = std::cell::RefCell::new(Vec::new());
		let proceed = gate(&data, |pid| if pid == 200 { Some(true) } else { Some(false) }, |t| notified.borrow_mut().push(t.to_string()), 2_000);
		assert!(!proceed, "有活动更新时必须拒绝启动");
		assert_eq!(notified.borrow().len(), 1);
		assert!(staging.join(common::PAYLOAD_FILE).exists(), "正在用的载荷不能被清掉");
		assert!(common::plan_path(&staging).exists(), "正在用的计划不能被清掉");
		assert!(common::staging_root(&data).join(common::lock::LOCK_FILE).exists(), "锁不能被清掉");
		assert!(common::read_marker(&data).is_some(), "标记要留给 helper 自己清");
		let _ = std::fs::remove_dir_all(&data);
	}

	#[test]
	fn startup_runs_cleanup_only_after_the_marker_is_gone() {
		let (data, staging) = staging_fixture("stale");
		// 进程已退出且过了宽限期(刚写下不久的标记仍会挡住启动，见 MARKER_GRACE_MS)：
		// 删标记，随后才清理旧暂存
		let marker = common::Marker { format: common::FORMAT, operation_id: "0123456789abcdef".into(), pid: 100, helper_pid: Some(200), at: 1_000 };
		common::write_marker(&data, &marker).unwrap();
		std::fs::remove_file(common::staging_root(&data).join(common::lock::LOCK_FILE)).unwrap();
		let later = 1_000 + common::MARKER_GRACE_MS + 1;
		assert!(gate(&data, |_| Some(false), |_| {}, later));
		assert!(common::read_marker(&data).is_none());
		assert!(!staging.exists(), "确认不活动后才清操作目录");
		assert!(common::staging_root(&data).exists(), "暂存根目录不是本轮创建的，不能删");
		let _ = std::fs::remove_dir_all(&data);
	}

	#[test]
	fn cleanup_skips_everything_while_a_helper_lock_exists() {
		let (data, staging) = staging_fixture("locked");
		// 没有标记但锁还在：可能有 helper 正要开始，保持不动
		assert!(gate(&data, |_| Some(false), |_| {}, 2_000));
		assert!(gate(&data, |_| Some(false), |_| {}, 1_000 + common::MARKER_GRACE_MS + 1));
		assert!(staging.join(common::PAYLOAD_FILE).exists());
		assert!(common::staging_root(&data).join(common::lock::LOCK_FILE).exists());
		let _ = std::fs::remove_dir_all(&data);
	}

	#[test]
	fn cleanup_never_touches_files_or_foreign_directories() {
		let (data, _) = staging_fixture("foreign");
		let root = common::staging_root(&data);
		std::fs::remove_file(root.join(common::lock::LOCK_FILE)).unwrap();
		std::fs::create_dir_all(root.join("someone-elses-dir")).unwrap();
		std::fs::write(root.join("notes.txt"), b"keep").unwrap();
		assert!(gate(&data, |_| Some(false), |_| {}, 2_000));
		assert!(root.join("someone-elses-dir").exists(), "不是本工具创建的名字不动");
		assert!(root.join("notes.txt").exists(), "文件不动");
		let _ = std::fs::remove_dir_all(&data);
	}

	#[test]
	fn helper_bytes_are_readable_from_the_payload() {
		let data = zip(&[(common::EXE_ENTRY, b"exe"), (common::HELPER_FILE, b"helper-bytes")]);
		assert_eq!(helper_bytes(&data).unwrap(), b"helper-bytes");
	}
}
