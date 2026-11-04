// 便携版更新助手入口：真正的替换逻辑在 win.rs(仅 Windows 编译)。
// release 构建用 windows 子系统：更新过程在后台完成，不弹控制台窗口；
// debug 构建保留控制台，方便在 Windows 上直接看输出。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
// 非 Windows 平台也编译这个二进制，但只报错退出，用于本机跑 swap 单元测试与交叉检查。
mod disposition;
mod swap;
#[cfg(windows)]
mod win;

fn main() {
	#[cfg(windows)]
	{
		std::process::exit(win::run());
	}
	#[cfg(not(windows))]
	{
		eprintln!("serial-debug-updater 只用于 Windows 便携版更新，当前平台不能执行替换");
		std::process::exit(3);
	}
}
