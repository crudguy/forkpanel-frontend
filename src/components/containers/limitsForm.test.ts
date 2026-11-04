/**
 * 「编辑资源限制」弹窗的纯逻辑守卫。
 *
 * 为什么值得单独测：这个弹窗是"界面上对用户说的话"与"实际发给 docker 的东西"
 * 之间唯一的换算处，而两类错误都不会被编译 / 类型 / 构建发现：
 * ① 放 `0` 过校验 —— `docker update` 会**静默忽略**它（rc=0 而值不变），
 *    用户看到"已保存"却什么都没发生，是最难发现的一类假控制；
 * ② 脏检查漏了某项 —— 按钮一直可点或一直不可点，用户只会觉得"面板坏了"。
 */
import { describe, expect, it } from 'vitest'
import {
  buildPayload,
  canSubmit,
  cpuError,
  fmtCurrent,
  formFromCurrent,
  isDirty,
  memError,
  type CurrentLimits,
  type LimitsForm,
} from './limitsForm'

const form = (over: Partial<LimitsForm> = {}): LimitsForm => ({
  cpuQuota: '',
  memLimit: '',
  restart: 'no',
  ...over,
})

const cur = (over: Partial<CurrentLimits> = {}): CurrentLimits => ({
  cpu_quota: null,
  mem_limit: null,
  restart: 'no',
  ...over,
})

describe('cpuError：0 必须被拦住（docker 会静默忽略它）', () => {
  it('留空 = 通过（表示"这项不动"）', () => {
    expect(cpuError('')).toBe('')
    expect(cpuError('   ')).toBe('')
  })

  it('正数通过（含小数）', () => {
    expect(cpuError('1')).toBe('')
    expect(cpuError('1.5')).toBe('')
    expect(cpuError('0.25')).toBe('')
  })

  it('0 / 负数 / 非数字 / Infinity 一律拒绝', () => {
    for (const v of ['0', '0.0', '-1', 'abc', 'NaN', 'Infinity']) {
      expect(cpuError(v), `\`${v}\` 不该通过校验`).not.toBe('')
    }
  })
})

describe('memError：口径与后端 mem_limit_is_safe 一致', () => {
  it('留空 = 通过', () => {
    expect(memError('')).toBe('')
  })

  it('数字 + 可选单个 k/m/g（大小写不敏感）', () => {
    for (const v of ['512m', '2g', '64k', '1024', '512M', '2G']) {
      expect(memError(v), `\`${v}\` 应通过`).toBe('')
    }
  })

  it('拒绝错误单位 / 0 / 缺数字', () => {
    for (const v of ['512mb', 'mm', 'm', '0', '0m', '1.5g', '512 m']) {
      expect(memError(v), `\`${v}\` 不该通过校验`).not.toBe('')
    }
  })
})

describe('isDirty：没有变更就不该发请求', () => {
  it('完全一样 ⇒ 不脏', () => {
    const c = cur({ cpu_quota: 1.5, mem_limit: '512m', restart: 'always' })
    expect(isDirty(form({ cpuQuota: '1.5', memLimit: '512m', restart: 'always' }), c)).toBe(false)
  })

  it('内存大小写不同不算变更（512M 与 512m 是同一个值）', () => {
    const c = cur({ mem_limit: '512m' })
    expect(isDirty(form({ memLimit: '512M' }), c)).toBe(false)
  })

  it('留空字段不参与比较（＝这项不动）', () => {
    const c = cur({ cpu_quota: 1.5, mem_limit: '512m' })
    expect(isDirty(form({ cpuQuota: '', memLimit: '' }), c)).toBe(false)
  })

  it('改任一项 ⇒ 脏', () => {
    const c = cur({ cpu_quota: 1.5, mem_limit: '512m', restart: 'no' })
    expect(isDirty(form({ cpuQuota: '2' }), c)).toBe(true)
    expect(isDirty(form({ memLimit: '1g' }), c)).toBe(true)
    expect(isDirty(form({ restart: 'always' }), c)).toBe(true)
  })

  it('原本"不限"、现在填了值 ⇒ 脏（这是给容器加限制的主路径）', () => {
    const c = cur({ cpu_quota: null, mem_limit: null })
    expect(isDirty(form({ cpuQuota: '1' }), c)).toBe(true)
    expect(isDirty(form({ memLimit: '256m' }), c)).toBe(true)
  })

  it('现值没读到 ⇒ 不脏（也就不可提交）', () => {
    expect(isDirty(form({ cpuQuota: '1' }), null)).toBe(false)
  })
})

describe('canSubmit：现值未到 / 有错 / 无变更都必须拦住', () => {
  it('现值未加载 ⇒ 不可提交（不知道会改成什么时不许改生产容器）', () => {
    expect(canSubmit(form({ cpuQuota: '2' }), null)).toBe(false)
  })

  it('有校验错误 ⇒ 不可提交', () => {
    const c = cur({ cpu_quota: 1 })
    expect(canSubmit(form({ cpuQuota: '0', restart: 'always' }), c)).toBe(false)
    expect(canSubmit(form({ memLimit: '512mb', restart: 'always' }), c)).toBe(false)
  })

  it('无变更 ⇒ 不可提交', () => {
    const c = cur({ cpu_quota: 1, mem_limit: '512m', restart: 'no' })
    expect(canSubmit(form({ cpuQuota: '1', memLimit: '512m', restart: 'no' }), c)).toBe(false)
  })

  it('合法变更 ⇒ 可提交', () => {
    const c = cur({ cpu_quota: 1, mem_limit: '512m', restart: 'no' })
    expect(canSubmit(form({ cpuQuota: '1', memLimit: '512m', restart: 'always' }), c)).toBe(true)
  })
})

describe('buildPayload：留空字段必须省略（后端把"未提供"当保持不变）', () => {
  it('只改重启策略时，不带 cpu_quota / mem_limit 键', () => {
    const p = buildPayload(form({ restart: 'unless-stopped' }))
    expect(p).toEqual({ restart: 'unless-stopped' })
    expect('cpu_quota' in p).toBe(false)
    expect('mem_limit' in p).toBe(false)
  })

  it('数值字段转成 number（不是字符串）', () => {
    const p = buildPayload(form({ cpuQuota: ' 1.5 ', memLimit: ' 512m ', restart: 'no' }))
    expect(p.cpu_quota).toBe(1.5)
    expect(typeof p.cpu_quota).toBe('number')
    expect(p.mem_limit).toBe('512m')
    expect(p.restart).toBe('no')
  })
})

describe('现值展示与回填', () => {
  it('null 显示为「不限」，不是 0', () => {
    expect(fmtCurrent(cur())).toBe('CPU 不限 · 内存 不限 · 重启 no')
    expect(fmtCurrent(null)).toBe('—')
  })

  it('有值时按核 / 单位串展示', () => {
    expect(fmtCurrent(cur({ cpu_quota: 1.5, mem_limit: '512m', restart: 'always' })))
      .toBe('CPU 1.5 核 · 内存 512m · 重启 always')
  })

  it('回填：null ⇒ 空串（留空即"不动这项"），有值 ⇒ 原样', () => {
    expect(formFromCurrent(cur({ cpu_quota: null, mem_limit: null, restart: 'no' })))
      .toEqual({ cpuQuota: '', memLimit: '', restart: 'no' })
    expect(formFromCurrent(cur({ cpu_quota: 2, mem_limit: '2g', restart: 'always' })))
      .toEqual({ cpuQuota: '2', memLimit: '2g', restart: 'always' })
  })

  it('回填后再原样提交不应被判为"有变更"（打开弹窗不能凭空可提交）', () => {
    const c = cur({ cpu_quota: 1.5, mem_limit: '512m', restart: 'always' })
    const f = formFromCurrent(c)
    expect(isDirty(f, c)).toBe(false)
    expect(canSubmit(f, c)).toBe(false)
  })
})
