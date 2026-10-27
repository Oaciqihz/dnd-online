/**
 * 两个进程之间通信用的固定参数。
 *
 * Next 进程和 Socket 进程不共享内存，Server Action 删完成员之后，
 * 必须再通过一次 HTTP 通知 Socket 进程「把这个人赶出房间」，
 * 否则对方的长连接还挂着，能继续收到房间里的消息。
 *
 * 这个文件刻意只放常量，不 import 任何 next/*，
 * 因为 Socket 进程（纯 Node）也要读同一份。
 */

/** 内部接口地址。Socket 进程监听的端口 */
export const SOCKET_HTTP_URL =
  process.env.SOCKET_HTTP_URL ?? "http://localhost:3001";

/**
 * 内部接口的口令。
 * 开发环境用固定默认值，两边能对上就行；
 * 上线前务必在环境变量里设置成随机串，否则任何人都能调这个接口踢人。
 */
export const INTERNAL_TOKEN =
  process.env.INTERNAL_TOKEN ?? "dev-internal-token";

export const INTERNAL_TOKEN_HEADER = "x-internal-token";
