import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createInstallProgress, stageLabel, etaText, fmtElapsed, STALL_MS } from './installProgress'

describe('stageLabel：apt 输出行分阶段', () => {
  it('下载行（Get:/Fetched:）→ 下载中', () => {
    expect(stageLabel('Get:1 http://deb.debian.org docker-ce-cli')).toBe('下载中')
    expect(stageLabel('Fetched 42.3 MB in 3s')).toBe('下载中')
    expect(stageLabel('')).toBe('下载中')
  })
  it('解包/配置行（Unpacking/Setting up/triggers）→ 安装中', () => {
    expect(stageLabel('Unpacking docker-ce (5:27.0.1-1) ...')).toBe('安装中')
    expect(stageLabel('Setting up containerd.io ...')).toBe('安装中')
    expect(stageLabel('Processing triggers for man-db ...')).toBe('安装中')
  })
})

describe('etaText', () => {
  it('percent<10：行数刻度方差大，只说估算中', () => {
    expect(etaText(60_000, 5)).toBe('估算中…')
  })
  it('中段：elapsed*(100-pct)/pct', () => {
    expect(etaText(60_000, 50)).toBe('约剩 1 分钟')
    expect(etaText(30_000, 75)).toBe('约剩 10 秒')
  })
  it('接近终点与终点', () => {
    expect(etaText(10_000, 99)).toBe('约剩 1 秒')
    expect(etaText(10_000, 100)).toBe('即将完成')
  })
})

describe('fmtElapsed', () => {
  it('mm:ss', () => {
    expect(fmtElapsed(0)).toBe('0:00')
    expect(fmtElapsed(65_000)).toBe('1:05')
  })
})

describe('状态机', () => {
  it('start → taskAccepted → running；进度单调不回跳；log 更新消息并续命', () => {
    const p = createInstallProgress()
    p.start()
    expect(p.phase.value).toBe('submitting')
    p.taskAccepted()
    expect(p.phase.value).toBe('running')
    p.onProgress(30, 'Fetched 10 MB')
    p.onProgress(10, 'Get:2 ...')
    // 乱序/重放的低值不得让进度条回跳
    expect(p.percent.value).toBe(30)
    expect(p.message.value).toBe('Get:2 ...')
    p.onLog('Unpacking docker-ce ...')
    expect(p.message.value).toBe('Unpacking docker-ce ...')
    expect(p.stage.value).toBe('安装中')
  })
  it('submitting 期间的进度事件被忽略（任务还没被接受）', () => {
    const p = createInstallProgress()
    p.start()
    p.onProgress(50, 'x')
    expect(p.percent.value).toBe(0)
  })
  it('finished ok → done，percent=100；finished fail → failed 保留当前进度', () => {
    const p = createInstallProgress()
    p.start(); p.taskAccepted(); p.onProgress(55, 'Fetched ...')
    p.onFinished('ok')
    expect(p.phase.value).toBe('done')
    expect(p.percent.value).toBe(100)
    const q = createInstallProgress()
    q.start(); q.taskAccepted(); q.onProgress(55, '失败：apt 错误')
    q.onFinished('fail')
    expect(q.phase.value).toBe('failed')
    expect(q.percent.value).toBe(55)
    q.onFinished('ok')
    // 终态后忽略后续事件（SSE 重连重放）
    expect(q.phase.value).toBe('failed')
  })
  it('停滞检测：超过 STALL_MS 无事件 → stalled；来一条日志即恢复', () => {
    const p = createInstallProgress()
    const t0 = Date.now()
    p.start(); p.taskAccepted(); p.onProgress(10, 'Get:1')
    p.tick(t0 + STALL_MS + 1)
    expect(p.stalled.value).toBe(true)
    p.onLog('Get:2 ...')
    p.tick(Date.now())
    expect(p.stalled.value).toBe(false)
  })
  it('未开始时不判停滞', () => {
    const p = createInstallProgress()
    p.tick(Date.now() + STALL_MS * 10)
    expect(p.stalled.value).toBe(false)
  })
})

// 接线守卫：ContainersView 必须真的订阅任务 SSE 并在卸载时关闭——
// 抽了 composable 但忘了接线 = 进度条永远 0，比没有进度更骗人。
describe('ContainersView 接线守卫', () => {
  const src = readFileSync(new URL('../views/ContainersView.vue', import.meta.url), 'utf8')
  it('订阅任务 SSE 且按 taskId 过滤、卸载时关闭', () => {
    expect(src.includes('new EventSource(API.events.tasks())')).toBe(true)
    expect(src.includes('closeInstallEs')).toBe(true)
  })
  it('终态轮询兜底在位（SSE 断线也不至于永远转圈）', () => {
    expect(src.includes('API.tasks.get')).toBe(true)
  })
})
