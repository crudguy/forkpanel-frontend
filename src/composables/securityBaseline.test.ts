import { describe, it, expect } from 'vitest'
import {
  baselineStatus, baselineOpNote, baselineAdvice, canFixBaseline,
  sshResultLabel, sshRiskLabel, sshRiskBadge, sshLogTime,
  type BaselineLike,
} from './securityBaseline'

function item(over: Partial<BaselineLike> = {}): BaselineLike {
  return {
    key: 'ssh.permit_root_login', ok: true, applicable: true,
    current: 'no', expected: 'no', advice: '', ...over,
  }
}

describe('安全基线状态与操作区规则', () => {
  it('不适用优先于 ok：applicable=false 时不得算通过', () => {
    expect(baselineStatus(item({ applicable: false, ok: true }))).toBe('na')
    expect(baselineStatus(item({ ok: true }))).toBe('ok')
    expect(baselineStatus(item({ ok: false }))).toBe('danger')
  })

  it('三种状态都能筛出来——状态值稳定且与汇总卡口径一致', () => {
    const rows = [
      item({ key: 'a', ok: true }),
      item({ key: 'b', ok: false }),
      item({ key: 'c', applicable: false }),
    ]
    expect(rows.filter(r => baselineStatus(r) === 'ok')).toHaveLength(1)
    expect(rows.filter(r => baselineStatus(r) === 'danger')).toHaveLength(1)
    expect(rows.filter(r => baselineStatus(r) === 'na')).toHaveLength(1)
  })

  it('操作区四种规则：可修留空给按钮，其余各有明确文案', () => {
    expect(baselineOpNote(item({ ok: false, key: 'ssh.password_auth' }))).toBe('')
    expect(baselineOpNote(item({ ok: false, key: 'ssh.custom_hardening' }))).toContain('手工')
    expect(baselineOpNote(item({ ok: true }))).toContain('已符合')
    expect(baselineOpNote(item({ applicable: false }))).toContain('不适用')
    expect(canFixBaseline(item({ ok: false, key: 'ssh.pubkey_auth' }))).toBe(true)
    expect(canFixBaseline(item({ ok: true, key: 'ssh.pubkey_auth' }))).toBe(false)
  })

  it('说明区有建议用建议，无建议回落到当前/期望值', () => {
    expect(baselineAdvice(item({ advice: '  请关闭 root 登录  ' }))).toBe('请关闭 root 登录')
    expect(baselineAdvice(item({ advice: '', current: 'yes', expected: 'no' }))).toBe('当前 yes，期望 no')
  })
})

describe('SSH 登录记录展示映射', () => {
  it('结果与风险类型均有中文标签，未知值原样透出', () => {
    expect(sshResultLabel('success')).toBe('成功')
    expect(sshResultLabel('failed')).toBe('失败')
    expect(sshResultLabel('weird')).toBe('weird')
    expect(sshRiskLabel('brute_force')).toBe('疑似爆破')
    expect(sshRiskLabel('root_attempt')).toBe('尝试 root 登录')
  })

  it('风险徽章全部落在全站 badge-* 药丸，高危统一 danger', () => {
    expect(sshRiskBadge('none')).toMatch(/^badge-/)
    expect(sshRiskBadge('failed_password')).toBe('badge-warn')
    expect(sshRiskBadge('root_login')).toBe('badge-danger')
    expect(sshRiskBadge('brute_force')).toBe('badge-danger')
    expect(sshRiskBadge('unknown')).toBe('badge-info')
  })

  it('无时间戳显示破折号，不伪造 1970', () => {
    const fmt = (t: number) => `T${t}`
    expect(sshLogTime(0, fmt)).toBe('—')
    expect(sshLogTime(-1, fmt)).toBe('—')
    expect(sshLogTime(1700000000, fmt)).toBe('T1700000000')
  })
})
