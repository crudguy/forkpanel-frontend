/**
 * 「写操作回执」类行为测试的共用夹具。
 *
 * 为什么单独一份：toast 的断言必须**真挂载 `ToastHost`**——只挂视图时 `toast()` 照样
 * 入队成功，但页面上什么都没有；「弹了提示」和「用户看见了提示」是两件事。
 * 三个视图（防火墙 / 证书 / 任务）各写一遍这套样板，迟早漂成三种（本项目在按钮、
 * 列宽上都吃过这个亏）。
 *
 * 队列是模块级单例，跨用例会串味，故额外提供 `clearToasts`：**每个用例开头调它**。
 */
import { defineComponent, h, type Component } from 'vue'
import ToastHost from '@/components/ToastHost.vue'
import { dismiss, useToasts } from '@/composables/useToast'
import type { Mounted } from './mount'

/** 视图 + 真的 ToastHost 一起挂。 */
export function withToastHost(view: Component): Component {
  return defineComponent({ name: 'ViewWithToastHost', render: () => h('div', [h(view), h(ToastHost)]) })
}

/** 清空队列（上一例的「已续期」不许漂到下一例）。 */
export function clearToasts(): void {
  for (const t of [...useToasts()]) dismiss(t.id)
}

/** 当前渲染出来的提示文案（只取正文，不含图标）。 */
export function toastTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.toast .tx')].map((e) => (e.textContent ?? '').trim())
}

/** 按文案找按钮。root 传 `.mask` 可把范围限定在弹窗内（行内同名按钮会抢先命中）。 */
export function buttonByText(root: ParentNode, text: string | RegExp): HTMLButtonElement {
  const hit = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => {
    const t = (b.textContent ?? '').trim()
    return typeof text === 'string' ? t === text : text.test(t)
  })
  if (!hit) throw new Error(`找不到按钮：${String(text)}`)
  return hit
}

/** 工具条上的「刷新」按钮：写后重载期间必须保持禁用。 */
export function refreshBtn(m: Mounted): HTMLButtonElement {
  return buttonByText(m.host, /刷新$/)
}

/**
 * 受控输入只能走原生 setter + input 事件。
 * 直接赋 `el.value` 时 Vue 的 `v-model` 收不到通知（DOM 变了、状态没变），
 * 后续按钮拿到的是旧值——而断言 `input.value` 又恰好是新的，极难查。
 */
export function setInput(el: HTMLInputElement, v: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTMLInputElement.prototype.value 没有 setter（环境异常）')
  setter.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 把**下一次**匹配的请求整体推后 ms 再交给假件，用来把「重载还没回来」变成可观测状态。
 *
 * ⚠ 不能在假件的路由函数里读 DOM 判「有没有 await」：路由函数是在 fetch 被调用的
 *   **同步阶段**执行的，那一刻 `finally` 还没跑，await 与不 await 一模一样。
 *   必须把调用本身推后。
 */
export function delayNextFetch(url: string, method: string, ms: number): () => void {
  const real = globalThis.fetch
  let armed = true
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const m = (init?.method ?? 'GET').toUpperCase()
    if (armed && u.split('?')[0] === url && m === method) {
      armed = false
      await wait(ms)
    }
    return real(input, init)
  }
  return () => { globalThis.fetch = real }
}
