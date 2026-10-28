/**
 * 图片标识（image ref）。
 *
 * 头像是用户内容，地图也是用户内容，两者在「库里存什么、怎么校验、
 * 怎么变成 <img src>」这三件事上完全一样。所以这套逻辑只能有一份 ——
 * 安全边界写成两遍，早晚会有一遍被改漏。
 *
 * 库里存三种形态之一：
 * - ""              没有图
 * - "p_ab12.webp"   我们自己的存储里的 key，渲染成 /media/p_ab12.webp
 * - "https://..."   外链，或云图床返回的完整地址
 *
 * 为什么允许 https 绝对地址而不统一压成 key：见 lib/media/storage.ts 的说明 ——
 * 云图床返回的是它自己域名下的地址，硬压成 key 就得在读取时反查供应商，
 * 换供应商时全表都要迁移。存可直接使用的地址，是渐进迁移。
 */

/**
 * 白名单。这个函数是安全边界，不是格式化函数。
 *
 * image 最终会进 <img src>。一旦允许任意字符串，就等于把
 * 「渲染层加载什么地址」交给了请求体。所以只放行两类：
 *
 * - https 绝对地址。不允许 http（https 页面里会静默裂图），
 *   也不允许 `//host` 这种协议相对写法；排除引号和尖括号，避免属性逃逸。
 * - 我们自己的 key：字母数字开头，只含 [a-z0-9._-]。
 *   不允许 "/" 所以拼不出跨目录路径；必须以字母数字开头，
 *   所以 ".." 和 ".hidden" 都被挡掉。
 */
export function sanitizeImageRef(raw: unknown): string {
  if (typeof raw !== "string") return "";

  const value = raw.trim().slice(0, 400);

  if (/^https:\/\/[^\s"'<>\\]+$/i.test(value)) return value;
  if (/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(value)) return value;

  return "";
}

/**
 * 转成能直接放进 src 的地址。
 *
 * 注意它**不做兜底**：没有图就返回 ""，由调用方决定「没图时显示什么」。
 * 头像的兜底是 DiceBear 生成图，地图的兜底是内置 CSS 场景 ——
 * 两种兜底完全不同，所以兜底不能写在这一层。
 */
export function imageRefUrl(ref: string): string {
  const value = ref.trim();

  if (/^https:\/\//i.test(value)) return value;
  if (/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(value)) return `/media/${value}`;

  return "";
}

/** 有没有图。决定 UI 上要不要显示「移除」按钮 */
export function hasImageRef(ref: string): boolean {
  return ref.trim().length > 0;
}

/* ------------------------------------------------------------- 体积上限 */

/**
 * 放在这个文件里，是因为**这个文件能被客户端引用**。
 *
 * storage.ts 里 import 了 node:fs，一旦从那里 import 常量，
 * 整个存储层会被拖进浏览器包，构建直接失败。而 UI 需要知道
 * 「最大能传多大」才能在选图时就拦下来，不必等服务器回 413。
 * 所以常量必须待在一个没有任何 node 依赖的地方。
 */

/** 头像：512×512 webp 一般 40-120KB，2MB 足够容纳原图 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * 地图上限比头像宽得多。
 *
 * DM 手里的素材常常是导出的 PNG 战术图，一张 1080p 的方格图动辄 3-6MB，
 * 沿用头像的 2MB 会把大多数地图直接挡在门外。
 */
export const MAX_MAP_UPLOAD_BYTES = 8 * 1024 * 1024;
