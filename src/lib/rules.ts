/**
 * DnD 5e 的规则计算。
 *
 * 这个文件里全是纯函数，没有数据库、没有 React ——
 * 客户端用它做「填属性时立刻看到 HP / AC 变化」的预览，
 * 服务端在保存时用同一份代码重算并落库。
 *
 * 为什么一定要共用：如果前端算一套、后端算一套，
 * 迟早会出现「我填完看到 AC 17，保存后变成 16」这种没人能解释的问题。
 *
 * 第一版只实现确定性强、不会算错的公式。
 * 法术位、负重、经验值这些先不做，规则变体太多，现在写就是给自己挖坑。
 */

export type AbilityKey = "str" | "dex" | "con" | "int" | "wis" | "cha";

export const ABILITIES: Array<{
  key: AbilityKey;
  label: string;
  short: string;
}> = [
  { key: "str", label: "力量", short: "STR" },
  { key: "dex", label: "敏捷", short: "DEX" },
  { key: "con", label: "体质", short: "CON" },
  { key: "int", label: "智力", short: "INT" },
  { key: "wis", label: "感知", short: "WIS" },
  { key: "cha", label: "魅力", short: "CHA" },
];

/** 12 个职业。hitDie 是生命骰面数，算 HP 时要用 */
export const CLASSES: Array<{
  key: string;
  label: string;
  hitDie: number;
}> = [
  { key: "barbarian", label: "野蛮人", hitDie: 12 },
  { key: "bard", label: "吟游诗人", hitDie: 8 },
  { key: "cleric", label: "牧师", hitDie: 8 },
  { key: "druid", label: "德鲁伊", hitDie: 8 },
  { key: "fighter", label: "战士", hitDie: 10 },
  { key: "monk", label: "武僧", hitDie: 8 },
  { key: "paladin", label: "圣武士", hitDie: 10 },
  { key: "ranger", label: "游侠", hitDie: 10 },
  { key: "rogue", label: "游荡者", hitDie: 8 },
  { key: "sorcerer", label: "术士", hitDie: 6 },
  { key: "warlock", label: "邪术师", hitDie: 8 },
  { key: "wizard", label: "法师", hitDie: 6 },
];

/** 18 个技能，按所属属性分组 */
export const SKILLS: Array<{
  key: string;
  label: string;
  ability: AbilityKey;
}> = [
  { key: "athletics", label: "运动", ability: "str" },

  { key: "acrobatics", label: "体操", ability: "dex" },
  { key: "sleight-of-hand", label: "巧手", ability: "dex" },
  { key: "stealth", label: "隐匿", ability: "dex" },

  { key: "arcana", label: "奥秘", ability: "int" },
  { key: "history", label: "历史", ability: "int" },
  { key: "investigation", label: "调查", ability: "int" },
  { key: "nature", label: "自然", ability: "int" },
  { key: "religion", label: "宗教", ability: "int" },

  { key: "animal-handling", label: "驯兽", ability: "wis" },
  { key: "insight", label: "洞悉", ability: "wis" },
  { key: "medicine", label: "医药", ability: "wis" },
  { key: "perception", label: "察觉", ability: "wis" },
  { key: "survival", label: "生存", ability: "wis" },

  { key: "deception", label: "欺瞒", ability: "cha" },
  { key: "intimidation", label: "威吓", ability: "cha" },
  { key: "performance", label: "表演", ability: "cha" },
  { key: "persuasion", label: "游说", ability: "cha" },
];

/** 标准阵列：加起来正好 72 点，玩家在这六个数字之间自由分配 */
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 20;

/** 属性调整值 = floor((属性 - 10) / 2)。向下取整是关键，7 点是 -2 不是 -1 */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** 熟练加值 = 2 + floor((等级 - 1) / 4)，20 级时是 +6 */
export function proficiencyBonus(level: number): number {
  const safeLevel = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.floor(level)));
  return 2 + Math.floor((safeLevel - 1) / 4);
}

/** 把修正值格式化成 "+3" / "-1" / "+0"，展示时用 */
export function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

export function findClass(classKey: string) {
  return CLASSES.find((item) => item.key === classKey) ?? CLASSES[4];
}

export function findSkill(skillKey: string) {
  return SKILLS.find((item) => item.key === skillKey) ?? null;
}

export type AbilityScores = Record<AbilityKey, number>;

export type DeriveInput = {
  classKey: string;
  level: number;
  abilities: AbilityScores;
  skills: string[];
  saves: AbilityKey[];
  hpBonus: number;
  acOverride: number | null;
};

export type SkillView = {
  key: string;
  label: string;
  ability: AbilityKey;
  abilityLabel: string;
  total: number;
  proficient: boolean;
};

export type SaveView = {
  key: AbilityKey;
  label: string;
  total: number;
  proficient: boolean;
};

export type Derived = {
  modifiers: AbilityScores;
  proficiencyBonus: number;
  maxHp: number;
  ac: number;
  /** AC 是不是玩家手动填的，UI 上要标一下，不然玩家会以为算错了 */
  acFromOverride: boolean;
  initiative: number;
  passivePerception: number;
  savingThrows: SaveView[];
  skills: SkillView[];
};

/**
 * 最大生命值。
 *
 * 1 级拿满生命骰 + 体质调整，之后每级拿「骰面均值向上取整 + 体质调整」，
 * 也就是 5e 里常说的固定值方案（d10 每级 +6）。
 * 每级最少涨 1 点，这是规则书里的下限，防止体质太低时算出负数。
 */
export function computeMaxHp(
  classKey: string,
  level: number,
  conScore: number,
  hpBonus: number,
): number {
  const hitDie = findClass(classKey).hitDie;
  const conMod = abilityModifier(conScore);
  const safeLevel = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.floor(level)));

  const firstLevel = Math.max(1, hitDie + conMod);
  const perLevel = Math.max(1, Math.floor(hitDie / 2) + 1 + conMod);

  return firstLevel + perLevel * (safeLevel - 1) + hpBonus;
}

/**
 * 一次性把所有派生值算出来。
 * 调用方拿到这个对象就够渲染整张卡，不用自己再拼公式。
 */
export function deriveCharacter(input: DeriveInput): Derived {
  const prof = proficiencyBonus(input.level);

  const modifiers = {} as AbilityScores;
  for (const item of ABILITIES) {
    modifiers[item.key] = abilityModifier(input.abilities[item.key] ?? 10);
  }

  const skillKeys = new Set(input.skills);
  const saveKeys = new Set(input.saves);

  const skills: SkillView[] = SKILLS.map((skill) => {
    const proficient = skillKeys.has(skill.key);
    const abilityLabel =
      ABILITIES.find((item) => item.key === skill.ability)?.label ?? "";

    return {
      key: skill.key,
      label: skill.label,
      ability: skill.ability,
      abilityLabel,
      total: modifiers[skill.ability] + (proficient ? prof : 0),
      proficient,
    };
  });

  const savingThrows: SaveView[] = ABILITIES.map((item) => {
    const proficient = saveKeys.has(item.key);
    return {
      key: item.key,
      label: item.label,
      total: modifiers[item.key] + (proficient ? prof : 0),
      proficient,
    };
  });

  // 被动察觉 = 10 + 察觉技能加值，所以直接从算好的 skills 里取，不重复算一遍
  const perception = skills.find((item) => item.key === "perception");
  const passivePerception = 10 + (perception?.total ?? modifiers.wis);

  const computedAc = 10 + modifiers.dex;
  const ac = input.acOverride ?? computedAc;

  return {
    modifiers,
    proficiencyBonus: prof,
    maxHp: computeMaxHp(
      input.classKey,
      input.level,
      input.abilities.con ?? 10,
      input.hpBonus,
    ),
    ac,
    acFromOverride: input.acOverride !== null,
    initiative: modifiers.dex,
    passivePerception,
    savingThrows,
    skills,
  };
}

/** 把数据库里的 JSON 数组字符串安全地还原成字符串数组 */
export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** 属性值得在 3~20 之间，这是角色卡第一版的合理范围（暂时不处理 Epic Boon） */
export function clampAbility(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(20, Math.max(3, Math.round(value)));
}
