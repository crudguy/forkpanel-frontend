// @vitest-environment jsdom
/**
 * 弹窗打开时的自动聚焦必须落在**可编辑字段**上，而不是右上角的 X。
 *
 * 背景（2026-11-09 真机实测）：`useModal` 原本聚焦 `focusables()[0]`，而模板里
 * 第一个可聚焦元素几乎总是 `<button class="modal-close" aria-label="关闭">`。
 * 于是文件页的「新建文件夹 / 重命名 / 改权限」弹窗打开后，用户得先按两次 Tab
 * 才能开始打字；需要输入确认词的删除框同理。
 *
 * 修在 `useModal`（一处接入，全项目 30+ 个浮层受益），本文件用 ConfirmDialog
 * 钉住两条行为：有输入字段 ⇒ 聚焦它；没有输入字段 ⇒ 聚焦仍在浮层内（不抛错）。
 *
 * ⚠ 判据是 `document.activeElement` 的实际身份，不是「有没有调用 focus()」——
 *   后者可以被一个聚焦到错误元素的实现满足。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mountView, type Mounted } from '@/test/mount'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

let m: Mounted | null = null
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  f.assertClean()
})

describe('弹窗自动聚焦', () => {
  it('需要确认词的确认框：焦点落在输入框，而不是右上角的关闭按钮', async () => {
    m = await mountView({
      component: ConfirmDialog,
      props: { open: true, title: '删除目录', detail: '不可逆', confirmWord: 'demo' },
    })
    await m.flush()

    const input = document.querySelector<HTMLInputElement>('.modal input')
    expect(input, '确认词输入框没渲染出来（挂载前提不成立）').toBeTruthy()
    // 先证明「关闭按钮确实存在且排在 input 之前」——否则这条断言可能因为
    // 模板结构变化（X 被移到后面）而变成恒真的巧合。
    const closeBtn = document.querySelector<HTMLButtonElement>('.modal button[aria-label="关闭"]')
    expect(closeBtn, '关闭按钮没渲染（模板结构已变，本用例前提需复核）').toBeTruthy()
    expect(document.activeElement).toBe(input)
    expect(document.activeElement).not.toBe(closeBtn)
  })

  it('没有输入字段的确认框：焦点仍落在浮层内', async () => {
    m = await mountView({
      component: ConfirmDialog,
      props: { open: true, title: '删除文件' },
    })
    await m.flush()

    expect(document.querySelector('.modal input'), '本用例前提是「无输入字段」').toBeNull()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog, '弹窗没渲染出来').toBeTruthy()
    expect(dialog!.contains(document.activeElement)).toBe(true)
  })
})
