/**
 * 全局浮层提示（toast）。
 *
 * 为什么需要它：此前的成功提示是**写进文档流的** `.notice` 段落
 * （`<p class="notice">`）。它插进页面就把下方内容整体下推——每保存一次页面
 * 就抖一下，用户看到的是"结构不稳"。toast 用 `position: fixed` 脱离文档流，
 * 出现与消失都不影响任何元素的布局。
 *
 * 设计：模块级单例队列（不挂 store，也不依赖组件实例），任何模块
 * `import { toast } from '@/composables/useToast'` 即可调用。队列上限 3 条，
 * 超出丢最旧，避免连点堆积把屏幕糊满。
 */
import { reactive } from 'vue'

/**
 * 四态。**取值到此为止，不要再自造 kind**——每加一种就要给一种新配色/图标，
 * 结果是同一个语义在不同页面长得不一样：
 *   ok 成功（绿 · check）｜err 失败（红 · alert-circle）
 *   warn 警告（黄 · alert）｜info 中性提示（主色 · info）
 */
export type ToastKind = 'ok' | 'err' | 'warn' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

/**
 * 自动消失时长（ms）。按**需要阅读的信息量**分级，而不是一刀切：
 * 失败要说清原因、用户倾向停下来读；成功只是确认，短一点更利落。
 */
const TTL: Record<ToastKind, number> = { ok: 3200, info: 3600, warn: 4500, err: 5000 }
/** 同时最多显示几条；超出丢最旧。 */
const MAX = 3

const items = reactive<ToastItem[]>([])
let seq = 0

/**
 * 弹一条提示。
 *
 * @param text 文案（面向用户的完整句子，不带标点收尾也可）
 * @param kind 语义：ok 成功 / err 失败 / warn 警告 / info 中性提示
 * @returns 该条的 id，可用于提前 dismiss
 */
export function toast(text: string, kind: ToastKind = 'ok'): number {
  const id = ++seq
  items.push({ id, kind, text })
  while (items.length > MAX) items.shift()
  window.setTimeout(() => dismiss(id), TTL[kind])
  return id
}

/** 手动关闭（用户点击 toast 时调用）。 */
export function dismiss(id: number): void {
  const i = items.findIndex((t) => t.id === id)
  if (i >= 0) items.splice(i, 1)
}

/** 供 ToastHost 渲染用的只读视图。 */
export function useToasts(): readonly ToastItem[] {
  return items
}
