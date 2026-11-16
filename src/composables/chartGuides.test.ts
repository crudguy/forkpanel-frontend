import { describe, it, expect } from 'vitest'
import { axisTicks, valueY, nearestIndex, tipLeft } from './chartGuides'

describe('chartGuides', () => {
  it('刻度落在顶/中/底，标签由调用方决定', () => {
    expect(axisTicks(100, v => v.toFixed(0))).toEqual([
      { y: 0, label: '100' }, { y: 50, label: '50' }, { y: 100, label: '0' },
    ])
    expect(axisTicks(8, v => v.toFixed(1)).map(t => t.label)).toEqual(['8.0', '4.0', '0.0'])
  })

  it('max 非法时不产生 NaN 坐标', () => {
    for (const t of axisTicks(0, v => String(v))) {
      expect(Number.isFinite(t.y)).toBe(true)
    }
  })

  it('阈值线与曲线共用同一映射', () => {
    expect(valueY(60, 100)).toBe(40)
    expect(valueY(85, 100)).toBe(15)
    expect(valueY(4, 8)).toBe(50)
    expect(valueY(-5, 100)).toBe(100)
    expect(valueY(500, 100)).toBe(0)
    expect(Number.isFinite(valueY(1, 0))).toBe(true)
  })

  it('最近点：越界夹取、空集返回 -1、中点取中位', () => {
    expect(nearestIndex(0.5, 101)).toBe(50)
    expect(nearestIndex(-1, 101)).toBe(0)
    expect(nearestIndex(2, 101)).toBe(100)
    expect(nearestIndex(0.5, 1)).toBe(0)
    expect(nearestIndex(0.5, 0)).toBe(-1)
  })

  it('tooltip 位置夹在 10%~90%', () => {
    expect(tipLeft(0)).toBe(10)
    expect(tipLeft(0.5)).toBe(50)
    expect(tipLeft(1)).toBe(90)
  })
})
