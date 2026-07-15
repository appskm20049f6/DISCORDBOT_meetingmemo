/**
 * 內部任務看板網頁（Express）
 *  - 列出 DC 群成員、把分析好的工作分配給人
 *  - 負責人完成時可在任務上「寫文字」或「貼上複製的圖片」回報完成狀態
 *
 * 啟動：node src/server.js  → 開 http://localhost:3000
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { ROOT, read, write } from "./db.js";

const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(ROOT, "config.json");
const BOARDS_PATH = path.join(ROOT, "data", "boards.json");
const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// 推送通知的目標頻道：優先用該專案的「工作提醒」看板頻道，沒有再退回 config 的討論群對應
function resolveChannelId(project) {
  try {
    if (fs.existsSync(BOARDS_PATH)) {
      const boards = JSON.parse(fs.readFileSync(BOARDS_PATH, "utf-8"));
      for (const b of Object.values(boards)) {
        if (b.project === project && b.channelId) return b.channelId;
      }
    }
  } catch { /* 忽略，往下退回 */ }
  const config = loadConfig();
  return (config.projectChannels || {})[project] || null;
}

const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "data", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

const now = () => new Date().toISOString();

// 取得整體狀態（成員 + 任務 + 專案對應的討論群名稱）
app.get("/api/state", (_req, res) => {
  const db = read();
  const config = loadConfig();
  const labelById = new Map((config.channels || []).map((c) => [String(c.id), c.label]));
  const channelLabels = config.channelLabels || {};
  const boardName = config.reminderBoards?.channelName || "工作提醒";
  const labelOf = (id) => channelLabels[String(id)] || labelById.get(String(id)) || String(id);
  const projectChannels = {};
  // 先放 config 的討論群對應（退回用）
  for (const [proj, id] of Object.entries(config.projectChannels || {})) {
    projectChannels[proj] = { id: String(id), label: labelOf(id) };
  }
  // 工作提醒看板優先（顯示實際送達頻道）
  try {
    if (fs.existsSync(BOARDS_PATH)) {
      const boards = JSON.parse(fs.readFileSync(BOARDS_PATH, "utf-8"));
      for (const b of Object.values(boards)) {
        if (b.project && b.channelId) projectChannels[b.project] = { id: String(b.channelId), label: channelLabels[String(b.channelId)] || `#${boardName}` };
      }
    }
  } catch { /* ignore */ }
  // 完整專案清單（任務的 + 設定的專案頻道 + 看板群組），給新增任務時自由選擇
  const projectSet = new Set(db.tasks.map((t) => t.project || "未分類"));
  for (const p of Object.keys(config.projectChannels || {})) projectSet.add(p);
  for (const g of config.reminderBoards?.groups || []) if (g.project) projectSet.add(g.project);
  const projects = [...projectSet].sort();
  res.json({ ...db, projectChannels, projects });
});

// 新增任務
app.post("/api/tasks", (req, res) => {
  const { title, description = "", assigneeId = null, status = "todo", project = "未分類", dueDate = "", startDate = "", recurrence = "once" } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: "標題必填" });
  const db = read();
  const task = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description,
    assigneeId,
    status,
    project: project?.trim() || "未分類",
    startDate: startDate || "",
    dueDate: dueDate || "",
    recurrence: recurrence || "once",
    completedAt: status === "done" ? now() : "",
    seen: false,
    createdAt: now(),
    updatedAt: now(),
    completion: { note: "", images: [] },
  };
  db.tasks.push(task);
  write(db);
  res.json(task);
});

// 批次匯入（給 Claude 整理好的 JSON：[{title, description, assigneeId, status}]）
app.post("/api/tasks/import", (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body.tasks;
  if (!Array.isArray(items)) return res.status(400).json({ error: "需傳入任務陣列" });
  const db = read();
  const created = items.map((it) => ({
    id: crypto.randomUUID(),
    title: String(it.title || "未命名任務"),
    description: it.description || "",
    assigneeId: it.assigneeId || null,
    status: it.status || "todo",
    project: (it.project && String(it.project).trim()) || "未分類",
    startDate: it.startDate || "",
    dueDate: it.dueDate || "",
    recurrence: it.recurrence || "once",
    completedAt: (it.status || "todo") === "done" ? now() : "",
    seen: false,
    createdAt: now(),
    updatedAt: now(),
    completion: { note: "", images: [] },
  }));
  db.tasks.push(...created);
  write(db);
  res.json({ count: created.length });
});

// 更新任務（分配、改狀態、改內容）
app.put("/api/tasks/:id", (req, res) => {
  const db = read();
  const t = db.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "找不到任務" });
  for (const k of ["title", "description", "assigneeId", "status", "project", "dueDate", "startDate", "recurrence"]) {
    if (k in req.body) t[k] = req.body[k];
  }
  // 記錄完成時間：剛變成 done 就記；移回未完成就清除；已封存則保留
  if (t.status === "done" && !t.completedAt) t.completedAt = now();
  else if (t.status === "todo" || t.status === "doing") t.completedAt = "";
  t.updatedAt = now();
  write(db);
  res.json(t);
});

// 回報完成（文字 + 已上傳的圖片網址；可選擇是否標記為完成）
app.post("/api/tasks/:id/complete", (req, res) => {
  const { note = "", images = [], markDone = true } = req.body;
  const db = read();
  const t = db.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "找不到任務" });
  t.completion = {
    note,
    images: Array.isArray(images) ? images : [],
  };
  if (markDone) {
    t.status = "done";
    if (!t.completedAt) t.completedAt = now();
  }
  t.updatedAt = now();
  write(db);
  res.json(t);
});

// 標記某負責人的任務為已讀（點選該成員時呼叫，清掉「新任務」提示）
app.post("/api/seen", (req, res) => {
  const { assigneeId, project } = req.body; // assigneeId 用 "" 或 null 代表「未分配」；project 可選
  const target = assigneeId || null;
  const db = read();
  let n = 0;
  for (const t of db.tasks) {
    if ((t.assigneeId || null) !== target) continue;
    if (project != null && (t.project || "未分類") !== project) continue;
    if (!t.seen) { t.seen = true; n++; }
  }
  write(db);
  res.json({ marked: n });
});

// 刪除任務
app.delete("/api/tasks/:id", (req, res) => {
  const db = read();
  const before = db.tasks.length;
  db.tasks = db.tasks.filter((x) => x.id !== req.params.id);
  write(db);
  res.json({ deleted: before - db.tasks.length });
});

const STATUS_LABEL = { todo: "尚未開始", doing: "進行中", done: "已完成" };
const boardUrl = () => process.env.BOARD_URL || `http://localhost:${PORT}`;

// 以 bot 身分把文字發到指定頻道，回傳建立的訊息（含 id）
async function sendToChannel(channelId, content) {
  const token = process.env.DISCORD_TOKEN;
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${token}` },
    body: JSON.stringify({ content, allowed_mentions: { parse: ["users"] } }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Discord 回傳 ${r.status}（多半是 bot 沒有該頻道發言權限）${detail ? "：" + detail.slice(0, 200) : ""}`);
  }
  return r.json();
}

// 「同一個人」的上一則通知記錄：key = `${channelId}:${assigneeId}` → messageId
const NOTIFYLOG_PATH = path.join(ROOT, "data", "notifylog.json");
const readNotifyLog = () => (fs.existsSync(NOTIFYLOG_PATH) ? JSON.parse(fs.readFileSync(NOTIFYLOG_PATH, "utf-8")) : {});
const writeNotifyLog = (o) => fs.writeFileSync(NOTIFYLOG_PATH, JSON.stringify(o, null, 2));

// 推送前：刪掉上一則發給同一個人（在同一頻道）的通知
async function deletePrevForPerson(channelId, assigneeId) {
  if (!assigneeId) return;
  const log = readNotifyLog();
  const prev = log[`${channelId}:${assigneeId}`];
  const prevId = typeof prev === "string" ? prev : prev?.id; // 相容舊格式
  if (!prevId) return;
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${prevId}`, {
    method: "DELETE",
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
  }).catch(() => { /* 訊息可能已被刪，略過 */ });
}

// 推送後：記下這次的訊息 id 與專案（供之後就地更新內容用）
function recordForPerson(channelId, assigneeId, messageId, project) {
  if (!assigneeId || !messageId) return;
  const log = readNotifyLog();
  log[`${channelId}:${assigneeId}`] = { id: messageId, project };
  writeNotifyLog(log);
}

// 組某人某專案的「未完成清單」內容；回傳 { content, count, tagged }
function reminderContent(db, project, target) {
  const tasks = db.tasks.filter(
    (t) => (t.assigneeId || null) === target && (t.project || "未分類") === project && t.status !== "done" && t.status !== "archived"
  ).sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31"));
  const member = db.members.find((m) => m.id === target);
  const isSnowflake = target && /^\d{17,20}$/.test(target);
  const who = isSnowflake ? `<@${target}>` : member ? `**${member.name}**` : "（未分配）";
  if (tasks.length === 0) {
    return { content: `📋 【${project}】→ ${who}：目前無未完成任務 ✅`, count: 0, tagged: isSnowflake };
  }
  const REC = { once: "", daily: "每日", weekly: "每週" };
  const dLabel = (t) => (t.startDate && t.dueDate ? `${t.startDate}~${t.dueDate}` : (t.dueDate || t.startDate || ""));
  const lines = tasks.map((t) => {
    const dl = dLabel(t);
    const rec = t.recurrence && t.recurrence !== "once" ? ` 🔁${REC[t.recurrence]}` : "";
    return `• ${t.title}${dl ? ` 📅 ${dl}` : ""}${rec}（${STATUS_LABEL[t.status]}）`;
  });
  const content = `📋 【${project}】未完成任務清單 → ${who}（共 ${tasks.length} 項）\n` + lines.join("\n") + `\n🔗 看板：${boardUrl()}`;
  return { content, count: tasks.length, tagged: isSnowflake };
}

// 推送某人某專案的「未完成清單」（刪舊發新、不洗版）；回傳 {count} 或 {skipped:true}
async function notifyPersonProject(db, project, assigneeId, { dryRun = false } = {}) {
  const channelId = resolveChannelId(project);
  if (!channelId) throw new Error(`專案「${project}」沒有可推送的頻道`);
  const target = assigneeId || null;
  const rc = reminderContent(db, project, target);
  if (rc.count === 0) return { skipped: true, count: 0 };
  if (dryRun) return { count: rc.count, tagged: rc.tagged, dryRun: true };
  await deletePrevForPerson(channelId, target);
  const msg = await sendToChannel(channelId, rc.content);
  recordForPerson(channelId, target, msg.id, project);
  return { count: rc.count, tagged: rc.tagged };
}

// 就地更新所有提醒訊息的內容（不重新 tag、不洗版），讓提醒永遠與看板/網頁一致
app.post("/api/refresh-reminders", async (req, res) => {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return res.status(400).json({ error: "尚未設定 DISCORD_TOKEN" });
  const db = read();
  const log = readNotifyLog();
  let edited = 0;
  for (const [key, val] of Object.entries(log)) {
    const messageId = typeof val === "string" ? val : val?.id;
    const project = typeof val === "object" ? val.project : null;
    if (!messageId || !project) continue; // 舊格式（無專案）略過，下次推送會補上
    const [channelId, assigneeId] = key.split(":");
    const rc = reminderContent(db, project, assigneeId || null);
    try {
      const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${token}` },
        body: JSON.stringify({ content: rc.content, allowed_mentions: { parse: [] } }),
      });
      if (r.ok) edited++;
    } catch { /* 訊息可能已被刪，略過 */ }
  }
  res.json({ ok: true, edited });
});

// 整個專案一次推送（單一人）
app.post("/api/notify-project", async (req, res) => {
  if (!process.env.DISCORD_TOKEN) return res.status(400).json({ error: "尚未設定 DISCORD_TOKEN（.env）" });
  const { assigneeId, project } = req.body;
  if (!project) return res.status(400).json({ error: "需指定 project" });
  try {
    const r = await notifyPersonProject(read(), project, assigneeId);
    if (r.skipped) return res.status(400).json({ error: "這個人在此專案沒有未完成的任務" });
    res.json({ ok: true, project, ...r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 定時提醒（模式 B）：對所有「還有未完成任務」的人各推一次。?dryRun=1 只回報不發送
app.post("/api/remind-all", async (req, res) => {
  if (!process.env.DISCORD_TOKEN) return res.status(400).json({ error: "尚未設定 DISCORD_TOKEN" });
  const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;
  const db = read();
  const pairs = new Map();
  for (const t of db.tasks) {
    if (t.status === "done" || t.status === "archived" || !t.assigneeId) continue;
    const project = t.project || "未分類";
    if (!resolveChannelId(project)) continue; // 只提醒有工作提醒頻道的專案
    pairs.set(project + "" + t.assigneeId, { project, assigneeId: t.assigneeId });
  }
  const results = [];
  for (const { project, assigneeId } of pairs.values()) {
    try { results.push({ project, assigneeId, ...(await notifyPersonProject(db, project, assigneeId, { dryRun })) }); }
    catch (e) { results.push({ project, assigneeId, error: e.message }); }
  }
  const count = results.filter((r) => r.count && !r.error).length;
  console.log(`remind-all：${dryRun ? "(dry-run) " : ""}對 ${count} 位有未完成任務的人推送提醒`);
  res.json({ ok: true, dryRun, count, results });
});

// 把任務以「bot 身分」發到該專案對應的討論群頻道，並 tag 負責人
app.post("/api/tasks/:id/notify", async (req, res) => {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return res.status(400).json({ error: "尚未設定 DISCORD_TOKEN（.env）" });

  const db = read();
  const t = db.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "找不到任務" });

  // 依專案找推送目標頻道（優先工作提醒看板）
  const project = t.project || "未分類";
  const channelId = resolveChannelId(project);
  if (!channelId) {
    return res.status(400).json({ error: `專案「${project}」沒有可推送的頻道（請先建立工作提醒看板，或在 config.json 設定 projectChannels）` });
  }

  const member = db.members.find((m) => m.id === t.assigneeId);
  const isSnowflake = t.assigneeId && /^\d{17,20}$/.test(t.assigneeId);
  const who = isSnowflake ? `<@${t.assigneeId}>` : member ? `**${member.name}**` : "（未分配）";

  const content =
    `📌 【${project}】任務指派 → ${who}\n` +
    `**${t.title}**\n` +
    (t.description ? `${t.description}\n` : "") +
    `狀態：${STATUS_LABEL[t.status] || t.status}\n` +
    `🔗 看板：${boardUrl()}`;

  try {
    await deletePrevForPerson(channelId, t.assigneeId);
    const msg = await sendToChannel(channelId, content);
    recordForPerson(channelId, t.assigneeId, msg.id);
    res.json({ ok: true, tagged: isSnowflake, channelId, project });
  } catch (e) {
    res.status(502).json({ error: `推送失敗：${e.message}` });
  }
});

// 上傳圖片（貼上複製的圖片時呼叫），回傳可存取的網址
app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "沒有檔案" });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// 手動新增/編輯成員（沒有用 bot 同步時也能用）
app.post("/api/members", (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "名稱必填" });
  const db = read();
  const member = { id: crypto.randomUUID(), name: name.trim(), username: "", avatar: "" };
  db.members.push(member);
  write(db);
  res.json(member);
});

// 自動封存：完成（done）超過 3 天的任務 → 移到「已封存」(archived)，保留可反查、不刪除
const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
function archiveOldDone() {
  const db = read();
  const cutoff = Date.now() - ARCHIVE_AFTER_MS;
  let n = 0;
  for (const t of db.tasks) {
    if (t.status !== "done") continue;
    const ts = Date.parse(t.completedAt || t.updatedAt || "");
    if (!isNaN(ts) && ts <= cutoff) { t.status = "archived"; n++; }
  }
  if (n) { write(db); console.log(`自動封存 ${n} 筆（完成超過 3 天）`); }
  return n;
}
setInterval(archiveOldDone, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`內部任務看板已啟動：http://localhost:${PORT}`);
  archiveOldDone();
});
