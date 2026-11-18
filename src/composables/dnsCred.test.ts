import { describe, it, expect } from 'vitest'
import {
  dns01Gate, selectableCreds, credBadge, credCheckText, validateCredInput,
  providerLabel, dns01Hint, stripErrorWrappers, type DnsCred,
} from './dnsCred'

function cred(p: Partial<DnsCred> = {}): DnsCred {
  return {
    id: 1,
    provider: 'cloudflare',
    provider_label: 'Cloudflare',
    label: '',
    secret_masked: 'abcd******wxyz',
    zone_hint: '',
    usable: true,
    last_check_at: 0,
    last_check_ok: false,
    last_check_msg: '',
    created_at: 0,
    updated_at: 0,
    ...p,
  }
}

describe('selectableCreds', () => {
  it('只保留 usable 的', () => {
    const list = [cred({ id: 1 }), cred({ id: 2, usable: false })]
    expect(selectableCreds(list).map((c) => c.id)).toEqual([1])
  })

  it('全部不可用时返回空（调用方据此判"重填"而非"没配"）', () => {
    expect(selectableCreds([cred({ usable: false })])).toEqual([])
  })
})

describe('dns01Gate', () => {
  it('一张凭据都没有 → 引导去配置，且不是"重填"', () => {
    const g = dns01Gate([], null)
    expect(g.ok).toBe(false)
    expect(g.reason).toContain('还没有配置')
    // 关键区分：此时说"请重填"是错的——没东西可重填
    expect(g.reason).not.toContain('重新填写')
  })

  it('有凭据但全解不开 → 引导重填，且不是"没配"', () => {
    const g = dns01Gate([cred({ usable: false })], null)
    expect(g.ok).toBe(false)
    expect(g.reason).toContain('重新填写')
    expect(g.reason).not.toContain('还没有配置')
  })

  it('只有一家可用且未指定 → 自动选中它（不让用户在单选项上做选择）', () => {
    const g = dns01Gate([cred()], null)
    expect(g.ok).toBe(true)
    expect(g.resolved).toBe('cloudflare')
  })

  it('未指定但有多个可用 → 要求明确指定', () => {
    const g = dns01Gate([cred({ id: 1, provider: 'cloudflare' }), cred({ id: 2, provider: 'aliyun' })], null)
    expect(g.ok).toBe(false)
    expect(g.reason).toContain('请指定')
  })

  it('指定的 provider 无可用凭据 → 点名是哪一家', () => {
    const g = dns01Gate([cred({ provider: 'cloudflare' })], 'aliyun')
    expect(g.ok).toBe(false)
    expect(g.reason).toContain('aliyun')
    expect(g.resolved).toBe('')
  })

  it('指定的 provider 有凭据但不可用 → 仍然拒绝（不能因为"存在"就放行）', () => {
    const g = dns01Gate([cred({ usable: false })], 'cloudflare')
    expect(g.ok).toBe(false)
  })

  it('空白字符串当未指定处理（表单默认值是空串，不能因此报"不支持"）', () => {
    expect(dns01Gate([cred()], '').ok).toBe(true)
    expect(dns01Gate([cred()], '   ').ok).toBe(true)
  })
})

describe('credBadge / credCheckText', () => {
  it('解不开 → err（比"未校验"更严重）', () => {
    expect(credBadge(cred({ usable: false, last_check_ok: true }))).toBe('err')
    expect(credCheckText(cred({ usable: false }))).toContain('重填')
  })

  it('可用但从未校验 → warn', () => {
    expect(credBadge(cred({ last_check_at: 0 }))).toBe('warn')
    expect(credCheckText(cred())).toBe('尚未校验')
  })

  it('校验通过 → ok；校验失败 → err 且带原因', () => {
    expect(credBadge(cred({ last_check_at: 100, last_check_ok: true }))).toBe('ok')
    const bad = cred({ last_check_at: 100, last_check_ok: false, last_check_msg: '9109 Invalid token' })
    expect(credBadge(bad)).toBe('err')
    expect(credCheckText(bad)).toContain('9109')
  })

  it('失败但后端没给原因 → 不留空串尾巴', () => {
    const bad = cred({ last_check_at: 100, last_check_ok: false, last_check_msg: '' })
    expect(credCheckText(bad)).toContain('原因未记录')
  })
})

describe('validateCredInput', () => {
  it('不支持的 provider 拒绝', () => {
    expect(validateCredInput('aliyun', 'x', true)).not.toBe('')
  })

  it('首次添加必须填 secret；编辑态留空合法', () => {
    expect(validateCredInput('cloudflare', '', true)).toContain('必须填写')
    expect(validateCredInput('cloudflare', '', false)).toBe('')
    expect(validateCredInput('cloudflare', '   ', false)).toBe('')
  })

  it('含空格/中文的 token 被拦（典型粘贴错误）', () => {
    expect(validateCredInput('cloudflare', 'abc def', true)).not.toBe('')
    expect(validateCredInput('cloudflare', '令牌值', true)).not.toBe('')
  })

  it('误把后台网址当 token 填 → 明确指出', () => {
    expect(validateCredInput('cloudflare', 'https://dash.cloudflare.com/profile', true)).toContain('网址')
  })

  it('正常 token 通过（不按长度硬卡，避免拦掉合法的新格式）', () => {
    expect(validateCredInput('cloudflare', 'abcdefghijklmnopqrstuvwxyz0123456789-_AB', true)).toBe('')
    // 短 token 也放行：长度由后端/CF 判定，前端卡长度只会误伤
    expect(validateCredInput('cloudflare', 'short', true)).toBe('')
  })
})

describe('providerLabel / dns01Hint', () => {
  it('已知 provider 给展示名，未知原样返回（不吞掉信息）', () => {
    expect(providerLabel('cloudflare')).toBe('Cloudflare')
    expect(providerLabel('weird')).toBe('weird')
  })

  it('提示里必须讲清"不要求 80 可达"——这是选 dns-01 的唯一理由', () => {
    const h = dns01Hint()
    expect(h).toContain('80')
    // 判据锚在"不要求"这个否定上：若哪天文案被改成中性的"需要 80"，
    // 用户会在内网机上选 dns-01 然后失败，而这条断言正是拦这种回退的。
    expect(h).toContain('不要求')
  })
})

describe('stripErrorWrappers', () => {
  it('剥掉实测的两层包装（真机 2026-11-18 抓到的原串）', () => {
    const raw = 'invalid input: token: invalid input: dns: 校验 API Token 失败：[9109] Invalid access token（HTTP 403 Forbidden）'
    const got = stripErrorWrappers(raw)
    expect(got).toBe('校验 API Token 失败：[9109] Invalid access token（HTTP 403 Forbidden）')
    expect(got).not.toContain('invalid input')
  })

  it('本来就干净的中文不被动（清洗不得改变合法文案）', () => {
    const clean = '首次添加 Cloudflare 必须填写 API Token'
    expect(stripErrorWrappers(clean)).toBe(clean)
  })

  it('一层包装也能剥', () => {
    expect(stripErrorWrappers('invalid input: provider: 不支持的 DNS 提供商 `xyz`'))
      .toBe('不支持的 DNS 提供商 `xyz`')
  })

  it('剥空时回落原串——宁可丑也不许把错误信息弄没', () => {
    expect(stripErrorWrappers('invalid input: x: ')).toBe('invalid input: x: ')
  })

  it('不像包装的英文不动（避免误伤 "invalid input format" 这类真实原因）', () => {
    const s = 'invalid input format detected'
    expect(stripErrorWrappers(s)).toBe(s)
  })
})
