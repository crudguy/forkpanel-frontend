import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { sysBadgeTip, BADGE_CTA } from './sysBadge'

const P = { os: 'linux', arch: 'x86_64', init: 'systemd', distro: 'debian:13', kernel: '6.1.0' }
const H = (uptime = 3600, cpu = 3.2, mem = 41, disk = 12.5) => ({ cpu, mem, disk, uptime })

describe('sysBadgeTip', () => {
  it('有读数有身份：读数 + 身份/内核/init/已运行 + CTA', () => {
    expect(sysBadgeTip(H(), P)).toBe(
      'CPU 3.2% · 内存 41.0% · 磁盘 12.5%'
      + '\ndebian:13 · x86_64 · 6.1.0 · systemd · 已运行 1 小时'
      + `｜${BADGE_CTA}`)
  })
  it('已运行跨天：天 + 小时', () => {
    const tip = sysBadgeTip(H(86400 * 3 + 7200), P)
    expect(tip).toContain('已运行 3 天 2 小时')
  })
  it('有读数无身份（platform 缺失）：读数行 + 已运行，不出现空段', () => {
    expect(sysBadgeTip(H(), null)).toBe(
      'CPU 3.2% · 内存 41.0% · 磁盘 12.5%\n已运行 1 小时' + `｜${BADGE_CTA}`)
  })
  it('无读数有身份：与合并前系统信息胶囊的 title 逐字一致（等价搬运基线）', () => {
    expect(sysBadgeTip(null, P)).toBe('debian:13 · 6.1.0 · systemd｜' + BADGE_CTA)
  })
  it('无读数且 distro 为 null：退回 os', () => {
    expect(sysBadgeTip(null, { ...P, distro: null })).toBe('linux · 6.1.0 · systemd｜' + BADGE_CTA)
  })
  it('无读数且 kernel 为 null：不出现内核段', () => {
    expect(sysBadgeTip(null, { ...P, kernel: null })).toBe('debian:13 · systemd｜' + BADGE_CTA)
  })
  it('两者皆无：兜底文案（外层 v-if 正常不会渲染到此）', () => {
    expect(sysBadgeTip(null, null)).toBe('系统状态')
  })
})

// 合并守卫：防止旧 sysinfo 胶囊复活（两处信息重复的回归）。断言指向 MainLayout.vue
// 的真实模板/样式锚点，而不是注释字符串。
describe('MainLayout 合并守卫', () => {
  const src = readFileSync(new URL('../layouts/MainLayout.vue', import.meta.url), 'utf8')
  it('旧 sysinfo 胶囊的模板与样式均已删除', () => {
    expect(src.includes('class="sysinfo"')).toBe(false)
    expect(src.includes('.sysinfo {')).toBe(false)
  })
  it('能力矩阵深链入口恰好一处（合并后唯一），且同时含文本段与指标条段', () => {
    expect(src.match(/to="\/settings#caps"/g)?.length).toBe(1)
    expect(src.includes('class="ht"')).toBe(true)
    expect(src.includes('class="hbars"')).toBe(true)
  })
  it('tooltip 文案走 composable 唯一事实源，不再内联拼接', () => {
    expect(src.includes('sysBadgeTip(health.value, auth.platform)')).toBe(true)
    expect(src.includes('点击查看概览')).toBe(false)
  })
})
