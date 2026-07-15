// PM2 設定 — 本專案專用，app 名稱以 memo- 開頭，避免與其他專案（metagooglead-*）衝突
module.exports = {
  apps: [
    {
      name: "memo-web", // 內部任務看板網頁
      script: "src/server.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 1000, // 幾乎不放棄，偶發崩潰也會被拉回來
      restart_delay: 3000, // 崩潰後等 3 秒再重啟
      exp_backoff_restart_delay: 500, // 連續崩潰時遞增延遲，避免狂churn
      time: true,
    },
    {
      name: "memo-bot", // Discord 常駐收集 + 看板自動更新 + 定時提醒
      script: "src/bot.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 1000,
      restart_delay: 3000,
      exp_backoff_restart_delay: 500,
      time: true,
    },
  ],
};
