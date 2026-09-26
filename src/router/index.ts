import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginView from '@/views/LoginView.vue'
import DashboardView from '@/views/DashboardView.vue'

// 除仪表盘外的模块均为懒加载：首屏只拉取必要代码（体积预算 ≤150KB gzip）
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    {
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', name: 'dashboard', component: DashboardView },
        { path: 'system', name: 'system', component: () => import('@/views/SystemView.vue') },
        { path: 'services', name: 'services', component: () => import('@/views/ServicesView.vue') },
        { path: 'sites', name: 'sites', component: () => import('@/views/SitesView.vue') },
        { path: 'files', name: 'files', component: () => import('@/views/FilesView.vue') },
        { path: 'databases', name: 'databases', component: () => import('@/views/DatabasesView.vue') },
        { path: 'firewall', name: 'firewall', component: () => import('@/views/FirewallView.vue') },
        { path: 'cron', name: 'cron', component: () => import('@/views/CronView.vue') },
        { path: 'logs', name: 'logs', component: () => import('@/views/LogsView.vue') },
        { path: 'settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
      ],
    },
  ],
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
