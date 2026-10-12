// 原生中文菜单栏(macOS 是系统菜单栏，Windows 是窗口菜单)。除新建窗口外，菜单动作一律以「app-menu」事件发给当前聚焦的窗口，
// 由 js/native-shell.js 按 id 驱动页面已有的控件与 API，这里不写业务。可用 / 勾选状态由页面经 menu_sync 报回来，只认聚焦窗口的报告
// (macOS 菜单栏是全应用共用一份，多开时显示的是前台窗口的状态)。
use serde::Deserialize;
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Window, Wry};

pub const NEW_WINDOW: &str = "new-window";

pub struct MenuHandles {
	connect: MenuItem<Wry>,
	auto_scroll: CheckMenuItem<Wry>,
	themes: Vec<(&'static str, CheckMenuItem<Wry>)>,
	// 只在串口调试视图里有意义的项，页面按当前视图启停
	view_items: Vec<MenuItem<Wry>>,
}

fn item(app: &AppHandle, id: &str, text: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
	MenuItem::with_id(app, id, text, true, accel)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
	let sep = || PredefinedMenuItem::separator(app);
	let name = app.package_info().name.clone();
	let about = PredefinedMenuItem::about(
		app,
		Some(&format!("关于 {}", name)),
		Some(AboutMetadata {
			name: Some(name.clone()),
			version: Some(app.package_info().version.to_string()),
			..Default::default()
		}),
	)?;
	let prefs = item(app, "preferences", "偏好设置…", Some("CmdOrCtrl+Comma"))?;

	// ---- 文件 ----
	let new_window = item(app, NEW_WINDOW, "新建窗口", Some("CmdOrCtrl+N"))?;
	let save_log = item(app, "save-log", "保存日志…", Some("CmdOrCtrl+S"))?;
	let close = PredefinedMenuItem::close_window(app, Some("关闭窗口"))?;
	#[cfg(target_os = "macos")]
	let file = Submenu::with_items(app, "文件", true, &[&new_window, &sep()?, &save_log, &sep()?, &close])?;
	// Windows / Linux 没有应用菜单：偏好设置与退出放进「文件」
	#[cfg(not(target_os = "macos"))]
	let file = Submenu::with_items(
		app,
		"文件",
		true,
		&[
			&new_window,
			&sep()?,
			&save_log,
			&sep()?,
			&prefs,
			&sep()?,
			&close,
			&PredefinedMenuItem::quit(app, Some("退出"))?,
		],
	)?;

	// ---- 编辑：WebView 里的输入框靠这些预置项才有 ⌘C / ⌘V 等快捷键，不能删 ----
	let find = item(app, "find-log", "查找日志", Some("CmdOrCtrl+F"))?;
	let edit = Submenu::with_items(
		app,
		"编辑",
		true,
		&[
			&PredefinedMenuItem::undo(app, Some("撤销"))?,
			&PredefinedMenuItem::redo(app, Some("重做"))?,
			&sep()?,
			&PredefinedMenuItem::cut(app, Some("剪切"))?,
			&PredefinedMenuItem::copy(app, Some("拷贝"))?,
			&PredefinedMenuItem::paste(app, Some("粘贴"))?,
			&PredefinedMenuItem::select_all(app, Some("全选"))?,
			&sep()?,
			&find,
		],
	)?;

	// ---- 串口 ----
	// ⌘K 是页面的命令面板，清空日志用 ⇧⌘K；发送沿用发送框原有的 ⌘/Ctrl + Enter
	let connect = item(app, "toggle-connect", "连接串口", Some("CmdOrCtrl+O"))?;
	let pick = item(app, "pick-port", "选择串口…", Some("CmdOrCtrl+Shift+O"))?;
	let send = item(app, "send", "发送", Some("CmdOrCtrl+Enter"))?;
	let clear = item(app, "clear-log", "清空日志", Some("CmdOrCtrl+Shift+K"))?;
	let auto_scroll = CheckMenuItem::with_id(app, "auto-scroll", "自动滚动", true, true, None::<&str>)?;
	let serial = Submenu::with_items(app, "串口", true, &[&connect, &pick, &sep()?, &send, &sep()?, &clear, &auto_scroll])?;

	// ---- 视图 ----
	let v_serial = item(app, "view-serial", "串口调试", Some("CmdOrCtrl+1"))?;
	let v_fw = item(app, "view-firmware", "固件", Some("CmdOrCtrl+2"))?;
	let v_power = item(app, "view-power", "功耗分析", Some("CmdOrCtrl+3"))?;
	let palette = item(app, "command-palette", "命令面板…", Some("CmdOrCtrl+K"))?;
	let right = item(app, "toggle-right-pane", "显示 / 隐藏右侧面板", Some("CmdOrCtrl+Alt+0"))?;
	let zoom_in = item(app, "log-zoom-in", "放大日志", Some("CmdOrCtrl+Equal"))?;
	let zoom_out = item(app, "log-zoom-out", "缩小日志", Some("CmdOrCtrl+Minus"))?;
	let zoom_reset = item(app, "log-zoom-reset", "日志实际大小", Some("CmdOrCtrl+0"))?;
	let t_auto = CheckMenuItem::with_id(app, "theme-auto", "跟随系统", true, true, None::<&str>)?;
	let t_light = CheckMenuItem::with_id(app, "theme-light", "浅色", true, false, None::<&str>)?;
	let t_dark = CheckMenuItem::with_id(app, "theme-dark", "深色", true, false, None::<&str>)?;
	let theme = Submenu::with_items(app, "主题", true, &[&t_auto, &t_light, &t_dark])?;
	let view = Submenu::with_items(
		app,
		"视图",
		true,
		&[
			&v_serial,
			&v_fw,
			&v_power,
			&sep()?,
			&palette,
			&right,
			&sep()?,
			&zoom_in,
			&zoom_out,
			&zoom_reset,
			&sep()?,
			&theme,
		],
	)?;
	#[cfg(target_os = "macos")]
	view.append_items(&[&sep()?, &PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?])?;

	// ---- 窗口 / 帮助 ----
	let window = Submenu::with_items(
		app,
		"窗口",
		true,
		&[
			&PredefinedMenuItem::minimize(app, Some("最小化"))?,
			&PredefinedMenuItem::maximize(app, Some("缩放"))?,
		],
	)?;
	#[cfg(target_os = "macos")]
	window.append_items(&[&sep()?, &PredefinedMenuItem::bring_all_to_front(app, Some("前置全部窗口"))?])?;
	let feedback = item(app, "help-feedback", "反馈问题…", None)?;
	let homepage = item(app, "help-homepage", "项目主页", None)?;
	let help = Submenu::with_items(app, "帮助", true, &[&feedback, &homepage])?;
	#[cfg(not(target_os = "macos"))]
	help.append_items(&[&sep()?, &about])?;

	#[cfg(target_os = "macos")]
	let menu = {
		let app_menu = Submenu::with_items(
			app,
			&name,
			true,
			&[
				&about,
				&sep()?,
				&prefs,
				&sep()?,
				&PredefinedMenuItem::services(app, Some("服务"))?,
				&sep()?,
				&PredefinedMenuItem::hide(app, Some(&format!("隐藏 {}", name)))?,
				&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
				&PredefinedMenuItem::show_all(app, Some("全部显示"))?,
				&sep()?,
				&PredefinedMenuItem::quit(app, Some(&format!("退出 {}", name)))?,
			],
		)?;
		Menu::with_items(app, &[&app_menu, &file, &edit, &serial, &view, &window, &help])?
	};
	#[cfg(not(target_os = "macos"))]
	let menu = Menu::with_items(app, &[&file, &edit, &serial, &view, &window, &help])?;
	// macOS 在「窗口」里列出打开的窗口，「帮助」带系统搜索框
	#[cfg(target_os = "macos")]
	{
		window.set_as_windows_menu_for_nsapp()?;
		help.set_as_help_menu_for_nsapp()?;
	}

	app.manage(MenuHandles {
		connect,
		auto_scroll,
		themes: vec![("auto", t_auto), ("light", t_light), ("dark", t_dark)],
		view_items: vec![save_log, find, send, clear, right, zoom_in, zoom_out, zoom_reset],
	});
	Ok(menu)
}

pub fn focused_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
	app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
}

// 菜单动作只发给聚焦窗口；没有聚焦窗口(macOS 关掉了所有窗口)时安静忽略
pub fn dispatch(app: &AppHandle, id: &str) {
	if let Some(w) = focused_window(app) {
		let _ = w.emit_to(w.label(), "app-menu", id);
	}
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuState {
	// 当前视图是不是串口调试
	serial_view: Option<bool>,
	// 当前主发路是否已连接
	connected: Option<bool>,
	auto_scroll: Option<bool>,
	// auto | light | dark
	theme: Option<String>,
}

#[tauri::command]
pub fn menu_sync(window: Window, handles: State<'_, MenuHandles>, state: MenuState) {
	if !window.is_focused().unwrap_or(false) {
		return;
	}
	if let Some(c) = state.connected {
		let _ = handles.connect.set_text(if c { "断开串口" } else { "连接串口" });
	}
	if let Some(a) = state.auto_scroll {
		let _ = handles.auto_scroll.set_checked(a);
	}
	if let Some(t) = state.theme.as_deref() {
		for (id, it) in &handles.themes {
			let _ = it.set_checked(*id == t);
		}
	}
	if let Some(on) = state.serial_view {
		for it in &handles.view_items {
			let _ = it.set_enabled(on);
		}
		let _ = handles.auto_scroll.set_enabled(on);
	}
}
