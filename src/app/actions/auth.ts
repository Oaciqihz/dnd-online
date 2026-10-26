"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { endSession, startSession } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import type { AuthState } from "@/lib/form-state";

const usernameSchema = z
  .string()
  .trim()
  .min(3, "用户名至少 3 个字符")
  .max(16, "用户名最多 16 个字符")
  .regex(/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/, "只能使用中文、字母、数字和下划线");

const passwordSchema = z
  .string()
  .min(8, "密码至少 8 位")
  .max(64, "密码最多 64 位");

const registerSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    message: "两次输入的密码不一致",
    path: ["confirm"],
  });

const loginSchema = z.object({
  username: z.string().trim().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码"),
});

const guestSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(1, "先给自己取个名字")
    .max(16, "昵称最多 16 个字符"),
});

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "请检查输入内容";
}

export async function registerAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = registerSchema.safeParse({
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirm: String(formData.get("confirm") ?? ""),
  });

  if (!parsed.success) {
    return { error: firstIssue(parsed.error) };
  }

  const username = parsed.data.username;

  // 先查一次给友好提示；真正的唯一性由数据库 UNIQUE 约束兜底
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (existing.length > 0) {
    return { error: "这个用户名已经被注册了" };
  }

  const id = randomUUID();

  await db.insert(users).values({
    id,
    kind: "member",
    username,
    displayName: username,
    passwordHash: await hashPassword(parsed.data.password),
    createdAt: Date.now(),
  });

  await startSession(id);
  redirect("/lobby");
}

export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = loginSchema.safeParse({
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
  });

  if (!parsed.success) {
    return { error: firstIssue(parsed.error) };
  }

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, parsed.data.username))
    .limit(1);

  const user = rows[0];

  // 用户不存在和密码错误返回同一句话，避免暴露哪些用户名已被注册
  const rejected: AuthState = { error: "用户名或密码不正确" };

  if (!user || !user.passwordHash) {
    return rejected;
  }

  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) {
    return rejected;
  }

  await startSession(user.id);
  redirect("/lobby");
}

export async function guestAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = guestSchema.safeParse({
    nickname: String(formData.get("nickname") ?? ""),
  });

  if (!parsed.success) {
    return { error: firstIssue(parsed.error) };
  }

  const id = randomUUID();

  await db.insert(users).values({
    id,
    kind: "guest",
    username: null,
    displayName: parsed.data.nickname,
    passwordHash: null,
    createdAt: Date.now(),
  });

  await startSession(id);
  redirect("/lobby");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/");
}
