//! Native Classic SPP, independent of the serial registry/backend. No raw addresses cross IPC.
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;
// Unsupported hosts keep the command schema buildable; AppPlatform never provides Classic there.
#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
	use super::Device;
	pub fn choose(_: bool) -> Result<Device, String> {
		Err("此平台没有原生 Classic 服务".into())
	}
	pub struct Connection;
	impl Connection {
		pub fn open(_: &Device, _: &crate::lease::OwnerOperation) -> Result<Self, String> {
			Err("此平台没有原生 Classic 服务".into())
		}
		pub fn read(&mut self, _: &mut [u8]) -> Result<usize, String> {
			Err("此平台没有原生 Classic 服务".into())
		}
		pub fn write(&mut self, _: &[u8], _: &crate::lease::OwnerOperation) -> Result<(), String> {
			Err("此平台没有原生 Classic 服务".into())
		}
	}
}
use crate::lease::{Claims, OwnerOperation, OwnerRelease, OwnerSet};
use serde::{Deserialize, Serialize};
use std::{
	collections::HashMap,
	sync::{
		atomic::{AtomicBool, AtomicU64, Ordering},
		mpsc, Arc, Condvar, Mutex,
	},
	time::{Duration, Instant},
};
use tauri::{
	ipc::{Channel, InvokeResponseBody},
	Manager, State,
};
#[derive(Clone, Deserialize)]
pub(super) struct Device {
	address: String,
	name: String,
	paired: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
	device_id: String,
	name: String,
	paired: bool,
}
struct Entry {
	owner: String,
	generation: u64,
	device: Device,
}
struct Handle {
	owner: String,
	generation: u64,
	stop: Arc<AtomicBool>,
	finished: Arc<(Mutex<bool>, Condvar)>,
	tx: mpsc::SyncSender<Write>,
}
struct Write {
	data: Vec<u8>,
	result: tokio::sync::oneshot::Sender<Result<(), String>>,
	operation: OwnerOperation,
	_update: crate::updater::DeviceOperation,
}
#[derive(Default)]
struct Registry {
	devices: HashMap<String, Entry>,
	handles: HashMap<u64, Arc<Handle>>,
}
impl Registry {
	fn device_key(&self, owner: &str, generation: u64, address: &str) -> Option<String> {
		self.devices
			.iter()
			.find(|(_, e)| e.owner == owner && e.generation == generation && e.device.address == address)
			.map(|(id, _)| id.clone())
	}
}

#[derive(Default)]
pub struct ClassicState {
	registry: Mutex<Registry>,
	owners: OwnerSet,
	claims: Claims,
	next: AtomicU64,
}
impl ClassicState {
	fn release(&self, label: &str) -> OwnerRelease<Vec<Arc<Handle>>> {
		let mut r = self.registry.lock().unwrap();
		let owner = self.owners.owner(label);
		owner.invalidate();
		r.devices.retain(|_, d| d.owner != label);
		let ids: Vec<_> = r.handles.iter().filter(|(_, h)| h.owner == label).map(|(id, _)| *id).collect();
		let handles = ids
			.into_iter()
			.map(|id| {
				let h = r.handles.remove(&id).unwrap();
				h.stop.store(true, Ordering::Release);
				h
			})
			.collect();
		OwnerRelease::new(owner, handles)
	}
	fn register_open(&self, id: u64, handle: Handle, op: &OwnerOperation) -> Result<(), String> {
		let mut r = self.registry.lock().unwrap();
		if !op.is_current() {
			return Err("Classic 会话已回收".into());
		}
		r.handles.insert(id, Arc::new(handle));
		Ok(())
	}
	fn operation(&self, label: &str, id: u64) -> Result<(Arc<Handle>, OwnerOperation), String> {
		let r = self.registry.lock().unwrap();
		let h = r.handles.get(&id).ok_or("Classic 通道已关闭")?;
		if h.owner != label {
			return Err("Classic 通道不属于本窗口".into());
		}
		let op = self.owners.owner(label).begin(Some(h.generation))?;
		Ok((h.clone(), op))
	}
}
fn wait_closed(h: &Handle, deadline: Instant) -> bool {
	let (lock, cv) = &*h.finished;
	let done = lock.lock().unwrap();
	*cv.wait_timeout_while(done, deadline.saturating_duration_since(Instant::now()), |done| !*done)
		.unwrap()
		.0
}
fn drain(release: OwnerRelease<Vec<Arc<Handle>>>) -> Result<(), String> {
	drain_until(release, Instant::now() + Duration::from_secs(3))
}
fn drain_until(release: OwnerRelease<Vec<Arc<Handle>>>, deadline: Instant) -> Result<(), String> {
	let closed = release.payload.iter().all(|h| wait_closed(h, deadline));
	if release.wait_drained(deadline) && closed {
		Ok(())
	} else {
		Err("Classic 操作尚未结束，请完成或取消系统配对窗口后重试".into())
	}
}
pub fn release_destroyed(state: &ClassicState, label: &str) {
	let release = state.release(label);
	tauri::async_runtime::spawn_blocking(move || {
		let _ = drain(release);
	});
}
pub fn release_owner(state: &ClassicState, label: &str) -> Result<(), String> {
	drain(state.release(label))
}
#[tauri::command]
pub async fn classic_release_owned(webview: tauri::Webview, state: State<'_, ClassicState>) -> Result<u64, String> {
	let release = state.release(webview.label());
	tauri::async_runtime::spawn_blocking(move || drain(release))
		.await
		.map_err(|_| "Classic 回收任务失败".to_string())??;
	Ok(state.owners.owner(webview.label()).begin(None)?.generation)
}
#[tauri::command]
pub async fn classic_devices(webview: tauri::Webview, state: State<'_, ClassicState>) -> Result<Vec<DeviceView>, String> {
	let r = state.registry.lock().unwrap();
	Ok(r.devices
		.iter()
		.filter(|(_, e)| e.owner == webview.label())
		.map(|(id, e)| DeviceView {
			device_id: id.clone(),
			name: e.device.name.clone(),
			paired: e.device.paired,
		})
		.collect())
}
#[tauri::command]
pub async fn classic_discover(webview: tauri::Webview, state: State<'_, ClassicState>, pair: bool, owner_generation: u64) -> Result<DeviceView, String> {
	let update = crate::updater::begin_device_operation(webview.app_handle())?;
	let op = state.owners.owner(webview.label()).begin(Some(owner_generation))?;
	let claim = state
		.claims
		.acquire("classic-system-dialog", webview.label(), op.generation)
		.map_err(|_| "已有 Classic 系统窗口，请先关闭它")?;
	let app = webview.app_handle().clone();
	let label = webview.label().to_owned();
	let (tx, rx) = tokio::sync::oneshot::channel();
	let task = move || {
		let _update = update;
		let _claim = claim;
		let result = (|| {
			if !op.is_current() {
				return Err("Classic 会话已回收".into());
			}
			let d = platform::choose(pair)?;
			if pair && !d.paired {
				return Err("系统未确认配对成功".into());
			}
			let state = app.state::<ClassicState>();
			let mut r = state.registry.lock().unwrap();
			if !op.is_current() {
				return Err("Classic 会话已回收".into());
			}
			// Reuse only the native identity within this owner generation; names never identify a device.
			let existing = r.device_key(&label, op.generation, &d.address);
			let id = if let Some(id) = existing {
				id
			} else {
				if r.devices.values().filter(|e| e.owner == label).count() >= 64 {
					return Err("Classic 设备列表已满，请清理会话".into());
				}
				format!("classic-{}", state.next.fetch_add(1, Ordering::Relaxed))
			};
			let result = DeviceView {
				device_id: id.clone(),
				name: d.name.clone(),
				paired: d.paired,
			};
			r.devices.insert(
				id,
				Entry {
					owner: label,
					generation: op.generation,
					device: d,
				},
			);
			Ok(result)
		})();
		let _ = tx.send(result);
	};
	#[cfg(target_os = "macos")]
	webview.app_handle().run_on_main_thread(task).map_err(|_| "无法打开 Classic 系统窗口")?;
	#[cfg(not(target_os = "macos"))]
	tauri::async_runtime::spawn_blocking(task);
	rx.await.map_err(|_| "Classic 系统窗口任务结束".to_string())?
}
#[tauri::command]
pub async fn classic_open(
	webview: tauri::Webview,
	state: State<'_, ClassicState>,
	device_id: String,
	owner_generation: u64,
	on_data: Channel<InvokeResponseBody>,
	on_event: Channel<serde_json::Value>,
) -> Result<u64, String> {
	let update = crate::updater::begin_device_operation(webview.app_handle())?;
	let label = webview.label().to_owned();
	let (device, op, claim) = {
		let r = state.registry.lock().unwrap();
		let e = r.devices.get(&device_id).ok_or("请重新搜索 Classic 设备")?;
		if e.owner != label || e.generation != owner_generation {
			return Err("设备不属于本窗口".into());
		}
		let op = state.owners.owner(&label).begin(Some(e.generation))?;
		let claim = state
			.claims
			.acquire("classic-connection", &label, op.generation)
			.map_err(|_| "Classic 设备已被窗口占用")?;
		(e.device.clone(), op, claim)
	};
	let id = state.next.fetch_add(1, Ordering::Relaxed);
	let app = webview.app_handle().clone();
	let stop = Arc::new(AtomicBool::new(false));
	let finished = Arc::new((Mutex::new(false), Condvar::new()));
	let (tx, requests) = mpsc::sync_channel::<Write>(8);
	let (reply, rx) = tokio::sync::oneshot::channel();
	std::thread::Builder::new()
		.name("classic-rfcomm".into())
		.spawn(move || {
			struct Finished(Arc<(Mutex<bool>, Condvar)>);
			impl Drop for Finished {
				fn drop(&mut self) {
					let (lock, cv) = &*self.0;
					*lock.lock().unwrap() = true;
					cv.notify_all();
				}
			}
			let _finished = Finished(finished.clone());
			let _claim = claim;
			let opened = (|| {
				if !op.is_current() {
					return Err("Classic 会话已回收".to_string());
				}
				let connection = platform::Connection::open(&device, &op)?;
				app.state::<ClassicState>().register_open(
					id,
					Handle {
						owner: label.clone(),
						generation: op.generation,
						stop: stop.clone(),
						finished,
						tx,
					},
					&op,
				)?;
				Ok(connection)
			})();
			drop(update);
			let _lifetime_operation = op; // Remains active through physical close, including failed/timed-out release.
			let mut connection = match opened {
				Ok(c) => c,
				Err(e) => {
					let _ = reply.send(Err(e));
					return;
				}
			};
			if reply.send(Ok(id)).is_err() {
				stop.store(true, Ordering::Release);
			}
			let mut buf = [0u8; 8192];
			while !stop.load(Ordering::Acquire) {
				if let Ok(w) = requests.try_recv() {
					let result = if !w.operation.is_current() || stop.load(Ordering::Acquire) {
						Err("Classic 会话已回收".into())
					} else {
						connection.write(&w.data, &w.operation)
					};
					let failed = result.is_err();
					let _ = w.result.send(result);
					if failed {
						break;
					}
				}
				match connection.read(&mut buf) {
					Ok(0) => {}
					Ok(n) => {
						if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
							break;
						}
					}
					Err(_) => break,
				}
			}
			drop(connection); // Release physical channel BEFORE the device claim / completion signal.
			let _ = on_event.send(serde_json::json!({"type":"lost"}));
			app.state::<ClassicState>().registry.lock().unwrap().handles.remove(&id);
		})
		.map_err(|_| "无法启动 Classic 通道线程")?;
	rx.await.map_err(|_| "Classic 通道打开任务失败".to_string())?
}
#[tauri::command]
pub async fn classic_write(webview: tauri::Webview, state: State<'_, ClassicState>, handle: u64, data: Vec<u8>) -> Result<(), String> {
	if data.is_empty() || data.len() > 65536 {
		return Err("Classic 写入长度须为 1..65536 字节".into());
	}
	let update = crate::updater::begin_device_operation(webview.app_handle())?;
	let (h, operation) = state.operation(webview.label(), handle)?;
	let (result, rx) = tokio::sync::oneshot::channel();
	h.tx.try_send(Write {
		data,
		result,
		operation,
		_update: update,
	})
	.map_err(|_| "Classic 通道忙或已关闭")?;
	rx.await.map_err(|_| "Classic 写入中断，结果未知".to_string())?
}
#[tauri::command]
pub async fn classic_close(webview: tauri::Webview, state: State<'_, ClassicState>, handle: u64) -> Result<(), String> {
	if !state.registry.lock().unwrap().handles.contains_key(&handle) {
		return Ok(());
	}
	let (h, op) = state.operation(webview.label(), handle)?;
	h.stop.store(true, Ordering::Release);
	tauri::async_runtime::spawn_blocking(move || {
		let _op = op;
		if wait_closed(&h, Instant::now() + Duration::from_secs(3)) {
			Ok(())
		} else {
			Err("Classic 通道未确认关闭，请重试".into())
		}
	})
	.await
	.map_err(|_| "Classic 关闭任务失败".to_string())?
}

#[cfg(test)]
mod tests {
	use super::*;
	fn handle(generation: u64) -> Handle {
		let (tx, _rx) = mpsc::sync_channel(1);
		Handle {
			owner: "fixture".into(),
			generation,
			stop: Arc::new(AtomicBool::new(false)),
			finished: Arc::new((Mutex::new(false), Condvar::new())),
			tx,
		}
	}
	#[test]
	fn repeated_release_cannot_pass_live_reader_after_handles_removed() {
		let state = ClassicState::default();
		let worker = state.owners.owner("fixture").begin(None).unwrap();
		let h = handle(worker.generation);
		let stopped = h.stop.clone();
		let finished = h.finished.clone();
		state.register_open(1, h, &worker).unwrap();
		let (physical_close, wait) = mpsc::channel();
		let thread = std::thread::spawn(move || {
			let _lifetime_operation = worker;
			wait.recv().unwrap(); // Synthetic native driver finishes physical close here.
			let (lock, cv) = &*finished;
			*lock.lock().unwrap() = true;
			cv.notify_all();
		});
		assert!(drain_until(state.release("fixture"), Instant::now()).is_err());
		assert!(stopped.load(Ordering::Acquire));
		assert!(state.registry.lock().unwrap().handles.is_empty());
		assert!(drain_until(state.release("fixture"), Instant::now()).is_err());
		physical_close.send(()).unwrap();
		thread.join().unwrap();
		assert!(drain_until(state.release("fixture"), Instant::now()).is_ok());
	}
	#[test]
	fn release_during_pending_open_denies_actual_registration_and_stays_busy() {
		let state = ClassicState::default();
		let pending = state.owners.owner("fixture").begin(None).unwrap();
		assert!(drain_until(state.release("fixture"), Instant::now()).is_err());
		assert!(state.register_open(1, handle(pending.generation), &pending).is_err());
		assert!(state.owners.owner("fixture").begin(Some(pending.generation)).is_err());
		assert!(state.registry.lock().unwrap().handles.is_empty());
		assert!(drain_until(state.release("fixture"), Instant::now()).is_err());
		drop(pending);
		assert!(drain_until(state.release("fixture"), Instant::now()).is_ok());
	}
	#[test]
	fn handles_are_owner_scoped_and_release_does_not_invalidate_other_window() {
		let state = ClassicState::default();
		let a = state.owners.owner("fixture").begin(None).unwrap();
		let b = state.owners.owner("b").begin(None).unwrap();
		state.register_open(1, handle(a.generation), &a).unwrap();
		assert!(state.operation("b", 1).is_err());
		let release = state.release("fixture");
		assert!(!a.is_current());
		assert!(b.is_current());
		drop(release);
	}
}

#[cfg(test)]
mod picker_tests {
	use super::*;
	#[test]
	fn repeated_system_selection_reuses_only_same_native_identity_and_owner_generation() {
		let mut registry = Registry::default();
		registry.devices.insert(
			"fixture-id".into(),
			Entry {
				owner: "fixture-owner".into(),
				generation: 1,
				device: Device {
					address: "synthetic-native-identity".into(),
					name: "Same name".into(),
					paired: true,
				},
			},
		);
		assert_eq!(
			registry.device_key("fixture-owner", 1, "synthetic-native-identity").as_deref(),
			Some("fixture-id")
		);
		assert!(registry.device_key("fixture-owner", 2, "synthetic-native-identity").is_none());
		assert!(registry.device_key("other-owner", 1, "synthetic-native-identity").is_none());
		assert!(registry.device_key("fixture-owner", 1, "another-native-identity").is_none());
	}
}
