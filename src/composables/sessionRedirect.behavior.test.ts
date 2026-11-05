// F-04：会话过期跳登录必须带回原地址。
// 纯函数部分走行为断言；「main.ts 真的用了它」是接线事实，用源码守卫钉住
// （main.ts 有 app.mount 副作用，真挂载成本远高于收益）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loginRedirect } from './sessionRedirect'

const MAIN = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8')

/** 源码守卫必须剥注释：注释里讲「redirect」不等于代码真的这么写。 */
function clean(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('loginRedirect（会话过期回跳）', () => {
  it('普通深链带回完整路径', () => {
    expect(loginRedirect('/sites?tab=ssl#advanced')).toEqual({
      name: 'login', query: { redirect: '/sites?tab=ssl#advanced' },
    })
  })

  it('概览页也带回，而不是一律落空 query', () => {
    expect(loginRedirect('/').query.redirect).toBe('/')
  })

  it('登录页自身不回跳，避免登录后被送回登录页死循环', () => {
    expect(loginRedirect('/login')).toEqual({ name: 'login', query: {} })
    expect(loginRedirect('/login?redirect=%2Fsites')).toEqual({ name: 'login', query: {} })
  })

  it('空值 / 外链形状 / 相对路径一律不回跳', () => {
    expect(loginRedirect(undefined).query).toEqual({})
    expect(loginRedirect('').query).toEqual({})
    expect(loginRedirect('//evil.example/sites').query).toEqual({})
    expect(loginRedirect('sites').query).toEqual({})
  })

  it('返回值可直接交给 router.push（name 固定 login）', () => {
    const t = loginRedirect('/cron/tasks')
    expect(t.name).toBe('login')
    expect(Object.keys(t.query)).toEqual(['redirect'])
  })
})

describe('接线守卫：main.ts 的 401 处理必须真的用 loginRedirect', () => {
  it('401 事件块里 clearSession + loginRedirect + router.push 三者齐全', () => {
    const body = clean(MAIN)
    const start = body.indexOf("addEventListener('panel:unauthorized'")
    expect(start, '找不到 401 事件监听——扫描前提不成立，不许静默通过').toBeGreaterThan(0)
    const block = body.slice(start, start + 600)
    expect(block).toContain('auth.clearSession()')
    expect(block).toContain('loginRedirect(')
    expect(block).toContain('router.currentRoute.value.fullPath')
    expect(block).toContain('router.push(')
    // 旧实现（裸 push）复活即红
    expect(block).not.toContain("router.push({ name: 'login' })")
  })

  it('import 存在且恰好一次', () => {
    const hits = clean(MAIN).match(/import \{ loginRedirect \} from '@\/composables\/sessionRedirect'/g) ?? []
    expect(hits.length).toBe(1)
  })
})
