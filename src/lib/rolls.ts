import { randomUUID } from "node:crypto";
import { db } from "./db";
import { roomRolls } from "./schema";
import type { DiceSpec } from "./dice";

/**
 * 掷骰结果的落库。
 *
 * 只有服务端会 import 这个文件（它碰数据库），
 * 客户端要的展示信息走 protocol.ts 的视图类型。
 *
 * 这一版只写不读。听起来像半成品，但是刻意的：
 * 结果在广播里已经完整送到了每个客户端，读库只服务于「历史回看」，
 * 而历史回看要和聊天记录合并成一条时间线才有意义 ——
 * 那是下一步的事，现在先保证每一条掷骰都**留得下来**。
 * 反过来的顺序（先做展示不留档）才会真的丢数据。
 */

export type RollOutcome = "success" | "fail" | null;

export async function appendRoll(input: {
  roomId: string;
  actorId: string;
  requestedBy: string;
  label: string;
  checkKey: string;
  spec: DiceSpec;
  /** 每一颗骰子的原始点数，顺序即掷出顺序 */
  raw: number[];
  pickedIndex: number;
  pickedValue: number;
  modifier: number;
  parts: Array<{ label: string; value: number }>;
  total: number;
  dc: number | null;
  outcome: RollOutcome;
}): Promise<{ id: string; createdAt: number }> {
  const id = randomUUID();
  const createdAt = Date.now();

  await db.insert(roomRolls).values({
    id,
    roomId: input.roomId,
    actorId: input.actorId,
    requestedBy: input.requestedBy,

    label: input.label,
    checkKey: input.checkKey,

    // 骰子规格和原始点数都序列化成 JSON。它们的形状由 lib/dice.ts 管着，
    // 读取方永远经过 sanitizeDiceSpec / 原样当数字数组用，不需要在库里建列
    dice: JSON.stringify(input.spec),
    rawRolls: JSON.stringify(input.raw),

    picked: input.pickedIndex,
    pickedValue: input.pickedValue,

    modifier: input.modifier,
    modifierParts: JSON.stringify(input.parts),

    total: input.total,
    dc: input.dc,
    outcome: input.outcome,

    createdAt,
  });

  return { id, createdAt };
}
