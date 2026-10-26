import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

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

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
