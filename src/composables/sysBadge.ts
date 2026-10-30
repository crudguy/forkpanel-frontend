/**
 * 顶栏「系统徽标」胶囊的 tooltip 推导（A12 健康徽标 + 系统信息胶囊合并后的唯一文案源）。
 *
 * ## 为什么抽它
 * `.vue` 里的纯逻辑没法单测（vitest 只收 src 下的 *.test.ts 且无 vue 插件，仓库纪律）。
 * 合并前这段逻辑有两份：healthTip（读数+身份）住在 MainLayout.vue 的 computed 里、
 * sysinfo 的 title 内联在模板字符串里——两枚相邻胶囊重复承载同一主机信息，视觉冲突。
 * 合并后 tooltip 只此一份，两种形态都有真跑断言。
 *
 * ## 形态
 * - 有读数（metrics 能力可用且已抓到）：读数 + 身份/内核/init/已运行 + CTA。
 * - 无读数但有 platform（501 / 无权限 / 数据未就绪）：与合并前系统信息胶囊的
 *   title 逐字一致（等价搬运基线，不许顺手改词）。
 * - 两者皆无：外层 v-if 保证不渲染，兜底文案只为防 null。
 */

export interface BadgeHealth {
  cpu: number
  mem: number
  disk: number
  uptime: number
}

export interface BadgePlatform {
  os: string
  arch: string
  init: string
  distro: string | null
  kernel: string | null
}

/** 点击目标统一为能力矩阵深链（/settings#caps）：它是唯一入口（概览在侧栏首项，
 *  指标条→概览属冗余快捷方式）；tooltip 尾部 CTA 与之一致。 */
export const BADGE_CTA = '点击查看运行环境与能力矩阵'

export function sysBadgeTip(health: BadgeHealth | null, platform: BadgePlatform | null): string {
  if (!health && !platform) return '系统状态'
  if (!health) {
    const p = platform!
    return `${p.distro || p.os}${p.kernel ? ' · ' + p.kernel : ''} · ${p.init}｜${BADGE_CTA}`
  }
  const d = Math.floor(health.uptime / 86400)
  const hr = Math.floor((health.uptime % 86400) / 3600)
  const up = health.uptime >= 86400 ? `${d} 天 ${hr} 小时` : `${hr} 小时`
  const env = platform
    ? `${platform.distro || platform.os} · ${platform.arch}`
      + `${platform.kernel ? ' · ' + platform.kernel : ''} · ${platform.init}`
    : ''
  return `CPU ${health.cpu.toFixed(1)}% · 内存 ${health.mem.toFixed(1)}% · 磁盘 ${health.disk.toFixed(1)}%`
    + (env ? `\n${env} · 已运行 ${up}` : `\n已运行 ${up}`)
    + `｜${BADGE_CTA}`
}
