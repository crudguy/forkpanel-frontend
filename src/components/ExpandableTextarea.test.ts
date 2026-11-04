import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 这个组件只有模板行为，vitest 没配 Vue 插件，因此按仓库惯例读源码断言
 * 「一旦改坏就会静默出错」的几处接线，而不是重测 Vue 自身。
 */
const src = readFileSync(
  fileURLToPath(new URL('./ExpandableTextarea.vue', import.meta.url)),
  'utf8',
)

describe('ExpandableTextarea', () => {
  it('两个编辑区共享同一个 v-model，不会各存一份', () => {
    const hits = src.match(/v-model="model"/g) ?? []
    expect(hits).toHaveLength(2)
  })

  it('放大层走 Teleport + 二级遮罩，并接入 useModal 的嵌套 Esc 栈', () => {
    expect(src).toContain('<Teleport to="body">')
    expect(src).toContain('class="mask level-2"')
    expect(src).toContain('useModal(')
  })

  it('放大按钮是 type=button，避免在表单里触发提交', () => {
    expect(src).toMatch(/class="expand-open"[\s\S]*?type="button"/)
  })
})
