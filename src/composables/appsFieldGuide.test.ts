import { describe, it, expect } from 'vitest'
import {
  FIELD_LABELS,
  COMMON_FIELD_HINTS,
  runtimeFieldHints,
  allFieldHints,
} from './appsFieldGuide'

/** 后端 `AppRuntime::key()` 的全部取值（8 个）。这里**故意手抄一份**：
 *  测试的作用之一就是钉住「后端加了运行时，前端指引没跟上」——
 *  若从后端动态读，两边永远一致，这条测试就恒绿了。 */
const RUNTIME_KEYS = ['node', 'go', 'rust', 'java', 'python', 'dotnet', 'php', 'custom'] as const

describe('appsFieldGuide', () => {
  it('每个运行时都给出了字段指引（后端加运行时必须来补）', () => {
    for (const k of RUNTIME_KEYS) {
      const hints = runtimeFieldHints(k)
      expect(hints.length, `${k} 没有字段指引`).toBe(3)
    }
  })

  it('未选运行时时返回空数组，不猜默认值', () => {
    expect(runtimeFieldHints('')).toEqual([])
    expect(runtimeFieldHints('unknown-runtime')).toEqual([])
    expect(allFieldHints('')).toEqual([])
  })

  it('每个运行时都覆盖工作目录 / 启动命令 / 监听端口三项', () => {
    for (const k of RUNTIME_KEYS) {
      const fields = runtimeFieldHints(k).map(h => h.field)
      expect(fields, `${k} 的字段集合不对`).toEqual([
        FIELD_LABELS.workdir,
        FIELD_LABELS.execStart,
        FIELD_LABELS.port,
      ])
    }
  })

  it('字段名与表单 label 逐字一致（用户按指引去页面里要能找得到）', () => {
    // 这四个名字是从 AppsView.vue 的表单 label 抄来的，改名必须同步改这里
    expect(FIELD_LABELS.workdir).toBe('工作目录')
    expect(FIELD_LABELS.execStart).toBe('启动命令')
    expect(FIELD_LABELS.port).toBe('监听端口')
    expect(FIELD_LABELS.runUser).toBe('运行用户')
    expect(FIELD_LABELS.domains).toBe('域名')

    const used = [
      ...RUNTIME_KEYS.flatMap(k => runtimeFieldHints(k)),
      ...COMMON_FIELD_HINTS,
    ].map(h => h.field)
    const known = new Set<string>(Object.values(FIELD_LABELS))
    for (const f of used) {
      expect(known.has(f), `指引里出现了表单没有的字段名「${f}」`).toBe(true)
    }
  })

  it('每条指引都给出了可抄的具体值，不是空话', () => {
    const all = [...RUNTIME_KEYS.flatMap(k => runtimeFieldHints(k)), ...COMMON_FIELD_HINTS]
    for (const h of all) {
      expect(h.what.trim().length, `「${h.field}」的说明为空`).toBeGreaterThan(8)
      // 至少带一个可抄的锚点：路径 / 命令 / 端口 / 示例值
      expect(
        /\/opt\/|\/var\/www\/|node |java |gunicorn|dotnet |cargo run|php |\.\/run|127\.0\.0\.1|\d{4}|example\.com|my-/.test(h.what),
        `「${h.field}」的说明里没有可抄的具体值：${h.what}`,
      ).toBe(true)
    }
  })

  it('不同运行时的启动命令互不相同（防止整段复制粘贴）', () => {
    const execs = RUNTIME_KEYS.map(k =>
      runtimeFieldHints(k).find(h => h.field === FIELD_LABELS.execStart)!.what,
    )
    expect(new Set(execs).size).toBe(RUNTIME_KEYS.length)
  })

  it('最后拼出的结果 = 运行时三项 + 公共三项', () => {
    const all = allFieldHints('node')
    expect(all.length).toBe(3 + COMMON_FIELD_HINTS.length)
    expect(all.slice(0, 3).map(h => h.field)).toEqual([
      FIELD_LABELS.workdir,
      FIELD_LABELS.execStart,
      FIELD_LABELS.port,
    ])
    // 公共三项在尾部，且包含名称 / 运行用户 / 域名
    expect(all.slice(3).map(h => h.field)).toEqual(['名称', '运行用户', '域名'])
  })

  it('公共指引里不含与运行时相关的项（避免两处各说一遍）', () => {
    const fields = COMMON_FIELD_HINTS.map(h => h.field)
    expect(fields).not.toContain(FIELD_LABELS.workdir)
    expect(fields).not.toContain(FIELD_LABELS.execStart)
    expect(fields).not.toContain(FIELD_LABELS.port)
  })
})
