/**
 * 表单 action 的返回类型。单独放一个文件，
 * 避免从 "use server" 模块里导出非函数内容（Next 对此有限制）。
 */
export type AuthState = { error: string | null };

export const initialAuthState: AuthState = { error: null };
