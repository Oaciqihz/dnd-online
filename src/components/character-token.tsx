"use client";

import { useEffect, useState } from "react";
import {
  PORTRAIT_FRAMES,
  portraitImageUrl,
  portraitInitial,
  type Portrait,
} from "@/lib/portrait";

/**
 * 舞台上的棋子（token）。
 *
 * 形态是「圆形徽章」：一张图裁成圆，外面套一圈金属环。
 * 这不是随便定的，是跑团工具几十年下来收敛出的唯一答案 ——
 * Roll20、Foundry、 Fantasy Grounds 的默认 token 全是这个样子。
 * 原因很实际：玩家的图源五花八门（截图、立绘、AI 生成、手机翻拍），
 * 尺寸、构图、色调全都不一致，只有「统一裁圆 + 统一边框」
 * 能让二十个来源混乱的图看起来像同一套棋子。
 *
 * 实现上用 HTML + CSS 而不是 SVG。
 * 之前那版是 SVG 分层路径，因为它是手绘的、必须矢量拼接；
 * 现在内容变成一张位图，SVG 反而处处别扭 —— 图片要 clipPath，
 * clipPath 要唯一 id，同一页二十个棋子就得处理 id 冲突，
 * 而 `rounded-full + overflow-hidden + object-cover` 一行 CSS 就解决了，
 * 还自带「按短边裁切、居中」的正确行为。
 *
 * 用 <img> 而不是 next/image：这些是玩家上传的 512×512 webp，
 * 已经压过一遍了，再过一次 Next 的优化器只会多一次回源和一份磁盘缓存，
 * 而 remotePatterns 还要为每个可能出现的图床域名开白名单 ——
 * 意味着「加一个图床要改配置并重新部署」。不值得。
 */

export function CharacterToken({
  portrait,
  name = "",
  className,
  dimmed = false,
  ring,
}: {
  portrait: Portrait;
  /** 没有图 / 图加载失败时用来显示首字，也用作无障碍标签 */
  name?: string;
  /** 控制尺寸。内部会强制 aspect-square */
  className?: string;
  /** 离线时压暗，让「谁还在」一眼可辨 */
  dimmed?: boolean;
  /** 覆盖边框主色。DM 用金色、自己用亮色，是房间里的身份标识 */
  ring?: string;
}) {
  const frame =
    PORTRAIT_FRAMES.find((item) => item.key === portrait.frame) ??
    PORTRAIT_FRAMES[0];
  const main = ring ?? frame.ring;

  const src = portraitImageUrl(portrait);

  /**
   * 图片加载失败时退回首字。
   *
   * 生成式头像走的是 api.dicebear.com，云图床走的是别人的域名 ——
   * 两者都不在我们的控制范围内，断网、被墙、图床删图都会让 <img> 变成裂图。
   * 而裂图在舞台上是灾难：一个灰方块，完全看不出是谁。
   * 所以宁可退成一个「首字 + 边框」，信息量最少但至少还是个人。
   */
  const [broken, setBroken] = useState(false);

  // src 变了说明玩家换图了，要重新给加载一次机会。
  // 不给这个重置的话，一张图挂过一次之后，这一整局都会停留在首字状态
  useEffect(() => {
    setBroken(false);
  }, [src]);

  return (
    <span
      role="img"
      aria-label={name ? `${name} 的形象` : "角色形象"}
      className={`relative block aspect-square overflow-hidden rounded-full ${
        className ?? ""
      }`}
      style={{
        opacity: dimmed ? 0.38 : 1,
        transition: "opacity 200ms",
        backgroundColor: "#14110D",
        /**
         * 四层 box-shadow 叠出金属环的厚度：
         * 最内一圈暗色（压住图片边缘）、中间是主环、外面再来一圈暗色当外沿，
         * 最后是整体投影，让棋子看起来是立在桌面上而不是浮着的。
         */
        boxShadow: [
          `0 0 0 1px ${frame.outer}`,
          `0 0 0 3px ${main}`,
          `0 0 0 4px ${frame.outer}`,
          "0 3px 8px rgba(0,0,0,0.55)",
          `inset 0 0 0 1px ${frame.highlight}66`,
          "inset 0 -7px 12px rgba(0,0,0,0.4)",
        ].join(", "),
      }}
    >
      {broken ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden>
            <text
              x="50"
              y="50"
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="44"
              fill={frame.highlight}
              style={{ fontFamily: "var(--font-serif, serif)" }}
            >
              {portraitInitial(name)}
            </text>
          </svg>
        </span>
      ) : (
        <img
          src={src}
          alt=""
          // 棋子会被拖动，图片默认的 drag 行为会在指针移动时
          // 弹出一个半透明的拖影，和自定义拖动打架
          draggable={false}
          onError={() => setBroken(true)}
          className="h-full w-full select-none object-cover"
        />
      )}

      {/* 左上高光。强度很低，只为了让圆看起来是凸的而不是一块贴纸 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(circle at 34% 22%, ${frame.highlight}2E, transparent 58%)`,
        }}
      />

      {/* 底部暗角，和舞台地面的投影方向对齐 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.4), transparent 42%)",
        }}
      />
    </span>
  );
}
