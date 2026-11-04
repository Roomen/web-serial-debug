// 主程序的替换：写入 → 改名备份 → 换上新文件 → 回读核对，任一步失败都恢复旧程序。
// 所有文件操作都经 Store，测试可以注入「占用 / 权限不足 / 磁盘写失败」这类 Windows 才有的错误。
// 本文件只用 std，非 Windows 平台也会编译(用于本机跑下面的单元测试)，因此在那里允许未使用。
#![cfg_attr(not(windows), allow(dead_code))]

use std::io;
use std::path::{Path, PathBuf};

pub trait Store {
	fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
	fn create(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
	fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
	fn remove(&self, path: &Path) -> io::Result<()>;
	fn exists(&self, path: &Path) -> bool;
	fn list(&self, dir: &Path) -> io::Result<Vec<String>>;
}

pub struct FsStore;

impl Store for FsStore {
	fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
		std::fs::read(path)
	}
	fn create(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
		use std::io::Write;
		let mut file = std::fs::File::create(path)?;
		file.write_all(bytes)?;
		file.sync_all()
	}
	fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		std::fs::rename(from, to)
	}
	fn remove(&self, path: &Path) -> io::Result<()> {
		std::fs::remove_file(path)
	}
	fn exists(&self, path: &Path) -> bool {
		path.exists()
	}
	fn list(&self, dir: &Path) -> io::Result<Vec<String>> {
		let mut names = Vec::new();
		for entry in std::fs::read_dir(dir)? {
			names.push(entry?.file_name().to_string_lossy().into_owned());
		}
		Ok(names)
	}
}

fn sibling(target: &Path, suffix: &str) -> PathBuf {
	let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("app.exe");
	target.with_file_name(format!("{name}.{suffix}"))
}

pub fn staged_path(target: &Path, operation_id: &str) -> PathBuf {
	sibling(target, &format!("new-{operation_id}"))
}
pub fn backup_path(target: &Path, operation_id: &str) -> PathBuf {
	sibling(target, &format!("old-{operation_id}"))
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
	a.len() == b.len() && a == b
}

/// 把备份放回主程序位置。每一步都看结果：先删掉可能已经就位的新文件
/// (Windows 上 rename 到已存在的路径会直接失败)，再改名，最后确认主程序又回来了。
/// 失败时备份一定还在，调用方可以把它的路径告诉用户。
fn restore(store: &impl Store, target: &Path, backup: &Path) -> Result<(), String> {
	if store.exists(target) {
		store.remove(target).map_err(|e| format!("无法移除未能使用的文件：{e}"))?;
	}
	store.rename(backup, target).map_err(|e| format!("无法放回原程序：{e}"))?;
	if !store.exists(target) {
		return Err("放回原程序后文件不存在".into());
	}
	Ok(())
}

/// 回滚后的错误描述：恢复成功就说恢复了；恢复失败要把备份路径给出来，
/// 不能让用户以为已经回到旧版。
fn rollback(store: &impl Store, target: &Path, backup: &Path, reason: String) -> String {
	match restore(store, target, backup) {
		Ok(()) => format!("{reason}，已恢复原版本"),
		Err(e) => format!("{reason}，且原版本还原失败({e})；旧程序备份保留在 {}，可手动改回原名", backup.display()),
	}
}

/// 用 `bytes` 替换 `target`。成功时旧文件已删除；失败时尽力保证 `target` 仍可运行。
pub fn apply(store: &impl Store, target: &Path, bytes: &[u8], operation_id: &str) -> Result<(), String> {
	let staged = staged_path(target, operation_id);
	let backup = backup_path(target, operation_id);
	if !store.exists(target) {
		return Err("主程序不存在，可能已被移动或删除".into());
	}
	// 1. 先落新文件并回读核对：写不进去(磁盘满、目录只读、被杀软占用)时旧程序一点没动
	if let Err(e) = store.create(&staged, bytes) {
		// 可能已写出半截文件：清掉，但不影响旧程序
		let _ = store.remove(&staged);
		return Err(format!("无法写入新版本文件：{e}"));
	}
	let written = match store.read(&staged) {
		Ok(bytes) => bytes,
		Err(e) => {
			let _ = store.remove(&staged);
			return Err(format!("无法校验新版本文件：{e}，已保留原程序"));
		}
	};
	if !same_bytes(&written, bytes) {
		let _ = store.remove(&staged);
		return Err("写入的新版本文件与更新包内容不一致，已保留原程序".into());
	}
	// 2. 旧程序改名做备份
	if let Err(e) = store.rename(target, &backup) {
		let _ = store.remove(&staged);
		return Err(format!("无法替换正在使用的程序，请先退出所有 Serial Debug 窗口：{e}"));
	}
	// 3. 新程序就位
	if let Err(e) = store.rename(&staged, target) {
		let _ = store.remove(&staged);
		return Err(rollback(store, target, &backup, format!("无法放置新版本程序({e})")));
	}
	// 4. 就位后再核对一次：改名成功但内容被改写(杀软、磁盘错误)也算替换失败，回滚
	match store.read(target) {
		Ok(placed) if same_bytes(&placed, bytes) => {}
		Ok(_) => return Err(rollback(store, target, &backup, "新版本程序写入后校验失败".into())),
		Err(e) => return Err(rollback(store, target, &backup, format!("无法读取新版本程序({e})"))),
	}
	// 5. 备份删除失败只是留下一个副本，不影响本次更新
	let _ = store.remove(&backup);
	Ok(())
}

/// 清理上次中断留下的临时文件。`bases` 是会被替换的文件名(主程序、说明文件、helper)。
/// 只删 `<名字>.new-*`，而且必须主程序还在：主程序不见了说明上次中断在「已备份、未就位」之间，
/// 此时任何副本都可能是唯一可运行的版本。`.old-*` 一律不动：那是别的轮次里的旧程序，
/// 删除是无必要的数据丢失。
pub fn sweep_leftovers(store: &impl Store, dir: &Path, bases: &[&str], keep_operation: &str) {
	let Ok(names) = store.list(dir) else { return };
	let Some(exe_name) = bases.first() else { return };
	if !store.exists(&dir.join(exe_name)) {
		return;
	}
	for name in names {
		if !bases.iter().any(|base| name.starts_with(&format!("{base}.new-"))) || name.contains(keep_operation) {
			continue;
		}
		let _ = store.remove(&dir.join(name));
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::cell::{Cell, RefCell};
	use std::collections::HashSet;

	// 可注入故障的文件系统：模拟 Windows 上的文件占用、权限不足与读失败
	struct Faulty {
		inner: FsStore,
		fail_rename_from: RefCell<Option<String>>,
		fail_rename_to: RefCell<Option<String>>,
		fail_remove: RefCell<Option<String>>,
		reads: Cell<u32>,
		read_fail_after: Cell<Option<u32>>,
	}
	impl Faulty {
		fn new() -> Self {
			Faulty {
				inner: FsStore,
				fail_rename_from: RefCell::new(None),
				fail_rename_to: RefCell::new(None),
				fail_remove: RefCell::new(None),
				reads: Cell::new(0),
				read_fail_after: Cell::new(None),
			}
		}
		fn fail_read_after(&self, n: u32) {
			self.read_fail_after.set(Some(n));
		}
	}
	impl Store for Faulty {
		fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
			let n = self.reads.get() + 1;
			self.reads.set(n);
			if self.read_fail_after.get().is_some_and(|limit| n > limit) {
				return Err(io::Error::new(io::ErrorKind::Other, "read failed"));
			}
			self.inner.read(path)
		}
		fn create(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
			self.inner.create(path, bytes)
		}
		fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
			if self.fail_rename_from.borrow().as_deref() == from.to_str() {
				return Err(io::Error::new(io::ErrorKind::PermissionDenied, "sharing violation"));
			}
			// 只失败一次：模拟「新文件放不进去」，随后的回滚改名仍然可行
			if self.fail_rename_to.borrow().as_deref() == to.to_str() {
				*self.fail_rename_to.borrow_mut() = None;
				return Err(io::Error::new(io::ErrorKind::PermissionDenied, "sharing violation"));
			}
			self.inner.rename(from, to)
		}
		fn remove(&self, path: &Path) -> io::Result<()> {
			if self.fail_remove.borrow().as_deref() == path.to_str() {
				return Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"));
			}
			self.inner.remove(path)
		}
		fn exists(&self, path: &Path) -> bool {
			self.inner.exists(path)
		}
		fn list(&self, dir: &Path) -> io::Result<Vec<String>> {
			self.inner.list(dir)
		}
	}

	// 只让前 n 次读成功，之后返回错内容(用于「就位后校验失败」)
	struct CorruptAfter<'a>(&'a Faulty, Cell<u32>);
	impl Store for CorruptAfter<'_> {
		fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
			let n = self.1.get() + 1;
			self.1.set(n);
			if n > 1 {
				return Ok(vec![9; 3]);
			}
			self.0.read(path)
		}
		fn create(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
			self.0.create(path, bytes)
		}
		fn rename(&self, a: &Path, b: &Path) -> io::Result<()> {
			self.0.rename(a, b)
		}
		fn remove(&self, path: &Path) -> io::Result<()> {
			self.0.remove(path)
		}
		fn exists(&self, path: &Path) -> bool {
			self.0.exists(path)
		}
		fn list(&self, dir: &Path) -> io::Result<Vec<String>> {
			self.0.list(dir)
		}
	}

	fn fixture(tag: &str) -> (PathBuf, PathBuf) {
		let dir = std::env::temp_dir().join(format!("pu-{tag}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let exe = dir.join("Serial Debug.exe");
		std::fs::write(&exe, b"old-exe").unwrap();
		(dir, exe)
	}

	fn names(dir: &Path) -> HashSet<String> {
		std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
	}

	const OP: &str = "0123456789abcdef";

	#[test]
	fn successful_replacement_keeps_no_leftovers() {
		let (dir, exe) = fixture("ok");
		let store = FsStore;
		apply(&store, &exe, b"new-exe", OP).unwrap();
		assert_eq!(std::fs::read(&exe).unwrap(), b"new-exe");
		assert_eq!(names(&dir), HashSet::from(["Serial Debug.exe".to_string()]));
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn successful_replacement_leaves_other_rounds_backups_alone() {
		let (dir, exe) = fixture("other-old");
		std::fs::write(dir.join("Serial Debug.exe.old-deadbeefdeadbeef"), b"previous-round").unwrap();
		apply(&FsStore, &exe, b"new-exe", OP).unwrap();
		assert!(dir.join("Serial Debug.exe.old-deadbeefdeadbeef").exists(), "其它轮次的备份不是本次能确认成功的东西，不能删");
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn locked_old_binary_leaves_the_original_in_place() {
		let (dir, exe) = fixture("locked");
		let store = Faulty::new();
		*store.fail_rename_from.borrow_mut() = Some(exe.to_str().unwrap().to_string());
		let err = apply(&store, &exe, b"new-exe", OP).unwrap_err();
		assert!(err.contains("无法替换"), "{err}");
		assert_eq!(std::fs::read(&exe).unwrap(), b"old-exe");
		assert_eq!(names(&dir), HashSet::from(["Serial Debug.exe".to_string()]));
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn failure_to_place_the_new_file_restores_the_backup() {
		let (dir, exe) = fixture("place");
		let store = Faulty::new();
		*store.fail_rename_to.borrow_mut() = Some(exe.to_str().unwrap().to_string());
		let err = apply(&store, &exe, b"new-exe", OP).unwrap_err();
		assert!(err.contains("已恢复原版本"), "{err}");
		assert_eq!(std::fs::read(&exe).unwrap(), b"old-exe");
		assert_eq!(names(&dir), HashSet::from(["Serial Debug.exe".to_string()]));
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn corrupted_staging_file_is_rejected_before_the_old_binary_is_touched() {
		let (dir, exe) = fixture("corrupt0");
		struct Short<'a>(&'a Faulty);
		impl Store for Short<'_> {
			fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
				let bytes = self.0.read(path)?;
				Ok(bytes[..bytes.len().saturating_sub(1)].to_vec())
			}
			fn create(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
				self.0.create(path, bytes)
			}
			fn rename(&self, a: &Path, b: &Path) -> io::Result<()> {
				self.0.rename(a, b)
			}
			fn remove(&self, path: &Path) -> io::Result<()> {
				self.0.remove(path)
			}
			fn exists(&self, path: &Path) -> bool {
				self.0.exists(path)
			}
			fn list(&self, dir: &Path) -> io::Result<Vec<String>> {
				self.0.list(dir)
			}
		}
		let store = Faulty::new();
		let err = apply(&Short(&store), &exe, b"new-exe", OP).unwrap_err();
		assert!(err.contains("已保留原程序"), "{err}");
		assert_eq!(std::fs::read(&exe).unwrap(), b"old-exe");
		assert_eq!(names(&dir), HashSet::from(["Serial Debug.exe".to_string()]));
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn corrupting_only_after_placement_is_caught_and_rolled_back() {
		let (dir, exe) = fixture("corrupt2");
		let store = Faulty::new();
		let err = apply(&CorruptAfter(&store, Cell::new(0)), &exe, b"new-exe", OP).unwrap_err();
		assert!(err.contains("校验失败") && err.contains("已恢复原版本"), "{err}");
		assert_eq!(std::fs::read(&exe).unwrap(), b"old-exe");
		assert_eq!(names(&dir), HashSet::from(["Serial Debug.exe".to_string()]));
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn read_error_after_placement_rolls_back_and_reports_it() {
		let (dir, exe) = fixture("read-error");
		let store = Faulty::new();
		// 第 1 次读是核对暂存文件，之后(读取已就位的新程序)一律失败
		store.fail_read_after(1);
		let err = apply(&store, &exe, b"new-exe", OP).unwrap_err();
		assert!(err.contains("无法读取新版本程序"), "{err}");
		assert!(err.contains("已恢复原版本"), "回滚成功就必须如实说恢复成功：{err}");
		assert_eq!(std::fs::read(&exe).unwrap(), b"old-exe");
		assert_eq!(names(&dir), HashSet::from(["Serial Debug.exe".to_string()]));
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn read_error_after_placement_with_failed_restore_keeps_the_backup_and_says_so() {
		let (dir, exe) = fixture("read-error-locked");
		let store = Faulty::new();
		store.fail_read_after(1);
		// 删不掉已就位的新文件(被杀软或索引服务占用)：回滚无法完成
		*store.fail_remove.borrow_mut() = Some(exe.to_str().unwrap().to_string());
		let err = apply(&store, &exe, b"new-exe", OP).unwrap_err();
		assert!(err.contains("原版本还原失败"), "不能报成已恢复：{err}");
		let backup = dir.join("Serial Debug.exe.old-0123456789abcdef");
		assert!(err.contains(&backup.display().to_string()), "要告诉用户备份在哪：{err}");
		assert_eq!(std::fs::read(&backup).unwrap(), b"old-exe");
		assert_eq!(std::fs::read(&exe).unwrap(), b"new-exe", "放不进去的新文件仍在原位，用户可自行改名");
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn leftover_cleanup_only_removes_partial_new_files_while_the_program_exists() {
		let (dir, exe) = fixture("sweep");
		std::fs::write(dir.join("Serial Debug.exe.new-dead"), b"partial").unwrap();
		std::fs::write(dir.join("Serial Debug.exe.new-0123456789abcdef"), b"current").unwrap();
		std::fs::write(dir.join("Serial Debug.exe.old-dead"), b"other-round").unwrap();
		std::fs::write(dir.join("unrelated.txt"), b"keep").unwrap();
		let store = FsStore;
		sweep_leftovers(&store, &dir, &["Serial Debug.exe", "README.txt"], OP);
		assert!(!dir.join("Serial Debug.exe.new-dead").exists(), "半截的新文件可以清");
		assert!(dir.join("Serial Debug.exe.new-0123456789abcdef").exists(), "本轮文件不能删");
		assert!(dir.join("Serial Debug.exe.old-dead").exists(), "别的轮次的备份不能删");
		assert!(dir.join("unrelated.txt").exists());
		// 主程序不见了：连半截的新文件也不能删(它可能是唯一剩下的可运行文件)
		std::fs::remove_file(&exe).unwrap();
		std::fs::write(dir.join("Serial Debug.exe.new-dead2"), b"partial").unwrap();
		sweep_leftovers(&store, &dir, &["Serial Debug.exe", "README.txt"], OP);
		assert!(dir.join("Serial Debug.exe.new-dead2").exists());
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn leftover_cleanup_covers_every_replaced_file_including_readme_and_helper() {
		let (dir, _exe) = fixture("sweep-extra");
		std::fs::write(dir.join("README.txt.new-dead"), b"partial").unwrap();
		std::fs::write(dir.join("serial-debug-updater.exe.new-dead"), b"partial").unwrap();
		std::fs::write(dir.join("README.txt"), b"current").unwrap();
		let store = FsStore;
		sweep_leftovers(&store, &dir, &["Serial Debug.exe", "README.txt", "serial-debug-updater.exe"], OP);
		assert!(!dir.join("README.txt.new-dead").exists(), "说明文件的半成品也要清");
		assert!(!dir.join("serial-debug-updater.exe.new-dead").exists(), "helper 的半成品也要清");
		assert!(dir.join("README.txt").exists(), "正式文件不能动");
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn missing_target_is_reported_without_touching_anything() {
		let (dir, _) = fixture("missing");
		let store = FsStore;
		let err = apply(&store, &dir.join("gone.exe"), b"new", OP).unwrap_err();
		assert!(err.contains("主程序不存在"), "{err}");
		let _ = std::fs::remove_dir_all(&dir);
	}
}
