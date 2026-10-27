"use client";

import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "./protocol";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type Registry = {
  socket: AppSocket | null;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * 状态挂在 globalThis 上，而不是模块作用域。
 *
 * Next 的开发模式会 Fast Refresh：改动任何文件，相关模块会被重新执行，
 * 模块级变量随之清空。如果 socket 只存在模块作用域里，重载之后就变成
 * 「变量没了、但连接还开着」的孤儿连接 —— 服务端一直算它在线上，
 * 新页面又建一条，来回几次「当前在线」就一路涨。
 *
 * 这和 db.ts 里 globalForDb 是同一个手法：跨模块重载保住同一份状态。
 * 生产构建不会热更新，这层保护等于没有额外成本。
 */
const globalForSocket = globalThis as unknown as {
  __dndSocketRegistry?: Registry;
};

const registry: Registry = globalForSocket.__dndSocketRegistry ?? {
  socket: null,
  refCount: 0,
  idleTimer: null,
};

globalForSocket.__dndSocketRegistry = registry;

/**
 * 没人用之后先挂 2 秒再断开，而不是立刻断。
 *
 * 「大厅 → 房间 → 大厅」这种连续导航里，上一个页面的组件正在卸载、
 * 下一个页面的组件马上挂载，中间空档只有几十毫秒。立刻 disconnect 的话，
 * 下一次 retain 又要重新握手；而握手是异步的，这时候再被切走，
 * 服务端就留下一条半开连接，要等心跳超时（几十秒）才回收。
 *
 * 留 2 秒缓冲，这类连续跳转全程复用同一条连接，压根不会断开重连。
 */
const IDLE_DISCONNECT_MS = 2000;

function socketUrl(): string {
  return process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3001";
}

/**
 * 所有组件共用的一条 Socket 连接。
 *
 * 为什么不让每个组件自己 io()：房间页同时挂着「连接状态」和「成员列表」
 * 两个组件，各建一条的话同一个人就占两条；来回导航会一路累积。
 */
export function retainSocket(): AppSocket {
  if (registry.idleTimer) {
    clearTimeout(registry.idleTimer);
    registry.idleTimer = null;
  }

  if (!registry.socket) {
    registry.socket = io(socketUrl(), { withCredentials: true });
  }

  registry.refCount += 1;
  return registry.socket;
}

export function releaseSocket(): void {
  registry.refCount = Math.max(0, registry.refCount - 1);
  if (registry.refCount > 0) return;

  if (registry.idleTimer) clearTimeout(registry.idleTimer);

  registry.idleTimer = setTimeout(() => {
    registry.idleTimer = null;
    if (registry.refCount > 0 || !registry.socket) return;

    registry.socket.disconnect();
    registry.socket = null;
  }, IDLE_DISCONNECT_MS);
}

/** 当前引用计数，排查连接泄漏时用 */
export function socketRefCount(): number {
  return registry.refCount;
}
