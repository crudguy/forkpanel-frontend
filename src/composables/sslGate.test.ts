import { describe, expect, it } from 'vitest'
import { sslGate, type SslFacts } from './sslGate'

// 行为测试（不是源码文本镜像）：把四个分支都真跑一遍，钉住「什么时候可签」与
// 「置灰时说什么」。文案与顺序都是用户可见契约，改口径必须在此显式改断言。
const base: SslFacts = {
  webSupported: true,
  sslSupported: true,
  selfSignedSupported: true,
  canSsl: true,
}

describe('sslGate', () => {
  it('四项齐备时可签发', () => {
    expect(sslGate(base)).toEqual({ ready: true, hint: '需 openssl 或 ACME' })
  })

  it('无 ssl.manage 权限时最优先报权限，即便底座与渠道都缺', () => {
    const r = sslGate({ ...base, canSsl: false, webSupported: false, sslSupported: false })
    expect(r.ready).toBe(false)
    expect(r.hint).toBe('无 ssl.manage 权限')
  })

  it('底座不就绪时报「没有进程可加载」，而不是笼统的「不可用」', () => {
    const r = sslGate({ ...base, webSupported: false })
    expect(r.ready).toBe(false)
    expect(r.hint).toContain('Web 服务器')
  })

  it('有底座但两条签发渠道都没有时不可签', () => {
    const r = sslGate({ ...base, sslSupported: false, selfSignedSupported: false })
    expect(r.ready).toBe(false)
    expect(r.hint).toBe('需 openssl 或 ACME')
  })

  it.each([
    ['只有 ACME', { sslSupported: true, selfSignedSupported: false }],
    ['只有自签', { sslSupported: false, selfSignedSupported: true }],
  ])('%s 也算渠道齐备', (_label, diff) => {
    expect(sslGate({ ...base, ...diff }).ready).toBe(true)
  })
})
