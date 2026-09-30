<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SideNav from '@/components/SideNav.vue'
import TaskDrawer from '@/components/TaskDrawer.vue'
import Icon from '@/components/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { getTheme, setTheme, type ThemeMode } from '@/composables/theme'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const TITLES: Record<string, string> = {
  dashboard: '概览', system: '主机监控', processes: '进程', services: '软件与服务',
  sites: '网站与 SSL', databases: '数据库', files: '文件', firewall: '防火墙与安全',
  security: '安全中心', logs: '日志', cron: '计划任务', tasks: '任务中心',
  users: '用户', audit: '审计日志', settings: '设置',
}
const title = computed(() => TITLES[String(route.name)] ?? 'ForkPanel')

const theme = ref<ThemeMode>(getTheme())
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  setTheme(theme.value)
}

const userMenu = ref(false)
const initial = computed(() => (auth.me?.user || '?').slice(0, 1).toUpperCase())
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

        <div class="search">
          <Icon name="search" :size="16" />
          <input placeholder="搜索服务、站点、日志…" />
        </div>

        <!-- 系统基础信息（从侧边栏底部移来）：distro·arch，hover 看 kernel/init 详情。
             平台字段由 /system/capabilities 下发，loadMe 时已加载；未就绪前不渲染。 -->
        <div v-if="auth.platform" class="sysinfo"
          :title="`${auth.platform.distro || auth.platform.os}${auth.platform.kernel ? ' · ' + auth.platform.kernel : ''} · ${auth.platform.init}`">
          <Icon name="server" :size="15" />
          <span>{{ auth.platform.distro || auth.platform.os }} · {{ auth.platform.arch }}</span>
        </div>

        <span class="spacer" />

        <button class="btn-icon ghost" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'" @click="toggleTheme">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="18" />
        </button>

        <div class="user" @click="userMenu = !userMenu">
          <span class="avatar">{{ initial }}</span>
          <span class="uname">{{ auth.me?.user }}</span>
          <span v-if="auth.me" class="role">{{ auth.me.role }}</span>
          <Icon name="chevron" :size="14" class="caret" />

          <div v-if="userMenu" class="backdrop" @click.stop="userMenu = false" />
          <div v-if="userMenu" class="menu">
            <div class="menu-head">
              <span class="avatar sm">{{ initial }}</span>
              <div>
                <div class="m-name">{{ auth.me?.user }}</div>
                <div class="m-sub">{{ auth.me?.role }} · 档位 {{ auth.me?.tier }}</div>
              </div>
            </div>
            <RouterLink :to="{ name: 'settings' }" class="mi" @click="userMenu = false">
              <Icon name="key" :size="16" /> 修改密码
            </RouterLink>
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
    <TaskDrawer />
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

.search {
  display: flex; align-items: center; gap: 8px;
  background: var(--c-bg); border: 1px solid var(--c-border);
  border-radius: 10px; padding: 0 11px; height: 36px; width: 280px;
  color: var(--c-text-dim);
}
.search input { border: none; background: transparent; padding: 0; height: 34px; color: var(--c-text); }
.search input:focus-visible { outline: none; box-shadow: none; }

/* 系统基础信息胶囊：右侧状态簇的一员，紧凑、不可点击、hover 出详情 */
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
.role { font-size: 11px; padding: 1px 8px; border-radius: 999px;
        background: var(--c-primary-soft); color: var(--c-primary); }
.caret { color: var(--c-text-dim); transition: transform .15s; }
.user[aria-expanded='true'] .caret, .user:has(.menu) .caret { transform: rotate(90deg); }

.backdrop { position: fixed; inset: 0; z-index: 40; }
.menu {
  position: absolute; right: 0; top: 46px; z-index: 41; width: 240px;
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
  .search { display: none; }
  .sysinfo { display: none; }
  .content { padding: 16px; }
}
</style>
