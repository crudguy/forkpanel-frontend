import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useRowLoad } from './useRowLoad'

/**
 * 6 个列表 Tab 共用的加载动作。此前它们各写一份，差异是"手感"而不是设计：
 * 失败要不要清列表、轮询成功要不要自愈清错、轮询失败要不要动 loading。
 * 这里把三条策略逐条钉死——它们都对应一次真实可见的故障：
 *   漏清列表 ⇒ 旧行与错误条并排，用户以为部分加载成功
 *   漏自愈   ⇒ 服务恢复了但错误条一直挂着，只有手动刷新才消失
 *   轮询动 loading ⇒ 每 5 秒闪一次骨架
 */
describe('useRowLoad', () => {
  it('成功：列表更新、错误清空', async () => {
    const rows = ref<string[]>(['旧'])
    const { loading, error, load } = useRowLoad(async () => ['新'], rows)
    const p = load()
    expect(loading.value, '进入即置位（骨架先出现）').toBe(true)
    await p
    expect(rows.value).toEqual(['新'])
    expect(error.value).toBe('')
    expect(loading.value).toBe(false)
  })

  it('失败：清空列表 + 落中文错误 + 复位 loading（三者缺一都是可见故障）', async () => {
    const rows = ref<string[]>(['旧行'])
    const { loading, error, load } = useRowLoad(async () => {
      throw new Error('boom')
    }, rows)
    const ok = await load()
    expect(ok, 'load 返回 Promise<void>（各 Tab 不消费成功与否）').toBeUndefined()
    expect(rows.value, '不清列表 ⇒ 旧行与错误条并排').toEqual([])
    expect(error.value).toBe('请求失败，请稍后重试')
    expect(loading.value, '漏复位 ⇒ 骨架卡死').toBe(false)
  })

  it('silent 失败：列表、错误、loading 全不动（轮询不打扰用户）', async () => {
    const rows = ref<string[]>(['在位的行'])
    const { loading, error, load } = useRowLoad(async () => {
      throw new Error('boom')
    }, rows)
    error.value = '上一轮的错'
    await load(true)
    expect(rows.value).toEqual(['在位的行'])
    expect(error.value, '轮询失败不该覆盖已有错误（可能是更重要的那条）').toBe('上一轮的错')
    expect(loading.value, '轮询失败不许闪骨架').toBe(false)
  })

  it('silent 成功：错误自愈清空，且全程不碰 loading', async () => {
    const rows = ref<string[]>([])
    const { loading, error, load } = useRowLoad(async () => ['a'], rows)
    error.value = '上一次失败的错'
    await load(true)
    expect(error.value, '服务被轮询等回来了，错误条必须自己消失').toBe('')
    expect(loading.value).toBe(false)
    expect(rows.value).toEqual(['a'])
  })

  it('端到端：失败后靠一次轮询自愈（不必手动刷新）', async () => {
    const rows = ref<string[]>([])
    let broken = true
    const { error, load } = useRowLoad(async () => {
      if (broken) throw new Error('down')
      return ['恢复了']
    }, rows)
    await load()
    expect(error.value).not.toBe('')
    broken = false
    await load(true)
    expect(error.value).toBe('')
    expect(rows.value).toEqual(['恢复了'])
  })
})
