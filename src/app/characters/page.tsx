import Link from "next/link";
import { redirect } from "next/navigation";
import { createCharacterAction } from "@/app/actions/characters";
import { getCurrentUser } from "@/lib/auth";
import { listCharactersByOwner, toSummary } from "@/lib/characters";

export default async function CharactersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { error } = await searchParams;
  const rows = await listCharactersByOwner(user.id);
  const list = rows.map(toSummary);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10">
      <header className="flex items-center justify-between">
        <Link
          href="/lobby"
          className="inline-flex items-center gap-1.5 text-[13px] text-stone-500 transition hover:text-ember-400"
        >
          <span aria-hidden>←</span> 大厅
        </Link>
      </header>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl text-parchment">我的角色卡</h1>
          <p className="mt-1.5 text-[13px] text-stone-500">
            角色卡跟着账号走，换个房间还能继续用
          </p>
        </div>

        <form action={createCharacterAction}>
          <button
            type="submit"
            className="rounded-lg bg-ember-500 px-4 py-2 text-[14px] font-medium text-ink-950 transition hover:bg-ember-400"
          >
            新建角色
          </button>
        </form>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-[13px] leading-relaxed text-red-300"
        >
          {error}
        </p>
      ) : null}

      {list.length === 0 ? (
        <section className="mt-8 rounded-xl border border-dashed border-ink-700 px-5 py-14 text-center">
          <p className="text-sm text-stone-500">还没有角色卡</p>
          <p className="mt-1.5 text-[13px] text-stone-600">
            建一张卡，就能带进房间跑了
          </p>
        </section>
      ) : (
        <ul className="mt-8 grid gap-3">
          {list.map((item) => (
            <li key={item.id}>
              <Link
                href={`/characters/${item.id}`}
                className="block rounded-xl border border-ink-800 bg-ink-900/40 p-4 transition hover:border-ember-600"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="truncate font-serif text-lg text-parchment">
                    {item.name || "未命名角色"}
                  </h2>

                  {item.status === "draft" ? (
                    <span className="shrink-0 rounded border border-ink-700 px-2 py-0.5 text-[11px] text-stone-500">
                      草稿
                    </span>
                  ) : null}
                </div>

                <p className="mt-1 text-[13px] text-stone-500">
                  {item.className} · {item.level} 级
                  {item.ancestry ? ` · ${item.ancestry}` : ""}
                </p>

                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-stone-400">
                  <span>
                    生命 {item.currentHp}/{item.maxHp}
                  </span>
                  <span>AC {item.ac}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-[12px] leading-relaxed text-stone-600">
        {user.kind === "guest"
          ? "你现在是游客身份，换浏览器或会话过期后这些角色卡会找不回来。"
          : `已登录为 ${user.displayName}，角色卡会永久保存。`}
      </p>
    </main>
  );
}
