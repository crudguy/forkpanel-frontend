/**
 * SiteFormDialog 的「浮层必须渲染在顶层」守卫。
 *
 * 为什么需要这条测试：浮层必须与主弹窗**平级**渲染。一旦被挪进 `v-if="open"` 的块内，
 * 列表行入口触发的路径会**静默失效**——那时主弹窗根本没打开，浮层随宿主一起不存在。
 *
 * 这个故障**三重门禁全抓不到**（实测过）：
 *   `vue-tsc` rc=0 / `vitest` 全过 / `vite build` 成功，
 * 而真机上点列表「证书」按钮**什么都不会发生**（一个 `.mask` 都不出现）。
 * 所以只能靠读源码做结构断言——「判据必须指向被检查的那一份」。
 *
 * ⚠️ 断言的是**层级位置**，不是"组件被引用了"：把标签挪进主弹窗后
 *    `SiteSaveAskDialog` 这串字仍然出现，只数它等于恒绿。
 *
 * 本文件只管**仍在 SiteFormDialog 里的**那个浮层。证书相关的两个浮层
 * （<SiteSslDialog> / <SiteCaHelpDialog>）随证书区搬进了 <SiteSslSection>，
 * 它们的「必须与区块平级」由 `SiteSslSection.guard.test.ts` 钉住——
 * 判据跟着被检查的那份文件走，不在这里留一份「反正它也出现在别处」的假断言。
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
 * 剔掉注释后的脚本段。
 * ⚠️ 不能拿整份 SRC 做「不该出现」的断言：本文件/被检查文件里的**注释正文**也会提到
 * 那些名字（例如「不再有 defineExpose({ applySsl })」这句解释本身就含该字符串），
 * 直接用正则会被自己的注释绊倒（恒红）。
 */
const SCRIPT_NO_COMMENTS = (() => {
  const end = SRC.indexOf('\n<template>')
  expect(end, '脚本段边界定位失败').toBeGreaterThan(0)
  return SRC.slice(0, end)
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
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
  for (const tag of ['SiteSaveAskDialog']) {
    it(`${tag} 在模板根层级出现，且只在根层级出现一次`, () => {
      const top = topLevelTags(tag)
      expect(top.length, `${tag} 在根层级出现了 ${top.length} 次（应为 1）——`
        + '若为 0，它被挪进了某个 v-if 块内，保存二选一会静默失效').toBe(1)

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

describe('证书区已整块搬走，本组件不再替它转发', () => {
  it('SiteSslSection 作为 <section class="sector"> 的直接子元素出现', () => {
    // 必须是直接子元素：跨列规则 `.modal-body .sector > .ssl` 是**直接子**选择器，
    // 中间多包一层 div 会让它失效（且 vue-tsc / build / 单测全绿）。
    expect(TEMPLATE).toMatch(/^ {6}<SiteSslSection\s/m)
  })

  it('不再有 defineExpose({ applySsl }) 这类两跳转发', () => {
    // 列表行「证书」按钮改为直连 SitesView 自己挂的 site=null 实例（见 SitesView）。
    // 若这里又冒出一个转发出口，说明有人把「找一块不在场的组件」那套搬回来了。
    expect(SCRIPT_NO_COMMENTS).not.toMatch(/defineExpose\(\{\s*applySsl\s*\}\)/)
  })

  it('申请证书 / 根证书指引的按钮不再留在本组件模板里', () => {
    expect(TEMPLATE).not.toMatch(/@click="applySslEditing"/)
    expect(TEMPLATE).not.toMatch(/@click="caHelp = true"/)
  })

  it('错误落点仍在（这是本组件唯一保留的 SSL 职责：只有它知道 open）', () => {
    const tag = (TEMPLATE.match(/^ {6}<SiteSslSection[\s\S]*?\/>/m) ?? [''])[0]
    expect(tag, '未找到 <SiteSslSection ... /> 标签').not.toBe('')
    expect(tag, '缺 @ssl-error：证书操作失败会无人展示').toMatch(/@ssl-error="onSslError"/)
    expect(tag, '缺 @ssl-notice：能力未接入时会退化成静默').toMatch(/@ssl-notice="onSslNotice"/)
    expect(tag, '缺 @update:busy：签发期间底部「保存并应用」仍可点').toMatch(/@update:busy=/)
  })
})
