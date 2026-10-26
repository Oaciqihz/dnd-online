import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect("/lobby");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6 py-16">
      <span className="inline-flex w-fit items-center gap-2 rounded-full border border-ink-700 px-3 py-1 text-[12px] tracking-wide text-ember-400">
        <span className="h-1.5 w-1.5 rounded-full bg-ember-500" aria-hidden />
        多人跑团 · 建设中
      </span>

      <h1 className="mt-6 font-serif text-[34px] leading-[1.28] text-parchment">
        骰子落下之前，
        <br />
        谁也不知道结局。
      </h1>

      <p className="mt-4 text-[15px] leading-relaxed text-stone-400">
        建一个房间，把朋友拉进来。
        <br />
        先用游客身份试试，不用注册。
      </p>

      <div className="mt-9 space-y-3">
        <Link
          href="/guest"
          className="block w-full rounded-lg bg-ember-500 px-4 py-3 text-center text-[15px] font-medium text-ink-950 transition hover:bg-ember-400"
        >
          以游客身份进入
        </Link>

        <Link
          href="/login"
          className="block w-full rounded-lg border border-ink-700 px-4 py-3 text-center text-[15px] font-medium text-parchment transition hover:border-ember-600 hover:text-ember-400"
        >
          登录已有账号
        </Link>
      </div>

      <p className="mt-7 text-center text-[13px] text-stone-600">
        还没有账号？
        <Link
          href="/register"
          className="ml-1 text-ember-400 transition hover:underline"
        >
          注册一个
        </Link>
      </p>
    </main>
  );
}
