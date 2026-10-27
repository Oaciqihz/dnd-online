"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  createRoom,
  joinRoom,
  kickMember,
  leaveRoom,
  normalizeRoomCode,
} from "@/lib/rooms";
import { notifyRoomKick } from "@/lib/socket-notify";
import type { KickActionState, RoomFormState } from "@/lib/form-state";

const createRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "给房间取个名字")
    .max(24, "房间名最多 24 个字符"),
});

export async function createRoomAction(
  _prev: RoomFormState,
  formData: FormData,
): Promise<RoomFormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const parsed = createRoomSchema.safeParse({
    name: String(formData.get("name") ?? ""),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "请检查输入" };
  }

  const room = await createRoom(user.id, parsed.data.name);
  redirect(`/rooms/${room.code}`);
}

export async function joinRoomAction(
  _prev: RoomFormState,
  formData: FormData,
): Promise<RoomFormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const result = await joinRoom(user.id, String(formData.get("code") ?? ""));

  if (!result.ok) {
    return { error: result.error };
  }

  redirect(`/rooms/${result.room.code}`);
}

/**
 * 房间页里「加入这个房间」按钮用的简单 action。
 * 直接拿表单里的 code，失败就带着错误信息回大厅。
 */
export async function joinRoomByCodeAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const code = normalizeRoomCode(String(formData.get("code") ?? ""));
  const result = await joinRoom(user.id, code);

  if (!result.ok) {
    redirect(`/lobby?joinError=${encodeURIComponent(result.error)}`);
  }

  redirect(`/rooms/${result.room.code}`);
}

export async function leaveRoomAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const code = normalizeRoomCode(String(formData.get("code") ?? ""));
  await leaveRoom(user.id, code);

  redirect("/lobby");
}

const kickSchema = z.object({
  code: z.string().min(1),
  userId: z.string().min(1),
});

/**
 * DM 把某个成员移出房间。
 *
 * 顺序很重要：先删数据库（唯一事实来源），再通知 Socket 进程赶人。
 * 反过来的话，万一删库失败，对方已经被踢下线却还在成员名单里，局面更乱。
 */
export async function kickMemberAction(input: {
  code: string;
  userId: string;
}): Promise<KickActionState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const parsed = kickSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "参数不对" };
  }

  const code = normalizeRoomCode(parsed.data.code);
  const result = await kickMember(user.id, code, parsed.data.userId);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  await notifyRoomKick(code, parsed.data.userId);
  revalidatePath(`/rooms/${code}`);

  return { ok: true };
}
