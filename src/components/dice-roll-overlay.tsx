"use client";

import { useEffect, useRef, useState } from "react";
import { chatColor } from "@/lib/chat";
import { formatBonus, ROLL_MODE_LABEL } from "@/lib/dice";
import type { DieFace } from "@/lib/dice";
import type { RollResultView } from "@/lib/protocol";

/**
 * 掷骰结果浮层。
 *
 * 这个组件最重要的性质是：**它拿到的是已经确定的结果**。
 *
 * 随机数在服务端、在广播发出之前就掷完了，这里播的那 900ms 动画
 * 只是在延迟揭晓。所以整段动画没有任何一处需要等网络、需要失败回滚、
 * 需要「转到一半发现结果变了」——那些麻烦全都来自「先动后算」的顺序。
 *
 * 这也意味着动画是**纯表现层**：把它整个删掉，功能依然完整，
 * 只是少了一点仪式感。一条不可靠的链路通常就坏在分不清这两件事。
 *
 * 为什么不做 3D：舞台是俯视 2D 棋盘 + 圆形徽章，突然弹出一颗真实的
 * 立体骰子在屏幕上滚，会像是从另一个游戏里贴过来的。扁平、带描边的
 * SVG 骰面，配上和棋子金环、聊天文字同一套色值，才是这套视觉的延伸。
 */

/** 骰面轮廓。没有 d2/d3 —— 跑团里没人用 */
const SHAPES: Record<number, { sides: number; rotate: number; stretch: number }> =
  {
    // 三角形
    4: { sides: 3, rotate: 0, stretch: 1 },
    // 四边形转 45° 才是正方形（不转是菱形，那是 d8）
    6: { sides: 4, rotate: 45, stretch: 1 },
    8: { sides: 4, rotate: 0, stretch: 1 },
    // d10 实际是风筝形，用纵向拉伸的五边形近似 —— 缩到 120px 看不出差别
    10: { sides: 5, rotate: 0, stretch: 1.14 },
    12: { sides: 5, rotate: 0, stretch: 1 },
    20: { sides: 6, rotate: 0, stretch: 1 },
  };

function polygonPoints(
  sides: number,
  radius: number,
  rotateDeg: number,
  stretch: number,
): string {
  const points: string[] = [];

  for (let i = 0; i < sides; i += 1) {
    // 从 -90° 起步，让第一个顶点朝正上方。不这么写的话
    // 三角形会尖朝下，看着像倒过来了
    const angle =
      (Math.PI * 2 * i) / sides - Math.PI / 2 + (rotateDeg * Math.PI) / 180;
    const x = 50 + radius * Math.cos(angle);
    const y = 50 + radius * Math.sin(angle) * stretch;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }

  return points.join(" ");
}

function DieFace({
  faces,
  value,
  color,
  spinning,
}: {
  faces: DieFace;
  value: number;
  color: string;
  spinning: boolean;
}) {
  const shape = SHAPES[faces];

  return (
    <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden>
      {shape ? (
        <polygon
          points={polygonPoints(shape.sides, 44, shape.rotate, shape.stretch)}
          fill="#16130E"
          stroke={color}
          strokeWidth={2.4}
          strokeLinejoin="round"
        />
      ) : (
        // d100 用圆。真正的 d100 是两颗 d10，但界面上只需要一个符号
        <circle cx="50" cy="50" r="44" fill="#16130E" stroke={color} strokeWidth={2.4} />
      )}

      {/*
        d20 的内部棱线：六边形里连两个交错的三角形。
        这两条线几乎不花成本，但正是它让一个普通六边形「看起来像二十面体」。
      */}
      {faces === 20 ? (
        <g stroke={color} strokeWidth={0.9} opacity={0.5} fill="none">
          <polygon points={polygonPoints(3, 44, 0, 1)} />
          <polygon points={polygonPoints(3, 44, 180, 1)} />
        </g>
      ) : null}

      <text
        x="50"
        y="52"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-sans)"
        fontSize={faces === 100 ? 26 : 34}
        fontWeight={500}
        fill={color}
        // 滚动时数字一直变，略微透明让它看起来「还没定」，
        // 定格的瞬间变实，这个对比比任何缩放动画都更有效
        opacity={spinning ? 0.62 : 1}
      >
        {value}
      </text>
    </svg>
  );
}

/** 滚动帧数 × 60ms = 总时长 */
const SPIN_FRAMES = 15;
const SPIN_TICK = 60;

/**
 * 生成滚动的数字序列。
 *
 * 关键的细节是**最后三帧要收敛**：如果直接从随机数硬切到真值，
 * 观感是「跳了一下」；而如果最后几帧围绕真值 ±2、±1 收拢，
 * 看起来才像骰子慢慢停下来。这个差别很小，但它决定了动画像不像骰子。
 */
function buildSpinSequence(faces: number, final: number): number[] {
  const frames: number[] = [];

  for (let i = 0; i < SPIN_FRAMES; i += 1) {
    const left = SPIN_FRAMES - 1 - i;

    if (left === 0) {
      frames.push(final);
    } else if (left <= 2) {
      // 围绕真值小幅摆动，左右交替，避免连续两帧同一个数
      const shift = i % 2 === 0 ? left : -left;
      frames.push(Math.min(faces, Math.max(1, final + shift)));
    } else {
      // 前中段随便跳。乘 37 是质数，能让序列走遍所有余数，
      // 比 Math.random 更稳定 —— 同一份结果每次播放的节奏是一致的
      frames.push(((i * 37 + 11) % faces) + 1);
    }
  }

  return frames;
}

export function DiceRollOverlay({
  result,
  onClose,
}: {
  /** null 表示没有要展示的结果 */
  result: RollResultView | null;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"spin" | "settled">("spin");
  const [display, setDisplay] = useState(1);
  const [angle, setAngle] = useState(0);
  const [entered, setEntered] = useState(false);

  /** 上一次播过的是哪一条结果。用来判断「新结果来了」要不要重新播 */
  const playedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!result) {
      setEntered(false);
      playedRef.current = null;
      return;
    }

    // 同一条结果不重播（重渲染、父组件 state 变了都不该再转一遍）
    if (playedRef.current === result.id) return;
    playedRef.current = result.id;

    const sequence = buildSpinSequence(result.dice.faces, result.pickedValue);

    setPhase("spin");
    setDisplay(sequence[0]);
    setAngle(0);
    setEntered(false);

    // 下一帧再置 true，让 transition 有一次从 0 开始的机会。
    // 同步设置的话元素一挂载就已经是终态，动画不会发生
    const raf = requestAnimationFrame(() => setEntered(true));

    let cursor = 0;
    const timer = setInterval(() => {
      cursor += 1;

      if (cursor >= sequence.length) {
        clearInterval(timer);
        setDisplay(result.pickedValue);
        setPhase("settled");
        // 转回最近的整圈。直接归零会让骰子倒着转回去
        setAngle((prev) => Math.round(prev / 360) * 360);
        return;
      }

      setDisplay(sequence[cursor]);
      setAngle((prev) => prev + 29 + (cursor % 5) * 6);
    }, SPIN_TICK);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, [result]);

  if (!result) return null;

  /**
   * 颜色跟掷骰者走，规则和聊天完全一致（DM 恒为金、玩家用自己的框色）。
   * 复用 chatColor 而不是另写一份，是为了让「同一个人」在舞台浮层、
   * 聊天记录、角色卡三处的颜色永远是同一个值。
   */
  const color = chatColor({ role: result.actorRole, frame: result.actorFrame });
  const spinning = phase === "spin";

  const modeLabel = ROLL_MODE_LABEL[result.dice.mode];
  const extraDice =
    result.dice.mode === "normal" ? [] : result.raw.filter((_, i) => i !== result.picked);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/62 px-4"
      onClick={onClose}
      // 遮罩本身是按钮，键盘用户也要能关掉
      role="button"
      tabIndex={-1}
      aria-label="关闭掷骰结果"
    >
      <div
        className="w-full max-w-[340px] rounded-2xl border border-ink-700 bg-ink-950/96 p-5 text-center"
        onClick={(event) => event.stopPropagation()}
        style={{
          transform: `scale(${entered ? 1 : 0.92})`,
          opacity: entered ? 1 : 0,
          transition: "transform 220ms cubic-bezier(.2,.9,.25,1), opacity 160ms",
        }}
      >
        <div className="mx-auto h-[124px] w-[124px]">
          <div
            style={{
              transform: `rotate(${angle}deg)`,
              transition: spinning
                ? `transform ${SPIN_TICK}ms linear`
                : "transform 300ms cubic-bezier(.2,.9,.25,1)",
            }}
          >
            <DieFace
              faces={result.dice.faces}
              value={display}
              color={color}
              spinning={spinning}
            />
          </div>
        </div>

        <p className="mt-3 text-[13px] font-medium" style={{ color }}>
          {result.actorName}
          <span className="ml-1.5 text-[12px] text-stone-500">
            {result.label}
            {modeLabel !== "普通" ? ` · ${modeLabel}` : ""}
          </span>
        </p>

        {result.note ? (
          <p className="mt-0.5 text-[11.5px] text-stone-600">{result.note}</p>
        ) : null}

        {/*
          结果行在第一帧就渲染、只是用透明度藏起来 ——
          等 settled 再挂载的话，卡片高度会突然跳一下
        */}
        <div
          className="mt-3 flex items-baseline justify-center gap-1.5"
          style={{
            opacity: spinning ? 0 : 1,
            transition: "opacity 240ms 60ms",
          }}
        >
          <span
            className="text-[44px] font-medium leading-none tabular-nums"
            style={{ color }}
          >
            {result.total}
          </span>

          <span className="text-[12px] text-stone-500">
            {result.dice.count > 1
              ? `${result.raw.join(" + ")}`
              : `d${result.dice.faces} ${result.pickedValue}`}
            {result.modifier !== 0 ? ` ${formatBonus(result.modifier)}` : ""}
          </span>
        </div>

        <div
          className="mt-2 space-y-1"
          style={{
            opacity: spinning ? 0 : 1,
            transition: "opacity 240ms 100ms",
          }}
        >
          {/* 优势/劣势要把没选中的那颗也亮出来，否则玩家没法验证你掷了两次 */}
          {extraDice.length > 0 ? (
            <p className="text-[11.5px] text-stone-500">
              两颗 {result.raw.join(" / ")} · {modeLabel}取
              {result.dice.mode === "advantage" ? "高" : "低"}{" "}
              {result.pickedValue}
            </p>
          ) : null}

          {/* 加值的构成摊开写。玩家能自己把 14 + 5 对成 19，就不需要信任任何人 */}
          {result.modifierParts.length > 0 ? (
            <p className="text-[11.5px] text-stone-600">
              {result.modifierParts
                .map((part) => `${part.label} ${formatBonus(part.value)}`)
                .join(" · ")}
            </p>
          ) : null}

          {result.dc !== null ? (
            <p className="text-[12.5px] font-medium">
              <span className="text-stone-500">DC {result.dc} · </span>
              <span
                className={
                  result.outcome === "success" ? "text-emerald-400" : "text-red-400"
                }
              >
                {result.outcome === "success" ? "成功" : "失败"}
              </span>
            </p>
          ) : null}

          {result.natTwenty ? (
            <p className="text-[12.5px] font-medium" style={{ color }}>
              天然 20 · 大成功
            </p>
          ) : null}
          {result.natOne ? (
            <p className="text-[12.5px] font-medium text-red-400">天然 1 · 大失败</p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-lg border border-ink-700 py-1.5 text-[12.5px] text-stone-400 transition hover:border-ink-600 hover:text-parchment"
        >
          关闭
        </button>
      </div>
    </div>
  );
}
