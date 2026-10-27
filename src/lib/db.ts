import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const DB_FILE = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "./data/app.db",
);

/**
 * 建表语句。第一阶段先这样跑，等进入第二阶段会换成正式的 migration 文件。
 * 用 IF NOT EXISTS，所以每次启动都可以安全执行。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'guest' CHECK (kind IN ('guest', 'member')),
  username TEXT UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rooms_host_idx ON rooms(host_id);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('dm', 'player')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members(user_id);
`;

function createDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  const sqlite = new Database(DB_FILE);
  // WAL 让读写不互相阻塞；Next 进程和 Socket 进程会同时打开这个文件
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);

  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;

// 开发模式下热更新会反复执行模块，用 globalThis 缓存避免打开一堆连接
const globalForDb = globalThis as unknown as { __dndDb?: Db };

export const db: Db = globalForDb.__dndDb ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__dndDb = db;
}

export { schema };
