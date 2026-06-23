let state = { members: [], tasks: [] };
let editingId = null;
let selAssignee = undefined; // undefined=未選；null=未分配；string=成員ID
let selProject = undefined;  // undefined=未選；string=專案名
let pasteImages = [];

const $ = (s) => document.querySelector(s);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};

const STATUS = [
  { key: "todo", label: "尚未開始" },
  { key: "doing", label: "進行中" },
  { key: "done", label: "已完成" },
  { key: "archived", label: "已封存" },
];
const UNASSIGNED = "__none__";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function load() {
  state = await api("/api/state");
  renderAll();
}
const STATUS_TXT = { todo: "尚未開始", doing: "進行中", done: "已完成", archived: "已封存" };
function renderAll() { renderMembers(); renderProjects(); renderTodayPane(); renderKanban(); }

// 中間欄下方：選了人後，列出那個人「今天有事」的任務（跨專案），點可開
function renderTodayPane() {
  const pane = $("#todayPane");
  if (!pane) return;
  if (selAssignee === undefined) { pane.innerHTML = ""; return; }
  const today = todayStr();
  const list = tasksByAssignee(selAssignee)
    .filter((t) => t.status !== "done" && t.status !== "archived" && occupies(t, today))
    .sort((a, b) => (a.dueDate || a.startDate || "9999").localeCompare(b.dueDate || b.startDate || "9999"));
  let html = `<div class="today-title">📅 今天 ${today}${list.length ? `・${list.length} 件` : ""}</div>`;
  if (list.length === 0) {
    html += '<div class="today-empty">沒有今日到期的任務</div>';
  } else {
    html += list.map((t) =>
      `<div class="today-item" data-id="${t.id}"><div>${esc(t.title)}</div>` +
      `<div class="today-meta">${esc(t.project || "未分類")}・${STATUS_TXT[t.status] || t.status}</div></div>`
    ).join("");
  }
  pane.innerHTML = html;
  pane.querySelectorAll(".today-item").forEach((el) => { el.onclick = () => openModal(el.dataset.id); });
}

function tasksByAssignee(a) {
  const t = a === UNASSIGNED ? null : a;
  return state.tasks.filter((x) => (x.assigneeId || null) === t);
}
function projOf(t) { return t.project || "未分類"; }

// ---------- 左：成員 ----------
function renderMembers() {
  const ul = $("#memberList");
  ul.innerHTML = "";
  const rows = state.members.map((m) => ({ key: m.id, name: m.name, avatar: m.avatar }));
  if (tasksByAssignee(UNASSIGNED).length > 0) rows.push({ key: UNASSIGNED, name: "未分配", avatar: "" });

  for (const r of rows) {
    const list = tasksByAssignee(r.key);
    const newCount = list.filter((t) => !t.seen).length;
    const li = document.createElement("li");
    li.className = "nav-item" + (selAssignee === r.key ? " active" : "");
    li.innerHTML = `
      ${r.avatar ? `<img class="avatar" src="${r.avatar}">` : '<span class="avatar"></span>'}
      <span class="n-name">${esc(r.name)}</span>
      ${newCount > 0 ? `<span class="badge-new">${newCount} 新</span>` : `<span class="n-total">${list.length}</span>`}`;
    li.onclick = () => selectMember(r.key);
    ul.appendChild(li);
  }
}

function selectMember(key) {
  selAssignee = key;
  selProject = undefined; // 換人時重置專案選擇
  renderAll();
}

// ---------- 中：專案分類 ----------
function renderProjects() {
  const ul = $("#projectList");
  const title = $("#projectPaneTitle");
  ul.innerHTML = "";
  if (selAssignee === undefined) {
    title.textContent = "專案分類";
    ul.innerHTML = '<li class="pane-empty">先選一位成員</li>';
    return;
  }
  const name = selAssignee === UNASSIGNED ? "未分配" : state.members.find((m) => m.id === selAssignee)?.name || "（已移除）";
  title.textContent = `${name} 的專案`;

  const list = tasksByAssignee(selAssignee);
  const projects = [...new Set(list.map(projOf))].sort();
  if (projects.length === 0) { ul.innerHTML = '<li class="pane-empty">目前尚未使用本功能</li>'; return; }

  for (const p of projects) {
    const pt = list.filter((t) => projOf(t) === p);
    const newCount = pt.filter((t) => !t.seen).length;
    const li = document.createElement("li");
    li.className = "nav-item" + (selProject === p ? " active" : "");
    li.innerHTML = `
      <span class="proj-ico">📁</span>
      <span class="n-name">${esc(p)}</span>
      ${newCount > 0 ? `<span class="badge-new">${newCount} 新</span>` : `<span class="n-total">${pt.length}</span>`}`;
    li.onclick = () => selectProject(p);
    ul.appendChild(li);
  }
}

async function selectProject(p) {
  selProject = p;
  renderProjects();
  renderKanban();
  // 進入此分類即標記已讀
  await api("/api/seen", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assigneeId: selAssignee === UNASSIGNED ? null : selAssignee, project: p }),
  });
  state = await api("/api/state");
  renderAll();
}

// ---------- 右：任務看板（三欄） ----------
function renderKanban() {
  const head = $("#detailName");
  const btnNew = $("#btnNewForPerson");
  const board = $("#kanban");

  const btnNotifyP = $("#btnNotifyProject");
  if (selAssignee === undefined || selProject === undefined) {
    head.textContent = selAssignee === undefined ? "← 請從左側選擇成員" : "← 請選擇一個專案分類";
    btnNew.classList.add("hidden");
    btnNotifyP.classList.add("hidden");
    board.innerHTML = '<div class="full-empty">選成員 →  選專案分類 →  這裡會用「尚未開始 / 進行中 / 已完成」三欄顯示任務。</div>';
    return;
  }

  const name = selAssignee === UNASSIGNED ? "未分配" : state.members.find((m) => m.id === selAssignee)?.name || "（已移除）";
  head.textContent = `${name} ／ ${selProject}`;
  btnNew.classList.remove("hidden");
  // 未分配不能 tag，就不顯示專案推送鈕
  btnNotifyP.classList.toggle("hidden", selAssignee === UNASSIGNED);

  const list = tasksByAssignee(selAssignee).filter((t) => projOf(t) === selProject);
  board.innerHTML = "";
  // 依日期排序：有日期的越接近越上面，沒日期的排最後
  const byDue = (a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31");
  for (const col of STATUS) {
    const colTasks = list.filter((t) => t.status === col.key).sort(byDue);
    const el = document.createElement("div");
    el.className = "kanban-col" + (col.key === "archived" ? " archived-col" : "");
    el.dataset.status = col.key;
    el.innerHTML = `<h3><span class="col-dot ${col.key}"></span>${col.label}<span class="col-count">${colTasks.length}</span></h3>`;
    for (const t of colTasks) el.appendChild(card(t));
    // 拖放：放到此欄就改成此狀態
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop-hover"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-hover"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drop-hover");
      const id = e.dataTransfer.getData("text/plain");
      const t = state.tasks.find((x) => x.id === id);
      if (!t || t.status === col.key) return;
      await api(`/api/tasks/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: col.key }) });
      await load();
    });
    board.appendChild(el);
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// 距今天還有幾天（負數=已過期）；無日期回傳 null
function daysUntil(ds) {
  if (!ds) return null;
  const d = new Date(ds + "T00:00:00"), t = new Date(todayStr() + "T00:00:00");
  return Math.round((d - t) / 86400000);
}
const SOON_DAYS = 2; // 2 天內（含今天）算「快到期」→ 金光
const REC_LABEL = { once: "", daily: "每日", weekly: "每週" };
// 任務是否「佔用」某一天：有開始+結束→整段都算；只有結束→當天；只有開始→當天
function occupies(t, ds) {
  const s = t.startDate, e = t.dueDate;
  if (s && e) return ds >= s && ds <= e;
  if (e) return ds === e;
  if (s) return ds === s;
  return false;
}

function card(t) {
  const el = document.createElement("div");
  const active = t.status !== "done" && t.status !== "archived";
  const du = daysUntil(t.dueDate);
  const overdue = active && du !== null && du < 0;
  const soon = active && du !== null && du >= 0 && du <= SOON_DAYS;
  const isArchived = t.status === "archived";
  el.className = "card" + (!isArchived && !t.seen ? " is-new" : "") + (overdue ? " overdue" : "") + (soon ? " soon" : "");
  el.draggable = true;
  el.dataset.id = t.id;
  const rep = t.completion?.note || (t.completion?.images?.length);
  const dateText = t.startDate && t.dueDate ? `${t.startDate} ~ ${t.dueDate}` : (t.dueDate || t.startDate || "");
  const recTag = t.recurrence && t.recurrence !== "once" ? ` 🔁${REC_LABEL[t.recurrence] || ""}` : "";
  el.innerHTML = `
    <div class="title">${!t.seen ? '<span class="tag-new">新</span>' : ""}${esc(t.title)}</div>
    ${dateText || recTag ? `<div class="due${overdue ? " overdue" : ""}">${dateText ? "📅 " + dateText : ""}${recTag}${overdue ? "（已逾期）" : ""}</div>` : ""}
    ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ""}
    ${rep ? `<div class="done-mark">✅ 已回報${t.completion.images?.length ? `（${t.completion.images.length} 張圖）` : ""}</div>` : ""}`;
  el.onclick = () => openModal(t.id);
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", t.id);
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  return el;
}

// ---------- Modal ----------
function fillAssignee() {
  $("#fAssignee").innerHTML = '<option value="">未分配</option>' +
    state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
}
// 建立專案下拉：列出所有專案（含尚無任務的），預設選 current，可改選任何專案，最後一項可自訂新專案
function fillProjectSelect(current) {
  const base = (state.projects && state.projects.length)
    ? [...state.projects]
    : [...new Set(state.tasks.map(projOf))].sort();
  if (!base.includes("未分類")) base.push("未分類");
  const cur = current && current.trim() ? current.trim() : "";
  if (cur && !base.includes(cur)) base.unshift(cur);
  const sel = $("#fProject");
  sel.innerHTML = base.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  sel.value = cur && base.includes(cur) ? cur : base[0];
}

function openModal(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  editingId = id;
  pasteImages = [...(t.completion?.images || [])];
  fillAssignee();
  $("#modalTitle").textContent = "編輯任務";
  $("#fTitle").value = t.title;
  $("#fDesc").value = t.description || "";
  $("#fAssignee").value = t.assigneeId || "";
  fillProjectSelect(projOf(t));
  $("#fStatus").value = t.status;
  $("#fStart").value = t.startDate || "";
  $("#fDue").value = t.dueDate || "";
  $("#fRecurrence").value = t.recurrence || "once";
  $("#fNote").value = t.completion?.note || "";
  renderImages();
  syncCalendar();
  $("#btnDelete").style.display = "";
  $("#btnNotify").style.display = "";
  $("#modal").classList.remove("hidden");
}

function openNew() {
  editingId = null;
  pasteImages = [];
  fillAssignee();
  $("#modalTitle").textContent = "新增任務";
  $("#fTitle").value = "";
  $("#fDesc").value = "";
  $("#fAssignee").value = selAssignee && selAssignee !== UNASSIGNED ? selAssignee : "";
  fillProjectSelect(selProject && selProject !== UNASSIGNED ? selProject : "");
  $("#fStatus").value = "todo";
  $("#fStart").value = "";
  $("#fDue").value = "";
  $("#fRecurrence").value = "once";
  $("#fNote").value = "";
  renderImages();
  syncCalendar();
  $("#btnDelete").style.display = "none";
  $("#btnNotify").style.display = "none";
  $("#modal").classList.remove("hidden");
}

// ---------- 月曆 ----------
let calYear, calMonth; // 目前顯示的年月（0-based month）

function syncCalendar() {
  const start = $("#fStart").value, due = $("#fDue").value;
  $("#calPanel").classList.remove("hidden"); // 一律顯示月曆
  const focus = due || start;
  const base = focus ? new Date(focus + "T00:00:00") : new Date();
  calYear = base.getFullYear();
  calMonth = base.getMonth();
  renderCalendar();
  // 任務本身有日期 → 自動展開那天的任務清單，不用再點一次
  if (focus) showDayTasks(focus);
  else $("#calDayList").innerHTML = "";
}

function renderCalendar() {
  const start = $("#fStart").value, due = $("#fDue").value;
  $("#calTitle").textContent = `${calYear} 年 ${calMonth + 1} 月`;
  const grid = $("#calGrid");
  const today = todayStr();
  const first = new Date(calYear, calMonth, 1).getDay();
  const days = new Date(calYear, calMonth + 1, 0).getDate();
  let html = ["日", "一", "二", "三", "四", "五", "六"].map((w) => `<div class="head">${w}</div>`).join("");
  for (let i = 0; i < first; i++) html += '<div class="cell empty"></div>';
  const proj = ($("#fProject").value || "").trim() || "未分類";
  const sameProj = state.tasks.filter((t) => (t.project || "未分類") === proj);
  for (let d = 1; d <= days; d++) {
    const ds = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cls = ["cell", "pick"];
    if (sameProj.some((t) => occupies(t, ds))) cls.push("has-task"); // 同專案其他任務（含區間每天）
    if (ds === today) cls.push("today");
    // 目前編輯任務的「日期/區間」：有開始+結束→整段標起來
    const inCurrent = start && due ? ds >= start && ds <= due : due ? ds === due : start ? ds === start : false;
    if (inCurrent) cls.push("due");
    html += `<div class="${cls.join(" ")}" data-date="${ds}">${d}</div>`;
  }
  grid.innerHTML = html;
  // 點日期 = 在下方列出當天所有任務
  grid.querySelectorAll(".pick").forEach((c) => {
    c.onclick = () => showDayTasks(c.dataset.date);
  });
}

// 點月曆某天 → 下方顯示當天任務清單；點任務可跳去開那個任務
function showDayTasks(ds) {
  const box = $("#calDayList");
  const proj = ($("#fProject").value || "").trim() || "未分類";
  const items = state.tasks.filter((t) => (t.project || "未分類") === proj && occupies(t, ds));
  const STAT = { todo: "尚未開始", doing: "進行中", done: "已完成", archived: "已封存" };
  if (items.length === 0) {
    box.innerHTML = `<div class="dl-title">${ds}</div><div class="dl-meta">這天沒有任務</div>`;
    return;
  }
  box.innerHTML =
    `<div class="dl-title">📅 ${ds} 的任務（${items.length}）</div>` +
    items.map((t) => {
      const m = state.members.find((x) => x.id === t.assigneeId);
      return `<div class="dl-item" data-id="${t.id}"><div>${esc(t.title)}</div>` +
        `<div class="dl-meta">${esc(t.project || "未分類")}・${m ? esc(m.name) : "未分配"}・${STAT[t.status] || t.status}</div></div>`;
    }).join("");
  box.querySelectorAll(".dl-item").forEach((el) => {
    el.onclick = () => openModal(el.dataset.id);
  });
}

function closeModal() { $("#modal").classList.add("hidden"); editingId = null; }

function renderImages() {
  const box = $("#imgPreview");
  box.innerHTML = pasteImages.map((url, i) => `<div class="thumb"><img src="${url}"><div class="rm" data-i="${i}">✕</div></div>`).join("");
  box.querySelectorAll(".rm").forEach((b) => { b.onclick = () => { pasteImages.splice(Number(b.dataset.i), 1); renderImages(); }; });
}

async function uploadBlob(blob) {
  const fd = new FormData();
  fd.append("image", blob, "paste.png");
  const { url } = await api("/api/upload", { method: "POST", body: fd });
  pasteImages.push(url); renderImages();
}
$("#fNote").addEventListener("paste", async (e) => {
  for (const it of e.clipboardData?.items || []) {
    if (it.type.startsWith("image/")) { e.preventDefault(); await uploadBlob(it.getAsFile()); }
  }
});

async function saveTask({ complete, keepOpen = false }) {
  const payload = {
    title: $("#fTitle").value.trim(),
    description: $("#fDesc").value,
    assigneeId: $("#fAssignee").value || null,
    project: ($("#fProject").value && $("#fProject").value !== "__new__") ? $("#fProject").value : "未分類",
    status: $("#fStatus").value,
    startDate: $("#fStart").value || "",
    dueDate: $("#fDue").value || "",
    recurrence: $("#fRecurrence").value || "once",
  };
  if (!payload.title) return alert("請填標題");

  if (!editingId) {
    const t = await api("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    editingId = t.id;
  } else {
    await api(`/api/tasks/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  await api(`/api/tasks/${editingId}/complete`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: $("#fNote").value, images: pasteImages, markDone: complete }),
  });

  if (keepOpen) { await load(); return; }
  closeModal(); await load();
}

// ---------- 事件 ----------
$("#btnNew").onclick = openNew;
$("#btnNewForPerson").onclick = openNew;
$("#fDue").addEventListener("change", syncCalendar);
$("#fStart").addEventListener("change", syncCalendar);
$("#fProject").addEventListener("change", () => {
  $("#calDayList").innerHTML = "";
  renderCalendar();
});
$("#calPrev").onclick = () => { if (--calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); };
$("#calNext").onclick = () => { if (++calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); };
$("#btnReload").onclick = load;
$("#modalClose").onclick = closeModal;
$("#btnSave").onclick = () => saveTask({ complete: false });
$("#btnComplete").onclick = () => saveTask({ complete: true });

$("#btnNotify").onclick = async () => {
  if (!editingId) return;
  // 先存目前的負責人/專案/狀態，確保通知內容最新
  await saveTask({ complete: false, keepOpen: true });
  const t = state.tasks.find((x) => x.id === editingId);
  if (!t) return;
  const project = t.project || "未分類";
  const ch = state.projectChannels?.[project];
  if (!ch) return alert(`專案「${project}」沒有對應的討論群頻道，無法推送。\n請先在 config.json 的 projectChannels 設定。`);
  const m = state.members.find((x) => x.id === t.assigneeId);
  const who = m ? m.name : "（未分配，不會 tag）";
  if (!confirm(`即將發到【${ch.label}】，tag ${who}\n\n📌 ${t.title}\n\n確定送出？`)) return;
  try {
    const r = await api(`/api/tasks/${editingId}/notify`, { method: "POST" });
    alert(r.tagged ? `已發到【${ch.label}】並 tag ${who} ✅` : `已發到【${ch.label}】（此負責人無法 tag）`);
  } catch (e) { alert("推送失敗：" + e.message); }
};

// 整個專案一次推送（某人 × 目前專案 的未完成任務）
$("#btnNotifyProject").onclick = async () => {
  if (selAssignee === undefined || selProject === undefined) return;
  const ch = state.projectChannels?.[selProject];
  if (!ch) return alert(`專案「${selProject}」沒有對應的討論群頻道，無法推送。`);
  const list = tasksByAssignee(selAssignee).filter((t) => projOf(t) === selProject && t.status !== "done");
  if (list.length === 0) return alert("這個人在此專案沒有未完成的任務。");
  const m = selAssignee === UNASSIGNED ? null : state.members.find((x) => x.id === selAssignee);
  const who = m ? m.name : "（未分配，不會 tag）";
  const preview = list.map((t) => "• " + t.title).join("\n");
  if (!confirm(`即將把【${who}／${selProject}】的 ${list.length} 項未完成任務整理成一則，發到【${ch.label}】並 tag ${who}：\n\n${preview}\n\n確定送出？`)) return;
  try {
    const r = await api("/api/notify-project", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeId: selAssignee === UNASSIGNED ? null : selAssignee, project: selProject }),
    });
    alert(`已發到【${ch.label}】，共 ${r.count} 項${r.tagged ? "並 tag " + who : ""} ✅`);
  } catch (e) { alert("推送失敗：" + e.message); }
};

$("#btnDelete").onclick = async () => {
  if (!editingId || !confirm("確定刪除這個任務？")) return;
  await api(`/api/tasks/${editingId}`, { method: "DELETE" });
  closeModal(); await load();
};

$("#btnAddMember").onclick = async () => {
  const name = prompt("新增成員名稱：");
  if (!name?.trim()) return;
  await api("/api/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  await load();
};

$("#btnImport").onclick = async () => {
  const text = prompt('貼上 Claude 整理好的任務 JSON 陣列，例如：\n[{"title":"...","project":"神州M","assigneeId":null,"status":"todo"}]');
  if (!text?.trim()) return;
  let data;
  try { data = JSON.parse(text); } catch { return alert("JSON 格式錯誤"); }
  const r = await api("/api/tasks/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  alert(`已匯入 ${r.count} 筆`); await load();
};

load();
