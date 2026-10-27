import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { roomMembers, rooms, users } from "./schema";
import type { RoomMemberView } from "./protocol";

/**
 * 房间相关的数据操作。
 * 和 session-store.ts 一样，这里不 import 任何 next/* 模块，
 * 因为 Socket.IO 独立进程也要用同一套逻辑。
 */

/** 去掉了 0/O/1/I 这些看错、念错的字符，口头报房间码时不容易出错 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(length = ROOM_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let code = "";

  for (let i = 0; i < length; i += 1) {
    // 256 % 32 === 0，所以这里取模不会造成分布偏差
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }

  return code;
}

/** 用户可能输入小写、空格、连字符，统一清洗成标准码 */
export function normalizeRoomCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
}

export async function getRoomByCode(code: string) {
  const rows = await db
    .select()
    .from(rooms)
    .where(eq(rooms.code, normalizeRoomCode(code)))
    .limit(1);

  return rows[0] ?? null;
}

export async function listRoomMembers(roomId: string) {
  return db
    .select({
      userId: users.id,
      displayName: users.displayName,
      kind: users.kind,
      role: roomMembers.role,
      joinedAt: roomMembers.joinedAt,
    })
    .from(roomMembers)
    .innerJoin(users, eq(users.id, roomMembers.userId))
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(roomMembers.joinedAt);
}

export type RoomMemberInfo = Awaited<ReturnType<typeof listRoomMembers>>[number];

export function toMemberView(
  row: RoomMemberInfo,
  onlineUserIds: Set<string>,
): RoomMemberView {
  return {
    userId: row.userId,
    displayName: row.displayName,
    kind: row.kind,
    role: row.role,
    online: onlineUserIds.has(row.userId),
  };
}

export async function isRoomMember(
  roomId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);

  return rows.length > 0;
}

/**
 * 建房。房间码靠数据库唯一约束保证不冲突，
 * 这里再预检一次并重试，把「撞码」变成对用户完全透明的事情。
 */
export async function createRoom(hostId: string, name: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateRoomCode();
    if (await getRoomByCode(code)) continue;

    const id = randomUUID();
    const now = Date.now();

    await db.insert(rooms).values({
      id,
      code,
      name,
      hostId,
      status: "open",
      createdAt: now,
    });

    // 建房的人自动成为 DM
    await db.insert(roomMembers).values({
      roomId: id,
      userId: hostId,
      role: "dm",
      joinedAt: now,
    });

    return { id, code, name, hostId, createdAt: now };
  }

  throw new Error("房间码生成失败，请重试");
}

export type JoinResult =
  | { ok: true; room: { id: string; code: string; name: string } }
  | { ok: false; error: string };

export async function joinRoom(
  userId: string,
  rawCode: string,
): Promise<JoinResult> {
  const code = normalizeRoomCode(rawCode);

  if (code.length !== ROOM_CODE_LENGTH) {
    return { ok: false, error: `房间码是 ${ROOM_CODE_LENGTH} 位，检查一下` };
  }

  const room = await getRoomByCode(code);
  if (!room) {
    return { ok: false, error: "没有找到这个房间，确认一下房间码" };
  }

  // 联合主键 + onConflictDoNothing：重复点击加入不会报错，也不会产生重复行
  await db
    .insert(roomMembers)
    .values({
      roomId: room.id,
      userId,
      role: "player",
      joinedAt: Date.now(),
    })
    .onConflictDoNothing();

  return { ok: true, room: { id: room.id, code: room.code, name: room.name } };
}

export async function leaveRoom(
  userId: string,
  rawCode: string,
): Promise<{ ok: boolean; deleted: boolean }> {
  const room = await getRoomByCode(rawCode);
  if (!room) return { ok: false, deleted: false };

  await db
    .delete(roomMembers)
    .where(
      and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)),
    );

  const remaining = await listRoomMembers(room.id);

  // 最后一个人走了就把房间删掉，不留空房间占着房间码
  if (remaining.length === 0) {
    await db.delete(rooms).where(eq(rooms.id, room.id));
    return { ok: true, deleted: true };
  }

  // 房主离开：把房主身份交给最早加入的人，房间不会变成没人管
  if (room.hostId === userId) {
    await db
      .update(rooms)
      .set({ hostId: remaining[0].userId })
      .where(eq(rooms.id, room.id));
  }

  return { ok: true, deleted: false };
}

export type KickResult =
  | { ok: true; displayName: string }
  | { ok: false; error: string };

/**
 * 把某个成员移出房间。
 *
 * 权限规则：只有房主能踢人，而且不能踢自己、不能踢另一位 DM。
 * 「房主」以 rooms.host_id 为准，而不是只看 role 字段 —— role 是展示用的，
 * host_id 才是唯一的权力来源，两者不一致时以 host_id 为准。
 *
 * 注意这里只动数据库。把对方的长连接赶出去要靠 socket-notify 里的内部通知，
 * 那一层失败了也不该影响「他确实不在成员名单里」这个事实。
 */
export async function kickMember(
  actorId: string,
  rawCode: string,
  targetUserId: string,
): Promise<KickResult> {
  const room = await getRoomByCode(rawCode);
  if (!room) return { ok: false, error: "房间不存在" };

  if (room.hostId !== actorId) {
    return { ok: false, error: "只有 DM 能移出成员" };
  }

  if (targetUserId === actorId) {
    return { ok: false, error: "不能把自己移出房间，用「离开房间」" };
  }

  const members = await listRoomMembers(room.id);
  const target = members.find((item) => item.userId === targetUserId);

  if (!target) {
    return { ok: false, error: "这个人已经不在房间里了" };
  }

  if (target.role === "dm") {
    return { ok: false, error: "不能移出另一位 DM" };
  }

  await db
    .delete(roomMembers)
    .where(
      and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, targetUserId)),
    );

  return { ok: true, displayName: target.displayName };
}

export async function listRoomsForUser(userId: string) {
  return db
    .select({
      id: rooms.id,
      code: rooms.code,
      name: rooms.name,
      hostId: rooms.hostId,
      createdAt: rooms.createdAt,
    })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(eq(roomMembers.userId, userId))
    .orderBy(desc(rooms.createdAt));
}
