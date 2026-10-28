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
  phase TEXT NOT NULL DEFAULT 'preparing' CHECK (phase IN ('preparing', 'playing', 'ended')),
  started_at INTEGER,
  background_key TEXT NOT NULL DEFAULT 'tavern',
  background_image TEXT NOT NULL DEFAULT '',
  background_fit TEXT NOT NULL DEFAULT 'cover',
  scene_caption TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rooms_host_idx ON rooms(host_id);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  class_key TEXT NOT NULL DEFAULT 'fighter',
  class_name TEXT NOT NULL DEFAULT '战士',
  level INTEGER NOT NULL DEFAULT 1,
  ancestry TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  alignment TEXT NOT NULL DEFAULT '',
  str INTEGER NOT NULL DEFAULT 10,
  dex INTEGER NOT NULL DEFAULT 10,
  con INTEGER NOT NULL DEFAULT 10,
  int INTEGER NOT NULL DEFAULT 10,
  wis INTEGER NOT NULL DEFAULT 10,
  cha INTEGER NOT NULL DEFAULT 10,
  skills TEXT NOT NULL DEFAULT '[]',
  saves TEXT NOT NULL DEFAULT '[]',
  current_hp INTEGER NOT NULL DEFAULT 0,
  temp_hp INTEGER NOT NULL DEFAULT 0,
  hp_bonus INTEGER NOT NULL DEFAULT 0,
  ac_override INTEGER,
  equipment TEXT NOT NULL DEFAULT '',
  spells TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '',
  backstory TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  portrait TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS characters_owner_idx ON characters(owner_id);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('dm', 'player')),
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members(user_id);

CREATE TABLE IF NOT EXISTS room_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  payload TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS room_messages_room_idx ON room_messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS room_rolls (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  check_key TEXT NOT NULL DEFAULT '',
  dice TEXT NOT NULL,
  raw_rolls TEXT NOT NULL DEFAULT '[]',
  picked INTEGER NOT NULL DEFAULT 0,
  picked_value INTEGER NOT NULL DEFAULT 0,
  modifier INTEGER NOT NULL DEFAULT 0,
  modifier_parts TEXT NOT NULL DEFAULT '[]',
  total INTEGER NOT NULL,
  dc INTEGER,
  outcome TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS room_rolls_room_idx ON room_rolls(room_id, created_at);
`;

/**
 * 给已存在的表补列。
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，
 * 重复执行会直接报错。所以先查 PRAGMA 再决定要不要加 ——
 * 这样老数据库（已经有人玩过的那个）升级时不会炸，新库也是同一条路径。
 */
function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;

  if (columns.some((item) => item.name === column)) return;

  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * 建立连接。
 *
 * 连接必须复用：dev 模式下每次热更新都 new 一个连接会漏文件句柄，
 * 而且 SQLite 在 WAL 下每个连接都持有一份读快照。
 */
function openSqlite(): Database.Database {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  const sqlite = new Database(DB_FILE);
  // WAL 让读写不互相阻塞；Next 进程和 Socket 进程会同时打开这个文件
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  return sqlite;
}

/**
 * 建表 + 补列。
 *
 * **这个函数每次模块加载都会执行，不跟着连接一起缓存。**
 *
 * 原因是很实际的一条：dev 模式下改了加列的代码，热更新只会重新执行模块，
 * 而 db 实例挂在 globalThis 上不会重建。如果迁移绑在「创建实例」里，
 * 新加的列就永远补不上 —— 代码明明写了 background_image，
 * 运行时却一直报 "no such column"，只能靠手动重启进程解决。
 * 这种「改了没生效」的故障排查起来最费时间，所以宁可每次多跑几条 PRAGMA。
 *
 * 重复执行是安全的：DDL 全是 IF NOT EXISTS，ensureColumn 先查 PRAGMA 再决定。
 */
function migrate(sqlite: Database.Database): void {
  sqlite.exec(DDL);

  // 角色卡是后加的功能，老库里 room_members 没有这一列，这里补上
  ensureColumn(
    sqlite,
    "room_members",
    "character_id",
    "TEXT REFERENCES characters(id) ON DELETE SET NULL",
  );

  // 房间阶段也是后加的。老库里 rooms 还有一列 status（open/closed），
  // 它从来没被任何代码读过，这里不再使用它，但也不去删 ——
  // 它带着 CHECK 约束，SQLite 删列可能失败，留着不占空间也不影响读写。
  ensureColumn(sqlite, "rooms", "phase", "TEXT NOT NULL DEFAULT 'preparing'");
  ensureColumn(sqlite, "rooms", "started_at", "INTEGER");
  ensureColumn(sqlite, "room_members", "ready", "INTEGER NOT NULL DEFAULT 0");

  // 舞台背景也是后加的
  ensureColumn(sqlite, "rooms", "background_key", "TEXT NOT NULL DEFAULT 'tavern'");
  ensureColumn(sqlite, "rooms", "scene_caption", "TEXT NOT NULL DEFAULT ''");

  // DM 上传的舞台地图，以及它是填满还是完整显示
  ensureColumn(sqlite, "rooms", "background_image", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(sqlite, "rooms", "background_fit", "TEXT NOT NULL DEFAULT 'cover'");

  // 舞台形象。
  //
  // 老库里没有这一列，这里补上，默认 '{}' —— 读取时 parsePortrait 会拿角色名
  // 当种子现场生成一张脸，所以老角色不会因为「没有形象」而变成空白棋子。
  //
  // 注意不去动旧的 look 列：它是上一版分层拼装方案的遗留，
  // 里面存的是五轴枚举，和 portrait 的语义完全不同，迁移过来只会产生
  // 一批「看起来有值、实际上全是非法字段」的数据。留着不动更安全。
  ensureColumn(sqlite, "characters", "portrait", "TEXT NOT NULL DEFAULT '{}'");

  // 掷骰事件进入聊天时间线之后，room_messages 要区分「人说的话」和「系统事件」。
  // 老库里的消息全是聊天，默认值 'chat' / '' 正好对上，不需要回填。
  ensureColumn(sqlite, "room_messages", "kind", "TEXT NOT NULL DEFAULT 'chat'");
  ensureColumn(sqlite, "room_messages", "payload", "TEXT NOT NULL DEFAULT ''");
}

function createDb(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;

// 开发模式下热更新会反复执行模块，用 globalThis 缓存避免打开一堆连接
const globalForDb = globalThis as unknown as {
  __dndDb?: Db;
  __dndSqlite?: Database.Database;
};

const sqlite = (globalForDb.__dndSqlite ??= openSqlite());

// 每次模块加载都跑，理由见上面 migrate 的注释
migrate(sqlite);

export const db: Db = globalForDb.__dndDb ?? createDb(sqlite);

if (process.env.NODE_ENV !== "production") {
  globalForDb.__dndDb = db;
}

export { schema };
