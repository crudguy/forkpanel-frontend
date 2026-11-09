// @vitest-environment jsdom
/**
 * 刷新按钮的图标必须**真的渲染出来**，而不只是"源码里写了 <Icon>"。
 *
 * Vue 遇到未注册 / 未 import 的 PascalCase 标签不会报错：它渲染成一个空的自
 * 定义元素（`<icon>`），只在 console 留一条 warning。于是 vue-tsc / vue build /
 * 源码断言全绿，用户看到的却是一个没有图标的按钮。这类静默失效只能靠
 * 「挂载后 querySelector 真有内容」抓到。
 *
 * `Icon.vue` 渲染 `<svg class="icon" ... v-html="ICONS[name] || ''">`，
 * 故判据取：按钮内有 `svg.icon`、尺寸正确、`v-html` 里真的有 path，
 * 且 DOM 里不留 `<icon>` 空元素。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mountView, type Mounted } from '@/test/mount'
import RefreshBtn from '@/components/RefreshBtn.vue'

let m: Mounted | null = null
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  f.assertClean()
})

function icon(mounted: Mounted): SVGSVGElement {
  const svg = mounted.host.querySelector<SVGSVGElement>('button svg.icon')
  if (!svg) {
    throw new Error('刷新按钮里没有 svg.icon —— <Icon> 未解析时 Vue 渲染空 <icon> 元素，'
      + 'tsc / build / 源码断言全绿，图标却是空的')
  }
  return svg
}

describe('RefreshBtn：图标真的渲染（不是空自定义元素）', () => {
  it('默认档有 svg.icon、尺寸 15、图标里真的注入了 refresh 的 path', async () => {
    m = await mountView({ component: RefreshBtn })
    const svg = icon(m)
    expect(svg.getAttribute('width')).toBe('15')
    expect(svg.getAttribute('height')).toBe('15')
    expect(svg.querySelectorAll('path').length, 'ICONS.refresh 必须真的注入').toBeGreaterThan(0)
    expect(m.host.querySelector('icon'), '不许留下未解析的 <icon> 空元素').toBeNull()
  })

  it('sm 档尺寸 14，且按钮带 btn-sm', async () => {
    m = await mountView({ component: RefreshBtn, props: { sm: true } })
    expect(icon(m).getAttribute('width')).toBe('14')
    expect(m.host.querySelector('button')!.classList.contains('btn-sm')).toBe(true)
    expect(m.host.querySelector('icon')).toBeNull()
  })

  it('disabled 态按钮禁用，图标仍然在', async () => {
    m = await mountView({ component: RefreshBtn, props: { disabled: true } })
    expect(m.host.querySelector('button')!.disabled).toBe(true)
    expect(icon(m).querySelectorAll('path').length).toBeGreaterThan(0)
  })
})

/**
 * ≤1400 的「只留图标」降级只发生在**显式声明 collapsible 的调用点**（文件页工具行）。
 * 字被 CSS 收起后，按钮的可访问名称只剩 aria-label —— 读屏用户唯一的信息来源。
 * ⚠ jsdom 不求值媒体查询，所以「文字真的收起了没」只能在真机量（getComputedStyle
 * 的 display + 按钮宽度）；这里钉住的是**文字是否可被 CSS 命中**与**名称是否还在**。
 */
describe('RefreshBtn：≤1400 只留图标（collapsible）不丢可访问名称', () => {
  it('collapsible：文字包在 .tool-label 里（类名对不上则 CSS 收不到），且 aria-label 兜底为「刷新」', async () => {
    m = await mountView({ component: RefreshBtn, props: { collapsible: true } })
    const btn = m.host.querySelector('button')!
    expect(btn.classList.contains('collapsible'), '缺这个类，媒体查询就收不起文字').toBe(true)
    const label = btn.querySelector('.tool-label')
    expect(label?.textContent?.trim(), '.tool-label 是隐藏文字的钩子，文字必须在里面').toBe('刷新')
    expect(btn.getAttribute('aria-label'), '文字被收起后这是唯一的可访问名称').toBe('刷新')
  })

  it('collapsible + title：aria-label 用 title（更具体），不退回笼统的「刷新」', async () => {
    m = await mountView({ component: RefreshBtn, props: { collapsible: true, title: '立即刷新一次文件列表' } })
    const btn = m.host.querySelector('button')!
    expect(btn.getAttribute('aria-label')).toBe('立即刷新一次文件列表')
    expect(btn.getAttribute('title')).toBe('立即刷新一次文件列表')
  })

  it('未声明 collapsible：不带收字钩子（卡片顶栏那 20 处空间宽松，不能被连带收起）', async () => {
    m = await mountView({ component: RefreshBtn, props: { sm: true } })
    const btn = m.host.querySelector('button')!
    expect(btn.classList.contains('collapsible')).toBe(false)
    expect(btn.querySelector('.tool-label')?.textContent?.trim()).toBe('刷新')
  })
})
