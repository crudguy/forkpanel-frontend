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
  it('默认档有 svg.icon、尺寸 15、v-html 里有 refresh 的 path', async () => {
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
