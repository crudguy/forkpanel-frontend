/**
 * SiteFormDialog 的「浮层必须渲染在顶层」守卫。
 *
 * 为什么需要这条测试：三个浮层（签发证书 / 根证书指引 / 保存二选一）必须与主弹窗
 * **平级**渲染。一旦被挪进 `v-if="open"` 的块内，列表行「证书」按钮触发的路径会
 * **静默失效**——那时主弹窗根本没打开，浮层随宿主一起不存在。
 *
 * 这个故障**三重门禁全抓不到**（实测过）：
 *   `vue-tsc` rc=0 / `vitest` 380 条全过 / `vite build` 成功，
 * 而真机上点列表「证书」按钮**什么都不会发生**（一个 `.mask` 都不出现）。
 * 所以只能靠读源码做结构断言——「判据必须指向被检查的那一份」。
 *
 * ⚠️ 断言的是**层级位置**，不是"组件被引用了"：把标签挪进主弹窗后
 *    `SiteSslDialog` 这串字仍然出现 8 次，只数它等于恒绿。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./SiteFormDialog.vue', import.meta.url), 'utf8')

/** 去掉 HTML 注释，避免注释里的示例文字被当成真实标签（恒绿/恒红的常见来源）。 */
const TEMPLATE = (() => {
  const a = SRC.indexOf('<template>')
  const b = SRC.lastIndexOf('</template>')
  expect(a, '模板段定位失败：找不到 <template>').toBeGreaterThan(0)
  expect(b, '模板段定位失败：找不到 </template>').toBeGreaterThan(a)
  return SRC.slice(a, b).replace(/<!--[\s\S]*?-->/g, '')
})()

/**
 * 取顶层渲染的 `<Tag`：缩进恰好两空格 = 组件根层级。
 *
 * 主弹窗是 `<div v-if="open" class="mask">`，它内部任何位置都会缩进 ≥4 空格。
 * 因此"两空格缩进"本身就是"在 v-if 块之外"的等价判据——这正是 `v-else-if has no
 * adjacent v-if` 那类编译错误之外的**语义**约束，Vue 不会替你检查。
 */
function topLevelTags(tag: string): string[] {
  const re = new RegExp(`^  <${tag}(\\s|>)`, 'gm')
  return TEMPLATE.match(re) ?? []
}

describe('SiteFormDialog 浮层必须渲染在 v-if="open" 块之外', () => {
  for (const tag of ['SiteSslDialog', 'SiteCaHelpDialog', 'SiteSaveAskDialog']) {
    it(`${tag} 在模板根层级出现，且只在根层级出现一次`, () => {
      const top = topLevelTags(tag)
      expect(top.length, `${tag} 在根层级出现了 ${top.length} 次（应为 1）——`
        + '若为 0，它被挪进了某个 v-if 块内，列表行入口会静默失效').toBe(1)

      // 全模板里该标签的总出现次数必须等于根层级次数：多出来的就是被嵌进主弹窗了
      const all = TEMPLATE.match(new RegExp(`<${tag}(\\s|>)`, 'g')) ?? []
      expect(all.length, `${tag} 全模板出现 ${all.length} 次，但只有 ${top.length} 次在根层级——`
        + '说明它同时被打包进了主弹窗的 v-if 块（关弹窗即消失）').toBe(top.length)
    })
  }

  it('主弹窗 v-if 块的起止可定位（结构变了必须重新审视本文件的判据）', () => {
    // 本文件所有断言都建立在「主弹窗 = 缩进两空格的 <div v-if="open" class="mask">」之上。
    // 哪天它被改名或改结构，这些断言会变成恒绿的空转——所以先把锚点点死。
    expect(TEMPLATE).toMatch(/^ {2}<div v-if="open" class="mask"/m)
  })
})

describe('证书相关的三个入口都被保留', () => {
  it('defineExpose 暴露 applySsl（列表行「证书」按钮的唯一入口）', () => {
    expect(SRC).toMatch(/defineExpose\(\{\s*applySsl\s*\}\)/)
  })

  it('编辑弹窗内的「申请证书」按钮仍绑在 applySslEditing 上', () => {
    expect(TEMPLATE).toMatch(/@click="applySslEditing"/)
  })

  it('「信任根证书」按钮仍会打开 caHelp', () => {
    expect(TEMPLATE).toMatch(/@click="caHelp = true"/)
  })

  it('签发弹窗的三个回传都接上（少 busy 会让页面底部「取消/保存」在签发期间可点）', () => {
    // 实测：删掉 `@update:busy` 后 vue-tsc rc=0、全部单测仍绿，只有真机上
    // 「签发进行中主弹窗操作条没置灰」这一点点差别——所以只能在这里钉死。
    const tag = (TEMPLATE.match(/^ {2}<SiteSslDialog[\s\S]*?\/>/m) ?? [''])[0]
    expect(tag, '根层级的 <SiteSslDialog ... /> 未找到').not.toBe('')
    expect(tag, '缺 @update:req：签完弹窗不会关').toMatch(/@update:req=/)
    expect(tag, '缺 @update:busy：签发期间宿主不知道在忙').toMatch(/@update:busy=/)
    expect(tag, '缺 @reload：自签成功后证书列表不刷新').toMatch(/@reload=/)
  })
})
