<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SideNav from '@/components/SideNav.vue'
import ChangePasswordDialog from '@/components/ChangePasswordDialog.vue'
import ToastHost from '@/components/ToastHost.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import Icon from '@/components/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { getTheme, setTheme, type ThemeMode } from '@/composables/theme'
import { api } from '@/api/client'
import { API } from '@/api/endpoints'
import { roleLabel, CAP } from '@/api/types'
import { navDrawerOpen, closeNav } from '@/composables/nav'
import { useTableDensity, DENSITY_OPTIONS } from '@/composables/useTablePrefs'
import { timeMode, setTimeMode } from '@/api/types'
import type { TimeMode } from '@/api/types'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// AI 助手顶栏入口（C9）：门控与侧边栏同口径（METRICS_READ 能力位 + system.view 权限点），
// 不可用即隐藏整钮——避免"点过去才发现 501"。
const assistOk = computed(() => auth.whyDisabled(CAP.METRICS_READ, 'system.view') === null)

// 表格密度（B8）：全站共享偏好，放用户菜单里与主题切换同级——它是"看的方式"，
// 不是某一页的功能，塞进某个视图的工具条会让用户以为只影响那一页。
const { density, setDensity } = useTableDensity()

// 时区（C4）：绝对时间按本地/UTC 显示，全站共享偏好，与密度同处用户菜单。
const TIME_MODE_OPTIONS: { value: TimeMode; label: string; hint: string }[] = [
  { value: 'local', label: '本地', hint: '跟随浏览器时区（默认）' },
  { value: 'utc', label: 'UTC', hint: '绝对时间按 UTC 显示，便于跨时区核对' },
]

// 命令面板（A11）开关：由全局 ⌘K / Ctrl+K 与顶栏搜索按钮唤起
const paletteOpen = ref(false)

// 移动端抽屉：路由切换即收起（审计 R1），避免停留在非当前页时抽屉仍开着
watch(() => route.path, () => { if (navDrawerOpen.value) closeNav() })

// 顶栏标题直接取路由 meta.title（单一事实源）。原先此处再维护一份 TITLES 映射，
// 与 router 的 meta.title 重复且易漏项——漏了 terminal/assistant/containers/backups/
// notifications，顶栏即回退成品牌名 "ForkPanel"。改为读 meta.title 后不会再有遗漏。
const title = computed(() => {
  const t = route.meta.title
  return typeof t === 'string' && t ? t : 'ForkPanel'
})

// 顶栏副标题：与各视图原先内容区顶部的灰色 page-sub 说明同源，集中到此统一收口。
// 动态信息（ServicesView 的 init、FirewallView 的启用状态/后端、FilesView 的当前路径）
// 不在此列，保留在各自视图的工具行/卡片顶栏，避免顶栏出现过长/动态文案。
// 覆盖所有带顶栏的路由（login 无顶栏，不参与）。新加路由必须同步补一条，
// 否则该页顶栏副标题静默为空——守卫 scripts/check-subtitles.mjs 会拦。
const SUBTITLES: Record<string, string> = {
  dashboard: '主机状态总览 · 卡片可自定义显示与排序',
  system: '实时资源趋势与历史走向',
  'system-pro': '每核 CPU / 负载 / 内存 / 磁盘 / 网卡 完整快照',
  'system-procs': '服务器全部进程 · 点表头可按 CPU / 内存 / 用户排序 · 可结束异常进程',
  'services-software': '白名单软件包的安装与卸载',
  'services-units': '服务启停 · 日志 · 配置',
  'service-detail': '单个服务的启停 · 日志 · 配置',
  sites: '虚拟主机站点管理',
  apps: 'systemd 托管进程 · 自动反代站点 · 构建请自行完成',
  databases: '连接管理 · 只读浏览 · 备份任务',
  files: '目录浏览与上传 · 面包屑分段可点直达',
  logs: '字面量过滤 · 上限 2000 行 · 支持实时跟随',
  'logs-audit': '关键操作追踪',
  firewall: '端口放行规则 · 改动需应用后下发',
  'firewall-baseline': '基线检查与活跃会话',
  cron: '平台原生调度，表达式语义由后端校验',
  'cron-tasks': '后台任务与执行进度（运行中每 2 秒自动刷新）',
  users: '面板账号与权限',
  settings: '运行环境与能力矩阵排查',
  notifications: '面板内消息 · 未读计数 · 一键全部已读',
  terminal: '内置 Web 终端（宿主级 shell）· 操作后请务必登出',
  assistant: '内置规则诊断 · 基于真实系统数据 · 只建议不自动执行',
  backups: '本地备份计划 · 手动执行 · 产物列表（恢复为高危后续）',
  // ⚠ 曾经写「只读列举 + 启停/重启/删除（不提供创建容器）」——创建容器早已开放，
  // 且现在还支持 Compose 项目的 up/stop/restart/down，那句是过时的事实错误。
  containers: 'Docker · 列举 / 创建 / 启停 / 删除 · Compose 项目管理',
  waf: '各站点防护档位与 CC 限速 · 随 nginx 配置一同下发',
  certs: '各站点证书总览 · 申请 · 续期 · 根证书信任',
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

// ── 用户菜单（下拉）的定位 ───────────────────────────────────────────
// 遮罩与菜单都 Teleport 到 body（原因见模板注释：顶栏的 backdrop-filter 会成为
// position:fixed 的包含块，留在顶栏里的遮罩只覆盖顶栏那一条、点页面关不掉菜单）。
// 菜单跟着脱离顶栏后就失去 absolute 锚点，改 fixed 由这里按触发按钮**实测**下发坐标；
// 窗口缩放时重算（顶栏在窄屏右侧元素会变少，按钮右移）。
const userBtn = ref<HTMLElement | null>(null)
const menuPos = ref({ top: '0px', right: '0px' })
function placeUserMenu() {
  const r = userBtn.value?.getBoundingClientRect()
  if (!r) return
  // 右偏移用 clientWidth（不含滚动条）算，否则会比顶栏内边距多出一个滚动条宽度
  menuPos.value = {
    top: `${Math.round(r.bottom + 6)}px`,
    right: `${Math.round(document.documentElement.clientWidth - r.right)}px`,
  }
}
function toggleUserMenu() {
  // 先量后开：否则首帧菜单会先落在 (0,0) 再跳到位
  if (!userMenu.value) placeUserMenu()
  userMenu.value = !userMenu.value
}
function onWinResize() { if (userMenu.value) placeUserMenu() }
onMounted(() => window.addEventListener('resize', onWinResize))
onUnmounted(() => window.removeEventListener('resize', onWinResize))
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

// ── 系统健康徽标（A12）：CPU/内存/磁盘迷你条 + 运行中任务数 ──
// 数据源 /system/overview（与概览同口径）+ /tasks（运行中计数）；15s 轮询，
// 失败静默、页签不可见暂停（沿用全站 P9 纪律）。
const health = ref<{ cpu: number; mem: number; disk: number; uptime: number } | null>(null)
const runningTasks = ref(0)
const healthOk = computed(() => auth.supported(CAP.METRICS_READ))
const tasksOk = computed(() => auth.whyDisabled(CAP.METRICS_READ, 'task.view') === null)

async function loadHealth() {
  try {
    const ov = await api.get<{
      cpu_pct?: number; mem_used_kib?: number; mem_total_kib?: number
      disk_used_bytes?: number; disk_total_bytes?: number; uptime_sec?: number
    }>(API.system.overview())
    health.value = {
      cpu: ov?.cpu_pct ?? 0,
      mem: ov && ov.mem_total_kib ? (ov.mem_used_kib ?? 0) / ov.mem_total_kib * 100 : 0,
      disk: ov && ov.disk_total_bytes ? (ov.disk_used_bytes ?? 0) / ov.disk_total_bytes * 100 : 0,
      uptime: ov?.uptime_sec ?? 0,
    }
  } catch { /* 静默重试：徽标取不到不影响任何操作 */ }
}
async function loadRunningTasks() {
  if (!tasksOk.value) return
  try {
    const list = await api.get<{ state: string }[]>(API.tasks.list())
    runningTasks.value = (list ?? []).filter(t => t.state === 'queued' || t.state === 'running').length
  } catch { /* 静默重试 */ }
}
function onHealthTick() { void loadHealth(); void loadRunningTasks() }
let healthTimer: number | undefined
function onHealthVisibility() {
  if (document.hidden) {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined }
  } else {
    onHealthTick()
    // 恢复前先清旧句柄（同各监控页）：后台标签打开时 onMounted 已建过定时器，
    // 直接覆盖会让旧句柄丢失、两个定时器同时跑。
    if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined }
    healthTimer = window.setInterval(onHealthTick, 15_000)
  }
}
onMounted(() => {
  onHealthTick()
  healthTimer = window.setInterval(onHealthTick, 15_000)
  document.addEventListener('visibilitychange', onHealthVisibility)
})
onUnmounted(() => {
  if (healthTimer) clearInterval(healthTimer)
  document.removeEventListener('visibilitychange', onHealthVisibility)
})

const hpct = (x: number) => Math.min(100, Math.max(2, x)) + '%'
const htone = (x: number) => (x >= 88 ? 'danger' : x >= 70 ? 'warn' : 'ok')
const healthTip = computed(() => {
  const h = health.value
  if (!h) return '系统健康（点击查看概览）'
  const p = auth.platform
  const host = p ? `${p.distro || p.os} · ${p.arch}` : ''
  const d = Math.floor(h.uptime / 86400), hr = Math.floor((h.uptime % 86400) / 3600)
  const up = h.uptime >= 86400 ? `${d} 天 ${hr} 小时` : `${hr} 小时`
  return `CPU ${h.cpu.toFixed(1)}% · 内存 ${h.mem.toFixed(1)}% · 磁盘 ${h.disk.toFixed(1)}%\n${host} · 已运行 ${up}｜点击查看概览`
})

// 命令面板：全局 ⌘K / Ctrl+K 唤起（评估报告 A11）。即便焦点在终端输入框也照常触发，
// 因为这是面板级快捷键，不应被页面内输入框吞掉。
function onPaletteKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
  }
}
onMounted(() => window.addEventListener('keydown', onPaletteKey))
onUnmounted(() => window.removeEventListener('keydown', onPaletteKey))

function logout() {
  userMenu.value = false
  auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="shell">
    <SideNav />
    <!-- 移动端抽屉遮罩：点击收起（审计 R1）。桌面端不渲染（v-if）。 -->
    <div v-if="navDrawerOpen" class="nav-backdrop" @click="closeNav" />
    <main>
      <header class="topbar">
        <!-- 汉堡按钮：仅窄屏（<=900px）出现，打开侧栏抽屉 -->
        <button class="hamburger" type="button" :aria-expanded="navDrawerOpen"
          aria-label="打开导航菜单" @click="navDrawerOpen = true">
          <Icon name="menu" :size="20" />
        </button>
        <div class="title-block">
          <h1 class="title">{{ title }}</h1>
          <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
        </div>

        <span class="spacer" />

        <!-- 系统健康徽标（A12）：CPU/内存/磁盘迷你条，点击直达概览；悬浮出完整读数与主机信息。
             无 metrics 能力时整钮隐藏。 -->
        <RouterLink v-if="healthOk && health" to="/" class="health" :title="healthTip">
          <span class="hb" :class="htone(health.cpu)"><i :style="{ width: hpct(health.cpu) }" /></span>
          <span class="hb" :class="htone(health.mem)"><i :style="{ width: hpct(health.mem) }" /></span>
          <span class="hb" :class="htone(health.disk)"><i :style="{ width: hpct(health.disk) }" /></span>
        </RouterLink>

        <!-- 运行中任务计数（与任务中心同源）：仅在有任务时出现 -->
        <RouterLink v-if="tasksOk && runningTasks > 0" to="/cron/tasks" class="task-chip"
          :title="`${runningTasks} 个任务运行中，点击查看`">
          <Icon name="clock" :size="13" /> {{ runningTasks }}
        </RouterLink>

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

        <button class="btn-icon ghost" type="button" title="命令面板（Ctrl / ⌘ + K）" @click="paletteOpen = true">
          <Icon name="search" :size="18" />
        </button>

        <!-- AI 助手顶栏常驻入口（C9）：原先入口埋在侧边栏末位，高频问诊路径太长 -->
        <RouterLink v-if="assistOk" :to="{ name: 'assistant', query: { ctx: (route.meta.title as string) || undefined } }" class="btn-icon ghost" title="AI 助手">
          <Icon name="sparkles" :size="18" />
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
            ref="userBtn"
            type="button" class="user"
            :aria-expanded="userMenu" aria-haspopup="menu"
            :aria-label="`用户菜单（${auth.me?.user ?? ''}）`"
            @click="toggleUserMenu"
            @keydown.escape="userMenu = false"
          >
            <span class="avatar">{{ initial }}</span>
            <span class="uname">{{ auth.me?.user }}</span>
            <Icon name="chevron" :size="14" class="caret" />
          </button>

          <!-- ⭐ 必须 Teleport 到 body：本菜单挂在 .topbar 里，而 topbar 有
               `backdrop-filter: blur(14px) saturate(150%)` —— **backdrop-filter 会让该
               元素成为 position:fixed 的包含块**，`.backdrop{position:fixed;inset:0}`
               于是按顶栏盒子解算（实测遮罩只有 1036×57，而视口是 1280×577）→
               点内容区根本碰不到遮罩、菜单关不掉（用户报「点其他地方关不了」）。
               移到 body 下就与页面结构无关（同 ColumnPicker 的处置）。菜单随之脱离
               absolute 锚点，改 fixed + 由 placeUserMenu() 按触发按钮实测下发坐标。 -->
          <Teleport to="body">
            <div v-if="userMenu" class="backdrop" @click="userMenu = false" />
            <div v-if="userMenu" class="menu" :style="menuPos">
              <div class="menu-head">
                <span class="avatar sm">{{ initial }}</span>
                <div>
                  <div class="m-name">{{ auth.me?.user }}</div>
                  <div class="m-sub">{{ roleLabel(auth.me?.role) }}</div>
                </div>
              </div>
              <!-- 表格密度（B8）：三档切换后整页表格立刻跟着变，刷新后仍保持。
                   用 role=group + aria-pressed 表达"三选一"，不靠颜色单独承载选中态。 -->
              <div class="mi-group">
                <span class="mi-label" id="tbl-density-label">表格密度</span>
                <div class="seg" role="group" aria-labelledby="tbl-density-label">
                  <button v-for="o in DENSITY_OPTIONS" :key="o.value" type="button" class="seg-b"
                    :class="{ on: density === o.value }" :title="o.hint"
                    :aria-pressed="density === o.value" @click="setDensity(o.value)">{{ o.label }}</button>
                </div>
              </div>
              <!-- 时区（C4）：绝对时间（下发时间/到期日/扫描时刻）按本地或 UTC 显示，刷新后保持。
                   与密度同款 role=group + aria-pressed。 -->
              <div class="mi-group">
                <span class="mi-label" id="time-mode-label">时区</span>
                <div class="seg" role="group" aria-labelledby="time-mode-label">
                  <button v-for="o in TIME_MODE_OPTIONS" :key="o.value" type="button" class="seg-b"
                    :class="{ on: timeMode === o.value }" :title="o.hint"
                    :aria-pressed="timeMode === o.value" @click="setTimeMode(o.value)">{{ o.label }}</button>
                </div>
              </div>
              <button class="mi" @click="openPwdDialog">
                <Icon name="key" :size="16" /> 修改密码
              </button>
              <button class="mi" @click="logout">
                <Icon name="logout" :size="16" /> 退出登录
              </button>
            </div>
          </Teleport>
        </div>
      </header>

      <div class="content">
        <div class="wrap"><RouterView /></div>
      </div>
    </main>
    <ChangePasswordDialog :open="pwdOpen" @close="pwdOpen = false" />
    <!-- 全站唯一的浮层提示宿主（脱离文档流，不影响任何页面布局） -->
    <ToastHost />
    <!-- 命令面板：全局 ⌘K / Ctrl+K 唤起，顶栏搜索按钮亦可触发 -->
    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
  </div>
</template>

<style scoped>
.shell { display: flex; min-height: 100vh; }

/* 汉堡按钮：默认隐藏，仅窄屏抽屉模式可见（审计 R1） */
.hamburger {
  display: none; width: 38px; height: 38px; padding: 0; flex: none;
  border: 1px solid var(--c-border); border-radius: 10px;
  background: var(--c-surface-2); color: var(--c-text);
}
.hamburger:hover { background: var(--c-hover); }
/* 窄屏：显示汉堡、隐藏侧栏常驻形态（侧栏改由 SideNav 自身媒体查询变抽屉） */
@media (max-width: 900px) {
  .hamburger { display: inline-flex; align-items: center; justify-content: center; }
  .content { padding: 16px; }
}
/* 抽屉遮罩：压在顶栏(30)之上、侧栏抽屉(60)之下，点击收起 */
.nav-backdrop { position: fixed; inset: 0; z-index: 59; background: rgba(0,0,0,.45); }

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
.title { font-size: var(--fs-17); font-weight: 650; margin: 0; letter-spacing: .2px; white-space: nowrap; }
.title-block { display: flex; flex-direction: column; justify-content: center; min-width: 0; gap: 1px; }
.subtitle { font-size: var(--fs-12); line-height: 1.3; color: var(--c-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 48vw; }

/* 系统基础信息胶囊：右侧状态簇的一员，紧凑、hover 出详情，点击直达能力矩阵 */
.bell { position: relative; color: var(--c-text-dim); }
.bell:hover { color: var(--c-text); }
.badge-dot { position: absolute; top: -3px; right: -3px; min-width: 17px; height: 17px;
             padding: 0 4px; border-radius: 999px; background: var(--c-danger); color: #fff;
             font-size: var(--fs-12); line-height: 17px; text-align: center; font-weight: 500;
             box-shadow: 0 0 0 2px var(--c-surface); }
.sysinfo {
  display: flex; align-items: center; gap: 7px; flex: none;
  height: 34px; padding: 0 12px;
  border: 1px solid var(--c-border); border-radius: 999px;
  background: var(--c-bg); color: var(--c-text-dim);
  font-size: var(--fs-12-5); white-space: nowrap; text-decoration: none;
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
  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: var(--fs-14);
  background: var(--gradient); box-shadow: var(--glow);
}
.avatar.sm { width: 36px; height: 36px; font-size: var(--fs-15); }
.uname { font-size: var(--fs-13-5); font-weight: 500; }
.caret { color: var(--c-text-dim); transition: transform .15s; }
.user[aria-expanded='true'] .caret { transform: rotate(90deg); }

.backdrop { position: fixed; inset: 0; z-index: 40; }
/* 宽度 168 → 200px：表格密度三档分段控件要并排放下（3×56 + 内边距），
   原先 168px 会把「宽松」挤出去。
   fixed（不是 absolute）：菜单已 Teleport 到 body、脱离了 .user-wrap 的锚点，
   坐标由 placeUserMenu() 实测下发（top = 按钮底 + 6px；right = 视口右 − 按钮右）。
   z-index 41 与 main.css 层级总表一致（40 遮罩 / 41 菜单）。 */
.menu {
  position: fixed; z-index: 41; width: 200px;
  background: var(--c-surface-2); border: 1px solid var(--c-border-strong);
  border-radius: 12px; box-shadow: var(--shadow-lg); padding: 6px; overflow: hidden;
}
.menu-head { display: flex; align-items: center; gap: 11px; padding: 8px 10px 10px; }
.m-name { font-weight: 600; font-size: var(--fs-14); }
.m-sub { font-size: var(--fs-12); color: var(--c-text-dim); }
.mi {
  display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
  padding: 9px 10px; border-radius: 8px; color: var(--c-text);
  background: transparent; border: none; font-size: var(--fs-13-5); cursor: pointer;
}
.mi:hover { background: var(--c-hover); }
/* 表格密度（B8）：与菜单项之间加一条上分隔线，表明它是"偏好"而非"操作" */
.mi-group { padding: 8px 10px; margin-top: 4px; border-top: 1px solid var(--c-border); }
.mi-label { display: block; font-size: var(--fs-12); color: var(--c-text-dim); margin-bottom: 6px; }
.seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--bg-inset); border: 1px solid var(--c-border); }
.seg-b { flex: 1; padding: 5px 0; border: none; border-radius: 6px; background: transparent;
  color: var(--c-text-dim); font-size: var(--fs-12); cursor: pointer; transition: background .12s ease, color .12s ease; }
.seg-b:hover { color: var(--c-text); }
/* 选中态 = 品牌色底 + 加粗：不只靠颜色，色觉障碍/灰阶下仍可分辨 */
.seg-b.on { background: var(--c-primary-soft); color: var(--c-primary); font-weight: 600; }

/* 内容区随视口填满：左内边距与顶栏保持一致（同为 22px），两者左边缘因此对齐。 */
.content { flex: 1; padding: 22px 22px 40px; }
/* 不设 max-width。原先 `max-width:1360px; margin:0 auto` 会让视口超过 ~1650px 后
   内容停止增长并居中，1920 下左右各空 163px、2560 下各空 483px——宽屏上大片是死的。
   面板以表格/卡片为主，填满比"限制行长"更实用，故直接铺满可用宽度。 */
.wrap { width: 100%; }

/* ── 系统健康徽标（A12）：三条迷你指标条 + 运行中任务计数 ── */
.health {
  display: inline-flex; flex-direction: column; justify-content: center; gap: 3px;
  height: 34px; padding: 0 10px; flex: none;
  border: 1px solid var(--c-border); border-radius: 10px;
  text-decoration: none; transition: border-color .15s ease, background .15s ease;
}
.health:hover { border-color: var(--c-border-strong); background: var(--c-hover); }
.hb { width: 30px; height: 4px; border-radius: 999px; background: var(--c-border); overflow: hidden; }
.hb > i { display: block; height: 100%; border-radius: 999px; transition: width .4s ease; }
.hb.ok > i { background: var(--c-ok); }
.hb.warn > i { background: var(--c-warn); }
.hb.danger > i { background: var(--c-danger); }
.task-chip {
  display: inline-flex; align-items: center; gap: 4px; flex: none;
  height: 24px; padding: 0 9px; border-radius: 999px;
  font-size: var(--fs-12); font-weight: 600; text-decoration: none;
  color: var(--c-primary); background: var(--c-primary-soft);
  transition: box-shadow .15s ease;
}
.task-chip:hover { box-shadow: 0 0 0 1px var(--c-primary); }

@media (max-width: 720px) {
  .sysinfo { display: none; }
  .health { display: none; }
}
</style>
