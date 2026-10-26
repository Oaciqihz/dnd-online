import type { SessionUser } from "./session-store";

/**
 * 前后端共用的消息协议。
 * 服务端（server/index.ts）和客户端（React 组件）都从这里取类型，
 * 改字段时两边会同时报错，不会悄悄对不上。
 */

export type ServerToClientEvents = {
  "session:ready": (payload: {
    user: SessionUser;
    serverTime: number;
  }) => void;
};

export type ClientToServerEvents = {
  "ping:check": (ack?: (payload: { pong: number }) => void) => void;
};

export type SocketData = {
  user: SessionUser;
};
