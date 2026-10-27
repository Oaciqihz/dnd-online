import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/**
 * 游客和注册用户共用一张表：
 * - kind = "guest"      -> 没有 username / passwordHash
 * - kind = "member"     -> 有 username / passwordHash
 * 这样后面做“游客升级成正式账号”只需要补字段，不用迁移数据。
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["guest", "member"] })
    .notNull()
    .default("guest"),
  username: text("username").unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash"),
  createdAt: integer("created_at").notNull(),
});

/**
 * 会话表。数据库里只存 token 的 SHA-256，不存明文。
 * 这样即使数据库泄露，攻击者也无法直接拿里面的值伪造登录。
 */
export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/**
 * 房间。code 是给玩家口头传播用的短码（6 位，去掉了易混淆字符），
 * 唯一约束保证不会撞车。
 */
export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("rooms_host_idx").on(table.hostId)],
);

/**
 * 房间成员。用 (roomId, userId) 做联合主键，
 * 数据库层面就保证了同一个人不会在同一个房间里出现两次
 * —— 重复加入用 onConflictDoNothing 天然幂等。
 */
export const roomMembers = sqliteTable(
  "room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["dm", "player"] })
      .notNull()
      .default("player"),
    joinedAt: integer("joined_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.userId] }),
    index("room_members_user_idx").on(table.userId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;
