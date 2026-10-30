import { ref, computed } from 'vue'

/**
 * 「一键安装 Docker」安装包下载/安装的就地进度状态机（2026-10-30）。
 *
 * ## 为什么抽它
 * 安装是后端任务（pkg.install:docker，apt 下载+解包，常跑 1~5 分钟），此前提交后
 * 只有一条 toast，界面长时间无反馈，用户会以为掉线。现在：任务 SSE
 * （`/api/v1/events/tasks`，事件 progress/log/finished）就地驱动进度条；
 * 任务详情轮询兜底终态（SSE 断线/丢事件也不至于永远转圈）。
 *
 * `.vue` 里的纯逻辑没法单测（仓库纪律），状态机与估算全部抽到这里真跑断言。
 *
 * ## 刻度说明（诚实展示）
 * 后端 percent 来自 apt 输出行数分档（10/30/55/75/90），不是字节刻度——所以
 * ETA 只在 percent>=10 且有第二个采样点后才显示，且永远说「约」。前端只取
 * max(percent) 单调展示（防输出波动导致进度条回跳）。
 */

export type InstallPhase = 'idle' | 'submitting' | 'running' | 'done' | 'failed'

/** 无任何进度事件超过该时长 → 停滞提醒（可重试）。后端任务自身还有超时兜底。 */
export const STALL_MS = 90_000

/** apt 输出行 → 阶段标签：解包/配置行算「安装中」，其余（Get:/Fetched: 等）算「下载中」。 */
export function stageLabel(msg: string): '下载中' | '安装中' {
  if (/Unpacking|Setting up|Preparing|Processing triggers|update-alternatives|Creating config/i.test(msg)) {
    return '安装中'
  }
  return '下载中'
}

/** 剩余时间估算文案。percent<10 时行数刻度方差太大，只说「估算中」。 */
export function etaText(elapsedMs: number, percent: number): string {
  if (percent >= 100) return '即将完成'
  if (percent < 10) return '估算中…'
  const remain = (elapsedMs * (100 - percent)) / percent
  if (remain < 60_000) return `约剩 ${Math.max(1, Math.round(remain / 1000))} 秒`
  return `约剩 ${Math.round(remain / 60_000)} 分钟`
}

/** 已用时 mm:ss（超过 1 小时也不带小时位——任务 40s~3min 量级，够用）。 */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function createInstallProgress() {
  const phase = ref<InstallPhase>('idle')
  const percent = ref(0)
  const message = ref('')
  const startedAt = ref(0)
  const lastEventAt = ref(0)
  /** SSE 心跳驱动的时钟；tick(now) 可注入便于测试 */
  const now = ref(Date.now())

  function start() {
    phase.value = 'submitting'
    percent.value = 0
    message.value = '提交安装任务…'
    startedAt.value = Date.now()
    lastEventAt.value = Date.now()
    now.value = startedAt.value
  }

  function taskAccepted() {
    if (phase.value === 'submitting' || phase.value === 'idle') {
      phase.value = 'running'
      lastEventAt.value = Date.now()
    }
  }

  function onProgress(pct: number, msg: string) {
    if (phase.value !== 'running') return
    // 单调展示：行数刻度理论上单调，但 SSE 乱序/重连重放不可信，取 max 防回跳
    percent.value = Math.max(percent.value, Math.min(100, pct))
    if (msg) message.value = msg
    lastEventAt.value = Date.now()
  }

  function onLog(line: string) {
    if (phase.value !== 'running' || !line) return
    message.value = line
    lastEventAt.value = Date.now()
  }

  function onFinished(state: string) {
    if (phase.value !== 'running' && phase.value !== 'submitting') return
    if (state === 'ok') {
      percent.value = 100
      phase.value = 'done'
    } else {
      phase.value = 'failed'
    }
  }

  function tick(t = Date.now()) { now.value = t }

  const elapsedMs = computed(() =>
    startedAt.value ? Math.max(0, now.value - startedAt.value) : 0)
  /** 停滞：running 中超过 STALL_MS 无任何事件（进度或日志都算活着） */
  const stalled = computed(() =>
    phase.value === 'running' && now.value - lastEventAt.value > STALL_MS)
  const stage = computed(() =>
    phase.value === 'running' ? stageLabel(message.value) : null)
  const eta = computed(() =>
    phase.value === 'running' ? etaText(elapsedMs.value, percent.value) : '')

  return {
    phase, percent, message, elapsedMs, stalled, stage, eta,
    start, taskAccepted, onProgress, onLog, onFinished, tick,
  }
}
