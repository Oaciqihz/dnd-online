/**
 * 表单 action 的返回类型。单独放一个文件，
 * 避免从 "use server" 模块里导出非函数内容（Next 对此有限制）。
 */
import type { RoomPhase } from "./protocol";

export type AuthState = { error: string | null };

export const initialAuthState: AuthState = { error: null };

/** 房间相关表单（建房 / 加入）的返回状态 */
export type RoomFormState = { error: string | null };

export const initialRoomState: RoomFormState = { error: null };

/** 踢人的返回状态。客户端只关心成功与否和失败原因 */
export type KickActionState = { ok: true } | { ok: false; error: string };

/** 阶段推进的返回状态。成功时带回新的阶段，客户端可以直接更新横幅 */
export type RoomPhaseActionResult =
  | { ok: true; phase: RoomPhase }
  | { ok: false; error: string };

/** 切换就绪的返回状态 */
export type ReadyActionResult =
  | { ok: true; ready: boolean }
  | { ok: false; error: string };

/**
 * 换场景的返回状态。成功时带回校验后的整组值，客户端可以直接更新舞台。
 *
 * 一次带全 backgroundKey / backgroundImage / backgroundFit / sceneCaption，
 * 而不是只回传「成功」：这四个值共同决定舞台长什么样，
 * 少回一个就会让前端拿旧状态和数据库拼出一个不存在过的画面。
 */
export type SceneActionResult =
  | {
      ok: true;
      backgroundKey: string;
      backgroundImage: string;
      backgroundFit: "cover" | "contain";
      sceneCaption: string;
    }
  | { ok: false; error: string };

/**
 * 建卡向导提交的内容。
 *
 * 刻意在这里重新声明一遍而不是从 characters.ts 里 import：
 * 那个文件引了数据库，被客户端组件间接依赖会把 better-sqlite3
 * 一起拖进浏览器包。这里只放形状，不碰任何运行时。
 */
export type CharacterAbilities = {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
};

export type CharacterFormInput = {
  name: string;
  classKey: string;
  level: number;
  ancestry: string;
  background: string;
  alignment: string;
  abilities: CharacterAbilities;
  skills: string[];
  saves: string[];
  equipment: string;
  spells: string;
  features: string;
  backstory: string;
  notes: string;
  hpBonus: number;
  acOverride: number | null;
};

export type CharacterActionResult =
  | { ok: true }
  | { ok: false; error: string };
