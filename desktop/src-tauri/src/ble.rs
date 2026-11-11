//! Computer BLE UART (CoreBluetooth / Windows WinRT through bluest).
//! One radio task at a time; opaque window-scoped IDs, no addresses over IPC.
use crate::lease::{Claims, OwnerOperation, OwnerRelease, OwnerSet};
use bluest::{Adapter, Characteristic, DeviceId};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
	collections::HashMap,
	sync::{
		atomic::{AtomicU64, Ordering},
		Arc, Mutex,
	},
	time::{Duration, Instant},
};
use tauri::{
	ipc::{Channel, InvokeResponseBody},
	Manager as _, State,
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selector {
	service: uuid::Uuid,
	characteristic: uuid::Uuid,
	props: u32,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
	tx: Selector,
	rx: Selector,
	response: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
	device_id: String,
	name: String,
	services: Vec<String>,
	rssi: Option<i16>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacteristicView {
	id: usize,
	service: uuid::Uuid,
	characteristic: uuid::Uuid,
	props: u32,
}
#[derive(Serialize)]
pub struct Opened {
	handle: u64,
	characteristics: Vec<CharacteristicView>,
}
struct Device {
	owner: String,
	generation: u64,
	id: DeviceId,
	adapter: Adapter,
}
enum Request {
	Write {
		data: Vec<u8>,
		reply: oneshot::Sender<Result<(), String>>,
		_update: crate::updater::DeviceOperation,
		_operation: OwnerOperation,
	},
	Start {
		profile: Profile,
		tx_id: Option<usize>,
		rx_id: Option<usize>,
		reply: oneshot::Sender<Result<(), String>>,
		_update: crate::updater::DeviceOperation,
		_operation: OwnerOperation,
	},
}
fn select(views: &[CharacteristicView], selector: &Selector, id: Option<usize>) -> Result<usize, String> {
	let matches: Vec<_> = views
		.iter()
		.filter(|c| c.service == selector.service && c.characteristic == selector.characteristic && c.props == selector.props && id.is_none_or(|id| c.id == id))
		.collect();
	if matches.len() != 1 {
		return Err("UUID / 属性不匹配或存在重复实例，请重新发现并选择 TX/RX".into());
	}
	Ok(matches[0].id)
}
struct Task {
	owner: String,
	generation: u64,
	cancel: CancellationToken,
	stop_scan: Option<CancellationToken>,
	done: watch::Receiver<bool>,
	writes: Option<mpsc::Sender<Request>>,
}
#[derive(Default)]
struct Registry {
	devices: HashMap<String, Device>,
	tasks: HashMap<u64, Arc<Task>>,
}
#[derive(Default)]
pub struct BleState {
	registry: Mutex<Registry>,
	owners: OwnerSet,
	claims: Claims,
	next: AtomicU64,
}
impl BleState {
	fn release(&self, owner: &str) -> OwnerRelease<()> {
		let mut r = self.registry.lock().unwrap();
		let life = self.owners.owner(owner);
		life.invalidate();
		r.devices.retain(|_, d| d.owner != owner);
		for t in r.tasks.values().filter(|t| t.owner == owner) {
			t.cancel.cancel();
		}
		OwnerRelease::new(life, ())
	}
	fn task(&self, owner: &str, id: u64) -> Result<Option<Arc<Task>>, String> {
		let r = self.registry.lock().unwrap();
		let Some(t) = r.tasks.get(&id) else { return Ok(None) };
		if t.owner != owner {
			return Err("BLE 通道不属于本窗口".into());
		}
		Ok(Some(t.clone()))
	}
}
fn drain(release: OwnerRelease<()>) -> Result<(), String> {
	if release.wait_drained(Instant::now() + Duration::from_secs(3)) {
		Ok(())
	} else {
		Err("BLE 系统操作尚未结束，已请求取消，请稍后重试释放".into())
	}
}
pub fn release_owner(state: &BleState, label: &str) -> Result<(), String> {
	drain(state.release(label))
}
pub fn release_destroyed(state: &BleState, label: &str) {
	let release = state.release(label);
	tauri::async_runtime::spawn_blocking(move || {
		let _ = drain(release);
	});
}
#[tauri::command]
pub async fn ble_release_owned(webview: tauri::Webview, state: State<'_, BleState>) -> Result<u64, String> {
	let release = state.release(webview.label());
	tauri::async_runtime::spawn_blocking(move || drain(release))
		.await
		.map_err(|_| "BLE 回收任务失败")??;
	Ok(state.owners.owner(webview.label()).begin(None)?.generation)
}
// One Write Request / Write Command carries at most ATT_MTU - 3 bytes. bluest's max_write_len
// returns exactly that on both hosts (CoreBluetooth maximumWriteValueLength(.withoutResponse),
// WinRT MaxPduSize - 3), so writes with response stay single ATT writes, never prepare/execute.
// 20 is the ATT_MTU 23 floor every link supports; 512 is the GATT attribute-value ceiling, so a
// larger trusted value (ATT_MTU 517 -> 514 on Windows) is capped to 512. Values below 20 or above
// the u16 ATT_MTU bound (Windows' MaxPduSize - 3 wrapping around) are untrusted and fall back to 20.
const BLE_MIN_WRITE_LEN: usize = 20;
const BLE_MAX_WRITE_LEN: usize = 512;
const BLE_MAX_REPORTED_WRITE_LEN: usize = u16::MAX as usize - 3;
fn write_chunk_len(reported: Option<usize>) -> usize {
	match reported {
		Some(len) if (BLE_MIN_WRITE_LEN..=BLE_MAX_REPORTED_WRITE_LEN).contains(&len) => len.min(BLE_MAX_WRITE_LEN),
		_ => BLE_MIN_WRITE_LEN,
	}
}
fn current(op: &OwnerOperation, cancel: &CancellationToken) -> Result<(), String> {
	if op.is_current() && !cancel.is_cancelled() {
		Ok(())
	} else {
		Err("BLE 操作已取消".into())
	}
}
// Waiting for adapter availability is cancellable without abandoning an OS connect/write.
async fn wait_scan_ready(
	ready: impl std::future::Future<Output = Result<(), String>>,
	cancel: &CancellationToken,
	stop: &CancellationToken,
) -> Result<bool, String> {
	tokio::select! {
		biased;
		_ = cancel.cancelled() => Err("BLE 操作已取消".into()),
		_ = stop.cancelled() => Ok(false),
		result = ready => result.map(|_| true),
	}
}
#[tauri::command]
pub async fn ble_scan(webview: tauri::Webview, state: State<'_, BleState>, owner_generation: u64, on_device: Channel<serde_json::Value>) -> Result<(), String> {
	let update = crate::updater::begin_device_operation(webview.app_handle())?;
	let label = webview.label().to_string();
	let op = state.owners.owner(&label).begin(Some(owner_generation))?;
	let claim = state
		.claims
		.acquire("computer-ble", &label, op.generation)
		.map_err(|_| "BLE 正在使用，请先关闭连接或扫描")?;
	let id = state.next.fetch_add(1, Ordering::Relaxed);
	let cancel = CancellationToken::new();
	let stop = CancellationToken::new();
	let (done, done_rx) = watch::channel(false);
	{
		let mut r = state.registry.lock().unwrap();
		current(&op, &cancel)?;
		r.tasks.insert(
			id,
			Arc::new(Task {
				owner: label.clone(),
				generation: op.generation,
				cancel: cancel.clone(),
				stop_scan: Some(stop.clone()),
				done: done_rx,
				writes: None,
			}),
		);
	}
	let app = webview.app_handle().clone();
	let (reply, rx) = oneshot::channel();
	// The task owns the native future even if IPC is dropped. Never abandon an in-flight
	// OS operation: a late connect/start_scan must still be followed by physical cleanup.
	tauri::async_runtime::spawn(async move {
		let _claim = claim;
		let _update = update;
		let result = async {
			on_device.send(serde_json::json!({ "type": "started" })).map_err(|_| "BLE 扫描回调已关闭")?;
			let adapter = Adapter::default().await.ok_or("无法初始化电脑蓝牙，请检查系统蓝牙开关与权限")?;
			current(&op, &cancel)?;
			// CoreBluetooth initializes and requests permission asynchronously. Keep the
			// manager alive until it is powered on; scan() itself fails immediately
			// while initialization or the permission prompt is still pending.
			if !wait_scan_ready(
				async {
					tokio::time::timeout(Duration::from_secs(60), adapter.wait_available())
						.await
						.map_err(|_| "等待蓝牙就绪超时：请打开系统蓝牙，并在系统设置中允许本应用访问蓝牙后重试".to_string())?
						.map_err(|_| "蓝牙尚未就绪，请检查系统蓝牙开关与访问权限".to_string())
				},
				&cancel,
				&stop,
			)
			.await?
			{
				return Ok(());
			}
			current(&op, &cancel)?;
			if stop.is_cancelled() {
				return Ok(());
			}
			let mut found = HashMap::new();
			{
				let mut scan = adapter.scan(&[]).await.map_err(|_| "BLE 扫描失败，请检查系统蓝牙开关与权限")?;
				loop {
					tokio::select! {
						_ = stop.cancelled() => break,
						_ = cancel.cancelled() => break,
						adv = scan.next() => {
							let Some(adv) = adv else { return Err("BLE 扫描已意外结束，请重试".into()) };
							current(&op, &cancel)?;
							let state = app.state::<BleState>();
							let mut r = state.registry.lock().unwrap();
							current(&op, &cancel)?;
							let key = adv.device.id();
							let device_id = if let Some((id, _)) = r.devices.iter().find(|(_, d)| d.owner == label && d.generation == op.generation && d.id == key) {
								id.clone()
							} else {
								// Bound the whole owner registry, including pause/resume cycles.
								if r.devices.values().filter(|d| d.owner == label).count() >= 256 { continue; }
								let id = format!("ble-{}", state.next.fetch_add(1, Ordering::Relaxed));
								r.devices.insert(id.clone(), Device { owner: label.clone(), generation: op.generation, id: key, adapter: adapter.clone() });
								id
							};
							let record = found.entry(device_id.clone()).or_insert_with(|| (String::new(), std::collections::BTreeSet::new(), None));
							if let Some(name) = adv.adv_data.local_name.filter(|s| !s.is_empty()) { record.0 = name.chars().take(128).collect(); }
							for uuid in adv.adv_data.services { if record.1.len() < 64 { record.1.insert(uuid); } }
							record.2 = adv.rssi;
							let view = DeviceView { device_id, name: record.0.clone(), services: record.1.iter().map(|s| s.to_string()).collect(), rssi: record.2 };
							drop(r);
							if on_device.send(serde_json::json!({ "type": "device", "device": view })).is_err() { break; }
						}
					}
				}
				// Dropping bluest's scan guard stops scanning; keep native entries for inspect.
			}
			current(&op, &cancel)?;
			Ok(())
		}
		.await;
		app.state::<BleState>().registry.lock().unwrap().tasks.remove(&id);
		drop(op);
		drop(_claim);
		drop(_update);
		let _ = done.send(true);
		let _ = reply.send(result);
	});
	rx.await.map_err(|_| "BLE 扫描任务失败".to_string())?
}

// Stop only this owner's scan. Unlike release, this preserves generation and credentials.
#[tauri::command]
pub async fn ble_scan_stop(webview: tauri::Webview, state: State<'_, BleState>, owner_generation: u64) -> Result<(), String> {
	let tasks: Vec<_> = state
		.registry
		.lock()
		.unwrap()
		.tasks
		.values()
		.filter(|t| t.owner == webview.label() && t.generation == owner_generation && t.stop_scan.is_some())
		.cloned()
		.collect();
	for t in &tasks {
		t.stop_scan.as_ref().unwrap().cancel();
	}
	for t in tasks {
		let mut done = t.done.clone();
		tokio::time::timeout(Duration::from_secs(3), async {
			while !*done.borrow_and_update() {
				done.changed().await.map_err(|_| "BLE 扫描收尾失败")?;
			}
			Ok::<(), &str>(())
		})
		.await
		.map_err(|_| "BLE 扫描尚未停止，请稍后重试")?
		.map_err(String::from)?;
	}
	Ok(())
}

#[tauri::command]
pub async fn ble_open(
	webview: tauri::Webview,
	state: State<'_, BleState>,
	device_id: String,
	owner_generation: u64,
	on_data: Channel<InvokeResponseBody>,
	on_event: Channel<serde_json::Value>,
) -> Result<Opened, String> {
	let update = crate::updater::begin_device_operation(webview.app_handle())?;
	let label = webview.label().to_string();
	let (op, device_id, adapter, claim) = {
		let r = state.registry.lock().unwrap();
		let d = r.devices.get(&device_id).ok_or("请重新扫描 BLE 设备")?;
		if d.owner != label || d.generation != owner_generation {
			return Err("BLE 设备已过期或不属于本窗口".into());
		}
		let op = state.owners.owner(&label).begin(Some(owner_generation))?;
		let claim = state
			.claims
			.acquire("computer-ble", &label, op.generation)
			.map_err(|_| "只支持一条 BLE 连接，请先关闭原连接")?;
		(op, d.id.clone(), d.adapter.clone(), claim)
	};
	let id = state.next.fetch_add(1, Ordering::Relaxed);
	let cancel = CancellationToken::new();
	let (done, done_rx) = watch::channel(false);
	let (writes, mut requests) = mpsc::channel::<Request>(8);
	{
		let mut r = state.registry.lock().unwrap();
		current(&op, &cancel)?;
		r.tasks.insert(
			id,
			Arc::new(Task {
				owner: label,
				generation: op.generation,
				cancel: cancel.clone(),
				stop_scan: None,
				done: done_rx,
				writes: Some(writes),
			}),
		);
	}
	let app = webview.app_handle().clone();
	let (reply, reply_rx) = oneshot::channel();
	tauri::async_runtime::spawn(async move {
		let _claim = claim;
		let mut reply = Some(reply);
		let mut update = Some(update);
		// All Device/Service/Characteristic objects stay inside this actor. On Windows
		// dropping ALL children is the OS disconnect operation; cache only DeviceId.
		let device = adapter.open_device(&device_id).await;
		let result: Result<(), String> = async {
			let device = device.as_ref().map_err(|_| "BLE 设备已不可用，请重新扫描")?;
			current(&op, &cancel)?;
			adapter.connect_device(device).await.map_err(|_| "BLE 连接失败，请检查设备与系统权限")?;
			current(&op, &cancel)?;
			let services = device.discover_services().await.map_err(|_| "BLE 服务发现失败")?;
			let mut chars: Vec<Characteristic> = Vec::new();
			let mut views = Vec::new();
			for service in &services {
				current(&op, &cancel)?;
				let service_uuid = service.uuid_async().await.map_err(|_| "BLE 服务信息不可用")?;
				for c in service.discover_characteristics().await.map_err(|_| "BLE 特征发现失败")? {
					if chars.len() >= 1024 {
						return Err("BLE 特征数量过多".into());
					}
					let characteristic = c.uuid_async().await.map_err(|_| "BLE 特征信息不可用")?;
					let props = c.properties().await.map_err(|_| "BLE 特征属性不可用")?.to_bits();
					views.push(CharacteristicView {
						id: chars.len(),
						service: service_uuid,
						characteristic,
						props,
					});
					chars.push(c);
				}
			}
			current(&op, &cancel)?;
			if reply
				.take()
				.unwrap()
				.send(Ok(Opened {
					handle: id,
					characteristics: views.clone(),
				}))
				.is_err()
			{
				return Err("BLE 页面已关闭".into());
			}
			// Until Start, this is a configuration session, not a ready UART.
			let (profile, tx_index, rx_index, started) = loop {
				let request = tokio::select! { _ = cancel.cancelled() => return Ok(()), r = requests.recv() => r };
				let Some(request) = request else { return Ok(()) };
				match request {
					Request::Write { reply, .. } => {
						let _ = reply.send(Err("BLE 尚未订阅 RX".into()));
					}
					Request::Start {
						profile,
						tx_id,
						rx_id,
						reply,
						_update,
						_operation,
					} => {
						let resolve = (|| {
							current(&op, &cancel)?;
							let tx = select(&views, &profile.tx, tx_id)?;
							let rx = select(&views, &profile.rx, rx_id)?;
							if views[tx].props & (if profile.response { 8 } else { 4 }) == 0 || views[rx].props & 0x30 == 0 {
								return Err("所选特征不支持配置的写模式或通知".into());
							}
							Ok((tx, rx))
						})();
						match resolve {
							Ok((tx, rx)) => break (profile, tx, rx, reply),
							Err(e) => {
								let _ = reply.send(Err(e));
							}
						}
					}
				}
			};
			let tx = &chars[tx_index];
			let rx = &chars[rx_index];
			let subscribed = rx.notify().await;
			let mut notifications = match subscribed {
				Ok(stream) => stream,
				Err(_) => {
					let _ = started.send(Err("BLE RX 订阅失败".into()));
					return Err("BLE RX 订阅失败".into());
				}
			};
			let result = async {
				current(&op, &cancel)?;
				if started.send(Ok(())).is_err() {
					return Err("BLE 页面已关闭".into());
				}
				drop(update.take());
				// Receive continuously while a long firmware frame is written. bluest has a
				// bounded notification channel; serializing RX behind the whole TX frame loses data.
				let incoming = async {
					let mut health = tokio::time::interval(Duration::from_secs(1));
					loop {
						tokio::select! {
							_ = cancel.cancelled() => break,
							_ = health.tick() => { if !op.is_current() || !device.is_connected().await { break; } },
							notification = notifications.next() => {
								if current(&op, &cancel).is_err() { break; }
								match notification {
									Some(Ok(bytes)) => { if on_data.send(InvokeResponseBody::Raw(bytes)).is_err() { break; } },
									_ => break,
								}
							}
						}
					}
					let _ = on_event.send(serde_json::json!({"type":"lost"}));
					cancel.cancel();
				};
				let outgoing = async {
					loop {
						let request = tokio::select! { _ = cancel.cancelled() => break, r = requests.recv() => r };
						let Some(request) = request else { break };
						match request {
							Request::Start { reply, .. } => {
								let _ = reply.send(Err("BLE 已就绪，修改映射请先关闭连接".into()));
							}
							Request::Write {
								data,
								reply,
								_update,
								_operation,
							} => {
								let result = async {
									// Read per frame: the ATT MTU can grow after connect (Windows MaxPduSizeChanged).
									let chunk_len = write_chunk_len(
										std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tx.max_write_len()))
											.ok()
											.and_then(Result::ok),
									);
									for chunk in data.chunks(chunk_len) {
										current(&op, &cancel)?;
										let result = if profile.response {
											tx.write(chunk).await
										} else {
											tx.write_without_response(chunk).await
										};
										result.map_err(|_| "BLE 写入失败，结果可能不完整")?;
									}
									current(&op, &cancel)
								}
								.await;
								let failed = result.is_err();
								let _ = reply.send(result);
								if failed {
									break;
								}
							}
						}
					}
					let _ = on_event.send(serde_json::json!({"type":"lost"}));
					cancel.cancel();
				};
				// join, not select: loss/cancel may interrupt the RX loop, but an OS write
				// already in flight must finish before we drop GATT handles/release the claim.
				tokio::join!(incoming, outgoing);
				Ok(())
			}
			.await;
			drop(notifications);
			// Notification-stream Drop requests unsubscribe asynchronously on both hosts.
			// Observe it before releasing the connection/claim, preventing a late CCCD-disable
			// from racing a new connection. Unknown close state remains busy/retryable.
			while device.is_connected().await {
				if matches!(rx.is_notifying().await, Ok(false)) {
					break;
				}
				tokio::time::sleep(Duration::from_millis(20)).await;
			}
			result
		}
		.await;
		// All characteristic handles/notification guards above are dropped before close.
		let _ = on_event.send(serde_json::json!({"type":"lost"}));
		if let Ok(device) = &device {
			while adapter.disconnect_device(device).await.is_err() {
				if !device.is_connected().await {
					break;
				}
				tokio::time::sleep(Duration::from_secs(1)).await;
			}
		}
		drop(device); // Windows closes here, after the last GATT child was dropped.
		app.state::<BleState>().registry.lock().unwrap().tasks.remove(&id);
		drop(op);
		drop(_claim);
		drop(update);
		let _ = done.send(true);
		if let Some(reply) = reply {
			let _ = reply.send(Err(result.err().unwrap_or_else(|| "BLE 连接已取消".into())));
		}
	});
	reply_rx.await.map_err(|_| "BLE 打开任务失败".to_string())?
}
#[tauri::command]
pub async fn ble_start(
	webview: tauri::Webview,
	state: State<'_, BleState>,
	handle: u64,
	profile: Profile,
	tx_id: Option<usize>,
	rx_id: Option<usize>,
) -> Result<(), String> {
	let _update = crate::updater::begin_device_operation(webview.app_handle())?;
	let t = state.task(webview.label(), handle)?.ok_or("BLE 通道已关闭")?;
	let _op = state.owners.owner(webview.label()).begin(Some(t.generation))?;
	let (reply, rx) = oneshot::channel();
	t.writes
		.as_ref()
		.ok_or("BLE 通道尚未连接")?
		.try_send(Request::Start {
			profile,
			tx_id,
			rx_id,
			reply,
			_update,
			_operation: _op,
		})
		.map_err(|_| "BLE 配置队列忙或已关闭")?;
	rx.await.map_err(|_| "BLE 订阅中断".to_string())?
}
#[tauri::command]
pub async fn ble_write(webview: tauri::Webview, state: State<'_, BleState>, handle: u64, data: Vec<u8>) -> Result<(), String> {
	if data.is_empty() || data.len() > 65536 {
		return Err("BLE 写入长度须为 1..65536 字节".into());
	}
	let _update = crate::updater::begin_device_operation(webview.app_handle())?;
	let t = state.task(webview.label(), handle)?.ok_or("BLE 通道已关闭")?;
	let _op = state.owners.owner(webview.label()).begin(Some(t.generation))?;
	if t.cancel.is_cancelled() {
		return Err("BLE 通道正在关闭".into());
	}
	let (reply, rx) = oneshot::channel();
	t.writes
		.as_ref()
		.ok_or("BLE 通道尚未连接")?
		.try_send(Request::Write {
			data,
			reply,
			_update,
			_operation: _op,
		})
		.map_err(|_| "BLE 写入队列忙或已关闭")?;
	rx.await.map_err(|_| "BLE 写入中断，结果未知".to_string())?
}
#[tauri::command]
pub async fn ble_close(webview: tauri::Webview, state: State<'_, BleState>, handle: u64) -> Result<(), String> {
	let Some(t) = state.task(webview.label(), handle)? else { return Ok(()) };
	t.cancel.cancel();
	let mut done = t.done.clone();
	tokio::time::timeout(Duration::from_secs(3), async {
		while !*done.borrow_and_update() {
			done.changed().await.map_err(|_| "BLE 关闭任务失败")?;
		}
		Ok::<(), &str>(())
	})
	.await
	.map_err(|_| "BLE 尚未确认关闭，请稍后重试")?
	.map_err(String::from)
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn write_chunk_len_follows_reported_limit_and_falls_back_to_20() {
		assert_eq!(write_chunk_len(Some(244)), 244);
		assert_eq!(write_chunk_len(Some(20)), 20);
		assert_eq!(write_chunk_len(Some(512)), 512);
		assert_eq!(write_chunk_len(None), 20);
		assert_eq!(write_chunk_len(Some(0)), 20);
		assert_eq!(write_chunk_len(Some(19)), 20);
		// Trusted large values (Windows ATT_MTU 517 -> 514, u16 max MTU -> 65532) cap at 512.
		assert_eq!(write_chunk_len(Some(513)), 512);
		assert_eq!(write_chunk_len(Some(514)), 512);
		assert_eq!(write_chunk_len(Some(65532)), 512);
		// Beyond any u16 ATT_MTU, including Windows MaxPduSize - 3 wrapping in release builds.
		assert_eq!(write_chunk_len(Some(65533)), 20);
		assert_eq!(write_chunk_len(Some(usize::MAX - 2)), 20);
		let data: Vec<u8> = (0..1380u32).map(|i| (i % 251) as u8).collect();
		let chunks: Vec<&[u8]> = data.chunks(write_chunk_len(Some(244))).collect();
		assert_eq!(chunks.iter().map(|c| c.len()).collect::<Vec<_>>(), vec![244, 244, 244, 244, 244, 160]);
		assert_eq!(chunks.concat(), data);
		let capped: Vec<&[u8]> = data.chunks(write_chunk_len(Some(514))).collect();
		assert_eq!(capped.iter().map(|c| c.len()).collect::<Vec<_>>(), vec![512, 512, 356]);
		assert_eq!(capped.concat(), data);
	}
	#[tokio::test]
	async fn pause_terminates_wait_for_adapter_even_before_ready() {
		let cancel = CancellationToken::new();
		let stop = CancellationToken::new();
		stop.cancel();
		let paused = tokio::time::timeout(Duration::from_millis(100), wait_scan_ready(std::future::pending(), &cancel, &stop))
			.await
			.unwrap();
		assert!(!paused.unwrap());
		assert!(!cancel.is_cancelled());
		let stop = CancellationToken::new();
		let waiting = wait_scan_ready(std::future::pending(), &cancel, &stop);
		let pause = async {
			tokio::task::yield_now().await;
			stop.cancel();
		};
		let (result, _) = tokio::join!(waiting, pause);
		assert!(!result.unwrap());
	}
	#[test]
	fn stopping_scan_keeps_generation_and_claim_until_task_drains() {
		let s = BleState::default();
		let op = s.owners.owner("fixture").begin(None).unwrap();
		let claim = s.claims.acquire("computer-ble", "fixture", op.generation).unwrap();
		let cancel = CancellationToken::new();
		let stop = CancellationToken::new();
		stop.cancel();
		assert!(current(&op, &cancel).is_ok());
		assert!(s.owners.owner("fixture").begin(Some(op.generation)).is_ok());
		assert!(s.claims.acquire("computer-ble", "fixture", op.generation).is_err());
		drop(op);
		drop(claim);
		assert!(s.claims.acquire("computer-ble", "fixture", 0).is_ok());
	}

	#[test]
	fn selectors_allow_distinct_services_and_reject_ambiguous_persisted_mapping() {
		let a = uuid::Uuid::from_u128(1);
		let b = uuid::Uuid::from_u128(2);
		let mut views = vec![
			CharacteristicView {
				id: 0,
				service: a,
				characteristic: b,
				props: 8,
			},
			CharacteristicView {
				id: 1,
				service: b,
				characteristic: a,
				props: 16,
			},
		];
		let tx = Selector {
			service: a,
			characteristic: b,
			props: 8,
		};
		let rx = Selector {
			service: b,
			characteristic: a,
			props: 16,
		};
		assert_eq!(select(&views, &tx, None).unwrap(), 0);
		assert_eq!(select(&views, &rx, None).unwrap(), 1);
		views.push(CharacteristicView {
			id: 2,
			service: a,
			characteristic: b,
			props: 8,
		});
		assert!(select(&views, &tx, None).is_err());
		assert_eq!(select(&views, &tx, Some(2)).unwrap(), 2);
		assert!(select(&views, &tx, Some(1)).is_err());
	}
	#[test]
	fn release_invalidates_pending_and_preserves_busy_until_cleanup() {
		let s = BleState::default();
		let op = s.owners.owner("fixture").begin(None).unwrap();
		let claim = s.claims.acquire("computer-ble", "fixture", op.generation).unwrap();
		let cancel = CancellationToken::new();
		let (_, done) = watch::channel(false);
		s.registry.lock().unwrap().tasks.insert(
			1,
			Arc::new(Task {
				owner: "fixture".into(),
				generation: op.generation,
				cancel: cancel.clone(),
				stop_scan: None,
				done,
				writes: None,
			}),
		);
		assert!(s.task("other", 1).is_err());
		let released = s.release("fixture");
		assert!(cancel.is_cancelled());
		assert!(current(&op, &cancel).is_err());
		assert!(!released.wait_drained(Instant::now()));
		drop(released);
		assert!(s.claims.acquire("computer-ble", "other", 0).is_err());
		let again = s.release("fixture");
		assert!(!again.wait_drained(Instant::now()));
		drop(op);
		drop(claim);
		assert!(again.wait_drained(Instant::now()));
	}
}
