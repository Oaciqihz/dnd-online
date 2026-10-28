import { hasImageRef, imageRefUrl, sanitizeImageRef } from "./media/ref";

/**
 * 角色在舞台上的形象（portrait）。
 *
 * 这里换过一次方案，值得记一下为什么。
 *
 * 上一版是「五轴枚举拼装」：种族、发型、衣着、持物、配色，手写 SVG 拼出一个小人。
 * 它的好处是零成本 —— 没有文件、没有审核、没有存储、序列化后不到 90 字节。
 * 但它有个天花板：手写 path 画不出立绘，细节一多就糊成一团，而且六个棋子
 * 站在一起像同一套贴纸换了颜色。对跑团来说这是致命的，因为「我这个角色长什么样」
 * 是玩家投入感最直接的来源。
 *
 * 现在改成「圆形棋子 + 一张图」。这是所有跑团工具的通用形态
 * （Roll20、Foundry 的默认 token 都是圆的），也是唯一能让玩家真正带自己的角色进来的形态。
 *
 * 代价是引入了用户内容，必须回答存储、校验、版权三个问题。这里的答案：
 *
 * 1. 存储 → storage provider（本地磁盘 / Cloudinary / ImgBB，见 lib/media/storage.ts）。
 *    数据库里存的是「能直接用的标识」，不是第三方 URL 的语义 —— 所以换图床不用改数据。
 *
 * 2. 校验 → 全部在服务端做（api/characters/[id]/portrait）。用 sharp 真实解码一次，
 *    解不出来就不是图片；然后统一重编码成 512×512 webp。
 *    重编码顺带剥离 EXIF —— 玩家传的手机照片不会带着 GPS 坐标进数据库。
 *    这一步比校验扩展名有用得多：扩展名是玩家自己起的，字节才是事实。
 *
 * 3. 版权 → 不做人工审核。一个自建跑团工具的合理边界是「玩家对自己上传的内容负责」，
 *    产品上给入口提示就够了。真要做成公开产品，那是另一套东西（举报、下架、DMCA）。
 *
 * 所以这个文件的职责被压得很小：定义形状、做白名单校验、算出最终的图片地址。
 * 没有渲染，没有数据库，前后端共用。
 */

/**
 * 生成式头像的风格。
 *
 * 不是随便挑的：全部是「半身人像」，能塞进圆形裁切里不变形。
 * 全身立绘塞进圆里会变成一根柱子，这是很多人第一次做 token 时踩的坑。
 *
 * license 字段必须留着并且在 UI 上露出来。
 * DiceBear 的代码是 MIT，但**每个风格的画稿是画家独立授权的**：
 * CC0 不用署名，CC BY 4.0 必须署名。
 * 把 adventurer 拿去商用却不署名，是实打实的侵权行为，跟「DiceBear 是开源的」没关系。
 */
export const PORTRAIT_STYLES: Array<{
  key: string;
  label: string;
  /** 画风的一句话说明，帮玩家判断该选哪个 */
  hint: string;
  license: "CC0" | "CC BY 4.0";
  author: string;
}> = [
  {
    key: "lorelei",
    label: "奇幻",
    hint: "柔和插画，最像角色立绘",
    license: "CC0",
    author: "Lisa Wischofsky",
  },
  {
    key: "adventurer",
    label: "冒险者",
    hint: "经典西幻卡通脸",
    license: "CC BY 4.0",
    author: "Lisa Wischofsky",
  },
  {
    key: "pixel-art",
    label: "像素",
    hint: "配像素风地图最搭",
    license: "CC0",
    author: "DiceBear",
  },
  {
    key: "notionists",
    label: "线稿",
    hint: "黑白线条，安静不抢戏",
    license: "CC0",
    author: "Zoish",
  },
  {
    key: "personas",
    label: "扁平",
    hint: "几何色块，辨识度高",
    license: "CC BY 4.0",
    author: "Draftbit",
  },
  {
    key: "open-peeps",
    label: "手绘",
    hint: "粗线条涂鸦感",
    license: "CC0",
    author: "Pablo Stanley",
  },
];

export type PortraitStyle = (typeof PORTRAIT_STYLES)[number]["key"];

export const DEFAULT_STYLE: PortraitStyle = "lorelei";

/**
 * 边框。这是「没有图」时玩家唯一能表达自己的地方，也是让一堆尺寸不一的
 * 玩家图片看起来像同一套棋子的关键 —— 统一的边框比统一的图片容易得多。
 *
 * 三个颜色一组：外圈（压暗）、主环、内高光。用三层同心圆叠出金属感，
 * 不用 SVG 渐变 —— 渐变要 <defs> + id，同一页渲染二十个棋子就会有 id 冲突。
 */
export const PORTRAIT_FRAMES: Array<{
  key: string;
  label: string;
  outer: string;
  ring: string;
  highlight: string;
}> = [
  { key: "ember", label: "赤铜", outer: "#3A1C12", ring: "#B4553A", highlight: "#E08A62" },
  { key: "bone", label: "骨白", outer: "#2E2A22", ring: "#B8AE96", highlight: "#EDE4CF" },
  { key: "silver", label: "银", outer: "#24262A", ring: "#8E96A0", highlight: "#D3D9E0" },
  { key: "moss", label: "苔绿", outer: "#1B2A1C", ring: "#5C8250", highlight: "#8FB37C" },
  { key: "violet", label: "紫晶", outer: "#251B33", ring: "#7A5CA0", highlight: "#AE92D0" },
  { key: "ash", label: "灰烬", outer: "#1E1E1E", ring: "#5E5E5E", highlight: "#9A9A9A" },
];

export type PortraitFrame = (typeof PORTRAIT_FRAMES)[number]["key"];

export const DEFAULT_FRAME: PortraitFrame = "ember";

export type Portrait = {
  /**
   * 图片标识。三种合法形态：
   * - ""              没有图，用生成式头像兜底
   * - "p_ab12.webp"   我们自己的存储里的 key，走 /media/ 读
   * - "https://..."   外链，或云图床返回的完整地址
   *
   * 为什么不统一存 key：云图床返回的是它自己的域名下的地址，
   * 硬要压成 key 就得在读取时反查「这个 key 存在哪家」，
   * 换供应商时全表数据都要迁移。存可直接使用的地址，
   * 旧图永远不失效，换供应商只是「新图走新的」，是渐进迁移。
   */
  image: string;
  /** 没有 image 时用哪个风格生成。有 image 时这个字段仍然保留，用于「删图后回到哪个风格」 */
  style: PortraitStyle;
  /** 生成式头像的种子。同一个 seed 永远生成同一张脸，所以它是稳定身份，不是随机数 */
  seed: string;
  frame: PortraitFrame;
};

export const DEFAULT_PORTRAIT: Portrait = {
  image: "",
  style: DEFAULT_STYLE,
  seed: "",
  frame: DEFAULT_FRAME,
};

/* ------------------------------------------------------------------ 校验 */

function pickStyle(raw: unknown): PortraitStyle {
  if (typeof raw === "string" && PORTRAIT_STYLES.some((item) => item.key === raw)) {
    return raw as PortraitStyle;
  }
  return DEFAULT_STYLE;
}

function pickFrame(raw: unknown): PortraitFrame {
  if (typeof raw === "string" && PORTRAIT_FRAMES.some((item) => item.key === raw)) {
    return raw as PortraitFrame;
  }
  return DEFAULT_FRAME;
}

export function sanitizePortrait(
  raw: unknown,
  fallbackSeed = "",
): Portrait {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;

  const seed =
    typeof input.seed === "string" ? input.seed.trim().slice(0, 40) : "";

  return {
    image: sanitizeImageRef(input.image),
    style: pickStyle(input.style),
    seed: seed || fallbackSeed.slice(0, 40),
    frame: pickFrame(input.frame),
  };
}

/**
 * 从数据库里的 JSON 字符串还原。
 *
 * fallbackSeed 用来给老数据补一个稳定的种子 —— 老角色的 portrait 是 "{}"，
 * 如果不给种子，DiceBear 会因为它内部的默认 PRNG 而给出一张随机脸，
 * 每次刷新都换人。用角色名当种子，至少「同一个人一直是那张脸」。
 */
export function parsePortrait(
  raw: string | null | undefined,
  fallbackSeed = "",
): Portrait {
  if (!raw) return { ...DEFAULT_PORTRAIT, seed: fallbackSeed.slice(0, 40) };

  try {
    return sanitizePortrait(JSON.parse(raw), fallbackSeed);
  } catch {
    return { ...DEFAULT_PORTRAIT, seed: fallbackSeed.slice(0, 40) };
  }
}

/* ------------------------------------------------------------------ 地址 */

/**
 * DiceBear 的生成地址。
 *
 * 服务端和浏览器都在拼这个字符串，但它只是一段文本，不需要任何运行时依赖。
 * 想彻底去掉这个第三方请求的话，装 @dicebear/core + @dicebear/collection
 * 在本机生成 SVG 即可 —— 换掉这一个函数就行，其余代码不用动。
 *
 * scale=100 是为了把胸像放大到填满圆形裁切。默认 50 会留一圈很宽的空白，
 * 放在棋子上看就是「一个小小的头飘在盘子中间」。
 */
export function generatedAvatarUrl(style: PortraitStyle, seed: string): string {
  const safeStyle = pickStyle(style);
  const safeSeed = encodeURIComponent(seed.slice(0, 40) || "adventurer");

  return `https://api.dicebear.com/9.x/${safeStyle}/svg?seed=${safeSeed}&scale=100`;
}

/**
 * 最终拿去渲染的地址。
 *
 * 有图用图，没图用生成头像。这个函数是把「玩家上传了」和「玩家还没上传」
 * 收敛成一个字符串的地方 —— 渲染层因此完全不需要知道图片从哪来。
 */
export function portraitImageUrl(portrait: Portrait): string {
  return imageRefUrl(portrait.image) || generatedAvatarUrl(portrait.style, portrait.seed);
}

/** 有没有玩家自己的图。决定 UI 上要不要显示「移除图片」 */
export function hasUploadedImage(portrait: Portrait): boolean {
  return hasImageRef(portrait.image);
}

/**
 * 没有图、也没有名字时的兜底字符。
 *
 * 用 [...str][0] 而不是 str[0]：中文和 emoji 都是多码元，
 * str[0] 会把一个 emoji 切成半个代理对，渲染出方块。
 */
export function portraitInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return [...trimmed][0].toUpperCase();
}

/** 需要署名才能商用的风格。UI 上据此决定要不要显示署名行 */
export function needsAttribution(style: PortraitStyle): boolean {
  const item = PORTRAIT_STYLES.find((entry) => entry.key === style);
  return item?.license === "CC BY 4.0";
}
