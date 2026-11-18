<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SideNav from '@/components/SideNav.vue'
import ChangePasswordDialog from '@/components/ChangePasswordDialog.vue'
import ToastHost from '@/components/ToastHost.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import TopbarMaintenance from '@/components/TopbarMaintenance.vue'
import Icon from '@/components/Icon.vue'
import ErrorBoundary from '@/components/ErrorBoundary.vue'
import { useAuthStore } from '@/stores/auth'
import { useNotificationsStore } from '@/stores/notifications'
import { usePolling } from '@/composables/usePolling'
import { whyDisabledForPath } from '@/composables/navPolicy'
import { sysBadgeTip } from '@/composables/sysBadge'
import { distroLabel } from '@/composables/systemLabel'
import { toast } from '@/composables/useToast'
import { themeMode, setTheme, THEME_OPTIONS } from '@/composables/theme'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { roleLabel, CAP } from '@/api/types'
import { navDrawerOpen, closeNav } from '@/composables/nav'
import { useTableDensity, DENSITY_OPTIONS } from '@/composables/useTablePrefs'
import { timeMode, setTimeMode } from '@/api/types'
import type { TimeMode } from '@/api/types'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
// 命令面板候选直接来自路由表（唯一事实源），不在组件里维护会漂移的清单
const commandRoutes = router.getRoutes()

// 表格密度（B8）：全站共享偏好，放用户菜单里——它是"看的方式"，不是某一页的
// 功能，塞进某个视图的工具条会让用户以为只影响那一页。主题与时区同处此菜单。
const { density, setDensity } = useTableDensity()

// 时区（C4）：绝对时间按本地/UTC 显示，全站共享偏好，与密度同处用户菜单。
const TIME_MODE_OPTIONS: { value: TimeMode; label: string; hint: string }[] = [
  { value: 'local', label: '本地', hint: '跟随浏览器时区（默认）' },
  { value: 'utc', label: 'UTC', hint: '绝对时间按 UTC 显示，便于跨时区核对' },
]

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
  dashboard: '主机状态总览 · 指标卡排序/显隐为面板级共享配置，具 settings.manage 权限者可拖拽调整（其他账号只读应用新顺序）',
  system: '实时资源趋势与历史走向',
  'system-pro': '每核 CPU / 负载 / 内存 / 磁盘 / 网卡 完整快照',
  'system-procs': '服务器全部进程 · 表头可按 CPU / 内存 / 用户排序 · 重载 / 结束 / 立即终止需 system.manage 与信号能力（只读角色仅可查看）',
  'system-dirs': '面板装到了哪 · 数据 / 日志 / Web 服务器 / 前端各在哪（与运行时实际落点一致）',
  'system-expose': '默认只监听回环 · 需 system.manage 方可用向导配置域名反代 + 来源白名单（HTTPS 可选）',
  'services-software': '白名单软件的安装 / 卸载 / 升级 · 写操作需 package.manage（operator / viewer 不可用）',
  'services-units': '服务列表与状态概览 · 点行进详情页启停 / 看日志 / 改配置',
  'service-detail': '单服务启停 / 日志 / 配置 · 启停与配置需 service.manage，日志只需只读权限',
  'not-found': '地址不存在 · 可从左侧菜单继续',
  sites: '虚拟主机站点管理 · 写操作需 site.manage / ssl.manage（viewer 只读）',
  apps: 'systemd 托管进程 · 自动反代站点 · 构建请自行完成（增删改需 service.manage，建反代另需 site.manage）',
  databases: '连接管理 · 只读浏览 / SQL · 备份 / 恢复 · 写操作需 db.manage（operator / viewer 不可用）',
  files: '目录浏览 / 上传 / 整理 · 面包屑分段可点直达（写操作需 file.write，viewer 只读）',
  logs: '字面量过滤 · 上限 2000 行 · 支持实时跟随',
  'logs-audit': '全量关键操作审计（可筛选 / 导出 / 校验完整性，所有内置角色可见）',
  firewall: '端口放行规则（改动需应用后下发）与 fail2ban 入侵防御 · 仅 owner/admin 可进入',
  'firewall-baseline': '安全基线检查与修复 · SSH 端口 · 活跃会话与两步验证 · 仅 owner/admin 可进入',
  cron: '平台原生调度，表达式语义由后端校验',
  'cron-tasks': '后台任务与执行进度（运行中每 2 秒自动刷新）',
  users: '面板账号与权限',
  settings: '面板与功能模块的配置与开关中心',
  notifications: '面板内消息（全局共享）· 未读计数 · 需 notification.manage 方可一键全部已读（viewer 无此按钮）',
  terminal: '内置 Web 终端（宿主级 shell，需 system.manage）· 关闭标签即断开会话，空闲 15 分钟自动回收',
  assistant: '内置规则诊断 · 基于真实系统数据 · 只建议不自动执行',
  backups: '备份计划（含可选远端副本）· 手动执行 · 产物列表 · 从产物恢复（高危需确认词，面板库须停服后用 CLI）',
  // ⚠ 曾经写「只读列举 + 启停/重启/删除（不提供创建容器）」——创建容器早已开放，
  // 且现在还支持 Compose 项目的 up/stop/restart/down，那句是过时的事实错误。
  containers: 'Docker · 列举（viewer 可看）/ 创建 / 启停 / 删除 · Compose up/stop/restart/down（写操作需 container.manage）',
  waf: '各站点防护档位与 IP 访问控制 · CC 限速仅 nginx（caddy 不支持）· 随站点配置一同下发',
  certs: '各站点证书总览 · 申请 / 续期需 ssl.manage · 信任根证书 site.view 即可',
  help: '常用操作指引 · 模块说明 · 安全提示与排障',
}
const subtitle = computed(() => SUBTITLES[String(route.name)] ?? '')

// 主题：选中态直接读 composables/theme 的模块级单例。唯一入口在用户菜单的三态
// 分段控件（登录页另有一处，属不同上下文）；原先顶栏还有一个「切到下一档」快捷钮，
// 同一状态两个入口、且目标档位不可指定，已删（2026-11-17）。

const userMenu = ref(false)
const pwdOpen = ref(false)
function openPwdDialog() {
  closeUserMenu()
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
// 关闭只有这一条路径：遮罩点击 / Esc / 选完菜单项都走它。
function closeUserMenu() { userMenu.value = false }
// Esc：焦点此时可能已经在菜单里的某个按钮上，关掉后必须交还触发钮，否则焦点
// 落到 body，键盘用户得从头 Tab 一遍（@keydown.escape 只挂在触发钮上时，
// 焦点进了菜单就再按不到了）。
function onUserMenuEsc() {
  closeUserMenu()
  userBtn.value?.focus()
}
function onWinResize() { if (userMenu.value) placeUserMenu() }
onMounted(() => window.addEventListener('resize', onWinResize))
onUnmounted(() => window.removeEventListener('resize', onWinResize))
const initial = computed(() => (auth.me?.user || '?').slice(0, 1).toUpperCase())

// 通知未读数：与通知页共用 `useNotificationsStore`——页面里标记已读/全部已读/
// 删除后徽标立即跟着变（此前两边各持一份 ref，最长 60s 才能自愈）。
// 顶栏只负责轮询与补拉：60s 一轮（非关键路径，失败静默）+ 路由变化补一次。
const notifications = useNotificationsStore()
const unread = computed(() => notifications.unread)
// 铃铛只给能进通知页的人：没有 system.view 的角色既不显示入口，也不每 60s
// 打一次注定 403 的请求（此前静默失败，既浪费请求又让人以为铃铛是坏的）。
const notifOk = computed(() => whyDisabledForPath(auth, '/notifications') === null)
// 60s 一轮；隐藏暂停 / 卸载清理交给 usePolling（原先未读计数不暂停，后台标签
// 也每分钟打一次——那是漏迁移，不是刻意行为）。首屏仍需立即取一次。
watch(() => route.path, () => { if (notifOk.value) void notifications.refresh() })
usePolling({ fn: () => notifications.refresh(), ms: 60_000, enabled: () => notifOk.value })
onMounted(() => { if (notifOk.value) void notifications.refresh() })

// ── 系统健康徽标（A12）：CPU/内存/磁盘迷你条 + 运行中任务数 ──
// 数据源 /system/overview（与概览同口径）+ /tasks（运行中计数）；15s 轮询，
// 失败静默、页签不可见暂停（沿用全站 P9 纪律）。
const health = ref<{ cpu: number; mem: number; disk: number; uptime: number } | null>(null)
const runningTasks = ref(0)
const healthOk = computed(() => auth.supported(CAP.METRICS_READ))
const tasksOk = computed(() => whyDisabledForPath(auth, '/cron/tasks') === null)

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
// 每个 tick 按能力位分别取：原先 loadHealth 不看 healthOk，指标不可用时
// 每 15s 撞一次 501 再静默吞掉（空转打后端）；拆开判断后两个来源互不连坐。
function onHealthTick() {
  if (healthOk.value) void loadHealth()
  if (tasksOk.value) void loadRunningTasks()
}
usePolling({ fn: onHealthTick, ms: 15_000 })
onMounted(onHealthTick)

// ── 面板版本常驻展示 + 重装 + 重启（右上角维护簇）已迁至 TopbarMaintenance.vue ──
// 该组件自管 /version 与 /settings(installation) 的拉取与浮层，顶栏此处只挂载它。

const hpct = (x: number) => Math.min(100, Math.max(2, x)) + '%'
const htone = (x: number) => (x >= 88 ? 'danger' : x >= 70 ? 'warn' : 'ok')
// 合并胶囊（原 A12 健康徽标 + 系统信息胶囊）：tooltip 文案唯一源在 composables/sysBadge.ts，
// 两种形态（有/无 metrics 读数）都在 sysBadge.test.ts 真跑断言。
const healthTip = computed(() => sysBadgeTip(health.value, auth.platform))

async function logout() {
  closeUserMenu()
  try {
    // 等后端真的把会话作废：失败时停在原页并提示，不要再抛一个未处理的
    // Promise rejection，也不要在会话仍有效时把人送到登录页。
    await auth.logout()
    await router.replace({ name: 'login' })
  } catch (e) {
    toast(`退出登录失败：${errorText(e)}`, 'err')
  }
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

        <!-- 系统徽标胶囊（2026-10-30 合并自 A12 健康徽标 + 系统信息胶囊）：两枚相邻胶囊
             重复承载同一主机信息（healthTip 里也拼了 distro·arch），视觉互相冲突。
             合并后 = distro·arch 常驻文本 + CPU/内存/磁盘迷你条（metrics 可用时），
             无 metrics 时退化为纯文本胶囊。tooltip 文案见 composables/sysBadge.ts。
             点击目标取能力矩阵而非概览：#caps 深链是排障唯一入口（菜单为何置灰、
             端点为何 501），概览在侧栏首项、指标条→概览属冗余快捷方式；
             早年「胶囊挨着主题切换」的偏好由本次合并让位（用户裁决合并优先）。 -->
        <RouterLink v-if="auth.platform || (healthOk && health)" to="/settings#caps" class="health" :title="healthTip">
          <span v-if="auth.platform" class="ht">{{ distroLabel(auth.platform.distro) || auth.platform.os }} · {{ auth.platform.arch }}</span>
          <span v-if="healthOk && health" class="hbars">
            <span class="hb" :class="htone(health.cpu)"><i :style="{ width: hpct(health.cpu) }" /></span>
            <span class="hb" :class="htone(health.mem)"><i :style="{ width: hpct(health.mem) }" /></span>
            <span class="hb" :class="htone(health.disk)"><i :style="{ width: hpct(health.disk) }" /></span>
          </span>
        </RouterLink>

        <!-- 维护簇：版本号（点击查更新/升级）+ 重装 + 重启（面板/系统） -->
        <TopbarMaintenance />

        <!-- 运行中任务计数（与任务中心同源）：仅在有任务时出现 -->
        <RouterLink v-if="tasksOk && runningTasks > 0" to="/cron/tasks" class="task-chip"
          :title="`${runningTasks} 个任务运行中，点击查看`">
          <Icon name="clock" :size="13" /> {{ runningTasks }}
        </RouterLink>


        <RouterLink v-if="notifOk" :to="{ name: 'notifications' }" class="btn-icon ghost bell"
          :aria-label="unread ? `通知，${unread} 条未读` : '通知'"
          :title="unread ? `未读通知 ${unread} 条` : '通知'">
          <Icon name="bell" :size="18" />
          <!-- 徽标只做视觉提示：它的数字会成为链接的可访问名（AX 实测变成 "1"），
               故用 aria-hidden 挡掉，名字由上面的 aria-label 统一给出。 -->
          <span v-if="unread" class="badge-dot" aria-hidden="true">{{ unread > 99 ? '99+' : unread }}</span>
        </RouterLink>

        <!-- 真实 button + aria-expanded（审计 U12）：此前 div+click 不可键盘聚焦，
             CSS 写了 [aria-expanded] 选择器却从不设置，键盘用户打不开菜单。
             触发器与下拉面板分离（HTML 不允许 button 嵌套 button）。 -->
        <div class="user-wrap">
          <button
            ref="userBtn"
            type="button" class="user"
            :aria-expanded="userMenu" aria-controls="user-menu"
            :aria-label="`用户菜单（${auth.me?.user ?? ''}）`"
            @click="toggleUserMenu"
            @keydown.escape="onUserMenuEsc"
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
            <div v-if="userMenu" class="backdrop" aria-hidden="true" @click="closeUserMenu" />
            <div v-if="userMenu" id="user-menu" class="menu" :style="menuPos"
              role="group" aria-label="用户菜单" @keydown.escape="onUserMenuEsc">
              <div class="menu-head">
                <span class="avatar sm">{{ initial }}</span>
                <div>
                  <div class="m-name">{{ auth.me?.user }}</div>
                  <div class="m-sub">{{ roleLabel(auth.me?.role) }}</div>
                </div>
              </div>
              <!-- 主题三态：与密度/时区同款 seg。system 此前只存在于类型里、
                   二态 toggle 永远到不了（假控制），这里让它真正可选。 -->
              <div class="mi-group">
                <span class="mi-label" id="theme-mode-label">主题</span>
                <div class="seg" role="group" aria-labelledby="theme-mode-label">
                  <button v-for="o in THEME_OPTIONS" :key="o.value" type="button" class="seg-b"
                    :class="{ on: themeMode === o.value }" :title="o.hint"
                    :aria-pressed="themeMode === o.value" @click="setTheme(o.value)">{{ o.label }}</button>
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
        <div class="wrap">
          <!-- 页面级边界：单个视图崩掉时侧栏/顶栏仍可用，切页即可恢复 -->
          <ErrorBoundary title="本页渲染出错">
            <RouterView />
          </ErrorBoundary>
        </div>
      </div>
    </main>
    <ChangePasswordDialog :open="pwdOpen" @close="pwdOpen = false" />
    <!-- 全站唯一的浮层提示宿主（脱离文档流，不影响任何页面布局） -->
    <ToastHost />
    <!-- 全局命令面板：常驻根层，浮层自己 Teleport 到 body（不要挪进任何 v-if 块） -->
    <CommandPalette :routes="commandRoutes" />
  </div>
</template>

<style scoped>
.shell { display: flex; min-height: 100vh; }

/* 汉堡按钮：默认隐藏，仅窄屏抽屉模式可见（审计 R1） */
.hamburger {
  display: none; width: 38px; height: 38px; padding: 0; flex: none;
  border: 1px solid var(--c-border); border-radius: var(--radius-sm);
  background: var(--c-surface-2); color: var(--c-text);
}
.hamburger:hover { background: var(--c-hover); }
/* 窄屏断点**不写在这里**：`.content` 的内边距覆盖必须排在下方基础规则之后，
   否则同特异性被后者盖掉（曾因此让 900px 档的 padding 从未生效过）。
   全部集中在 <style> 末尾的「响应式」小节。 */
/* 抽屉遮罩：压在顶栏(30)之上、侧栏抽屉(60)之下，点击收起 */
.nav-backdrop { position: fixed; inset: 0; z-index: 59; background: var(--c-scrim); }

main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.topbar {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; gap: 14px;
  height: var(--topbar-h); padding: 0 22px;
  background: color-mix(in srgb, var(--c-surface) 82%, transparent);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  border-bottom: 1px solid var(--c-border);
}
.title { font-size: var(--fs-17); font-weight: 650; margin: 0; letter-spacing: .2px; white-space: nowrap;
         overflow: hidden; text-overflow: ellipsis; }
/* flex:1 1 auto 让标题块吃掉剩余空间：此前是 `0 1 auto` + min-width:0，
   于是空间不足时它被压到 **0 宽**——实测 1024px（笔记本常见宽）与 768px 下
   `.title` 的宽度就是 0，页面标题整块消失。顶栏里只有它是「可让」的文本，
   该让路的是信息性胶囊（见下方 <=1200 收起 .health），不是标题。 */
.title-block { display: flex; flex-direction: column; justify-content: center; flex: 1 1 auto; min-width: 0; gap: 1px; }
.subtitle { font-size: var(--fs-12); line-height: 1.3; color: var(--c-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 48vw; }

.bell { position: relative; color: var(--c-text-dim); }
.bell:hover { color: var(--c-text); }
.badge-dot { position: absolute; top: -6px; right: -6px; min-width: 17px; height: 17px;
             padding: 0 4px; border-radius: 999px; background: var(--c-danger); color: var(--c-on-accent);
             font-size: var(--fs-12); line-height: 17px; text-align: center; font-weight: 500;
             box-shadow: 0 0 0 2px var(--c-surface); }
.spacer { flex: 1; }

.user-wrap { position: relative; }
.user { position: static; display: flex; align-items: center; gap: 9px; cursor: pointer;
        padding: 4px 8px 4px 4px; border-radius: 999px; border: none; background: none; color: inherit; font: inherit; }
.user:hover { background: var(--c-hover); }
.avatar {
  width: 32px; height: 32px; border-radius: 50%; flex: none;
  display: grid; place-items: center; color: var(--c-on-accent); font-weight: 700; font-size: var(--fs-14);
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
  border-radius: var(--radius-md); box-shadow: var(--shadow-lg); padding: 6px; overflow: hidden;
}
.menu-head { display: flex; align-items: center; gap: 11px; padding: 8px 10px 10px; }
.m-name { font-weight: 600; font-size: var(--fs-14); }
.m-sub { font-size: var(--fs-12); color: var(--c-text-dim); }
.mi {
  display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
  padding: 9px 10px; border-radius: var(--radius-xs); color: var(--c-text);
  background: transparent; border: none; font-size: var(--fs-13-5); cursor: pointer;
}
.mi:hover { background: var(--c-hover); }
/* 表格密度（B8）：与菜单项之间加一条上分隔线，表明它是"偏好"而非"操作" */
.mi-group { padding: 8px 10px; margin-top: 4px; border-top: 1px solid var(--c-border); }
.mi-label { display: block; font-size: var(--fs-12); color: var(--c-text-dim); margin-bottom: 6px; }
.seg { display: flex; gap: 2px; padding: 2px; border-radius: var(--seg-radius); background: var(--seg-bg); border: 1px solid var(--seg-border); }
.seg-b { flex: 1; padding: 5px 0; border: none; border-radius: var(--seg-item-radius); background: transparent;
  color: var(--seg-fg); font-size: var(--fs-12); cursor: pointer; transition: background .12s ease, color .12s ease; }
.seg-b:hover { color: var(--c-text); }
/* 选中态 = 品牌色底 + 加粗：不只靠颜色，色觉障碍/灰阶下仍可分辨 */
.seg-b.on { background: var(--seg-on-bg); color: var(--seg-on-fg); font-weight: 600; }

/* 内容区随视口填满：左内边距与顶栏保持一致（同为 22px），两者左边缘因此对齐。 */
/* 内边距取 --content-pt/--content-pb（main.css 定义）：FilesView / TerminalView 的
   全高布局要用同一个值算 `calc(100vh - var(--page-chrome-h))`，窄屏由 main.css 的
   媒体查询统一改小，此处无需再写一条 @media（写了也容易被同特异性覆盖）。 */
.content { flex: 1; padding: var(--content-pt) 22px var(--content-pb); }
/* 不设 max-width。原先 `max-width:1360px; margin:0 auto` 会让视口超过 ~1650px 后
   内容停止增长并居中，1920 下左右各空 163px、2560 下各空 483px——宽屏上大片是死的。
   面板以表格/卡片为主，填满比"限制行长"更实用，故直接铺满可用宽度。 */
.wrap { width: 100%; }

/* ── 系统徽标胶囊（A12 健康徽标 + 系统信息胶囊合并）：distro·arch 文本 + 三条迷你指标条 ── */
.health {
  display: inline-flex; align-items: center; gap: 9px; flex: none;
  height: 34px; padding: 0 12px;
  border: 1px solid var(--c-border); border-radius: 999px;
  background: var(--c-bg); color: var(--c-text-dim);
  font-size: var(--fs-12-5); text-decoration: none;
  transition: color .15s ease, background .15s ease, border-color .15s ease;
}
.health:hover { color: var(--c-text); background: var(--c-hover); border-color: var(--c-border-strong); }
.ht { white-space: nowrap; }
.hbars { display: flex; flex-direction: column; justify-content: center; gap: 3px; }
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

/* 面板版本胶囊：与 health 胶囊同款外形，常驻顶栏左侧信息簇，更新后重启即变。 */
.ver-chip {
  display: inline-flex; align-items: center; flex: none; height: 34px; padding: 0 12px;
  border: 1px solid var(--c-border); border-radius: 999px;
  background: var(--c-bg); color: var(--c-text-dim);
  font-size: var(--fs-12-5); font-weight: 600; white-space: nowrap;
  transition: color .15s ease, background .15s ease, border-color .15s ease;
}
.ver-chip:hover { color: var(--c-text); background: var(--c-hover); border-color: var(--c-border-strong); }

/* ══ 响应式（从宽到窄；宽度断点全站只有 1200 / 900 / 720 / 480 四档）══════════
   900 = 侧栏「常驻 → 抽屉」的分界，与 SideNav 自身媒体查询同档。 */

/* <=1200：顶栏收起系统徽标胶囊。
   2026-11-17 真机复测（1440 / 1024 / 900 / 768）：收起徽标后标题宽 350 / 238 /
   294 / 228，四档均无横向溢出；1024 下强行显示徽标（实测占 187px）标题只剩
   48px —— 这就是本档仍然保留的依据。
   （2026-11-05 的老记录里固定项 657px 还含「搜索 34」「主题 34」两个重复入口，
   1024 下 `.title` 曾被压到 0；两者已删，共省 96px。）
   徽标是纯信息展示（点它才进能力矩阵），窄屏让位给标题；能力矩阵侧栏仍有入口。 */
@media (max-width: 1200px) {
  .health { display: none; }
}

/* <=900：侧栏转抽屉（汉堡出现），与 SideNav 自身媒体查询同档。
   本档原先还把顶栏 AI 胶囊收成纯图标（768 下固定项 694 + 间距 126 + 内边距
   44 = 864 > 758 会横向滚动），该入口已删，现在只剩汉堡。 */
@media (max-width: 900px) {
  .hamburger { display: inline-flex; align-items: center; justify-content: center; }
}
</style>
