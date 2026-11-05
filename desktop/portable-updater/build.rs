// 把更新公钥编译进 helper：helper 在主程序退出后独立复核签名，不依赖应用进程内存里的结果。
// 公钥是公开信息(发布清单里本来就带)，但只在配置了签名时才内嵌；没配时内嵌空串，
// helper 会拒绝任何更新(失败关闭)，本地无签名构建仍然能打出可手动使用的便携 ZIP。
fn main() {
	let pubkey = std::env::var("TAURI_UPDATER_PUBLIC_KEY").unwrap_or_default();
	let pubkey = pubkey.trim();
	println!("cargo:rerun-if-env-changed=TAURI_UPDATER_PUBLIC_KEY");
	println!("cargo:rustc-env=SERIAL_UPDATER_PUBKEY={pubkey}");
}
