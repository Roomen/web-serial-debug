// 桌面客户端外壳：加载与网页版同一份静态页面(desktop/scripts/stage-web.mjs 复制进 dist)，只补网页在 WebView 里缺的能力：
// 原生串口(serial.rs，前端 js/transport-native-serial.js)、下载落盘、多窗口。页面功能与网页版一致，平台差异只走 js/platform.js。
mod serial;

use std::sync::atomic::{AtomicU32, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

static WINDOW_SEQ: AtomicU32 = AtomicU32::new(0);

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

fn open_window(app: &AppHandle) -> tauri::Result<()> {
	let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
	let label = if n == 0 { "main".to_string() } else { format!("main-{}", n + 1) };
	let handle = app.clone();
	let opener = app.clone();
	WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
		.title("Serial Debug")
		.inner_size(1440.0, 900.0)
		.min_inner_size(960.0, 600.0)
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
		})
		.build()?;
	Ok(())
}

pub fn run() {
	tauri::Builder::default()
		.plugin(tauri_plugin_opener::init())
		.manage(serial::SerialState::default())
		.invoke_handler(tauri::generate_handler![
			serial::serial_list,
			serial::serial_open,
			serial::serial_write,
			serial::serial_set_signals,
			serial::serial_close,
			serial::serial_release_owned
		])
		.on_window_event(|window, event| {
			if let tauri::WindowEvent::Destroyed = event {
				serial::release_owner(&window.state::<serial::SerialState>(), window.label());
			}
		})
		// 默认菜单的 File 里只有「关闭窗口」，在它前面加「新建窗口」：桌面客户端可多开，每个窗口是独立实例
		.menu(|app| {
			let menu = Menu::default(app)?;
			let new_window = MenuItem::with_id(app, "new-window", "新建窗口", true, Some("CmdOrCtrl+N"))?;
			let sep = PredefinedMenuItem::separator(app)?;
			let file = menu
				.items()?
				.into_iter()
				.filter_map(|i| i.as_submenu().cloned())
				.find(|s| s.text().map(|t| t == "File").unwrap_or(false));
			match file {
				Some(f) => f.prepend_items(&[&new_window, &sep])?,
				None => menu.append(&Submenu::with_items(app, "File", true, &[&new_window])?)?,
			}
			Ok(menu)
		})
		.on_menu_event(|app, event| {
			if event.id() == "new-window" {
				let _ = open_window(app);
			}
		})
		.setup(|app| {
			open_window(app.handle())?;
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("启动客户端失败");
}
