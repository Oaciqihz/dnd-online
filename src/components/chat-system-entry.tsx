"use client";

import {
  DM_CHAT_COLOR,
  ROLL_FAIL_COLOR,
  ROLL_SUCCESS_COLOR,
  SYSTEM_CHAT_COLOR,
  formatChatTime,
} from "@/lib/chat";
import { ROLL_MODE_LABEL, formatBonus } from "@/lib/dice";
import type { ChatMessageView } from "@/lib/protocol";

/**
 * 聊天时间线里的系统条目：发起检定 / 掷骰结算。
 *
 * 它和普通消息共用一条时间线，但**长得完全不一样** ——
 * 这是有意的。普通消息是「某人说的话」，读者的扫描路径是
 * 「找名字 → 读内容」；系统条目不是人说的，它是一个事件，
 * 扫描路径应该是「一眼看到这是个事件 → 看数字」。
 *
 * 所以这里不做头像、不做名字染色、不做气泡对齐，
 * 而是一块带左边框的窄卡片 + 「系统」标签。
 * 如果让它长得像一条普通消息，玩家就会试图去对应「这是谁说的」，
 * 而那个答案是「没有人」—— 只能靠猜，猜不出来就会觉得界面有问题。
 */
export function ChatSystemEntry({ message }: { message: ChatMessageView }) {
  const isResult = message.kind === "roll-result";
  const result = isResult ? message.roll : null;
  const request = isResult ? null : message.request;

  /**
   * payload 解不出来（老数据、手工改过的库）时退化成纯文字。
   * 这时候 message.body 就是唯一的信息来源 —— 这也是
   * 「明知道要渲染卡片还坚持存一句话」的理由。
   */
  const broken = isResult ? !result : !request;

  return (
    <article
      className="rounded-md border-l-2 py-1.5 pl-2.5 pr-2"
      style={{
        borderLeftColor: SYSTEM_CHAT_COLOR,
        backgroundColor: `${SYSTEM_CHAT_COLOR}0f`,
      }}
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className="shrink-0 rounded-[3px] border px-1 text-[10px] font-semibold leading-[14px] tracking-wider"
          style={{
            color: SYSTEM_CHAT_COLOR,
            borderColor: `${SYSTEM_CHAT_COLOR}55`,
            backgroundColor: `${SYSTEM_CHAT_COLOR}1f`,
          }}
        >
          系统
        </span>

        <span
          className="shrink-0 text-[11.5px] tracking-wide"
          style={{ color: SYSTEM_CHAT_COLOR }}
        >
          {isResult ? "掷骰结果" : "要求检定"}
        </span>

        <span
          className="ml-auto shrink-0 text-[10.5px] tabular-nums text-stone-600"
          suppressHydrationWarning
        >
          {formatChatTime(message.createdAt)}
        </span>
      </div>

      {broken ? (
        <p
          className="mt-1 text-[12.5px] leading-relaxed"
          style={{ color: SYSTEM_CHAT_COLOR }}
        >
          {message.body}
        </p>
      ) : request ? (
        <RequestBody request={request} />
      ) : result ? (
        <ResultBody result={result} />
      ) : null}
    </article>
  );
}

function RequestBody({
  request,
}: {
  request: NonNullable<ChatMessageView["request"]>;
}) {
  const mode =
    request.dice.mode === "normal" ? null : ROLL_MODE_LABEL[request.dice.mode];

  return (
    <>
      <p className="mt-1 text-[12.5px] leading-relaxed text-stone-300">
        {/* 发起人的名字用 DM 的金色：这条记录的主人是谁，一眼就能对上 */}
        <span style={{ color: DM_CHAT_COLOR }}>{request.requestedByName}</span>
        <span className="text-stone-500"> 要求 </span>
        <span className="font-medium text-parchment">{request.targetName}</span>
        <span className="text-stone-500"> 掷 </span>
        <span className="font-medium text-parchment">{request.label}</span>

        {mode ? (
          <span
            className="ml-1 rounded px-1 py-px text-[10.5px]"
            style={{
              color: SYSTEM_CHAT_COLOR,
              backgroundColor: `${SYSTEM_CHAT_COLOR}1f`,
            }}
          >
            {mode}
          </span>
        ) : null}

        {request.dc !== null ? (
          <span className="ml-1.5 rounded bg-ink-950/60 px-1.5 py-px text-[11px] tabular-nums text-stone-400">
            DC {request.dc}
          </span>
        ) : null}
      </p>

      {request.note ? (
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-stone-500">
          「{request.note}」
        </p>
      ) : null}
    </>
  );
}

function ResultBody({
  result,
}: {
  result: NonNullable<ChatMessageView["roll"]>;
}) {
  const mode =
    result.dice.mode === "normal" ? null : ROLL_MODE_LABEL[result.dice.mode];

  const verdictColor =
    result.outcome === null
      ? SYSTEM_CHAT_COLOR
      : result.outcome === "success"
        ? ROLL_SUCCESS_COLOR
        : ROLL_FAIL_COLOR;

  const verdictText =
    result.outcome === null
      ? "仅记录"
      : result.outcome === "success"
        ? "成功"
        : "失败";

  /**
   * 加值构成里 value 为 0 的项不展示。
   *
   * resolveCheck 会把每一项都列出来（力量调整 +0 也是合法的一项），
   * 但在小结里写「力量调整 +0」只是噪音 —— 玩家要看的是「为什么是 +5」，
   * 而 +0 的项对这个问题没有贡献。
   */
  const parts = result.modifierParts.filter((part) => part.value !== 0);

  return (
    <>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span className="text-[12.5px] font-medium text-parchment">
          {result.actorName}
        </span>
        <span className="text-[11.5px] text-stone-500">{result.label}</span>

        {mode ? (
          <span
            className="rounded px-1 py-px text-[10.5px]"
            style={{
              color: SYSTEM_CHAT_COLOR,
              backgroundColor: `${SYSTEM_CHAT_COLOR}1f`,
            }}
          >
            {mode}
          </span>
        ) : null}

        {/* 骰面：生效的那颗点亮，另一颗压暗。
            优势/劣势时两颗都在，玩家能自己确认「确实掷了两次」 */}
        <span className="inline-flex items-center gap-1">
          {result.raw.map((value, index) => {
            const picked = index === result.picked;

            return (
              <span
                key={index}
                className="rounded-[3px] px-1 text-[12px] tabular-nums"
                style={
                  picked
                    ? {
                        backgroundColor: `${SYSTEM_CHAT_COLOR}38`,
                        color: "#EEF4FB",
                        fontWeight: 600,
                      }
                    : { color: "#8A8479" }
                }
                title={picked ? "生效的点数" : "被舍弃的点数"}
              >
                {value}
              </span>
            );
          })}

          <span className="text-[11.5px] tabular-nums text-stone-500">
            {formatBonus(result.modifier)}
          </span>

          <span className="text-[11.5px] text-stone-600">=</span>

          <span
            className="text-[13.5px] font-semibold tabular-nums"
            style={{ color: verdictColor }}
          >
            {result.total}
          </span>
        </span>

        {result.dc !== null ? (
          <span className="rounded bg-ink-950/60 px-1.5 py-px text-[11px] tabular-nums text-stone-400">
            DC {result.dc}
          </span>
        ) : null}

        <span
          className="rounded px-1.5 py-px text-[11px] font-medium"
          style={{
            color: verdictColor,
            backgroundColor: `${verdictColor}1f`,
          }}
        >
          {verdictText}
        </span>

        {/* 天然 20 / 天然 1 单独再标一次：它不是「加值算得高」，
            而是规则层面的特殊结果，值得被单独看见 */}
        {result.natTwenty ? (
          <span
            className="rounded px-1.5 py-px text-[11px] font-semibold"
            style={{ color: DM_CHAT_COLOR, backgroundColor: `${DM_CHAT_COLOR}1f` }}
          >
            天然 20
          </span>
        ) : null}

        {result.natOne ? (
          <span
            className="rounded px-1.5 py-px text-[11px] font-semibold"
            style={{ color: ROLL_FAIL_COLOR, backgroundColor: `${ROLL_FAIL_COLOR}1f` }}
          >
            天然 1
          </span>
        ) : null}
      </div>

      {parts.length > 0 ? (
        <p className="mt-0.5 text-[11px] leading-relaxed text-stone-600">
          加值 {parts.map((part) => `${part.label} ${formatBonus(part.value)}`).join(" · ")}
        </p>
      ) : null}
    </>
  );
}
