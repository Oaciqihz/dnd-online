import { randomInt } from "node:crypto";
import { actualDiceCount, type DiceSpec } from "./dice";

/**
 * 真正掷骰的地方。整个项目里唯一产生随机数的地方。
 *
 * 为什么单独一个文件、为什么只有服务端能 import：
 *
 * 1. **客户端绝不能有随机数。** 一旦点数在浏览器里生成再上报，
 *    改一行 localStorage 就能把 nat 1 变成 nat 20。这不是理论风险，
 *    跑团玩家是真的会尝试的。
 * 2. **用 crypto.randomInt 而不是 Math.random。** 后者在 V8 里是
 *    xorshift 类算法，内部状态可以被观察出的序列反推；而且
 *    `Math.floor(Math.random() * 20) + 1` 存在取模偏差 ——
 *    浮点数在 [0,1) 上不是均匀落在 20 个整数区间里的，
 *    某些面会微妙地更常出现。这点偏差小到测不出来，
 *    但「DM 的骰子是不是偏向怪物」这种怀疑一旦产生就无法自证清白了。
 *    randomInt(1, 21) 是无偏的整数采样。
 */
export function rollRaw(spec: DiceSpec): number[] {
  const count = actualDiceCount(spec);
  const raw: number[] = new Array(count);

  for (let i = 0; i < count; i += 1) {
    // randomInt 的上界是开区间，所以 faces + 1 才能取到 faces 本身
    raw[i] = randomInt(1, spec.faces + 1);
  }

  return raw;
}
