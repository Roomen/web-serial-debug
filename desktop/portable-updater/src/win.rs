// Windows 便携版更新的执行体：主程序退出后替换 EXE、清理、重启。
// 只接受一个参数(计划文件绝对路径)，不解释命令行、不调用 shell、不接受网页给的地址。
// 更新载荷在这里用编译期内嵌的公钥再验一次签名，验不过就不碰任何文件。
use crate::disposition::{self, steps, Outcome};
use crate::swap;
use portable_update_common as common;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 由 build.rs 从构建环境注入；没有配置签名时为空，helper 会拒绝所有更新
const PUBKEY: &str = env!("SERIAL_UPDATER_PUBKEY");

/// 只认一个普通文件路径参数：不做引号解析、不支持开关，避免把参数当命令解释
fn plan_argument() -> Result<PathBuf, String> {
	let mut args: Vec<OsString> = std::env::args_os().skip(1).collect();
	if args.len() != 1 {
		return Err("更新助手参数无效".into());
	}
	let text = args.pop().unwrap().to_string_lossy().into_owned();
	if text.starts_with('-') || text.contains('\0') {
		return Err("更新助手参数无效".into());
	}
	let path = PathBuf::from(&text);
	if !path.is_absolute() {
		return Err("更新助手的计划路径必须是绝对路径".into());
	}
	Ok(path)
}

fn read_plan(path: &Path) -> Result<common::Plan, String> {
	let data = std::fs::read(path).map_err(|e| format!("无法读取更新计划：{e}"))?;
	if data.len() > 64 * 1024 {
		return Err("更新计划过大".into());
	}
	let plan: common::Plan = serde_json::from_slice(&data).map_err(|e| format!("更新计划格式错误：{e}"))?;
	common::validate_plan(&plan, path)?;
	Ok(plan)
}

fn read_payload(plan: &common::Plan) -> Result<Vec<u8>, String> {
	let meta = std::fs::metadata(&plan.payload).map_err(|e| format!("无法读取更新包：{e}"))?;
	if meta.len() == 0 || meta.len() > common::MAX_PAYLOAD_BYTES {
		return Err("更新包大小异常".into());
	}
	std::fs::read(&plan.payload).map_err(|e| format!("无法读取更新包：{e}"))
}

fn extract_program(payload: &[u8]) -> Result<Vec<u8>, String> {
	let files = common::payload::extract(payload, &[common::EXE_ENTRY], &common::payload::LIMITS)?;
	files.get(common::EXE_ENTRY).cloned().ok_or_else(|| "更新包里缺少主程序".to_string())
}

fn optional_file(payload: &[u8], name: &str) -> Option<Vec<u8>> {
	common::payload::extract(payload, &[name], &common::payload::LIMITS)
		.ok()
		.and_then(|mut files| files.remove(name))
}

// 被替换的文件：主程序必须成功，说明文件与 helper 是附带内容(失败不影响已经就位的新程序)。
// helper 也一并换掉：旧版本安装目录里那份会一直陈旧，下次更新用的仍是载荷里取出的新 helper。
fn extra_file(plan: &common::Plan, name: &str, bytes: &[u8], suffix: &str) {
	let store = swap::FsStore;
	let _ = swap::apply(&store, &plan.install_dir.join(name), bytes, &format!("{}{suffix}", plan.operation_id));
}

fn perform(plan: &common::Plan) -> Result<(), String> {
	let store = swap::FsStore;
	let bases = [plan.exe_name.as_str(), common::README_ENTRY, common::HELPER_FILE];
	swap::sweep_leftovers(&store, &plan.install_dir, &bases, &plan.operation_id);
	let payload = read_payload(plan)?;
	// 载荷签名是唯一信任来源：公钥内嵌在 helper 里，签名与目标版本都要对得上
	common::signature::verify_payload(&payload, &plan.signature, PUBKEY, &plan.version)?;
	let program = extract_program(&payload)?;
	let readme = optional_file(&payload, common::README_ENTRY);
	let helper = optional_file(&payload, common::HELPER_FILE);
	let timeout = Duration::from_millis(common::clamp_wait_timeout(plan.wait_timeout_ms));
	common::proc::wait_for_exit(&plan.install_dir, &plan.exe_name, timeout)?;
	let exe = plan.install_dir.join(&plan.exe_name);
	swap::apply(&store, &exe, &program, &plan.operation_id)?;
	if let Some(readme) = readme {
		extra_file(plan, common::README_ENTRY, &readme, "r");
	}
	// 运行中的 helper 是暂存目录里那份，安装目录里的这份可以安全替换
	if let Some(helper) = helper {
		extra_file(plan, common::HELPER_FILE, &helper, "h");
	}
	Ok(())
}

/// 更新结束后把结果写进应用数据目录，并启动(新版或回滚后的旧版)程序。
/// 写不写结果、清不清标记、要不要重启由 disposition::steps 决定。
fn finish(plan: &common::Plan, outcome: Outcome) -> i32 {
	let steps = steps(&outcome);
	if steps.write_result {
		let result = match &outcome {
			Outcome::Performed(result) => common::UpdateResult {
				format: common::FORMAT,
				success: result.is_ok(),
				version: plan.version.clone(),
				message: result.as_ref().err().cloned().unwrap_or_default(),
				at: common::unix_ms(),
			},
			// steps() 不会让 Skipped 走到这里；留一份保守结果，避免 panic
			Outcome::Skipped(reason) => common::UpdateResult {
				format: common::FORMAT,
				success: false,
				version: plan.version.clone(),
				message: reason.clone(),
				at: common::unix_ms(),
			},
		};
		// 结果写不下来也要继续(程序本身已经替换完成或已经回滚)，但失败的更新不能连原因都丢：
		// 页面读不到结果文件，就用原生消息框告诉用户
		if common::write_result(&plan.data_dir, &result).is_err() && !result.success {
			common::proc::message_box(&format!("更新未完成：{}\n\n已保留原版本，可继续使用。", result.message));
		}
	}
	if steps.clear_marker {
		// 只清本次的标记，别把别的轮次的标记删掉
		if common::read_marker(&plan.data_dir).is_some_and(|marker| marker.operation_id == plan.operation_id) {
			common::remove_marker(&plan.data_dir);
		}
	}
	if steps.cleanup_staging {
		common::cleanup_staging(&common::staging_dir(&plan.data_dir, &plan.operation_id));
	}
	if !steps.restart {
		eprintln!("跳过本次更新");
		return 3;
	}
	let exe = plan.install_dir.join(&plan.exe_name);
	// 不要继承 helper 的句柄：控制台程序会借它一直占着调用方的管道
	let spawned = std::process::Command::new(&exe)
		.current_dir(&plan.install_dir)
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.spawn();
	match (&outcome, spawned) {
		(Outcome::Skipped(_), _) => 3,
		(Outcome::Performed(Ok(())), Ok(_)) => 0,
		(Outcome::Performed(Err(_)), Ok(_)) => 1,
		(Outcome::Performed(result), Err(e)) => {
			let text = match result {
				Ok(()) => format!("更新已安装，但无法自动启动新版本({e})。请手动运行：\n{}", exe.display()),
				Err(reason) => format!("更新未完成：{reason}\n\n已保留原版本，请手动运行：\n{}", exe.display()),
			};
			common::proc::message_box(&text);
			1
		}
	}
}

pub fn run() -> i32 {
	let plan_path = match plan_argument() {
		Ok(path) => path,
		Err(e) => {
			common::proc::message_box(&e);
			return 2;
		}
	};
	let plan = match read_plan(&plan_path) {
		Ok(plan) => plan,
		Err(e) => {
			common::proc::message_box(&format!("{e}\n\n已保留原版本，可继续使用。"));
			return 2;
		}
	};
	let lock = match common::lock::Lock::acquire(&plan.data_dir) {
		Ok(lock) => lock,
		// 拿不到锁：另一个 helper 正在处理同一个安装目录。什么都不动，由它负责收尾与重启。
		Err(e) => return finish(&plan, Outcome::Skipped(e)),
	};
	// 拿到锁之后才改写标记：让新启动的实例等到我们这里才放行。拿不到锁时不能改，
	// 否则会把别人那次更新的标记 pid 换成自己的，我们一退出就成了「死 pid」。
	let marked = match common::read_marker(&plan.data_dir) {
		Some(mut marker) if marker.operation_id == plan.operation_id => {
			marker.helper_pid = Some(std::process::id());
			marker.at = common::unix_ms();
			common::write_marker(&plan.data_dir, &marker)
		}
		// 标记丢了或不是本次的：补一个只有 helper pid 的，保证替换期间新实例起不来
		_ => common::write_marker(
			&plan.data_dir,
			&common::Marker {
				format: common::FORMAT,
				operation_id: plan.operation_id.clone(),
				pid: 0,
				helper_pid: Some(std::process::id()),
				at: common::unix_ms(),
			},
		),
	};
	if let Err(e) = marked {
		// 标记写不进去就不替换：替换期间没有标记，新实例会起来和本进程抢同一个 EXE
		drop(lock);
		let text = format!("无法记录更新状态({e})，已取消本次更新，当前版本可继续使用。");
		common::proc::message_box(&text);
		return 2;
	}
	disposition::execute(lock, || perform(&plan), |outcome| finish(&plan, outcome))
}
