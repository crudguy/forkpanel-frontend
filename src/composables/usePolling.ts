/**
 * 统一轮询（全站轮询的唯一实现）。
 *
 * ## 为什么抽它
 * 原先每处各写一份：间隔写死或各自推导、`document.hidden` 暂停只有 6 处做了
 * （Dashboard 10s / TasksView 2s / ContainerLogsDialog 3s 三处漏了，后台标签
 * 持续打后端）、恢复可见时要不要补拉一次也各不相同。规则散在九个文件里，
 * 新增轮询页只能"抄一个最近的"，抄漏哪条都不报错。
 *
 * ## 行为契约
 * - **自调度链**（`setTimeout` 递归而非 `setInterval`）：`ms` 可以是 getter，
 *   改了下一次调度立即用新值，不需要 watcher——也因此**能在组件外调用**
 *   （单测直接调，不依赖组件上下文）。
 * - `enabled`（getter）每 tick 求值：条件恢复后无需任何重启动作即生效。
 * - `pauseWhenHidden`（默认 true）：标签隐藏即停链，恢复可见**立即补一次**再续。
 * - tick 失败（同步 throw / 异步 reject）一律收敛到 `onError`；不传则降级
 *   `console.error`——绝不留下静默的 unhandled rejection（P1-21）。
 * - 间隔下限 200ms：防手滑写 0/1 把后端打爆。
 * - `stop()` 永久停止（供"任务跑完就不轮询"）；`restart()` 解除并重新排队，
 *   **不立即执行**；立即执行用 `run()`。
 * - 在组件内使用时自动注册卸载清理；组件外调用时跳过（无实例不挂钩子）。
 *
 * ## 测试
 * 见 `usePolling.test.ts`（`// @vitest-environment jsdom`：需要 `document`
 * 与 `visibilitychange`，纯 node 环境没有）。jsdom 是本仓库第一个 DOM 依赖，
 * `vitest.config.ts` 的注释本就预留了这条路径（"按文件加
 * `@vitest-environment jsdom`"）——组件级测试迟早要走这一步。
 */
import { getCurrentInstance, onUnmounted } from 'vue'

/** 间隔下限：低于此值的配置视为手误，钳到 200ms（1000ms 内最多 5 次） */
const MIN_MS = 200

export interface PollingOptions {
  /** 每次 tick 执行；返回 Promise 也会被等待（不阻塞调度链） */
  fn: () => void | Promise<void>
  /** 轮询间隔（毫秒），可为 getter——下一次调度即用新值 */
  ms: number | (() => number)
  /** 是否启用；每个 tick 求值，条件恢复后无需重启即生效 */
  enabled?: () => boolean
  /** 标签不可见时是否暂停（默认 true）。false = 后台也继续轮询（慎用） */
  pauseWhenHidden?: boolean
  /** tick 失败回调：同步 throw 与异步 reject 都会进这里。
   *  不传则降级 `console.error`——避免回调 reject 变成静默的 unhandled
   *  rejection，导致页面数据停止更新却无任何错误态（P1-21）。 */
  onError?: (err: unknown) => void
}

export interface PollingHandle {
  /** 立即执行一次（不受 enabled / 隐藏态约束——显式调用即执行） */
  run: () => void
  /** 解除 stop() 的永久停止并按当前配置重新排队；不立即执行 */
  restart: () => void
  /** 永久停止，直到 restart() */
  stop: () => void
}

export function usePolling(opts: PollingOptions): PollingHandle {
  const { fn } = opts
  // ⚠ 必须先取到局部常量再窄化：TS 不会把「属性访问」的窄化带进闭包，
  // 直接写 `() => opts.ms` 会让返回类型退回 `number | (() => number)`。
  const msValue = opts.ms
  const getMs: () => number = typeof msValue === 'function' ? msValue : () => msValue
  const getEnabled = opts.enabled ?? (() => true)
  const pauseWhenHidden = opts.pauseWhenHidden ?? true
  const onError = opts.onError

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const currentMs = () => Math.max(MIN_MS, getMs())

  function clearTimer() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  }

  /** 统一调用 fn：同步 throw 与异步 reject 都收敛到 onError（默认 console.error），
   *  绝不变成静默的 unhandled rejection（P1-21）。**不 await**——保持自调度链不被拖住。 */
  function safeRun() {
    try {
      const r = fn()
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).catch(err => {
          if (onError) onError(err)
          else console.error('[usePolling] 轮询回调失败', err)
        })
      }
    } catch (err) {
      if (onError) onError(err)
      else console.error('[usePolling] 轮询回调失败', err)
    }
  }

  /** 排下一次：永久停止 / 隐藏态不续链。
   *
   *  ⚠ `enabled` **不在这里判断**——只在 tick 里判断。这样禁用期间链保持空转，
   *  条件恢复后下一个 tick 自动生效，不需要 watcher、也不需要调用方 restart。
   *  （在 schedule 里拦掉的话，"恢复"就永远等不到下一次调度。） */
  function schedule() {
    clearTimer()
    if (stopped) return
    if (pauseWhenHidden && document.visibilityState === 'hidden') return
    timer = setTimeout(tick, currentMs())
  }

  function tick() {
    if (stopped) return
    if (getEnabled()) safeRun()
    schedule()
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      // pauseWhenHidden=false 时隐藏不停链（调用方明确要求后台也轮询）
      if (pauseWhenHidden) clearTimer()
      return
    }
    if (stopped || !getEnabled()) return
    // 回可见：立即补一次（不等整周期），再续链
    safeRun()
    schedule()
  }

  function run() { safeRun() }

  function restart() {
    stopped = false
    schedule()
  }

  function stop() {
    stopped = true
    clearTimer()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }
  // 组件外调用（单测）时没有实例，挂 onUnmounted 只会告警——跳过即可。
  if (getCurrentInstance()) {
    onUnmounted(() => {
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibility)
    })
  }

  schedule()

  return { run, restart, stop }
}
