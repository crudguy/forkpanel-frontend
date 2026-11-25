// @vitest-environment jsdom
/**
 * HelpDrawer 的 Esc 关闭（真挂载 + 真监听器 + 真关开状态）。
 *
 * 背景（真实故障）：`HelpDrawer` 原先写成 `@keydown.esc.window`，真机上
 * **只有焦点恰好在抽屉里**才关得掉——从「?」打开抽屉时焦点还在触发钮（或已落空到
 * `<body>`）上，按键从焦点元素冒泡到 `document` 就结束，挂在 `window` 上的监听点收不到，
 * 按 Esc 毫无反应。9 个用它的页面全都这样。
 *
 * 为什么分两层断言：
 *
 * ① **接线层（本文件的重点）**：spy 住 `document.addEventListener` /
 *    `window.addEventListener`，断言监听挂在 **document** 且 **capture=true**。
 *
 *    这一层是**必须的**，因为 jsdom 测不出真实浏览器的差异：jsdom 里无论监听挂在
 *    `window` 还是 `document`、无论 capture 与否，派发到 body 的事件都能到达——
 *    实测把实现改回旧写法（`window.addEventListener(..., false)`），纯行为断言**7 项全绿**，
 *    即恒绿陷阱。真实浏览器里 `window` 上的监听点收不到从 body 冒泡的事件（事件在
 *    document 就结束，不再上浮到 window 目标）。所以「挂哪里、什么标志」才是判据本身，
 *    不能拿 jsdom 的行为结论替代它。
 *
 * ② **行为层**：关开状态、只认 Escape、未打开不挂、内层 modal 不越级、重开仍生效。
 *    这些 jsdom 能诚实回答，照常验。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import HelpDrawer from './HelpDrawer.vue'

let app: App | null = null
let host: HTMLElement | null = null
let closes = 0

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  closes = 0
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mountDrawer(open = true) {
  const isOpen = ref(open)
  const Parent = defineComponent({
    setup: () => () => h(HelpDrawer, {
      open: isOpen.value,
      title: '测试说明',
      onClose: () => { closes += 1; isOpen.value = false },
    }, { default: () => h('p', '正文') }),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(Parent)
  app.mount(host)
  return {
    setOpen: async (v: boolean) => { isOpen.value = v; await nextTick() },
  }
}

function pressEscOn(target: EventTarget) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
}

describe('① 接线：Esc 监听必须挂在 document 的捕获阶段', () => {
  it('打开时 addEventListener 打在 document 上且 capture=true', async () => {
    const docAdd = vi.spyOn(document, 'addEventListener')
    const winAdd = vi.spyOn(window, 'addEventListener')

    mountDrawer(true)
    await nextTick()

    const escCalls = docAdd.mock.calls.filter(([type]) => type === 'keydown')
    expect(escCalls.length, '打开时应给 document 挂一个 keydown 监听').toBeGreaterThanOrEqual(1)

    const [, , opts] = escCalls[escCalls.length - 1]
    // capture 可能是 boolean 也可能是 { capture: true }
    const captured = opts === true || (typeof opts === 'object' && opts !== null && opts.capture === true)
    expect(captured, '必须是捕获阶段：焦点在外时事件到不了冒泡阶段的上层监听点').toBe(true)

    const winKeydown = winAdd.mock.calls.filter(([type]) => type === 'keydown')
    expect(winKeydown.length, '不得把 Esc 挂到 window（真机上从 body 冒泡的事件收不到）').toBe(0)
  })

  it('收起时摘掉同一个引用（同一 fn、同一标志），不留悬挂监听', async () => {
    const docAdd = vi.spyOn(document, 'addEventListener')
    const docRm = vi.spyOn(document, 'removeEventListener')
    const d = mountDrawer(true)
    await nextTick()

    const addCall = docAdd.mock.calls.filter(([t]) => t === 'keydown').pop()!
    await d.setOpen(false)

    const rmKeydown = docRm.mock.calls.filter(([t]) => t === 'keydown')
    expect(rmKeydown.length, '收起时应解绑').toBeGreaterThanOrEqual(1)
    const last = rmKeydown[rmKeydown.length - 1]
    expect(last[1], '解绑必须用同一个函数引用，否则摘不掉').toBe(addCall[1])
    expect(last[2], '解绑标志必须与挂载一致').toBe(addCall[2])
  })

  it('未打开时不挂任何 keydown 监听', async () => {
    const docAdd = vi.spyOn(document, 'addEventListener')
    mountDrawer(false)
    await nextTick()
    expect(docAdd.mock.calls.filter(([t]) => t === 'keydown').length).toBe(0)
  })
})

describe('② 行为：关开语义', () => {
  it('焦点在 body 时 Esc 关闭', async () => {
    mountDrawer()
    document.body.focus?.()
    pressEscOn(document.body)
    await nextTick()
    expect(closes).toBe(1)
  })

  it('焦点在抽屉外的按钮上时 Esc 关闭', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    mountDrawer()
    pressEscOn(trigger)
    await nextTick()
    expect(closes).toBe(1)
  })

  it('焦点在抽屉内时 Esc 关闭（原有能力不退化）', async () => {
    mountDrawer()
    const closeBtn = document.querySelector<HTMLElement>('.hd-x')
    expect(closeBtn, '抽屉里应有 .hd-x 关闭按钮').toBeTruthy()
    closeBtn!.focus()
    pressEscOn(closeBtn!)
    await nextTick()
    expect(closes).toBe(1)
  })

  it('只有 Escape 才关，其他键不关', async () => {
    mountDrawer()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }))
    await nextTick()
    expect(closes).toBe(0)
  })

  it('内层还有 modal 弹窗时不越级关闭（一次 Esc 只关一层）', async () => {
    mountDrawer()
    const inner = document.createElement('div')
    inner.setAttribute('role', 'dialog')
    inner.setAttribute('aria-modal', 'true')
    document.body.appendChild(inner)

    pressEscOn(document.body)
    await nextTick()
    expect(closes, '内层弹窗打开时应先让内层关').toBe(0)

    inner.remove()
    pressEscOn(document.body)
    await nextTick()
    expect(closes, '内层关闭后 Esc 应关掉抽屉').toBe(1)
  })

  it('收起后再打开，Esc 仍生效（once 型实现会漏）', async () => {
    const d = mountDrawer(true)
    pressEscOn(document.body)
    await nextTick()
    expect(closes).toBe(1)

    pressEscOn(document.body)
    await nextTick()
    expect(closes, '收起后不该再累积').toBe(1)

    await d.setOpen(true)
    pressEscOn(document.body)
    await nextTick()
    expect(closes, '重新打开后必须重新挂上监听').toBe(2)
  })
})
