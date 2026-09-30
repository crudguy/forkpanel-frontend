import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'
import { CAP, type CapabilityMap, type PlatformInfo } from '@/api/types'

export interface Me {
  user: string
  role: string
  permissions: string[]
  allowed_roots: string[]
  tier: 'nano' | 'small' | 'standard'
}

/**
 * 认证 + 能力矩阵。
 *
 * 关键设计：菜单可见性 = 能力位 AND 权限点。
 * 二者缺一都置灰，这样"平台不支持"和"你没权限"在 UI 上是同一套机制。
 */
export const useAuthStore = defineStore('auth', () => {
  const me = ref<Me | null>(null)
  const capabilities = ref<CapabilityMap>({})
  const platform = ref<PlatformInfo | null>(null)
  const loading = ref(false)

  const loggedIn = computed(() => me.value !== null)

  /** 平台能力是否支持（与权限无关，纯平台维度） */
  const supported = (key: string) => capabilities.value[key]?.supported ?? false

  /** 是否有某个 RBAC 权限点 */
  const can = (perm: string) => me.value?.permissions.includes(perm) ?? false

  /** 菜单/操作是否可用：能力位 AND 权限点 */
  const enabled = (capKey: string, perm: string) => supported(capKey) && can(perm)

  /** 置灰原因：先说平台不支持，再说权限不足 */
  const whyDisabled = (capKey: string, perm: string): string | null => {
    if (!supported(capKey)) return '当前环境不支持此功能'
    if (!can(perm)) return '权限不足'
    return null
  }

  async function loadMe() {
    loading.value = true
    try {
      const r = await api.get<Me & { capabilities: CapabilityMap }>('/api/v1/auth/me')
      me.value = { user: r.user, role: r.role, permissions: r.permissions,
                   allowed_roots: r.allowed_roots, tier: r.tier }
      capabilities.value = r.capabilities ?? {}
      // platform（distro/kernel/arch/init）由 /system/capabilities 下发，与 capabilities 同源；
      // 一并加载，供概览/设置/导航展示平台信息。缺失非致命（UI 降级为 —）。
      try { await loadCapabilities() } catch { /* platform 缺失不阻断登录 */ }
    } finally {
      loading.value = false
    }
  }

  async function loadCapabilities() {
    const r = await api.get<{ platform: PlatformInfo; features: CapabilityMap }>(
      '/api/v1/system/capabilities')
    platform.value = r.platform
    capabilities.value = r.features
  }

  async function login(username: string, password: string, totp?: string) {
    await api.post('/api/v1/auth/login', { username, password, totp })
    await loadMe()
  }

  async function logout() {
    await api.post('/api/v1/auth/logout')
    me.value = null
    capabilities.value = {}
  }

  /** 仅清前端会话状态（不请求后端）：会话已失效（如收到 401）时用，避免对已失效会话再发请求 */
  function clearSession() {
    me.value = null
    capabilities.value = {}
    platform.value = null
  }

  /** nano 档位：SSE 不可用，退化为轮询（实测：低配机器上长连接是负担） */
  const pollingMode = computed(() => me.value?.tier === 'nano')

  const metricsAvailable = computed(() => supported(CAP.METRICS_READ))

  return {
    me, capabilities, platform, loading, loggedIn, pollingMode, metricsAvailable,
    supported, can, enabled, whyDisabled, loadMe, loadCapabilities, login, logout, clearSession,
  }
})
