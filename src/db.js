// 極簡 JSON 資料庫：成員與任務都存在 data/db.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ members: [], tasks: [] }, null, 2));
  }
}

export function read() {
  ensure();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

export function write(db) {
  ensure();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
