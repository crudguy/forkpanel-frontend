import { describe, it, expect } from 'vitest'
import { generateStrongPassword, passwordPolicyOk } from './password'

describe('password 工具', () => {
  it('默认长度 16', () => {
    expect(generateStrongPassword().length).toBe(16)
  })

  it('可指定长度', () => {
    expect(generateStrongPassword(20).length).toBe(20)
  })

  it('生成的口令全部满足策略（≥10 位且 ≥2 类），多次抽样', () => {
    for (let i = 0; i < 60; i++) {
      expect(passwordPolicyOk(generateStrongPassword())).toBe(true)
    }
  })

  it('生成口令含全部四类字符（强口令而非仅达标）', () => {
    const p = generateStrongPassword()
    expect(/[a-z]/.test(p)).toBe(true)
    expect(/[A-Z]/.test(p)).toBe(true)
    expect(/\d/.test(p)).toBe(true)
    expect(/[^a-zA-Z0-9]/.test(p)).toBe(true)
  })

  it('两次生成大概率不同（随机性）', () => {
    const a = generateStrongPassword()
    const b = generateStrongPassword()
    expect(a).not.toBe(b)
  })

  it('弱口令被策略拒绝（负向）', () => {
    expect(passwordPolicyOk('short')).toBe(false) // 太短
    expect(passwordPolicyOk('alllowercaseonly')).toBe(false) // 单类
    expect(passwordPolicyOk('1234567890')).toBe(false) // 单类（数字）
    expect(passwordPolicyOk('')).toBe(false)
  })
})
