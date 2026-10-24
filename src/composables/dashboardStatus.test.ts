import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { svcTile, ctTile, siteTile, bkTile } from './dashboardStatus'

describe('svcTile', () => {
  it('成功且全部正常：显示运行中数与 ok', () => {
    expect(svcTile({ total: 5, active: 5, failed: 0, ok: true }, '')).toEqual({ text: '5 个运行中', tone: 'ok' })
  })
  it('成功但有异常服务：显示异常数与 danger', () => {
    expect(svcTile({ total: 5, active: 3, failed: 2, ok: true }, '')).toEqual({ text: '2 个服务异常', tone: 'danger' })
  })
  it('加载中（未抓完）：显示 — 与 muted', () => {
    expect(svcTile({ total: 0, active: 0, failed: 0, ok: false }, '')).toEqual({ text: '—', tone: 'muted' })
  })
  it('抓取失败不再渲染成空：显示加载失败与 warn（P1-20）', () => {
    expect(svcTile({ total: 0, active: 0, failed: 0, ok: false }, '请求失败，请稍后重试'))
      .toEqual({ text: '加载失败', tone: 'warn' })
  })
  it('失败优先于陈旧的成功数据（重试再失败时不能显示旧计数）', () => {
    expect(svcTile({ total: 5, active: 5, failed: 0, ok: true }, '权限不足，请联系管理员'))
      .toEqual({ text: '加载失败', tone: 'warn' })
  })
})

describe('ctTile', () => {
  it('成功：显示运行中/总数，有容器全停时 warn', () => {
    expect(ctTile({ total: 3, running: 2, ok: true }, '', '')).toEqual({ text: '运行中 2 / 共 3', tone: 'ok' })
    expect(ctTile({ total: 3, running: 0, ok: true }, '', '')).toEqual({ text: '运行中 0 / 共 3', tone: 'warn' })
  })
  it('能力性不可用（守护进程不可达 / 未安装 Docker）与抓取失败是两回事', () => {
    expect(ctTile({ total: 0, running: 0, ok: false }, '', 'daemon_unreachable'))
      .toEqual({ text: '守护进程不可达', tone: 'muted' })
    expect(ctTile({ total: 0, running: 0, ok: false }, '', 'binary_missing'))
      .toEqual({ text: '未安装 Docker', tone: 'muted' })
    expect(ctTile({ total: 0, running: 0, ok: false }, '', 'unknown'))
      .toEqual({ text: '不可用', tone: 'muted' })
  })
  it('抓取失败显示加载失败与 warn，且优先于能力原因（P1-20）', () => {
    expect(ctTile({ total: 0, running: 0, ok: false }, '请求失败，请稍后重试', 'daemon_unreachable'))
      .toEqual({ text: '加载失败', tone: 'warn' })
  })
})

describe('siteTile', () => {
  it('成功：显示总数与启用数', () => {
    expect(siteTile({ total: 4, enabled: 2, ok: true }, '')).toEqual({ text: '共 4 个 · 启用 2', tone: 'ok' })
  })
  it('加载中显示 — 与 muted', () => {
    expect(siteTile({ total: 0, enabled: 0, ok: false }, '')).toEqual({ text: '—', tone: 'muted' })
  })
  it('抓取失败与「真的是空」可区分（P1-20 的核心）', () => {
    const failed = siteTile({ total: 0, enabled: 0, ok: false }, '请求失败，请稍后重试')
    expect(failed).toEqual({ text: '加载失败', tone: 'warn' })
    // 成功抓到空列表是另一种呈现——不再与失败撞脸
    expect(siteTile({ total: 0, enabled: 0, ok: true }, '')).not.toEqual(failed)
  })
})

describe('bkTile', () => {
  it('成功：全部正常 / 未配置计划 / 有计划失败', () => {
    expect(bkTile({ total: 2, fail: 0, ok: true }, '')).toEqual({ text: '全部正常', tone: 'ok' })
    expect(bkTile({ total: 0, fail: 0, ok: true }, '')).toEqual({ text: '未配置计划', tone: 'warn' })
    expect(bkTile({ total: 2, fail: 1, ok: true }, '')).toEqual({ text: '1 个计划失败', tone: 'danger' })
  })
  it('抓取失败显示加载失败与 warn，优先于陈旧成功数据（P1-20）', () => {
    expect(bkTile({ total: 2, fail: 0, ok: true }, '请求失败，请稍后重试'))
      .toEqual({ text: '加载失败', tone: 'warn' })
  })
})

// ── 源码级接线守卫 ──
// 推导逻辑再好，.vue 里不接线仍是静默失败（本仓「配置项假控制」同款病）。
// 判据指向被检查的那一份：DashboardView.vue 生产段（剔注释行，避免被自己的
// 注释绊倒）；断言「恰好一次」而非 contains——重复接线/漏接线都能抓到。
describe('DashboardView 接线守卫（P1-20）', () => {
  const raw = readFileSync(new URL('../views/DashboardView.vue', import.meta.url), 'utf8')
  const prod = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('<!--'))
    .join('\n')

  it('loadStatus 四路抓取失败都写入对应错误 ref（恰好一次）', () => {
    for (const ref of ['svcErr', 'ctErr', 'siteErr', 'bkErr']) {
      const needle = `${ref}.value = errorText(e)`
      expect(prod.split(needle).length - 1, `${needle} 应恰好出现一次`).toBe(1)
    }
  })

  it('四路抓取成功都清空对应错误 ref（重试成功后错误态可恢复）', () => {
    for (const ref of ['svcErr', 'ctErr', 'siteErr', 'bkErr']) {
      const needle = `${ref}.value = ''`
      expect(prod.split(needle).length - 1, `${needle} 应恰好出现一次`).toBe(1)
    }
  })

  it('便签加载失败同样可见（noteErr 有写入与清除点）', () => {
    // 注意：noteErr 的写入点有两处——loadNotes（新增）与 doDeleteNote（既有），
    // 故不能用计数，改用「先清后写」的序列精确锚定 loadNotes 那一处。
    expect(prod).toContain("noteErr.value = ''\n} catch (e) { noteErr.value = errorText(e) }")
    expect(prod.split("noteErr.value = ''").length - 1).toBe(1)
    // 删除失败的可见性（既有行为）不许被顺手改回静默
    expect(prod).toContain('}).catch((e) => { noteErr.value = errorText(e) })')
  })

  it('模板消费派生视图而非裸 ok 判断', () => {
    for (const v of ['svcView', 'ctView', 'siteView', 'bkView']) {
      expect(prod, `${v}.text 未在模板中使用`).toContain(`${v}.text`)
      expect(prod, `${v}.tone 未在模板中使用`).toContain(`${v}.tone`)
    }
  })

  it('旧裸判断 computed 已移除（svcText/svcTone 等不再被引用）', () => {
    for (const old of ['svcText', 'ctText', 'bkText', 'svcTone', 'ctTone', 'siteTone', 'bkTone']) {
      expect(prod, `${old} 仍被引用`).not.toContain(old)
    }
  })

  it('失败时有区块级错误条与重试入口', () => {
    expect(prod).toContain('v-if="statusErr"')
    expect(prod).toContain('@click="loadStatus"')
  })
})
