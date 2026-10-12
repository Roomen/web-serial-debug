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

// 读写都用短超时轮询：读线程靠它及时看到停止标记；写由 write_all_until 按截止时间循环，
// 不给读写两个句柄设不同超时(Windows 上复制出的句柄共用一份 COMMTIMEOUTS，会互相覆盖)
const IO_TIMEOUT: Duration = Duration::from_millis(20);
// 连续读错误到这个次数仍查得到设备，也按设备丢失处理，免得读线程空转刷错误
const MAX_READ_ERRORS: u32 = 50;

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
	port: Mutex<Box<dyn serialport::SerialPort>>,
	stop: Arc<AtomicBool>,
	reader: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
pub struct SerialState {
	next: AtomicU32,
	handles: Mutex<HashMap<u32, Arc<Handle>>>,
}

impl SerialState {
	fn get(&self, id: u32) -> Result<Arc<Handle>, String> {
		self.handles.lock().unwrap().get(&id).cloned().ok_or_else(|| "串口未打开".to_string())
	}
	fn open_paths(&self) -> Vec<String> {
		self.handles.lock().unwrap().values().map(|h| h.path.clone()).collect()
	}
	fn take_owned(&self, owner: &str) -> Vec<Arc<Handle>> {
		let mut map = self.handles.lock().unwrap();
		let ids: Vec<u32> = map.iter().filter(|(_, h)| h.owner == owner).map(|(id, _)| *id).collect();
		ids.into_iter().filter_map(|id| map.remove(&id)).collect()
	}
}

fn shutdown(h: Arc<Handle>) {
	h.stop.store(true, Ordering::Release);
	// 等读线程放下它那份句柄再返回，否则紧接着重开同一个口会撞上独占锁
	if let Some(th) = h.reader.lock().unwrap().take() {
		let _ = th.join();
	}
}

// 窗口关闭时由 lib.rs 调用；也给页面加载时的 serial_release_owned 用
pub fn release_owner(state: &SerialState, owner: &str) {
	for h in state.take_owned(owner) {
		shutdown(h);
	}
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
	let open = state.open_paths();
	blocking(move || {
		let ports = serialport::available_ports().map_err(|e| e.to_string())?;
		let mut out: Vec<PortDesc> = ports
			.into_iter()
			.filter(|p| listed(&p.port_name))
			.map(|p| {
				let is_open = open.contains(&p.port_name);
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
					out.push(describe(info, open.contains(&p.to_string())));
				}
			}
		}
		out.sort_by(|a, b| a.path.cmp(&b.path));
		out.dedup_by(|a, b| a.path == b.path);
		Ok(out)
	})
	.await
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
	let lost = |msg: String| {
		let _ = on_event.send(json!({ "type": "lost", "message": msg }));
	};
	while !stop.load(Ordering::Acquire) {
		match port.read(&mut buf) {
			Ok(0) => {
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
			Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
			Err(e) => {
				if stop.load(Ordering::Acquire) {
					return;
				}
				if !port_present(&path) {
					lost(format!("设备已断开: {}", e));
					return;
				}
				errors += 1;
				if errors >= MAX_READ_ERRORS {
					lost(format!("串口持续读错误: {}", e));
					return;
				}
				// 同一串错误只报一次，前端每报一次就换一条读流
				if errors == 1 {
					let _ = on_event.send(json!({ "type": "error", "message": e.to_string() }));
				}
				std::thread::sleep(Duration::from_millis(50));
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
	let p = path.clone();
	let (port, reader) = blocking(move || {
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
			serialport::new(&p, baud)
				.data_bits(data_bits)
				.stop_bits(stop_bits)
				.parity(parity)
				.flow_control(flow)
				.timeout(IO_TIMEOUT)
				.open()
		};
		let port = match build(options.baud_rate) {
			Ok(port) => Ok(port),
			// 虚拟串口(伪终端，如 socat 建的口)不认设置波特率的 ioctl，报 ENOTTY；伪终端本来没有波特率，按 0 (不设)再开一次
			Err(e) if cfg!(unix) && is_enotty(&e) => build(0),
			Err(e) => Err(e),
		}
		.map_err(|e| format!("打开 {} 失败: {}", short_name(&p), e))?;
		let reader = port.try_clone().map_err(|e| e.to_string())?;
		Ok((port, reader))
	})
	.await?;
	if crate::updater::frozen(webview.app_handle()) { return Err("应用正在准备升级".into()); }
	let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
	let stop = Arc::new(AtomicBool::new(false));
	let s = stop.clone();
	let rp = path.clone();
	let th = std::thread::Builder::new()
		.name(format!("serial-read-{}", id))
		.spawn(move || read_loop(rp, reader, s, on_data, on_event))
		.map_err(|e| e.to_string())?;
	let h = Arc::new(Handle {
		path,
		owner: webview.label().to_string(),
		port: Mutex::new(port),
		stop,
		reader: Mutex::new(Some(th)),
	});
	state.handles.lock().unwrap().insert(id, h);
	Ok(id)
}

// 写满为止：每次 write 可能只写进一部分或在短超时上返回，按数据量与波特率留足截止时间(硬件流控卡住时也会在这里超时)
fn write_all_until(port: &mut Box<dyn serialport::SerialPort>, data: &[u8]) -> Result<(), String> {
	let baud = port.baud_rate().unwrap_or(9600).max(1) as u64;
	let budget = 2000 + (data.len() as u64) * 11 * 1000 * 2 / baud;
	let deadline = Instant::now() + Duration::from_millis(budget);
	let mut off = 0;
	while off < data.len() {
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
	let h = state.get(handle)?;
	blocking(move || {
		let mut port = h.port.lock().unwrap();
		write_all_until(&mut port, &data)
	})
	.await
}

#[tauri::command]
pub async fn serial_set_signals(app: tauri::AppHandle, state: State<'_, SerialState>, handle: u32, signals: Signals) -> Result<(), String> {
	let _operation = crate::updater::begin_device_operation(&app)?;
	let h = state.get(handle)?;
	blocking(move || {
		let mut port = h.port.lock().unwrap();
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
	})
	.await
}

// 已经关过(设备丢失后前端补关、重复关)按成功处理：句柄不在就是已释放
#[tauri::command]
pub async fn serial_close(state: State<'_, SerialState>, handle: u32) -> Result<(), String> {
	let h = match state.handles.lock().unwrap().remove(&handle) {
		Some(h) => h,
		None => return Ok(()),
	};
	blocking(move || {
		shutdown(h);
		Ok(())
	})
	.await
}

// 页面加载时调用：收回这个 webview 上一次页面(刷新前)留下的句柄。pagehide 里的关闭是发出即走，刷新时不一定来得及完成
#[tauri::command]
pub async fn serial_release_owned(webview: tauri::Webview, state: State<'_, SerialState>) -> Result<(), String> {
	let owned = state.take_owned(webview.label());
	blocking(move || {
		owned.into_iter().for_each(shutdown);
		Ok(())
	})
	.await
}
