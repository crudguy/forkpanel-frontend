/**
 * serviceActionDisabled 的联动矩阵单测（纯函数，无需 DOM）。
 *
 * 锁死需求里的核心约束：
 *  - 运行中 → 启动禁用、停止/重启可用（不能对已在运行的服务重复启动）
 *  - 已停止/失败 → 停止禁用、启动/重启可用（不能对已停的服务重复停止）
 *  - 过渡态 → 三者统一禁用（避免对正在切换的服务叠起停）
 *  - sshd/ssh 永不许停止；无权限 / 正在执行时整组禁用。
 * 这是「判断逻辑抽纯函数」纪律的直接收益：每个分支都能被单测真跑，
 * 而不是散在模板里靠肉眼复查。
 */
import { describe, it, expect } from 'vitest'
import { serviceActionDisabled } from './serviceActionState'

function base(over: Partial<Parameters<typeof serviceActionDisabled>[0]> = {}) {
  return serviceActionDisabled({
    name: 'nginx.service', state: 'active', managed: true, canManage: true, busy: false, ...over,
  })
}

describe('运行中 (active)', () => {
  it('启用停止与重启，禁用启动', () => {
    const d = base({ state: 'active' })
    expect(d.start).toBe(true)
    expect(d.stop).toBe(false)
    expect(d.restart).toBe(false)
  })
})

describe('已停止 (inactive)', () => {
  it('启用启动与重启，禁用停止', () => {
    const d = base({ state: 'inactive' })
    expect(d.start).toBe(false)
    expect(d.stop).toBe(true)
    expect(d.restart).toBe(false)
  })
})

describe('失败 (failed)', () => {
  it('视为未运行：启用启动与重启，禁用停止', () => {
    const d = base({ state: 'failed' })
    expect(d.start).toBe(false)
    expect(d.stop).toBe(true)
    expect(d.restart).toBe(false)
  })
})

describe('过渡态 (activating / deactivating)', () => {
  it('activating：三者统一禁用', () => {
    const d = base({ state: 'activating' })
    expect(d.start).toBe(true)
    expect(d.stop).toBe(true)
    expect(d.restart).toBe(true)
  })
  it('deactivating：三者统一禁用', () => {
    const d = base({ state: 'deactivating' })
    expect(d.start).toBe(true)
    expect(d.stop).toBe(true)
    expect(d.restart).toBe(true)
  })
})

describe('sshd / ssh 防失联', () => {
  it('sshd 运行中：停止仍禁用（双保险），启动因已运行禁用，重启可用', () => {
    const d = base({ name: 'sshd', state: 'active' })
    expect(d.ssh).toBe(true)
    expect(d.stop).toBe(true)
    expect(d.start).toBe(true)
    expect(d.restart).toBe(false)
  })
  it('ssh 已停止：停止禁用、启动可用', () => {
    const d = base({ name: 'ssh', state: 'inactive' })
    expect(d.ssh).toBe(true)
    expect(d.stop).toBe(true)
    expect(d.start).toBe(false)
  })
})

describe('权限与并发叠加', () => {
  it('无管理权限：整组禁用（即便运行中）', () => {
    const d = base({ canManage: false, state: 'active' })
    expect(d.start).toBe(true)
    expect(d.stop).toBe(true)
    expect(d.restart).toBe(true)
  })
  it('正在执行：整组禁用（busy 覆盖一切状态）', () => {
    const d = base({ busy: true, state: 'inactive' })
    expect(d.start).toBe(true)
    expect(d.stop).toBe(true)
    expect(d.restart).toBe(true)
  })
  it('未托管服务（managed=false）不影响矩阵：已停止时启动可用、停止禁用', () => {
    const d = base({ managed: false, state: 'inactive' })
    expect(d.start).toBe(false)
    expect(d.stop).toBe(true)
    expect(d.restart).toBe(false)
  })
})
