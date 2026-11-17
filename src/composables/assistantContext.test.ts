import { describe, it, expect } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { readFileSync } from 'node:fs'
import { pageContextTitle, withAssistantContext, ASSISTANT_CTX_MAX } from './assistantContext'

type CtxRoute = Parameters<typeof withAssistantContext>[0]
function route(name: string, title: string, query: Record<string, string> = {}, hash = ''): CtxRoute {
  return { name, query, hash, meta: { title } } as unknown as CtxRoute
}

describe('pageContextTitle：ctx 口径与注入侧共用', () => {
  it('页面标题原样保留（去首尾空白）', () => {
    expect(pageContextTitle('  网站  ')).toBe('网站')
  })

  it('助手自身 / 空 / 非字符串 → 空，不产生自我指涉的上下文', () => {
    expect(pageContextTitle('AI 助手')).toBe('')
    expect(pageContextTitle('   ')).toBe('')
    expect(pageContextTitle(undefined)).toBe('')
    expect(pageContextTitle(42)).toBe('')
  })

  it('超长截断，挡住任意链接注入指令前缀', () => {
    expect(pageContextTitle('X'.repeat(100))).toBe('X'.repeat(ASSISTANT_CTX_MAX))
  })
})

describe('withAssistantContext：只给助手页注入一次', () => {
  const sites = route('sites', '网站')

  it('从网站页进助手页 → 注入 ctx=网站', () => {
    expect(withAssistantContext(route('assistant', 'AI 助手'), sites)).toEqual({
      name: 'assistant', query: { ctx: '网站' }, hash: '',
    })
  })

  it('已有 ctx → null，重定向重跑守卫不会无限循环', () => {
    expect(withAssistantContext(route('assistant', 'AI 助手', { ctx: '概览' }), sites)).toBeNull()
  })

  it('目标不是助手页 → null，ctx 不撒到全站 URL', () => {
    expect(withAssistantContext(route('settings', '设置'), sites)).toBeNull()
  })

  it('来源是助手页自身 → null，页内重复点不自指', () => {
    expect(withAssistantContext(route('assistant', 'AI 助手'), route('assistant', 'AI 助手'))).toBeNull()
  })

  it('保留目标原有 query 与 hash，深链不被吃掉', () => {
    expect(withAssistantContext(route('assistant', 'AI 助手', { tab: 'x' }, '#q'), sites)).toEqual({
      name: 'assistant', query: { tab: 'x', ctx: '网站' }, hash: '#q',
    })
  })
})

describe('路由接线：决策函数确实接进 beforeEach', () => {
  it('router/index.ts 的 beforeEach 链里恰好调用一次 withAssistantContext(to, from)', () => {
    const src = readFileSync(new URL('../router/index.ts', import.meta.url), 'utf8')
    const calls = src.match(/withAssistantContext\(to, from\)/g) ?? []
    expect(calls).toHaveLength(1)
    // 守卫存在 ≠ 在跑：调用点必须落在 beforeEach 之后，否则只是个没接线的孤儿导入
    const guardAt = src.indexOf('router.beforeEach(')
    const callAt = src.indexOf('withAssistantContext(to, from)')
    expect(guardAt).toBeGreaterThan(-1)
    expect(callAt).toBeGreaterThan(guardAt)
  })
})


describe('真路由导航：守卫返回 location 后能正常落地', () => {
  it('从网站页进助手页 URL 带 ctx，且不会无限重定向', async () => {
    const Dummy = defineComponent({ render: () => h('div') })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/sites', name: 'sites', component: Dummy, meta: { title: '网站' } },
        { path: '/assistant', name: 'assistant', component: Dummy, meta: { title: 'AI 助手' } },
      ],
    })
    router.beforeEach((to, from) => withAssistantContext(to, from) ?? true)
    await router.push('/sites')
    await router.push('/assistant')
    expect(router.currentRoute.value.query.ctx).toBe('网站')
  })
})
