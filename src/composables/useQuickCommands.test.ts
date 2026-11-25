// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installApiFake } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import {
  PRESET_COMMANDS,
  normalizeCustomCommands,
  useQuickCommands,
  validateQuickCommand,
} from './useQuickCommands'

type Row = { id: number; label: string; cmd: string; desc: string }
type Ctx = { url: string; method: string; body?: unknown }
let rows: Row[]
let fake: ReturnType<typeof installApiFake>

function install() {
  return installApiFake({
    [API.quickCommands.list()]: (raw) => {
      const ctx = raw as Ctx
      if (ctx.method === 'GET') return rows
      const body = (ctx.body ?? {}) as { label?: string; cmd?: string; desc?: string }
      if (ctx.method === 'POST') {
        rows.push({
          id: rows.length + 1,
          label: body.label ?? '', cmd: body.cmd ?? '', desc: body.desc ?? '',
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
      expect(c.label).toBeTruthy()
      expect(c.cmd).toBeTruthy()
      expect(c.builtin).toBe(true)
      expect(c.cmd).not.toMatch(/[\r\n]/)
    }
  })

  it('校验拒绝空值、换行与超长', () => {
    expect(validateQuickCommand({ label: '', cmd: 'ls' })).toContain('名称')
    expect(validateQuickCommand({ label: 'x', cmd: '' })).toContain('命令')
    expect(validateQuickCommand({ label: 'x', cmd: 'ls\nrm -rf /' })).toContain('单行')
    expect(validateQuickCommand({ label: 'x'.repeat(41), cmd: 'ls' })).toContain('名称')
    expect(validateQuickCommand({ label: 'x', cmd: 'a'.repeat(501) })).toContain('命令')
    expect(validateQuickCommand({ label: 'x', cmd: 'ls', desc: 'd'.repeat(81) })).toContain('说明')
    expect(validateQuickCommand({ label: ' 查状态 ', cmd: ' git status ' })).toBeNull()
  })

  it('服务端响应归一：数字 id 转字符串、脏记录丢弃', () => {
    expect(normalizeCustomCommands(null)).toEqual([])
    expect(normalizeCustomCommands('oops')).toEqual([])
    expect(normalizeCustomCommands([
      null,
      { id: 'x', label: 'x', cmd: 'ls' },
      { id: 7, label: ' 一 ', cmd: ' ls -la ', desc: ' 说明 ' },
      { id: 7, label: '重复', cmd: 'pwd' },
      { id: 'p_ls', label: '伪造预置', cmd: 'ls' },
      { id: 9, label: '换行', cmd: 'ls\nwhoami' },
      { id: 10, label: '缺命令', cmd: '' },
    ])).toEqual([{ id: '7', label: '一', cmd: 'ls -la', desc: '说明' }])
  })

  it('load / add / update / remove 全部走服务端 API', async () => {
    rows = [{ id: 1, label: '初始', cmd: 'pwd', desc: '' }]
    const api = useQuickCommands()

    await api.load()
    expect(api.custom.value).toEqual([{ id: '1', label: '初始', cmd: 'pwd', desc: '' }])

    await api.add({ label: '新增', cmd: 'git status', desc: '状态' })
    expect(rows).toHaveLength(2)
    expect(api.custom.value.map((c) => c.label)).toEqual(['初始', '新增'])
    expect(fake.count(API.quickCommands.list(), 'POST')).toBe(1)

    await api.update('1', { label: '改名', cmd: 'pwd' })
    expect(rows[0].label).toBe('改名')
    expect(fake.count(API.quickCommands.item(1), 'PATCH')).toBe(1)

    await api.remove('1')
    expect(rows.map((r) => r.id)).toEqual([2])
    expect(fake.count(API.quickCommands.item(1), 'DELETE')).toBe(1)
  })

  it('非法输入在提交前拦下，不发请求', async () => {
    const api = useQuickCommands()
    await expect(api.add({ label: '', cmd: 'ls' })).rejects.toThrow('请填写名称')
    await expect(api.update('1', { label: 'x', cmd: 'a\nb' })).rejects.toThrow('单行')
    expect(fake.count(API.quickCommands.list(), 'POST')).toBe(0)
    expect(fake.count(API.quickCommands.item(1), 'PATCH')).toBe(0)
  })
})
