const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog;
const { revealItemInDir } = window.__TAURI__.opener;
const { getCurrentWebview } = window.__TAURI__.webview;

const MIB = 1024 * 1024;
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "m4v", "webm", "ts", "m2ts", "flv", "wmv", "mpg", "mpeg"];

const $ = (id) => document.getElementById(id);
const el = {
  nav: $("nav"),
  navCount: $("nav-count"),
  crumb: $("crumb"),
  viewVideos: $("view-videos"),
  viewSettings: $("view-settings"),
  cfgThreshold: $("cfg-threshold"),
  cfgChunk: $("cfg-chunk"),
  cfgOut: $("cfg-out"),
  cfgEdit: $("cfg-edit"),
  pickFolder: $("pick-folder"),
  pickFiles: $("pick-files"),
  rescan: $("rescan"),
  recursive: $("recursive"),
  sourceText: $("source-text"),
  sourceFull: $("source-full"),
  threshold: $("threshold"),
  chunk: $("chunk"),
  presets: $("chunk-presets"),
  inputError: $("input-error"),
  previewText: $("preview-text"),
  outBeside: $("out-beside"),
  outCustom: $("out-custom"),
  outBesideCard: $("out-beside-card"),
  outCustomCard: $("out-custom-card"),
  outdirText: $("outdir-text"),
  pickOut: $("pick-out"),
  filter: $("filter"),
  ctAll: $("ct-all"),
  ctOver: $("ct-over"),
  ctError: $("ct-error"),
  summary: $("summary"),
  splitAll: $("split-all"),
  cancel: $("cancel"),
  selectAll: $("select-all"),
  selBar: $("sel-bar"),
  selCount: $("sel-count"),
  selSplit: $("sel-split"),
  selClear: $("sel-clear"),
  queue: $("queue"),
  queueText: $("queue-text"),
  queuePct: $("queue-pct"),
  queueFill: $("queue-fill"),
  rows: $("rows"),
  empty: $("empty"),
  emptyTitle: $("empty-title"),
  emptySub: $("empty-sub"),
  footText: $("foot-text"),
  overlay: $("drop-overlay"),
  toast: $("toast"),
};

/**
 * Mỗi video: { path, fileName, folder, sizeBytes,
 *   status: "idle" | "queued" | "running" | "done" | "skipped" | "error" | "cancelled",
 *   percent, message, result, error, expanded, selected }
 */
let videos = [];
let sources = [];
let queue = []; // đường dẫn các video đang chờ chia
let current = null; // video đang chia
let scanning = false;
let filter = "over"; // "over" | "all" | "error"
let view = "videos"; // "videos" | "settings"
let outDir = "";
// Tiến độ của cả đợt (từ lúc hàng đợi bắt đầu đến khi rỗng).
let batch = { total: 0, done: 0 };

// ---- Lưu cấu hình giữa các lần mở app ----
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("settings") || "{}");
    if (s.threshold > 0) el.threshold.value = s.threshold;
    if (s.chunk > 0) el.chunk.value = s.chunk;
    if (typeof s.recursive === "boolean") el.recursive.checked = s.recursive;
    if (["all", "over", "error"].includes(s.filter)) filter = s.filter;
    if (s.view === "settings") view = "settings";
    if (typeof s.outDir === "string") outDir = s.outDir;
  } catch {}
}
function saveSettings() {
  try {
    localStorage.setItem("settings", JSON.stringify({
      threshold: Number(el.threshold.value),
      chunk: Number(el.chunk.value),
      recursive: el.recursive.checked,
      filter,
      view,
      outDir,
    }));
  } catch {}
}

// ---- Tiện ích ----
function fmtSize(bytes) {
  const mib = bytes / MIB;
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}
function icon(name, cls = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${cls}`.trim());
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 4500);
}

function readInputs() {
  const threshold = Number(el.threshold.value);
  const chunk = Number(el.chunk.value);
  if (!(threshold > 0)) return { error: "Ngưỡng chia phải lớn hơn 0" };
  if (!(chunk >= 1)) return { error: "Dung lượng mỗi đoạn phải ≥ 1 MiB" };
  return { threshold, chunk };
}

const isBusy = () => current !== null || queue.length > 0;
const isOver = (v, threshold) => v.sizeBytes > threshold * MIB;
/** Video có thể đưa vào hàng đợi: lớn hơn ngưỡng và chưa chia / chia lỗi. */
const canSplit = (v, threshold) =>
  isOver(v, threshold) && ["idle", "error", "cancelled"].includes(v.status);
const hasOversizedPart = (v) => v.result.parts.some((p) => p.sizeBytes > v.result.chunk * MIB);

// ---- Hiển thị ----
function badge(text, cls = "") {
  return h("span", { class: `badge ${cls}` }, text);
}

function statusCell(v, threshold) {
  const td = h("td", { class: "status-cell" });
  switch (v.status) {
    case "queued":
      td.append(badge("Đang chờ", "amber"));
      break;
    case "running": {
      const pct = v.percent || 0;
      td.append(
        badge("Đang chia", "blue pulse"),
        h("span", { class: "status-sub run-text" }, v.message || "Đang chuẩn bị…"),
        h("div", { class: "row-progress" },
          h("div", { class: "progress" }, h("div", { class: "run-fill", style: `width:${pct}%` })),
          h("span", { class: "run-pct" }, `${pct.toFixed(0)}%`),
        ),
      );
      break;
    }
    case "done":
      td.append(badge(`Hoàn tất · ${v.result.parts.length} đoạn`, "green"));
      if (hasOversizedPart(v)) {
        td.append(h("span", { class: "status-sub" }, "Có đoạn vượt dung lượng do keyframe thưa"));
      }
      break;
    case "skipped":
      td.append(badge("Không cần chia", "muted"));
      break;
    case "error":
      td.append(badge("Lỗi", "red"), h("span", { class: "status-sub err", title: v.error }, v.error));
      break;
    case "cancelled":
      td.append(badge("Đã huỷ", "muted"));
      break;
    default:
      td.append(isOver(v, threshold) ? badge("Chưa chia") : badge("Dưới ngưỡng", "muted"));
  }
  return td;
}

function actionCell(v, threshold, error) {
  const td = h("td", { class: "actions" });
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };
  if (v.status === "queued") {
    td.append(h("button", { class: "btn btn-ghost btn-sm", onclick: stop(() => unqueue(v)) }, icon("x"), "Bỏ"));
  } else if (v.status === "done") {
    td.append(
      h("button", { class: "btn btn-outline btn-sm", onclick: stop(() => reveal(v)) }, icon("folder-open"), "Mở"),
      " ",
      h("button", { class: "btn btn-ghost btn-icon", title: "Xem các đoạn", onclick: stop(() => toggle(v)) }, icon("chevron", "chev")),
    );
  } else if (v.status !== "running" && isOver(v, threshold)) {
    const retry = v.status === "error" || v.status === "cancelled";
    td.append(h("button", {
      class: `btn ${retry ? "btn-outline" : "btn-primary"} btn-sm`,
      disabled: !!error || !canSplit(v, threshold),
      onclick: stop(() => enqueue([v])),
    }, icon(retry ? "refresh" : "scissors"), retry ? "Thử lại" : "Chia"));
  }
  return td;
}

function partsCell(v, over, chunk, error) {
  if (v.status === "done") return h("td", { class: "num" }, h("b", {}, String(v.result.parts.length)));
  if (!over || error) return h("td", { class: "num parts-est" }, "—");
  return h("td", { class: "num parts-est" }, "~", h("b", {}, String(Math.ceil(v.sizeBytes / (chunk * MIB)))));
}

function detailRow(v) {
  const total = v.result.parts.reduce((n, p) => n + p.sizeBytes, 0);
  const list = h("div", { class: "parts-list" });
  for (const p of v.result.parts) {
    list.append(h("div", { class: `part ${p.sizeBytes > v.result.chunk * MIB ? "over" : ""}`, title: p.fileName },
      h("span", { class: "idx" }, String(p.index).padStart(2, "0")),
      h("div", { class: "pbody" },
        h("span", { class: "pname" }, p.fileName),
        h("span", { class: "ptime" }, `${fmtTime(p.start)} → ${fmtTime(p.start + p.duration)}`),
      ),
      h("span", { class: "psize" }, fmtSize(p.sizeBytes)),
    ));
  }
  return h("tr", { class: "detail" }, h("td", { colSpan: 6 },
    h("div", { class: "parts-head" },
      h("span", { class: "mono" }, v.result.outDir || ""),
      h("span", {}, `${v.result.parts.length} tệp · ${fmtSize(total)}`),
    ),
    list,
  ));
}

function toggle(v) {
  v.expanded = !v.expanded;
  render();
}

function render() {
  const { threshold, chunk, error } = readInputs();
  el.inputError.textContent = error || "";
  const t = error ? Infinity : threshold;
  const busy = isBusy();

  // Thống kê
  const over = videos.filter((v) => isOver(v, t));
  const pending = videos.filter((v) => canSplit(v, t));
  const done = videos.filter((v) => v.status === "done");
  const errors = videos.filter((v) => v.status === "error");
  const estParts = error ? 0 : pending.reduce((n, v) => n + Math.ceil(v.sizeBytes / (chunk * MIB)), 0);
  const totalBytes = videos.reduce((n, v) => n + v.sizeBytes, 0);

  el.navCount.textContent = videos.length;
  el.ctAll.textContent = videos.length;
  el.ctOver.textContent = over.length;
  el.ctError.textContent = errors.length;

  const parts = [];
  if (videos.length) {
    parts.push(`${videos.length} video · ${fmtSize(totalBytes)}`);
    if (over.length) parts.push(`<strong>${pending.length}</strong> cần chia${estParts ? ` → <strong>${estParts}</strong> đoạn` : ""}`);
    if (done.length) parts.push(`${done.length} xong`);
    if (errors.length) parts.push(`<span class="err">${errors.length} lỗi</span>`);
  }
  el.summary.innerHTML = parts.join(" · ");

  // Bảng
  const shown = filter === "over"
    ? videos.filter((v) => isOver(v, t) || !["idle", "skipped"].includes(v.status))
    : filter === "error"
      ? errors
      : videos;

  // Chỉ giữ lựa chọn cho video còn chia được.
  for (const v of videos) if (v.selected && !canSplit(v, t)) v.selected = false;

  el.rows.replaceChildren();
  for (const v of shown) {
    const isO = isOver(v, t);
    const expanded = v.status === "done" && v.expanded;
    const ext = (v.fileName.split(".").pop() || "").slice(0, 4);
    const check = h("input", {
      type: "checkbox",
      checked: !!v.selected,
      disabled: !canSplit(v, t) || busy,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        v.selected = e.target.checked;
        render();
      },
    });
    check.setAttribute("aria-label", `Chọn ${v.fileName}`);
    const row = h(
      "tr",
      {
        class: [
          "item",
          `st-${v.status}`,
          isO ? "" : "below",
          v.selected ? "selected" : "",
          v.status === "done" ? "clickable" : "",
          expanded ? "expanded has-detail" : "",
        ].join(" "),
        title: v.path,
        onclick: () => v.status === "done" && toggle(v),
      },
      h("td", {}, check),
      h("td", {},
        h("div", { class: "video-cell" },
          h("div", { class: "file-icon" }, ext),
          h("div", { style: "min-width:0" },
            h("div", { class: "name" }, v.fileName),
            v.folder ? h("div", { class: "folder" }, icon("folder"), v.folder) : null,
          ),
        ),
      ),
      h("td", { class: "num size" }, fmtSize(v.sizeBytes)),
      partsCell(v, isO, chunk, error),
      statusCell(v, t),
      actionCell(v, t, error),
    );
    row.dataset.path = v.path;
    el.rows.append(row);
    if (expanded) el.rows.append(detailRow(v));
  }

  // Chọn nhiều
  const selectable = shown.filter((v) => canSplit(v, t));
  const selected = videos.filter((v) => v.selected);
  el.selectAll.disabled = busy || selectable.length === 0;
  el.selectAll.checked = selectable.length > 0 && selectable.every((v) => v.selected);
  el.selectAll.indeterminate = !el.selectAll.checked && selectable.some((v) => v.selected);
  el.selBar.hidden = selected.length === 0 || view !== "videos";
  el.selCount.textContent = `${selected.length} video đã chọn`;
  el.selSplit.querySelector("span").textContent = `Chia ${selected.length} video`;

  // Trạng thái trống
  el.empty.hidden = shown.length > 0;
  if (scanning) {
    el.emptyTitle.textContent = "Đang quét…";
    el.emptySub.textContent = "Đang tìm các file video trong thư mục.";
  } else if (!sources.length) {
    el.emptyTitle.textContent = "Chưa có video";
    el.emptySub.textContent = "Bấm “Chọn thư mục” hoặc kéo thả thư mục / file vào cửa sổ.";
  } else if (!videos.length) {
    el.emptyTitle.textContent = "Không tìm thấy video";
    el.emptySub.textContent = el.recursive.checked
      ? "Folder này không chứa file video nào."
      : "Thử bật “Quét cả thư mục con” trong Cài đặt.";
  } else if (filter === "error") {
    el.emptyTitle.textContent = "Không có video lỗi";
    el.emptySub.textContent = "Tất cả video đã xử lý đều thành công.";
  } else {
    el.emptyTitle.textContent = "Không có video nào cần chia";
    el.emptySub.textContent = `Tất cả video đều ≤ ${threshold} MiB. Hạ ngưỡng trong Cài đặt hoặc chọn “Tất cả” để xem.`;
  }

  // Nguồn & thư mục lưu
  const sourceLabel = sources.length === 0 ? "Chưa chọn nguồn"
    : sources.length === 1 ? sources[0]
    : `${sources.length} mục đã chọn`;
  el.sourceText.textContent = sourceLabel;
  el.sourceText.title = sources.join("\n");
  el.sourceFull.textContent = sources.length > 1 ? sources.map(baseName).join(", ") : sourceLabel;
  el.footText.textContent = videos.length
    ? `${shown.length} / ${videos.length} video · Kéo thả để thêm nguồn khác`
    : "Kéo thả thư mục hoặc file vào cửa sổ để thêm";

  el.outBeside.checked = !outDir && !pickingOut;
  el.outCustom.checked = !!outDir || pickingOut;
  el.outBesideCard.classList.toggle("selected", el.outBeside.checked);
  el.outCustomCard.classList.toggle("selected", el.outCustom.checked);
  el.outdirText.textContent = outDir || "Chưa chọn thư mục";
  el.outdirText.title = outDir;
  el.outdirText.parentElement.classList.toggle("set", !!outDir);
  el.pickOut.disabled = !el.outCustom.checked;

  // Tóm tắt cấu hình (sidebar + cài đặt)
  el.cfgThreshold.textContent = error ? "—" : `${threshold} MiB`;
  el.cfgChunk.textContent = error ? "—" : `${chunk} MiB`;
  el.cfgOut.textContent = outDir ? baseName(outDir) : "Cạnh film";
  el.previewText.textContent = error ? "Nhập cấu hình hợp lệ để xem số đoạn dự kiến."
    : !videos.length ? "Chọn nguồn video để xem số đoạn dự kiến."
    : pending.length ? `Với nguồn hiện tại: ${pending.length} video sẽ được chia thành ${estParts} đoạn, mỗi đoạn ≤ ${chunk} MiB. Đoạn được cắt tại keyframe gần nhất nên dung lượng thực có thể lệch vài MiB.`
    : "Không có video nào cần chia với cấu hình này.";

  // Nút & khoá khi đang chạy
  for (const b of el.filter.children) b.classList.toggle("active", b.dataset.filter === filter);
  for (const b of el.presets.children) b.classList.toggle("active", Number(b.dataset.v) === chunk);
  el.splitAll.disabled = !!error || pending.length === 0 || busy;
  el.splitAll.querySelector("span").textContent = pending.length ? `Chia tất cả (${pending.length})` : "Chia tất cả";
  const lock = busy || scanning;
  for (const b of [el.pickFolder, el.pickFiles, el.threshold, el.chunk, el.recursive, el.outBeside, el.outCustom, ...el.presets.children]) {
    b.disabled = lock;
  }
  el.rescan.disabled = lock || !sources.length;
  if (lock) el.pickOut.disabled = true;
  setView(view, false);
  renderQueue();
}

function renderQueue() {
  el.queue.hidden = !isBusy();
  if (el.queue.hidden) return;
  const frac = current ? (current.percent || 0) / 100 : 0;
  const pct = batch.total ? ((batch.done + frac) / batch.total) * 100 : 0;
  el.queueText.textContent = current
    ? `Đang chia ${current.fileName} · ${Math.min(batch.done + 1, batch.total)}/${batch.total}`
    : "Đang chuẩn bị…";
  el.queuePct.textContent = `${pct.toFixed(0)}%`;
  el.queueFill.style.width = `${pct}%`;
}

/** Cập nhật tiến trình mà không vẽ lại cả bảng. */
function renderProgress(v) {
  renderQueue();
  const row = [...el.rows.children].find((r) => r.dataset.path === v.path);
  if (!row) return;
  const text = row.querySelector(".run-text");
  const fill = row.querySelector(".run-fill");
  const pct = row.querySelector(".run-pct");
  if (text) text.textContent = v.message;
  if (fill) fill.style.width = `${v.percent}%`;
  if (pct) pct.textContent = `${v.percent.toFixed(0)}%`;
}

// ---- Quét ----
async function scan(paths) {
  if (isBusy() || !paths?.length) return;
  sources = paths;
  scanning = true;
  render();
  try {
    const found = await invoke("scan_videos", { paths, recursive: el.recursive.checked });
    // Giữ lại trạng thái các video đã xử lý nếu quét lại cùng chỗ.
    const old = new Map(videos.map((v) => [v.path, v]));
    videos = found.map((f) => {
      const prev = old.get(f.path);
      return prev && prev.sizeBytes === f.sizeBytes ? { ...prev, ...f } : { ...f, status: "idle" };
    });
  } catch (e) {
    videos = [];
    toast(`Lỗi khi quét: ${e}`);
  } finally {
    scanning = false;
    render();
  }
}

el.pickFolder.addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false });
  if (dir) scan([dir]);
});
el.pickFiles.addEventListener("click", async () => {
  const files = await open({
    multiple: true,
    filters: [{ name: "Video", extensions: VIDEO_EXT }, { name: "Tất cả", extensions: ["*"] }],
  });
  if (files?.length) scan(files);
});
el.rescan.addEventListener("click", () => scan(sources));
el.recursive.addEventListener("change", () => {
  saveSettings();
  if (sources.length) scan(sources);
});

getCurrentWebview().onDragDropEvent((event) => {
  const { type } = event.payload;
  const canDrop = !isBusy() && !scanning;
  if (type === "enter" || type === "over") {
    el.overlay.hidden = !canDrop;
  } else {
    el.overlay.hidden = true;
    if (type === "drop" && event.payload.paths?.length) {
      if (canDrop) scan(event.payload.paths);
      else toast("Đang xử lý, hãy đợi xong hoặc bấm Huỷ trước khi quét folder khác.");
    }
  }
});

// ---- Thư mục lưu & cấu hình ----
let pickingOut = false;
async function chooseOutDir() {
  pickingOut = true;
  render();
  try {
    const dir = await open({ directory: true, multiple: false });
    if (dir) {
      outDir = dir;
      saveSettings();
    }
  } finally {
    pickingOut = false;
    render();
  }
}
el.pickOut.addEventListener("click", chooseOutDir);
el.outCustom.addEventListener("change", () => {
  if (!outDir) chooseOutDir();
});
el.outBeside.addEventListener("change", () => {
  outDir = "";
  saveSettings();
  render();
});

// ---- Chuyển tab ----
function setView(next, persist = true) {
  view = next;
  el.viewVideos.hidden = view !== "videos";
  el.viewSettings.hidden = view !== "settings";
  el.crumb.textContent = view === "videos" ? "Danh sách video" : "Cài đặt";
  for (const b of el.nav.querySelectorAll(".nav-item")) b.classList.toggle("active", b.dataset.view === view);
  if (persist) {
    saveSettings();
    render();
  }
}
el.nav.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setView(b.dataset.view);
});
el.cfgEdit.addEventListener("click", () => setView("settings"));

// ---- Chọn nhiều ----
el.selectAll.addEventListener("change", () => {
  const { threshold, error } = readInputs();
  const t = error ? Infinity : threshold;
  const shown = filter === "over"
    ? videos.filter((v) => isOver(v, t) || !["idle", "skipped"].includes(v.status))
    : filter === "error" ? videos.filter((v) => v.status === "error") : videos;
  for (const v of shown) if (canSplit(v, t)) v.selected = el.selectAll.checked;
  render();
});
el.selClear.addEventListener("click", () => {
  for (const v of videos) v.selected = false;
  render();
});
el.selSplit.addEventListener("click", () => enqueue(videos.filter((v) => v.selected)));

function onConfigChange() {
  // Đổi cấu hình thì các video "không cần chia" cần được xét lại.
  for (const v of videos) if (v.status === "skipped") v.status = "idle";
  saveSettings();
  render();
}
el.threshold.addEventListener("input", onConfigChange);
el.chunk.addEventListener("input", onConfigChange);
el.presets.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b || b.disabled) return;
  el.chunk.value = b.dataset.v;
  onConfigChange();
});
el.filter.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-filter]");
  if (!b) return;
  filter = b.dataset.filter;
  saveSettings();
  render();
});

// ---- Hàng đợi chia video ----
function enqueue(list) {
  const { threshold, error } = readInputs();
  if (error) return;
  if (!isBusy()) batch = { total: 0, done: 0 };
  for (const v of list) {
    if (!canSplit(v, threshold)) continue;
    v.status = "queued";
    v.selected = false;
    v.error = null;
    queue.push(v.path);
    batch.total++;
  }
  render();
  processNext();
}

function unqueue(v) {
  queue = queue.filter((p) => p !== v.path);
  v.status = "idle";
  batch.total = Math.max(batch.done, batch.total - 1);
  render();
}

async function processNext() {
  if (current || !queue.length) {
    render();
    return;
  }
  const { threshold, chunk } = readInputs();
  const v = videos.find((x) => x.path === queue[0]);
  queue.shift();
  if (!v) return processNext();

  current = v;
  v.status = "running";
  v.percent = 0;
  v.message = "Đang chuẩn bị…";
  render();

  try {
    const res = await invoke("split_video", {
      path: v.path,
      thresholdMib: threshold,
      chunkMib: chunk,
      outDir: outDir || null,
    });
    if (res.split) {
      v.status = "done";
      v.result = { ...res, chunk };
    } else {
      v.status = "skipped";
    }
  } catch (e) {
    const msg = String(e);
    v.status = msg === "Đã huỷ" ? "cancelled" : "error";
    v.error = msg;
  } finally {
    current = null;
    batch.done++;
    processNext();
  }
}

listen("split-progress", ({ payload }) => {
  if (!current) return;
  current.percent = payload.percent;
  current.message = payload.message;
  renderProgress(current);
});

el.splitAll.addEventListener("click", () => {
  const { threshold } = readInputs();
  enqueue(videos.filter((v) => canSplit(v, threshold)));
});

el.cancel.addEventListener("click", () => {
  for (const path of queue) {
    const v = videos.find((x) => x.path === path);
    if (v) v.status = "idle";
  }
  queue = [];
  if (current) invoke("cancel_split");
  render();
});

function reveal(v) {
  const target = v.result?.parts[0]?.path ?? v.result?.outDir;
  if (target) revealItemInDir(target).catch((e) => toast(String(e)));
}

loadSettings();
render();
