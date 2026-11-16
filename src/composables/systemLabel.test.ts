import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { distroLabel, systemLabel } from './systemLabel'
import type { PlatformInfo } from '@/api/types'

const P: PlatformInfo = { os: 'linux', arch: 'x86_64', init: 'systemd', distro: 'debian:12', kernel: '6.1.0' }

describe('distroLabel', () => {
  it('契约 id:version → 可读名称', () => {
    expect(distroLabel('debian:12')).toBe('Debian 12')
    expect(distroLabel('debian:forky')).toBe('Debian forky')
    expect(distroLabel('ubuntu:22.04')).toBe('Ubuntu 22.04')
  })
  it('无版本号 / 空值', () => {
    expect(distroLabel('debian')).toBe('Debian')
    expect(distroLabel(null)).toBe('')
    expect(distroLabel('  ')).toBe('')
  })
})

describe('systemLabel', () => {
  it('稳定版：系统族 + 发行版同行', () => {
    expect(systemLabel(P)).toBe('Linux · Debian 12')
  })
  it('滚动版（无 VERSION_ID，后端回退到 codename）：原样展示 codename', () => {
    expect(systemLabel({ ...P, distro: 'debian:forky' })).toBe('Linux · Debian forky')
  })
  it('distro 为 null：只显示系统族，不把 linux 冒充发行版', () => {
    expect(systemLabel({ ...P, distro: null })).toBe('Linux')
  })
  it('PRETTY_NAME 回退值（无冒号）：原样展示，且不重复拼 Linux 前缀', () => {
    expect(systemLabel({ ...P, distro: 'Debian GNU/Linux forky/sid' })).toBe('Debian GNU/Linux forky/sid')
  })
  it('platform 缺失：占位符；os 空但有 distro：不产生前导分隔符', () => {
    expect(systemLabel(null)).toBe('—')
    expect(systemLabel({ ...P, os: '' })).toBe('Debian 12')
  })
})

// 接线守卫：纯函数测过了不代表视图真的用它。断言指向 DashboardView.vue 的
// 生产模板/脚本锚点（不是注释），防止「发行版：linux」被并行改动悄悄改回去。
describe('DashboardView 接线守卫', () => {
  const src = readFileSync(new URL('../views/DashboardView.vue', import.meta.url), 'utf8')
  it('系统信息行走 systemLabel 唯一源，旧「发行版」回落行已删除', () => {
    expect(src.includes("import { systemLabel } from '@/composables/systemLabel'")).toBe(true)
    expect(src.includes("{ k: '系统', v: systemLabel(p) }")).toBe(true)
    expect(src.includes("{ k: '发行版'")).toBe(false)
  })
})
