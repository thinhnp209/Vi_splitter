fn main() {
    // Để bản dev tìm được resources/vs-ffprobe-<target-triple>.exe do scripts/fetch-ffmpeg.mjs tải về.
    println!(
        "cargo:rustc-env=VS_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    tauri_build::build()
}
