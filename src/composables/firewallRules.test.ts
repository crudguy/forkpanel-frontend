import { describe, it, expect } from 'vitest'
import {
  parsePorts, hitsProtectedPort, applyConfirm, needsLockoutAck, applyToast,
} from './firewallRules'

describe('parsePorts', () => {
  it('单端口 / 范围 / 混合列表都解析', () => {
    const p = parsePorts('80,443,8000-8100', 'allow')
    expect(p.ok).toBe(true)
    expect(p.singles).toEqual([80, 443])
    expect(p.ranges).toEqual([[8000, 8100]])
    expect(p.all).toBe(false)
  })

  it('all 与 * 识别为全部端口', () => {
    expect(parsePorts('all', 'deny').all).toBe(true)
    expect(parsePorts('*', 'deny').all).toBe(true)
  })

  it('非法输入拒绝，且文案随动作变化', () => {
    expect(parsePorts('', 'allow').msg).toBe('请填写要放行的端口')
    expect(parsePorts('', 'deny').msg).toBe('请填写要封禁的端口')
    expect(parsePorts('99999', 'deny').ok).toBe(false)
    expect(parsePorts('100-50', 'deny').ok).toBe(false)
    expect(parsePorts('80; rm -rf /', 'deny').ok).toBe(false)
  })
})

describe('hitsProtectedPort', () => {
  it('单端口命中：SSH 改到 2222 后封 2222 必须命中', () => {
    expect(hitsProtectedPort(parsePorts('2222', 'deny'), [22, 2222])).toBe(true)
    expect(hitsProtectedPort(parsePorts('2222', 'deny'), [22])).toBe(false)
  })

  it('范围命中', () => {
    expect(hitsProtectedPort(parsePorts('2200-2300', 'deny'), [2222])).toBe(true)
    expect(hitsProtectedPort(parsePorts('8000-8100', 'deny'), [2222])).toBe(false)
  })

  it('all 无条件命中，即使保护集为空', () => {
    expect(hitsProtectedPort(parsePorts('all', 'deny'), [])).toBe(true)
  })

  it('放行不算命中，封禁命中才允许越过确认', () => {
    expect(needsLockoutAck('allow', true)).toBe(false)
    expect(needsLockoutAck('deny', true)).toBe(true)
    expect(needsLockoutAck('reject', false)).toBe(false)
  })
})

describe('applyConfirm', () => {
  it('普通封禁：标题不含高危，detail 说清端口与来源', () => {
    const c = applyConfirm('deny', '8080', '', false)
    expect(c.danger).toBe(false)
    expect(c.title).toBe('确认封禁端口')
    expect(c.detail).toContain('8080')
    expect(c.detail).toContain('来源：任意')
  })

  it('命中 SSH：danger + 失联后果 + 端口 + 来源都说到', () => {
    const c = applyConfirm('deny', '2222', '1.2.3.0/24', true)
    expect(c.danger).toBe(true)
    expect(c.detail).toContain('失联')
    expect(c.detail).toContain('2222')
    expect(c.detail).toContain('1.2.3.0/24')
  })

  it('放行 SSH 端口不算高危（即便端口命中保护集）', () => {
    const c = applyConfirm('allow', '2222', '', true)
    expect(c.danger).toBe(false)
    expect(c.title).toBe('确认放行端口')
    expect(c.detail).toContain('放行')
  })

  it('toast 区分放行与封禁', () => {
    expect(applyToast('allow', '80', 1)).toBe('已放行端口 80')
    expect(applyToast('deny', '80', 1)).toBe('已封禁端口 80')
    expect(applyToast('deny', '80', 0)).toBe('端口 80 已在封禁列表中')
  })
})
