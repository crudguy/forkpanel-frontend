/**
 * 主题：暗 / 亮 / 跟随系统。
 * 写 localStorage('panel-theme')，并同步到 <html data-theme>。
 *
 * 与 useTablePrefs 同款范式：模块级单例 ref + 选项常量 + 白名单校验。
 * 顶栏快捷钮、用户菜单、登录页三处都读同一份选中态；各持一份 ref 就会出现
 * 「A 处切了、B 处还显示旧选中态」，而 DOM 主题其实已经是新的。
 */
import { ref } from 'vue'

export type ThemeMode = 'dark' | 'light' | 'system'

const KEY = 'panel-theme'
const VALID: ThemeMode[] = ['dark', 'light', 'system']

/** 三态选项：label / hint / icon 是 UI 的唯一事实源（守卫钉住不得删掉 system）。 */
export const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string; icon: string }[] = [
  { value: 'dark', label: '深色', hint: '始终使用深色界面', icon: 'moon' },
  { value: 'light', label: '浅色', hint: '始终使用浅色界面', icon: 'sun' },
  { value: 'system', label: '跟随系统', hint: '随操作系统外观自动切换', icon: 'monitor' },
]

/** localStorage 是用户可改的：非法值不能变成无人匹配的 data-theme 脏值。 */
export function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && (VALID as string[]).includes(v)
}

export function getTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    return isThemeMode(v) ? v : 'dark'
  } catch {
    return 'dark' // 隐私模式 / 存储被禁：回落默认，不让启动崩
  }
}

/** 模块级单例：三处 UI 共享；切主题只经 setTheme / cycleTheme 写入。 */
export const themeMode = ref<ThemeMode>(getTheme())

/** jsdom / 老浏览器没有 matchMedia：缺它时按暗色解析，不让启动崩。 */
function systemQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null
}

export function applyTheme() {
  const t = themeMode.value
  const sys = systemQuery()?.matches ? 'light' : 'dark'
  document.documentElement.dataset.theme = t === 'system' ? sys : t
}

export function setTheme(mode: ThemeMode) {
  if (!isThemeMode(mode)) return
  themeMode.value = mode
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* 隐私模式 / 配额满：写不进去时本次会话仍生效（已 apply），不打扰用户 */
  }
  applyTheme()
}

/** 顶栏快捷钮：按 THEME_OPTIONS 的顺序循环（深 → 浅 → 跟随系统 → 深）。 */
export function cycleTheme() {
  const i = THEME_OPTIONS.findIndex((o) => o.value === themeMode.value)
  setTheme(THEME_OPTIONS[(i + 1) % THEME_OPTIONS.length].value)
}

if (typeof window !== 'undefined') {
  systemQuery()?.addEventListener('change', () => {
    if (themeMode.value === 'system') applyTheme()
  })
  // 多标签页：另一页改了偏好，本页的选中态与 data-theme 都要跟上
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    const v: unknown = e.newValue
    themeMode.value = isThemeMode(v) ? v : 'dark'
    applyTheme()
  })
}
