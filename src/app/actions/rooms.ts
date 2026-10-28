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
  setMemberReady,
  setRoomPhase,
  setRoomScene,
} from "@/lib/rooms";
import { notifyRoomKick, notifyRoomRefresh } from "@/lib/socket-notify";
import { getMediaStore } from "@/lib/media/storage";
import type {
  KickActionState,
  ReadyActionResult,
  RoomFormState,
  RoomPhaseActionResult,
  SceneActionResult,
} from "@/lib/form-state";
import type { RoomPhase } from "@/lib/protocol";

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

const phaseSchema = z.object({
  code: z.string().min(1),
  phase: z.enum(["preparing", "playing", "ended"]),
});

/**
 * 推进房间阶段。开始、结束、退回准备共用一个 action，
 * 只传目标阶段 —— 权限和允许的流转都由 rooms.ts 里的 setRoomPhase 判断，
 * 客户端不可能是「绕过 UI 就拿到额外能力」。
 */
export async function setRoomPhaseAction(input: {
  code: string;
  phase: RoomPhase;
}): Promise<RoomPhaseActionResult> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const parsed = phaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "参数不对" };

  const code = normalizeRoomCode(parsed.data.code);
  const result = await setRoomPhase(user.id, code, parsed.data.phase);

  if (!result.ok) return { ok: false, error: result.error };

  // 数据库已经改了，广播只是让别人立刻看到。这一步失败不回滚。
  await notifyRoomRefresh(code);
  revalidatePath(`/rooms/${code}`);

  return { ok: true, phase: result.phase };
}

const readySchema = z.object({
  code: z.string().min(1),
  ready: z.boolean(),
});

/**
 * 玩家切换「我准备好了」。
 *
 * 这个动作刻意不触发 revalidatePath —— 它只影响一个布尔值，
 * 靠实时广播同步就够，走一次服务端渲染反而会打断别人正在输入的聊天框。
 */
export async function toggleReadyAction(input: {
  code: string;
  ready: boolean;
}): Promise<ReadyActionResult> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const parsed = readySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "参数不对" };

  const code = normalizeRoomCode(parsed.data.code);
  const result = await setMemberReady(user.id, code, parsed.data.ready);

  if (!result.ok) return { ok: false, error: result.error };

  await notifyRoomRefresh(code);

  return { ok: true, ready: result.ready };
}

const sceneSchema = z.object({
  code: z.string().min(1),
  /**
   * builtin = 切回内置渐变（会清掉地图）；upload = 用已上传的地图。
   * 这里放宽成 z.string() 而不是 z.enum()，是为了让「传了个乱七八糟的值」
   * 走到 lib 层得到一句人话的错误，而不是 zod 的英文报错。
   * 真正的白名单在 setRoomScene 里。
   */
  source: z.string().min(1),
  backgroundKey: z.string().min(1),
  fit: z.string().min(1),
  caption: z.string().max(200),
});

/**
 * DM 换场景。
 *
 * 写库之后通知 Socket 进程重播一次 room:state —— 背景 key、图片地址、
 * 填充方式、场景描述全在那条广播里，所以不需要新的内部接口，
 * 也不用知道房间里都有谁。
 *
 * 注意这个 action **不接受图片地址**。地图只能通过
 * /api/rooms/[code]/scene 上传进来，那条路会做解码和体积校验。
 * 如果这里允许传 image，就等于开了一个「绕过校验直接写库」的后门。
 */
export async function setSceneAction(input: {
  code: string;
  source: "builtin" | "upload";
  backgroundKey: string;
  fit: "cover" | "contain";
  caption: string;
}): Promise<SceneActionResult> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const parsed = sceneSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "参数不对" };

  const code = normalizeRoomCode(parsed.data.code);
  const result = await setRoomScene(user.id, code, {
    source: parsed.data.source === "upload" ? "upload" : "builtin",
    backgroundKey: parsed.data.backgroundKey,
    fit: parsed.data.fit,
    caption: parsed.data.caption,
  });

  if (!result.ok) return { ok: false, error: result.error };

  // 切换来源时会有旧图被丢弃，文件要跟着删掉。
  // 放在 action 里而不是 lib 里，是因为 lib/rooms 也被 Socket 进程引用，
  // 不该让它连带依赖文件系统。
  if (result.removedImage) {
    await getMediaStore().remove(result.removedImage);
  }

  await notifyRoomRefresh(code);
  revalidatePath(`/rooms/${code}`);

  return {
    ok: true,
    backgroundKey: result.backgroundKey,
    backgroundImage: result.backgroundImage,
    backgroundFit: result.backgroundFit,
    sceneCaption: result.sceneCaption,
  };
}
