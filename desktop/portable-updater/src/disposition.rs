// 更新结束后的处置决定（纯逻辑，非 Windows 平台也会编译并被单测覆盖）。
// 关键约束：只有真正拿到锁、可能改动过文件的那一次才写结果、清标记、重启程序；
// 没拿到锁说明另一个 helper 正在处理同一个安装目录，这一次什么都没动，
// 清标记会让新实例绕过启动闸门，启动程序会把别人的替换逼成超时回滚。
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
	/// 执行过替换（成功或已回滚）：文件状态已定
	Performed(Result<(), String>),
	/// 没拿到锁（或计划校验前就失败）：什么都没动
	Skipped(String),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Steps {
	/// 写应用数据目录里的 update-result.json
	pub write_result: bool,
	/// 删掉本次的 update-in-progress.json
	pub clear_marker: bool,
	/// 删掉本次的操作暂存目录
	pub cleanup_staging: bool,
	/// 启动安装目录里的程序
	pub restart: bool,
}

/// 持锁执行「替换 → 收尾」。锁必须覆盖 finish：finish 会写结果、删标记、清暂存、启动程序，
/// 期间另一个 helper 不能拿到锁开始第二轮替换。写成独立函数是为了让「guard 活到 finish 之后」
/// 成为类型层面的事实（lock 按值移入本函数，函数返回时才 Drop），而不是靠肉眼检查 match 分支。
pub fn execute<L, P, F>(lock: L, perform: P, finish: F) -> i32
where
	P: FnOnce() -> Result<(), String>,
	F: FnOnce(Outcome) -> i32,
{
	let outcome = Outcome::Performed(perform());
	let code = finish(outcome);
	// 显式在 finish 之后释放，顺带说明顺序要求
	drop(lock);
	code
}

pub fn steps(outcome: &Outcome) -> Steps {
	match outcome {
		Outcome::Performed(_) => Steps { write_result: true, clear_marker: true, cleanup_staging: true, restart: true },
		Outcome::Skipped(_) => Steps { write_result: false, clear_marker: false, cleanup_staging: false, restart: false },
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::disposition::execute;
	use portable_update_common::lock::Lock;
	use std::time::Duration;

	fn temp_dir(tag: &str) -> std::path::PathBuf {
		let dir = std::env::temp_dir().join(format!("pu-exec-{tag}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		dir
	}

	#[test]
	fn the_update_lock_is_still_held_while_finishing() {
		let dir = temp_dir("held");
		let code = execute(
			Lock::acquire(&dir).expect("取锁失败"),
			|| Ok(()),
			|outcome| {
				assert_eq!(outcome, Outcome::Performed(Ok(())));
				// finish 阶段仍在持锁：此时第二个 helper 必须拿不到锁
				assert!(Lock::acquire_with(&dir, Duration::from_millis(120)).is_err(), "finish 期间锁不能已经释放");
				0
			},
		);
		assert_eq!(code, 0);
		// execute 返回后锁已释放，下一轮更新能正常开始
		drop(Lock::acquire_with(&dir, Duration::from_millis(120)).expect("收尾后锁应已释放"));
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_failed_perform_is_still_finished_under_the_lock() {
		let dir = temp_dir("failed");
		let mut saw_error = false;
		let code = execute(
			Lock::acquire(&dir).expect("取锁失败"),
			|| Err("无法替换".to_string()),
			|outcome| {
				saw_error = matches!(&outcome, Outcome::Performed(Err(_)));
				assert!(Lock::acquire_with(&dir, Duration::from_millis(120)).is_err());
				1
			},
		);
		assert_eq!(code, 1);
		assert!(saw_error);
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_performed_update_writes_the_result_clears_its_marker_and_restarts() {
		let steps = steps(&Outcome::Performed(Ok(())));
		assert_eq!(steps, Steps { write_result: true, clear_marker: true, cleanup_staging: true, restart: true });
	}

	#[test]
	fn a_rolled_back_update_still_reports_and_restarts_the_old_program() {
		let steps = steps(&Outcome::Performed(Err("无法替换".into())));
		assert_eq!(steps, Steps { write_result: true, clear_marker: true, cleanup_staging: true, restart: true });
	}

	#[test]
	fn a_helper_that_never_got_the_lock_touches_nothing() {
		// 锁竞争失败：既不写「更新未完成」的结果(那次更新随后会重启程序并成功)，
		// 也不清标记、不启动程序(启动会占住正在等待实例退出的另一次替换)
		let steps = steps(&Outcome::Skipped("另一个更新进程正在进行".into()));
		assert_eq!(steps, Steps { write_result: false, clear_marker: false, cleanup_staging: false, restart: false });
	}
}
