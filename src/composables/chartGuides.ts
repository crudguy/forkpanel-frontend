/**
 * 曲线图的几何/读数辅助（纯函数，供 SystemView 的三张 SVG 共用）。
 * 不引图表库：只补刻度、最近点与 tooltip 边界，仍用 0..100 归一化坐标，
 * preserveAspectRatio / CSS 尺寸由视图控制，因此不同屏幕尺寸下无需重算。
 */

export interface AxisTick {
  /** 0..100 的 y 坐标（与曲线同一坐标系） */
  y: number
  label: string
}

/** 顶 / 中 / 底三条刻度；max<=0 时按 1 处理，避免除零产生 NaN 坐标。 */
export function axisTicks(max: number, format: (v: number) => string): AxisTick[] {
  const hi = max > 0 ? max : 1
  return [hi, hi / 2, 0].map(v => ({ y: 100 - (v / hi) * 100, label: format(v) }))
}

/** 把数值映射到 0..100 的 y 坐标，用于画阈值参考线。 */
export function valueY(value: number, max: number): number {
  const hi = max > 0 ? max : 1
  return 100 - (Math.min(Math.max(value, 0), hi) / hi) * 100
}

/** 鼠标横向比例 → 最近样本下标；越界夹到两端，count<=0 返回 -1。 */
export function nearestIndex(ratio: number, count: number): number {
  if (count <= 0) return -1
  const r = Math.min(Math.max(ratio, 0), 1)
  return Math.min(count - 1, Math.max(0, Math.round(r * (count - 1))))
}

/** tooltip 横向位置夹到 10%~90%，避免贴边被卡片裁掉。 */
export function tipLeft(ratio: number): number {
  return Math.round(Math.min(Math.max(ratio, 0.1), 0.9) * 100)
}
