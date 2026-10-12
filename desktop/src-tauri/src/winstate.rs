// 主窗口(main)的大小、位置与最大化记忆。不用 tauri-plugin-window-state：它存的是物理像素，
// 还原时窗口还在主屏(Retina 2x)上就按物理像素设大小，等于逻辑尺寸减半，随后才移到 1x 外接屏，每次启动缩一半直到卡在最小尺寸。
// 这里大小存逻辑像素，位置只用来找回它所在的屏，还原时钳进目标屏的工作区。
// 位置的坐标系按平台：Windows 有真正的全局物理桌面坐标，存物理像素；macOS 的 tao 没有全局物理空间，
// outer_position / 显示器 position / work_area 都是「逻辑坐标 × 各自所在窗口或屏的倍率」，set_position(Physical) 又按窗口当前倍率换回逻辑，
// 混合倍率下换算不一致，所以 macOS 一律用全局逻辑坐标(存、比较、设置都是逻辑)。Area 与 Saved 的 x/y/w/h 都在这个「位置坐标系」里，scale 是位置坐标系每逻辑像素的单位数(macOS 恒为 1)。
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::LogicalPosition;
#[cfg(not(target_os = "macos"))]
use tauri::PhysicalPosition;
use tauri::{AppHandle, Manager, WebviewWindow};

pub const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
pub const MIN_SIZE: (f64, f64) = (960.0, 600.0);

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct Saved {
	// 未最大化时的内部大小(逻辑像素)
	pub w: f64,
	pub h: f64,
	// 未最大化时的窗口左上角(位置坐标系：macOS 全局逻辑坐标，Windows 全局物理坐标)
	pub x: f64,
	pub y: f64,
	pub maximized: bool,
}

// 一块屏的工作区(位置坐标系)与位置坐标系每逻辑像素的单位数
#[derive(Clone, Copy, Debug)]
pub struct Area {
	pub x: f64,
	pub y: f64,
	pub w: f64,
	pub h: f64,
	pub scale: f64,
}

#[derive(Default)]
pub struct WinState(pub Mutex<Option<Saved>>);

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
	app.path().app_data_dir().ok().map(|p| p.join("main-window.json"))
}

pub fn load(app: &AppHandle) -> Option<Saved> {
	let s: Saved = serde_json::from_slice(&std::fs::read(path(app)?).ok()?).ok()?;
	(s.w.is_finite() && s.h.is_finite() && s.w > 0.0 && s.h > 0.0).then_some(s)
}

fn save(app: &AppHandle, s: &Saved) {
	if let Some(p) = path(app) {
		if let Some(dir) = p.parent() {
			let _ = std::fs::create_dir_all(dir);
		}
		if let Ok(b) = serde_json::to_vec(s) {
			let _ = std::fs::write(p, b);
		}
	}
}

pub fn areas(app: &AppHandle) -> (Vec<Area>, Option<usize>) {
	let to_area = |m: &tauri::Monitor| {
		let r = m.work_area();
		let sf = m.scale_factor();
		// macOS 的 work_area 是「逻辑 × 该屏倍率」，除回去得全局逻辑坐标；Windows 本来就是全局物理坐标
		let (k, scale) = if cfg!(target_os = "macos") { (1.0 / sf, 1.0) } else { (1.0, sf) };
		Area {
			x: r.position.x as f64 * k,
			y: r.position.y as f64 * k,
			w: r.size.width as f64 * k,
			h: r.size.height as f64 * k,
			scale,
		}
	};
	let list: Vec<Area> = app.available_monitors().unwrap_or_default().iter().map(to_area).collect();
	let primary = app
		.primary_monitor()
		.ok()
		.flatten()
		.map(|m| to_area(&m))
		.and_then(|p| list.iter().position(|a| (a.x - p.x).abs() < 0.5 && (a.y - p.y).abs() < 0.5 && (a.w - p.w).abs() < 0.5 && (a.h - p.h).abs() < 0.5));
	(list, primary)
}

fn contains(a: &Area, x: f64, y: f64) -> bool {
	x >= a.x && y >= a.y && x < a.x + a.w && y < a.y + a.h
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
	v.max(lo).min(hi.max(lo))
}

// 算窗口该用的逻辑大小与物理位置：保存的位置落在某块在位的屏上就用那块屏，否则主屏(没有主屏信息取第一块)；
// 大小钳进该屏工作区(逻辑)，不小于最小尺寸，除非屏比最小尺寸还小；位置为 None 表示交给居中
pub fn plan(saved: Option<Saved>, areas: &[Area], primary: Option<usize>) -> ((f64, f64), Option<(f64, f64)>) {
	let want = saved.map(|s| (s.w, s.h)).unwrap_or(DEFAULT_SIZE);
	let on = saved.and_then(|s| areas.iter().find(|a| contains(a, s.x, s.y)));
	let target = on.or_else(|| primary.and_then(|i| areas.get(i))).or_else(|| areas.first());
	let Some(a) = target else { return (want, None) };
	let (aw, ah) = (a.w as f64 / a.scale, a.h as f64 / a.scale);
	let size = (clamp(want.0, MIN_SIZE.0.min(aw), aw), clamp(want.1, MIN_SIZE.1.min(ah), ah));
	let pos = match (saved, on) {
		(Some(s), Some(_)) => {
			let (pw, ph) = (size.0 * a.scale, size.1 * a.scale);
			Some((clamp(s.x, a.x, a.x + a.w - pw), clamp(s.y, a.y, a.y + a.h - ph)))
		}
		_ => None,
	};
	(size, pos)
}

// 窗口建好后(隐藏着)套用位置；没有有效位置就居中，再显示，免得先在别处闪一下
pub fn apply(w: &WebviewWindow, pos: Option<(f64, f64)>, maximized: bool) {
	match pos {
		Some((x, y)) => {
			#[cfg(target_os = "macos")]
			let _ = w.set_position(LogicalPosition::new(x, y));
			#[cfg(not(target_os = "macos"))]
			let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
		}
		None => {
			let _ = w.center();
		}
	}
	if maximized {
		let _ = w.maximize();
	}
	let _ = w.show();
}

// 窗口移动 / 缩放 / 关闭时记下来；最小化、全屏不记，最大化只记标志、保留之前的未最大化几何
pub fn record(w: &WebviewWindow) {
	if w.is_fullscreen().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
		return;
	}
	let app = w.app_handle();
	let state = app.state::<WinState>();
	let mut cur = state.0.lock().unwrap();
	let maximized = w.is_maximized().unwrap_or(false);
	let next = if maximized {
		cur.or_else(|| load(app)).map(|s| Saved { maximized: true, ..s })
	} else {
		let (Ok(scale), Ok(size), Ok(pos)) = (w.scale_factor(), w.inner_size(), w.outer_position()) else {
			return;
		};
		let l = size.to_logical::<f64>(scale);
		// macOS 存全局逻辑坐标(按窗口当前倍率换回)，Windows 存物理坐标
		let (x, y) = if cfg!(target_os = "macos") {
			let p = pos.to_logical::<f64>(scale);
			(p.x, p.y)
		} else {
			(pos.x as f64, pos.y as f64)
		};
		Some(Saved {
			w: l.width,
			h: l.height,
			x,
			y,
			maximized: false,
		})
	};
	if let Some(n) = next {
		if *cur != Some(n) {
			save(app, &n);
			*cur = Some(n);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn sv(w: f64, h: f64, x: f64, y: f64) -> Saved {
		Saved { w, h, x, y, maximized: false }
	}
	// Windows：物理坐标，scale 为各屏倍率
	fn retina() -> Area {
		Area { x: 0.0, y: 38.0, w: 3024.0, h: 1870.0, scale: 2.0 }
	}
	fn ext() -> Area {
		Area { x: 3024.0, y: -1080.0, w: 1920.0, h: 1055.0, scale: 1.0 }
	}
	// macOS：全局逻辑坐标，scale 恒为 1；内置 Retina 逻辑 1512x935，外接 1x 在其右上方
	fn mac_builtin() -> Area {
		Area { x: 0.0, y: 38.0, w: 1512.0, h: 935.0, scale: 1.0 }
	}
	fn mac_ext() -> Area {
		Area { x: 1512.0, y: -1080.0, w: 1920.0, h: 1055.0, scale: 1.0 }
	}

	#[test]
	fn first_launch_uses_default_and_centers() {
		let (s, p) = plan(None, &[retina()], Some(0));
		assert_eq!(s, (1440.0, 900.0));
		assert_eq!(p, None);
	}

	#[test]
	fn small_screen_clamps_default() {
		let a = Area { x: 0.0, y: 25.0, w: 1280.0, h: 775.0, scale: 1.0 };
		let (s, _) = plan(None, &[a], Some(0));
		assert_eq!(s, (1280.0, 775.0));
	}

	#[test]
	fn logical_size_survives_mixed_dpi() {
		let (s, p) = plan(Some(sv(1200.0, 800.0, 3200.0, -900.0)), &[retina(), ext()], Some(0));
		assert_eq!(s, (1200.0, 800.0));
		assert_eq!(p, Some((3200.0, -900.0)));
	}

	#[test]
	fn mac_mixed_dpi_position_stays_on_external() {
		// 外接 1x 屏上的窗口，存的是全局逻辑坐标 1886：必须仍判在外接屏上，位置原样还回
		let (s, p) = plan(Some(sv(1200.0, 800.0, 1886.0, -900.0)), &[mac_builtin(), mac_ext()], Some(0));
		assert_eq!(s, (1200.0, 800.0));
		assert_eq!(p, Some((1886.0, -900.0)));
		// 外接屏拔掉后回主屏居中
		let (_, p) = plan(Some(sv(1200.0, 800.0, 1886.0, -900.0)), &[mac_builtin()], Some(0));
		assert_eq!(p, None);
	}

	#[test]
	fn missing_monitor_falls_back_to_primary_center() {
		let (s, p) = plan(Some(sv(1200.0, 800.0, 9000.0, -345.0)), &[retina()], Some(0));
		assert_eq!(s, (1200.0, 800.0));
		assert_eq!(p, None);
	}

	#[test]
	fn position_clamped_into_work_area() {
		let (_, p) = plan(Some(sv(1200.0, 800.0, 3000.0, 1800.0)), &[retina()], Some(0));
		assert_eq!(p, Some((3024.0 - 2400.0, 38.0 + 1870.0 - 1600.0)));
		let (_, p) = plan(Some(sv(1200.0, 800.0, 1400.0, 900.0)), &[mac_builtin()], Some(0));
		assert_eq!(p, Some((312.0, 173.0)));
	}

	#[test]
	fn never_below_min_unless_screen_smaller() {
		let (s, _) = plan(Some(sv(100.0, 100.0, 0.0, 40.0)), &[retina()], Some(0));
		assert_eq!(s, MIN_SIZE);
	}
}
