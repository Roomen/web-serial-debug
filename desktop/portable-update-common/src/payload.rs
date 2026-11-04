// 便携更新载荷(便携 ZIP)的读取：用 zip crate 解析，只按名字白名单取根目录下的固定文件。
// 不自己维护压缩格式解析器；这里只加「条目名必须是普通文件名」「大小/条目数上限」两道闸，
// 避免借载荷里的路径或超大条目影响安装目录。
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use zip::ZipArchive;

pub struct Limits {
	pub max_entries: usize,
	pub max_entry_bytes: u64,
	pub max_total_bytes: u64,
}

pub const LIMITS: Limits = Limits { max_entries: 16, max_entry_bytes: 192 * 1024 * 1024, max_total_bytes: 256 * 1024 * 1024 };

fn open(data: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, String> {
	ZipArchive::new(Cursor::new(data)).map_err(|_| "更新包不是有效的 ZIP 文件".to_string())
}

// 根目录下的普通文件名：不含分隔符、不以点开头，避免借路径跳出安装目录
fn plain_name(name: &str) -> bool {
	!name.is_empty()
		&& name.len() <= 128
		&& !name.contains(['/', '\\', ':', '$'])
		&& !name.starts_with('.')
		&& name.bytes().all(|b| b >= 0x20 && b != 0x7f)
}

/// 只解压白名单里的条目，返回「文件名 → 内容」。目录条目与其它文件一律忽略，
/// 但白名单条目缺失、条目重复或解压结果与目录登记的大小不符都算失败。
pub fn extract(data: &[u8], wanted: &[&str], limits: &Limits) -> Result<BTreeMap<String, Vec<u8>>, String> {
	let mut archive = open(data)?;
	if archive.len() > limits.max_entries {
		return Err("更新包里的文件过多".into());
	}
	let mut found = BTreeMap::new();
	let mut total = 0u64;
	for index in 0..archive.len() {
		let mut file = archive.by_index(index).map_err(|_| "更新包内容损坏".to_string())?;
		let name = file.name().to_string();
		if !plain_name(&name) || !wanted.contains(&name.as_str()) || file.is_dir() {
			continue;
		}
		if file.enclosed_name().is_none() {
			return Err("更新包里的文件路径不安全".into());
		}
		if found.contains_key(&name) {
			return Err("更新包里有重复的文件".into());
		}
		if file.size() > limits.max_entry_bytes {
			return Err("更新包里的文件过大".into());
		}
		total = total.saturating_add(file.size());
		if total > limits.max_total_bytes {
			return Err("更新包解压后过大".into());
		}
		let declared = file.size();
		let mut content = Vec::with_capacity(declared as usize);
		// 多读一个字节，解压结果比目录登记的大也能发现
		file.by_ref()
			.take(declared.saturating_add(1))
			.read_to_end(&mut content)
			.map_err(|_| "更新包解压失败".to_string())?;
		if content.len() as u64 != declared {
			return Err("更新包解压后大小不一致".into());
		}
		found.insert(name, content);
	}
	for name in wanted {
		if !found.contains_key(*name) {
			return Err(format!("更新包里缺少 {name}"));
		}
	}
	Ok(found)
}

/// 只做结构预检(应用端在启动 helper 前用)：是不是 ZIP、有没有主程序条目
pub fn contains_entry(data: &[u8], name: &str) -> bool {
	open(data).is_ok_and(|mut archive| archive.by_name(name).is_ok())
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;
	use zip::write::SimpleFileOptions;

	fn build(entries: &[(&str, &[u8])]) -> Vec<u8> {
		let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
		let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
		for (name, content) in entries {
			writer.start_file(*name, options).unwrap();
			writer.write_all(content).unwrap();
		}
		writer.finish().unwrap().into_inner()
	}

	#[test]
	fn extracts_whitelisted_entries_and_ignores_others() {
		let zip = build(&[("Serial Debug.exe", b"exe-bytes"), ("README.txt", b"readme"), ("other.txt", b"ignored")]);
		let out = extract(&zip, &["Serial Debug.exe", "README.txt"], &LIMITS).unwrap();
		assert_eq!(out.len(), 2);
		assert_eq!(out["Serial Debug.exe"], b"exe-bytes");
		assert_eq!(out["README.txt"], b"readme");
		assert!(contains_entry(&zip, "Serial Debug.exe"));
		assert!(!contains_entry(&zip, "nope.exe"));
	}

	#[test]
	fn stored_entries_are_supported() {
		let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
		writer.start_file("Serial Debug.exe", SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
		writer.write_all(b"exe").unwrap();
		let zip = writer.finish().unwrap().into_inner();
		assert_eq!(extract(&zip, &["Serial Debug.exe"], &LIMITS).unwrap()["Serial Debug.exe"], b"exe");
	}

	#[test]
	fn missing_wanted_entry_is_an_error() {
		let zip = build(&[("Serial Debug.exe", b"exe")]);
		assert!(extract(&zip, &["Serial Debug.exe", "README.txt"], &LIMITS).is_err());
	}

	#[test]
	fn path_like_entry_names_never_match() {
		let zip = build(&[("..\\evil.exe", b"x"), ("sub/Serial Debug.exe", b"y")]);
		assert!(extract(&zip, &["..\\evil.exe"], &LIMITS).is_err());
		assert!(extract(&zip, &["sub/Serial Debug.exe"], &LIMITS).is_err());
	}

	#[test]
	fn whitelisted_directory_entries_are_not_treated_as_files() {
		let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
		writer.add_directory("Serial Debug.exe/", SimpleFileOptions::default()).unwrap();
		let zip = writer.finish().unwrap().into_inner();
		assert!(extract(&zip, &["Serial Debug.exe"], &LIMITS).is_err());
	}

	#[test]
	fn names_are_matched_exactly_not_case_insensitively() {
		// Windows 文件系统不分大小写，所以白名单按字节精确比对：名字写法一变就当缺文件处理
		let zip = build(&[("serial debug.exe", b"exe")]);
		assert!(extract(&zip, &["Serial Debug.exe"], &LIMITS).is_err());
	}

	#[test]
	fn non_zip_data_is_rejected() {
		assert!(extract(b"not a zip at all", &["Serial Debug.exe"], &LIMITS).is_err());
	}

	#[test]
	fn entry_and_count_limits_are_enforced() {
		let zip = build(&[("Serial Debug.exe", b"0123456789")]);
		let small = Limits { max_entries: 16, max_entry_bytes: 4, max_total_bytes: 1024 };
		assert!(extract(&zip, &["Serial Debug.exe"], &small).is_err());
		let zero = Limits { max_entries: 0, max_entry_bytes: 1024, max_total_bytes: 1024 };
		assert!(extract(&zip, &["Serial Debug.exe"], &zero).is_err());
	}
}
