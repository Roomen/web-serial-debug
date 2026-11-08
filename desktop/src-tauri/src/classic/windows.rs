use super::Device;
use std::{
	mem::{size_of, zeroed},
	sync::OnceLock,
	time::{Duration, Instant},
};
use windows_sys::Win32::{Devices::Bluetooth::*, Networking::WinSock::*};
// The system owns PIN/passkey confirmation. Never register an auto-accept authentication callback.
pub fn choose(pair: bool) -> Result<Device, String> {
	unsafe {
		let mut p: BLUETOOTH_SELECT_DEVICE_PARAMS = zeroed();
		p.dwSize = size_of::<BLUETOOTH_SELECT_DEVICE_PARAMS>() as u32;
		p.fShowAuthenticated = 1;
		p.fShowRemembered = 1;
		p.fShowUnknown = 1;
		p.fAddNewDeviceWizard = i32::from(pair);
		p.fForceAuthentication = i32::from(pair);
		p.fSkipServicesPage = 1;
		if BluetoothSelectDevices(&mut p) == 0 {
			return Err("Classic 搜索/配对已取消或未成功".into());
		}
		let value = if p.cNumDevices == 1 && !p.pDevices.is_null() {
			let mut d = *p.pDevices;
			if BluetoothGetDeviceInfo(std::ptr::null_mut(), &mut d) != 0 {
				BluetoothSelectDevicesFree(&mut p);
				return Err("无法确认 Classic 配对状态".into());
			}
			let n = d.szName.iter().position(|c| *c == 0).unwrap_or(d.szName.len());
			Ok(Device {
				address: d.Address.Anonymous.ullLong.to_string(),
				name: String::from_utf16_lossy(&d.szName[..n]),
				paired: d.fAuthenticated != 0,
			})
		} else {
			Err("请选择一个 Classic SPP 设备".into())
		};
		BluetoothSelectDevicesFree(&mut p);
		value
	}
}
pub struct Connection(SOCKET);
impl Connection {
	pub fn open(d: &Device, operation: &crate::lease::OwnerOperation) -> Result<Self, String> {
		static STARTED: OnceLock<bool> = OnceLock::new();
		if !*STARTED.get_or_init(|| unsafe {
			let mut w = zeroed();
			WSAStartup(0x202, &mut w) == 0
		}) {
			return Err("Winsock 初始化失败".into());
		}
		if !d.paired {
			return Err("请先通过系统配对窗口完成配对".into());
		}
		unsafe {
			let socket = socket(AF_BTH as i32, SOCK_STREAM, BTHPROTO_RFCOMM as i32);
			if socket == INVALID_SOCKET {
				return Err("Classic RFCOMM 不可用".into());
			}
			let c = Self(socket);
			let mut nonblocking = 1u32;
			if ioctlsocket(socket, FIONBIO, &mut nonblocking) != 0 {
				return Err("无法配置 Classic 通道".into());
			}
			let addr = SOCKADDR_BTH {
				addressFamily: AF_BTH,
				btAddr: d.address.parse().map_err(|_| "设备标识无效")?,
				serviceClassId: windows_sys::core::GUID::from_u128(0x00001101_0000_1000_8000_00805f9b34fb),
				port: 0,
			};
			if connect(socket, &addr as *const _ as *const SOCKADDR, size_of::<SOCKADDR_BTH>() as i32) != 0 {
				if WSAGetLastError() != WSAEWOULDBLOCK {
					return Err("Classic SPP 连接失败".into());
				}
				let deadline = Instant::now() + Duration::from_secs(15);
				loop {
					if !operation.is_current() {
						return Err("Classic 会话已回收".into());
					}
					let mut fds = [WSAPOLLFD {
						fd: socket,
						events: POLLWRNORM,
						revents: 0,
					}];
					let result = WSAPoll(fds.as_mut_ptr(), 1, 20);
					if result < 0 || Instant::now() >= deadline {
						return Err("Classic SPP 连接超时或失败".into());
					}
					if result > 0 {
						let mut error = 0i32;
						let mut len = size_of::<i32>() as i32;
						if getsockopt(socket, SOL_SOCKET, SO_ERROR, &mut error as *mut _ as *mut u8, &mut len) != 0 || error != 0 {
							return Err("Classic SPP 连接失败".into());
						}
						break;
					}
				}
			}
			Ok(c)
		}
	}
	pub fn read(&mut self, out: &mut [u8]) -> Result<usize, String> {
		unsafe {
			let n = recv(self.0, out.as_mut_ptr(), out.len() as i32, 0);
			if n > 0 {
				return Ok(n as usize);
			}
			if n == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK {
				std::thread::sleep(Duration::from_millis(10));
				return Ok(0);
			}
			Err("Classic 连接已丢失".into())
		}
	}
	pub fn write(&mut self, data: &[u8], operation: &crate::lease::OwnerOperation) -> Result<(), String> {
		let deadline = Instant::now() + Duration::from_secs(10);
		let mut offset = 0;
		while offset < data.len() {
			if !operation.is_current() {
				return Err("Classic 会话已回收".into());
			}
			let n = unsafe { send(self.0, data[offset..].as_ptr(), (data.len() - offset) as i32, 0) };
			if n > 0 {
				offset += n as usize;
				continue;
			}
			if unsafe { WSAGetLastError() } != WSAEWOULDBLOCK || Instant::now() >= deadline {
				return Err("Classic 写入失败或超时".into());
			}
			std::thread::sleep(Duration::from_millis(10));
		}
		Ok(())
	}
}
impl Drop for Connection {
	fn drop(&mut self) {
		unsafe {
			shutdown(self.0, SD_BOTH);
			while closesocket(self.0) != 0 {
				if WSAGetLastError() == WSAENOTSOCK {
					break;
				}
				std::thread::sleep(Duration::from_millis(10));
			}
		}
	}
}
