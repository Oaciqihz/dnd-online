import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { characters, roomMembers, rooms } from "./schema";
import type { CharacterRow } from "./schema";
import type { CharacterSummary } from "./protocol";
import { findLockingRoom } from "./rooms";
import {
  parsePortrait,
  sanitizePortrait,
  type Portrait,
} from "./portrait";
import {
  ABILITIES,
  clampAbility,
  computeMaxHp,
  deriveCharacter,
  findClass,
  MAX_LEVEL,
  MIN_LEVEL,
  parseJsonArray,
  SKILLS,
  type AbilityKey,
  type AbilityScores,
  type Derived,
} from "./rules";

/**
 * 角色卡的数据操作。
 *
 * 这个文件里有一个必须守住的原则：
 * 「别人能看什么」的裁剪必须发生在服务端。
 *
 * 常见的错误做法是把完整对象查出来、发给前端、再用 CSS 隐藏敏感字段。
 * 那样按 F12 就能看到别人的属性和背景故事，等于没做权限。
 * 所以这里导出两个函数：toSummary（对外）和 toDetail（自己或 DM），
 * 调用方按角色选一个，拿到的对象就只包含允许的字段。
 */

export type { CharacterSummary };

export type CharacterDetail = CharacterSummary & {
  background: string;
  alignment: string;
  abilities: AbilityScores;
  skills: string[];
  saves: AbilityKey[];
  hpBonus: number;
  acOverride: number | null;
  equipment: string;
  spells: string;
  features: string;
  backstory: string;
  notes: string;
  derived: Derived;
  createdAt: number;
  updatedAt: number;
};

function readAbilities(row: CharacterRow): AbilityScores {
  return {
    str: row.str,
    dex: row.dex,
    con: row.con,
    int: row.int,
    wis: row.wis,
    cha: row.cha,
  };
}

function derive(row: CharacterRow): Derived {
  return deriveCharacter({
    classKey: row.classKey,
    level: row.level,
    abilities: readAbilities(row),
    skills: parseJsonArray(row.skills),
    saves: parseJsonArray(row.saves) as AbilityKey[],
    hpBonus: row.hpBonus,
    acOverride: row.acOverride,
  });
}

/**
 * 一次检定对这个角色来说是多少加值。
 *
 * 这是掷骰功能里最省事的一环：DM 只需要说「做个运动检定」，
 * 不需要知道这个人的运动加值是几，玩家也没机会自己填。
 *
 * 为什么这件事重要，不只是省事 —— 它是**防作弊的落点**。
 * 如果加值由客户端上报，改一个数字就能让所有人每次检定都 +30。
 * 由服务端从角色卡现算，玩家能操作的只剩「掷」这个动作本身，
 * 而那一下也是服务端掷的。
 *
 * checkKey 的形状是 `kind:key`，四种：
 * - `skill:athletics` 技能检定
 * - `save:dex` 豁免检定
 * - `ability:int` 纯属性检定（不熟练）
 * - `flat` 不加任何加值
 */
export type CheckResolution = {
  /** 给人看的名字，如「运动检定」 */
  label: string;
  modifier: number;
  /** 加值的构成，UI 上要摊开给玩家看，否则他没法相信这个数 */
  parts: Array<{ label: string; value: number }>;
};

export function resolveCheck(
  row: CharacterRow,
  checkKey: string,
): CheckResolution | null {
  const derived = derive(row);

  // 没有加值的纯掷骰。留着这个入口是因为 DM 有时候只是想看个随机数
  if (checkKey === "flat") {
    return { label: "纯掷骰", modifier: 0, parts: [] };
  }

  const [kind, key] = checkKey.split(":");
  if (!kind || !key) return null;

  /**
   * 属性名从 skills 里借 —— SKILLS 常量覆盖全部六属性，
   * 所以一定能找到。比再 import 一次 ABILITIES 少一次依赖，
   * 也保证「技能卡上写的属性名」和「掷骰面板上写的一致」。
   */
  const abilityLabel =
    derived.skills.find((item) => item.ability === key)?.abilityLabel ?? key;

  if (kind === "skill") {
    const skill = derived.skills.find((item) => item.key === key);
    if (!skill) return null;

    const parts = [
      { label: `${skill.abilityLabel}调整`, value: derived.modifiers[skill.ability] },
    ];
    if (skill.proficient) {
      parts.push({ label: "熟练", value: derived.proficiencyBonus });
    }

    return { label: `${skill.label}检定`, modifier: skill.total, parts };
  }

  if (kind === "save") {
    const save = derived.savingThrows.find((item) => item.key === key);
    if (!save) return null;

    const parts = [
      {
        label: `${abilityLabel}调整`,
        value: derived.modifiers[save.key],
      },
    ];
    if (save.proficient) {
      parts.push({ label: "熟练", value: derived.proficiencyBonus });
    }

    return { label: `${save.label}豁免`, modifier: save.total, parts };
  }

  if (kind === "ability") {
    const ability = ABILITIES.find((item) => item.key === key);
    if (!ability) return null;

    return {
      label: `${abilityLabel}检定`,
      modifier: derived.modifiers[ability.key],
      parts: [{ label: `${abilityLabel}调整`, value: derived.modifiers[ability.key] }],
    };
  }

  return null;
}

/**
 * 对外摘要。房间里其他人看到的就是这个形状：
 * 名字、职业、等级、生命、AC —— 够用来判断「他快死了要不要救」，但不含细节。
 */
export function toSummary(row: CharacterRow): CharacterSummary {
  const derived = derive(row);

  // 老数据的 portrait 是空对象。这时给一个用角色名当种子的生成头像 ——
  // 用名字当种子意味着「同一个角色永远是同一张脸」，
  // 而不是每次刷新 DataBase 的默认 PRNG 都给一张新的
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    classKey: row.classKey,
    className: row.className,
    level: row.level,
    ancestry: row.ancestry,
    currentHp: Math.max(0, Math.min(row.currentHp, derived.maxHp)),
    maxHp: derived.maxHp,
    tempHp: row.tempHp,
    ac: derived.ac,
    status: row.status,
    portrait: parsePortrait(row.portrait, row.name || row.id),
  };
}

/** 完整卡片。只给卡主自己和房间 DM 用 */
export function toDetail(row: CharacterRow): CharacterDetail {
  const derived = derive(row);

  return {
    ...toSummary(row),
    background: row.background,
    alignment: row.alignment,
    abilities: readAbilities(row),
    skills: parseJsonArray(row.skills),
    saves: parseJsonArray(row.saves) as AbilityKey[],
    hpBonus: row.hpBonus,
    acOverride: row.acOverride,
    equipment: row.equipment,
    spells: row.spells,
    features: row.features,
    backstory: row.backstory,
    notes: row.notes,
    derived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listCharactersByOwner(ownerId: string) {
  return db
    .select()
    .from(characters)
    .where(eq(characters.ownerId, ownerId))
    .orderBy(desc(characters.updatedAt));
}

export async function getCharacterById(id: string) {
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.id, id))
    .limit(1);

  return rows[0] ?? null;
}

/** 带属主校验的读取：不是自己的卡就拿不到，防止改 URL 直接访问别人的卡 */
export async function getOwnedCharacter(id: string, ownerId: string) {
  const rows = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, ownerId)))
    .limit(1);

  return rows[0] ?? null;
}

export type CharacterInput = {
  name: string;
  classKey: string;
  level: number;
  ancestry: string;
  background: string;
  alignment: string;
  abilities: AbilityScores;
  skills: string[];
  saves: AbilityKey[];
  equipment: string;
  spells: string;
  features: string;
  backstory: string;
  notes: string;
  hpBonus: number;
  acOverride: number | null;
  /** 不传表示不动当前生命值；传了就按传的来（扣血 / 治疗） */
  currentHp?: number;
};

function sanitize(input: CharacterInput) {
  const classInfo = findClass(input.classKey);
  const abilityKeys = ABILITIES.map((item) => item.key);
  const validSkills = new Set(SKILLS.map((item) => item.key));
  const validAbilities = new Set<string>(abilityKeys);

  const abilities = {} as AbilityScores;
  for (const key of abilityKeys) {
    abilities[key] = clampAbility(input.abilities[key] ?? 10);
  }

  const level = Math.min(
    MAX_LEVEL,
    Math.max(MIN_LEVEL, Math.round(input.level) || 1),
  );

  return {
    name: input.name.trim().slice(0, 40),
    classKey: classInfo.key,
    className: classInfo.label,
    level,
    ancestry: input.ancestry.trim().slice(0, 24),
    background: input.background.trim().slice(0, 40),
    alignment: input.alignment.trim().slice(0, 24),
    abilities,
    skills: [...new Set(input.skills.filter((item) => validSkills.has(item)))],
    saves: [
      ...new Set(input.saves.filter((item) => validAbilities.has(item))),
    ],
    equipment: input.equipment.slice(0, 4000),
    spells: input.spells.slice(0, 4000),
    features: input.features.slice(0, 4000),
    backstory: input.backstory.slice(0, 8000),
    notes: input.notes.slice(0, 4000),
    hpBonus: Math.max(-20, Math.min(200, Math.round(input.hpBonus) || 0)),
    acOverride:
      input.acOverride === null
        ? null
        : Math.max(1, Math.min(40, Math.round(input.acOverride) || 10)),
  };
}

/** 新建一张空的草稿卡，让建卡向导有东西可以写 */
export async function createCharacterDraft(ownerId: string) {
  const now = Date.now();
  const classInfo = findClass("fighter");
  const maxHp = computeMaxHp(classInfo.key, 1, 10, 0);

  const row: CharacterRow = {
    id: randomUUID(),
    ownerId,
    name: "",
    classKey: classInfo.key,
    className: classInfo.label,
    level: 1,
    ancestry: "",
    background: "",
    alignment: "",
    str: 10,
    dex: 10,
    con: 10,
    int: 10,
    wis: 10,
    cha: 10,
    skills: "[]",
    saves: "[]",
    currentHp: maxHp,
    tempHp: 0,
    hpBonus: 0,
    acOverride: null,
    equipment: "",
    spells: "",
    features: "",
    backstory: "",
    notes: "",
    // 草稿阶段还没有名字，先存空对象。
    // 读取时 parsePortrait 会拿角色名当种子现场生成一张脸，
    // 所以建卡建到一半也不会出现「没有脸」的状态
    portrait: "{}",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(characters).values(row);
  return row;
}

export type SaveResult =
  | { ok: true; row: CharacterRow }
  | { ok: false; error: string };

/**
 * 保存角色卡。
 *
 * 有一个容易被忽略的细节：升级时 maxHp 会涨，但玩家可能已经受了伤。
 * 如果直接把 currentHp 写死，升级后血量就不会跟着涨，玩家会以为卡坏了。
 * 所以这里默认保持「已损失的生命值」不变 —— 最大生命涨多少，当前生命涨多少。
 *
 * 调用方显式传 currentHp 时（扣血、治疗、长休）就以传的值为准。
 */
export async function saveCharacter(
  actorId: string,
  id: string,
  input: CharacterInput,
  options: { finalize?: boolean } = {},
): Promise<SaveResult> {
  const existing = await getOwnedCharacter(id, actorId);
  if (!existing) return { ok: false, error: "找不到这张角色卡" };

  /**
   * 属性锁定。
   *
   * 卡正被一个「进行中」的房间使用时，属性、熟练、装备都不允许再改 ——
   * 那等于中途把角色换了一个人，DM 完全不知情。
   *
   * 这条校验必须在这里而不是只做在 UI 上：直接调 Server Action
   * 一样要能被拦住。生命值走的是另一个函数 setCharacterHp，
   * 不吃这条限制，因为战斗扣血是随时都会发生的。
   */
  const lock = await findLockingRoom(id);
  if (lock) {
    return {
      ok: false,
      error: `这张卡正在「${lock.name}」里进行游戏，属性已锁定。生命值和备注仍然可以改`,
    };
  }

  const clean = sanitize(input);

  if (options.finalize && clean.name.length === 0) {
    return { ok: false, error: "角色需要一个名字" };
  }

  const oldMaxHp = computeMaxHp(
    existing.classKey,
    existing.level,
    existing.con,
    existing.hpBonus,
  );
  const newMaxHp = computeMaxHp(
    clean.classKey,
    clean.level,
    clean.abilities.con,
    clean.hpBonus,
  );

  let currentHp: number;
  if (typeof input.currentHp === "number") {
    currentHp = Math.round(input.currentHp);
  } else {
    const lost = Math.max(0, oldMaxHp - existing.currentHp);
    currentHp = newMaxHp - lost;
  }

  currentHp = Math.max(0, Math.min(newMaxHp, currentHp));

  const now = Date.now();

  const [row] = await db
    .update(characters)
    .set({
      name: clean.name,
      classKey: clean.classKey,
      className: clean.className,
      level: clean.level,
      ancestry: clean.ancestry,
      background: clean.background,
      alignment: clean.alignment,
      str: clean.abilities.str,
      dex: clean.abilities.dex,
      con: clean.abilities.con,
      int: clean.abilities.int,
      wis: clean.abilities.wis,
      cha: clean.abilities.cha,
      skills: JSON.stringify(clean.skills),
      saves: JSON.stringify(clean.saves),
      currentHp,
      tempHp: existing.tempHp,
      hpBonus: clean.hpBonus,
      acOverride: clean.acOverride,
      equipment: clean.equipment,
      spells: clean.spells,
      features: clean.features,
      backstory: clean.backstory,
      notes: clean.notes,
      status: options.finalize ? "ready" : existing.status,
      updatedAt: now,
    })
    .where(eq(characters.id, id))
    .returning();

  return { ok: true, row };
}

export type DeleteResult = { ok: true } | { ok: false; error: string };

/**
 * 删除角色卡。
 *
 * 被房间引用时不允许删 —— 否则房间里那个人的角色会突然变成空白，
 * 而他自己也不知道发生了什么。让他先去房间里换一张卡。
 */
export async function deleteCharacter(
  actorId: string,
  id: string,
): Promise<DeleteResult> {
  const existing = await getOwnedCharacter(id, actorId);
  if (!existing) return { ok: false, error: "找不到这张角色卡" };

  const used = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(eq(roomMembers.characterId, id))
    .limit(1);

  if (used.length > 0) {
    return { ok: false, error: "还有房间在用这张卡，先在房间里换掉再删" };
  }

  await db.delete(characters).where(eq(characters.id, id));
  return { ok: true };
}

/** 房间成员的当前角色卡（摘要），附带属主，房间页直接渲染用 */
export async function listRoomCharacterSummaries(roomId: string) {
  const rows = await db
    .select({
      userId: roomMembers.userId,
      characterId: roomMembers.characterId,
    })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId));

  const ids = rows
    .map((item) => item.characterId)
    .filter((item): item is string => Boolean(item));

  if (ids.length === 0) return new Map<string, CharacterSummary>();

  const charRows = await db
    .select()
    .from(characters)
    .where(inArray(characters.id, ids));

  const byId = new Map<string, CharacterSummary>();
  for (const row of charRows) {
    byId.set(row.id, toSummary(row));
  }

  const result = new Map<string, CharacterSummary>();
  for (const item of rows) {
    if (!item.characterId) continue;
    const summary = byId.get(item.characterId);
    if (summary) result.set(item.userId, summary);
  }

  return result;
}

/** 房间里所有人的角色卡，按 userId 索引。只给 DM 看详情用 */
export async function listRoomCharacterDetails(roomId: string) {
  const summaries = await listRoomCharacterSummaries(roomId);
  const details = new Map<string, CharacterDetail>();

  for (const [userId, summary] of summaries) {
    const row = await getCharacterById(summary.id);
    if (row) details.set(userId, toDetail(row));
  }

  return details;
}

export type SetCharacterResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 设置「我在这个房间用哪张卡」。
 *
 * 传 null 表示卸下。校验两件事：卡是自己的，人确实在这个房间里。
 * 房主身份不影响这里 —— DM 也可以有自己的卡（将来放 NPC 用）。
 */
export async function setRoomCharacter(
  userId: string,
  rawCode: string,
  characterId: string | null,
): Promise<SetCharacterResult> {
  const code = rawCode.trim().toUpperCase();
  const roomRows = await db
    .select()
    .from(rooms)
    .where(eq(rooms.code, code))
    .limit(1);

  const room = roomRows[0];
  if (!room) return { ok: false, error: "房间不存在" };

  const memberRows = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)),
    )
    .limit(1);

  if (memberRows.length === 0) {
    return { ok: false, error: "你不在这个房间里" };
  }

  if (characterId) {
    const owned = await getOwnedCharacter(characterId, userId);
    if (!owned) return { ok: false, error: "这不是你的角色卡" };

    if (owned.status !== "ready") {
      return { ok: false, error: "先把这张卡建完再用" };
    }
  }

  await db
    .update(roomMembers)
    .set({ characterId })
    .where(
      and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)),
    );

  return { ok: true };
}

/** 某个人在某个房间用的是哪张卡，改 HP 之类的操作要先确认这个 */
export async function getRoomCharacterId(
  roomId: string,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ characterId: roomMembers.characterId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)),
    )
    .limit(1);

  return rows[0]?.characterId ?? null;
}

/**
 * 直接改当前生命值。
 *
 * 不走 saveCharacter：扣血是个高频动作，让它经过全字段校验没有意义，
 * 而且 saveCharacter 会重算 maxHp、处理升级差额，只会把简单的事搞复杂。
 * 这里只做一件事：把值夹在 0 和最大生命值之间，防止扣成负数。
 */
export async function setCharacterHp(
  characterId: string,
  currentHp: number,
): Promise<{ ok: true; currentHp: number } | { ok: false; error: string }> {
  const row = await getCharacterById(characterId);
  if (!row) return { ok: false, error: "找不到这张角色卡" };

  const maxHp = computeMaxHp(row.classKey, row.level, row.con, row.hpBonus);
  const next = Math.max(0, Math.min(maxHp, Math.round(currentHp)));

  await db
    .update(characters)
    .set({ currentHp: next, updatedAt: Date.now() })
    .where(eq(characters.id, characterId));

  return { ok: true, currentHp: next };
}

/**
 * 只改舞台形象。
 *
 * 刻意不走 saveCharacter，有两个理由：
 *
 * 1. 形象是纯展示，改了不影响任何数值平衡，所以它**不受阶段锁定**。
 *    进了「进行中」还能换张图，比永远定格在开局那一刻合理得多。
 * 2. 走 saveCharacter 会牵连属性、熟练、装备的全字段校验和 maxHp 重算，
 *    为了换一张头像去重算生命值上限，是没有意义的耦合。
 */
export async function saveCharacterPortrait(
  characterId: string,
  ownerId: string,
  rawPortrait: unknown,
): Promise<{ ok: true; portrait: Portrait } | { ok: false; error: string }> {
  const row = await getOwnedCharacter(characterId, ownerId);
  if (!row) return { ok: false, error: "找不到这张角色卡" };

  // 白名单校验在服务端做。客户端传来的东西永远不可信 ——
  // portrait.image 最终会变成 <img src>，不校验就等于把渲染层交给了请求体。
  //
  // fallback 用「这张卡当前的种子」而不是空字符串：万一某个字段非法，
  // 只把那一个字段退回原值，玩家不会因为改边框失败而发现自己的脸变了。
  const current = parsePortrait(row.portrait, row.name || row.id);
  const portrait = sanitizePortrait(rawPortrait, current.seed);

  await db
    .update(characters)
    .set({ portrait: JSON.stringify(portrait), updatedAt: Date.now() })
    .where(eq(characters.id, characterId));

  return { ok: true, portrait };
}

export type CharacterSnapshot = {
  userId: string;
  role: "dm" | "player";
  character: CharacterSummary | null;
};

/**
 * 房间角色卡的完整快照，按「谁该看到什么」裁剪后返回。
 *
 * viewerIsDm 决定别人那些卡是摘要还是详情。
 * 自己的卡永远是详情 —— 玩家要能看见自己的全部属性。
 */
export async function getRoomCharacterSnapshot(
  roomId: string,
  viewerId: string,
  viewerIsDm: boolean,
): Promise<CharacterSnapshot[]> {
  const members = await db
    .select({
      userId: roomMembers.userId,
      role: roomMembers.role,
      characterId: roomMembers.characterId,
      joinedAt: roomMembers.joinedAt,
    })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(asc(roomMembers.joinedAt));

  const snapshot: CharacterSnapshot[] = [];

  for (const member of members) {
    if (!member.characterId) {
      snapshot.push({
        userId: member.userId,
        role: member.role,
        character: null,
      });
      continue;
    }

    const row = await getCharacterById(member.characterId);
    if (!row) {
      snapshot.push({
        userId: member.userId,
        role: member.role,
        character: null,
      });
      continue;
    }

    // 本人和 DM 拿详情，其他人只拿摘要
    const canSeeDetail = member.userId === viewerId || viewerIsDm;
    snapshot.push({
      userId: member.userId,
      role: member.role,
      character: canSeeDetail ? toDetail(row) : toSummary(row),
    });
  }

  return snapshot;
}
