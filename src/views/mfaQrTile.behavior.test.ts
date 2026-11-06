// @vitest-environment jsdom
/**
 * MFA 扫码卡片带面板品牌头——真挂载行为测试。
 *
 * 背景：验证器 App 内的条目标徽由 App 自己按 issuer 首字母生成
 * （Microsoft Authenticator 对 `issuer=ForkPanel` 显示 "Fo"），otpauth 协议
 * 没有图标字段，面板侧无法替换，所以品牌露出只能落在面板这张扫码卡片上。
 *
 * 断言三件事，缺一件都会静默坏掉：
 *  1. `.qr-tile` 真的渲染出来（不是写了个组件忘了挂）；
 *  2. logo 位置是**真 SVG**——`<Icon>` 忘记 import 时 Vue 渲染空元素且
 *     vue-tsc/build/单测全绿，只有真机 DOM 能抓到；
 *  3. 二维码本体仍在卡片里，没被品牌头挤掉（扫码是这张卡唯一的用途）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import SecurityView from '@/views/SecurityView.vue'
import { mountView, type Mounted } from '@/test/mount'

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

const ENROLL = {
  secret: 'JBSWY3DPEHPK3PXP',
  otpauth_uri:
    'otpauth://totp/ForkPanel:admin?secret=JBSWY3DPEHPK3PXP&issuer=ForkPanel&digits=6&period=30',
  recovery_codes: ['aaaa-bbbb-cccc'],
}

function routesForEnroll() {
  return {
    [API.security.baseline()]: [],
    [API.security.sessions()]: { sessions: [] },
    [API.auth.mfaEnroll()]: ENROLL,
  }
}

async function enroll(mounted: Mounted) {
  const btn = [...mounted.host.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('启用 MFA'))
  expect(btn, '「启用 MFA」按钮不存在，测试前提已失效').toBeTruthy()
  btn!.click()
  await mounted.flush()
}

describe('MFA 扫码卡片：面板 logo 品牌头', () => {
  it('启用后卡片显示狗头 logo + ForkPanel 名称，二维码仍在', async () => {
    m = await mountView({ component: SecurityView, routes: routesForEnroll() })
    await enroll(m)

    const tile = m.host.querySelector('.qr-tile')
    expect(tile, '.qr-tile 未渲染').toBeTruthy()
    expect(tile!.querySelector('.qr-tile-name')?.textContent?.trim()).toBe('ForkPanel')
    // Icon 未 import 时这里会是 null（Vue 把未知标签渲染成空元素）
    expect(tile!.querySelector('.qr-tile-logo svg'), 'logo 没渲染成 SVG').toBeTruthy()
    expect(tile!.querySelector('svg.qr'), '二维码本体不在卡片里').toBeTruthy()
    m.fake.assertClean()
  })

  it('品牌头只在扫码卡片里，未启用状态下不出现', async () => {
    m = await mountView({ component: SecurityView, routes: routesForEnroll() })
    expect(m.host.querySelector('.qr-tile')).toBeNull()
    expect(m.host.textContent ?? '').toContain('未启用')
  })
})
