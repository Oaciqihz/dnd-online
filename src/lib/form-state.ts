/**
 * 表单 action 的返回类型。单独放一个文件，
 * 避免从 "use server" 模块里导出非函数内容（Next 对此有限制）。
 */
export type AuthState = { error: string | null };

export const initialAuthState: AuthState = { error: null };

/** 房间相关表单（建房 / 加入）的返回状态 */
export type RoomFormState = { error: string | null };

export const initialRoomState: RoomFormState = { error: null };

/** 踢人的返回状态。客户端只关心成功与否和失败原因 */
export type KickActionState = { ok: true } | { ok: false; error: string };
