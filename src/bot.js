/**
 * Discord 版塊文字收集 Bot（discord.js）
 * ------------------------------------------------
 *  - 從 config.json 指定的各「版塊（頻道）」撈新訊息，輸出成 Markdown
 *  - state.json 記住每個頻道上次撈到的位置，避免重複
 *  - 也可把 DC 群成員同步到看板（給網頁分配任務用）
 *
 * 用法：
 *   node src/bot.js --once            撈一次就結束（建議搭配 Windows 工作排程器一天兩次）
 *   node src/bot.js                    常駐，依 config.schedule_times 每天定時執行
 *   node src/bot.js --list-channels    列出可見頻道 ID（填 config 用）
 *   node src/bot.js --sync-members     把 guild 成員同步到看板 data/db.json
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { ROOT, read, write } from "./db.js";
import { setupBoards, updateBoards, setupVirtualBoards, cleanupBoardChannels } from "./boards.js";

const CONFIG_PATH = path.join(ROOT, "config.json");
const STATE_PATH = path.join(ROOT, "state.json");

const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const loadState = () => (fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) : {});
const saveState = (s) => fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

function makeClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // 需在 Developer Portal 開啟 Message Content Intent
      GatewayIntentBits.GuildMembers, // 同步成員用，需開啟 Server Members Intent
    ],
    partials: [Partials.Channel],
  });
}

const sanitize = (s) => String(s).replace(/[^\p{L}\p{N}\-_]/gu, "_");

// 抓單一頻道：自上次位置後的新訊息（分頁，每次最多 100）
async function fetchNewMessages(channel, afterId, maxTotal) {
  const collected = [];
  let after = afterId || "0";
  while (collected.length < maxTotal) {
    const batch = await channel.messages.fetch({ limit: 100, after });
    if (batch.size === 0) break;
    // fetch 回傳由新到舊；轉成陣列並依時間由舊到新
    const arr = [...batch.values()].sort((a, b) => Number(a.id) - Number(b.id));
    collected.push(...arr);
    after = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }
  return collected.slice(0, maxTotal);
}

// 從最新往回撈，只取最近 sinceDays 天內的訊息
async function fetchRecentMessages(channel, sinceDays) {
  const cutoff = Date.now() - sinceDays * 86400000;
  const collected = [];
  let before; // 第一次不帶 before = 最新
  while (true) {
    const opts = { limit: 100 };
    if (before) opts.before = before;
    const batch = await channel.messages.fetch(opts);
    if (batch.size === 0) break;
    const arr = [...batch.values()].sort((a, b) => Number(b.id) - Number(a.id)); // 新→舊
    for (const m of arr) {
      if (m.createdTimestamp >= cutoff) collected.push(m);
    }
    const oldest = arr[arr.length - 1];
    before = oldest.id;
    if (oldest.createdTimestamp < cutoff || batch.size < 100) break;
  }
  return collected.sort((a, b) => Number(a.id) - Number(b.id)); // 輸出用 舊→新
}

// 寫出 Markdown（共用）
function writeMarkdown(config, label, channelId, messages, suffix = "") {
  const now = new Date();
  const dateStr = now.toLocaleDateString("sv-SE");
  const hm = now.toTimeString().slice(0, 5).replace(":", "");
  const outDir = path.join(ROOT, config.output_dir || "output", dateStr);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${hm}_${sanitize(label)}${suffix}.md`);
  const lines = [
    `# 版塊：${label}`,
    `- 頻道 ID：${channelId}`,
    `- 收集時間：${now.toLocaleString("zh-TW")}`,
    `- 訊息數：${messages.length}`,
    "",
    "---",
    "",
  ];
  for (const m of messages) {
    const ts = m.createdAt.toLocaleString("zh-TW", { hour12: false });
    const author = m.member?.displayName || m.author?.username || "未知";
    lines.push(`### [${ts}] ${author}`);
    if (m.content?.trim()) lines.push(m.content.trim());
    for (const att of m.attachments.values()) lines.push(`📎 附件：${att.name} — ${att.url}`);
    for (const emb of m.embeds) if (emb.title) lines.push(`🔗 嵌入：${emb.title}`);
    lines.push("");
  }
  fs.writeFileSync(outPath, lines.join("\n"));
  return outPath;
}

// 近 N 天收集（不更新 state，純臨時撈）
async function collectRecent(client, chConf, config, days) {
  const channelId = String(chConf.id);
  const label = chConf.label || channelId;
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (e) {
    console.log(`  [略過] 找不到頻道 ${label} (${channelId})：${e.message}`);
    return 0;
  }
  if (!channel?.messages) {
    console.log(`  [略過] 非文字頻道：${label}`);
    return 0;
  }
  let messages;
  try {
    messages = await fetchRecentMessages(channel, days);
  } catch (e) {
    console.log(`  [略過] 讀取失敗（多半權限不足）：${label} — ${e.message}`);
    return 0;
  }
  if (messages.length === 0) {
    console.log(`  [${label}] 近 ${days} 天沒有訊息`);
    return 0;
  }
  const out = writeMarkdown(config, label, channelId, messages, `_近${days}天`);
  console.log(`  [${label}] 近 ${days} 天撈到 ${messages.length} 則 → ${path.relative(ROOT, out)}`);
  return messages.length;
}

async function collectChannel(client, chConf, config, state) {
  const channelId = String(chConf.id);
  const label = chConf.label || channelId;

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (e) {
    console.log(`  [略過] 找不到頻道 ${label} (${channelId})：${e.message}`);
    return 0;
  }
  if (!channel || !channel.messages) {
    console.log(`  [略過] 非文字頻道：${label} (${channelId})`);
    return 0;
  }

  let messages;
  try {
    messages = await fetchNewMessages(channel, state[channelId], config.history_limit_per_channel || 1000);
  } catch (e) {
    console.log(`  [略過] 讀取失敗（多半是權限不足）：${label} — ${e.message}`);
    return 0;
  }

  if (messages.length === 0) {
    console.log(`  [${label}] 沒有新訊息`);
    return 0;
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString("sv-SE"); // YYYY-MM-DD
  const hm = now.toTimeString().slice(0, 5).replace(":", "");
  const outDir = path.join(ROOT, config.output_dir || "output", dateStr);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${hm}_${sanitize(label)}.md`);

  const lines = [
    `# 版塊：${label}`,
    `- 頻道 ID：${channelId}`,
    `- 收集時間：${now.toLocaleString("zh-TW")}`,
    `- 訊息數：${messages.length}`,
    "",
    "---",
    "",
  ];
  for (const m of messages) {
    const ts = m.createdAt.toLocaleString("zh-TW", { hour12: false });
    const author = m.member?.displayName || m.author?.username || "未知";
    lines.push(`### [${ts}] ${author}`);
    if (m.content?.trim()) lines.push(m.content.trim());
    for (const att of m.attachments.values()) lines.push(`📎 附件：${att.name} — ${att.url}`);
    for (const emb of m.embeds) if (emb.title) lines.push(`🔗 嵌入：${emb.title}`);
    lines.push("");
  }
  fs.writeFileSync(outPath, lines.join("\n"));

  state[channelId] = messages[messages.length - 1].id;
  console.log(`  [${label}] 撈到 ${messages.length} 則 → ${path.relative(ROOT, outPath)}`);
  return messages.length;
}

async function runCollection(client) {
  const config = loadConfig();
  const state = loadState();
  const channels = (config.channels || []).filter((c) => String(c.id) !== "0");
  if (channels.length === 0) {
    console.log("⚠ config.json 還沒設定任何頻道（channels 為空或 id=0）。");
    return;
  }
  console.log(`== 開始收集 ${new Date().toLocaleString("zh-TW")} ==`);
  let total = 0;
  for (const ch of channels) total += await collectChannel(client, ch, config, state);
  saveState(state);
  console.log(`== 完成，共撈取 ${total} 則訊息 ==`);
}

async function syncMembers(client) {
  const config = loadConfig();
  const guildId = String(config.guildId || "0");
  let guilds = [];
  if (guildId !== "0") {
    guilds = [await client.guilds.fetch(guildId)];
  } else {
    guilds = [...client.guilds.cache.values()];
  }
  const db = read();
  const map = new Map(db.members.map((m) => [m.id, m]));
  let count = 0;
  for (const g of guilds) {
    const guild = g.members ? g : await client.guilds.fetch(g.id);
    const members = await guild.members.fetch();
    for (const m of members.values()) {
      if (m.user.bot) continue;
      map.set(m.id, {
        id: m.id,
        name: m.displayName,
        username: m.user.username,
        avatar: m.user.displayAvatarURL({ size: 64 }),
      });
      count++;
    }
  }
  db.members = [...map.values()];
  write(db);
  console.log(`已同步 ${count} 位成員到看板（data/db.json）。`);
}

// 列出「分類 → 底下的頻道」結構（看工作群組用）
async function listGroups(client) {
  for (const [, guild] of client.guilds.cache) {
    console.log(`\n=== 伺服器：${guild.name} ===`);
    const channels = await guild.channels.fetch();
    const cats = [...channels.values()].filter((c) => c && c.type === 4); // GuildCategory
    cats.sort((a, b) => a.rawPosition - b.rawPosition);
    const noCat = [...channels.values()].filter((c) => c && c.isTextBased?.() && !c.parentId);
    if (noCat.length) {
      console.log("\n[未分類]");
      for (const c of noCat) console.log(`   ${c.id}  #${c.name}`);
    }
    for (const cat of cats) {
      console.log(`\n📂 分類：${cat.name}  (id: ${cat.id})`);
      const kids = [...channels.values()]
        .filter((c) => c && c.parentId === cat.id && c.isTextBased?.())
        .sort((a, b) => a.rawPosition - b.rawPosition);
      for (const c of kids) console.log(`   ${c.id}  #${c.name}`);
    }
  }
}

async function listChannels(client) {
  for (const [, guild] of client.guilds.cache) {
    console.log(`\n伺服器：${guild.name} (id: ${guild.id})`);
    const channels = await guild.channels.fetch();
    for (const ch of channels.values()) {
      if (ch && ch.isTextBased?.()) console.log(`  ${ch.id}  #${ch.name}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const token = process.env.DISCORD_TOKEN;
  if (!token || token === "請填入你的BOT_TOKEN") {
    console.error("錯誤：請先在 .env 設定 DISCORD_TOKEN（可複製 .env.example）");
    process.exit(1);
  }

  const client = makeClient();

  // 常駐排程模式
  if (args.length === 0) {
    const config = loadConfig();
    const times = new Set(config.schedule_times || ["09:00", "18:00"]);
    let lastRunKey = null;
    client.once("ready", async () => {
      console.log(`已登入：${client.user.tag}`);
      console.log(`排程時間：${[...times].sort().join(", ")}（週一~週五 定時提醒未完成任務）。看板每 10 分鐘自動更新。Ctrl+C 結束。`);
      // 啟動時先更新一次看板
      try { await updateBoards(client); } catch (e) { console.error("看板更新錯誤：", e.message); }
      // 每天定時收集
      const PORT = process.env.PORT || 3100;
      setInterval(async () => {
        const now = new Date();
        const hm = now.toTimeString().slice(0, 5);
        const key = now.toLocaleDateString("sv-SE") + " " + hm;
        const dow = now.getDay(); // 0=日,6=六：週末不推送
        if (times.has(hm) && key !== lastRunKey && dow !== 0 && dow !== 6) {
          lastRunKey = key;
          try {
            await updateBoards(client);
            // 定時提醒（模式 B）：對所有有未完成任務的人各推一次，直到完成
            const r = await fetch(`http://localhost:${PORT}/api/remind-all`, { method: "POST" })
              .then((x) => x.json())
              .catch((e) => ({ error: e.message }));
            console.log(`[${hm}] 定時提醒未完成任務：${r.error ? "失敗 " + r.error : "已推 " + r.count + " 人"}`);
          } catch (e) {
            console.error("定時提醒錯誤：", e.message);
          }
        }
      }, 20000);
      // 每 10 分鐘把最新任務狀態同步到各群看板，並就地更新提醒訊息內容（不重新 tag）
      setInterval(async () => {
        try {
          await updateBoards(client);
          await fetch(`http://localhost:${PORT}/api/refresh-reminders`, { method: "POST" }).catch(() => {});
        } catch (e) { console.error("看板更新錯誤：", e.message); }
      }, 600000);
    });
    await client.login(token);
    return;
  }

  // 一次性指令
  client.once("ready", async () => {
    console.log(`已登入：${client.user.tag}`);
    try {
      if (args.includes("--list-groups")) await listGroups(client);
      else if (args.includes("--list-channels")) await listChannels(client);
      else if (args.includes("--setup-boards")) {
        const i = args.indexOf("--setup-boards");
        const onlyIds = args.slice(i + 1).filter((a) => /^\d{17,20}$/.test(a));
        await setupBoards(client, loadConfig(), onlyIds.length ? onlyIds : null);
      }
      else if (args.includes("--setup-virtual-boards")) await setupVirtualBoards(client, loadConfig());
      else if (args.includes("--cleanup-channels")) await cleanupBoardChannels(client, args.includes("--dry"));
      else if (args.includes("--update-boards")) await updateBoards(client);
      else if (args.includes("--sync-members")) await syncMembers(client);
      else if (args.includes("--recent")) {
        // 用法：--recent <天數> [頻道ID ...]；若帶頻道ID只撈那些，否則撈 config 全部
        const i = args.indexOf("--recent");
        const days = Number(args[i + 1]) || 30;
        const ids = args.slice(i + 2).filter((a) => /^\d{17,20}$/.test(a));
        const config = loadConfig();
        let channels;
        if (ids.length) {
          const map = new Map((config.channels || []).map((c) => [String(c.id), c.label]));
          channels = ids.map((id) => ({ id, label: map.get(id) || id }));
        } else {
          channels = (config.channels || []).filter((c) => String(c.id) !== "0");
        }
        console.log(`== 近 ${days} 天收集（${channels.length} 個頻道）==`);
        let total = 0;
        for (const ch of channels) total += await collectRecent(client, ch, config, days);
        console.log(`== 完成，共撈取 ${total} 則訊息 ==`);
      } else if (args.includes("--once")) await runCollection(client);
      else console.log("未知參數。可用：--once / --recent <天數> [頻道ID] / --list-channels / --list-groups / --setup-boards / --update-boards / --sync-members");
    } catch (e) {
      console.error("執行錯誤：", e);
    } finally {
      client.destroy();
    }
  });
  await client.login(token);
}

main();
