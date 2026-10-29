// 桌面客户端外壳：加载与网页版同一份静态页面(desktop/scripts/stage-web.mjs 复制进 dist)，只补网页在 WebView 里缺的能力：
// 原生串口(serial.rs，前端 js/transport-native-serial.js)、下载落盘、多窗口、原生菜单(menu.rs)与窗口外观。
// 页面功能与网页版一致，平台差异只走 js/platform.js，页面侧胶水在 js/native-shell.js。
mod menu;
mod serial;
mod updater;
mod winstate;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
// 新窗口相对参考窗口错开的距离(逻辑像素)
const CASCADE: f64 = 28.0;
// macOS 一体化标题栏：红绿灯浮在页面左上(左侧导航栏顶部)，纵向与顶栏 46px 的中线对齐；页面按 html[data-platform='macos'] 留出空位
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (8.0, 15.0);

// 同名文件已存在时按「名称 (n).扩展名」顺延，与浏览器下载的习惯一致
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
	let first = dir.join(name);
	if !first.exists() {
		return first;
	}
	let p = std::path::Path::new(name);
	let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("download");
	let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{}", e)).unwrap_or_default();
	for i in 1.. {
		let c = dir.join(format!("{} ({}){}", stem, i, ext));
		if !c.exists() {
			return c;
		}
	}
	unreachable!()
}

// 第一个窗口固定叫 main(窗口位置大小只记它的，见 winstate.rs)，其余取最小的空闲 main-N
fn next_label(app: &AppHandle) -> String {
	if app.get_webview_window(MAIN).is_none() {
		return MAIN.to_string();
	}
	(2..).map(|n| format!("main-{}", n)).find(|l| app.get_webview_window(l).is_none()).unwrap()
}

// 新开的窗口跟参考窗口(聚焦的，没有就任取一个)同大小、向右下错开；参考窗口最大化或全屏时不跟它的尺寸
fn cascade_from(app: &AppHandle) -> Option<(LogicalPosition<f64>, LogicalSize<f64>)> {
	let w = menu::focused_window(app).or_else(|| app.webview_windows().into_values().next())?;
	if w.is_fullscreen().unwrap_or(false) || w.is_maximized().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
		return None;
	}
	let scale = w.scale_factor().ok()?;
	let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
	let size = w.inner_size().ok()?.to_logical::<f64>(scale);
	Some((LogicalPosition::new(pos.x + CASCADE, pos.y + CASCADE), size))
}

fn open_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
	updater::with_window_creation(app, || build_window(app))
}

fn build_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
	let label = next_label(app);
	build_window_with_session(app, &label, None)
}

fn build_window_with_session(app: &AppHandle, label: &str, session: Option<&std::collections::HashMap<String, String>>) -> tauri::Result<WebviewWindow> {
	let handle = app.clone();
	let opener = app.clone();
	let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
		.title("Serial Debug")
		.min_inner_size(960.0, 600.0)
		// Tauri 的文件拖放处理会吞掉页面的 HTML5 drop(固件拖拽卡、快捷发送拖动排序)，页面不用 Tauri 的拖放事件
		.disable_drag_drop_handler()
		// 页面里 target="_blank" 的外部链接(GitHub、反馈)交给系统浏览器，不在客户端里开新窗口
		.on_new_window(move |url, _features| {
			if matches!(url.scheme(), "http" | "https" | "mailto") {
				let _ = opener.opener().open_url(url.as_str(), None::<&str>);
			}
			NewWindowResponse::Deny
		})
		// 页面里的导出、固件产物都是 <a download> + blob：存进系统「下载」目录，再通知页面提示保存位置
		.on_download(move |webview, event| {
			match event {
				DownloadEvent::Requested { destination, .. } => {
					let name = destination
						.file_name()
						.and_then(|s| s.to_str())
						.filter(|s| !s.is_empty())
						.unwrap_or("download")
						.to_string();
					if let Ok(dir) = handle.path().download_dir() {
						*destination = unique_path(&dir, &name);
					}
				}
				DownloadEvent::Finished { path, success, .. } => {
					// 只通知发起下载的那个窗口，多开时别的窗口不弹提示
					let _ = webview.emit_to(webview.label(), "app-download", serde_json::json!({ "path": path, "success": success }));
				}
				_ => {}
			}
			true
		});
	if let Some(session) = session {
		builder = builder.initialization_script(updater::session_script(session));
	}
	// main 的大小(逻辑像素)与位置由 winstate 还原并钳进目标屏工作区(没存过就居中)；其余窗口跟着参考窗口错开
	let mut restore = None;
	match (label != MAIN).then(|| cascade_from(app)).flatten() {
		Some((pos, size)) => builder = builder.position(pos.x, pos.y).inner_size(size.width, size.height),
		None if label == MAIN => {
			let saved = winstate::load(app);
			let (areas, primary) = winstate::areas(app);
			let (size, pos) = winstate::plan(saved, &areas, primary);
			// 先隐藏建出来，位置设好再显示，免得在别的屏上闪一下
			builder = builder.inner_size(size.0, size.1).visible(false);
			restore = Some((pos, saved.map(|s| s.maximized).unwrap_or(false)));
		}
		None => builder = builder.inner_size(winstate::DEFAULT_SIZE.0, winstate::DEFAULT_SIZE.1).center(),
	}
	#[cfg(target_os = "macos")]
	{
		builder = builder
			.title_bar_style(tauri::TitleBarStyle::Overlay)
			.hidden_title(true)
			.traffic_light_position(LogicalPosition::new(TRAFFIC_LIGHTS.0, TRAFFIC_LIGHTS.1));
	}
	let window = builder.build()?;
	if let Some((pos, maximized)) = restore {
		winstate::apply(&window, pos, maximized);
	}
	#[cfg(target_os = "windows")]
	window.hide_menu()?;
	Ok(window)
}

// 双击一体化标题栏的空白处：按系统设置「连按窗口标题栏以」缩放 / 最小化 / 不动作(默认缩放)
#[tauri::command]
fn titlebar_double_click(window: tauri::WebviewWindow) {
	#[cfg(target_os = "macos")]
	{
		let action = std::process::Command::new("defaults")
			.args(["read", "-g", "AppleActionOnDoubleClick"])
			.output()
			.ok()
			.filter(|o| o.status.success())
			.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
			.unwrap_or_default();
		match action.as_str() {
			"Minimize" => {
				let _ = window.minimize();
				return;
			}
			"None" => return,
			_ => {}
		}
	}
	let _ = if window.is_maximized().unwrap_or(false) {
		window.unmaximize()
	} else {
		window.maximize()
	};
}

pub fn run() {
	let app = tauri::Builder::default()
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.manage(serial::SerialState::default())
		.manage(winstate::WinState::default())
		.manage(updater::UpdateState::default())
		.invoke_handler(tauri::generate_handler![
			serial::serial_list,
			serial::serial_open,
			serial::serial_write,
			serial::serial_set_signals,
			serial::serial_close,
			serial::serial_release_owned,
			menu::menu_sync,
			updater::app_update_check,
			updater::app_update_install,
			updater::app_update_ack,
			titlebar_double_click
		])
		.on_window_event(|window, event| {
			if let tauri::WindowEvent::Destroyed = event {
				serial::release_destroyed(&window.state::<serial::SerialState>(), window.label());
			}
			// 只记 main 的大小位置：多开的 main-N 每次都相对当前窗口错开，记下来反而会叠在旧位置上
			if window.label() == MAIN && matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) | tauri::WindowEvent::CloseRequested { .. }) {
				if let Some(w) = window.app_handle().get_webview_window(MAIN) {
					winstate::record(&w);
				}
			}
		})
		.on_menu_event(|app, event| {
			let id = event.id().as_ref();
			if id == menu::NEW_WINDOW {
				let _ = open_window(app);
			} else {
				menu::dispatch(app, id);
			}
		})
		.setup(|app| {
			let m = menu::build(app.handle())?;
			app.set_menu(m)?;
			if let Some(handoff) = updater::read_handoff(app.handle()) {
				let mut sessions: Vec<_> = handoff.windows.into_iter().collect();
				sessions.sort_by_key(|(label, _)| if label == MAIN { 0 } else { label[5..].parse::<u32>().unwrap_or(u32::MAX) });
				for (label, session) in sessions {
					updater::with_window_creation(app.handle(), || build_window_with_session(app.handle(), &label, Some(&session)))?;
				}
				updater::remove_handoff(app.handle());
			} else {
				open_window(app.handle())?;
			}
			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("启动客户端失败");
	app.run(|app, event| {
		// macOS 习惯：关掉最后一个窗口不退出，点 Dock 图标再开一个(有最小化的窗口就还原它)；⌘Q / Dock「退出」走 terminate，不经这里
		#[cfg(target_os = "macos")]
		match event {
			tauri::RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
			tauri::RunEvent::Reopen {
				has_visible_windows: false, ..
			} => match app.webview_windows().into_values().next() {
				Some(w) => {
					let _ = w.unminimize();
					let _ = w.set_focus();
				}
				None => {
					let _ = open_window(app);
				}
			},
			_ => {}
		}
		#[cfg(not(target_os = "macos"))]
		let _ = (app, event);
	});
}
