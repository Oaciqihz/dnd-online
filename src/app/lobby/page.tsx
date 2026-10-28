import Link from "next/link";
import { redirect } from "next/navigation";
import { logoutAction } from "@/app/actions/auth";
import { CreateRoomForm } from "@/components/create-room-form";
import { JoinRoomForm } from "@/components/join-room-form";
import { SocketStatus } from "@/components/socket-status";
import { getCurrentUser } from "@/lib/auth";
import { listRoomsForUser } from "@/lib/rooms";

export default async function LobbyPage({
  searchParams,
}: {
  searchParams: Promise<{ joinError?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { joinError } = await searchParams;
  const myRooms = await listRoomsForUser(user.id);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 py-10">
      <header className="flex items-center justify-between border-b border-ink-800 pb-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-ink-700 bg-ink-900 font-serif text-lg text-ember-400">
            {user.displayName.slice(0, 1)}
          </div>
          <div>
            <p className="text-[15px] text-parchment">{user.displayName}</p>
            <p className="text-[12px] text-stone-500">
              {user.kind === "guest" ? "游客身份" : `@${user.username}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/characters"
            className="rounded-lg border border-ink-700 px-3 py-1.5 text-[13px] text-stone-400 transition hover:border-ember-600 hover:text-ember-400"
          >
            我的角色卡
          </Link>

          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-lg border border-ink-700 px-3 py-1.5 text-[13px] text-stone-400 transition hover:border-red-900 hover:text-red-400"
            >
              退出
            </button>
          </form>
        </div>
      </header>

      <section className="mt-9">
        <h1 className="font-serif text-2xl text-parchment">大厅</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-400">
          开一个房间当 DM，或者用朋友给你的房间码加入。
        </p>

        {joinError ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-[13px] text-red-300"
          >
            {joinError}
          </p>
        ) : null}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-5">
            <h2 className="text-[14px] font-medium text-parchment">
              创建房间
            </h2>
            <p className="mt-1 mb-4 text-[12px] leading-relaxed text-stone-500">
              你会成为这个房间的 DM，拿到一个 6 位房间码发给朋友。
            </p>
            <CreateRoomForm />
          </div>

          <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-5">
            <h2 className="text-[14px] font-medium text-parchment">
              加入房间
            </h2>
            <p className="mt-1 mb-4 text-[12px] leading-relaxed text-stone-500">
              输入朋友给你的房间码，直接进他的房间。
            </p>
            <JoinRoomForm />
          </div>
        </div>
      </section>

      <section className="mt-10 flex-1">
        <h2 className="text-[13px] font-medium tracking-wide text-stone-400">
          我参与的房间
          <span className="ml-2 text-stone-600">{myRooms.length}</span>
        </h2>

        {myRooms.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-ink-700 px-5 py-10 text-center">
            <p className="text-sm text-stone-500">还没有加入任何房间</p>
            <p className="mt-1.5 text-[13px] text-stone-600">
              上面创建或加入一个，就会出现在这里
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {myRooms.map((room) => (
              <li key={room.id}>
                <Link
                  href={`/rooms/${room.code}`}
                  className="flex items-center justify-between rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3 transition hover:border-ember-600/60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] text-parchment">
                      {room.name}
                    </span>
                    <span className="mt-0.5 block font-mono text-[12px] tracking-[0.2em] text-stone-500">
                      {room.code}
                    </span>
                  </span>

                  <span className="ml-4 shrink-0 text-[12px] text-stone-500">
                    {room.hostId === user.id ? "你是 DM" : "玩家"}
                    <span className="mx-1.5 text-stone-700">·</span>
                    进入
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-10 border-t border-ink-800 pt-4">
        <SocketStatus />
      </footer>
    </main>
  );
}
