"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { kickMemberAction } from "@/app/actions/rooms";
import { releaseSocket, retainSocket } from "@/lib/socket-client";
import type { RoomMemberView } from "@/lib/protocol";

type Props = {
  code: string;
  selfId: string;
  initialMembers: RoomMemberView[];
  /** 只有 DM（房主）能看到「移出」按钮 */
  canKick: boolean;
};

type ConnState = "connecting" | "online" | "offline";

const STATUS_LABEL: Record<ConnState, string> = {
  connecting: "连接中…",
  online: "实时同步中",
  offline: "连接已断开",
};

const STATUS_DOT: Record<ConnState, string> = {
  connecting: "bg-stone-500",
  online: "bg-emerald-500",
  offline: "bg-red-500",
};

export function RoomPresence({ code, selfId, initialMembers, canKick }: Props) {
  const [members, setMembers] = useState<RoomMemberView[]>(initialMembers);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [kicked, setKicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** 第一次点击只是「上膛」，再点一次才真的踢出去，避免误触 */
  const [armingId, setArmingId] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const socket = retainSocket();

    const subscribe = () => {
      socket.emit("room:join", { code });
    };

    const onConnect = () => {
      setConn("online");
      subscribe();
    };
    const onDisconnect = () => setConn("offline");
    const onError = () => setConn("offline");

    const onState = (payload: {
      code: string;
      members: RoomMemberView[];
      serverTime: number;
    }) => {
      if (payload.code === code) setMembers(payload.members);
    };

    // 被 DM 移出：服务端已经把我的连接从房间频道摘掉了，这里只能自己走
    const onKicked = (payload: { code: string; reason: string }) => {
      if (payload.code === code) setKicked(payload.reason);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onError);
    socket.on("room:state", onState);
    socket.on("room:kicked", onKicked);

    // 复用已有连接时不会再触发 connect，要主动补一次订阅
    if (socket.connected) {
      setConn("online");
      subscribe();
    }

    return () => {
      socket.emit("room:leave", { code });
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onError);
      socket.off("room:state", onState);
      socket.off("room:kicked", onKicked);
      releaseSocket();
    };
  }, [code]);

  useEffect(() => {
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, []);

  function arm(userId: string) {
    setError(null);
    setArmingId(userId);

    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => setArmingId(null), 4000);
  }

  function kick(userId: string) {
    // 第二下才真踢
    if (armingId !== userId) {
      arm(userId);
      return;
    }

    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setArmingId(null);

    startTransition(async () => {
      const result = await kickMemberAction({ code, userId });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      // 乐观移除：万一实时通道正好断着，自己的列表也不会停在旧状态
      setMembers((prev) => prev.filter((item) => item.userId !== userId));
    });
  }

  if (kicked) {
    return (
      <section className="rounded-xl border border-red-900/60 bg-red-950/20 px-5 py-8 text-center">
        <h2 className="font-serif text-xl text-parchment">你已被移出房间</h2>
        <p className="mt-2 text-sm text-stone-400">{kicked}</p>
        <Link
          href="/lobby"
          className="mt-6 inline-block rounded-lg bg-ember-500 px-4 py-2.5 text-[14px] font-medium text-ink-950 transition hover:bg-ember-400"
        >
          回到大厅
        </Link>
      </section>
    );
  }

  const onlineCount = members.filter((m) => m.online).length;

  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-medium tracking-wide text-stone-400">
          房间里的人
          <span className="ml-2 text-stone-600">
            {onlineCount}/{members.length} 在线
          </span>
        </h2>

        <span className="flex items-center gap-1.5 text-[12px] text-stone-500">
          <span
            className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[conn]}`}
            aria-hidden
          />
          {STATUS_LABEL[conn]}
        </span>
      </div>

      <ul className="mt-3 space-y-1.5">
        {members.map((member) => (
          <li
            key={member.userId}
            className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2.5"
          >
            <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-850 font-serif text-[13px] text-ember-400">
              {member.displayName.slice(0, 1)}
              <span
                className={`absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border-2 border-ink-900 ${
                  member.online ? "bg-emerald-500" : "bg-stone-600"
                }`}
                aria-hidden
              />
            </span>

            <span className="min-w-0 flex-1 truncate text-[14px] text-parchment">
              {member.displayName}
              {member.userId === selfId ? (
                <span className="ml-1.5 text-[12px] text-stone-500">（你）</span>
              ) : null}
            </span>

            {member.role === "dm" ? (
              <span className="rounded border border-ember-600/60 bg-ember-600/10 px-1.5 py-0.5 text-[11px] text-ember-400">
                DM
              </span>
            ) : (
              <span className="rounded border border-ink-700 px-1.5 py-0.5 text-[11px] text-stone-500">
                玩家
              </span>
            )}

            {canKick && member.userId !== selfId && member.role !== "dm" ? (
              <button
                type="button"
                onClick={() => kick(member.userId)}
                disabled={pending}
                className={`rounded border px-2 py-0.5 text-[11px] transition disabled:opacity-50 ${
                  armingId === member.userId
                    ? "border-red-700 bg-red-900/40 text-red-300"
                    : "border-ink-700 text-stone-500 hover:border-red-900 hover:text-red-400"
                }`}
              >
                {armingId === member.userId ? "确认移出" : "移出"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {error ? (
        <p className="mt-2 text-[12px] text-red-400">{error}</p>
      ) : null}

      {conn === "offline" ? (
        <p className="mt-2 text-[12px] text-stone-600">
          实时通道断开，成员列表不会自动更新 · 确认 socket 进程已启动
        </p>
      ) : null}
    </section>
  );
}
