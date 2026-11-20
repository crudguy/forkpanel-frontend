import { describe, it, expect } from 'vitest'
import {
  parsePorts, hitsProtectedPort, applyConfirm,
  needsMigration, newPortError, applyToast, portExposure, portExposureLabel,
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

})

describe('needsMigration', () => {
  it('只有 deny/reject 命中受保护端口才要求迁移；放行与否都不要', () => {
    expect(needsMigration('allow', true)).toBe(false)
    expect(needsMigration('deny', true)).toBe(true)
    expect(needsMigration('reject', true)).toBe(true)
    expect(needsMigration('deny', false)).toBe(false)
  })
})

describe('newPortError', () => {
  const blocked = parsePorts('2200-2300', 'deny')

  it('合法新端口放行', () => {
    // 2224 落在 blocked 的 2200-2300 内，合法样例必须取范围外
    expect(newPortError('2323', blocked, [22])).toBeNull()
  })

  it('空 / 非数字 / 超范围都拦住', () => {
    expect(newPortError('', blocked, [22])).toContain('请填写')
    expect(newPortError('22a', blocked, [22])).toContain('请填写')
    expect(newPortError('0', blocked, [22])).toContain('超出范围')
    expect(newPortError('65536', blocked, [22])).toContain('超出范围')
  })

  it('新端口等于当前 SSH 端口＝没迁移，必须拦', () => {
    // 自定义 SSH 端口同样受保护，不能只盯 22
    expect(newPortError('2222', blocked, [22, 2222])).toContain('相同')
  })

  it('新端口落在本次封禁的单端口 / 范围 / all 内都要拦', () => {
    expect(newPortError('8080', parsePorts('80,8080', 'deny'), [22])).toContain('封禁的端口中')
    expect(newPortError('2222', blocked, [22])).toContain('封禁的端口范围内')
    expect(newPortError('2222', parsePorts('all', 'deny'), [22])).toContain('不能封禁全部端口')
  })

  it('源端口解析失败时不误判封禁范围，只校验新端口本身', () => {
    expect(newPortError('2222', parsePorts('', 'deny'), [22])).toBeNull()
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

describe('portExposure', () => {
  it('22 没有显式规则 + accept → 默认放行（列表里看不到它，但它是通的）', () => {
    expect(portExposure(22, [{ ports: '80,443', action: 'allow' }], 'accept')).toBe('default-allow')
  })

  it('显式规则优先：封禁压过放行，范围与 all 都能命中', () => {
    const rules = [
      { ports: '80,443', action: 'allow' },
      { ports: '8000-8100', action: 'deny' },
    ]
    expect(portExposure(80, rules, 'accept')).toBe('explicit-allow')
    expect(portExposure(8001, rules, 'accept')).toBe('explicit-deny')
    expect(portExposure(22, [{ ports: 'all', action: 'reject' }], 'accept')).toBe('explicit-deny')
  })

  it('带来源的规则单独标记，不谎称全局放行/封禁', () => {
    expect(portExposure(22, [{ ports: '22', action: 'allow', source: '1.2.3.0/24' }], 'drop'))
      .toBe('by-source')
  })

  it('默认策略 drop 时未列端口是默认拒绝；读不到策略就是 unknown', () => {
    expect(portExposure(9999, [], 'drop')).toBe('default-deny')
    expect(portExposure(9999, [], null)).toBe('unknown')
  })

  it('默认放行是风险项，色调必须是 warn 而不是 ok', () => {
    expect(portExposureLabel('default-allow')).toEqual({ text: '默认放行', tone: 'primary' })
    expect(portExposureLabel('explicit-deny').tone).toBe('danger')
  })
})
