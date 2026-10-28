import { formatBonus, formatDice, ROLL_MODE_LABEL } from "./dice";
import { PORTRAIT_FRAMES, type PortraitFrame } from "./portrait";
import type { RollPendingView, RollResultView, RoomRole } from "./protocol";

/**
 * 聊天的纯逻辑层。
 *
 * 这个文件里不能出现任何 node 模块（node:crypto、db、fs），因为
 * 客户端组件会 import 它来算文字颜色。数据库读写放在 lib/chat-store.ts。
 *
 * 拆开的理由很实际：Next 会把 import 图整个打进去，
 * 一旦这里 import 了 db，better-sqlite3 这个原生模块就会被打进浏览器包，
 * 构建阶段直接报错。而「校验一下长度」「算个颜色」本来就是纯函数。
 */

/** 单条消息上限。跑团一句话通常 20-50 字，500 字已经够描述一整个动作 */
export const CHAT_MAX_LENGTH = 500;

/** 一屏历史。60 条大约是一局游戏里翻得回去的量，再多也没人往上翻 */
export const CHAT_HISTORY_LIMIT = 60;

/** DM 的文字颜色。和舞台棋子上强制给 DM 套的金色环是同一个值 */
export const DM_CHAT_COLOR = "#E0B457";

/**
 * 系统条目的颜色（检定发起 / 掷骰结算）。
 *
 * 刻意选了一个**没有任何头像框在用**的冷蓝：金色已经被 DM 占着，
 * 而头像框那一套都是暖色（苔绿、灰烬、绛紫…）。
 * 如果系统消息借用其中任意一种，玩家会下意识把它读成「某个人说的话」，
 * 但它其实不是人说的 —— 它是一个事件。
 *
 * 亮度按近黑背景（#14110D）调到 8.9:1 对比度，
 * 和 chatColor 里挑 highlight 那一档的理由一样。
 */
export const SYSTEM_CHAT_COLOR = "#8FB8E8";

/** 成败用的两种颜色。成功青绿、失败砖红 —— 和舞台血量的低血警示同一套语义 */
export const ROLL_SUCCESS_COLOR = "#6DD3A0";
export const ROLL_FAIL_COLOR = "#E58A8A";

/**
 * 校验并规整消息正文。
 *
 * 返回 null 表示「这条不该被发出去」（非字符串、全空白）。
 * 超长不报错而是截断：玩家粘贴一大段描述时，让他看到前半句
 * 比看到一个「太长了」的报错更有用 —— 但截断必须发生在这里，
 * 而不是等到渲染时用 CSS 的 line-clamp 遮掉，那只是看起来短了。
 *
 * 控制字符要剥掉：聊天记录最终会原样回显到浏览器，
 * 里面混进 \u0000 或退格符会让终端和日志一片混乱，
 * 而换行 \n 要保留 —— 它是玩家自己按出来的排版。
 */
export function sanitizeChatBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const cleaned = raw
    .replace(/\r\n?/g, "\n")
    // 保留 \n(0A) 和 \t(09)，其余 C0 控制符一律清掉
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  const trimmed = cleaned.trim();
  if (!trimmed) return null;

  return trimmed.slice(0, CHAT_MAX_LENGTH);
}

/**
 * 这条消息该用什么颜色显示。
 *
 * 这是「文字颜色跟随头像框」的唯一实现处 —— 服务端渲染的历史记录、
 * 客户端实时收到的消息、以及将来任何回显，都调这一个函数，
 * 所以不可能出现「同一个人在列表里是紫的、在输入框回显里是绿的」。
 *
 * 三条规则，按优先级：
 *
 * 1. **DM 恒为金色。** 不是覆盖个人选择，而是因为棋子上 DM 的环
 *    本来就被强制成金色（见 stage-view.tsx 的 `ring="#E0B457"`）。
 *    如果聊天里按他自己的框显示，就会出现「棋子是金环、名字是紫字」，
 *    玩家得靠猜才能把两者对上。
 * 2. **玩家用 frame.highlight。** 每种框有 outer / ring / highlight 三档，
 *    只有最亮的 highlight 能保证在 #14110D 这种近黑背景上过 WCAG AA
 *    对比度（实测 6.9:1 ~ 15:1）。用 ring 那一档，苔绿和灰烬会掉到 4:1 以下。
 * 3. **没有角色卡的人用默认框。** DM 常常不建卡，此时 frame 是 null，
 *    退成第一个框的 highlight，而不是留一个 undefined 让整行变透明。
 */
export function chatColor(input: {
  role: RoomRole;
  frame: PortraitFrame | null;
}): string {
  if (input.role === "dm") return DM_CHAT_COLOR;

  const frame = PORTRAIT_FRAMES.find((item) => item.key === input.frame);
  return (frame ?? PORTRAIT_FRAMES[0]).highlight;
}

/**
 * 消息时间的展示格式。
 *
 * 只在客户端调用。服务端渲染用的是同一个函数、同一台机器的时区，
 * 所以正常情况下不会 hydration mismatch；但部署到 UTC 容器里
 * 而用户在 +08:00 时就会不一致，所以渲染处要允许 hydration 差异。
 *
 * 用 hourCycle "h23" 而不是 hour12: false —— 后者在部分 ICU 版本上
 * 会给出 "24:05" 这种半夜的写法。
 */
export function formatChatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * 系统条目的纯文本正文。
 *
 * 为什么明知道聊天栏会渲染一张带骰面的卡片，还要生成一句话：
 *
 * 1. 这是落进 room_messages.body 的东西。payload 里的 JSON 解析失败
 *    （老数据、手工改过的库）时，聊天栏还能显示这一行字，
 *    而不是一条空白的卡片。
 * 2. 将来要做搜索、通知、战报导出，能直接用的永远是这句话，
 *    而不是一个需要再解一层的结构。
 * 3. 无障碍：卡片里全是排布过的数字和徽标，读屏出来是一盘散沙，
 *    body 是可朗读的完整句子。
 */
export function rollRequestText(pending: RollPendingView): string {
  const mode =
    pending.dice.mode === "normal"
      ? ""
      : `（${ROLL_MODE_LABEL[pending.dice.mode]}）`;
  const dc = pending.dc === null ? "" : `，DC ${pending.dc}`;
  const note = pending.note ? ` · ${pending.note}` : "";

  return `${pending.targetName} 被要求掷 ${pending.label}${mode}${dc}${note}`;
}

export function rollResultText(result: RollResultView): string {
  const mode =
    result.dice.mode === "normal"
      ? ""
      : `（${ROLL_MODE_LABEL[result.dice.mode]} ${result.raw.join("/")} 取 ${result.pickedValue}）`;

  /**
   * 加值为 0 时不写出来。
   *
   * 「d20(14) +0 = 14」在数学上没错，但读起来像是个残缺的式子 ——
   * 玩家会先花半秒确认「+0 是不是有什么特别含义」。
   * 没有加值就是没有，直接写成「d20(14) = 14」。
   */
  const bonus = result.modifier === 0 ? "" : ` ${formatBonus(result.modifier)}`;

  const math =
    result.dice.mode === "normal"
      ? `${formatDice(result.dice)}(${result.raw.join("+")})${bonus} = ${result.total}`
      : `取 ${result.pickedValue}${bonus} = ${result.total}`;

  const verdict =
    result.outcome === null
      ? "仅记录点数"
      : result.outcome === "success"
        ? `DC ${result.dc} 成功`
        : `DC ${result.dc} 失败`;

  return `${result.actorName} 的 ${result.label}${mode}：${math}，${verdict}`;
}
