"use client";

import { useState } from "react";
import { CharacterToken } from "./character-token";
import { DEFAULT_PORTRAIT } from "@/lib/portrait";
import { ABILITIES, SKILLS } from "@/lib/rules";
import { ROLL_MODES, ROLL_MODE_LABEL, type RollMode } from "@/lib/dice";
import type { RollPendingView, RoomMemberView } from "@/lib/protocol";

/**
 * 「等某人掷骰」的状态条。
 *
 * 所有人都能看到它 —— 「现在轮到 xin 掷察觉，DC 15」本来就是
 * 桌上所有人都该知道的事，藏起来反而奇怪。
 *
 * 但**掷骰按钮只在被指定的人那里渲染**，撤销按钮只在 DM 那里渲染。
 * 这比「所有人都有按钮、点了再被服务端拒」好得多：
 * 一个看得见但按下去会报错的按钮，比没有按钮更让人困惑。
 */
export function RollPendingBar({
  pending,
  isTarget,
  isDm,
  busy,
  error,
  onRoll,
  onCancel,
}: {
  pending: RollPendingView;
  /** 当前用户是不是被指定的那个人 */
  isTarget: boolean;
  isDm: boolean;
  busy: boolean;
  error: string | null;
  onRoll: () => void;
  onCancel: () => void;
}) {
  const modeLabel =
    pending.dice.mode === "normal" ? "" : ` · ${ROLL_MODE_LABEL[pending.dice.mode]}`;

  return (
    <div className="mt-3 rounded-xl border border-ember-500/40 bg-ember-500/8 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* 呼吸点：不用文字说「等待中」，一个脉动的小点比一句话更快被读到 */}
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-ember-400" />
        </span>

        <span className="text-[13px] text-parchment">
          {isTarget ? (
            <>
              该你掷 <span className="font-medium text-ember-400">{pending.label}</span>
              {modeLabel}
            </>
          ) : (
            <>
              等{" "}
              <span className="font-medium text-ember-400">{pending.targetName}</span>{" "}
              掷 {pending.label}
              {modeLabel}
            </>
          )}
        </span>

        {pending.dc !== null ? (
          <span className="rounded bg-ink-950/50 px-1.5 py-0.5 text-[11px] tabular-nums text-stone-400">
            DC {pending.dc}
          </span>
        ) : null}

        {pending.note ? (
          <span className="text-[11.5px] text-stone-500">{pending.note}</span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isTarget ? (
            <button
              type="button"
              onClick={onRoll}
              disabled={busy}
              className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[12.5px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:opacity-50"
            >
              {busy ? "掷骰中…" : "掷骰"}
            </button>
          ) : null}

          {isDm ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-md border border-ink-700 px-2 py-0.5 text-[11.5px] text-stone-400 transition hover:border-red-500/40 hover:text-red-400 disabled:opacity-50"
            >
              撤销
            </button>
          ) : null}
        </div>
      </div>

      {error ? <p className="mt-1.5 text-[11.5px] text-red-400">{error}</p> : null}
    </div>
  );
}

/**
 * DM 的「要求某人过检定」面板。
 *
 * 这里刻意**不显示任何加值**。
 *
 * 直觉上 DM 该看到「xin 的运动是 +5」才好定 DC，但那恰好会毁掉一点东西：
 * 桌上 DM 不预先知道玩家能不能过，才有那种「你掷吧」的紧张感。
 * 加值在结算时连同构成一起摊开（见 dice-roll-overlay），
 * 那时候所有人一起看到 —— 信息的时机比信息本身重要。
 *
 * 所以面板只收集三个事实：谁、什么检定、多难。
 */
export function RollRequestPanel({
  members,
  hasPending,
  onRequest,
}: {
  members: RoomMemberView[];
  /** 已经有待掷的请求时，发起按钮要禁用 —— 服务端也会拒，但先让人看见原因 */
  hasPending: boolean;
  onRequest: (input: {
    targetUserId: string;
    checkKey: string;
    mode: RollMode;
    dc: number | null;
    note: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);

  /**
   * 只列玩家。DM 自己不需要被「要求」掷骰 —— 他想掷随时可以说一句，
   * 而且把 DM 混进候选里会让「该指定谁」这件事多一层犹豫。
   */
  const candidates = members.filter((member) => member.role === "player");

  const [targetId, setTargetId] = useState("");
  const [checkKey, setCheckKey] = useState("skill:perception");
  const [mode, setMode] = useState<RollMode>("normal");
  const [dc, setDc] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 选中的人退房之后 targetId 会指向一个不存在的人，
  // 渲染时降级到第一个候选，而不是让面板看起来什么都没选
  const selected =
    candidates.find((member) => member.userId === targetId) ?? candidates[0] ?? null;

  async function submit() {
    if (!selected) {
      setError("房间里还没有可以掷骰的玩家");
      return;
    }

    setBusy(true);
    setError(null);

    const trimmed = dc.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);

    const result = await onRequest({
      targetUserId: selected.userId,
      checkKey,
      mode,
      dc: parsed !== null && Number.isFinite(parsed) ? parsed : null,
      note: note.trim(),
    });

    setBusy(false);

    if (!result.ok) {
      // 失败保留输入。DM 辛苦想的 DC 因为一次网络抖动被清空，
      // 他就得重新推一遍难度
      setError(result.error ?? "发起失败");
      return;
    }

    setNote("");
    setOpen(false);
  }

  return (
    <div className="mt-2.5">
      {/*
        入口做成一条常驻的操作条，而不是一个角落里的小按钮。

        DM 一晚上要发起几十次检定，这是他在这个页面上**最常用**的动作，
        却原来被做成了最不显眼的那个控件（灰底小字，混在深色面板里）。
        现在给它一整行：左边一句话说明「这里能做什么」，
        右边一颗实心主色按钮 —— 视线扫到舞台下方就能停住。
      */}
      <div className="flex items-center gap-3 rounded-xl border border-ember-500/25 bg-ember-500/[0.06] px-3 py-2">
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-stone-500">
          {hasPending
            ? "还有一次检定没掷，先让他掷完或撤销"
            : "要求某位玩家过检定 —— 点数由服务端掷出，加值从角色卡现算"}
        </span>

        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition ${
            open
              ? "border border-ember-500/60 bg-transparent text-ember-300 hover:bg-ember-500/10"
              : "bg-ember-500 text-ink-950 hover:bg-ember-400"
          }`}
        >
          <D20Icon />
          {open ? "收起" : "要求检定"}
        </button>
      </div>

      {open ? (
        <div className="mt-2 rounded-xl border border-ink-800 bg-ink-900/70 p-3.5">
          <p className="text-[11px] tracking-wide text-stone-500">指定谁掷</p>

          {candidates.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-stone-600">房间里还没有玩家加入</p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {candidates.map((member) => {
                const isActive = selected?.userId === member.userId;
                // 没卡的人算不出加值，服务端也会拒。这里直接禁用，
                // 比让他选中之后点下去才报错友好
                const disabled = !member.character;

                return (
                  <button
                    key={member.userId}
                    type="button"
                    disabled={disabled}
                    onClick={() => setTargetId(member.userId)}
                    title={disabled ? "对方还没有角色卡" : undefined}
                    className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 transition ${
                      isActive
                        ? "border-ember-500/60 bg-ember-500/10"
                        : "border-ink-800 hover:border-ink-700"
                    } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
                  >
                    <span className="h-5 w-5 shrink-0">
                      <CharacterToken
                        portrait={member.character?.portrait ?? DEFAULT_PORTRAIT}
                        name={member.character?.name ?? member.displayName}
                        className="h-full w-full"
                      />
                    </span>
                    <span className="text-[12px] text-stone-300">
                      {member.character?.name?.trim() || member.displayName}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <p className="mt-3 text-[11px] tracking-wide text-stone-500">检定类型</p>
          <select
            value={checkKey}
            onChange={(event) => setCheckKey(event.target.value)}
            className="mt-1.5 w-full rounded-md border border-ink-700 bg-ink-950/60 px-2 py-1.5 text-[12.5px] text-parchment outline-none focus:border-ember-500"
          >
            <optgroup label="技能检定">
              {SKILLS.map((skill) => (
                <option key={skill.key} value={`skill:${skill.key}`}>
                  {skill.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="豁免检定">
              {ABILITIES.map((ability) => (
                <option key={ability.key} value={`save:${ability.key}`}>
                  {ability.label}豁免
                </option>
              ))}
            </optgroup>
            <optgroup label="纯属性检定">
              {ABILITIES.map((ability) => (
                <option key={ability.key} value={`ability:${ability.key}`}>
                  {ability.label}
                </option>
              ))}
            </optgroup>
            <option value="flat">纯掷骰（不加值）</option>
          </select>

          <div className="mt-2.5 flex gap-1.5">
            {ROLL_MODES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`flex-1 rounded-md border px-2 py-1 text-[12px] transition ${
                  mode === item
                    ? "border-ember-500/60 bg-ember-500/10 text-ember-400"
                    : "border-ink-800 text-stone-400 hover:border-ink-700"
                }`}
              >
                {ROLL_MODE_LABEL[item]}
              </button>
            ))}
          </div>

          <div className="mt-2.5 flex gap-2">
            <label className="flex-1">
              <span className="text-[11px] tracking-wide text-stone-500">
                难度 DC（可留空）
              </span>
              <input
                type="number"
                min={1}
                max={40}
                value={dc}
                onChange={(event) => setDc(event.target.value)}
                placeholder="15"
                className="mt-1 w-full rounded-md border border-ink-700 bg-ink-950/60 px-2 py-1.5 text-[12.5px] text-parchment outline-none placeholder:text-stone-600 focus:border-ember-500"
              />
            </label>

            <label className="flex-[2]">
              <span className="text-[11px] tracking-wide text-stone-500">
                一句话说明（可留空）
              </span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={60}
                placeholder="推开石门"
                className="mt-1 w-full rounded-md border border-ink-700 bg-ink-950/60 px-2 py-1.5 text-[12.5px] text-parchment outline-none placeholder:text-stone-600 focus:border-ember-500"
              />
            </label>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !selected || hasPending}
              className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[12.5px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:opacity-50"
            >
              {busy ? "发起中…" : "发起检定"}
            </button>

            {hasPending ? (
              <span className="text-[11.5px] text-stone-500">
                还有一次检定没掷，先让他掷完或撤销
              </span>
            ) : error ? (
              <span className="text-[11.5px] text-red-400">{error}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 小 d20 图标。
 *
 * 自绘而不是引图标库：整个项目没有图标依赖，为了一颗骰子装一整套
 * 图标包不划算；而且这里的线条粗细、圆角要和舞台上那些自绘的骰面
 * 视觉一致，外面来的图标很难对上。
 */
function D20Icon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
    >
      {/* 正二十面体的外轮廓 */}
      <path d="M12 2.8 20.2 7.2v9.6L12 21.2 3.8 16.8V7.2z" />
      {/* 正面的三角形刻面 */}
      <path d="M12 8 15.6 14H8.4z" />
      {/* 三个顶点到刻面的棱 */}
      <path d="M12 2.8v5.2M20.2 7.2l-4.6 6.8M3.8 7.2l4.6 6.8M12 21.2V14" />
    </svg>
  );
}
