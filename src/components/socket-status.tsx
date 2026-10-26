"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";

type ConnState = "connecting" | "online" | "offline" | "unauthorized";

const LABEL: Record<ConnState, string> = {
  connecting: "正在连接实时服务…",
  online: "实时服务已连接",
  offline: "实时服务未连接",
  unauthorized: "实时服务拒绝了会话",
};

const DOT: Record<ConnState, string> = {
  connecting: "bg-stone-500",
  online: "bg-emerald-500",
  offline: "bg-red-500",
  unauthorized: "bg-amber-500",
};

export function SocketStatus() {
  const [state, setState] = useState<ConnState>("connecting");

  useEffect(() => {
    const url =
      process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3001";

    const socket = io(url, { withCredentials: true });

    socket.on("connect", () => setState("online"));
    socket.on("disconnect", () => setState("offline"));
    socket.on("connect_error", (error) => {
      setState(error.message === "unauthorized" ? "unauthorized" : "offline");
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-stone-500">
      <span className={`h-2 w-2 rounded-full ${DOT[state]}`} aria-hidden />
      <span>{LABEL[state]}</span>
      {state === "offline" ? (
        <span className="text-stone-600">
          · 确认 dev 里的 socket 进程已启动
        </span>
      ) : null}
    </div>
  );
}
