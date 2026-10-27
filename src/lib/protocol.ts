import type { SessionUser } from "./session-store";

/**
 * 前后端共用的消息协议。
 * 服务端（server/index.ts）和客户端（React 组件）都从这里取类型，
 * 改字段时两边会同时报错，不会悄悄对不上。
 *
 * 注意：这个文件只放「类型」，不 import 任何运行时模块，
 * 否则会把服务端代码带进浏览器的包里。
 */

export type RoomRole = "dm" | "player";

/** 发给客户端的成员视角：在数据库字段基础上加了在线状态 */
export type RoomMemberView = {
  userId: string;
  displayName: string;
  kind: "guest" | "member";
  role: RoomRole;
  online: boolean;
};

export type RoomAck = { ok: true } | { ok: false; error: string };

export type ServerToClientEvents = {
  "session:ready": (payload: {
    user: SessionUser;
    serverTime: number;
  }) => void;

  /** 房间成员或在线状态变化时，广播给房间里所有人 */
  "room:state": (payload: {
    code: string;
    members: RoomMemberView[];
    serverTime: number;
  }) => void;

  /**
   * 被 DM 移出房间。
   * 服务端发完这条就把连接从房间频道里摘掉，所以客户端必须自己离开页面，
   * 否则会停在一个「已经看不到任何更新」的房间里。
   */
  "room:kicked": (payload: { code: string; reason: string }) => void;
};

export type ClientToServerEvents = {
  "ping:check": (ack?: (payload: { pong: number }) => void) => void;

  /** 订阅房间的实时通道（只允许已经是房间成员的人） */
  "room:join": (
    payload: { code: string },
    ack?: (result: RoomAck) => void,
  ) => void;

  "room:leave": (
    payload: { code: string },
    ack?: (result: RoomAck) => void,
  ) => void;
};

export type SocketData = {
  user: SessionUser;
  /** 这个连接当前订阅了哪些房间，断线时要据此广播离线 */
  joinedRooms: string[];
  /** 握手成功的时刻，排查连接泄漏时用来看每条连接活了多久 */
  connectedAt: number;
};
