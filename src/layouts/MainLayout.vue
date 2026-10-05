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
import { roleLabel } from '@/api/types'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// 顶栏标题直接取路由 meta.title（单一事实源）。原先此处再维护一份 TITLES 映射，
// 与 router 的 meta.title 重复且易漏项——漏了 terminal/assistant/containers/backups/
// notifications，顶栏即回退成品牌名 "ForkPanel"。改为读 meta.title 后不会再有遗漏。
const title = computed(() => {
  const t = route.meta.title
  return typeof t === 'string' && t ? t : 'ForkPanel'
})

// 顶栏副标题：与各视图原先内容区顶部的灰色 page-sub 说明同源，集中到此统一收口。
// 动态信息（ServicesView 的 init、FirewallView 的启用状态/后端、FilesView 的当前路径）
// 不在此列，保留在各自视图的 page-head，避免顶栏出现过长/动态文案。
const SUBTITLES: Record<string, string> = {
  system: '实时资源趋势与历史走向',
  'system-pro': '每核 CPU / 负载 / 内存 / 磁盘 / 网卡 完整快照',
  'system-procs': '服务器全部进程 · 点表头可按 CPU / 内存 / 用户排序 · 可结束异常进程',
  'services-software': '白名单软件包的安装与卸载',
  'services-units': '服务启停 · 日志 · 配置',
  sites: '虚拟主机站点与证书管理',
  databases: '连接管理 · 只读浏览 · 备份任务',
  logs: '字面量过滤 · 上限 2000 行 · 支持实时跟随',
  'logs-audit': '关键操作追踪',
  'firewall-baseline': '基线检查与活跃会话',
  cron: '平台原生调度，表达式语义由后端校验',
  'cron-tasks': '后台任务与执行进度（运行中每 2 秒自动刷新）',
  users: '面板账号与权限',
  settings: '运行环境与能力矩阵排查',
  terminal: '内置 Web 终端（宿主级 shell）· 操作后请务必登出',
  assistant: '内置规则诊断 · 基于真实系统数据 · 只建议不自动执行',
  backups: '本地备份计划 · 手动执行 · 产物列表（恢复为高危后续）',
  containers: 'Docker · 只读列举 + 启停/重启/删除（不提供创建容器）',
  waf: '各站点防护档位与 CC 限速 · 随 nginx 配置一同下发',
}
const subtitle = computed(() => SUBTITLES[String(route.name)] ?? '')

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
        <div class="title-block">
          <h1 class="title">{{ title }}</h1>
          <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
        </div>

        <span class="spacer" />

        <!-- 系统基础信息（从侧边栏底部移来）：distro·arch，hover 看 kernel/init 详情。
             平台字段由 /system/capabilities 下发，loadMe 时已加载；未就绪前不渲染。
             置于右侧簇、紧邻深色模式按钮（用户偏好：放最右、挨着主题切换）。 -->
        <!-- 能力矩阵是排障首选信息（菜单为何置灰、端点为何 501），原先埋在设置页深处，
             这里把胶囊做成入口一键直达（路由已配 hash 滚动，落到 #caps 锚点）。 -->
        <RouterLink v-if="auth.platform" to="/settings#caps" class="sysinfo"
          :title="`${auth.platform.distro || auth.platform.os}${auth.platform.kernel ? ' · ' + auth.platform.kernel : ''} · ${auth.platform.init}｜点击查看运行环境与能力矩阵`">
          <Icon name="monitor" :size="15" />
          <span>{{ auth.platform.distro || auth.platform.os }} · {{ auth.platform.arch }}</span>
        </RouterLink>

        <RouterLink :to="{ name: 'notifications' }" class="btn-icon ghost bell"
          :title="unread ? `未读通知 ${unread} 条` : '通知'">
          <Icon name="bell" :size="18" />
          <span v-if="unread" class="badge-dot">{{ unread > 99 ? '99+' : unread }}</span>
        </RouterLink>

        <button class="btn-icon ghost" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'" @click="toggleTheme">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="18" />
        </button>

        <!-- 真实 button + aria-expanded（审计 U12）：此前 div+click 不可键盘聚焦，
             CSS 写了 [aria-expanded] 选择器却从不设置，键盘用户打不开菜单。
             触发器与下拉面板分离（HTML 不允许 button 嵌套 button）。 -->
        <div class="user-wrap">
          <button
            type="button" class="user"
            :aria-expanded="userMenu" aria-haspopup="menu"
            :aria-label="`用户菜单（${auth.me?.user ?? ''}）`"
            @click="userMenu = !userMenu"
            @keydown.escape="userMenu = false"
          >
            <span class="avatar">{{ initial }}</span>
            <span class="uname">{{ auth.me?.user }}</span>
            <Icon name="chevron" :size="14" class="caret" />
          </button>

          <div v-if="userMenu" class="backdrop" @click.stop="userMenu = false" />
          <div v-if="userMenu" class="menu">
            <div class="menu-head">
              <span class="avatar sm">{{ initial }}</span>
              <div>
                <div class="m-name">{{ auth.me?.user }}</div>
                <div class="m-sub">{{ roleLabel(auth.me?.role) }}</div>
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
.title-block { display: flex; flex-direction: column; justify-content: center; min-width: 0; gap: 1px; }
.subtitle { font-size: 12px; line-height: 1.3; color: var(--c-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 48vw; }

/* 系统基础信息胶囊：右侧状态簇的一员，紧凑、hover 出详情，点击直达能力矩阵 */
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
  font-size: 12.5px; white-space: nowrap; text-decoration: none;
  transition: color .15s ease, background .15s ease;
}
.sysinfo:hover { color: var(--c-text); background: var(--c-hover); }

.spacer { flex: 1; }

.user-wrap { position: relative; }
.user { position: static; display: flex; align-items: center; gap: 9px; cursor: pointer;
        padding: 4px 8px 4px 4px; border-radius: 999px; border: none; background: none; color: inherit; font: inherit; }
.user:hover { background: var(--c-hover); }
.avatar {
  width: 32px; height: 32px; border-radius: 50%; flex: none;
  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 14px;
  background: var(--gradient); box-shadow: var(--glow);
}
.avatar.sm { width: 36px; height: 36px; font-size: 15px; }
.uname { font-size: 13.5px; font-weight: 500; }
.caret { color: var(--c-text-dim); transition: transform .15s; }
.user[aria-expanded='true'] .caret { transform: rotate(90deg); }

.backdrop { position: fixed; inset: 0; z-index: 40; }
.menu {
  position: absolute; right: 0; top: 46px; z-index: 41; width: 168px;
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
