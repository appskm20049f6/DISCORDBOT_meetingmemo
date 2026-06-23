// 各工作群組的「工作提醒看板」：在分類底下建一個頻道、發一則會自動更新的看板訊息
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { ChannelType } from "discord.js";
import { ROOT, read } from "./db.js";

const BOARDS_PATH = path.join(ROOT, "data", "boards.json");
const readBoards = () => (fs.existsSync(BOARDS_PATH) ? JSON.parse(fs.readFileSync(BOARDS_PATH, "utf-8")) : {});
const writeBoards = (s) => {
  fs.mkdirSync(path.dirname(BOARDS_PATH), { recursive: true });
  fs.writeFileSync(BOARDS_PATH, JSON.stringify(s, null, 2));
};
const boardUrl = () => process.env.BOARD_URL || "http://localhost:3000";
// 依日期排序：有日期的越近越前面，沒日期的排最後（以結束/期限為準，沒有就用開始）
const dueKey = (t) => t.dueDate || t.startDate || "9999-12-31";
const byDue = (a, b) => dueKey(a).localeCompare(dueKey(b));
const REC_LABEL = { once: "", daily: "每日", weekly: "每週" };
const dateLabel = (t) => (t.startDate && t.dueDate ? `${t.startDate}~${t.dueDate}` : (t.dueDate || t.startDate || ""));
const recLabel = (t) => (t.recurrence && t.recurrence !== "once" ? ` 🔁${REC_LABEL[t.recurrence] || ""}` : "");
const taskLine = (t, nameOf) => {
  const n = nameOf(t.assigneeId);
  const dl = dateLabel(t);
  return `• ${t.title}${dl ? ` 📅 ${dl}` : ""}${recLabel(t)}${n ? ` — ${n}` : "（未分配）"}`;
};

// 組看板內容（依專案，從 data/db.json 取任務）
function buildContent(project, db) {
  const tasks = db.tasks.filter((t) => (t.project || "未分類") === project);
  const grp = { todo: [], doing: [], done: [] };
  for (const t of tasks) (grp[t.status] || grp.todo).push(t);
  grp.doing.sort(byDue);
  grp.todo.sort(byDue);
  const nameOf = (id) => db.members.find((m) => m.id === id)?.name || null;
  const line = (t) => taskLine(t, nameOf);
  const L = [];
  L.push(`📌 **工作提醒看板** ｜ ${project}`);
  L.push(`_更新：${new Date().toLocaleString("zh-TW", { hour12: false })}_`);
  L.push("");
  L.push(`🟦 **進行中（${grp.doing.length}）**`);
  L.push(...(grp.doing.length ? grp.doing.map(line) : ["（無）"]));
  L.push("");
  L.push(`⬜ **尚未開始（${grp.todo.length}）**`);
  L.push(...(grp.todo.length ? grp.todo.map(line) : ["（無）"]));
  L.push("");
  L.push(`✅ 已完成：${grp.done.length} 項`);
  L.push("");
  L.push(`🔗 完整看板（可分配/回報）：${boardUrl()}`);
  let content = L.join("\n");
  if (content.length > 1990) content = content.slice(0, 1985) + "…";
  return content;
}

// 組多專案共用看板內容（一則訊息涵蓋多個專案，每行標出所屬專案）
function buildContentMulti(title, projects, db) {
  const set = new Set(projects);
  const nameOf = (id) => db.members.find((m) => m.id === id)?.name || null;
  const line = (t) => `${taskLine(t, nameOf)} ｜${t.project || "未分類"}`;
  const mine = db.tasks.filter((t) => set.has(t.project || "未分類"));
  const doing = mine.filter((t) => t.status === "doing").sort(byDue);
  const todo = mine.filter((t) => t.status === "todo").sort(byDue);
  const doneCount = mine.filter((t) => t.status === "done").length;
  const L = [];
  L.push(`📌 **工作提醒看板** ｜ ${title}`);
  L.push(`_更新：${new Date().toLocaleString("zh-TW", { hour12: false })}_`);
  L.push("");
  L.push(`🟦 **進行中（${doing.length}）**`);
  L.push(...(doing.length ? doing.map(line) : ["（無）"]));
  L.push("");
  L.push(`⬜ **尚未開始（${todo.length}）**`);
  L.push(...(todo.length ? todo.map(line) : ["（無）"]));
  L.push("");
  L.push(`✅ 已完成：${doneCount} 項`);
  L.push("");
  L.push(`🔗 完整看板（可分配/回報）：${boardUrl()}`);
  let content = L.join("\n");
  if (content.length > 1990) content = content.slice(0, 1985) + "…";
  return content;
}

// 依看板記錄組內容（單一專案或多專案共用）
function contentFor(b, db) {
  if (b.projects && b.projects.length) return buildContentMulti(b.title || b.projects.join("/"), b.projects, db);
  return buildContent(b.project || (b.projects && b.projects[0]) || "未分類", db);
}

// 建立/沿用各群組的看板頻道與訊息（首次設定用）
export async function setupBoards(client, config, onlyCategoryIds = null) {
  const channelName = config.reminderBoards?.channelName || "工作提醒";
  let groups = config.reminderBoards?.groups || [];
  if (onlyCategoryIds && onlyCategoryIds.length) {
    const set = new Set(onlyCategoryIds.map(String));
    groups = groups.filter((g) => set.has(String(g.categoryId)));
  }
  if (groups.length === 0) {
    console.log("⚠ config.json 的 reminderBoards.groups 是空的。");
    return;
  }
  const guild = await client.guilds.fetch(String(config.guildId));
  const db = read();
  const boardState = readBoards();

  for (const g of groups) {
    const catId = String(g.categoryId);
    const channels = await guild.channels.fetch();
    let ch = [...channels.values()].find(
      (c) => c && c.parentId === catId && c.name === channelName && c.isTextBased?.()
    );
    if (!ch) {
      ch = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: catId,
        topic: `自動工作提醒看板（${g.project}）— 由 bot 維護`,
      });
      console.log(`  ＋建立 #${channelName} 於「${g.project}」`);
    } else {
      console.log(`  已存在 #${channelName}（${g.project}），沿用`);
    }

    const content = buildContent(g.project, db);
    let msg = null;
    const prev = boardState[catId];
    if (prev && prev.channelId === ch.id) {
      try {
        const old = await ch.messages.fetch(prev.messageId);
        await old.edit(content);
        msg = old;
      } catch {
        msg = await ch.send(content);
      }
    } else {
      msg = await ch.send(content);
    }
    try { await msg.pin(); } catch { /* 已釘選或無權限就略過 */ }
    boardState[catId] = { channelId: ch.id, messageId: msg.id, project: g.project };
  }
  writeBoards(boardState);
  console.log(`== 看板設定完成，共 ${groups.length} 個群組 ==`);
}

// 虛擬看板：為沒有專屬分類/討論群的專案，在指定的現有頻道上放一則會自動更新的看板訊息
// 一則訊息可涵蓋多個專案（projects 陣列），共用同一則
export async function setupVirtualBoards(client, config) {
  const items = config.virtualBoards || [];
  const db = read();
  const boardState = readBoards();
  const newKeys = new Set();

  for (const item of items) {
    const cid = String(item.channelId);
    const projects = item.projects && item.projects.length ? item.projects : (item.project ? [item.project] : []);
    if (!projects.length) continue;
    const title = item.title || projects.join("/");
    const key = "virtual:" + (item.title || projects.join(","));
    newKeys.add(key);
    let ch;
    try { ch = await client.channels.fetch(cid); }
    catch (e) { console.log(`  [略過] 找不到頻道 ${cid}：${e.message}`); continue; }
    const content = contentFor({ projects, title }, db);
    let msg = null;
    const prev = boardState[key];
    if (prev && prev.channelId === cid) {
      try { const old = await ch.messages.fetch(prev.messageId); await old.edit(content); msg = old; }
      catch { msg = await ch.send(content); }
    } else {
      msg = await ch.send(content);
    }
    try { await msg.pin(); } catch { /* 已釘或無權限略過 */ }
    boardState[key] = { channelId: cid, messageId: msg.id, projects, title };
    console.log(`  虛擬看板：「${title}」(${projects.join("、")}) → 頻道 ${cid}`);
  }

  // 清掉已不在設定中的舊虛擬看板（例如先前單獨的「未分類」訊息）
  for (const k of Object.keys(boardState)) {
    if (k.startsWith("virtual:") && !newKeys.has(k)) {
      const b = boardState[k];
      try { const ch = await client.channels.fetch(b.channelId); const m = await ch.messages.fetch(b.messageId); await m.delete(); } catch { /* 略過 */ }
      delete boardState[k];
      console.log(`  移除舊虛擬看板：${k}`);
    }
  }
  writeBoards(boardState);
  console.log("== 虛擬看板設定完成 ==");
}

const NOTIFYLOG_PATH = path.join(ROOT, "data", "notifylog.json");
const readNotifyLog = () => (fs.existsSync(NOTIFYLOG_PATH) ? JSON.parse(fs.readFileSync(NOTIFYLOG_PATH, "utf-8")) : {});

// 清理各「工作提醒」頻道：只保留「看板訊息」與「未完成任務清單提醒」，其餘訊息一律刪除
// dryRun=true 只回報會刪幾則、不真的刪
export async function cleanupBoardChannels(client, dryRun = false) {
  const boardState = readBoards();
  const notifylog = readNotifyLog();
  // channelId -> 要保留的訊息 id 集合（看板 + 該頻道的提醒）
  const keep = {};
  for (const b of Object.values(boardState)) {
    (keep[b.channelId] = keep[b.channelId] || new Set()).add(b.messageId);
  }
  for (const [k, mid] of Object.entries(notifylog)) {
    const cid = k.split(":")[0];
    if (keep[cid]) keep[cid].add(mid); // 只清理「有看板」的頻道
  }
  let deleted = 0;
  for (const [cid, keepSet] of Object.entries(keep)) {
    try {
      const ch = await client.channels.fetch(cid);
      const msgs = await ch.messages.fetch({ limit: 100 });
      const toDelete = [...msgs.values()].filter((m) => !keepSet.has(m.id));
      if (toDelete.length === 0) continue;
      if (dryRun) { deleted += toDelete.length; continue; }
      try {
        await ch.bulkDelete(toDelete, true); // 14 天內可批次刪；較舊的會被略過
      } catch {
        for (const m of toDelete) { try { await m.delete(); } catch { /* 略過 */ } }
      }
      deleted += toDelete.length;
    } catch (e) {
      console.log(`  [清理略過] 頻道 ${cid}：${e.message}`);
    }
  }
  console.log(`  ${dryRun ? "(乾跑) " : ""}清理工作提醒頻道：${deleted} 則非看板/提醒訊息`);
  return deleted;
}

// 更新所有已建立的看板訊息（定時呼叫）
export async function updateBoards(client) {
  const boardState = readBoards();
  const entries = Object.entries(boardState);
  if (entries.length === 0) return;
  const db = read();
  let ok = 0;
  for (const [, b] of entries) {
    try {
      const ch = await client.channels.fetch(b.channelId);
      const msg = await ch.messages.fetch(b.messageId);
      await msg.edit(contentFor(b, db));
      ok++;
    } catch (e) {
      console.log(`  [看板更新略過] ${b.title || b.project}：${e.message}`);
    }
  }
  console.log(`  看板已更新 ${ok}/${entries.length} 個`);
  // 順便清理各頻道：只留看板與未完成提醒，其餘刪除
  try { await cleanupBoardChannels(client); } catch (e) { console.log("  清理略過：" + e.message); }
}
