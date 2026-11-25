// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installApiFake } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import {
  PRESET_COMMANDS,
  normalizeCustomCommands,
  quickFieldError,
  useQuickCommands,
  validateQuickCommand,
} from './useQuickCommands'

type Row = { id: number; cmd: string; desc: string }
type Ctx = { url: string; method: string; body?: unknown }
let rows: Row[]
let fake: ReturnType<typeof installApiFake>

function install() {
  return installApiFake({
    [API.quickCommands.list()]: (raw) => {
      const ctx = raw as Ctx
      if (ctx.method === 'GET') return rows
      const body = (ctx.body ?? {}) as { cmd?: string; desc?: string }
      if (ctx.method === 'POST') {
        rows.push({
          id: rows.length + 1,
          cmd: body.cmd ?? '', desc: body.desc ?? '',
        })
        return { ok: true }
      }
      const id = Number(ctx.url.split('/').pop())
      if (ctx.method === 'PATCH') {
        const i = rows.findIndex((r) => r.id === id)
        if (i >= 0) rows[i] = { ...rows[i], ...body }
        return { ok: true }
      }
      if (ctx.method === 'DELETE') {
        rows = rows.filter((r) => r.id !== id)
        return { ok: true }
      }
      return rows
    },
  })
}

describe('快捷命令数据层（服务端）', () => {
  beforeEach(() => { rows = []; fake = install() })
  afterEach(() => { fake.assertClean(); fake.restore() })

  it('预置命令字段完整且全部单行', () => {
    expect(PRESET_COMMANDS.length).toBeGreaterThanOrEqual(5)
    for (const c of PRESET_COMMANDS) {
      expect(c.id).toBeTruthy()
      expect(c.cmd).toBeTruthy()
      // 名称字段已移除（040）：命令本身是唯一标识，说明负责解释用途
      expect('label' in c).toBe(false)
      expect(c.builtin).toBe(true)
      expect(c.cmd).not.toMatch(/[\r\n]/)
    }
    // 预置命令之间不能有重复命令，否则浮层里并排两行一模一样
    const cmds = PRESET_COMMANDS.map((c) => c.cmd)
    expect(new Set(cmds).size).toBe(cmds.length)
  })

  it('校验拒绝空值、换行与超长', () => {
    expect(validateQuickCommand({ cmd: '' })).toContain('命令')
    expect(validateQuickCommand({ cmd: 'ls\nrm -rf /' })).toContain('单行')
    expect(validateQuickCommand({ cmd: 'a'.repeat(501) })).toContain('命令')
    expect(validateQuickCommand({ cmd: 'ls', desc: 'd'.repeat(81) })).toContain('说明')
    expect(validateQuickCommand({ cmd: ' git status ' })).toBeNull()
  })

  it('字段级错误指向对应输入框，且与整段文案完全一致', () => {
    const cases: Array<[Parameters<typeof quickFieldError>[0], 'cmd' | 'desc']> = [
      [{ cmd: '' }, 'cmd'],
      [{ cmd: 'ls\nrm -rf /' }, 'cmd'],
      [{ cmd: 'a'.repeat(501) }, 'cmd'],
      [{ cmd: 'ls', desc: 'd'.repeat(81) }, 'desc'],
    ]
    for (const [input, field] of cases) {
      const err = quickFieldError(input)
      expect(err).not.toBeNull()
      expect(err!.field).toBe(field)
      expect(err!.message).toBe(validateQuickCommand(input))
    }
    const taken = new Set(['git status'])
    const dup = quickFieldError({ cmd: ' git status ' }, taken)
    expect(dup?.field).toBe('cmd')
    expect(dup?.message).toBe(validateQuickCommand({ cmd: ' git status ' }, taken))
    expect(quickFieldError({ cmd: 'ls' })).toBeNull()
  })

  it('校验拒绝重复命令（trim 后比较；未传集合时仍只做格式校验）', () => {
    const taken = new Set(['git status', 'clear'])
    expect(validateQuickCommand({ cmd: 'git status' }, taken)).toContain('已存在')
    expect(validateQuickCommand({ cmd: '  git status  ' }, taken)).toContain('已存在')
    expect(validateQuickCommand({ cmd: 'htop' }, taken)).toBeNull()
    expect(validateQuickCommand({ cmd: 'git status' })).toBeNull()
  })

  it('服务端响应归一：数字 id 转字符串、脏记录丢弃', () => {
    expect(normalizeCustomCommands(null)).toEqual([])
    expect(normalizeCustomCommands('oops')).toEqual([])
    expect(normalizeCustomCommands([
      null,
      { id: 'x', cmd: 'ls' },
      { id: 7, cmd: ' ls -la ', desc: ' 说明 ' },
      { id: 7, cmd: 'pwd' },
      // 另一条 id 但命令与上面相同：同用户下命令重复，只留先出现的那条
      { id: 11, cmd: 'ls -la' },
      { id: 'p_ls', cmd: 'ls' },
      { id: 9, cmd: 'ls\nwhoami' },
      { id: 10, cmd: '' },
      // 旧服务端可能仍带 label：多余字段直接忽略，不影响归一
      { id: 12, label: '旧字段', cmd: 'df -h', desc: '' },
    ])).toEqual([
      { id: '7', cmd: 'ls -la', desc: '说明' },
      { id: '12', cmd: 'df -h', desc: '' },
    ])
  })

  it('load / add / update / remove 全部走服务端 API', async () => {
    rows = [{ id: 1, cmd: 'pwd', desc: '' }]
    const api = useQuickCommands()

    await api.load()
    expect(api.custom.value).toEqual([{ id: '1', cmd: 'pwd', desc: '' }])

    await api.add({ cmd: 'git status', desc: '状态' })
    expect(rows).toHaveLength(2)
    expect(api.custom.value.map((c) => c.cmd)).toEqual(['pwd', 'git status'])
    expect(fake.count(API.quickCommands.list(), 'POST')).toBe(1)

    await api.update('1', { cmd: 'whoami' })
    expect(rows[0].cmd).toBe('whoami')
    expect(fake.count(API.quickCommands.item(1), 'PATCH')).toBe(1)

    await api.remove('1')
    expect(rows.map((r) => r.id)).toEqual([2])
    expect(fake.count(API.quickCommands.item(1), 'DELETE')).toBe(1)
  })

  it('请求体不再携带 label（040 已删字段）', async () => {
    const api = useQuickCommands()
    await api.add({ cmd: 'htop', desc: '进程' })
    const body = fake.lastBody(API.quickCommands.list(), 'POST') as Record<string, unknown>
    expect(body).toEqual({ cmd: 'htop', desc: '进程' })
    expect('label' in body).toBe(false)
  })

  it('非法输入在提交前拦下，不发请求', async () => {
    const api = useQuickCommands()
    await expect(api.add({ cmd: '' })).rejects.toThrow('请填写命令')
    await expect(api.update('1', { cmd: 'a\nb' })).rejects.toThrow('单行')
    expect(fake.count(API.quickCommands.list(), 'POST')).toBe(0)
    expect(fake.count(API.quickCommands.item(1), 'PATCH')).toBe(0)
  })
})
