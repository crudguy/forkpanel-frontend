import { describe, it, expect } from 'vitest'
import { cpuTone } from './metricTone'

/**
 * `cpuTone` 的阈值**与图表柱/线共用**（ProfessionalView `coreColor`），目的是让
 * 头部指标卡与图表"说同一件事"。若只改一边，就会出现"卡片显示橙色偏热、同一份
 * 数据的柱子却是灰的"——而两边谁都没报错。这里把档位钉死。
 */
describe('cpuTone', () => {
  it('<60 为中性灰（cpu）：正常占用不该报警', () => {
    expect(cpuTone(0)).toBe('cpu')
    expect(cpuTone(59)).toBe('cpu')
    expect(cpuTone(59.9)).toBe('cpu')
  })

  it('>=60 为 hot（橙），>=85 为 danger（红）', () => {
    // ⚠ 边界本身：60 起即偏热、85 起即危险，都是**闭区间下界**
    expect(cpuTone(60)).toBe('hot')
    expect(cpuTone(84.9)).toBe('hot')
    expect(cpuTone(85)).toBe('danger')
    expect(cpuTone(100)).toBe('danger')
  })

  it('null / undefined 按 0 处理（缺失读数不显示成危险）', () => {
    expect(cpuTone(null)).toBe('cpu')
    expect(cpuTone(undefined)).toBe('cpu')
  })

  it('越界读数不落到意外档位（夹紧语义由调用方保证，这里只钉不崩）', () => {
    expect(cpuTone(-1)).toBe('cpu')
    expect(cpuTone(1000)).toBe('danger')
  })
})
