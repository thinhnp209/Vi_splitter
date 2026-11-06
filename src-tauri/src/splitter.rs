//! Chia video theo dung lượng bằng FFmpeg (stream copy, không encode lại).
//!
//! Cách làm:
//! 1. ffprobe đọc vị trí byte của mọi keyframe trong file gốc.
//! 2. Chọn các điểm cắt (luôn tại keyframe) sao cho mỗi đoạn có số byte
//!    ước tính <= dung lượng mong muốn * hệ số an toàn.
//! 3. ffmpeg segment muxer cắt một lượt tại đúng các điểm đó.
//! 4. Kiểm tra dung lượng thực tế; nếu đoạn nào vượt thì giảm hệ số và làm lại.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

pub const MIB: f64 = 1024.0 * 1024.0;
const INITIAL_RATIO: f64 = 0.97;
const MAX_ATTEMPTS: usize = 5;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub duration: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub index: usize,
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub start: f64,
    pub duration: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SplitResult {
    pub split: bool,
    pub message: String,
    pub out_dir: Option<String>,
    pub parts: Vec<Part>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub percent: f64,
    pub message: String,
}

pub struct SplitOptions {
    pub path: String,
    pub threshold_mib: f64,
    pub chunk_mib: f64,
    pub out_dir: Option<String>,
}

/// Điểm cắt: (thời điểm tính từ đầu file, vị trí byte trong file gốc).
type CutPoint = (f64, u64);

// ---------------------------------------------------------------------------
// Gọi ffmpeg / ffprobe
// ---------------------------------------------------------------------------

/// Ưu tiên ffmpeg/ffprobe đặt cạnh file chạy của app, sau đó tới PATH.
fn tool_path(name: &str) -> PathBuf {
    let exe_name = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let candidate = dir.join(&exe_name);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(exe_name)
}

fn command(name: &str) -> Command {
    let mut cmd = Command::new(tool_path(name));
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn spawn_error(name: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("Không tìm thấy {name}. Hãy cài FFmpeg và thêm vào PATH (hoặc đặt {name} cạnh file chạy của app).")
    } else {
        format!("Không chạy được {name}: {e}")
    }
}

fn run(cmd: &mut Command, name: &str) -> Result<String, String> {
    let out = cmd.output().map_err(|e| spawn_error(name, e))?;
    if !out.status.success() {
        return Err(format!("{name} lỗi: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Trả về (duration, start_time) của file.
fn probe_format(path: &Path) -> Result<(f64, f64), String> {
    let out = run(
        command("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration,start_time"])
            .args(["-of", "default=noprint_wrappers=1"])
            .arg(path),
        "ffprobe",
    )?;
    let mut duration = None;
    let mut start = 0.0;
    for line in out.lines() {
        match line.split_once('=') {
            Some(("duration", v)) => duration = v.trim().parse::<f64>().ok(),
            Some(("start_time", v)) => start = v.trim().parse::<f64>().unwrap_or(0.0),
            _ => {}
        }
    }
    let duration = duration.ok_or("Không đọc được thời lượng video (file hỏng hoặc không phải video?)")?;
    Ok((duration, start))
}

/// Danh sách keyframe (thời điểm tương đối, vị trí byte) của stream đầu tiên được chọn.
fn keyframes(path: &Path, selector: &str, start_time: f64) -> Result<Vec<CutPoint>, String> {
    let out = run(
        command("ffprobe")
            .args(["-v", "error", "-select_streams", selector])
            .args(["-show_entries", "packet=pts_time,pos,flags", "-of", "compact=p=0"])
            .arg(path),
        "ffprobe",
    )?;
    let mut points = Vec::new();
    for line in out.lines() {
        let (mut t, mut pos, mut key) = (None, None, false);
        for field in line.split('|') {
            match field.split_once('=') {
                Some(("pts_time", v)) => t = v.parse::<f64>().ok(),
                Some(("pos", v)) => pos = v.parse::<u64>().ok(),
                Some(("flags", v)) => key = v.starts_with('K'),
                _ => {}
            }
        }
        if let (true, Some(t), Some(pos)) = (key, t, pos) {
            points.push((t - start_time, pos));
        }
    }
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    points.dedup_by(|b, a| (b.0 - a.0).abs() < 1e-3);
    Ok(points)
}

// ---------------------------------------------------------------------------
// API công khai
// ---------------------------------------------------------------------------

pub fn probe(path: &str) -> Result<VideoInfo, String> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| format!("Không đọc được file: {e}"))?;
    if !meta.is_file() {
        return Err("Đường dẫn không phải là file".into());
    }
    let (duration, _) = probe_format(p)?;
    Ok(VideoInfo {
        path: path.to_string(),
        file_name: p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        size_bytes: meta.len(),
        duration,
    })
}

pub const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "m4v", "webm", "ts", "m2ts", "flv", "wmv", "mpg", "mpeg",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoEntry {
    pub path: String,
    pub file_name: String,
    /// Thư mục chứa file, tính tương đối so với đường dẫn được quét.
    pub folder: String,
    pub size_bytes: u64,
}

fn is_video(path: &Path) -> bool {
    path.extension()
        .map(|e| VIDEO_EXTS.contains(&e.to_string_lossy().to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// File do chính app tạo ra (`<tên>_partNN.<ext>`) thì không quét lại.
fn is_part_file(path: &Path) -> bool {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match stem.rsplit_once("_part") {
        Some((_, n)) => !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// Quét các file/folder được chọn và trả về mọi video tìm thấy, sắp xếp theo đường dẫn.
pub fn scan(paths: &[String], recursive: bool) -> Vec<VideoEntry> {
    fn push(out: &mut Vec<VideoEntry>, root: &Path, file: &Path) {
        if !is_video(file) || is_part_file(file) {
            return;
        }
        let Ok(meta) = std::fs::metadata(file) else { return };
        let folder = file
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push(VideoEntry {
            path: file.to_string_lossy().into_owned(),
            file_name: file.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            folder,
            size_bytes: meta.len(),
        });
    }

    fn walk(out: &mut Vec<VideoEntry>, root: &Path, dir: &Path, recursive: bool, depth: usize) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                // Bỏ qua thư mục kết quả do app tạo ra.
                if recursive && depth < 32 && !name.ends_with("_parts") {
                    walk(out, root, &path, recursive, depth + 1);
                }
            } else {
                push(out, root, &path);
            }
        }
    }

    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            walk(&mut out, path, path, recursive, 0);
        } else if path.is_file() {
            push(&mut out, path.parent().unwrap_or(Path::new("")), path);
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// Chọn các chỉ số điểm cắt sao cho mỗi đoạn ước tính <= budget byte.
fn plan(points: &[CutPoint], budget: u64) -> Vec<usize> {
    let last = points.len() - 1;
    let mut cuts = vec![0];
    let mut s = 0;
    while s < last {
        let limit = points[s].1.saturating_add(budget);
        let mut e = s + 1; // ít nhất 1 GOP, kể cả khi GOP lớn hơn budget
        while e < last && points[e + 1].1 <= limit {
            e += 1;
        }
        cuts.push(e);
        s = e;
    }
    cuts
}

pub fn split(
    opts: &SplitOptions,
    cancel: &AtomicBool,
    emit: impl Fn(Progress),
) -> Result<SplitResult, String> {
    if !(opts.threshold_mib > 0.0) || !(opts.chunk_mib >= 1.0) {
        return Err("Ngưỡng phải > 0 và dung lượng mỗi đoạn phải >= 1 MiB".into());
    }
    let input = Path::new(&opts.path);
    let info = probe(&opts.path)?;
    let size_mib = info.size_bytes as f64 / MIB;
    let threshold = (opts.threshold_mib * MIB) as u64;
    let chunk = (opts.chunk_mib * MIB) as u64;

    if info.size_bytes <= threshold {
        return Ok(SplitResult {
            split: false,
            message: format!(
                "File {:.1} MiB ≤ ngưỡng {} MiB nên không cần chia.",
                size_mib, opts.threshold_mib
            ),
            out_dir: None,
            parts: vec![],
        });
    }

    emit(Progress { percent: 0.0, message: "Đang phân tích keyframe…".into() });
    let (duration, start_time) = probe_format(input)?;
    let mut points = keyframes(input, "v:0", start_time)?;
    if points.is_empty() {
        // File chỉ có audio: mọi packet audio đều là điểm cắt hợp lệ.
        points = keyframes(input, "a:0", start_time)?;
    }
    if points.is_empty() {
        return Err("Không tìm thấy keyframe nào để cắt".into());
    }
    // Đoạn đầu luôn bắt đầu từ 0 và chứa cả header; thêm điểm kết thúc ảo.
    if points[0].0 > 0.01 {
        points.insert(0, (0.0, 0));
    } else {
        points[0] = (0.0, 0);
    }
    points.push((duration, info.size_bytes));

    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or("video".into());
    let ext = input.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or("mp4".into());
    // Mỗi film một thư mục `<tên>_parts`, đặt cạnh film hoặc trong thư mục đích đã chọn.
    let base = match &opts.out_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => input.parent().unwrap_or(Path::new(".")).to_path_buf(),
    };
    let out_dir = base.join(format!("{stem}_parts"));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Không tạo được thư mục đích: {e}"))?;

    let mut ratio = INITIAL_RATIO;
    for attempt in 1..=MAX_ATTEMPTS {
        let cuts = plan(&points, (chunk as f64 * ratio) as u64);
        let n = cuts.len() - 1;
        emit(Progress {
            percent: 0.0,
            message: if attempt == 1 {
                format!("Bắt đầu chia thành {n} đoạn…")
            } else {
                format!("Có đoạn vượt dung lượng, chia lại thành {n} đoạn (lần {attempt})…")
            },
        });

        let pattern = out_dir.join(format!("{stem}_part%02d.{ext}"));
        let times: Vec<f64> = cuts[1..n].iter().map(|&i| points[i].0).collect();
        clean_parts(&out_dir, &stem, &ext);
        run_segment(input, &pattern, &ext, &times, duration, n, cancel, &emit)?;

        let mut parts = Vec::with_capacity(n);
        for k in 0..n {
            let file_name = format!("{stem}_part{:02}.{ext}", k + 1);
            let path = out_dir.join(&file_name);
            let size_bytes = std::fs::metadata(&path)
                .map_err(|_| format!("Thiếu file đầu ra {file_name}"))?
                .len();
            let (t0, t1) = (points[cuts[k]].0, points[cuts[k + 1]].0);
            parts.push(Part {
                index: k + 1,
                path: path.to_string_lossy().into_owned(),
                file_name,
                size_bytes,
                start: t0,
                duration: t1 - t0,
            });
        }

        // Chỉ tính các đoạn có thể nhỏ hơn được (nhiều hơn 1 GOP).
        let worst = parts
            .iter()
            .zip(cuts.windows(2))
            .filter(|(p, w)| p.size_bytes > chunk && w[1] - w[0] > 1)
            .map(|(p, _)| p.size_bytes)
            .max();

        match worst {
            Some(size) if attempt < MAX_ATTEMPTS => {
                ratio *= chunk as f64 / size as f64 * 0.98;
            }
            _ => {
                let over = parts.iter().filter(|p| p.size_bytes > chunk).count();
                let mut message = format!(
                    "Đã chia {:.1} MiB thành {} đoạn (mỗi đoạn ≤ {} MiB).",
                    size_mib,
                    parts.len(),
                    opts.chunk_mib
                );
                if over > 0 {
                    message.push_str(&format!(
                        " Lưu ý: {over} đoạn vẫn vượt vì khoảng cách keyframe quá lớn so với dung lượng yêu cầu."
                    ));
                }
                emit(Progress { percent: 100.0, message: "Hoàn tất".into() });
                return Ok(SplitResult {
                    split: true,
                    message,
                    out_dir: Some(out_dir.to_string_lossy().into_owned()),
                    parts,
                });
            }
        }
    }
    unreachable!()
}

/// Xoá các part cũ cùng tên để không lẫn với kết quả mới.
fn clean_parts(dir: &Path, stem: &str, ext: &str) {
    let prefix = format!("{stem}_part");
    let suffix = format!(".{ext}");
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(mid) = name.strip_prefix(&prefix).and_then(|r| r.strip_suffix(&suffix)) {
                if !mid.is_empty() && mid.chars().all(|c| c.is_ascii_digit()) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_segment(
    input: &Path,
    pattern: &Path,
    ext: &str,
    times: &[f64],
    duration: f64,
    n: usize,
    cancel: &AtomicBool,
    emit: &impl Fn(Progress),
) -> Result<(), String> {
    let mut cmd = command("ffmpeg");
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"])
        .arg(input)
        .args(["-map", "0", "-dn", "-ignore_unknown", "-c", "copy"])
        .args(["-f", "segment", "-reset_timestamps", "1", "-avoid_negative_ts", "1"])
        .args(["-segment_start_number", "1"]);
    if !times.is_empty() {
        // Lùi 1ms để chắc chắn cắt đúng keyframe đã chọn, không trượt sang keyframe sau.
        let list: Vec<String> = times.iter().map(|t| format!("{:.6}", (t - 0.001).max(0.0))).collect();
        cmd.arg("-segment_times").arg(list.join(","));
    } else {
        cmd.args(["-segment_time", "1000000000"]);
    }
    if matches!(ext.to_ascii_lowercase().as_str(), "mp4" | "m4v" | "mov") {
        cmd.args(["-segment_format_options", "movflags=+faststart"]);
    }
    cmd.args(["-progress", "pipe:1", "-nostats"])
        .arg(pattern)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| spawn_error("ffmpeg", e))?;
    let mut stderr = child.stderr.take().unwrap();
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let stdout = BufReader::new(child.stdout.take().unwrap());
    for line in stdout.lines().map_while(Result::ok) {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Đã huỷ".into());
        }
        if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = v.trim().parse::<f64>() {
                let secs = us / 1_000_000.0;
                let percent = (secs / duration * 100.0).clamp(0.0, 99.9);
                let current = times.iter().filter(|&&t| t <= secs).count() + 1;
                emit(Progress {
                    percent,
                    message: format!("Đang ghi đoạn {}/{}…", current.min(n), n),
                });
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let err = err_reader.join().unwrap_or_default();
    if cancel.load(Ordering::SeqCst) {
        return Err("Đã huỷ".into());
    }
    if !status.success() {
        return Err(format!("ffmpeg lỗi: {}", err.trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Chạy: FILM=/đường/dẫn/film.mp4 CHUNK=100 cargo test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn split_real_file() {
        let path = std::env::var("FILM").expect("đặt biến FILM");
        let chunk: f64 = std::env::var("CHUNK").ok().and_then(|v| v.parse().ok()).unwrap_or(200.0);
        let out = std::env::temp_dir().join("video_splitter_test");
        let opts = SplitOptions {
            path,
            threshold_mib: 1.0,
            chunk_mib: chunk,
            out_dir: Some(out.to_string_lossy().into_owned()),
        };
        let res = split(&opts, &AtomicBool::new(false), |p| eprintln!("{:5.1}% {}", p.percent, p.message)).unwrap();
        println!("{}", res.message);
        for p in &res.parts {
            println!("{} {:.2} MiB start={:.3} dur={:.3}", p.file_name, p.size_bytes as f64 / MIB, p.start, p.duration);
            assert!(p.size_bytes as f64 <= chunk * MIB);
        }
    }

    #[test]
    fn plan_respects_budget() {
        let points: Vec<CutPoint> = (0..=100).map(|i| (i as f64, i as u64 * 10)).collect();
        let cuts = plan(&points, 250);
        assert_eq!(cuts, vec![0, 25, 50, 75, 100]);
        // GOP lớn hơn budget vẫn tiến ít nhất 1 điểm
        assert_eq!(plan(&points, 5), (0..=100).collect::<Vec<_>>());
    }
}

#[cfg(test)]
mod scan_tests {
    use super::*;

    #[test]
    fn scan_finds_videos_and_skips_outputs() {
        let root = std::env::temp_dir().join(format!("video_splitter_scan_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for f in ["a.mp4", "b.MKV", "note.txt", "sub/c.mov", "sub/deep/d.mp4", "a_parts/a_part01.mp4", "x_part02.mp4", ".hidden/e.mp4"] {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"x").unwrap();
        }
        let names = |v: Vec<VideoEntry>| v.into_iter().map(|e| e.file_name).collect::<Vec<_>>();
        let root_s = root.to_string_lossy().into_owned();

        assert_eq!(names(scan(&[root_s.clone()], true)), ["a.mp4", "b.MKV", "c.mov", "d.mp4"]);
        assert_eq!(names(scan(&[root_s.clone()], false)), ["a.mp4", "b.MKV"]);
        let deep = scan(&[root_s], true).into_iter().find(|e| e.file_name == "d.mp4").unwrap();
        assert_eq!(Path::new(&deep.folder), Path::new("sub/deep"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
