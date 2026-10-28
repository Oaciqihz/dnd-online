import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { characters, roomMembers, roomMessages, users } from "./schema";
import { CHAT_HISTORY_LIMIT } from "./chat";
import { parsePortrait } from "./portrait";
import type {
  ChatEntryKind,
  ChatMessageView,
  RollPendingView,
  RollResultView,
  RoomRole,
} from "./protocol";

const CHAT_KINDS: ChatEntryKind[] = ["chat", "roll-request", "roll-result"];

/**
 * 把库里的 kind 字符串收敛成合法枚举。
 *
 * 不认识的值一律当聊天处理：这让「有人手工往库里塞了个奇怪的值」
 * 这种故障的后果只是「这条显示成普通消息」，而不是整段聊天渲染不出来。
 */
function parseKind(raw: string | null): ChatEntryKind {
  return CHAT_KINDS.find((item) => item === raw) ?? "chat";
}

/**
 * 解析系统事件的结构化载荷。
 *
 * 只在「确实是个对象、而且带有 id」时才认。这是读取侧的最后一道防线：
 * payload 是 JSON 列，理论上可以被任何直连数据库的东西写坏，
 * 而它最终会进入 React 的渲染路径 —— 一个 null 或者字符串
 * 会让卡片渲染直接抛异常，把整个聊天面板带崩。
 * 认不出来就返回 null，调用方退化成只显示 body 那句话。
 */
function parsePayload<T>(raw: string | null): T | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof (parsed as { id?: unknown }).id !== "string") return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * 聊天记录的读写。
 *
 * 和 lib/chat.ts 分开：那个文件是纯函数（客户端要用），
 * 这个文件碰数据库（只有服务端能 import）。
 *
 * 读写两条路径的形状刻意不一样：
 * - 写：只落 body 和时间，作者信息一个字都不存
 * - 读：现查 users / room_members / characters，把「现在」的名字和头像框拼上去
 *
 * 这样换名字、换框之后历史消息会跟着变。跑团中途改角色名是常事，
 * 聊天记录里还挂着旧名字只会让人困惑「这个『无名的游侠』是谁」。
 */

/**
 * 一个房间最近的消息，按时间正序返回（最早的在前）。
 *
 * 库里按倒序取 limit 条再反转，而不是正序取 —— 正序取到的是
 * 「这个房间最早的一批消息」，聊天记录要的永远是「最新的这一屏」。
 * 这个顺序如果写反了，表现是「聊了几百句之后消息列表卡在开头不动」。
 */
export async function listRecentMessages(
  roomId: string,
  limit = CHAT_HISTORY_LIMIT,
): Promise<ChatMessageView[]> {
  const rows = await db
    .select({
      id: roomMessages.id,
      userId: roomMessages.userId,
      body: roomMessages.body,
      kind: roomMessages.kind,
      payload: roomMessages.payload,
      createdAt: roomMessages.createdAt,
      displayName: users.displayName,
      role: roomMembers.role,
      characterName: characters.name,
      portrait: characters.portrait,
    })
    .from(roomMessages)
    .innerJoin(users, eq(users.id, roomMessages.userId))
    /**
     * 两个 leftJoin 而不是 innerJoin：发过言的人可能已经退房了，
     * 或者退房之后又建了新卡。用 innerJoin 会让这些历史消息整条消失，
     * 表现出来就是「往上翻，中间缺了几十行」。
     */
    .leftJoin(
      roomMembers,
      and(
        eq(roomMembers.roomId, roomMessages.roomId),
        eq(roomMembers.userId, roomMessages.userId),
      ),
    )
    .leftJoin(characters, eq(characters.id, roomMembers.characterId))
    .where(eq(roomMessages.roomId, roomId))
    .orderBy(desc(roomMessages.createdAt))
    .limit(limit);

  return rows.reverse().map((row) => {
    const name = row.characterName?.trim() || row.displayName;
    const kind = parseKind(row.kind);

    return {
      id: row.id,
      userId: row.userId,
      name,
      /**
       * 退房的人查不到 room_members，角色退成 player。
       * 这是可接受的：他都已经不在房间里了，金色还是紫色不重要，
       * 重要的是这行字还读得出来。
       */
      role: (row.role ?? "player") as RoomRole,
      /**
       * portrait 存的是 JSON 字符串，可能为空（老数据）或被人手工改脏。
       * parsePortrait 兜不住的时候会返回默认值，这里只取 frame，
       * 所以坏数据最多让颜色变成默认色，不会让整条消息渲染不出来。
       */
      frame: row.portrait
        ? parsePortrait(row.portrait, name).frame
        : null,
      body: row.body,
      createdAt: row.createdAt,

      /**
       * 系统条目的结构化部分。payload 解不出来时这里是 null，
       * 聊天栏会退化成「只有 body 那一行字」的样式 ——
       * 内容仍然读得懂，只是少了骰面和推导过程。
       */
      kind,
      request:
        kind === "roll-request"
          ? parsePayload<RollPendingView>(row.payload)
          : null,
      roll:
        kind === "roll-result"
          ? parsePayload<RollResultView>(row.payload)
          : null,
    };
  });
}

/**
 * 落一条消息。返回 id 和时间，作者信息由调用方（Socket 层）用自己的
 * 成员上下文拼 —— 它本来就知道「这个连接是谁、用的哪张卡」，
 * 再查一次数据库纯属浪费。
 */
export async function appendChatMessage(input: {
  roomId: string;
  userId: string;
  body: string;
  /**
   * 系统事件用。缺省就是普通聊天。
   *
   * 系统条目也记在 userId 名下（发起检定的是 DM、掷骰的是玩家），
   * 而不是造一个「系统用户」—— 那个假用户会污染 users 表，
   * 而且会让「这人发过言没有」之类的查询全都算错一次。
   */
  kind?: ChatEntryKind;
  /** 系统事件的结构化载荷，会被 JSON.stringify 后落库 */
  payload?: unknown;
  /** 允许调用方指定，测试和多端同步时有用；正常情况留空 */
  id?: string;
  createdAt?: number;
}): Promise<{ id: string; createdAt: number }> {
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? Date.now();

  await db.insert(roomMessages).values({
    id,
    roomId: input.roomId,
    userId: input.userId,
    body: input.body,
    kind: input.kind ?? "chat",
    payload: input.payload === undefined ? "" : JSON.stringify(input.payload),
    createdAt,
  });

  return { id, createdAt };
}
