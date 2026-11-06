#!/usr/bin/env node
// Tải ffmpeg + ffprobe bản static vào resources/ để Tauri đóng gói kèm app (bundle.externalBin).
//
//   node scripts/fetch-ffmpeg.mjs                 # cho máy hiện tại
//   node scripts/fetch-ffmpeg.mjs --target x86_64-pc-windows-msvc
//   node scripts/fetch-ffmpeg.mjs --force         # tải lại dù đã có
//
// File tạo ra: resources/vs-ffmpeg-<target-triple>[.exe], resources/vs-ffprobe-<target-triple>[.exe]
// (Tauri yêu cầu hậu tố target triple; khi cài đặt sẽ thành vs-ffmpeg / vs-ffprobe cạnh file chạy.)

import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "resources");
const TOOLS = ["ffmpeg", "ffprobe"];

// Bản LGPL static (đủ cho stream copy). Linux/Windows: BtbN, macOS: evermeet.cx.
const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
const MAC = [
  "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip",
  "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
];
const SOURCES = {
  "x86_64-unknown-linux-gnu": [`${BTBN}/ffmpeg-master-latest-linux64-lgpl.tar.xz`],
  "aarch64-unknown-linux-gnu": [`${BTBN}/ffmpeg-master-latest-linuxarm64-lgpl.tar.xz`],
  "x86_64-pc-windows-msvc": [`${BTBN}/ffmpeg-master-latest-win64-lgpl.zip`],
  "aarch64-pc-windows-msvc": [`${BTBN}/ffmpeg-master-latest-winarm64-lgpl.zip`],
  "x86_64-apple-darwin": MAC,
  "aarch64-apple-darwin": MAC, // bản x86_64, chạy qua Rosetta
};

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (!line) throw new Error("Không đọc được target triple từ `rustc -vV`");
  return line.slice(5).trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--target");
  return {
    force: args.includes("--force"),
    // Khi chạy qua `tauri build --target ...`, Tauri truyền target qua biến môi trường này.
    target: (i >= 0 && args[i + 1]) || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple(),
  };
}

const mib = (n) => (n / 1024 / 1024).toFixed(1);

async function download(url, file) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} khi tải ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    got += chunk.length;
    if (process.stdout.isTTY && Date.now() - last > 250) {
      last = Date.now();
      const pct = total ? ` (${((got / total) * 100).toFixed(0)}%)` : "";
      process.stdout.write(`\r  ${mib(got)}${total ? "/" + mib(total) : ""} MiB${pct}   `);
    }
  });
  await pipeline(body, createWriteStream(file));
  if (process.stdout.isTTY) process.stdout.write("\r");
  console.log(`  đã tải ${mib(got)} MiB`);
}

function extract(archive, dir) {
  mkdirSync(dir, { recursive: true });
  // GNU tar không mở được zip; bsdtar (macOS, Windows 10+) thì được.
  if (archive.endsWith(".zip") && process.platform === "linux") {
    execFileSync("unzip", ["-q", "-o", archive, "-d", dir], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", archive, "-C", dir], { stdio: "inherit" });
  }
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

async function main() {
  const { force, target } = parseArgs();
  const ext = target.includes("windows") ? ".exe" : "";
  const dest = (tool) => join(OUT_DIR, `vs-${tool}-${target}${ext}`);

  if (!force && TOOLS.every((t) => existsSync(dest(t)))) {
    console.log(`[ffmpeg] Đã có ffmpeg/ffprobe cho ${target}, bỏ qua (dùng --force để tải lại).`);
    return;
  }
  const urls = SOURCES[target];
  if (!urls) {
    throw new Error(
      `Chưa hỗ trợ tải tự động cho ${target}. Hãy tự đặt ffmpeg/ffprobe vào:\n  ${dest("ffmpeg")}\n  ${dest("ffprobe")}`,
    );
  }

  console.log(`[ffmpeg] Tải ffmpeg/ffprobe cho ${target}…`);
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "vs-ffmpeg-"));
  try {
    for (const [i, url] of urls.entries()) {
      const archive = join(tmp, `dl-${i}${url.endsWith(".tar.xz") ? ".tar.xz" : ".zip"}`);
      console.log(`- ${url}`);
      await download(url, archive);
      extract(archive, join(tmp, `x-${i}`));
    }
    for (const tool of TOOLS) {
      const src = findFile(tmp, tool + ext);
      if (!src) throw new Error(`Không thấy ${tool}${ext} trong gói đã tải`);
      copyFileSync(src, dest(tool));
      chmodSync(dest(tool), 0o755);
      console.log(`[ffmpeg] → ${dest(tool)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[ffmpeg] Lỗi: ${e.message}`);
  process.exit(1);
});
