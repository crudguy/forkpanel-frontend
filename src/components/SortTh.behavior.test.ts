// @vitest-environment jsdom
/**
 * 排序表头必须键盘可达：这是被十几个列表页复用的公共组件，鼠标点击能用、
 * 键盘用户却无法排序是不可接受的。钉住两件事：
 *  ① <th> 带 tabindex/role，读屏能听到当前排序方向（aria-sort）；
 *  ② Enter / Space 与点击一样触发 sort。
 * 判据是 emit 的真实触发次数与 aria-sort 的实际取值，不是「绑了 onkeydown」源码文本。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountView, type Mounted } from '@/test/mount'
import SortTh from '@/components/SortTh.vue'

let m: Mounted | null = null
let sorts = 0
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  sorts = 0
  f.assertClean()
})

async function mountTh(props: { label: string; active?: boolean; dir?: 'asc' | 'desc' }) {
  sorts = 0
  const Wrap = defineComponent({
    setup() {
      return () => h('table', [h('thead', [h('tr', [
        h(SortTh, { ...props, onSort: () => { sorts += 1 } }),
      ])])])
    },
  })
  m = await mountView({ component: Wrap })
  await m.flush()
  return () => document.querySelector('th.sortable') as HTMLElement
}

describe('SortTh 键盘可达', () => {
  it('表头带 tabindex/role，aria-sort 反映当前排序方向', async () => {
    const th = await mountTh({ label: '名称', active: true, dir: 'desc' })
    expect(th().getAttribute('tabindex')).toBe('0')
    expect(th().getAttribute('role')).toBe('columnheader')
    expect(th().getAttribute('aria-sort')).toBe('descending')
  })

  it('未激活列 aria-sort=none', async () => {
    const th = await mountTh({ label: '名称', active: false })
    expect(th().getAttribute('aria-sort')).toBe('none')
  })

  it('Enter 触发 sort', async () => {
    const th = await mountTh({ label: '名称' })
    th().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await m!.flush()
    expect(sorts).toBe(1)
  })

  it('Space 触发 sort', async () => {
    const th = await mountTh({ label: '名称' })
    th().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    await m!.flush()
    expect(sorts).toBe(1)
  })
})
