# Vi_splitter

Ứng dụng desktop (Tauri v2 + Rust + Node.js) chia nhỏ film theo dung lượng (MiB) bằng FFmpeg, **không encode lại** nên nhanh và giữ nguyên chất lượng.

## Tính năng

- Chọn folder (hoặc kéo thả), tự quét video, có thể quét cả thư mục con.
- Lọc video lớn hơn **ngưỡng chia** (mặc định 400 MiB).
- Chia mỗi video thành các đoạn ≤ **dung lượng mỗi đoạn** (mặc định 200 MiB).
- Chia từng video hoặc **Chia tất cả** theo hàng đợi, có tiến trình và nút Huỷ.
- Kết quả lưu trong `<tên film>_parts/<tên film>_partNN.<ext>`, cạnh film hoặc trong thư mục tuỳ chọn.
- Giao diện sáng/tối theo hệ điều hành.

## Cách chia

1. `ffprobe` đọc vị trí byte của các keyframe.
2. Chọn điểm cắt tại keyframe sao cho mỗi đoạn ước tính ≤ dung lượng yêu cầu (hệ số an toàn 97%).
3. `ffmpeg -f segment -c copy` cắt một lượt tại đúng các điểm đó — không mất hay lặp frame ở chỗ nối.
4. Kiểm tra dung lượng thực tế; đoạn nào vượt thì tự giảm hệ số và chia lại.

## Yêu cầu

- [Rust](https://rustup.rs/) và [Node.js](https://nodejs.org/) 18+
- FFmpeg (`ffmpeg`, `ffprobe`) trong `PATH`, hoặc đặt cạnh file chạy của app
- Linux: các gói phụ thuộc của Tauri (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, …) — xem [hướng dẫn Tauri](https://v2.tauri.app/start/prerequisites/)

## Chạy & build

```bash
npm install
npm run dev     # chạy thử
npm run build   # tạo bộ cài trong src-tauri/target/release/bundle/, đóng gói kèm ffmpeg
```

### Đóng gói kèm FFmpeg

Mọi lệnh `tauri dev` / `tauri build` đều tự chạy `scripts/fetch-ffmpeg.mjs` để chuẩn bị ffmpeg + ffprobe
bản static trong `resources/` rồi nhúng vào bộ cài qua `bundle.externalBin` (cấu hình ở
`src-tauri/tauri.conf.json`). Người dùng cuối không cần cài FFmpeg.

Nếu `resources/` đã có sẵn `ffmpeg.exe` và `ffprobe.exe`, script dùng lại chúng; nếu không thì tải bản LGPL.

- Nguồn: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (Linux, Windows), [evermeet.cx](https://evermeet.cx/ffmpeg/) (macOS).
- File tải về: `resources/vs-ffmpeg-<target-triple>`, `resources/vs-ffprobe-<target-triple>` (không commit lên git).
- Tải sẵn hoặc tải lại: `npm run ffmpeg` / `npm run ffmpeg -- --force`.
- Build cho target khác: `npm run build -- --target x86_64-pc-windows-msvc`.

App tìm ffmpeg theo thứ tự: `vs-ffmpeg` cạnh file chạy → `ffmpeg` cạnh file chạy → `PATH`.

## Test

```bash
cd src-tauri
cargo test
# Chạy thử trên film thật:
FILM=/đường/dẫn/film.mp4 CHUNK=100 cargo test -- --include-ignored --nocapture
```

## Cấu trúc

```
src/                   Giao diện (HTML/CSS/JS thuần)
src-tauri/src/main.rs  Lệnh Tauri: scan_videos, split_video, cancel_split
src-tauri/src/splitter.rs  Quét folder và logic chia video bằng FFmpeg
scripts/fetch-ffmpeg.mjs   Tải ffmpeg/ffprobe để đóng gói
resources/             Nơi chứa ffmpeg/ffprobe đã tải
```
