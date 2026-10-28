import { sanitizeImageRef } from "./media/ref";

/**
 * 舞台背景。
 *
 * 两套来源并存，不是二选一：
 *
 * 1. **内置场景**（下面 SCENES 里那 10 个）—— 全部由 CSS 渐变生成，没有一张图片。
 *    体积为 0、切换瞬间完成、永远不会裂图、不需要对象存储、
 *    不需要跟 DM 解释图片比例。它覆盖的是「随手换个气氛」这个高频场景。
 *
 * 2. **DM 上传的地图** —— 跑团真正需要的东西是战术地图：
 *    方格、房间、走廊。这个东西没法用渐变换来，只能让 DM 传。
 *
 * 为什么不是「有了上传就把内置删掉」：上传有成本（体积、带宽、审核、
 * 加载等待），而九成的场景切换根本不需要一张图。保留内置让 DM
 * 在「只是换了个地方」时不必先去找图。
 *
 * 两者的关系是叠加而不是互斥：背景图存在时铺在渐变上面。
 * 渐变退化成「图加载中 / 图挂掉 / contain 留白」时的底色，
 * 所以任何时候舞台上都不会出现一块纯黑的空洞。
 */

export type SceneKey =
  | "tavern"
  | "dungeon"
  | "forest"
  | "snow"
  | "desert"
  | "sea"
  | "cave"
  | "ruins"
  | "city"
  | "void";

/**
 * 背景图怎么填进 16:9 的舞台。
 *
 * 这个开关不是可选项。方格战术图多半是正方形，硬裁成 16:9
 * 会切掉地图上下边缘 —— 而边缘往往正是「走廊通向哪」的关键信息。
 * 但反过来，一张宽幅场景插画用 contain 会上下留两条黑边，很难看。
 *
 * 所以让 DM 自己选，默认 cover（填满、裁边缘），
 * 需要看全整张图时切到 contain。
 */
export type SceneFit = "cover" | "contain";

export type Scene = {
  key: SceneKey;
  label: string;
  /** 给 DM 选场景时看的一句话，说明这个场景适合什么场合 */
  hint: string;
  /** CSS background 简写，可以多层叠加 */
  background: string;
  /** 地面那条线用更亮的颜色，让棋子看起来是站在地上而不是浮着 */
  floor: string;
};

/**
 * 每一层都是「顶部压暗 + 底部径向光」，这是舞台灯光的常见结构：
 * 光从下方或远端来，头顶是暗的。比均匀的纯色底看起来深得多。
 */
const VIGNETTE = "linear-gradient(to bottom, rgba(1,1,1,0.55) 0%, rgba(1,1,1,0) 42%)";

export const SCENES: Scene[] = [
  {
    key: "tavern",
    label: "旅店",
    hint: "暖光、木桌、人声嘈杂。适合开场、接头、打探消息",
    background: `${VIGNETTE}, radial-gradient(ellipse 95% 72% at 50% 108%, #6B3E1F 0%, #2A1A0E 55%, #120B06 100%)`,
    floor: "rgba(217,112,74,0.22)",
  },
  {
    key: "dungeon",
    label: "地窖",
    hint: "潮湿的石壁、火把、回音。适合探索与陷阱",
    background: `${VIGNETTE}, radial-gradient(ellipse 85% 62% at 50% 110%, #2B3A32 0%, #16201C 55%, #0A0F0D 100%)`,
    floor: "rgba(120,160,140,0.18)",
  },
  {
    key: "forest",
    label: "森林",
    hint: "树影、湿润的泥土。适合伏击与追踪",
    background: `${VIGNETTE}, radial-gradient(ellipse 88% 66% at 50% 106%, #2C4526 0%, #162415 55%, #08110A 100%)`,
    floor: "rgba(150,190,110,0.18)",
  },
  {
    key: "snow",
    label: "雪原",
    hint: "强光、风雪、脚印。适合长途跋涉与失温",
    background: `${VIGNETTE}, radial-gradient(ellipse 92% 70% at 50% 112%, #8FA3B3 0%, #4C5D6B 58%, #212B34 100%)`,
    floor: "rgba(226,238,248,0.28)",
  },
  {
    key: "desert",
    label: "荒漠",
    hint: "烈日、沙丘、脱水。适合追逐与遗迹",
    background: `${VIGNETTE}, radial-gradient(ellipse 92% 70% at 50% 112%, #C79A55 0%, #7A5628 58%, #33220F 100%)`,
    floor: "rgba(250,199,117,0.24)",
  },
  {
    key: "sea",
    label: "海岸",
    hint: "潮声、礁石、咸风。适合航行与海怪",
    background: `${VIGNETTE}, radial-gradient(ellipse 92% 70% at 50% 114%, #2E6B7C 0%, #17414F 58%, #08202A 100%)`,
    floor: "rgba(93,202,165,0.2)",
  },
  {
    key: "cave",
    label: "洞窟",
    hint: "滴水、绝对的黑、看不见的深处。适合伏击与恐惧",
    background: `${VIGNETTE}, radial-gradient(ellipse 82% 60% at 50% 110%, #3A3350 0%, #1C1830 58%, #0B0916 100%)`,
    floor: "rgba(175,169,236,0.16)",
  },
  {
    key: "ruins",
    label: "废墟",
    hint: "断墙、碎石、旧日的气息。适合考古与诅咒",
    background: `${VIGNETTE}, radial-gradient(ellipse 90% 68% at 50% 110%, #5A4E42 0%, #332B23 58%, #16120E 100%)`,
    floor: "rgba(210,190,160,0.2)",
  },
  {
    key: "city",
    label: "城镇",
    hint: "石板路、灯火、耳目。适合交涉与潜行",
    background: `${VIGNETTE}, radial-gradient(ellipse 90% 70% at 50% 110%, #4E4A46 0%, #2B2926 58%, #131211 100%)`,
    floor: "rgba(200,195,186,0.16)",
  },
  {
    key: "void",
    label: "虚空",
    hint: "没有参照物的地方。适合梦境、传送、Boss 战",
    background: `${VIGNETTE}, radial-gradient(ellipse 78% 58% at 50% 108%, #2A1C4A 0%, #130D22 58%, #040308 100%)`,
    floor: "rgba(138,107,176,0.2)",
  },
];

export const DEFAULT_SCENE: SceneKey = "tavern";

export function findScene(key: string | null | undefined): Scene {
  return SCENES.find((item) => item.key === key) ?? SCENES[0];
}

/** 白名单校验。DM 换场景时传上来的值同样不可信 */
export function sanitizeSceneKey(raw: unknown): SceneKey {
  return SCENES.some((item) => item.key === raw)
    ? (raw as SceneKey)
    : DEFAULT_SCENE;
}

/**
 * 图片怎么填进 16:9 的舞台。
 *
 * 只有两个合法值，所以不需要 SCENE_FITS 数组再 some() 一遍。
 * 传上来的任何东西（含 undefined、数字、原型链上的怪值）一律退成 cover ——
 * 这是"填满"，视觉上永远不会出现空白，是地图默认该有的样子。
 */
export function sanitizeSceneFit(raw: unknown): SceneFit {
  return raw === "contain" ? "contain" : "cover";
}

/**
 * 房间当前该显示成什么样。
 *
 * 这个函数存在的意义是：把「三个字段（key / image / fit）」
 * 收敛成「一处判断」，让渲染层、广播层、服务端渲染都读同一个结果，
 * 不会出现「舞台认为有图、场景条认为没有」这种对不上的情况。
 */
export type RoomScene = {
  key: SceneKey;
  /** 已通过白名单的图片标识，空字符串表示只用内置渐变 */
  image: string;
  fit: SceneFit;
};

export function resolveRoomScene(
  key: string | null | undefined,
  image: string | null | undefined,
  fit: string | null | undefined,
): RoomScene {
  return {
    key: sanitizeSceneKey(key),
    image: sanitizeImageRef(image),
    fit: sanitizeSceneFit(fit),
  };
}
