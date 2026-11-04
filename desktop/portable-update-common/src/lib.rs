// Windows 便携版应用内更新的共享协议：桌面客户端写「更新计划」，helper 读计划并回写「更新结果」。
// 两边都只认这里定义的文件名、格式版本与校验规则，避免各自拷贝一份后漂移。
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub mod lock;
pub mod payload;
// 进程查询(helper 与桌面客户端共用)：Windows 上是真实实现，其它平台给失败关闭的占位，便于本机跑单测
pub mod proc;
pub mod signature;

/// 计划 / 结果格式版本，任一方不认识就不动作
pub const FORMAT: u32 = 1;
/// helper 在安装目录与暂存目录里的文件名
pub const HELPER_FILE: &str = "serial-debug-updater.exe";
/// 已验签的更新载荷(便携 ZIP)在暂存目录里的文件名
pub const PAYLOAD_FILE: &str = "payload.zip";
/// 计划文件名(helper 从命令行只收这一个绝对路径)
pub const PLAN_FILE: &str = "plan.json";
/// 载荷里主程序条目的固定名字(发布流水线打包时用这个名字)
pub const EXE_ENTRY: &str = "Serial Debug.exe";
/// 载荷里的说明文件条目，可缺省
pub const README_ENTRY: &str = "README.txt";
/// helper 把结果写进应用数据目录，下次启动由客户端读取并删除
pub const RESULT_FILE: &str = "update-result.json";
/// 升级进行中的标记，冻结期间新起的进程据此拒绝继续
pub const IN_PROGRESS_FILE: &str = "update-in-progress.json";
/// 应用数据目录下的暂存根目录，只由更新流程创建与清理
pub const STAGING_DIR: &str = "update";
/// 载荷上限：便携 ZIP 远小于此，防止误读巨型文件
pub const MAX_PAYLOAD_BYTES: u64 = 256 * 1024 * 1024;
/// 单个解压条目上限
pub const MAX_ENTRY_BYTES: u64 = 192 * 1024 * 1024;
/// 等待安装目录内实例退出的默认上限
pub const DEFAULT_WAIT_TIMEOUT_MS: u64 = 60_000;
/// 等待上限的硬上限，避免计划里塞进无限等待
pub const MAX_WAIT_TIMEOUT_MS: u64 = 10 * 60_000;
/// 升级标记的最长有效时间：超过就当作残留，允许新进程继续启动
pub const MARKER_MAX_AGE_MS: u64 = 15 * 60_000;
/// 标记里记的进程已经不在时，仍要先挡住启动一小段时间。应用写完标记、启动 helper、
/// 自己退出之间有几毫秒，helper 拿到锁后会把自己的 pid 写进标记；如果这时恰好有一方
/// 的写失败，标记里留下的是已死掉的 pid。没有这段宽限，新实例会正好在这段时间启动，
/// 和正在替换文件的 helper 抢同一个 EXE。helper 正常结束会删标记，平时不受影响。
pub const MARKER_GRACE_MS: u64 = 60_000;

/// 桌面客户端在启动 helper 前写下的计划
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
	pub format: u32,
	/// 本次更新的标识，同时用于备份文件后缀；只允许小写十六进制
	pub operation_id: String,
	/// 安装目录(主程序所在目录)，只允许替换其中的主程序 / helper / 说明文件
	pub install_dir: PathBuf,
	/// 主程序文件名。用户可能改过名，替换目标按这个名字
	pub exe_name: String,
	/// 已验签载荷的绝对路径，必须位于计划文件所在目录
	pub payload: PathBuf,
	/// 载荷的 minisign 签名(base64，即 .sig 文件内容)，helper 会用内嵌公钥重新校验
	pub signature: String,
	/// 应用数据目录，用于写更新结果
	pub data_dir: PathBuf,
	/// 目标版本，只用于日志与结果展示
	pub version: String,
	/// 等待实例退出的上限(毫秒)
	pub wait_timeout_ms: u64,
}

/// helper 的终局结果；成功后不写文件，失败时写进应用数据目录
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateResult {
	pub format: u32,
	pub success: bool,
	pub version: String,
	pub message: String,
	/// Unix 毫秒时间戳，仅用于展示与判断过期
	pub at: u64,
}

/// 暂存根目录：<应用数据目录>/update
pub fn staging_root(data_dir: &Path) -> PathBuf {
	data_dir.join(STAGING_DIR)
}

/// 本次更新的暂存目录：<应用数据目录>/update/<operation>
pub fn staging_dir(data_dir: &Path, operation_id: &str) -> PathBuf {
	staging_root(data_dir).join(operation_id)
}

/// 计划文件路径，helper 命令行收到的就是它
pub fn plan_path(staging: &Path) -> PathBuf {
	staging.join(PLAN_FILE)
}

/// 只允许小写十六进制，长度固定区间；同时用作目录名与备份后缀
pub fn valid_operation_id(id: &str) -> bool {
	(16..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// Windows 的绝对路径一定带 Prefix(盘符 / UNC / verbatim)，所以只拒绝 . 与 .. 段；
// 两者都出现说明路径可由调用方随意上下跳，不能用来定位待替换的文件
fn is_absolute_clean(path: &Path) -> bool {
	path.is_absolute() && !path.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir))
}

fn valid_version(version: &str) -> bool {
	let mut parts = version.split('.');
	let ok = |s: Option<&str>| s.is_some_and(|s| !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit()));
	ok(parts.next()) && ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// 校验计划。`plan_path` 是 helper 实际读到的计划文件，用来把载荷钉死在同一暂存目录里，
/// 防止计划被改成指向任意路径的文件再交给替换逻辑。
pub fn validate_plan(plan: &Plan, plan_path: &Path) -> Result<(), String> {
	if plan.format != FORMAT {
		return Err("更新计划格式不受支持，请重新检查更新".into());
	}
	if !valid_operation_id(&plan.operation_id) {
		return Err("更新计划标识无效".into());
	}
	if plan_path.file_name().and_then(|n| n.to_str()) != Some(PLAN_FILE) {
		return Err("更新计划文件名无效".into());
	}
	let stage_dir = plan_path.parent().ok_or_else(|| "更新计划路径无效".to_string())?;
	if !is_absolute_clean(&plan.install_dir) || !is_absolute_clean(&plan.payload) || !is_absolute_clean(&plan.data_dir) {
		return Err("更新计划包含无效路径".into());
	}
	if plan.install_dir == stage_dir {
		return Err("安装目录与暂存目录相同".into());
	}
	if plan.install_dir.parent().is_none() {
		return Err("不能更新磁盘根目录里的程序，请把 Serial Debug 放在单独文件夹".into());
	}
	if !plan.install_dir.is_dir() {
		return Err("安装目录不存在或不是文件夹".into());
	}
	let name = Path::new(&plan.exe_name);
	// 文件名必须是一个不含分隔符的普通名字：Windows 上 \\ 与 / 都能分隔、: 还能指向备用数据流，
	// 所以在两种平台上都按字符直接拒绝，而不是只看 Path::components(本机平台不同解读也不同)
	let plain = !plan.exe_name.is_empty()
		&& plan.exe_name.len() <= 128
		&& !plan.exe_name.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
		&& plan.exe_name.bytes().all(|b| b >= 0x20 && b != 0x7f)
		&& plan.exe_name != "."
		&& plan.exe_name != "..";
	if !plain || !matches!(name.components().next(), Some(Component::Normal(_))) || name.components().count() != 1 {
		return Err("主程序文件名无效".into());
	}
	if !plan.exe_name.to_ascii_lowercase().ends_with(".exe") {
		return Err("主程序文件名无效".into());
	}
	if plan.payload.parent() != Some(stage_dir) || plan.payload.file_name().and_then(|n| n.to_str()) != Some(PAYLOAD_FILE) {
		return Err("更新载荷路径无效".into());
	}
	let payload = std::fs::metadata(&plan.payload).map_err(|_| "更新载荷不存在".to_string())?;
	if !payload.is_file() || payload.len() == 0 || payload.len() > MAX_PAYLOAD_BYTES {
		return Err("更新载荷大小无效".into());
	}
	if plan.signature.is_empty() || plan.signature.len() > 16 * 1024 {
		return Err("更新签名无效".into());
	}
	if !valid_version(&plan.version) {
		return Err("目标版本无效".into());
	}
	Ok(())
}

/// 规范化等待上限，计划里给的越界值不直接使用
pub fn clamp_wait_timeout(ms: u64) -> u64 {
	ms.clamp(1_000, MAX_WAIT_TIMEOUT_MS)
}

/// 当前 Unix 毫秒时间戳；系统时间回拨时退回 0，由调用方按「已失效」处理
pub fn unix_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis() as u64)
		.unwrap_or(0)
}

// 原子写：先写同目录下的临时文件再改名。临时名带 pid 与进程内递增序号，
// 让应用与 helper(甚至两个 helper)各写各的临时文件——共用固定 ".tmp" 会互相截断，
// 在 Windows 上改名也可能因对方持有句柄而失败，留下 0 字节的标记文件等于放行新实例。
fn write_json_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
	use std::io::Write;
	use std::sync::atomic::{AtomicU64, Ordering};
	static SEQ: AtomicU64 = AtomicU64::new(0);
	if let Some(dir) = path.parent() {
		std::fs::create_dir_all(dir)?;
	}
	let stamp = format!("{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
	let temp = path.with_extension(format!("tmp-{stamp}"));
	let mut file = std::fs::File::create(&temp)?;
	let result = file.write_all(bytes).and_then(|_| file.sync_all());
	drop(file);
	if result.is_err() {
		let _ = std::fs::remove_file(&temp);
		return result;
	}
	if let Err(e) = std::fs::rename(&temp, path) {
		let _ = std::fs::remove_file(&temp);
		return Err(e);
	}
	Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, limit: u64) -> Option<T> {
	if std::fs::metadata(path).ok()?.len() > limit {
		return None;
	}
	serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub fn marker_path(data_dir: &Path) -> PathBuf {
	data_dir.join(IN_PROGRESS_FILE)
}
pub fn result_path(data_dir: &Path) -> PathBuf {
	data_dir.join(RESULT_FILE)
}

pub fn read_marker(data_dir: &Path) -> Option<Marker> {
	read_json(&marker_path(data_dir), 16 * 1024)
}
pub fn write_marker(data_dir: &Path, marker: &Marker) -> std::io::Result<()> {
	let bytes = serde_json::to_vec(marker)?;
	write_json_atomic(&marker_path(data_dir), &bytes)
}
pub fn remove_marker(data_dir: &Path) {
	let path = marker_path(data_dir);
	let _ = std::fs::remove_file(path.with_extension("tmp"));
	let _ = std::fs::remove_file(path);
}

pub fn read_result(data_dir: &Path) -> Option<UpdateResult> {
	let result: UpdateResult = read_json(&result_path(data_dir), 16 * 1024)?;
	(result.format == FORMAT).then_some(result)
}
pub fn write_result(data_dir: &Path, result: &UpdateResult) -> std::io::Result<()> {
	write_json_atomic(&result_path(data_dir), &serde_json::to_vec(result)?)
}
pub fn remove_result(data_dir: &Path) {
	let path = result_path(data_dir);
	let _ = std::fs::remove_file(path.with_extension("tmp"));
	let _ = std::fs::remove_file(path);
}

pub fn write_plan(staging: &Path, plan: &Plan) -> std::io::Result<()> {
	std::fs::create_dir_all(staging)?;
	write_json_atomic(&plan_path(staging), &serde_json::to_vec(plan)?)
}

/// 只删本次暂存目录(必须是 update/<operationId> 形式)，不碰其它目录；失败不影响更新结果
pub fn cleanup_staging(staging: &Path) {
	let name = staging.file_name().and_then(|n| n.to_str()).unwrap_or("");
	let parent = staging.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");
	if parent != STAGING_DIR || !valid_operation_id(name) {
		return;
	}
	let _ = std::fs::remove_dir_all(staging);
}

/// 升级进行中的标记。冻结后由应用写下(helperPid 在 helper 启动后补上)，helper 结束时删除。
/// 新进程启动时读它：更新正在进行就不允许再开一个实例去碰同一个安装目录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Marker {
	pub format: u32,
	pub operation_id: String,
	/// 发起更新的应用进程
	pub pid: u32,
	/// 真正执行替换的 helper 进程，未启动时为空
	pub helper_pid: Option<u32>,
	pub at: u64,
}

/// 读到标记后该怎么办
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerAction {
	/// 没有标记或已失效，删掉即可
	Remove,
	/// 有进程正在替换文件，不要启动
	Block,
}

/// 判定标记是否仍然活跃。`alive` 拿不到结果(权限不足等)时按「还活着」处理，
/// 宁可拒绝一次启动也不要和正在替换文件的 helper 抢同一个 EXE。
pub fn marker_action(marker: &Marker, now_ms: u64, alive: impl Fn(u32) -> Option<bool>) -> MarkerAction {
	let age = now_ms.saturating_sub(marker.at);
	if marker.format != FORMAT || age > MARKER_MAX_AGE_MS {
		return MarkerAction::Remove;
	}
	match marker.helper_pid.or(Some(marker.pid)) {
		Some(pid) if pid != 0 => match alive(pid) {
			// 判不出来(权限不足等)一律按「还活着」处理
			None => MarkerAction::Block,
			Some(true) => MarkerAction::Block,
			// 进程已不在：刚写下不久的先挡住(启动 helper 的窗口)，之后再清
			Some(false) if age <= MARKER_GRACE_MS => MarkerAction::Block,
			Some(false) => MarkerAction::Remove,
		},
		_ => MarkerAction::Remove,
	}
}

#[cfg(test)]
mod marker_tests {	use super::*;

	fn marker(helper: Option<u32>) -> Marker {
		Marker { format: FORMAT, operation_id: "0123456789abcdef".into(), pid: 100, helper_pid: helper, at: 1_000 }
	}

	#[test]
	fn live_helper_blocks_a_new_start() {
		assert_eq!(marker_action(&marker(Some(200)), 2_000, |_| Some(true)), MarkerAction::Block);
		assert_eq!(marker_action(&marker(None), 2_000, |_| Some(true)), MarkerAction::Block);
	}

	#[test]
	fn a_fresh_marker_with_a_dead_pid_still_blocks_the_startup_window() {
		// 应用写完标记、spawn helper、自己退出；helper 还没把自己的 pid 写进标记。
		// 这时标记里的 pid 已经死了，但替换可能正在进行，新实例必须继续被挡住。
		let fresh = marker(None);
		assert_eq!(marker_action(&fresh, 1_000 + 5, |_| Some(false)), MarkerAction::Block);
		assert_eq!(marker_action(&fresh, 1_000 + MARKER_GRACE_MS, |_| Some(false)), MarkerAction::Block);
		assert_eq!(marker_action(&fresh, 1_000 + MARKER_GRACE_MS + 1, |_| Some(false)), MarkerAction::Remove);
	}

	#[test]
	fn dead_helper_after_the_grace_window_is_cleanable() {
		assert_eq!(marker_action(&marker(Some(200)), 1_000 + MARKER_GRACE_MS + 1, |_| Some(false)), MarkerAction::Remove);
		assert_eq!(marker_action(&marker(Some(200)), 1_000 + MARKER_MAX_AGE_MS + 1, |_| Some(true)), MarkerAction::Remove);
		let mut stale = marker(None);
		stale.format = FORMAT + 1;
		assert_eq!(marker_action(&stale, 2_000, |_| Some(true)), MarkerAction::Remove);
	}

	#[test]
	fn unknown_process_state_blocks_instead_of_assuming_free() {
		assert_eq!(marker_action(&marker(Some(200)), 2_000, |_| None), MarkerAction::Block);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	#[test]
	fn concurrent_marker_writes_never_leave_a_truncated_file() {
		// 应用与 helper 会在毫秒级内先后重写同一个标记：各写各的临时文件再改名，
		// 不能共用固定 ".tmp"(会互相截断，读到 0 字节等于放行新实例)
		let data = std::env::temp_dir().join(format!("pu-marker-race-{}", std::process::id()));
		let _ = fs::remove_dir_all(&data);
		fs::create_dir_all(&data).unwrap();
		let writer = |app: u32| {
			let data = data.clone();
			std::thread::spawn(move || {
				for i in 0..200u64 {
					let marker = Marker { format: FORMAT, operation_id: "0123456789abcdef".into(), pid: app, helper_pid: None, at: i };
					write_marker(&data, &marker).expect("写标记失败");
					// 每次写完都必须能完整读回(允许被另一个写方覆盖成它那版)
					let read = read_marker(&data).expect("标记被写成半截或丢失");
					assert_eq!(read.format, FORMAT);
					assert_eq!(read.operation_id, "0123456789abcdef");
				}
			})
		};
		let a = writer(1);
		let b = writer(2);
		a.join().unwrap();
		b.join().unwrap();
		// 临时文件不能残留在应用数据目录里
		let leftovers: Vec<_> = fs::read_dir(&data)
			.unwrap()
			.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
			.filter(|n| n.contains(".tmp"))
			.collect();
		assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
		let _ = fs::remove_dir_all(&data);
	}

	fn plan(dir: &Path) -> Plan {
		let stage = dir.join("stage");
		let install = dir.join("install");
		let data = dir.join("data");
		fs::create_dir_all(&stage).unwrap();
		fs::create_dir_all(&install).unwrap();
		fs::create_dir_all(&data).unwrap();
		fs::write(stage.join(PAYLOAD_FILE), b"payload").unwrap();
		Plan {
			format: FORMAT,
			operation_id: "0123456789abcdef".into(),
			install_dir: install,
			exe_name: "Serial Debug.exe".into(),
			payload: stage.join(PAYLOAD_FILE),
			signature: "c2ln".into(),
			data_dir: data,
			version: "1.2.3".into(),
			wait_timeout_ms: DEFAULT_WAIT_TIMEOUT_MS,
		}
	}

	#[test]
	fn accepts_a_well_formed_plan() {
		let tmp = std::env::temp_dir().join(format!("puc-{}", std::process::id()));
		let p = plan(&tmp);
		assert_eq!(validate_plan(&p, &p.payload.with_file_name(PLAN_FILE)), Ok(()));
		let _ = fs::remove_dir_all(&tmp);
	}

	#[test]
	fn rejects_payload_outside_the_staging_directory() {
		let tmp = std::env::temp_dir().join(format!("puc-payload-{}", std::process::id()));
		let mut p = plan(&tmp);
		let plan_file = p.payload.with_file_name(PLAN_FILE);
		p.payload = p.install_dir.join(PAYLOAD_FILE);
		assert!(validate_plan(&p, &plan_file).is_err());
		let _ = fs::remove_dir_all(&tmp);
	}

	#[test]
	fn rejects_relative_paths_and_unknown_exe_names() {
		let tmp = std::env::temp_dir().join(format!("puc-rel-{}", std::process::id()));
		let mut p = plan(&tmp);
		let plan_file = p.payload.with_file_name(PLAN_FILE);
		p.install_dir = PathBuf::from("install");
		assert!(validate_plan(&p, &plan_file).is_err());
		let mut p = plan(&tmp);
		p.exe_name = "..\\evil.exe".into();
		assert!(validate_plan(&p, &plan_file).is_err());
		let mut p = plan(&tmp);
		p.exe_name = "Serial Debug.txt".into();
		assert!(validate_plan(&p, &plan_file).is_err());
		let mut p = plan(&tmp);
		p.version = "1.2".into();
		assert!(validate_plan(&p, &plan_file).is_err());
		let _ = fs::remove_dir_all(&tmp);
	}

	#[test]
	fn operation_ids_are_restricted_to_lowercase_hex() {
		assert!(valid_operation_id("0123456789abcdef"));
		assert!(!valid_operation_id("0123456789ABCDEF"));
		assert!(!valid_operation_id("short"));
		assert!(!valid_operation_id(&"a".repeat(65)));
	}

	#[test]
	fn wait_timeout_is_clamped() {
		assert_eq!(clamp_wait_timeout(0), 1_000);
		assert_eq!(clamp_wait_timeout(60_000), 60_000);
		assert_eq!(clamp_wait_timeout(u64::MAX), MAX_WAIT_TIMEOUT_MS);
	}

	#[test]
	fn plan_json_is_deny_unknown_fields() {
		let json = r#"{"format":1,"operationId":"0123456789abcdef","installDir":"/a","exeName":"a.exe","payload":"/b/payload.zip","signature":"x","dataDir":"/c","version":"1.2.3","waitTimeoutMs":1000,"extra":1}"#;
		assert!(serde_json::from_str::<Plan>(json).is_err());
	}
}
