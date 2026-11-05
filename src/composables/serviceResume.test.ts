import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  isRecovered,
  waitForRecovery,
  type RecoveryOptions,
  type ResumeRule,
} from './serviceResume'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('isRecovered —— 三种恢复判据的决策表', () => {
  // 表格逐行断言：三形态 × (断连过 / 没断连) × (版本变了 / 没变)。
  // 写成一格一句而不是一条 `if` 一句，是为了让"把三种语义混成一个布尔参数"的改动
  // 立刻在某一行撞红——混同之后总有一格会变。
  const rows: Array<[ResumeRule, string, boolean, boolean, string]> = [
    // any-response：重启面板，能应答就是好了（版本号无关、有没有断连过无关）
    [{ kind: 'any-response' }, '1.0.0', false, true, '重启面板：没断连过也算恢复'],
    [{ kind: 'any-response' }, '1.0.0', true, true, '重启面板：断连过当然算恢复'],
    // after-down：重启系统，必须先见过断连
    [{ kind: 'after-down' }, '1.0.0', false, false, '重启系统：全程没断连 ⇒ reboot 未生效，不能刷新'],
    [{ kind: 'after-down' }, '1.0.0', true, true, '重启系统：断连过之后能应答 ⇒ 恢复'],
    // version-changed：升级/重装，两个竞态取或
    [{ kind: 'version-changed', from: '1.0.0' }, '1.0.0', false, false, '升级：版本没变、也没断连 ⇒ 旧进程还在应答，不能刷新'],
    [{ kind: 'version-changed', from: '1.0.0' }, '1.0.0', true, true, '升级：断连过之后应答 ⇒ 恢复（哪怕版本号还没读出来）'],
    [{ kind: 'version-changed', from: '1.0.0' }, '1.0.1', false, true, '升级：版本号变了 ⇒ 恢复（没抓到断连也算）'],
    [{ kind: 'version-changed', from: '1.0.0' }, '1.0.1', true, true, '升级：两个条件同时成立'],
  ]
  for (const [rule, app, sawDown, want, why] of rows) {
    it(`${rule.kind} sawDown=${sawDown} app=${app} → ${want}（${why}）`, () => {
      expect(isRecovered(rule, app, sawDown)).toBe(want)
    })
  }
})

/** 把 `waitForRecovery` 的最小可观测面收成一个对象，避免每条用例重复搭脚手架。 */
function harness(overrides: Partial<RecoveryOptions> & { probe: RecoveryOptions['probe'] }) {
  const onReload = vi.fn()
  const onTimeout = vi.fn()
  const opts: RecoveryOptions = {
    rule: { kind: 'version-changed', from: '1.0.0' },
    intervalMs: 2000,
    timeoutMs: 180_000,
    onTimeout,
    onReload,
    ...overrides,
  }
  return { opts, onReload, onTimeout }
}

describe('waitForRecovery —— 轮询、刷新、超时', () => {
  it('版本没变且从未断连：不刷新，到点回调 onTimeout 一次', async () => {
    const probe = vi.fn(() => Promise.resolve('1.0.0'))
    const { opts, onReload, onTimeout } = harness({ probe })
    void waitForRecovery(opts)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(onReload).not.toHaveBeenCalled()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    // 3 分钟 / 2 秒 = 90 次探测：间隔没被写错（写成 0 会打出成千上万次）
    expect(probe).toHaveBeenCalledTimes(90)
  })

  it('先断连、之后同版本应答 ⇒ 立刻刷新（升级不能等版本号变才刷新）', async () => {
    // 头两次探测连接被切断（旧进程正在被杀），第三次旧进程又应答了同版本号
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('1.0.0')
    const { opts, onReload, onTimeout } = harness({ probe })
    void waitForRecovery(opts)
    await vi.advanceTimersByTimeAsync(6000)
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('版本号变了 ⇒ 第一次探测就刷新，且只刷一次（刷新后不再探测）', async () => {
    const probe = vi.fn(() => Promise.resolve('1.0.1'))
    const { opts, onReload } = harness({ probe })
    void waitForRecovery(opts)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('探测抛错不中断等待链（服务没起来是常态，不是异常）', async () => {
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue('1.0.1')
    const { opts, onReload } = harness({ probe })
    // 用 after-down 语义确保"没断连就不刷新"的判据不干扰本次断言
    opts.rule = { kind: 'any-response' }
    void waitForRecovery(opts)
    await vi.advanceTimersByTimeAsync(6000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('超时按总时长计：40s / 1s 恰好 40 次探测（对齐原「40 次 × 1 秒」的重启口径）', async () => {
    const probe = vi.fn(() => Promise.reject(new Error('down')))
    const { opts, onTimeout } = harness({
      probe,
      rule: { kind: 'any-response' },
      intervalMs: 1000,
      timeoutMs: 40_000,
    })
    void waitForRecovery(opts)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(probe).toHaveBeenCalledTimes(40)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('不传 onReload 时用真实 location.reload()（默认动作真的接到浏览器上）', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const { opts } = harness({ probe: () => Promise.resolve('1.0.1') })
    delete (opts as { onReload?: () => void }).onReload
    void waitForRecovery(opts)
    await vi.advanceTimersByTimeAsync(2000)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
