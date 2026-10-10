/**
 * 侧边栏折叠状态。
 *
 * 写 localStorage('panel-nav-collapsed')——与 `theme.ts` 同一套约定：
 * 偏好只在这一个模块里定义 key，避免 localStorage 的键散落到各个组件。
 *
 * 为什么要持久化：折叠是**长期偏好**而不是一次性动作（窄屏用户会一直用折叠态），
 * 刷新一次就弹回展开态会让人每次都得再点一遍。
 */
import { ref, watch } from 'vue'

const KEY = 'panel-nav-collapsed'

/** 默认展开。已折叠 → 立刻按折叠态渲染，不做"先展开再收起"的闪烁。 */
export const navCollapsed = ref(localStorage.getItem(KEY) === '1')

watch(navCollapsed, (v) => localStorage.setItem(KEY, v ? '1' : '0'))

export function toggleNav() {
  navCollapsed.value = !navCollapsed.value
}

/**
 * 移动端抽屉状态（审计 R1）。
 *
 * 窄屏（<=900px）侧栏改为浮层抽屉：顶栏汉堡按钮打开、遮罩点击 / 路由切换关闭。
 * 与 `navCollapsed` 是两套独立状态——折叠是桌面长期偏好，抽屉是移动端临时态，
 * 互不影响：桌面端折叠态照常生效，移动端抽屉默认收起、宽度强制 234px 不受折叠影响。
 * 不写 localStorage：抽屉是一次性临时态，刷新回到收起即可。
 */
export const navDrawerOpen = ref(false)
export function openNav() { navDrawerOpen.value = true }
export function closeNav() { navDrawerOpen.value = false }
export function toggleNavDrawer() { navDrawerOpen.value = !navDrawerOpen.value }
