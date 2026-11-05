// @vitest-environment jsdom
/**
 * F-19 后半：命令面板的 Esc 不能只挂在搜索框上。
 *
 * 原实现把 Escape 写在 input 的 @keydown 里——焦点一移到结果列表或页面别处，
 * 键盘用户就关不掉浮层，也没有 Tab 焦点陷阱。接进 useModal 后，判据是
 * 「焦点在浮层外时按 Esc 仍触发 close」，而不是「input 上有 @keydown」。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mountView, type Mounted } from '@/test/mount'
import CommandPalette from '@/components/CommandPalette.vue'

let m: Mounted | null = null
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  f.assertClean()
})

function searchInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.pal input.inp')
  if (!el) throw new Error('命令面板没渲染出搜索框（挂载前提不成立）')
  return el
}

async function openPalette(): Promise<{ onClose: ReturnType<typeof vi.fn> }> {
  const onClose = vi.fn()
  m = await mountView({ component: CommandPalette, props: { open: true, onClose } })
  await m.flush()
  return { onClose }
}

describe('命令面板的模态键盘行为', () => {
  it('打开后自动聚焦搜索框', async () => {
    await openPalette()
    expect(document.activeElement).toBe(searchInput())
  })

  it('焦点在浮层外时按 Esc 仍能关闭（旧实现只挂在 input 上会漏）', async () => {
    const { onClose } = await openPalette()
    const outside = document.createElement('button')
    outside.textContent = '浮层外的按钮'
    document.body.appendChild(outside)
    outside.focus()
    expect(document.activeElement, '前置：焦点确实已经移出浮层').toBe(outside)

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }))
    // useModal 的离场动画 140ms 后才真正 emit('close')。
    await new Promise<void>((r) => setTimeout(r, 220))
    expect(onClose, 'Esc 必须由全局捕获阶段接管').toHaveBeenCalledOnce()
    outside.remove()
  })

  it('Tab 被拦在浮层内，不会把焦点漏到遮罩后面的页面', async () => {
    await openPalette()
    const input = searchInput()
    input.focus()
    const evt = new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    })
    document.dispatchEvent(evt)
    expect(evt.defaultPrevented, 'Tab 必须被焦点陷阱接管').toBe(true)
    expect(document.querySelector('.pal')?.contains(document.activeElement)).toBe(true)
  })
})
