/**
 * 舞台上的默认站位。
 *
 * 不落库、只存在服务端内存里（见 server/index.ts）。理由：
 * 位置是「这一局的临时摆位」，不是角色的属性。一旦落库就要回答
 * 「重开一局要不要重置」「阶段退回准备要不要清空」这一串问题，
 * 而现在这些问题的答案都是「不用管」。
 *
 * 排成一条微微下沉的弧线，比排成一行更像围坐在桌边。
 */
export function defaultPosition(
  index: number,
  total: number,
): { x: number; y: number } {
  const count = Math.max(1, total);
  // 单人时居中，多人时均匀分布在中间 70% 的横向区间
  const startX = count === 1 ? 50 : 18;
  const endX = count === 1 ? 50 : 82;
  const step = count === 1 ? 0 : (endX - startX) / (count - 1);
  const x = startX + step * index;

  // 中间的人站得稍靠后，两端稍靠前，形成一点纵深
  const mid = (count - 1) / 2;
  const offset = mid === 0 ? 0 : (index - mid) / mid;
  const y = 62 + Math.abs(offset) * 6;

  return { x, y };
}
