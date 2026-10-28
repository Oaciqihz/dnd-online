import type { RoomPhase, RoomRole } from "./protocol";

/**
 * 房间阶段的权限判断，集中在这一层。
 *
 * 为什么要有这个文件：一旦开始用 phase 写 `if (room.phase === "playing")`，
 * 它就会散落到角色卡页、掷骰动作、Socket 广播、加入房间等十几个地方。
 * 三个月后你自己都不确定「进行中到底能不能改卡」。
 *
 * 这里的规则是：页面和 Server Action 都不直接读 phase，一律调这里。
 * 将来要加「DM 临时解锁某人改卡」这种例外，只改这一个文件。
 *
 * 这个模块不 import 任何 next/*，Socket 进程也能用。
 */

export type PhaseCapabilities = {
  /** 推进到「进行中」 */
  canStart: boolean;
  /** 推进到「已结束」 */
  canEnd: boolean;
  /** 从进行中退回准备 */
  canReopen: boolean;
  /** 切换自己的「我准备好了」 */
  canToggleReady: boolean;
  /** 更换这一局使用的角色卡 */
  canSwitchCharacter: boolean;
  /** 修改角色卡的属性、熟练、装备等（HP 与备注不在此列） */
  canEditCharacterFields: boolean;
  /** 调整生命值 */
  canAdjustHp: boolean;
  /** 切换舞台背景与场景描述 */
  canChangeScene: boolean;
  /** 移出其他成员 */
  canKick: boolean;
  /** 新成员能否加入（凭码进房间） */
  canJoin: boolean;
};

export function phaseCapabilities(input: {
  phase: RoomPhase;
  hostId: string;
  viewerId: string;
  /** null 表示这个人还不是房间成员 */
  viewerRole: RoomRole | null;
}): PhaseCapabilities {
  const isHost = input.hostId === input.viewerId;
  const isMember = input.viewerRole !== null;
  const { phase } = input;

  return {
    // 只有 DM 能推进阶段。玩家没有「开始」这个动作，
    // 他们按的是另一个东西：ready，一个纯信号。
    canStart: isHost && phase === "preparing",
    canEnd: isHost && phase === "playing",
    canReopen: isHost && (phase === "playing" || phase === "ended"),

    // DM 不需要举「我准备好了」，他自己就是决定的人
    canToggleReady: isMember && input.viewerRole === "player" && phase === "preparing",

    canSwitchCharacter: isMember && phase === "preparing",

    // 「只锁属性，HP 放行」的具体落地：
    // 属性、熟练、装备、等级这些在进入进行中之后就不让改了，
    // 因为改了等于中途换人。但 current_hp 必须随时能动 ——
    // DM 说「你受到 14 点伤害」，玩家当场就要扣血。
    canEditCharacterFields: isMember && phase === "preparing",
    canAdjustHp: isMember && phase !== "ended",

    // 换场景是叙事动作，属于 DM。结束之后没必要再换 ——
    // 那一局已经过去了，留着最后的场景当回放封面就行
    canChangeScene: isHost && isMember && phase !== "ended",

    canKick: isHost && isMember,
    canJoin: phase !== "ended",
  };
}

/** 阶段的中文标签，横幅和列表都用这个，避免各处写死字符串 */
export const PHASE_LABEL: Record<RoomPhase, string> = {
  preparing: "准备中",
  playing: "进行中",
  ended: "已结束",
};

export function phaseHint(phase: RoomPhase): string {
  switch (phase) {
    case "preparing":
      return "建角色卡、聊天等人。DM 宣布开始后属性会锁定";
    case "playing":
      return "属性已锁定，生命值和备注仍可修改";
    case "ended":
      return "本局已结束，所有内容只读";
  }
}
