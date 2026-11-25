import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LS_KEY,
  PRESET_COMMANDS,
  normalizeCustomCommands,
  useQuickCommands,
  validateQuickCommand,
} from './useQuickCommands'

function makeStore() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
    clear: () => data.clear(),
  }
}

describe('快捷命令数据层', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeStore())
  })

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

  it('归一化丢弃脏记录并去重、trim', () => {
    expect(normalizeCustomCommands(null)).toEqual([])
    expect(normalizeCustomCommands('oops')).toEqual([])
    const raw = [
      null,
      42,
      { id: '', label: 'x', cmd: 'ls' },
      { id: 'a', label: ' 一 ', cmd: ' ls -la ', desc: ' 说明 ' },
      { id: 'a', label: '重复', cmd: 'pwd' },
      { id: 'p_ls', label: '伪造预置', cmd: 'ls' },
      { id: 'b', label: '换行', cmd: 'ls\nwhoami' },
      { id: 'c', label: '缺命令', cmd: '' },
    ]
    expect(normalizeCustomCommands(raw)).toEqual([
      { id: 'a', label: '一', cmd: 'ls -la', desc: '说明' },
    ])
  })

  it('自定义命令 CRUD 立即落盘，且刷新后能读回', () => {
    const api = useQuickCommands()
    expect(api.all.value.length).toBe(PRESET_COMMANDS.length)

    const created = api.add({ label: '部署', cmd: 'systemctl restart panel', desc: '重启面板' })
    expect(created).not.toBeNull()
    expect(api.custom.value).toHaveLength(1)
    expect(api.all.value.at(-1)?.label).toBe('部署')
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')).toHaveLength(1)

    expect(api.update(created!.id, { label: '重启', cmd: 'systemctl restart panel' })).toBe(true)
    expect(api.custom.value[0].label).toBe('重启')

    // 第二次实例模拟刷新：从落盘数据读回
    const reloaded = useQuickCommands()
    expect(reloaded.custom.value[0].label).toBe('重启')
    expect(reloaded.custom.value[0].desc).toBe('')

    expect(reloaded.remove(created!.id)).toBe(true)
    expect(reloaded.custom.value).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')).toHaveLength(0)
  })

  it('非法输入不入库，预置项不可被改删', () => {
    const api = useQuickCommands()
    expect(api.add({ label: '', cmd: 'ls' })).toBeNull()
    expect(api.add({ label: 'x', cmd: 'a\nb' })).toBeNull()
    expect(api.custom.value).toHaveLength(0)
    expect(api.update(PRESET_COMMANDS[0].id, { label: 'x', cmd: 'y' })).toBe(false)
    expect(api.remove(PRESET_COMMANDS[0].id)).toBe(false)
  })
})
