// 原生串口：列口、打开、读线程推数据、写、关闭、控制信号。前端由 js/transport-native-serial.js 包装成 Web Serial 形状的端口。
// 读线程把收到的字节经 on_data 通道原样推给前端，读错误与设备丢失经 on_event 通道报告；设备丢失后由前端调 serial_close 释放句柄。
// 打开、写、关闭都是阻塞调用，一律放进 spawn_blocking，同步命令会在主线程上跑、卡住界面。
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};

use crate::lease::{resource_key, ClaimDenied, ClaimGuard, OwnerLifecycle, OwnerOperation, OwnerRelease, OwnerSet};

// 读写都用短超时轮询：读线程靠它及时看到停止标记；写由 write_all_until 按截止时间循环，
// 不给读写两个句柄设不同超时(Windows 上复制出的句柄共用一份 COMMTIMEOUTS，会互相覆盖)
const IO_TIMEOUT: Duration = Duration::from_millis(20);
// 连续读错误到这个次数、且从第一次错误起持续了 READ_ERROR_WINDOW 仍查得到设备，也按设备丢失处理，免得读线程空转刷错误；
// 只按次数判会被 20 ms 退避压成约 1 s，USB 挂起恢复、hub 抖动这类健康设备上的短暂错误突发也会被当成掉线
const MAX_READ_ERRORS: u32 = 50;
const READ_ERROR_WINDOW: Duration = Duration::from_millis(2500);
const RELEASE_TIMEOUT: Duration = Duration::from_secs(3);

// 串口的释放收尾：逐个关停收回来的句柄(共用总截止)，先放掉这批引用再等在飞 operation 归还。
// releasing 屏障由 OwnerRelease 的 Drop 减回(lease.rs)，哪怕这里没跑完也不会把该窗口永久挡住。
impl OwnerRelease<Vec<Arc<Handle>>> {
	fn finish(mut self) {
		let deadline = Instant::now() + RELEASE_TIMEOUT;
		for h in &self.payload {
			shutdown(h.clone(), Some(deadline));
		}
		// Drop our writer handles before waiting for the remaining operation references.
		drop(std::mem::take(&mut self.payload));
		if !self.wait_drained(deadline) {
			eprintln!("serial owner release timed out waiting for pending operations");
		}
		// Outstanding operations still carry the old generation and cannot register a handle.
	}
}

// serialport 把 errno 转成只带描述文字的 Unknown 错误(文字取自 nix 的 errno 描述表)，只能按文字认 ENOTTY；
// 认不出来的后果只是虚拟串口照旧打不开，真实串口不会报 ENOTTY
fn is_enotty(e: &serialport::Error) -> bool {
	e.kind() == serialport::ErrorKind::Unknown && matches!(e.description.as_str(), "Not a typewriter" | "Inappropriate ioctl for device")
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PortDesc {
	// 打开用的完整路径：macOS /dev/cu.xxx，Windows COM3
	path: String,
	// 给人看的短名：macOS cu.xxx，Windows COM3
	name: String,
	// usb | pci | bluetooth | unknown
	transport: &'static str,
	vendor_id: Option<u16>,
	product_id: Option<u16>,
	serial_number: Option<String>,
	manufacturer: Option<String>,
	// 产品名；Windows 上是设备管理器里的友好名(已去掉末尾的「(COMx)」)
	product: Option<String>,
	// 本进程(任一窗口)已打开这个口
	open: bool,
}

fn clean(s: Option<String>) -> Option<String> {
	s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn clean_product(product: Option<String>, name: &str) -> Option<String> {
	clean(product).and_then(|product| {
		let tail = format!(" ({})", name);
		clean(Some(product.strip_suffix(&tail).unwrap_or(&product).to_string()))
	})
}

#[cfg(windows)]
mod windows_names {
	use super::{clean, clean_product, PortDesc};
	use std::collections::HashMap;
	use std::mem::size_of;
	use std::ptr::{null, null_mut};
	use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
		SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceRegistryPropertyW, SetupDiOpenDevRegKey, DICS_FLAG_GLOBAL,
		DIGCF_PRESENT, DIREG_DEV, GUID_DEVCLASS_MODEM, GUID_DEVCLASS_PORTS, HDEVINFO, SPDRP_DEVICEDESC, SPDRP_FRIENDLYNAME, SPDRP_MFG, SP_DEVINFO_DATA,
	};
	use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
	use windows_sys::Win32::System::Registry::{RegCloseKey, RegQueryValueExW, KEY_QUERY_VALUE, REG_SZ};

	struct DeviceSet(HDEVINFO);

	impl Drop for DeviceSet {
		fn drop(&mut self) {
			unsafe { SetupDiDestroyDeviceInfoList(self.0) };
		}
	}

	fn decode(buffer: &[u16], bytes: u32) -> Option<String> {
		if bytes % 2 != 0 || bytes as usize > size_of::<u16>() * buffer.len() {
			return None;
		}
		let text = &buffer[..bytes as usize / 2];
		let end = text.iter().position(|value| *value == 0).unwrap_or(text.len());
		clean(Some(String::from_utf16_lossy(&text[..end])))
	}

	fn property(set: &DeviceSet, device: &SP_DEVINFO_DATA, property: u32) -> Option<String> {
		let mut bytes = 0;
		let mut value_type = 0;
		unsafe {
			SetupDiGetDeviceRegistryPropertyW(set.0, device, property, &mut value_type, null_mut(), 0, &mut bytes);
		}
		if bytes == 0 || bytes % 2 != 0 {
			return None;
		}
		let mut buffer = vec![0u16; bytes as usize / 2];
		let success = unsafe { SetupDiGetDeviceRegistryPropertyW(set.0, device, property, &mut value_type, buffer.as_mut_ptr().cast(), bytes, &mut bytes) };
		if success == 0 || value_type != REG_SZ {
			return None;
		}
		decode(&buffer, bytes)
	}

	fn port_name(set: &DeviceSet, device: &SP_DEVINFO_DATA) -> Option<String> {
		let key = unsafe { SetupDiOpenDevRegKey(set.0, device, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_QUERY_VALUE) };
		if key == INVALID_HANDLE_VALUE {
			return None;
		}
		let value_name: Vec<u16> = "PortName".encode_utf16().chain(Some(0)).collect();
		let mut bytes = 0;
		let mut value_type = 0;
		let result = (|| {
			let status = unsafe { RegQueryValueExW(key, value_name.as_ptr(), null(), &mut value_type, null_mut(), &mut bytes) };
			if status != 0 || value_type != REG_SZ || bytes == 0 || bytes % 2 != 0 {
				return None;
			}
			let mut buffer = vec![0u16; bytes as usize / 2];
			let status = unsafe { RegQueryValueExW(key, value_name.as_ptr(), null(), &mut value_type, buffer.as_mut_ptr().cast(), &mut bytes) };
			if status != 0 || value_type != REG_SZ {
				return None;
			}
			decode(&buffer, bytes)
		})();
		unsafe { RegCloseKey(key) };
		result
	}

	pub(super) fn enrich(ports: &mut [PortDesc]) {
		let mut names = HashMap::new();
		for class in [GUID_DEVCLASS_PORTS, GUID_DEVCLASS_MODEM] {
			let handle = unsafe { SetupDiGetClassDevsW(&class, null(), null_mut(), DIGCF_PRESENT) };
			if handle == INVALID_HANDLE_VALUE as HDEVINFO {
				continue;
			}
			let set = DeviceSet(handle);
			let mut index = 0;
			loop {
				let mut device: SP_DEVINFO_DATA = unsafe { std::mem::zeroed() };
				device.cbSize = size_of::<SP_DEVINFO_DATA>() as u32;
				if unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut device) } == 0 {
					break;
				}
				index += 1;
				if let Some(path) = port_name(&set, &device) {
					let product = property(&set, &device, SPDRP_FRIENDLYNAME).or_else(|| property(&set, &device, SPDRP_DEVICEDESC));
					let manufacturer = property(&set, &device, SPDRP_MFG);
					names.insert(path.to_ascii_uppercase(), (product, manufacturer));
				}
			}
		}
		for port in ports {
			if let Some((product, manufacturer)) = names.remove(&port.path.to_ascii_uppercase()) {
				if product.is_some() {
					port.product = clean_product(product, &port.name);
				}
				if manufacturer.is_some() {
					port.manufacturer = manufacturer;
				}
			}
		}
	}
}

fn short_name(path: &str) -> String {
	path.rsplit('/').next().unwrap_or(path).to_string()
}

// macOS 同一设备有 tty.*(拨入，打开会等 DCD)与 cu.*(呼出)两个节点，只列 cu.*；系统自带的调试 / 蓝牙口不列
fn listed(path: &str) -> bool {
	if cfg!(target_os = "macos") {
		let n = short_name(path);
		if !n.starts_with("cu.") {
			return false;
		}
		return !matches!(n.as_str(), "cu.debug-console" | "cu.Bluetooth-Incoming-Port" | "cu.wlan-debug");
	}
	true
}

fn describe(p: serialport::SerialPortInfo, open: bool) -> PortDesc {
	let name = short_name(&p.port_name);
	let mut d = PortDesc {
		path: p.port_name.clone(),
		name,
		transport: "unknown",
		vendor_id: None,
		product_id: None,
		serial_number: None,
		manufacturer: None,
		product: None,
		open,
	};
	match p.port_type {
		serialport::SerialPortType::UsbPort(u) => {
			d.transport = "usb";
			d.vendor_id = Some(u.vid);
			d.product_id = Some(u.pid);
			d.serial_number = clean(u.serial_number);
			d.manufacturer = clean(u.manufacturer);
			d.product = clean(u.product);
		}
		serialport::SerialPortType::PciPort => d.transport = "pci",
		serialport::SerialPortType::BluetoothPort => d.transport = "bluetooth",
		serialport::SerialPortType::Unknown => {}
	}
	// Windows 友好名形如「USB-SERIAL CH340 (COM3)」，口名另有一栏，去掉重复的尾巴
	d.product = clean_product(d.product, &d.name);
	d
}

fn port_present(path: &str) -> bool {
	#[cfg(unix)]
	{
		std::path::Path::new(path).exists()
	}
	#[cfg(not(unix))]
	{
		serialport::available_ports().map(|l| l.iter().any(|p| p.port_name == path)).unwrap_or(true)
	}
}

struct Handle {
	path: String,
	// 打开它的 webview 标签：页面刷新或窗口关闭后 JS 端的状态没了，句柄按标签收回，免得独占锁一直挂着
	owner: String,
	lifecycle: Arc<OwnerLifecycle>,
	generation: u64,
	// 设备租约凭据：不主动读，存活即占用。写句柄与读线程各持一份(见 spawn_reader)，
	// 回收超时 detach 读线程后，句柄先释放占用仍在，直到读线程真正退出、两份凭据都归还
	#[allow(dead_code)]
	claim: Arc<ClaimGuard>,
	port: Mutex<Box<dyn serialport::SerialPort>>,
	stop: Arc<AtomicBool>,
	reader: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
pub struct SerialState {
	next: AtomicU32,
	handles: Mutex<HashMap<u32, Arc<Handle>>>,
	owners: OwnerSet,
	// 设备级单 owner 租约：已登记句柄与打开途中的 pending 都算占用，跨窗口争用在这里裁决(lease.rs)
	claims: crate::lease::Claims,
}

impl SerialState {
	fn operation(&self, id: u32) -> Result<(Arc<Handle>, OwnerOperation), String> {
		// Taking the reference and counting it must be atomic with owner release.
		let map = self.handles.lock().unwrap();
		let h = map.get(&id).ok_or_else(|| "串口未打开".to_string())?;
		let operation = h.lifecycle.begin(Some(h.generation))?;
		Ok((h.clone(), operation))
	}
	fn claimed_paths(&self) -> Vec<String> {
		self.claims.keys()
	}
	fn owner(&self, label: &str) -> Arc<OwnerLifecycle> {
		self.owners.owner(label)
	}

	// Invalidate opens and prevent new operations before taking the registered handles.
	// All paths lock the handle map before the lifecycle (invalidate 也在这把锁里推进代次)。
	fn begin_release(&self, label: &str) -> OwnerRelease<Vec<Arc<Handle>>> {
		let owner = self.owner(label);
		let mut map = self.handles.lock().unwrap();
		owner.invalidate();
		let ids: Vec<u32> = map.iter().filter(|(_, h)| h.owner == label).map(|(id, _)| *id).collect();
		let handles: Vec<_> = ids.into_iter().filter_map(|id| map.remove(&id)).collect();
		for h in &handles {
			h.stop.store(true, Ordering::Release);
		}
		drop(map);
		OwnerRelease::new(owner, handles)
	}
}

fn shutdown(h: Arc<Handle>, deadline: Option<Instant>) {
	h.stop.store(true, Ordering::Release);
	let reader = h.reader.lock().unwrap().take();
	if let Some(th) = reader {
		while !th.is_finished() && deadline.is_some_and(|end| Instant::now() < end) {
			std::thread::sleep(IO_TIMEOUT);
		}
		if deadline.is_none() || th.is_finished() {
			let _ = th.join();
		} else {
			// Dropping JoinHandle detaches; the reader still owns its port until it exits.
			// 读线程闭包里还有一份 claim 凭据，占用不会随句柄先释放
			eprintln!("serial reader shutdown timed out: {}", h.path);
		}
	}
}

// Updater already freezes and drains device operations before calling this.
pub fn release_owner(state: &SerialState, owner: &str) {
	state.begin_release(owner).finish();
}

// Invalidate synchronously, but never join a reader on the window event thread.
pub fn release_destroyed(state: &SerialState, owner: &str) {
	let release = state.begin_release(owner);
	tauri::async_runtime::spawn_blocking(move || release.finish());
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOptions {
	baud_rate: u32,
	data_bits: Option<u8>,
	stop_bits: Option<u8>,
	parity: Option<String>,
	flow_control: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signals {
	data_terminal_ready: Option<bool>,
	request_to_send: Option<bool>,
	#[serde(rename = "break")]
	brk: Option<bool>,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
	tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn serial_list(state: State<'_, SerialState>) -> Result<Vec<PortDesc>, String> {
	// 占用按设备租约算：已登记的句柄和别的窗口正在打开中的口都算「已打开」
	let open: std::collections::HashSet<String> = state.claimed_paths().into_iter().collect();
	blocking(move || {
		let ports = serialport::available_ports().map_err(|e| e.to_string())?;
		let mut out: Vec<PortDesc> = ports
			.into_iter()
			.filter(|p| listed(&p.port_name))
			.map(|p| {
				let is_open = open.contains(&resource_key(&p.port_name));
				describe(p, is_open)
			})
			.collect();
		#[cfg(windows)]
		windows_names::enrich(&mut out);
		// 开发调试：SERIAL_EXTRA_PORTS 里列的路径(冒号或逗号分隔，如 socat 建的 /dev/ttys003)也当串口列出。
		// 虚拟串口对不在 IOKit / SetupAPI 的串口枚举里，不这样就没法在客户端里用虚拟串口自测
		if let Ok(extra) = std::env::var("SERIAL_EXTRA_PORTS") {
			for p in extra.split([':', ',']).map(str::trim).filter(|p| !p.is_empty() && port_present(p)) {
				if !out.iter().any(|d| d.path == p) {
					let info = serialport::SerialPortInfo {
						port_name: p.to_string(),
						port_type: serialport::SerialPortType::Unknown,
					};
					out.push(describe(info, open.contains(&resource_key(p))));
				}
			}
		}
		out.sort_by(|a, b| a.path.cmp(&b.path));
		out.dedup_by(|a, b| a.path == b.path);
		Ok(out)
	})
	.await
}

// serialport represents an ordinary empty read as a synthetic timeout without an errno
// (windows/com.rs and posix/poll.rs). A real OS error retains raw_os_error (notably
// Windows ERROR_OPERATION_ABORTED). Do not also gate on elapsed time: a platform that
// rounds the timeout down would turn every idle wait into an error.
fn normal_idle_error(error: &std::io::Error) -> bool {
	matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) && error.raw_os_error().is_none()
}

// 读线程入口：claim 随闭包进线程，与 Handle 里的那份共持同一租约——
// 回收超时 detach 后句柄先释放占用仍在，读线程退出时两份凭据都归还才释放
fn spawn_reader(
	id: u32,
	path: String,
	reader: Box<dyn serialport::SerialPort>,
	claim: Arc<ClaimGuard>,
	stop: Arc<AtomicBool>,
	on_data: Channel<InvokeResponseBody>,
	on_event: Channel<serde_json::Value>,
) -> std::io::Result<JoinHandle<()>> {
	std::thread::Builder::new()
		.name(format!("serial-read-{}", id))
		.spawn(move || {
			let _claim = claim;
			read_loop(path, reader, stop, on_data, on_event)
		})
}

fn read_loop(
	path: String,
	mut port: Box<dyn serialport::SerialPort>,
	stop: Arc<AtomicBool>,
	on_data: Channel<InvokeResponseBody>,
	on_event: Channel<serde_json::Value>,
) {
	let mut buf = vec![0u8; 64 * 1024];
	let mut errors: u32 = 0;
	let mut first_error = Instant::now();
	// 第一次读错误就查一次在位，真拔出时立刻报丢失
	let mut last_presence_check = Instant::now().checked_sub(Duration::from_secs(1)).unwrap_or_else(Instant::now);
	let lost = |msg: String| {
		let _ = on_event.send(json!({ "type": "lost", "message": msg }));
	};
	while !stop.load(Ordering::Acquire) {
		match port.read(&mut buf) {
			Ok(0) => {
				errors = 0;
				// 部分驱动拔出后读到 EOF 而不是报错
				if !port_present(&path) {
					lost("设备已断开".into());
					return;
				}
				std::thread::sleep(IO_TIMEOUT);
			}
			Ok(n) => {
				errors = 0;
				// 前端窗口已关，通道发不出去：没人收了，退出读线程
				if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
					return;
				}
			}
			Err(e) => {
				if stop.load(Ordering::Acquire) {
					return;
				}
				let idle = matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted);
				// POSIX backends report an ordinary full-duration idle wait as TimedOut.
				// Immediate errors (including Windows aborted I/O mapped to TimedOut) must accrue.
				// 空闲超时本身已等满 IO_TIMEOUT，不再补睡，否则收数据要多等一轮
				if normal_idle_error(&e) {
					errors = 0;
					continue;
				}
				if errors == 0 {
					first_error = Instant::now();
				}
				errors += 1;
				let persistent = errors >= MAX_READ_ERRORS && first_error.elapsed() >= READ_ERROR_WINDOW;
				if persistent || last_presence_check.elapsed() >= Duration::from_secs(1) {
					last_presence_check = Instant::now();
					if !port_present(&path) {
						lost(format!("设备已断开: {}", e));
						return;
					}
				}
				if persistent {
					lost(format!("串口持续读错误: {}", e));
					return;
				}
				// 同一串错误只报一次，前端每报一次就换一条读流
				if errors == 1 && !idle {
					let _ = on_event.send(json!({ "type": "error", "message": e.to_string() }));
				}
				std::thread::sleep(IO_TIMEOUT);
			}
		}
	}
}

#[tauri::command]
pub async fn serial_open(
	webview: tauri::Webview,
	state: State<'_, SerialState>,
	path: String,
	options: OpenOptions,
	on_data: Channel<InvokeResponseBody>,
	on_event: Channel<serde_json::Value>,
) -> Result<u32, String> {
	let _operation = crate::updater::begin_device_operation(webview.app_handle())?;
	let lifecycle = state.owner(webview.label());
	let owner_operation = lifecycle.begin(None)?;
	let app = webview.app_handle().clone();
	let owner = webview.label().to_string();
	// 设备租约在触碰硬件前裁决：本窗口另一路 / 别的窗口占用(含正在打开)都在 open 之前拒绝；
	// 同窗口旧代次残留的占用在凭据归还前也不放行(新旧两个方向都禁止顶替，见 lease.rs)，
	// 旧在飞 open 仍会在它的登记屏障失败
	let claim = state
		.claims
		.acquire(&resource_key(&path), &owner, owner_operation.generation)
		.map_err(|d| match d {
			ClaimDenied::SameOwner => "该串口已被本窗口另一路占用".to_string(),
			ClaimDenied::OtherOwner => "该串口正被另一窗口占用".to_string(),
		})?;
	if !owner_operation.is_current() {
		return Err("串口会话已回收".into());
	}
	let p = path.clone();
	blocking(move || {
		// Keep both barriers alive even if the async command is cancelled.
		let _operation = _operation;
		let owner_operation = owner_operation;
		let claim = claim;
		let state = app.state::<SerialState>();
		let data_bits = match options.data_bits.unwrap_or(8) {
			5 => serialport::DataBits::Five,
			6 => serialport::DataBits::Six,
			7 => serialport::DataBits::Seven,
			_ => serialport::DataBits::Eight,
		};
		let stop_bits = if options.stop_bits == Some(2) {
			serialport::StopBits::Two
		} else {
			serialport::StopBits::One
		};
		let parity = match options.parity.as_deref() {
			Some("even") => serialport::Parity::Even,
			Some("odd") => serialport::Parity::Odd,
			_ => serialport::Parity::None,
		};
		let flow = if options.flow_control.as_deref() == Some("hardware") {
			serialport::FlowControl::Hardware
		} else {
			serialport::FlowControl::None
		};
		let build = |baud: u32| {
			let builder = serialport::new(&p, baud)
				.data_bits(data_bits)
				.stop_bits(stop_bits)
				.parity(parity)
				.flow_control(flow)
				.timeout(IO_TIMEOUT);
			#[cfg(not(windows))]
			{
				builder.open()
			}
			#[cfg(windows)]
			{
				let port = builder.open_native()?;
				if flow == serialport::FlowControl::Hardware {
					windows_hardware_handshake(&port)?;
				}
				Ok(Box::new(port) as Box<dyn serialport::SerialPort>)
			}
		};
		let port = match build(options.baud_rate) {
			Ok(port) => Ok(port),
			// 虚拟串口(伪终端，如 socat 建的口)不认设置波特率的 ioctl，报 ENOTTY；伪终端本来没有波特率，按 0 (不设)再开一次
			Err(e) if cfg!(unix) && is_enotty(&e) => build(0),
			Err(e) => Err(e),
		}
		.map_err(|e| format!("打开 {} 失败: {}", short_name(&p), e))?;
		let reader = port.try_clone().map_err(|e| e.to_string())?;
		// Linearize registration with release. Stale ports and their clones drop here.
		// invalidate 也只在 handles 锁里推进代次，所以 is_current 到 insert 之间不会被释放插队。
		let mut map = state.handles.lock().unwrap();
		if !owner_operation.is_current() {
			return Err("串口会话已回收".into());
		}
		if crate::updater::frozen(&app) {
			return Err("应用正在准备升级".into());
		}
		let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
		let stop = Arc::new(AtomicBool::new(false));
		let claim = Arc::new(claim);
		let th = spawn_reader(id, path.clone(), reader, claim.clone(), stop.clone(), on_data, on_event).map_err(|e| e.to_string())?;
		let h = Arc::new(Handle {
			path,
			owner,
			lifecycle: lifecycle.clone(),
			generation: owner_operation.generation,
			claim,
			port: Mutex::new(port),
			stop,
			reader: Mutex::new(Some(th)),
		});
		map.insert(id, h);
		Ok(id)
	})
	.await
}

// 写满为止：每次 write 可能只写进一部分或在短超时上返回，按数据量与波特率留足截止时间(硬件流控卡住时也会在这里超时)
fn write_all_until(port: &mut Box<dyn serialport::SerialPort>, data: &[u8], stop: &AtomicBool, operation: &OwnerOperation) -> Result<(), String> {
	let baud = port.baud_rate().unwrap_or(9600).max(1) as u64;
	let budget = 2000 + (data.len() as u64) * 11 * 1000 * 2 / baud;
	let deadline = Instant::now() + Duration::from_millis(budget);
	let mut off = 0;
	while off < data.len() {
		if stop.load(Ordering::Acquire) || !operation.is_current() {
			return Err("串口会话已回收".into());
		}
		match port.write(&data[off..]) {
			Ok(n) => off += n,
			Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
			Err(e) => return Err(e.to_string()),
		}
		if off < data.len() && Instant::now() > deadline {
			return Err("写入超时".into());
		}
	}
	Ok(())
}

#[tauri::command]
pub async fn serial_write(app: tauri::AppHandle, state: State<'_, SerialState>, handle: u32, data: Vec<u8>) -> Result<(), String> {
	let _operation = crate::updater::begin_device_operation(&app)?;
	let (h, owner_operation) = state.operation(handle)?;
	blocking(move || {
		let _operation = _operation;
		let owner_operation = owner_operation;
		let result = {
			let mut port = h.port.lock().unwrap();
			write_all_until(&mut port, &data, &h.stop, &owner_operation)
		};
		drop(h);
		drop(owner_operation);
		result
	})
	.await
}

#[tauri::command]
pub async fn serial_set_signals(app: tauri::AppHandle, state: State<'_, SerialState>, handle: u32, signals: Signals) -> Result<(), String> {
	let _operation = crate::updater::begin_device_operation(&app)?;
	let (h, owner_operation) = state.operation(handle)?;
	blocking(move || {
		let _operation = _operation;
		let owner_operation = owner_operation;
		let result = (|| {
			let mut port = h.port.lock().unwrap();
			if h.stop.load(Ordering::Acquire) {
				return Err("串口会话已回收".into());
			}
			if let Some(v) = signals.data_terminal_ready {
				port.write_data_terminal_ready(v).map_err(|e| e.to_string())?;
			}
			if let Some(v) = signals.request_to_send {
				port.write_request_to_send(v).map_err(|e| e.to_string())?;
			}
			if let Some(v) = signals.brk {
				if v { port.set_break() } else { port.clear_break() }.map_err(|e| e.to_string())?;
			}
			Ok(())
		})();
		drop(h);
		drop(owner_operation);
		result
	})
	.await
}

// 已经关过(设备丢失后前端补关、重复关)按成功处理：句柄不在就是已释放
#[tauri::command]
pub async fn serial_close(state: State<'_, SerialState>, handle: u32) -> Result<(), String> {
	// Include closes removed from the map in the owner drain as well.
	let (h, owner_operation) = match state.operation(handle) {
		Ok(operation) => operation,
		Err(_) => return Ok(()), // already closed or owner release is responsible
	};
	state.handles.lock().unwrap().remove(&handle);
	blocking(move || {
		let owner_operation = owner_operation;
		// Preserve explicit-close semantics: success means the reader has released its port.
		// Owner release can still time out independently while this operation drains.
		shutdown(h, None);
		drop(owner_operation);
		Ok(())
	})
	.await
}

// 页面加载时调用：收回这个 webview 上一次页面(刷新前)留下的句柄。pagehide 里的关闭是发出即走，刷新时不一定来得及完成
#[tauri::command]
pub async fn serial_release_owned(webview: tauri::Webview, state: State<'_, SerialState>) -> Result<(), String> {
	let release = state.begin_release(webview.label());
	blocking(move || {
		release.finish();
		Ok(())
	})
	.await
}

// serialport 4.10.1 enables CTS but leaves RTS permanently asserted on Windows.
// Preserve every other DCB flag; fail the open if the driver rejects handshaking.
#[cfg(windows)]
fn windows_hardware_handshake(port: &serialport::COMPort) -> serialport::Result<()> {
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::Devices::Communication::{GetCommState, SetCommState, DCB};
	let mut dcb: DCB = unsafe { std::mem::zeroed() };
	dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
	let handle = port.as_raw_handle();
	if unsafe { GetCommState(handle, &mut dcb) } == 0 {
		return Err(std::io::Error::last_os_error().into());
	}
	// Win32 DCB: fRtsControl is the two-bit field at bits 12..13; HANDSHAKE = 2.
	dcb._bitfield = (dcb._bitfield & !(3 << 12)) | (2 << 12);
	if unsafe { SetCommState(handle, &dcb) } == 0 {
		return Err(std::io::Error::last_os_error().into());
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn idle_timeout_is_distinct_from_fast_or_os_errors() {
		let timeout = std::io::Error::new(ErrorKind::TimedOut, "Operation timed out");
		assert!(normal_idle_error(&timeout));
		assert!(!normal_idle_error(&std::io::Error::from_raw_os_error(995)));
		assert!(!normal_idle_error(&std::io::Error::other("driver failure")));
	}

	// 设备租约(lease::Claims)接入 serial 的判定：跨窗口、同窗口另一路、代次顶替
	#[test]
	fn claims_arbitrate_pending_open_across_windows() {
		let state = SerialState::default();
		let op_a = state.owner("win-a").begin(None).unwrap();
		let op_b = state.owner("win-b").begin(None).unwrap();
		let key = resource_key("/dev/cu.test-claim");
		let claim_a = state.claims.acquire(&key, "win-a", op_a.generation).unwrap();
		// 窗口 A 持有(打开途中也算)时 B 拒绝
		assert_eq!(
			state.claims.acquire(&key, "win-b", op_b.generation).unwrap_err(),
			ClaimDenied::OtherOwner
		);
		// 同窗口同一代次的另一路也拒绝
		assert_eq!(
			state.claims.acquire(&key, "win-a", op_a.generation).unwrap_err(),
			ClaimDenied::SameOwner
		);
		drop(claim_a);
		assert!(state.claims.acquire(&key, "win-b", op_b.generation).is_ok());
	}

	// 回收推进代次后，旧 pending 的占用凭据未归还前新代次也不能顶替；
	// 旧请求登记屏障失败、凭据归还后才可重取
	#[test]
	fn release_advances_generation_but_held_stale_claim_still_blocks() {
		let state = SerialState::default();
		let owner = state.owner("win-a");
		let op1 = owner.begin(None).unwrap();
		let key = resource_key("/dev/cu.test-stale");
		let stale = state.claims.acquire(&key, "win-a", op1.generation).unwrap();
		// 刷新/回收：代次推进，旧 pending open 不再能登记
		let release = state.begin_release("win-a");
		assert!(owner.begin(None).is_err());
		drop(op1);
		drop(release);
		let op2 = owner.begin(None).unwrap();
		// 旧 pending 凭据还没归还，新代次不能顶替(晚到的旧请求同样拒，见 lease 测试)
		assert_eq!(
			state.claims.acquire(&key, "win-a", op2.generation).unwrap_err(),
			ClaimDenied::SameOwner
		);
		// 旧请求 is_current 失败收尾、凭据归还，占用才释放
		drop(stale);
		let current = state.claims.acquire(&key, "win-a", op2.generation).unwrap();
		drop(current);
		assert!(!state.claims.contains(&key));
	}

	// 确定性延迟的假读端：第一次 read 先报已进入，随后阻塞在 gate 上直到放行。
	// Handle 里的写端也用同一类型(gate 永不放行，写路径不会调它的 read)
	struct FakePort {
		entered: Option<std::sync::mpsc::Sender<()>>,
		gate: std::sync::mpsc::Receiver<()>,
	}

	impl std::io::Read for FakePort {
		fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
			if let Some(entered) = self.entered.take() {
				let _ = entered.send(());
			}
			let _ = self.gate.recv();
			Err(std::io::Error::new(ErrorKind::Other, "fake reader released"))
		}
	}

	impl std::io::Write for FakePort {
		fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
			Ok(buf.len())
		}
		fn flush(&mut self) -> std::io::Result<()> {
			Ok(())
		}
	}

	impl serialport::SerialPort for FakePort {
		fn name(&self) -> Option<String> {
			None
		}
		fn baud_rate(&self) -> serialport::Result<u32> {
			Ok(9600)
		}
		fn data_bits(&self) -> serialport::Result<serialport::DataBits> {
			Ok(serialport::DataBits::Eight)
		}
		fn flow_control(&self) -> serialport::Result<serialport::FlowControl> {
			Ok(serialport::FlowControl::None)
		}
		fn parity(&self) -> serialport::Result<serialport::Parity> {
			Ok(serialport::Parity::None)
		}
		fn stop_bits(&self) -> serialport::Result<serialport::StopBits> {
			Ok(serialport::StopBits::One)
		}
		fn timeout(&self) -> Duration {
			IO_TIMEOUT
		}
		fn set_baud_rate(&mut self, _v: u32) -> serialport::Result<()> {
			Ok(())
		}
		fn set_data_bits(&mut self, _v: serialport::DataBits) -> serialport::Result<()> {
			Ok(())
		}
		fn set_flow_control(&mut self, _v: serialport::FlowControl) -> serialport::Result<()> {
			Ok(())
		}
		fn set_parity(&mut self, _v: serialport::Parity) -> serialport::Result<()> {
			Ok(())
		}
		fn set_stop_bits(&mut self, _v: serialport::StopBits) -> serialport::Result<()> {
			Ok(())
		}
		fn set_timeout(&mut self, _v: Duration) -> serialport::Result<()> {
			Ok(())
		}
		fn write_request_to_send(&mut self, _v: bool) -> serialport::Result<()> {
			Ok(())
		}
		fn write_data_terminal_ready(&mut self, _v: bool) -> serialport::Result<()> {
			Ok(())
		}
		fn read_clear_to_send(&mut self) -> serialport::Result<bool> {
			Ok(false)
		}
		fn read_data_set_ready(&mut self) -> serialport::Result<bool> {
			Ok(false)
		}
		fn read_ring_indicator(&mut self) -> serialport::Result<bool> {
			Ok(false)
		}
		fn read_carrier_detect(&mut self) -> serialport::Result<bool> {
			Ok(false)
		}
		fn bytes_to_read(&self) -> serialport::Result<u32> {
			Ok(0)
		}
		fn bytes_to_write(&self) -> serialport::Result<u32> {
			Ok(0)
		}
		fn clear(&self, _b: serialport::ClearBuffer) -> serialport::Result<()> {
			Ok(())
		}
		fn try_clone(&self) -> serialport::Result<Box<dyn serialport::SerialPort>> {
			Err(serialport::Error::new(serialport::ErrorKind::NoDevice, "fake"))
		}
		fn set_break(&self) -> serialport::Result<()> {
			Ok(())
		}
		fn clear_break(&self) -> serialport::Result<()> {
			Ok(())
		}
	}

	// 回收超时 detach 读线程后，占用凭据由读线程与句柄共持：
	// 句柄先释放时另一个 owner 仍被拒，读线程退出、两份凭据都归还才释放
	#[test]
	fn detached_reader_keeps_claim_until_it_exits() {
		let claims = crate::lease::Claims::default();
		let path = "/dev/cu.test-detach";
		let key = resource_key(path);
		let claim = Arc::new(claims.acquire(&key, "win-a", 0).unwrap());
		let stop = Arc::new(AtomicBool::new(false));
		let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
		let (gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
		let th = spawn_reader(
			7,
			path.to_string(),
			Box::new(FakePort {
				entered: Some(entered_tx),
				gate: gate_rx,
			}),
			claim.clone(),
			stop.clone(),
			Channel::new(|_| Ok(())),
			Channel::new(|_| Ok(())),
		)
		.unwrap();
		let (_, dead_rx) = std::sync::mpsc::channel::<()>();
		let h = Arc::new(Handle {
			path: path.to_string(),
			owner: "win-a".to_string(),
			lifecycle: Arc::new(OwnerLifecycle::default()),
			generation: 0,
			claim,
			port: Mutex::new(Box::new(FakePort {
				entered: None,
				gate: dead_rx,
			})),
			stop,
			reader: Mutex::new(Some(th)),
		});
		// 确定读线程已卡在 read 里，再走回收路径并超时 detach
		entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
		shutdown(h.clone(), Some(Instant::now() + Duration::from_millis(100)));
		drop(h);
		// 句柄(写端)已释放、读线程尚存：另一个 owner 仍被拒
		assert_eq!(
			claims.acquire(&key, "win-b", 0).unwrap_err(),
			ClaimDenied::OtherOwner
		);
		// 放行：read 返回错误、stop 已置，读线程退出后凭据归还
		drop(gate_tx);
		let deadline = Instant::now() + Duration::from_secs(2);
		while claims.contains(&key) && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(5));
		}
		assert!(claims.acquire(&key, "win-b", 0).is_ok());
	}

	#[test]
	fn concurrent_pending_opens_keep_single_claimant() {
		let state = Arc::new(SerialState::default());
		let barrier = Arc::new(std::sync::Barrier::new(8));
		let mut workers = Vec::new();
		for i in 0..8 {
			let state = state.clone();
			let barrier = barrier.clone();
			workers.push(std::thread::spawn(move || {
				let label = format!("win-{}", i % 3);
				let generation = state.owner(&label).begin(None).unwrap().generation;
				barrier.wait();
				// 凭据带回来保住占用，否则返回值处 Drop 会让下一个立刻得手
				state.claims.acquire(&resource_key("COM7"), &label, generation).ok()
			}));
		}
		let wins: Vec<Option<ClaimGuard>> = workers.into_iter().map(|h| h.join().unwrap()).collect();
		assert_eq!(wins.iter().filter(|w| w.is_some()).count(), 1);
	}
}
