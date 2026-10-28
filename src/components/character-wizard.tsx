"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveCharacterAction } from "@/app/actions/characters";
import {
  ABILITIES,
  CLASSES,
  deriveCharacter,
  formatModifier,
  SKILLS,
  STANDARD_ARRAY,
  type AbilityKey,
} from "@/lib/rules";
import type { CharacterFormInput } from "@/lib/form-state";
import { FormError, inputClass, labelClass } from "@/components/ui";

const STEPS = ["基础", "属性", "熟练", "装备", "确认"] as const;

const ANCESTRIES = [
  "人类",
  "精灵",
  "矮人",
  "半身人",
  "龙裔",
  "侏儒",
  "半精灵",
  "半兽人",
  "提夫林",
];

const ALIGNMENTS = [
  "守序善良",
  "中立善良",
  "混乱善良",
  "守序中立",
  "绝对中立",
  "混乱中立",
  "守序邪恶",
  "中立邪恶",
  "混乱邪恶",
];

/**
 * 建卡向导。
 *
 * 为什么要分步而不是一屏塞完：第一次接触 DnD 的人看到三十个字段会直接关掉页面。
 * 分五步之后，每一步只需要回答一个问题，而且每步都有即时的计算反馈 ——
 * 属性一改，生命值和 AC 立刻跟着变，玩家能看见自己的选择有影响。
 *
 * 每点「下一步」都会真的写一次库，所以中途关掉浏览器不会白填。
 */
export function CharacterWizard({
  characterId,
  initial,
  isDraft,
}: {
  characterId: string;
  initial: CharacterFormInput;
  isDraft: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<CharacterFormInput>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 客户端算的这份只用来做预览，保存时服务端会用同一份 rules.ts 重算并落库
  const derived = deriveCharacter({
    classKey: form.classKey,
    level: form.level,
    abilities: form.abilities,
    skills: form.skills,
    saves: form.saves as AbilityKey[],
    hpBonus: form.hpBonus,
    acOverride: form.acOverride,
  });

  const abilityTotal = ABILITIES.reduce(
    (sum, item) => sum + (form.abilities[item.key] ?? 10),
    0,
  );

  function patch(update: Partial<CharacterFormInput>) {
    setForm((prev) => ({ ...prev, ...update }));
  }

  function setAbility(key: AbilityKey, value: number) {
    const next = Number.isFinite(value) ? Math.min(20, Math.max(3, value)) : 10;
    setForm((prev) => ({
      ...prev,
      abilities: { ...prev.abilities, [key]: next },
    }));
  }

  function toggleSkill(key: string) {
    setForm((prev) => ({
      ...prev,
      skills: prev.skills.includes(key)
        ? prev.skills.filter((item) => item !== key)
        : [...prev.skills, key],
    }));
  }

  function toggleSave(key: AbilityKey) {
    setForm((prev) => ({
      ...prev,
      saves: prev.saves.includes(key)
        ? prev.saves.filter((item) => item !== key)
        : [...prev.saves, key],
    }));
  }

  /**
   * 保存并跳到目标步骤。传 6 表示「完成建卡」。
   *
   * 顺序有意为之：先写库再切界面。
   * 反过来会出现「界面已经到了下一步，但数据没存上」的错觉。
   */
  async function goTo(next: number) {
    if (pending) return;

    setPending(true);
    setError(null);

    const result = await saveCharacterAction({
      id: characterId,
      data: form,
      finalize: next > STEPS.length,
    });

    setPending(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    if (next > STEPS.length) {
      router.push("/characters");
      return;
    }

    setStep(next);
  }

  return (
    <div>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-[12px]">
        {STEPS.map((label, index) => {
          const number = index + 1;
          const active = number === step;
          const done = number < step;

          return (
            <li key={label} className="flex items-center gap-1.5">
              <span
                className={[
                  "flex h-5 w-5 items-center justify-center rounded-full border text-[11px]",
                  active
                    ? "border-ember-500 bg-ember-500 text-ink-950"
                    : done
                      ? "border-ember-600 text-ember-400"
                      : "border-ink-700 text-stone-600",
                ].join(" ")}
              >
                {number}
              </span>
              <span
                className={
                  active
                    ? "text-parchment"
                    : done
                      ? "text-ember-400"
                      : "text-stone-600"
                }
              >
                {label}
              </span>
              {number < STEPS.length ? (
                <span className="mx-1 text-ink-700" aria-hidden>
                  ·
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="mt-6 rounded-xl border border-ink-800 bg-ink-900/40 p-5">
        {step === 1 ? (
          <StepBasics form={form} patch={patch} derived={derived} />
        ) : null}

        {step === 2 ? (
          <StepAbilities
            form={form}
            patch={patch}
            setAbility={setAbility}
            derived={derived}
            abilityTotal={abilityTotal}
          />
        ) : null}

        {step === 3 ? (
          <StepProficiencies
            form={form}
            toggleSkill={toggleSkill}
            toggleSave={toggleSave}
          />
        ) : null}

        {step === 4 ? <StepText form={form} patch={patch} /> : null}

        {step === 5 ? <StepConfirm form={form} derived={derived} /> : null}
      </div>

      <div className="mt-3">
        <FormError message={error} />
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => goTo(step - 1)}
          disabled={step === 1 || pending}
          className="rounded-lg border border-ink-700 px-4 py-2 text-[14px] text-stone-400 transition hover:border-ink-700 hover:text-parchment disabled:cursor-not-allowed disabled:opacity-40"
        >
          上一步
        </button>

        <button
          type="button"
          onClick={() => goTo(step + 1)}
          disabled={pending}
          className="flex-1 rounded-lg bg-ember-500 px-4 py-2 text-[15px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending
            ? "保存中…"
            : step === STEPS.length
              ? isDraft
                ? "完成建卡"
                : "保存修改"
              : "保存并继续"}
        </button>
      </div>

      <p className="mt-3 text-center text-[12px] text-stone-600">
        每一步都会自动保存，中途关掉页面下次还能接着填
      </p>
    </div>
  );
}

type BaseProps = { form: CharacterFormInput };

type StepProps = BaseProps & {
  patch: (update: Partial<CharacterFormInput>) => void;
};

type DerivedProps = { derived: ReturnType<typeof deriveCharacter> };

function StepBasics({
  form,
  patch,
  derived,
}: StepProps & DerivedProps) {
  function applyStandardArray() {
    const values: number[] = [...STANDARD_ARRAY];
    const next = { ...form.abilities };

    ABILITIES.forEach((item, index) => {
      next[item.key] = values[index] ?? 10;
    });

    patch({ abilities: next });
  }

  return (
    <div className="space-y-5">
      <div>
        <label className={labelClass} htmlFor="char-name">
          角色名字
        </label>
        <input
          id="char-name"
          value={form.name}
          maxLength={40}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder="比如：灰羽、罗兰爵士"
          className={inputClass}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="char-class">
            职业
          </label>
          <select
            id="char-class"
            value={form.classKey}
            onChange={(event) => patch({ classKey: event.target.value })}
            className={inputClass}
          >
            {CLASSES.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}（d{item.hitDie}）
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="char-level">
            等级
          </label>
          <input
            id="char-level"
            type="number"
            min={1}
            max={20}
            value={form.level}
            onChange={(event) =>
              patch({
                level: Math.min(20, Math.max(1, Number(event.target.value) || 1)),
              })
            }
            className={inputClass}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="char-ancestry">
            种族
          </label>
          <select
            id="char-ancestry"
            value={form.ancestry}
            onChange={(event) => patch({ ancestry: event.target.value })}
            className={inputClass}
          >
            <option value="">暂不选择</option>
            {ANCESTRIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="char-alignment">
            阵营
          </label>
          <select
            id="char-alignment"
            value={form.alignment}
            onChange={(event) => patch({ alignment: event.target.value })}
            className={inputClass}
          >
            <option value="">暂不选择</option>
            {ALIGNMENTS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor="char-background">
          背景
        </label>
        <input
          id="char-background"
          value={form.background}
          maxLength={40}
          onChange={(event) => patch({ background: event.target.value })}
          placeholder="比如：士兵、学徒、流浪儿"
          className={inputClass}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-ink-800 pt-4 text-[13px] text-stone-400">
        <span>
          生命上限 <span className="text-parchment">{derived.maxHp}</span>
        </span>
        <span>
          AC <span className="text-parchment">{derived.ac}</span>
        </span>
        <span>
          熟练加值{" "}
          <span className="text-parchment">
            {formatModifier(derived.proficiencyBonus)}
          </span>
        </span>
      </div>

      <button
        type="button"
        onClick={applyStandardArray}
        className="text-[13px] text-ember-400 transition hover:text-ember-300"
      >
        先套一组标准属性（15/14/13/12/10/8），下一步再调
      </button>
    </div>
  );
}

function StepAbilities({
  form,
  patch,
  setAbility,
  derived,
  abilityTotal,
}: StepProps & DerivedProps & {
  setAbility: (key: AbilityKey, value: number) => void;
  abilityTotal: number;
}) {
  const overBudget = abilityTotal > 72;

  return (
    <div>
      <p className="text-[13px] leading-relaxed text-stone-400">
        标准阵列六项加起来是 72 点。超过这个数不算错，但多数团会要求解释来源。
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {ABILITIES.map((item) => (
          <div
            key={item.key}
            className="flex items-center gap-3 rounded-lg border border-ink-800 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-parchment">{item.label}</p>
              <p className="text-[11px] text-stone-600">{item.short}</p>
            </div>

            <input
              type="number"
              min={3}
              max={20}
              value={form.abilities[item.key]}
              onChange={(event) => setAbility(item.key, Number(event.target.value))}
              className="w-16 rounded-md border border-ink-700 bg-ink-950/60 px-2 py-1.5 text-center text-[15px] text-parchment outline-none focus:border-ember-500"
            />

            <span className="w-9 text-right font-mono text-[14px] text-ember-400">
              {formatModifier(derived.modifiers[item.key])}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ink-800 pt-4 text-[13px]">
        <span className={overBudget ? "text-ember-400" : "text-stone-500"}>
          合计 {abilityTotal} 点{overBudget ? "（高于标准阵列 72）" : ""}
        </span>

        <div className="flex gap-4 text-stone-400">
          <span>
            生命上限 <span className="text-parchment">{derived.maxHp}</span>
          </span>
          <span>
            先攻{" "}
            <span className="text-parchment">
              {formatModifier(derived.initiative)}
            </span>
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-4 border-t border-ink-800 pt-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="char-hpbonus">
            额外生命值
          </label>
          <input
            id="char-hpbonus"
            type="number"
            value={form.hpBonus}
            onChange={(event) =>
              patch({ hpBonus: Number(event.target.value) || 0 })
            }
            className={inputClass}
          />
          <span className="mt-1.5 block text-[12px] text-stone-600">
            专长、种族特性给的加值，没有就填 0
          </span>
        </div>

        <div>
          <label className={labelClass} htmlFor="char-ac">
            护甲等级（AC）
          </label>
          <input
            id="char-ac"
            type="number"
            min={1}
            max={40}
            value={form.acOverride ?? ""}
            placeholder={`自动：${10 + derived.modifiers.dex}`}
            onChange={(event) =>
              patch({
                acOverride: event.target.value ? Number(event.target.value) : null,
              })
            }
            className={inputClass}
          />
          <span className="mt-1.5 block text-[12px] text-stone-600">
            留空按「10 + 敏捷调整」算，穿了甲就填实际值
          </span>
        </div>
      </div>
    </div>
  );
}

function StepProficiencies({
  form,
  toggleSkill,
  toggleSave,
}: BaseProps & {
  toggleSkill: (key: string) => void;
  toggleSave: (key: AbilityKey) => void;
}) {
  return (
    <div>
      <p className="text-[13px] leading-relaxed text-stone-400">
        勾上你熟练的项。熟练项会在判定时额外加上熟练加值，具体能选几个由职业决定。
      </p>

      <div className="mt-5">
        <p className={labelClass}>豁免熟练</p>
        <div className="flex flex-wrap gap-2">
          {ABILITIES.map((item) => {
            const active = form.saves.includes(item.key);
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => toggleSave(item.key)}
                className={[
                  "rounded-lg border px-3 py-1.5 text-[13px] transition",
                  active
                    ? "border-ember-500 bg-ember-500/15 text-ember-400"
                    : "border-ink-700 text-stone-400 hover:border-ink-700 hover:text-parchment",
                ].join(" ")}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-6">
        <p className={labelClass}>
          技能熟练
          <span className="ml-2 font-normal text-stone-600">
            已选 {form.skills.length} 项
          </span>
        </p>

        <div className="space-y-3">
          {ABILITIES.map((ability) => {
            const group = SKILLS.filter((item) => item.ability === ability.key);
            if (group.length === 0) return null;

            return (
              <div key={ability.key}>
                <p className="mb-1.5 text-[11px] tracking-wide text-stone-600">
                  {ability.label}
                </p>

                <div className="flex flex-wrap gap-2">
                  {group.map((skill) => {
                    const active = form.skills.includes(skill.key);
                    return (
                      <button
                        key={skill.key}
                        type="button"
                        onClick={() => toggleSkill(skill.key)}
                        className={[
                          "rounded-lg border px-3 py-1.5 text-[13px] transition",
                          active
                            ? "border-ember-500 bg-ember-500/15 text-ember-400"
                            : "border-ink-700 text-stone-400 hover:text-parchment",
                        ].join(" ")}
                      >
                        {skill.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StepText({ form, patch }: StepProps) {
  const fields: Array<{
    key: keyof Pick<
      CharacterFormInput,
      "equipment" | "spells" | "features" | "backstory" | "notes"
    >;
    label: string;
    hint: string;
  }> = [
    { key: "equipment", label: "装备", hint: "武器、护甲、随身物品，随便写" },
    { key: "spells", label: "法术", hint: "已知或准备的法术，戏法也算" },
    { key: "features", label: "职业特性", hint: "职业和种族给的特性" },
    { key: "backstory", label: "背景故事", hint: "他为什么在冒险" },
    { key: "notes", label: "备注", hint: "私人的东西，DM 也看得到" },
  ];

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-stone-400">
        这几项是纯文本，不参与任何计算。写多少都行，之后随时能回来改。
      </p>

      {fields.map((field) => (
        <div key={field.key}>
          <label className={labelClass} htmlFor={`char-${field.key}`}>
            {field.label}
          </label>
          <textarea
            id={`char-${field.key}`}
            value={form[field.key]}
            rows={3}
            maxLength={4000}
            onChange={(event) =>
              patch({
                [field.key]: event.target.value,
              } as Partial<CharacterFormInput>)
            }
            className={`${inputClass} resize-y leading-relaxed`}
          />
          <span className="mt-1 block text-[12px] text-stone-600">
            {field.hint}
          </span>
        </div>
      ))}
    </div>
  );
}

function StepConfirm({ form, derived }: BaseProps & DerivedProps) {
  const classLabel =
    CLASSES.find((item) => item.key === form.classKey)?.label ?? "—";

  const rows: Array<[string, string]> = [
    ["职业", classLabel],
    ["等级", `${form.level}`],
    ["种族", form.ancestry || "—"],
    ["阵营", form.alignment || "—"],
    ["背景", form.background || "—"],
    ["生命上限", `${derived.maxHp}`],
    ["护甲等级", `${derived.ac}${derived.acFromOverride ? "（手动）" : ""}`],
    ["先攻", formatModifier(derived.initiative)],
    ["被动察觉", `${derived.passivePerception}`],
    ["熟练加值", formatModifier(derived.proficiencyBonus)],
  ];

  return (
    <div>
      {form.name.trim().length === 0 ? (
        <p className="mb-4 rounded-lg border border-ember-600/40 bg-ember-600/10 px-3 py-2 text-[13px] text-ember-400">
          还没有名字。回去第一步填一个再完成建卡。
        </p>
      ) : (
        <h2 className="font-serif text-xl text-parchment">{form.name}</h2>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2 text-[13px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2 border-b border-ink-800 pb-1.5">
            <dt className="text-stone-500">{label}</dt>
            <dd className="text-parchment">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {ABILITIES.map((item) => (
          <div
            key={item.key}
            className="rounded-lg border border-ink-800 px-2 py-2 text-center"
          >
            <p className="text-[11px] text-stone-600">{item.short}</p>
            <p className="mt-0.5 text-[15px] text-parchment">
              {form.abilities[item.key]}
            </p>
            <p className="text-[11px] text-ember-400">
              {formatModifier(derived.modifiers[item.key])}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <p className={labelClass}>技能加值</p>
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-[12px] sm:grid-cols-3">
          {derived.skills
            .filter((item) => item.proficient)
            .map((item) => (
              <div key={item.key} className="flex justify-between gap-2">
                <span className="text-stone-500">{item.label}</span>
                <span className="text-parchment">
                  {formatModifier(item.total)}
                </span>
              </div>
            ))}
          {derived.skills.every((item) => !item.proficient) ? (
            <span className="text-stone-600">还没选技能熟练</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
