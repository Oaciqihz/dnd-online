"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  createCharacterDraft,
  deleteCharacter,
  getRoomCharacterId,
  saveCharacter,
  saveCharacterPortrait,
  setCharacterHp,
  setRoomCharacter,
} from "@/lib/characters";
import {
  findRoomCodesUsingCharacter,
  getRoomByCode,
  normalizeRoomCode,
} from "@/lib/rooms";
import { notifyRoomRefresh } from "@/lib/socket-notify";
import { MAX_LEVEL, MIN_LEVEL, type AbilityKey } from "@/lib/rules";
import type {
  CharacterActionResult,
  CharacterFormInput,
} from "@/lib/form-state";

/**
 * 建卡相关动作。
 *
 * 校验策略有意分层：
 * - 向导中途每一步都只做「形状校验」（字段在不在、类型对不对），
 *   名字可以先空着，属性可以先不填满，这样关掉页面回来还能接着填。
 * - 点「完成建卡」时才做真正的完整性校验（必须有名字）。
 * 如果每一步都全量必填，玩家就没法分次填完了。
 */
const abilitiesSchema = z.object({
  str: z.number(),
  dex: z.number(),
  con: z.number(),
  int: z.number(),
  wis: z.number(),
  cha: z.number(),
});

const characterSchema = z.object({
  name: z.string().max(40),
  classKey: z.string().min(1),
  level: z.number().int().min(MIN_LEVEL).max(MAX_LEVEL),
  ancestry: z.string().max(24),
  background: z.string().max(40),
  alignment: z.string().max(24),
  abilities: abilitiesSchema,
  skills: z.array(z.string()).max(20),
  saves: z.array(z.string()).max(6),
  equipment: z.string().max(4000),
  spells: z.string().max(4000),
  features: z.string().max(4000),
  backstory: z.string().max(8000),
  notes: z.string().max(4000),
  hpBonus: z.number().int().min(-20).max(200),
  acOverride: z.number().int().min(1).max(40).nullable(),
});

/** 卡库里点「新建角色」：先落一张空草稿，拿到 id 再进向导 */
export async function createCharacterAction(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const row = await createCharacterDraft(user.id);
  redirect(`/characters/${row.id}`);
}

/**
 * 保存当前这一步。
 *
 * finalize = true 表示「完成建卡」，这时才要求有名字，并把状态改成 ready，
 * 之后这张卡才能被带进房间。
 */
export async function saveCharacterAction(input: {
  id: string;
  data: CharacterFormInput;
  finalize?: boolean;
}): Promise<CharacterActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "登录状态已失效，请重新登录" };

  const parsed = characterSchema.safeParse(input.data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "输入有误" };
  }

  const result = await saveCharacter(
    user.id,
    input.id,
    {
      ...parsed.data,
      // sanitize 里会过滤掉不在技能表里的 key，这里转换是安全的
      saves: parsed.data.saves as AbilityKey[],
    },
    { finalize: input.finalize },
  );

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/characters");
  revalidatePath(`/characters/${input.id}`);

  return { ok: true };
}

export async function deleteCharacterAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const id = String(formData.get("id") ?? "");
  const result = await deleteCharacter(user.id, id);

  if (!result.ok) {
    redirect(`/characters?error=${encodeURIComponent(result.error)}`);
  }

  redirect("/characters");
}

/**
 * 在房间里选择「这一局用哪张卡」。
 *
 * 改完数据库必须通知 Socket 进程重播房间状态 ——
 * 否则别人的成员列表里，你那一行会一直显示没有角色。
 */
export async function setRoomCharacterAction(input: {
  code: string;
  characterId: string | null;
}): Promise<CharacterActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "登录状态已失效，请重新登录" };

  const code = normalizeRoomCode(input.code);
  const result = await setRoomCharacter(user.id, code, input.characterId);

  if (!result.ok) return { ok: false, error: result.error };

  await notifyRoomRefresh(code);
  revalidatePath(`/rooms/${code}`);

  return { ok: true };
}

/**
 * 保存舞台形象里「不需要走文件上传」的那部分：风格、种子、边框。
 *
 * 和 saveCharacterAction 分开，因为形象**不受阶段锁定** ——
 * 进了「进行中」还能换张脸，不影响任何数值平衡。
 *
 * 图片上传不走这里，走 /api/characters/[id]/portrait 的 route handler：
 * Server Action 的 body 默认上限 1MB，而且它擅长的是「表单字段 → 数据库」，
 * 不擅长接收二进制。两者分工：这里管配置，那边管文件。
 */
export async function savePortraitAction(input: {
  characterId: string;
  portrait: unknown;
}): Promise<CharacterActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "登录状态已失效，请重新登录" };

  const result = await saveCharacterPortrait(
    input.characterId,
    user.id,
    input.portrait,
  );
  if (!result.ok) return { ok: false, error: result.error };

  // 这张卡可能正摆在某个房间里。改了形象要让那边的人立刻看到，
  // 否则别人眼里你还是老样子，直到下次刷新
  const codes = await findRoomCodesUsingCharacter(input.characterId);
  await Promise.all(codes.map((code) => notifyRoomRefresh(code)));

  revalidatePath("/characters");
  revalidatePath(`/characters/${input.characterId}`);
  for (const code of codes) revalidatePath(`/rooms/${code}`);

  return { ok: true };
}

/**
 * 改生命值。本人随时能改，DM 能改任意玩家的。
 *
 * 权限以 rooms.host_id 为准，和踢人用同一套判断 ——
 * role 字段只是展示用的标签，真正说了算的是 host_id。
 */
export async function adjustHpAction(input: {
  code: string;
  targetUserId: string;
  currentHp: number;
}): Promise<CharacterActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "登录状态已失效，请重新登录" };

  const code = normalizeRoomCode(input.code);
  const room = await getRoomByCode(code);
  if (!room) return { ok: false, error: "房间不存在" };

  const isDm = room.hostId === user.id;
  if (!isDm && input.targetUserId !== user.id) {
    return { ok: false, error: "只能改自己的生命值" };
  }

  const characterId = await getRoomCharacterId(room.id, input.targetUserId);
  if (!characterId) return { ok: false, error: "还没选角色卡" };

  if (!Number.isFinite(input.currentHp)) {
    return { ok: false, error: "生命值不对" };
  }

  const result = await setCharacterHp(characterId, input.currentHp);
  if (!result.ok) return { ok: false, error: result.error };

  await notifyRoomRefresh(code);
  revalidatePath(`/rooms/${code}`);

  return { ok: true };
}
