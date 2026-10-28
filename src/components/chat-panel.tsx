"use client";

import { useEffect, useRef, useState } from "react";
import {
  CHAT_MAX_LENGTH,
  DM_CHAT_COLOR,
  chatColor,
  formatChatTime,
} from "@/lib/chat";
import type { ChatMessageView } from "@/lib/protocol";
import { ChatSystemEntry } from "./chat-system-entry";

/**
 * 房间聊天面板。
 *
 * 一个纯展示组件：消息数组从外面传进来，发送通过 onSend 交出去。
 * 不在这里订阅 Socket —— 房间页已经有一条连接了，
 * 为聊天再建一条不仅浪费，还会把「谁在线」的统计搞乱
 * （之前那个「在线人数一直增加」的 bug 就是这么来的）。
 *
 * 布局放在舞台下方而不是右侧：舞台是 16:9，宽度被压窄之后
 * 地图上的格子会小到看不清，而聊天是线性阅读，横向宽一点没用。
 */
export function ChatPanel({
  messages,
  selfId,
  connected,
  readOnly = false,
  onSend,
}: {
  messages: ChatMessageView[];
  selfId: string;
  connected: boolean;
  /**
   * 只读：本局已结束时用。
   *
   * 不禁用整个面板，只禁用输入 —— 结束之后回头看这局说过什么，
   * 恰恰是聊天记录最有用的时候。
   */
  readOnly?: boolean;
  onSend: (body: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 连接状态要等挂载之后才能信。
   *
   * 服务端渲染时拿不到「连没连上」，如果直接把 initial 的 connecting
   * 渲染出来，每次打开页面都会先闪一下「连接中…」再消失 ——
   * 而实际上连接一直是好的。所以 SSR 阶段干脆不显示状态，
   * 只在客户端确认断开时才提示。
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /** 能不能发。三个条件缺一不可，收敛成一个变量免得三处判断写岔 */
  const canSend = connected && !readOnly;

  /**
   * 有新人说话时滚到底 —— 但只在「用户本来就在底部」的时候滚。
   *
   * 无脑滚底是最烦人的聊天体验：有人往上翻记录看 DM 三分钟前说过的线索，
   * 这时随便谁打个「+1」，视野就被拽回底部，线索就丢了。
   * 所以先判断当前位置离底部是不是在 80px 以内。
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceToBottom < 80) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages.length]);

  /** 输入框跟着内容长高，但最多 4 行左右，再长就内部滚动 */
  function autoresize() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }

  async function submit() {
    const body = draft.trim();
    if (!body || sending || !canSend) return;

    setSending(true);
    setError(null);

    const result = await onSend(body);
    setSending(false);

    if (!result.ok) {
      // 失败时保留草稿。清空是最糟的处理 —— 玩家辛苦打的一段话
      // 因为一次网络抖动就没了，下次他就不敢打长了
      setError(result.error ?? "发送失败");
      return;
    }

    setDraft("");
    // 高度要跟着手动归位，否则清空后 textarea 还停在长句的高度
    requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.style.height = "auto";
    });
  }

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-ink-800 bg-ink-900/40">
      <header className="flex items-center justify-between border-b border-ink-800/80 px-3.5 py-2">
        <h2 className="text-[12px] font-medium tracking-wide text-stone-400">
          聊天
          {messages.length > 0 ? (
            <span className="ml-2 text-stone-600">{messages.length} 条</span>
          ) : null}
        </h2>

        {readOnly ? (
          <span className="text-[11px] text-stone-600">本局已结束 · 只读</span>
        ) : mounted && !connected ? (
          <span className="text-[11px] text-amber-500/80">实时通道断开</span>
        ) : null}
      </header>

      <div
        ref={listRef}
        className="max-h-[260px] min-h-[92px] space-y-2.5 overflow-y-auto px-3.5 py-3"
      >
        {messages.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-stone-600">
            还没有人说话。打个招呼，开个场。
          </p>
        ) : (
          messages.map((message) => {
            /**
             * 系统条目走另一套渲染。
             *
             * 分流放在这里而不是在 map 里套三元：下面那段普通消息的渲染
             * 有名字、徽标、时间、染色四件事，再塞进一个「或者是卡片」
             * 的分支，读起来就没法一眼看懂哪个是常态了。
             */
            if (message.kind === "roll-result" || message.kind === "roll-request") {
              return <ChatSystemEntry key={message.id} message={message} />;
            }

            /**
             * 颜色在这里算，不在服务端算。
             *
             * 服务端只发 role 和 frame 两个事实，颜色是推导出来的结论。
             * 好处是玩家换一次头像框，整段历史消息的颜色会一起变 ——
             * 这才叫「跟随」。如果服务端下发固定颜色，
             * 同一个人的消息就会在换框那一刻前后两种颜色。
             */
            const color = chatColor(message);
            const isSelf = message.userId === selfId;
            const isDm = message.role === "dm";

            return (
              <article key={message.id} className="text-[13px] leading-relaxed">
                <div className="flex items-baseline gap-1.5">
                  {/* 名字前的小圆点：颜色最直接的指示器，比只染名字更容易扫读 */}
                  <span
                    className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full"
                    style={{ backgroundColor: color }}
                    aria-hidden
                  />

                  <span
                    className="min-w-0 truncate font-medium"
                    style={{ color }}
                    title={message.name}
                  >
                    {message.name}
                  </span>

                  {/*
                    DM 徽标。

                    颜色单独区分不够 —— 房间可能有六七个玩家，每人一个框色，
                    「金色是哪位」这件事只有自己记住了框色排序才知道。
                    一个实心标签是零成本的：扫一眼就知道这句话是「规则」还是「闲聊」，
                    而这两者在跑团里的分量完全不同。

                    放在名字**后面**而不是前面：名字仍然是最先被读到的，
                    徽标是补充说明。放前面会让整列名字的第一个字对不齐。
                  */}
                  {isDm ? (
                    <span
                      className="shrink-0 rounded-[3px] border px-1 text-[10px] font-semibold leading-[14px] tracking-wider"
                      style={{
                        color,
                        borderColor: `${DM_CHAT_COLOR}66`,
                        backgroundColor: `${DM_CHAT_COLOR}1f`,
                      }}
                      title="地下城主"
                    >
                      DM
                    </span>
                  ) : null}

                  {isSelf ? (
                    <span className="shrink-0 text-[10.5px] text-stone-600">
                      你
                    </span>
                  ) : null}

                  {/*
                    suppressHydrationWarning：时间用的是本地时区格式化，
                    服务端渲染那一次和浏览器之间理论上可能差一分钟甚至一个时区，
                    React 19 会因此报 hydration mismatch。这个值本来就是
                    「给人看的近似时间」，允许两边不一致是合理的。
                  */}
                  <span
                    className="ml-auto shrink-0 text-[10.5px] tabular-nums text-stone-600"
                    suppressHydrationWarning
                  >
                    {formatChatTime(message.createdAt)}
                  </span>
                </div>

                <p
                  className="mt-0.5 whitespace-pre-wrap break-words pl-3"
                  style={{ color }}
                >
                  {message.body}
                </p>
              </article>
            );
          })
        )}
      </div>

      <div className="border-t border-ink-800/80 p-2.5">
        {/*
          下面输入框的占位文案不用 canSend 判断：那个值在 SSR 阶段恒为 false，
          会先渲染出「连接建立后就能发言」，水合后再变成正常文案。
          禁用的输入框本身已经有视觉区分（变灰、不可聚焦），
          不需要再靠一句会闪的提示来说明。
        */}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            maxLength={CHAT_MAX_LENGTH}
            placeholder={
              readOnly
                ? "本局已结束，聊天记录只读"
                : "说点什么…（Enter 发送，Shift+Enter 换行）"
            }
            disabled={!canSend}
            onChange={(event) => {
              setDraft(event.target.value);
              autoresize();
            }}
            onKeyDown={(event) => {
              /**
               * isComposing 必须判断，否则中文输入法选词时按的那一下回车
               * 会把半截拼音发出去。这是中文环境下写聊天输入框
               * 最容易漏、也最容易被用户骂的一行。
               */
              if (event.key !== "Enter") return;
              if (event.nativeEvent.isComposing) return;
              if (event.shiftKey) return;

              event.preventDefault();
              void submit();
            }}
            className="max-h-[96px] min-h-[36px] flex-1 resize-none rounded-lg border border-ink-700 bg-ink-950/60 px-2.5 py-2 text-[13px] leading-snug text-parchment outline-none placeholder:text-stone-600 focus:border-ember-500 disabled:opacity-50"
          />

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend || sending || draft.trim().length === 0}
            className="h-9 shrink-0 rounded-lg bg-ember-500 px-3.5 text-[13px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? "…" : "发送"}
          </button>
        </div>

        {error ? (
          <p className="mt-1.5 px-1 text-[11.5px] text-red-400">{error}</p>
        ) : null}
      </div>
    </section>
  );
}
