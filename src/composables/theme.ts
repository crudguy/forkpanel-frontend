/**
 * 主题：暗 / 亮 / 跟随系统。
 * 写 localStorage('panel-theme')，并同步到 <html data-theme>。
 */
export type ThemeMode = 'dark' | 'light' | 'system'

const KEY = 'panel-theme'

export function getTheme(): ThemeMode {
  return (localStorage.getItem(KEY) as ThemeMode) || 'dark'
}

export function applyTheme() {
  const t = getTheme()
  const sys = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  document.documentElement.dataset.theme = t === 'system' ? sys : t
}

export function setTheme(mode: ThemeMode) {
  localStorage.setItem(KEY, mode)
  applyTheme()
}

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', () => { if (getTheme() === 'system') applyTheme() })
}
