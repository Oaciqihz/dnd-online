import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "./db";
import { sessions, users } from "./schema";

/**
 * 这个文件刻意不 import 任何 next/* 模块，
 * 因为 Socket.IO 跑在独立的 Node 进程里（没有 Next 运行时），
 * 它需要复用同一套会话校验逻辑。
 */

export const SESSION_COOKIE = "dnd_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

export type SessionUser = {
  id: string;
  kind: "guest" | "member";
  displayName: string;
  username: string | null;
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueSessionToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();

  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });

  return token;
}

export async function findUserByToken(token: string): Promise<SessionUser | null> {
  const rows = await db
    .select({
      id: users.id,
      kind: users.kind,
      displayName: users.displayName,
      username: users.username,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, Date.now()),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function revokeSessionToken(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
