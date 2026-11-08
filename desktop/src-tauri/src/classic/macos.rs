use super::Device;
use std::ffi::{c_char, c_void, CStr, CString};
extern "C" {
	fn classic_choose(pair: i32) -> *mut c_char;
	fn classic_open(address: *const c_char, current: extern "C" fn(*mut c_void) -> i32, context: *mut c_void) -> *mut c_void;
	fn classic_read(handle: *mut c_void, out: *mut u8, capacity: u32) -> i32;
	fn classic_write(handle: *mut c_void, bytes: *const u8, length: u32, current: extern "C" fn(*mut c_void) -> i32, context: *mut c_void) -> i32;
	fn classic_close(handle: *mut c_void);
	fn free(p: *mut c_void);
}
pub fn choose(pair: bool) -> Result<Device, String> {
	unsafe {
		let p = classic_choose(i32::from(pair));
		if p.is_null() {
			return Err("Classic 搜索/配对已取消或未成功".into());
		}
		let parsed = serde_json::from_slice(CStr::from_ptr(p).to_bytes()).map_err(|_| "Classic 设备结果无效".into());
		free(p.cast());
		parsed
	}
}
extern "C" fn current(context: *mut c_void) -> i32 {
	i32::from(unsafe { &*(context as *const crate::lease::OwnerOperation) }.is_current())
}
pub struct Connection(*mut c_void);
impl Connection {
	pub fn open(d: &Device, operation: &crate::lease::OwnerOperation) -> Result<Self, String> {
		let address = CString::new(d.address.as_str()).map_err(|_| "设备标识无效")?;
		let p = unsafe { classic_open(address.as_ptr(), current, operation as *const _ as *mut c_void) };
		if p.is_null() {
			Err("Classic RFCOMM 打开失败：确认已配对、允许蓝牙访问且设备提供 SPP".into())
		} else {
			Ok(Self(p))
		}
	}
	pub fn read(&mut self, out: &mut [u8]) -> Result<usize, String> {
		let n = unsafe { classic_read(self.0, out.as_mut_ptr(), out.len() as u32) };
		if n < 0 {
			Err("Classic 连接已丢失或接收队列溢出".into())
		} else {
			Ok(n as usize)
		}
	}
	pub fn write(&mut self, data: &[u8], operation: &crate::lease::OwnerOperation) -> Result<(), String> {
		if unsafe { classic_write(self.0, data.as_ptr(), data.len() as u32, current, operation as *const _ as *mut c_void) } == 0 {
			Ok(())
		} else {
			Err("Classic 写入失败".into())
		}
	}
}
impl Drop for Connection {
	fn drop(&mut self) {
		unsafe { classic_close(self.0) }
	}
}
