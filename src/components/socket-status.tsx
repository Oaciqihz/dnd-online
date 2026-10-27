"use client";

import { useEffect, useState } from "react";
import { releaseSocket, retainSocket } from "@/lib/socket-client";

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
    const socket = retainSocket();

    const onConnect = () => setState("online");
    const onDisconnect = () => setState("offline");
    const onError = (error: Error) => {
      setState(error.message === "unauthorized" ? "unauthorized" : "offline");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onError);

    // 复用已有连接时不会再触发一次 connect，状态得自己读一次
    if (socket.connected) setState("online");

    return () => {
      // 只摘掉自己注册的监听。共用连接时用 removeAllListeners
      // 会把别的组件的监听一起清掉，这是这类重构最容易踩的坑
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onError);
      releaseSocket();
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
