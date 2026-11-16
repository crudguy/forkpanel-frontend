import { describe, it, expect } from 'vitest'
import { seriesPoints, smoothCurvePath, smoothSeriesPath, type CurvePoint } from './smoothPath'

type Pt = [number, number]
interface Seg { p0: Pt; c1: Pt; c2: Pt; p1: Pt }

/** 只按 path 语法取数，不比对整串文本——格式化改动不该让行为测试变红。 */
function parse(d: string): { start: Pt; segs: Seg[] } {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  expect(nums.length).toBeGreaterThanOrEqual(2)
  expect((nums.length - 2) % 6).toBe(0) // 1 个 M + 每段 6 个贝塞尔数
  const pt = (a: number[]): Pt => [a[0], a[1]]
  const start = pt(nums.slice(0, 2))
  const rest = nums.slice(2)
  const segs: Seg[] = []
  let prev = start
  for (let i = 0; i < rest.length; i += 6) {
    const seg: Seg = {
      p0: prev,
      c1: pt(rest.slice(i, i + 2)),
      c2: pt(rest.slice(i + 2, i + 4)),
      p1: pt(rest.slice(i + 4, i + 6)),
    }
    segs.push(seg)
    prev = seg.p1
  }
  return { start, segs }
}

function bezier(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
}

describe('smoothCurvePath', () => {
  it('不足两点返回空串——与旧 polyline 空点串的「不渲染」语义一致', () => {
    expect(smoothCurvePath([])).toBe('')
    expect(smoothCurvePath([{ x: 0, y: 50 }])).toBe('')
    expect(smoothSeriesPath([1], 100)).toBe('')
  })

  it('两点退化为直线段：不凭空造出弧度', () => {
    const { start, segs } = parse(smoothCurvePath([{ x: 0, y: 20 }, { x: 100, y: 80 }]))
    expect(start).toEqual([0, 20])
    expect(segs).toHaveLength(1)
    expect(segs[0].p1).toEqual([100, 80])
    // 两个控制点都落在端点连线上
    for (const c of [segs[0].c1, segs[0].c2]) {
      const cross = (c[0] - 0) * (80 - 20) - (c[1] - 20) * (100 - 0)
      expect(Math.abs(cross)).toBeLessThan(1e-2)
    }
  })

  it('逐点穿过原始数据，且 x 严格递增', () => {
    const pts: CurvePoint[] = [
      { x: 0, y: 50 }, { x: 10, y: 80 }, { x: 20, y: 20 },
      { x: 30, y: 90 }, { x: 40, y: 40 }, { x: 100, y: 60 },
    ]
    const { start, segs } = parse(smoothCurvePath(pts))
    expect(start[0]).toBeCloseTo(pts[0].x, 4)
    expect(start[1]).toBeCloseTo(pts[0].y, 4)
    expect(segs).toHaveLength(pts.length - 1)
    segs.forEach((s, i) => {
      expect(s.p1[0]).toBeCloseTo(pts[i + 1].x, 4)
      expect(s.p1[1]).toBeCloseTo(pts[i + 1].y, 4)
      expect(s.p1[0]).toBeGreaterThan(s.p0[0])
    })
  })

  it('尖峰数据不过冲：曲线恒在相邻点区间内', () => {
    // 两组夹具必须都能区分「调和平均」与「算术平均」：
    // 第一组是反号折返，第二组同号但斜率悬殊——后者用算术平均会顶出端点区间。
    for (const values of [[0, 100, 0, 100, 0], [100, 10, 0, 10, 100]]) {
      const pts = seriesPoints(values, 100)
      const { segs } = parse(smoothCurvePath(pts))
      for (const s of segs) {
        const lo = Math.min(s.p0[1], s.p1[1]) - 1e-4
        const hi = Math.max(s.p0[1], s.p1[1]) + 1e-4
        for (let k = 0; k <= 20; k++) {
          const t = k / 20
          const y = bezier(s.p0[1], s.c1[1], s.c2[1], s.p1[1], t)
          expect(y).toBeGreaterThanOrEqual(lo)
          expect(y).toBeLessThanOrEqual(hi)
          // x 也不能倒退，否则刷新/深链缩放时会出现折返
          const x = bezier(s.p0[0], s.c1[0], s.c2[0], s.p1[0], t)
          expect(x).toBeGreaterThanOrEqual(s.p0[0] - 1e-4)
          expect(x).toBeLessThanOrEqual(s.p1[0] + 1e-4)
        }
      }
    }
  })

  it('平台段保持水平，折返处斜率归零而不是拉出尖角', () => {
    const { segs } = parse(smoothCurvePath(seriesPoints([42, 42, 42, 42], 100)))
    expect(segs).toHaveLength(3)
    for (const s of segs) {
      expect(s.c1[1]).toBe(58) // 100 - 42
      expect(s.c2[1]).toBe(58)
    }
    const turn = parse(smoothCurvePath(seriesPoints([20, 80, 20], 100))).segs
    expect(turn[0].c2[1]).toBeCloseTo(turn[0].p1[1], 4)
    expect(turn[1].c1[1]).toBeCloseTo(turn[1].p0[1], 4)
  })

  it('数据量从 2 到万级都产出有限、单调的 path', () => {
    for (const n of [2, 3, 120, 4096, 10080]) {
      const values = Array.from({ length: n }, (_, i) => (i % 7) * 14)
      const d = smoothSeriesPath(values, 100)
      expect(d).not.toMatch(/NaN|Infinity/)
      expect(parse(d).segs).toHaveLength(n - 1)
    }
  })
})

describe('seriesPoints', () => {
  it('越界值夹取到 [0,max]，x 按索引等分', () => {
    expect(seriesPoints([1], 100)).toEqual([])
    const pts = seriesPoints([-5, 0, 50, 100, 150], 100)
    expect(pts.map(p => p.y)).toEqual([100, 100, 50, 0, 0])
    expect(pts[0].x).toBe(0)
    expect(pts[4].x).toBe(100)
    expect(pts[2].x).toBe(50)
  })

  it('非有限读数不产出半截曲线', () => {
    expect(smoothSeriesPath([1, Number.NaN, 3], 100)).toBe('')
    expect(smoothSeriesPath([1, Number.POSITIVE_INFINITY], 100)).toBe('')
  })
})
