import { describe, it, expect } from 'vitest'
import { lineNumberWindow } from './lineNumbers'

const base = {
  lineCount: 100,
  lineHeight: 20,
  scrollTop: 0,
  viewportHeight: 200,
  paddingTop: 9,
  buffer: 2,
}

describe('lineNumberWindow：行号与正文共用同一套坐标', () => {
  it('未滚动时从 1 号开始，首行落在 padding-top', () => {
    const w = lineNumberWindow(base)
    expect(w.first).toBe(1)
    expect(w.numbers[0]).toBe(1)
    expect(w.offsetY).toBe(9)
    expect(w.numbers[w.numbers.length - 1]).toBe(10 + 4 + 1) // 一屏 10 行 + 前后各 2 + 1
  })

  it('滚动 40 行后窗口起点前移 buffer，平移量 = 起点×行高 - scrollTop + padding', () => {
    const w = lineNumberWindow({ ...base, scrollTop: 800 })
    expect(w.first).toBe(39) // 800/20 - 2 = 38（0-based），行号 39
    expect(w.numbers[0]).toBe(39)
    expect(w.offsetY).toBe(9 + 38 * 20 - 800)
  })

  it('窗口末尾不超过总行数，且不会渲染空行号', () => {
    const w = lineNumberWindow({ ...base, lineCount: 5, scrollTop: 0 })
    expect(w.numbers).toEqual([1, 2, 3, 4, 5])
    expect(w.numbers.at(-1)).toBeLessThanOrEqual(5)
  })

  it('滚到末尾时窗口仍贴着最后一行，不会出现空洞', () => {
    const w = lineNumberWindow({ ...base, lineCount: 100, scrollTop: 1980 })
    expect(w.numbers.at(-1)).toBe(100)
    expect(w.numbers[0]).toBeLessThan(w.numbers.at(-1)!)
  })

  it('大文本只渲染一屏 + 缓冲，节点数不随行数增长', () => {
    const small = lineNumberWindow({ ...base, lineCount: 50 })
    const huge = lineNumberWindow({ ...base, lineCount: 1_000_000 })
    expect(huge.numbers.length).toBe(small.numbers.length)
    expect(huge.numbers.length).toBeLessThan(50)
  })

  it('视口变高时窗口变宽，但起点不变', () => {
    const a = lineNumberWindow({ ...base, viewportHeight: 100 })
    const b = lineNumberWindow({ ...base, viewportHeight: 400 })
    expect(a.first).toBe(b.first)
    expect(b.numbers.length).toBeGreaterThan(a.numbers.length)
  })

  it('buffer=0 时起点严格等于当前可见首行', () => {
    const w = lineNumberWindow({ ...base, buffer: 0, scrollTop: 800 })
    expect(w.first).toBe(41) // 800/20 + 1
    expect(w.offsetY).toBe(9 + 40 * 20 - 800)
  })

  it('非法度量值不会算出 NaN 或负行号', () => {
    const w = lineNumberWindow({
      lineCount: 0,
      lineHeight: 0,
      scrollTop: Number.NaN,
      viewportHeight: -1,
      paddingTop: Number.NaN,
    })
    expect(Number.isFinite(w.offsetY)).toBe(true)
    expect(w.numbers[0]).toBe(1)
    expect(w.numbers.every((n) => n >= 1)).toBe(true)
  })
})
