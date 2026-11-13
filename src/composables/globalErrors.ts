/**
 * 全局未处理异常的可见兜底。
 *
 * `app.config.errorHandler` 只覆盖 Vue 组件树内的异常（watcher / 生命周期钩子 /
 * 异步 setup）。树外仍有大片静默区：动态 import 失败（发版后旧页面引用已删除的
 * chunk）、事件处理器里 async 函数抛出的 rejection、路由懒加载失败、定时器回调……
 * 这些只进 console，用户看到的是「点了没反应」。本模块补最后一层。
 *
 * 四条纪律：
 * 1. **只做可见化，不吞异常**：不调 preventDefault，控制台原始堆栈保留供排查。
 * 2. **主动取消不是故障**：AbortError / `request_cancelled` 弹提示反而是噪声。
 * 3. **共用节流窗口**：同一故障常同时触发 error 与 unhandledrejection，只弹一次。
 * 4. **文案不泄露内部机制**：固定中文短句，不回显 reason / stack / URL。
 */

/** 面向用户的兜底文案。错误细节一律只进 console，不回显给用户。 */
export const GLOBAL_ERROR_TEXT = '页面出现异常，请重试或刷新页面'

/** 同一时间窗口内只弹一次；批量 rejection 不应把 toast 队列刷屏。 */
const DEFAULT_THROTTLE_MS = 3000

export interface GlobalErrorSink {
  notify: (text: string) => void
  /** 注入时钟，让节流行为可测（不依赖真实等待）。 */
  now?: () => number
  throttleMs?: number
}

export interface GlobalErrorHandlers {
  onUnhandledRejection: (event: PromiseRejectionEvent) => void
  onError: (event: ErrorEvent) => void
}

/**
 * 是否属于「不该打扰用户」的 rejection。
 *
 * `api/client.ts` 里调用方主动取消会抛 `ApiError(0, 0, 'request_cancelled')`；
 * fetch / AbortSignal.timeout 抛 `AbortError`。二者都是**预期内的控制流**，
 * 若当成页面异常弹提示，用户会在每次主动取消、切页、超时重试时看到红字。
 */
export function isIgnorableGlobalError(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false
  const r = reason as { name?: unknown; code?: unknown; status?: unknown; message?: unknown }
  if (r.name === 'AbortError') return true
  return r.code === 0 && r.status === 0 && r.message === 'request_cancelled'
}

/**
 * 造出两个可挂载的监听器。刻意**不含 DOM 依赖**：接线在 `main.ts`，
 * 行为在本文件里就能被完整断言（vitest 默认 node 环境，无需 jsdom）。
 */
export function createGlobalErrorHandlers(sink: GlobalErrorSink): GlobalErrorHandlers {
  const windowMs = sink.throttleMs ?? DEFAULT_THROTTLE_MS
  const clock = sink.now ?? (() => Date.now())
  let last = Number.NEGATIVE_INFINITY

  const show = () => {
    const now = clock()
    if (now - last < windowMs) return
    last = now
    try {
      sink.notify(GLOBAL_ERROR_TEXT)
    } catch (e) {
      // 兜底自身不能再抛：notify 失败只进 console，原始异常的堆栈仍在上面那条里。
      console.error('[panel] 兜底提示失败：', e)
    }
  }

  return {
    onUnhandledRejection: (event) => {
      const reason = event?.reason
      if (isIgnorableGlobalError(reason)) return
      console.error('[panel] 未处理的 Promise 异常：', reason)
      show()
    },
    onError: (event) => {
      // 资源加载失败（img/script/link）也会冒泡成 window error，但它们的
      // `error` 为空：这类失败由各自的 onerror / UI 兜底，不当页面级异常刷屏。
      if (!event?.error) return
      console.error('[panel] 未捕获的运行时异常：', event.error)
      show()
    },
  }
}
