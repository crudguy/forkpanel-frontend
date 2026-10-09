import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginView from '@/views/LoginView.vue'
import DashboardView from '@/views/DashboardView.vue'

// 除仪表盘外的模块均为懒加载：首屏只拉取必要代码（体积预算 ≤150KB gzip）
export const router = createRouter({
  history: createWebHistory(),
  // 支持 #锚点 深链（如 /settings#caps：topbar 系统信息胶囊直达能力矩阵）；
  // 顺带修正"切换路由后仍停在旧滚动位置"的默认行为。
  scrollBehavior(to, _from, savedPosition) {
    if (to.hash) return { el: to.hash, top: 24, behavior: 'smooth' }
    return savedPosition ?? { top: 0 }
  },
  routes: [
    { path: '/login', name: 'login', component: LoginView, meta: { title: '登录' } },
    {
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', name: 'dashboard', component: DashboardView, meta: { title: '概览' } },
        {
          path: 'system',
          component: () => import('@/views/MonitorView.vue'),
          children: [
            { path: '', name: 'system', component: () => import('@/views/SystemView.vue'), meta: { title: '实时趋势' } },
            { path: 'pro', name: 'system-pro', component: () => import('@/views/ProfessionalView.vue'), meta: { title: '专业快照' } },
            { path: 'procs', name: 'system-procs', component: () => import('@/views/ProcessesView.vue'), meta: { title: '进程管理' } },
          ],
        },
        // 「软件 / 服务」是同一页的两个 Tab，**由子路由承载**（两条路由指向同一组件）：
        // 顶栏标题随子路由 meta.title 变化、Tab 可深链可前进后退，与「主机监控」同范式。
        // 旧链接 /services 重定向到默认 Tab（软件）。
        { path: 'services', redirect: '/services/software' },
        { path: 'services/software', name: 'services-software', component: () => import('@/views/ServicesView.vue'), meta: { title: '软件' } },
        { path: 'services/units', name: 'services-units', component: () => import('@/views/ServicesView.vue'), meta: { title: '服务' } },
        // 服务详情：原先是列表页里的模态弹窗（启停+日志+配置三块挤在半屏里），
        // 改独立路由页后地址可分享、浏览器返回可用、编辑区有完整高度。
        // 不在侧边栏单列入口——由列表页行点击进入。
        { path: 'services/:unit', name: 'service-detail', component: () => import('@/views/ServiceDetailView.vue'), meta: { title: '服务详情' } },
        { path: 'sites', name: 'sites', component: () => import('@/views/SitesView.vue'), meta: { title: '网站' } },
        { path: 'apps', name: 'apps', component: () => import('@/views/AppsView.vue'), meta: { title: '应用' } },
        // WAF 是站点配置的一部分（同一次 apply 下发），单独开一页只为统一查看/批量调整
        { path: 'waf', name: 'waf', component: () => import('@/views/WafView.vue'), meta: { title: 'WAF' } },
        // 证书总览：与 WAF 同理——证书按 domain 归属站点，但需跨站统一巡检/续期/装根 CA，
        // 故单列一项做全局视角（申请/续期/删除的快捷入口仍保留在「编辑站点」弹窗内）。
        { path: 'certs', name: 'certs', component: () => import('@/views/CertsView.vue'), meta: { title: '证书' } },
        { path: 'files', name: 'files', component: () => import('@/views/FilesView.vue'), meta: { title: '文件' } },
        { path: 'databases', name: 'databases', component: () => import('@/views/DatabasesView.vue'), meta: { title: '数据库' } },
        { path: 'containers', name: 'containers', component: () => import('@/views/ContainersView.vue'), meta: { title: '容器' } },
        { path: 'backups', name: 'backups', component: () => import('@/views/BackupsView.vue'), meta: { title: '备份' } },
        {
          path: 'firewall',
          component: () => import('@/views/SecurityCenterView.vue'),
          children: [
            { path: '', name: 'firewall', component: () => import('@/views/FirewallView.vue'), meta: { title: '防火墙规则' } },
            { path: 'baseline', name: 'firewall-baseline', component: () => import('@/views/SecurityView.vue'), meta: { title: '安全基线' } },
          ],
        },
        {
          path: 'cron',
          component: () => import('@/views/TaskCenterView.vue'),
          children: [
            { path: '', name: 'cron', component: () => import('@/views/CronView.vue'), meta: { title: '计划任务' } },
            { path: 'tasks', name: 'cron-tasks', component: () => import('@/views/TasksView.vue'), meta: { title: '任务中心' } },
          ],
        },
        {
          path: 'logs',
          component: () => import('@/views/LogCenterView.vue'),
          children: [
            { path: '', name: 'logs', component: () => import('@/views/LogsView.vue'), meta: { title: '系统日志' } },
            { path: 'audit', name: 'logs-audit', component: () => import('@/views/AuditView.vue'), meta: { title: '审计日志' } },
          ],
        },
        { path: 'notifications', name: 'notifications', component: () => import('@/views/NotificationsView.vue'), meta: { title: '通知' } },
        { path: 'terminal', name: 'terminal', component: () => import('@/views/TerminalView.vue'), meta: { title: '终端' } },
        { path: 'assistant', name: 'assistant', component: () => import('@/views/AssistantView.vue'), meta: { title: 'AI 助手' } },
        { path: 'settings', name: 'settings', component: () => import('@/views/SettingsView.vue'), meta: { title: '设置' } },
        { path: 'processes', redirect: '/system/procs' },
        { path: 'professional', redirect: '/system/pro' },
        { path: 'security', redirect: '/firewall/baseline' },
        { path: 'tasks', redirect: '/cron/tasks' },
        { path: 'users', name: 'users', component: () => import('@/views/UsersView.vue'), meta: { title: '用户' } },
        { path: 'audit', redirect: '/logs/audit' },
      ],
    },
    // 兜底：未匹配的路径重定向到首页。缺此条时访问未知 URL 会渲染空白页（无 404 视图）。
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

// 页面标题统一格式：`<页面> - 叉叉面板 - ForkPanel`（见 index.html 兜底文案）。
const APP_TITLE = '叉叉面板 - ForkPanel'
router.afterEach((to) => {
  const page = typeof to.meta.title === 'string' ? to.meta.title : ''
  document.title = page ? `${page} - ${APP_TITLE}` : APP_TITLE
})

router.beforeEach(async (to) => {
  if (!to.meta.requiresAuth) return true
  const auth = useAuthStore()
  if (!auth.loggedIn) {
    try { await auth.loadMe() } catch { return { name: 'login' } }
    if (!auth.loggedIn) return { name: 'login' }
  }
  return true
})
