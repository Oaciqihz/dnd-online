/**
 * 骰子的纯逻辑层。
 *
 * 和 lib/chat.ts 同一个理由：这个文件被客户端组件 import（要画骰面、
 * 要格式化结果），所以这里**不能出现任何 node 模块**。
 * 真正的随机数生成在 lib/dice-roll.ts，只有 Socket 进程会 import 它。
 *
 * 拆开的代价是多一个文件，收益是「掷骰」这件事被分成两半：
 * 一半是纯数据（哪些骰型合法、怎么算总和、怎么挑优势那颗），
 * 一半是熵（randomInt）。后者必须只存在于服务端，否则前端改一行就能作弊。
 */

/** 支持的骰型。没有 d2 / d3 —— 跑团里没人用，多一个白名单项就多一个被滥用的入口 */
export const DIE_FACES = [4, 6, 8, 10, 12, 20, 100] as const;
export type DieFace = (typeof DIE_FACES)[number];

/**
 * 优势 / 劣势。
 *
 * 这是 d20 系统里最重要的一条规则：优势掷两颗取高，劣势掷两颗取低。
 * 把它做成枚举而不是「让玩家自己掷两次」，是因为后者一定会被记错 ——
 * 人会下意识挑好看的那个。
 */
export const ROLL_MODES = ["normal", "advantage", "disadvantage"] as const;
export type RollMode = (typeof ROLL_MODES)[number];

export const ROLL_MODE_LABEL: Record<RollMode, string> = {
  normal: "普通",
  advantage: "优势",
  disadvantage: "劣势",
};

export type DiceSpec = {
  /** 逻辑上的骰子数量。优势/劣势时仍然是 1，实际会掷两颗，见 actualDiceCount */
  count: number;
  faces: DieFace;
  mode: RollMode;
};

/** 一次最多几颗。够 `4d6` 抽属性、够 `8d6` 火球，再往上就是有人想搞事了 */
export const MAX_DICE_COUNT = 20;

export const DEFAULT_DICE: DiceSpec = { count: 1, faces: 20, mode: "normal" };

/**
 * 白名单校验。
 *
 * 和头像框那个 sanitize 一样，这是安全边界：传来的东西最终会变成
 * 数据库里的数字和渲染层的文本。非法值不报错而是退回默认值 ——
 * DM 填错一个数不该让整个请求失败，退成普通 d20 是他能看懂的结果。
 */
export function sanitizeDiceSpec(raw: unknown): DiceSpec {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_DICE };

  const input = raw as Record<string, unknown>;

  const faces = DIE_FACES.find((item) => item === input.faces) ?? 20;

  const rawCount = typeof input.count === "number" ? Math.floor(input.count) : 1;
  const count = Math.min(MAX_DICE_COUNT, Math.max(1, rawCount));

  const mode = ROLL_MODES.find((item) => item === input.mode) ?? "normal";

  return { count, faces, mode };
}

/** 实际要掷几颗。优势/劣势多掷一颗，这是 d20 的核心规则，不是可选项 */
export function actualDiceCount(spec: DiceSpec): number {
  return spec.mode === "normal" ? spec.count : spec.count * 2;
}

/** "d20" / "2d6"。不带加值 —— 加值来自角色卡，不属于骰子规格 */
export function formatDice(spec: DiceSpec): string {
  return `${spec.count > 1 ? spec.count : ""}d${spec.faces}`;
}

/**
 * 从掷出的原始点数里挑出生效的那个。
 *
 * 优势取最高、劣势取最低、普通取第一颗（多颗时由总和说话，不需要挑）。
 * 平手时取第一个 —— 两个值一样，取哪个结果都相同，但**下标必须固定**，
 * 否则服务端算出来的是第 1 颗、客户端高亮的却是第 2 颗，看起来像算错了。
 */
export function pickRoll(raw: number[], mode: RollMode): number {
  if (raw.length === 0) return 0;
  if (mode === "advantage") return Math.max(...raw);
  if (mode === "disadvantage") return Math.min(...raw);
  return raw[0];
}

/** 生效那颗在原始数组里的下标。渲染时用来高亮「用的是这个」 */
export function pickIndex(raw: number[], mode: RollMode): number {
  const picked = pickRoll(raw, mode);
  const index = raw.indexOf(picked);
  return index >= 0 ? index : 0;
}

/**
 * 天然 20 / 天然 1。
 *
 * 只看「生效的那颗」，因为优势掷出 20 依然是大成功，而劣势掷出 1
 * 才是大失败 —— 规则看的是结果，不是某一颗骰子本身。
 */
export function isNatTwenty(picked: number, faces: DieFace): boolean {
  return faces === 20 && picked === 20;
}

export function isNatOne(picked: number, faces: DieFace): boolean {
  return faces === 20 && picked === 1;
}

/**
 * 总和的唯一算法。
 *
 * 服务端落库、客户端渲染、将来做战报统计，全都走这一个函数。
 * 如果这里出现第二份实现，就一定会出现「服务端说 18、屏幕上写 19」
 * 这种最伤信任的 bug —— 跑团里玩家会立刻发现。
 */
export function rollTotal(
  raw: number[],
  spec: DiceSpec,
  modifier: number,
): number {
  // 普通模式多颗骰子要全加起来（3d6 的伤害），
  // 优势/劣势只有 d20 检定才会出现，取的是「其中一颗」
  const base =
    spec.mode === "normal"
      ? raw.reduce((sum, value) => sum + value, 0)
      : pickRoll(raw, spec.mode);

  return base + modifier;
}

/** 带符号的加值，`+5` / `-1` / `+0`。和 rules.ts 的 formatModifier 同形 */
export function formatBonus(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

/**
 * 过没过。
 *
 * 5e 的规则是「达到或超过 DC 就算成功」，平手算成功（meet or beat）——
 * 这一条如果写成 `>`，会有一整批本该成功的检定被判失败，
 * 而它只在一小部分结果上出现，测试时很容易漏掉。
 *
 * dc 为 null 表示 DM 没设难度，那就没有成败可言，返回 null。
 */
export function judgeOutcome(
  total: number,
  dc: number | null,
): "success" | "fail" | null {
  if (dc === null) return null;
  return total >= dc ? "success" : "fail";
}
