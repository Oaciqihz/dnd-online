import Link from "next/link";
import { redirect } from "next/navigation";
import { DeleteCharacterButton } from "@/components/delete-character-button";
import { CharacterWizard } from "@/components/character-wizard";
import { PortraitEditor } from "@/components/portrait-editor";
import { getCurrentUser } from "@/lib/auth";
import { getOwnedCharacter } from "@/lib/characters";
import { findLockingRoom } from "@/lib/rooms";
import { parsePortrait } from "@/lib/portrait";
import type { CharacterFormInput } from "@/lib/form-state";
import { parseJsonArray, type AbilityKey } from "@/lib/rules";

export default async function CharacterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // 带属主校验的读取：换个 URL 也打不开别人的卡
  const row = await getOwnedCharacter(id, user.id);

  if (!row) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-16 text-center">
        <h1 className="font-serif text-2xl text-parchment">找不到这张角色卡</h1>
        <p className="mt-2.5 text-sm leading-relaxed text-stone-400">
          可能已经被删掉了，或者这张卡不属于当前账号。
        </p>
        <Link
          href="/characters"
          className="mt-7 inline-block w-full rounded-lg bg-ember-500 px-4 py-2.5 text-[15px] font-medium text-ink-950 transition hover:bg-ember-400"
        >
          回到角色卡
        </Link>
      </main>
    );
  }

  // 这张卡是否正被一个「进行中」的房间占用。占用时属性锁定，
  // 但生命值仍然能在房间里改 —— 战斗扣血不能等。
  const lock = await findLockingRoom(row.id);

  const initial: CharacterFormInput = {
    name: row.name,
    classKey: row.classKey,
    level: row.level,
    ancestry: row.ancestry,
    background: row.background,
    alignment: row.alignment,
    abilities: {
      str: row.str,
      dex: row.dex,
      con: row.con,
      int: row.int,
      wis: row.wis,
      cha: row.cha,
    },
    skills: parseJsonArray(row.skills),
    saves: parseJsonArray(row.saves) as AbilityKey[],
    equipment: row.equipment,
    spells: row.spells,
    features: row.features,
    backstory: row.backstory,
    notes: row.notes,
    hpBonus: row.hpBonus,
    acOverride: row.acOverride,
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10">
      <header className="flex items-center justify-between">
        <Link
          href="/characters"
          className="inline-flex items-center gap-1.5 text-[13px] text-stone-500 transition hover:text-ember-400"
        >
          <span aria-hidden>←</span> 我的角色卡
        </Link>

        {row.status === "ready" ? (
          <span className="rounded border border-ink-700 px-2 py-0.5 text-[11px] text-stone-500">
            可带入房间
          </span>
        ) : (
          <span className="rounded border border-ember-600/50 px-2 py-0.5 text-[11px] text-ember-400">
            草稿
          </span>
        )}
      </header>

      <h1 className="mt-6 font-serif text-2xl text-parchment">
        {row.name || "新角色"}
      </h1>

      {lock ? (
        <div className="mt-6 rounded-xl border border-amber-800/50 bg-amber-950/20 px-4 py-3">
          <p className="text-[13px] text-amber-300">
            属性已锁定 · 这张卡正在「{lock.name}」里进行游戏
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-stone-500">
            属性、熟练、装备都不能再改 —— 那等于中途把角色换了一个人。
            生命值和备注仍然可以在房间里调整。
          </p>
          <Link
            href={`/rooms/${lock.code}`}
            className="mt-2 inline-block text-[12px] text-ember-400 transition hover:text-ember-300"
          >
            回到房间 →
          </Link>
        </div>
      ) : null}

      {/*
        用一个 disabled 的 fieldset 把整个向导锁住。
        fieldset 会自动禁用内部所有表单控件，不需要给每个 input 单独加
        disabled —— 那样一旦新增字段漏了就漏了，而且很容易改错。
      */}
      <fieldset
        disabled={Boolean(lock)}
        className={`mt-6 min-w-0 border-0 p-0 ${lock ? "opacity-60" : ""}`}
      >
        <CharacterWizard
          characterId={row.id}
          initial={initial}
          isDraft={row.status === "draft"}
        />
      </fieldset>

      {/*
        形象编辑刻意放在 fieldset 外面。
        进行中的房间会锁住属性和装备，但换张脸不影响任何数值平衡，
        把它一起锁了只会让人困惑「凭什么不能改头像」。
      */}
      <section className="mt-10 rounded-xl border border-ink-800 bg-ink-900/40 p-5">
        <h2 className="text-[13px] font-medium tracking-wide text-stone-400">
          舞台形象
        </h2>
        <p className="mt-1 text-[12px] text-stone-600">
          开始游戏后，这个圆形棋子会摆在房间的舞台上
        </p>

        <div className="mt-4">
          <PortraitEditor
            characterId={row.id}
            initialPortrait={parsePortrait(row.portrait, row.name || row.id)}
            characterName={row.name}
          />
        </div>
      </section>

      <footer className="mt-10 border-t border-ink-800 pt-5">
        <DeleteCharacterButton id={row.id} />
      </footer>
    </main>
  );
}
