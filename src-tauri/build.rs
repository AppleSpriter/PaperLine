fn main() {
    println!("cargo:rustc-env=PAPERLINE_TARGET={}", std::env::var("TARGET").unwrap());
    tauri_build::build()
}
