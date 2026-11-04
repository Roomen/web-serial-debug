// Windows 进程查询：等待占用同一安装目录的实例退出、判断标记里的进程是否还活着，
// 以及页面还没起来时的原生提示框。应用端与 helper 共用，避免两处各写一份。
// 任何一处查询失败都按「还无法确认」处理，不能把权限不足当成「没有实例 / 已经退出」。
// 其它平台只给失败关闭的占位实现，让本机也能编译并跑 portable 相关单测。
use std::path::Path;
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE, STILL_ACTIVE};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
	CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
	GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[cfg(windows)]
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
	use std::os::windows::ffi::OsStrExt;
	value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn path_of(pid: u32) -> Result<Option<std::path::PathBuf>, String> {
	unsafe {
		let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		if handle.is_null() {
			let code = GetLastError();
			// 87: 进程在快照之后已经退出，属于正常竞争
			if code == ERROR_INVALID_PARAMETER {
				return Ok(None);
			}
			// 5(拒绝访问)等其它错误：无法确认它是不是同一个安装目录的实例，失败关闭
			return Err(format!("无法查询进程 {pid} 的路径(错误 {code})，请关闭占用程序的其它窗口后重试"));
		}
		let mut buffer = vec![0u16; 32768];
		let mut size = buffer.len() as u32;
		let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size);
		CloseHandle(handle);
		if ok == 0 {
			let code = GetLastError();
			if code == ERROR_INVALID_PARAMETER {
				return Ok(None);
			}
			return Err(format!("无法读取进程 {pid} 的程序路径(错误 {code})，请关闭占用程序的其它窗口后重试"));
		}
		buffer.truncate(size as usize);
		Ok(Some(std::path::PathBuf::from(String::from_utf16_lossy(&buffer))))
	}
}

// 去掉 \\?\ 前缀，统一分隔符与大小写后比对：同一个文件可能以多种写法出现。
// 非 Windows 上只有单测会用(没有实例枚举)，所以那里允许未使用。
#[cfg_attr(not(windows), allow(dead_code))]
fn normalize(path: &Path) -> String {
	let mut text = path.to_string_lossy().replace('/', "\\");
	while let Some(rest) = text.strip_prefix("\\\\?\\") {
		text = rest.to_string();
	}
	text.trim_end_matches('\\').to_lowercase()
}

// 比对身份时尽量用规范化路径：它会消掉 8.3 短名、subst / junction 与 \\?\ 前缀这些
// 「同一个文件的不同写法」。规范化解不出来(文件被占用、已删除)就退回字面归一化，
// 与原来的行为一致——漏检不会更差，命中会更多。
#[cfg_attr(not(windows), allow(dead_code))]
fn identity(path: &Path) -> String {
	match std::fs::canonicalize(path) {
		Ok(resolved) => normalize(&resolved),
		Err(_) => normalize(path),
	}
}

#[cfg(windows)]
fn exe_name_matches(entry: &PROCESSENTRY32W, exe_name: &str) -> bool {
	let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
	let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
	name.eq_ignore_ascii_case(exe_name)
}

/// 列出正在运行、且映像是 `install_dir/exe_name` 的进程 id(不含自身)
#[cfg(windows)]
pub fn instances_running(install_dir: &Path, exe_name: &str, self_pid: u32) -> Result<Vec<u32>, String> {
	let want = identity(&install_dir.join(exe_name));
	let mut found = Vec::new();
	unsafe {
		let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
		if snapshot == INVALID_HANDLE_VALUE {
			return Err(format!("无法枚举正在运行的程序(错误 {})，已取消更新", GetLastError()));
		}
		let mut entry: PROCESSENTRY32W = std::mem::zeroed();
		entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
		let mut ok = Process32FirstW(snapshot, &mut entry);
		while ok != 0 {
			let pid = entry.th32ProcessID;
			if pid != self_pid && pid > 4 && exe_name_matches(&entry, exe_name) {
				if let Some(path) = path_of(pid)? {
					if identity(&path) == want {
						found.push(pid);
					}
				}
			}
			ok = Process32NextW(snapshot, &mut entry);
		}
		CloseHandle(snapshot);
	}
	Ok(found)
}

/// 等待安装目录里的全部实例退出，超时或查询失败都返回 Err(调用方回滚并提示)
#[cfg(windows)]
pub fn wait_for_exit(install_dir: &Path, exe_name: &str, timeout: std::time::Duration) -> Result<(), String> {
	let self_pid = std::process::id();
	let deadline = Instant::now() + timeout;
	loop {
		let running = instances_running(install_dir, exe_name, self_pid)?;
		if running.is_empty() {
			return Ok(());
		}
		if Instant::now() >= deadline {
			return Err(format!("还有 {} 个 Serial Debug 实例仍在运行，已取消更新，请全部退出后重试", running.len()));
		}
		std::thread::sleep(Duration::from_millis(250));
	}
}

/// 进程是否还活着。`None` 表示无法判断(权限不足等)，调用方必须按「还活着」处理。
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> Option<bool> {
	unsafe {
		let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		if handle.is_null() {
			return match GetLastError() {
				ERROR_INVALID_PARAMETER => Some(false),
				_ => None,
			};
		}
		let mut code = 0u32;
		let ok = GetExitCodeProcess(handle, &mut code);
		CloseHandle(handle);
		if ok == 0 {
			return None;
		}
		// STILL_ACTIVE 是 NTSTATUS 的 0x103，GetExitCodeProcess 用同一个数值表示「还在跑」
		Some(code as i32 == STILL_ACTIVE)
	}
}

/// 用系统消息框提示无法启动更新的原因(此时页面还没起来，只能靠原生窗口)
#[cfg(windows)]
pub fn message_box(text: &str) {
	use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
	let caption = wide(std::ffi::OsStr::new("Serial Debug 更新"));
	let body = wide(std::ffi::OsStr::new(text));
	unsafe {
		MessageBoxW(std::ptr::null_mut(), body.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR);
	}
}

// ---- 非 Windows：没有这些 Windows 语义，统一失败关闭 ----

#[cfg(not(windows))]
pub fn instances_running(_install_dir: &std::path::Path, _exe_name: &str, _self_pid: u32) -> Result<Vec<u32>, String> {
	Err("当前平台不支持便携版更新的实例检测".into())
}

#[cfg(not(windows))]
pub fn wait_for_exit(_install_dir: &std::path::Path, _exe_name: &str, _timeout: std::time::Duration) -> Result<(), String> {
	Err("当前平台不支持便携版更新的实例检测".into())
}

#[cfg(not(windows))]
pub fn pid_alive(_pid: u32) -> Option<bool> {
	None
}

#[cfg(not(windows))]
pub fn message_box(text: &str) {
	eprintln!("{text}");
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn case_and_separator_differences_collapse() {
		assert_eq!(normalize(Path::new(r"C:\Apps\Serial Debug\app.exe")), normalize(Path::new(r"c:/apps/serial debug/APP.EXE")));
		assert_eq!(normalize(Path::new(r"\\?\C:\Apps\app.exe")), normalize(Path::new(r"C:\Apps\app.exe")));
	}

	#[test]
	fn canonicalize_resolves_symlinked_install_directories() {
		// macOS 的 /tmp 是指向 /private/tmp 的符号链接：不规范化就会把同一目录当成两个
		let dir = std::env::temp_dir().join(format!("pu-identity-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let exe = dir.join("app.exe");
		std::fs::write(&exe, b"x").unwrap();
		let direct = identity(&exe);
		assert!(direct.ends_with("app.exe"), "{direct}");
		// 同一路径再算一次必须稳定(规范化成功或退回字面归一化都一样)
		assert_eq!(direct, identity(&exe));
		#[cfg(target_os = "macos")]
		{
			// macOS 上 temp_dir() 是 /var/... 而真实路径是 /private/var/...：同一文件必须归一成同一身份
			// 注意 join 遇到绝对路径会整体替换，所以要先去掉开头的 /
			let relative = dir.strip_prefix("/").unwrap();
			let linked = Path::new("/private").join(relative).join("app.exe");
			assert!(linked.exists(), "{} 应可通过 /private 访问", linked.display());
			assert_eq!(identity(&linked), direct, "符号链接目录必须归一到同一身份");
			// 未规范化的字面比较会把它们当成两个目录，这正是需要 canonicalize 的原因
			assert_ne!(normalize(&linked), normalize(&exe));
		}
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_missing_path_falls_back_to_the_literal_form_instead_of_panicking() {
		let missing = std::env::temp_dir().join("pu-identity-does-not-exist\u{1f}app.exe");
		assert!(identity(&missing).ends_with("app.exe"));
	}
}
