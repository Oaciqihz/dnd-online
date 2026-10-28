import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { roomMembers, rooms, users } from "./schema";
import type {
  CharacterSummary,
  RoomMemberView,
  RoomPhase,
} from "./protocol";
import { PHASE_LABEL, phaseCapabilities } from "./permissions";
import {
  sanitizeSceneFit,
  sanitizeSceneKey,
  type SceneFit,
  type SceneKey,
} from "./scenes";
import { sanitizeImageRef } from "./media/ref";

/**
 * 房间相关的数据操作。
 * 和 session-store.ts 一样，这里不 import 任何 next/* 模块，
 * 因为 Socket.IO 独立进程也要用同一套逻辑。
 *
 * 场景相关（换背景 / 传地图）也放在这个文件，因为「谁能改房间的显示状态」
 * 这条判断必须和成员、角色、阶段用同一份 phaseCapabilities。
 * 拆成 scenes-store.ts 只会让权限判断出现第二份。
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
      characterId: roomMembers.characterId,
      ready: roomMembers.ready,
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
  character: CharacterSummary | null = null,
): RoomMemberView {
  return {
    userId: row.userId,
    displayName: row.displayName,
    kind: row.kind,
    role: row.role,
    online: onlineUserIds.has(row.userId),
    // DM 不参与就绪统计，即使库里残留了 true 也对外表现为 false
    ready: row.role === "player" ? row.ready : false,
    character,
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
      phase: "preparing",
      startedAt: null,
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

  // 已结束的团不能再加入。这条校验必须放在服务端，
  // 光在页面上藏掉入口，别人拿房间码直接 POST 一样能挤进去。
  if (room.phase === "ended") {
    return { ok: false, error: "这一局已经结束了，不能再加入" };
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
      phase: rooms.phase,
      createdAt: rooms.createdAt,
    })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(eq(roomMembers.userId, userId))
    .orderBy(desc(rooms.createdAt));
}

/**
 * 允许的阶段流转。
 *
 * 刻意的限制：
 * - preparing 不能直接跳到 ended —— 还没开始就结束，其实是「废弃这个房间」，
 *   那应该删房间，不是标一个结束
 * - ended 不能直接回到 playing —— 结束的团要重新跑，得先回到准备，
 *   让所有人有机会改卡，再开始
 */
const ALLOWED_TRANSITIONS: Record<RoomPhase, RoomPhase[]> = {
  preparing: ["playing"],
  playing: ["ended", "preparing"],
  ended: ["preparing"],
};

export type PhaseResult =
  | { ok: true; phase: RoomPhase }
  | { ok: false; error: string };

/**
 * 推进房间阶段。只有 DM（房主）能做，能力判断全部交给 permissions.ts。
 *
 * 状态流转本身不做任何广播 —— 和踢人一样，写库发生在这个进程，
 * 广播要靠 socket-notify 通知另一个进程。
 */
export async function setRoomPhase(
  actorId: string,
  rawCode: string,
  next: RoomPhase,
): Promise<PhaseResult> {
  const room = await getRoomByCode(rawCode);
  if (!room) return { ok: false, error: "房间不存在" };

  const members = await listRoomMembers(room.id);
  const self = members.find((item) => item.userId === actorId);

  if (!self) return { ok: false, error: "你不在这个房间里" };

  const caps = phaseCapabilities({
    phase: room.phase,
    hostId: room.hostId,
    viewerId: actorId,
    viewerRole: self.role,
  });

  const needed =
    next === "playing"
      ? caps.canStart
      : next === "ended"
        ? caps.canEnd
        : caps.canReopen;

  if (!needed) {
    if (room.hostId !== actorId) {
      return { ok: false, error: "只有 DM 能改变房间阶段" };
    }
    if (room.phase === next) return { ok: true, phase: room.phase };
    return { ok: false, error: `当前是「${PHASE_LABEL[room.phase]}」，不能切到「${PHASE_LABEL[next]}」` };
  }

  if (!ALLOWED_TRANSITIONS[room.phase].includes(next)) {
    return {
      ok: false,
      error: `「${PHASE_LABEL[room.phase]}」不能直接切到「${PHASE_LABEL[next]}」`,
    };
  }

  await db
    .update(rooms)
    .set({
      phase: next,
      // 每次进入进行中都刷新开始时间；退回准备时保留上一次的值，
      // 让 DM 能看出「这局已经打了多久」
      startedAt: next === "playing" ? Date.now() : room.startedAt,
    })
    .where(eq(rooms.id, room.id));

  // 回到准备意味着要重新确认一遍就绪状态，否则 DM 会看到过期的绿灯
  if (next === "preparing") {
    await db
      .update(roomMembers)
      .set({ ready: false })
      .where(eq(roomMembers.roomId, room.id));
  }

  return { ok: true, phase: next };
}

export type SceneState = {
  backgroundKey: SceneKey;
  backgroundImage: string;
  backgroundFit: SceneFit;
  sceneCaption: string;
};

/**
 * 换场景的输入。
 *
 * `source` 是这个接口里最容易被省略、却最不能省的一个字段。
 *
 * 直觉写法是「只传 backgroundKey，传了就换场景」，但它无法表达
 * 「我要切回内置场景」—— 因为 DM 上传过地图之后，backgroundKey
 * 仍然是有值的（它降级成了兜底底色）。这时点内置场景如果不清图，
 * 图还盖在上面，DM 会觉得按钮坏了。
 *
 * 反过来，如果只要 backgroundKey 变化就清图，那「只改一句场景描述」
 * 又会把地图清掉。所以来源必须是显式的，而不是从别的字段推断。
 */
export type SceneInput = {
  /** builtin = 用内置渐变（会清掉地图）；upload = 用已上传的地图 */
  source: "builtin" | "upload";
  /** source=builtin 时选中的场景 key */
  backgroundKey: unknown;
  fit: unknown;
  caption: string;
};

export type SceneResult =
  | ({ ok: true } & SceneState & {
        /** 被这次切换丢弃的旧图，调用方负责删文件。空字符串表示没删 */
        removedImage: string;
      })
  | { ok: false; error: string };

/**
 * 换场景前的公共校验：房间在不在、我在不在、我有没有这个权限。
 * 上传图片和切换场景走同一套判断 —— 两处各写一遍迟早会分叉。
 */
async function authorizeSceneChange(
  actorId: string,
  rawCode: string,
): Promise<
  | { ok: true; roomId: string; image: string; key: string; fit: string; caption: string }
  | { ok: false; error: string }
> {
  const room = await getRoomByCode(rawCode);
  if (!room) return { ok: false, error: "房间不存在" };

  const members = await listRoomMembers(room.id);
  const self = members.find((item) => item.userId === actorId);
  if (!self) return { ok: false, error: "你不在这个房间里" };

  const caps = phaseCapabilities({
    phase: room.phase,
    hostId: room.hostId,
    viewerId: actorId,
    viewerRole: self.role,
  });

  if (!caps.canChangeScene) {
    return {
      ok: false,
      error:
        room.phase === "ended"
          ? "本局已结束，不能再换场景"
          : "只有 DM 能切换场景",
    };
  }

  return {
    ok: true,
    roomId: room.id,
    image: room.backgroundImage,
    key: room.backgroundKey,
    fit: room.backgroundFit,
    caption: room.sceneCaption,
  };
}

/**
 * 换舞台背景。
 *
 * 场景描述不是可选的装饰 —— 它是这个功能真正的价值所在。
 * 单纯的「设置里挑一张背景图」只会在开局被用一次，然后被忘掉；
 * 而「你们推开沉重的木门，一股霉味涌出来」+ 换背景，
 * 是跑团里 DM 一直在做的动作。等 game_events 表建起来之后，
 * 每一次这样的切换都会自然成为场景时间线上的一条记录。
 */
export async function setRoomScene(
  actorId: string,
  rawCode: string,
  input: SceneInput,
): Promise<SceneResult> {
  const allowed = await authorizeSceneChange(actorId, rawCode);
  if (!allowed.ok) return allowed;

  const safeKey = sanitizeSceneKey(input.backgroundKey);
  const safeFit = sanitizeSceneFit(input.fit);
  // 一句话就够，不给人写小说的机会 —— 横幅上一行长文会把舞台挤掉
  const safeCaption = input.caption.trim().slice(0, 120);

  let image = allowed.image;

  if (input.source === "upload") {
    // 选了「用我的地图」但库里没有图：这是前端状态和服务端数据不同步，
    // 明确报错比默默显示回渐变要好，否则 DM 会一直以为图传上去了
    if (!image) return { ok: false, error: "还没有上传地图" };
  } else {
    image = "";
  }

  await db
    .update(rooms)
    .set({
      backgroundKey: safeKey,
      backgroundImage: image,
      backgroundFit: safeFit,
      sceneCaption: safeCaption,
    })
    .where(eq(rooms.id, allowed.roomId));

  return {
    ok: true,
    backgroundKey: safeKey,
    backgroundImage: image,
    backgroundFit: safeFit,
    sceneCaption: safeCaption,
    removedImage: image ? "" : allowed.image,
  };
}

/**
 * 写入 DM 上传的地图。只有上传接口会调这个。
 *
 * 单独一个函数而不是复用 setRoomScene，因为它们的输入根本不同：
 * 这边拿到的是存储层刚返回的 ref，那边拿到的是 DM 点选的 key。
 * 强行合并只能靠「传了 image 就覆盖」这种隐式约定，那正是上面
 * SceneInput.source 想避免的东西。
 */
export async function setRoomBackgroundImage(
  actorId: string,
  rawCode: string,
  image: string,
  fit: unknown,
): Promise<SceneResult> {
  const allowed = await authorizeSceneChange(actorId, rawCode);
  if (!allowed.ok) return allowed;

  const safeImage = sanitizeImageRef(image);
  if (!safeImage) return { ok: false, error: "图片地址不合法" };

  const safeFit = sanitizeSceneFit(fit);

  await db
    .update(rooms)
    .set({ backgroundImage: safeImage, backgroundFit: safeFit })
    .where(eq(rooms.id, allowed.roomId));

  return {
    ok: true,
    backgroundKey: sanitizeSceneKey(allowed.key),
    backgroundImage: safeImage,
    backgroundFit: safeFit,
    sceneCaption: allowed.caption,
    removedImage: allowed.image !== safeImage ? allowed.image : "",
  };
}

/**
 * 清空地图，退回内置渐变。
 *
 * 和 setRoomScene(source=builtin) 的区别是它不动 backgroundKey：
 * 用在「上传失败要回滚」和「删除图但保留当前场景」这两种场合。
 */
export async function clearRoomBackgroundImage(
  actorId: string,
  rawCode: string,
): Promise<SceneResult> {
  const allowed = await authorizeSceneChange(actorId, rawCode);
  if (!allowed.ok) return allowed;

  if (!allowed.image) {
    return {
      ok: true,
      backgroundKey: sanitizeSceneKey(allowed.key),
      backgroundImage: "",
      backgroundFit: sanitizeSceneFit(allowed.fit),
      sceneCaption: allowed.caption,
      removedImage: "",
    };
  }

  await db
    .update(rooms)
    .set({ backgroundImage: "" })
    .where(eq(rooms.id, allowed.roomId));

  return {
    ok: true,
    backgroundKey: sanitizeSceneKey(allowed.key),
    backgroundImage: "",
    backgroundFit: sanitizeSceneFit(allowed.fit),
    sceneCaption: allowed.caption,
    removedImage: allowed.image,
  };
}

/**
 * 玩家切换自己的「我准备好了」。
 *
 * 这只是个信号，不改变任何人的权限，也不会触发自动开团。
 * DM 没有这个按钮 —— 他本来就是决定的人。
 */
export async function setMemberReady(
  userId: string,
  rawCode: string,
  ready: boolean,
): Promise<{ ok: true; ready: boolean } | { ok: false; error: string }> {
  const room = await getRoomByCode(rawCode);
  if (!room) return { ok: false, error: "房间不存在" };

  const members = await listRoomMembers(room.id);
  const self = members.find((item) => item.userId === userId);
  if (!self) return { ok: false, error: "你不在这个房间里" };

  const caps = phaseCapabilities({
    phase: room.phase,
    hostId: room.hostId,
    viewerId: userId,
    viewerRole: self.role,
  });

  if (!caps.canToggleReady) {
    return {
      ok: false,
      error:
        self.role === "dm"
          ? "DM 不参与就绪，直接开始就好"
          : "现在不能切换就绪状态",
    };
  }

  await db
    .update(roomMembers)
    .set({ ready })
    .where(
      and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)),
    );

  return { ok: true, ready };
}

/**
 * 某张角色卡是否正被一个「进行中」的房间占用。
 *
 * 用来在角色卡编辑页把属性字段锁住：卡已经在团里了还去改力量值，
 * 等于中途换了个角色，DM 完全不知情。
 */
export async function findLockingRoom(characterId: string): Promise<{
  code: string;
  name: string;
} | null> {
  const rows = await db
    .select({ code: rooms.code, name: rooms.name })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(
      and(
        eq(roomMembers.characterId, characterId),
        eq(rooms.phase, "playing"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * 找出所有正在使用这张角色卡的房间（不限阶段）。
 *
 * 和 findLockingRoom 的区别：那个只关心「进行中」，用来阻止改属性；
 * 这个关心的是「哪里可能正在显示这张卡片的外观」，用来决定改完形象要通知谁。
 * 准备阶段的成员列表里也画着 token，所以不能只查进行中的房间。
 */
export async function findRoomCodesUsingCharacter(
  characterId: string,
): Promise<string[]> {
  const rows = await db
    .select({ code: rooms.code })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(eq(roomMembers.characterId, characterId));

  return [...new Set(rows.map((row) => row.code))];
}
