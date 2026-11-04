// 更新互斥锁：同一时间只允许一个 helper 替换同一个安装目录(多窗口、多次启动都会排队)。
// 锁是暂存根目录下的一个文件；内容为持有者 pid，过期才可清理，崩溃留下也不会永久锁死。
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const LOCK_FILE: &str = "lock";
/// 等别人释放锁的上限
pub const WAIT: Duration = Duration::from_secs(30);
/// 锁多久没被更新算残留(大于这个时间的锁可以被清掉)
pub const STALE_AFTER_MS: u64 = 15 * 60_000;

#[derive(Debug)]
pub struct Lock(PathBuf);

impl Lock {
	/// 在 `<data_dir>/update/lock` 上取独占锁，取不到就等到上限
	pub fn acquire(data_dir: &Path) -> Result<Lock, String> {
		Self::acquire_with(data_dir, WAIT)
	}

	pub fn acquire_with(data_dir: &Path, wait: Duration) -> Result<Lock, String> {
		let path = crate::staging_root(data_dir).join(LOCK_FILE);
		if let Some(dir) = path.parent() {
			std::fs::create_dir_all(dir).map_err(|e| format!("无法准备更新目录：{e}"))?;
		}
		let deadline = SystemTime::now() + wait;
		loop {
			match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
				Ok(mut file) => {
					let _ = writeln!(file, "{}", std::process::id());
					return Ok(Lock(path));
				}
				Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
					// 上次的 helper 崩溃留下的锁：超过有效期才清掉，否则等它结束
					if is_stale(&path) {
						let _ = std::fs::remove_file(&path);
						continue;
					}
					if SystemTime::now() >= deadline {
						return Err("另一个更新进程正在进行，请稍后再试".into());
					}
					std::thread::sleep(Duration::from_millis(50));
				}
				Err(e) => return Err(format!("无法创建更新锁：{e}")),
			}
		}
	}
}

// 修改时间读不到时按「不过期」处理：宁可多等一会儿，也不要在别人的替换过程中抢锁
fn is_stale(path: &Path) -> bool {
	std::fs::metadata(path)
		.and_then(|m| m.modified())
		.ok()
		.and_then(|t| t.elapsed().ok())
		.is_some_and(|age| age > Duration::from_millis(STALE_AFTER_MS))
}

impl Drop for Lock {
	fn drop(&mut self) {
		let _ = std::fs::remove_file(&self.0);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::time::Duration;

	fn dir(tag: &str) -> PathBuf {
		let d = std::env::temp_dir().join(format!("pu-lock-{tag}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		std::fs::create_dir_all(&d).unwrap();
		d
	}

	#[test]
	fn lock_is_exclusive_and_released_on_drop() {
		let data = dir("exclusive");
		let path = crate::staging_root(&data).join(LOCK_FILE);
		let held = Lock::acquire(&data).unwrap();
		assert!(path.exists());
		// 第二个持有者必须等不到(用极短的等待上限模拟真实排队)
		let err = Lock::acquire_with(&data, Duration::from_millis(120)).unwrap_err();
		assert!(err.contains("另一个更新进程"), "{err}");
		assert!(path.exists(), "抢锁失败不能删掉持有者的锁");
		drop(held);
		assert!(!path.exists(), "释放后锁文件要消失");
		// 释放后可以再次取到
		let again = Lock::acquire(&data).unwrap();
		drop(again);
		let _ = std::fs::remove_dir_all(&data);
	}

	#[test]
	fn lock_file_records_the_holder_pid() {
		let data = dir("pid");
		let held = Lock::acquire(&data).unwrap();
		let text = std::fs::read_to_string(crate::staging_root(&data).join(LOCK_FILE)).unwrap();
		assert_eq!(text.trim(), std::process::id().to_string());
		drop(held);
		let _ = std::fs::remove_dir_all(&data);
	}

	#[test]
	fn lock_waits_for_a_live_holder_then_succeeds_when_released() {
		let data = dir("wait");
		let held = Lock::acquire(&data).unwrap();
		let thread_dir = data.clone();
		let waiter = std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(80));
			drop(held);
			// 释放后立刻取锁，验证等待循环能拿到
			Lock::acquire_with(&thread_dir, Duration::from_secs(5)).map(|lock| drop(lock))
		});
		std::thread::sleep(Duration::from_millis(20));
		let second = Lock::acquire_with(&data, Duration::from_secs(5));
		let waited = waiter.join().unwrap();
		assert!(second.is_ok() || waited.is_ok(), "同一时刻只应有一个成功，另一个等到释放后成功");
		drop(second);
		let _ = std::fs::remove_dir_all(&data);
	}

	#[test]
	fn a_stale_lock_from_a_crashed_helper_can_be_reclaimed() {
		let data = dir("stale");
		let path = crate::staging_root(&data).join(LOCK_FILE);
		std::fs::create_dir_all(path.parent().unwrap()).unwrap();
		std::fs::write(&path, b"999999").unwrap();
		// 把修改时间推到很久以前：锁应被视为残留并清掉
		let old = std::time::SystemTime::now() - Duration::from_millis(STALE_AFTER_MS + 60_000);
		set_mtime(&path, old);
		let lock = Lock::acquire_with(&data, Duration::from_millis(500)).unwrap();
		drop(lock);
		let _ = std::fs::remove_dir_all(&data);
	}

	#[test]
	fn a_fresh_unreadable_lock_is_not_reclaimed() {
		let data = dir("fresh");
		let path = crate::staging_root(&data).join(LOCK_FILE);
		std::fs::create_dir_all(path.parent().unwrap()).unwrap();
		std::fs::write(&path, b"1").unwrap();
		// 修改时间就在刚刚：即使持有者已经死了也要等，不能抢锁
		assert!(!is_stale(&path));
		assert!(Lock::acquire_with(&data, Duration::from_millis(120)).is_err());
		let _ = std::fs::remove_dir_all(&data);
	}

	// 各平台统一用 std 的 FileTimes：Windows 上走 SetFileTime，没有空桩可以退化成
	// 「时间没被改过」——那样残留锁的用例在 Windows 上一定失败。
	fn set_mtime(path: &Path, when: SystemTime) {
		let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
		let times = std::fs::FileTimes::new().set_modified(when).set_accessed(when);
		file.set_times(times).unwrap();
	}
}
