import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  findUserByToken,
  issueSessionToken,
  revokeSessionToken,
  type SessionUser,
} from "./session-store";

export type { SessionUser };

/**
 * 只在 Next 运行时（Server Action / Server Component）里使用。
 * 里面用到 cookies()，所以不能给 Socket.IO 进程用 —— 那边用 session-store.ts。
 */
export async function startSession(userId: string): Promise<void> {
  const token = await issueSessionToken(userId);
  const store = await cookies();

  store.set(SESSION_COOKIE, token, {
    httpOnly: true, // JS 读不到，防 XSS 偷 token
    sameSite: "lax", // 防 CSRF，同时保留正常跳转带 cookie
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    await revokeSessionToken(token);
  }
  store.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (!token) return null;
  return findUserByToken(token);
}
