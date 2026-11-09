fn main() {
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
		cc::Build::new()
			.file("src/classic/macos.m")
			.flag("-fobjc-arc")
			.flag("-mmacosx-version-min=11.0")
			.compile("classic_native");
		println!("cargo:rustc-link-lib=framework=IOBluetooth");
		println!("cargo:rustc-link-lib=framework=IOBluetoothUI");
		println!("cargo:rerun-if-changed=src/classic/macos.m");
	}
	tauri_build::build()
}
