// release 构建在 Windows 上不额外弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
	serial_debug_lib::run()
}
