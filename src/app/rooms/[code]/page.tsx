import Link from "next/link";
import { redirect } from "next/navigation";
import { joinRoomByCodeAction, leaveRoomAction } from "@/app/actions/rooms";
import { CopyRoomCode } from "@/components/copy-room-code";
import { RoomPresence } from "@/components/room-presence";
import { SocketStatus } from "@/components/socket-status";
import { getCurrentUser } from "@/lib/auth";
import {
  getRoomByCode,
  listRoomMembers,
  normalizeRoomCode,
  toMemberView,
} from "@/lib/rooms";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const room = await getRoomByCode(code);

  if (!room) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-16 text-center">
        <h1 className="font-serif text-2xl text-parchment">房间不存在</h1>
        <p className="mt-2.5 text-sm leading-relaxed text-stone-400">
          这个房间码可能写错了，或者房间已经被所有人离开了。
        </p>
        <Link
          href="/lobby"
          className="mt-7 inline-block w-full rounded-lg bg-ember-500 px-4 py-2.5 text-[15px] font-medium text-ink-950 transition hover:bg-ember-400"
        >
          回到大厅
        </Link>
      </main>
    );
  }

  const members = await listRoomMembers(room.id);
  const isMember = members.some((item) => item.userId === user.id);

  // 拿到链接但还没加入的人：给一个明确的加入入口，而不是直接踢回大厅
  if (!isMember) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-16">
        <p className="text-[12px] tracking-wide text-ember-400">房间邀请</p>
        <h1 className="mt-2 font-serif text-2xl text-parchment">
          {room.name}
        </h1>
        <p className="mt-2.5 text-sm leading-relaxed text-stone-400">
          房间里已经有 {members.length} 个人。加入后你就能看到实时成员列表。
        </p>

        <form action={joinRoomByCodeAction} className="mt-7">
          <input type="hidden" name="code" value={room.code} />
          <button
            type="submit"
            className="w-full rounded-lg bg-ember-500 px-4 py-2.5 text-[15px] font-medium text-ink-950 transition hover:bg-ember-400"
          >
            加入这个房间
          </button>
        </form>

        <Link
          href="/lobby"
          className="mt-3 block text-center text-[13px] text-stone-500 transition hover:text-ember-400"
        >
          回到大厅
        </Link>
      </main>
    );
  }

  const isHost = room.hostId === user.id;
  const initialMembers = members.map((row) =>
    toMemberView(row, new Set<string>()),
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10">
      <header className="flex items-center justify-between">
        <Link
          href="/lobby"
          className="inline-flex items-center gap-1.5 text-[13px] text-stone-500 transition hover:text-ember-400"
        >
          <span aria-hidden>←</span> 大厅
        </Link>

        <form action={leaveRoomAction}>
          <input type="hidden" name="code" value={room.code} />
          <button
            type="submit"
            className="rounded-lg border border-ink-700 px-3 py-1.5 text-[13px] text-stone-400 transition hover:border-red-900 hover:text-red-400"
          >
            离开房间
          </button>
        </form>
      </header>

      <section className="mt-6 flex flex-wrap items-start justify-between gap-4 rounded-xl border border-ink-800 bg-ink-900/40 p-5">
        <div className="min-w-0">
          <h1 className="truncate font-serif text-2xl text-parchment">
            {room.name}
          </h1>
          <p className="mt-1.5 text-[13px] text-stone-500">
            你的身份：{isHost ? "DM（房主）" : "玩家"}
          </p>
        </div>

        <div className="text-right">
          <p className="text-[11px] tracking-wide text-stone-600">房间码</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-[18px] tracking-[0.3em] text-ember-400">
              {room.code}
            </span>
            <CopyRoomCode code={room.code} />
          </div>
        </div>
      </section>

      <section className="mt-8">
        <RoomPresence
          code={room.code}
          selfId={user.id}
          initialMembers={initialMembers}
          canKick={isHost}
        />
      </section>

      <section className="mt-8 flex-1 rounded-xl border border-dashed border-ink-700 px-5 py-8 text-center">
        <p className="text-sm text-stone-500">聊天、掷骰、角色卡还没做</p>
        <p className="mt-1.5 text-[13px] text-stone-600">
          当前只实现了「建房间 + 凭码加入 + 实时成员列表」
        </p>
      </section>

      <footer className="mt-8 border-t border-ink-800 pt-4">
        <SocketStatus />
      </footer>
    </main>
  );
}
