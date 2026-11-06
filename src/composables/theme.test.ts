// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isThemeMode, getTheme, setTheme, applyTheme, cycleTheme,
  themeMode, THEME_OPTIONS,
} from './theme'

const KEY = 'panel-theme'

/** jsdom 没有 matchMedia：用可切换的假实现，才能验证 system 真的跟随系统。 */
let systemLight = true
function fakeMatchMedia(q: string) {
  return {
    media: q,
    get matches() { return q.includes('light') && systemLight },
    addEventListener() {},
    removeEventListener() {},
  }
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.dataset.theme = ''
  systemLight = true
  vi.stubGlobal('matchMedia', fakeMatchMedia)
  setTheme('dark') // 模块级单例复位；同时证明写入链路是通的
})

afterEach(() => { vi.unstubAllGlobals() })

describe('isThemeMode / getTheme 白名单', () => {
  it('只认三态，脏值一律不认', () => {
    expect(['dark', 'light', 'system'].every(isThemeMode)).toBe(true)
    for (const bad of ['', 'DARK', 'foo', null, undefined, 1, {}]) {
      expect(isThemeMode(bad)).toBe(false)
    }
  })

  it('无值 / 非法值都回落 dark，合法值原样返回', () => {
    localStorage.removeItem(KEY)
    expect(getTheme()).toBe('dark')
    for (const bad of ['foo', 'DARK', '{"a":1}']) {
      localStorage.setItem(KEY, bad)
      expect(getTheme()).toBe('dark')
    }
    for (const ok of ['dark', 'light', 'system']) {
      localStorage.setItem(KEY, ok)
      expect(getTheme()).toBe(ok)
    }
  })
})

describe('setTheme / applyTheme', () => {
  it('写入偏好、更新单例与 data-theme', () => {
    setTheme('light')
    expect(localStorage.getItem(KEY)).toBe('light')
    expect(themeMode.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('非法值被拒绝，不污染偏好 / 单例 / DOM', () => {
    setTheme('evil' as never)
    expect(localStorage.getItem(KEY)).toBe('dark')
    expect(themeMode.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('system 按 prefers-color-scheme 解析，偏好变化后重算', () => {
    setTheme('system')
    expect(document.documentElement.dataset.theme).toBe('light')
    systemLight = false
    applyTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(themeMode.value).toBe('system') // 模式没变，变的是解析结果
  })
})

describe('cycleTheme / THEME_OPTIONS', () => {
  it('按 深→浅→跟随系统→深 循环，每档都真的落到 DOM', () => {
    for (const want of ['light', 'system', 'dark']) {
      cycleTheme()
      expect(themeMode.value).toBe(want)
      expect(localStorage.getItem(KEY)).toBe(want)
      expect(document.documentElement.dataset.theme).toBe(
        want === 'system' ? 'light' : want,
      )
    }
  })

  it('三态选项完备，system 不许被删掉（假控制的回归点）', () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(['dark', 'light', 'system'])
    for (const o of THEME_OPTIONS) {
      expect(o.label && o.hint && o.icon).toBeTruthy()
    }
  })
})
