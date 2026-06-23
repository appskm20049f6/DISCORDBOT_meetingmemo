// PM2 設定 — 本專案專用，app 名稱以 memo- 開頭，避免與其他專案（metagooglead-*）衝突
const path = require("path");

module.exports = {
  apps: [
    {
      name: "memo-web", // 內部任務看板網頁
      script: "src/server.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
    {
      name: "memo-bot", // Discord 常駐收集 + 看板自動更新
      script: "src/bot.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
