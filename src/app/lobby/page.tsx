import { redirect } from "next/navigation";
import { logoutAction } from "@/app/actions/auth";
import { SocketStatus } from "@/components/socket-status";
import { getCurrentUser } from "@/lib/auth";

export default async function LobbyPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10">
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

        <form action={logoutAction}>
          <button
            type="submit"
            className="rounded-lg border border-ink-700 px-3 py-1.5 text-[13px] text-stone-400 transition hover:border-red-900 hover:text-red-400"
          >
            退出
          </button>
        </form>
      </header>

      <section className="mt-10 flex-1">
        <h1 className="font-serif text-2xl text-parchment">大厅</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-400">
          账号这一层已经打通。下一步这里会变成房间列表。
        </p>

        <div className="mt-7 rounded-xl border border-dashed border-ink-700 px-5 py-12 text-center">
          <p className="text-sm text-stone-500">还没有房间</p>
          <p className="mt-1.5 text-[13px] text-stone-600">
            创建房间和邀请朋友的功能在下一步实现
          </p>
        </div>
      </section>

      <footer className="mt-8 border-t border-ink-800 pt-4">
        <SocketStatus />
      </footer>
    </main>
  );
}
