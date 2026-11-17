/**
 * AI 助手「解释当前页」上下文（顶栏重复入口移除后改为路由层自动注入）。
 *
 * 从任意页面进入 /assistant 时把来源页标题写进 ?ctx=，AssistantView 据此显示
 * 「解释这个页面」快捷提问。原先只有顶栏胶囊传 ctx；入口删掉后若不补这一步，
 * 侧边栏这条唯一入口会连「解释上一页」的能力一起丢掉。
 *
 * 决策逻辑抽成纯函数：单测直接覆盖「来源页 / 助手自身 / 已带 ctx / 超长截断」
 * 四条边界，避免守卫写错后只能靠肉眼读模板发现（源码断言恒绿的典型坑）。
 */
import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router'

/** ctx 最大长度：与页面标题同量级，挡住任意链接注入超长文本 / 指令前缀 */
export const ASSISTANT_CTX_MAX = 40

const ASSISTANT_TITLE = 'AI 助手'

/** 任意输入 → 可用 ctx：非字符串 / 空 / 助手自身 → 空；超长截断 */
export function pageContextTitle(title: unknown): string {
  if (typeof title !== 'string') return ''
  const t = title.trim()
  if (!t || t === ASSISTANT_TITLE) return ''
  return t.slice(0, ASSISTANT_CTX_MAX)
}

/** 守卫只需这几个字段；结构类型便于单测直接构造，不必拽整个 router */
type CtxRoute = Pick<RouteLocationNormalized, 'name' | 'query' | 'hash' | 'meta'>

/**
 * 进入 /assistant 且尚未带 ctx 时，返回带来源页 ctx 的重定向 location。
 *
 * ⚠ `to.query.ctx` 必须先查：守卫返回 location 会触发新导航并**重跑整个
 * beforeEach 链**，不检查就会无限重定向（表现为路由永不就绪）。
 * 返回 null 表示无需注入，交调用方正常放行。
 */
export function withAssistantContext(to: CtxRoute, from: CtxRoute): RouteLocationRaw | null {
  if (to.name !== 'assistant') return null
  if (typeof to.query.ctx === 'string' && to.query.ctx) return null
  const ctx = pageContextTitle(from.meta.title)
  if (!ctx) return null
  return { name: 'assistant', query: { ...to.query, ctx }, hash: to.hash }
}
