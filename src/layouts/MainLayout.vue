<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SideNav from '@/components/SideNav.vue'
import ChangePasswordDialog from '@/components/ChangePasswordDialog.vue'
import Icon from '@/components/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { getTheme, setTheme, type ThemeMode } from '@/composables/theme'
import { api } from '@/api/client'
import { API } from '@/api/endpoints'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const TITLES: Record<string, string> = {
  dashboard: '概览', system: '主机监控', 'system-pro': '专业快照', 'system-procs': '进程管理',
  services: '软件与服务', sites: '网站与 SSL', databases: '数据库', files: '文件',
  logs: '日志', 'logs-audit': '审计日志',
  firewall: '防火墙规则', 'firewall-baseline': '安全基线',
  cron: '计划任务', 'cron-tasks': '任务中心',
  users: '用户', settings: '设置',
}
const title = computed(() => TITLES[String(route.name)] ?? 'ForkPanel')

const theme = ref<ThemeMode>(getTheme())
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  setTheme(theme.value)
}

const userMenu = ref(false)
const pwdOpen = ref(false)
function openPwdDialog() {
  userMenu.value = false
  pwdOpen.value = true
}
const initial = computed(() => (auth.me?.user || '?').slice(0, 1).toUpperCase())

// 通知未读数：原先只有「通知」页内部才显示，备份失败/恢复失败这类"必须知道"的事件
// 在其余任意页面都完全静默。这里在 topbar 常驻铃铛把信号放出来：轮询 60s
// （非关键路径，失败静默）+ 路由变化补一次（看完通知回来立刻更新）。
const unread = ref(0)
let unreadTimer: number | undefined
async function loadUnread() {
  try {
    const r = await api.get<{ count: number }>(API.notifications.unreadCount())
    unread.value = r.count
  } catch { /* 静默重试：未读数取不到不影响任何操作 */ }
}
watch(() => route.path, loadUnread)
onMounted(() => {
  loadUnread()
  unreadTimer = window.setInterval(loadUnread, 60_000)
})
onUnmounted(() => { if (unreadTimer) clearInterval(unreadTimer) })

// 档位 tier 的中文可读标签：原「档位」二字偏术语，改为自解释文案（描述性能资源档）
const TIER_LABELS: Record<string, string> = { nano: '轻量配置', small: '进阶配置', standard: '标准配置' }
const tierLabel = computed(() => TIER_LABELS[String(auth.me?.tier)] ?? String(auth.me?.tier ?? ''))
function logout() {
  userMenu.value = false
  auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="shell">
    <SideNav />
    <main>
      <header class="topbar">
        <h1 class="title">{{ title }}</h1>

        <span class="spacer" />

        <!-- 系统基础信息（从侧边栏底部移来）：distro·arch，hover 看 kernel/init 详情。
             平台字段由 /system/capabilities 下发，loadMe 时已加载；未就绪前不渲染。
             置于右侧簇、紧邻深色模式按钮（用户偏好：放最右、挨着主题切换）。 -->
        <div v-if="auth.platform" class="sysinfo"
          :title="`${auth.platform.distro || auth.platform.os}${auth.platform.kernel ? ' · ' + auth.platform.kernel : ''} · ${auth.platform.init}`">
          <Icon name="monitor" :size="15" />
          <span>{{ auth.platform.distro || auth.platform.os }} · {{ auth.platform.arch }}</span>
        </div>

        <RouterLink :to="{ name: 'notifications' }" class="btn-icon ghost bell"
          :title="unread ? `未读通知 ${unread} 条` : '通知'">
          <Icon name="bell" :size="18" />
          <span v-if="unread" class="badge-dot">{{ unread > 99 ? '99+' : unread }}</span>
        </RouterLink>

        <button class="btn-icon ghost" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'" @click="toggleTheme">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="18" />
        </button>

        <div class="user" @click="userMenu = !userMenu">
          <span class="avatar">{{ initial }}</span>
          <span class="uname">{{ auth.me?.user }}</span>
          <Icon name="chevron" :size="14" class="caret" />

          <div v-if="userMenu" class="backdrop" @click.stop="userMenu = false" />
          <div v-if="userMenu" class="menu">
            <div class="menu-head">
              <span class="avatar sm">{{ initial }}</span>
              <div>
                <div class="m-name">{{ auth.me?.user }}</div>
                <div class="m-sub">{{ auth.me?.role }} · {{ tierLabel }}</div>
              </div>
            </div>
            <button class="mi" @click="openPwdDialog">
              <Icon name="key" :size="16" /> 修改密码
            </button>
            <button class="mi" @click="logout">
              <Icon name="logout" :size="16" /> 退出登录
            </button>
          </div>
        </div>
      </header>

      <div class="content">
        <div class="wrap"><RouterView /></div>
      </div>
    </main>
    <ChangePasswordDialog :open="pwdOpen" @close="pwdOpen = false" />
  </div>
</template>

<style scoped>
.shell { display: flex; min-height: 100vh; }

main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.topbar {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; gap: 14px;
  height: 58px; padding: 0 22px;
  background: color-mix(in srgb, var(--c-surface) 82%, transparent);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  border-bottom: 1px solid var(--c-border);
}
.title { font-size: 17px; font-weight: 650; margin: 0; letter-spacing: .2px; white-space: nowrap; }

/* 系统基础信息胶囊：右侧状态簇的一员，紧凑、不可点击、hover 出详情 */
.bell { position: relative; color: var(--c-text-dim); }
.bell:hover { color: var(--c-text); }
.badge-dot { position: absolute; top: -3px; right: -3px; min-width: 17px; height: 17px;
             padding: 0 4px; border-radius: 999px; background: var(--c-danger); color: #fff;
             font-size: 11px; line-height: 17px; text-align: center; font-weight: 500;
             box-shadow: 0 0 0 2px var(--c-surface); }
.sysinfo {
  display: flex; align-items: center; gap: 7px; flex: none;
  height: 34px; padding: 0 12px;
  border: 1px solid var(--c-border); border-radius: 999px;
  background: var(--c-bg); color: var(--c-text-dim);
  font-size: 12.5px; white-space: nowrap;
}

.spacer { flex: 1; }

.user { position: relative; display: flex; align-items: center; gap: 9px; cursor: pointer;
        padding: 4px 8px 4px 4px; border-radius: 999px; }
.user:hover { background: var(--c-hover); }
.avatar {
  width: 32px; height: 32px; border-radius: 50%; flex: none;
  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 14px;
  background: var(--gradient); box-shadow: var(--glow);
}
.avatar.sm { width: 36px; height: 36px; font-size: 15px; }
.uname { font-size: 13.5px; font-weight: 500; }
.caret { color: var(--c-text-dim); transition: transform .15s; }
.user[aria-expanded='true'] .caret, .user:has(.menu) .caret { transform: rotate(90deg); }

.backdrop { position: fixed; inset: 0; z-index: 40; }
.menu {
  position: absolute; right: 0; top: 46px; z-index: 41; width: 210px;
  background: var(--c-surface-2); border: 1px solid var(--c-border-strong);
  border-radius: 12px; box-shadow: var(--shadow-lg); padding: 6px; overflow: hidden;
}
.menu-head { display: flex; align-items: center; gap: 11px; padding: 8px 10px 10px; }
.m-name { font-weight: 600; font-size: 14px; }
.m-sub { font-size: 12px; color: var(--c-text-dim); }
.mi {
  display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
  padding: 9px 10px; border-radius: 8px; color: var(--c-text);
  background: transparent; border: none; font-size: 13.5px; cursor: pointer;
}
.mi:hover { background: var(--c-hover); }

.content { flex: 1; padding: 24px 28px 40px; }
.wrap { max-width: 1360px; margin: 0 auto; }

@media (max-width: 720px) {
  .sysinfo { display: none; }
  .content { padding: 16px; }
}
</style>
