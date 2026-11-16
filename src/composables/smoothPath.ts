/**
 * 图表曲线的唯一平滑实现。
 *
 * 旧实现把相邻采样点用 `<polyline>` 直连，拐角生硬。这里改用单调三次
 * Hermite（Fritsch–Carlson 斜率）转三次贝塞尔：曲线**逐点穿过原始数据**，
 * 相邻点之间不再过冲（控制点 y 恒在端点区间内），因此不会虚构出数据
 * 之外的峰值，整体趋势与读数保持一致。
 *
 * 坐标沿用现有归一化空间：x ∈ [0,100] 按索引等分，y ∈ [0,100] 自下而上。
 * viewBox / preserveAspectRatio / CSS 尺寸都不动，故屏幕尺寸变化仍由浏览器缩放处理。
 */
export interface CurvePoint {
  x: number
  y: number
}

/** 4 位小数足够覆盖万级采样点（x 间距 0.01）；Number() 去掉尾随 0 省体积。 */
function fmt(v: number): string {
  return String(Number(v.toFixed(4)))
}

/**
 * 把点列变成平滑的 SVG path `d`。
 * 少于两点返回空串——与旧实现的「不渲染」语义一致。
 */
export function smoothCurvePath(points: readonly CurvePoint[]): string {
  const n = points.length
  if (n < 2) return ''

  // 相邻 y 差（x 按索引等分，故以「每步」为单位求斜率，分母恒为 1，
  // 不会因为点数变多 / 间距变小而产生除零或放大误差）。
  const delta = new Array<number>(n - 1)
  for (let i = 0; i < n - 1; i++) delta[i] = points[i + 1].y - points[i].y

  const slope = new Array<number>(n)
  slope[0] = delta[0]
  slope[n - 1] = delta[n - 2]
  for (let i = 1; i < n - 1; i++) {
    const a = delta[i - 1]
    const b = delta[i]
    // 极值点 / 平台取 0 斜率：既避免过冲，也让折返处过渡自然；
    // 同号时取调和平均（≤ 2×较小者），保证控制点不越过相邻端点。
    slope[i] = a * b <= 0 ? 0 : (2 * a * b) / (a + b)
  }

  let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i]
    const p1 = points[i + 1]
    const dx = (p1.x - p0.x) / 3
    const c1x = p0.x + dx
    const c1y = p0.y + slope[i] / 3
    const c2x = p1.x - dx
    const c2y = p1.y - slope[i + 1] / 3
    d += ` C ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p1.x)} ${fmt(p1.y)}`
  }
  return d
}

/** 数值序列 → 归一化点：x 按索引等分，y 夹取到 [0,max] 后自下而上映射。 */
export function seriesPoints(values: readonly number[], max: number): CurvePoint[] {
  const n = values.length
  if (n < 2) return []
  const hi = max > 0 ? max : 1
  return values.map((raw, i) => ({
    x: (i / (n - 1)) * 100,
    y: 100 - (Math.min(Math.max(raw, 0), hi) / hi) * 100,
  }))
}

/**
 * 视图侧入口：数值序列直接得到平滑 path。
 * 非有限值会让 path 整条失效（而不是画一半），与旧实现的空数据态一致。
 */
export function smoothSeriesPath(values: readonly number[], max: number): string {
  if (values.length < 2) return ''
  if (values.some(v => !Number.isFinite(v))) return ''
  return smoothCurvePath(seriesPoints(values, max))
}
