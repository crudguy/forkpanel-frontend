// @vitest-environment jsdom
// F-08：退出登录必须等后端成功才清前端会话；失败要上抛且给可见反馈。
// store 行为用真 Pinia + fetch 假件测；「MainLayout 真的 await / catch / toast」
// 是接线事实，用源码守卫钉住（布局真挂载要拉一堆子组件，成本远超收益）。
// ⚠ 必须 jsdom：`client.ts` 的 readCookie 读 document.cookie；纯 node 下会抛
//   「document is not defined」，而「登出失败」用例只要 reject 就通过 ⇒ 恒绿。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { installApiFake, fakeError, type ApiFake, type FakeRoute } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import { useAuthStore } from './auth'

// ⚠ jsdom 环境下 import.meta.url 不是 file: scheme，fileURLToPath 会直接抛
//   「The URL must be of scheme file」。统一走 cwd（vitest 的 root = 前端仓根）。
const LAYOUT = readFileSync(resolve(process.cwd(), 'src/layouts/MainLayout.vue'), 'utf8')
if (!LAYOUT.includes('function logout()') || LAYOUT.length < 2000) {
  throw new Error('MainLayout.vue 读取异常——接线守卫的扫描前提不成立，不许静默通过')
}

function clean(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

let fake: ApiFake | null = null
afterEach(() => { fake?.restore(); fake = null })

function seeded(route: FakeRoute) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.me = { user: 'admin', role: 'admin', permissions: ['system.view'], allowed_roots: ['/'], tier: 'standard' }
  auth.capabilities = { 'metrics.read': { supported: true, backend: null, reason: null } }
  auth.limits = { terminal_max_sessions: 4 }
  auth.platform = { os: 'linux', arch: 'x86_64', init: 'systemd', distro: 'debian:13', kernel: '6.1' }
  fake = installApiFake({ [API.auth.logout()]: route })
  return auth
}

describe('F-08 auth.logout 会话一致性', () => {
  it('后端登出成功：me / capabilities / limits / platform 全部清空', async () => {
    const auth = seeded({ ok: true })
    await auth.logout()
    expect(auth.loggedIn).toBe(false)
    expect(auth.capabilities).toEqual({})
    expect(auth.limits).toBeNull()
    expect(auth.platform).toBeNull()
    expect(fake!.count(API.auth.logout(), 'POST')).toBe(1)
    fake!.assertClean()
  })

  it('后端登出失败：抛出错误，且前端会话原样保留（刷新后不会假装已退出）', async () => {
    const auth = seeded(fakeError(500, 10901, '会话注销失败'))
    await expect(auth.logout()).rejects.toThrow()
    expect(auth.me?.user).toBe('admin')
    expect(auth.capabilities['metrics.read']?.supported).toBe(true)
    expect(auth.limits).not.toBeNull()
    expect(auth.platform).not.toBeNull()
    fake!.assertClean()
  })

  it('失败信息透出后端中文原文，便于 MainLayout 的 toast 直接呈现', async () => {
    const auth = seeded(fakeError(500, 10901, '会话注销失败，请稍后重试'))
    let msg = ''
    try { await auth.logout() } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('会话注销失败')
    fake!.assertClean()
  })
})

describe('接线守卫：MainLayout 的退出入口', () => {
  it('退出函数体里 await auth.logout() + router.replace + 失败 toast 三者齐全', () => {
    const body = clean(LAYOUT)
    const start = body.indexOf('async function logout()')
    expect(start, '找不到退出函数——扫描前提不成立').toBeGreaterThan(0)
    const block = body.slice(start, start + 700)
    expect(block).toContain('await auth.logout()')
    expect(block).toContain("await router.replace({ name: 'login' })")
    expect(block).toContain('toast(')
    expect(block).toContain("'err'")
    expect(block).toContain('errorText(e)')
    // 旧实现复活即红：未 await 的裸调用 / 抛着不管的 push
    expect(block).not.toMatch(/^\s*auth\.logout\(\)\s*$/m)
    expect(block).not.toContain("router.push({ name: 'login' })")
  })

  it('errorText 与 toast 的 import 各恰好一次', () => {
    const body = clean(LAYOUT)
    expect((body.match(/import \{ api, errorText \} from '@\/api\/client'/g) ?? []).length).toBe(1)
    expect((body.match(/import \{ toast \} from '@\/composables\/useToast'/g) ?? []).length).toBe(1)
  })
})

// Q-11：`loadMe` 里那句 `catch { }` 原先只有一个理由注释，改成了 console.warn。
// 这条测试同时钉住两件事——①失败真的不阻断登录；②**能力矩阵不依赖这个端点**
// （它由 /auth/me 一并下发）。第二点是「这里能不能静默」的判据：若能力矩阵只能
// 从这个端点拿到，失败就等于全站置灰，那就不是「静默」而是「掩盖故障」。
describe('Q-11 /system/capabilities 失败时的降级边界', () => {
  it('不抛错；platform/limits 缺失，但能力矩阵仍是 /auth/me 下发的那份', async () => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    fake = installApiFake({
      [API.auth.me()]: {
        user: 'admin', role: 'admin', permissions: ['system.view'],
        allowed_roots: ['/'], tier: 'standard',
        capabilities: { 'metrics.read': { supported: true, backend: null, reason: null } },
      },
      [API.system.capabilities()]: fakeError(500, 10001, '能力探测失败'),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // ① 登录流程不能被这一步拖垮（原来也是这个语义，改的是"要不要留痕"）
      await expect(auth.loadMe()).resolves.toBeUndefined()
      expect(auth.me?.user).toBe('admin')
      // ② 降级的真实范围：只有 platform / limits
      expect(auth.platform).toBeNull()
      expect(auth.limits).toBeNull()
      // ③ 关键判据：功能没有整体置灰——能力矩阵来自 /auth/me
      expect(auth.capabilities['metrics.read']?.supported).toBe(true)
      // ④ 但必须留痕，且理由说得清是哪个端点
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('/system/capabilities')
    } finally {
      warn.mockRestore()
    }
    fake!.assertClean()
  })
})
