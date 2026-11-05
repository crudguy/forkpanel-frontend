/**
 * 组件行为测试的 API 假件（Q-06 前置物）。
 *
 * 为什么在 fetch 层拦：生产链路是 `组件 → api.get/post → request → fetch`，
 * 在 fetch 层挡住才能连 `{data}` 解包、CSRF 头、错误映射一起验；直接 mock `api`
 * 会把最容易写错的那一层整段跳过。
 *
 * 两条防恒绿纪律：
 * - 路由 key 一律用 `API.*()` 生成。写 `'/api/v1/...'` 字面量会被
 *   `ci/check-api-contract.sh` 当成真实调用（它扫 `*.test.ts` 与 src 下的字面量）。
 * - **未登记的请求不静默返回空**：记入 `unexpected` 并回 500，测试末尾用
 *   `assertClean()` 断言。否则组件拿到 undefined、渲染空、断言恰好"看不见"
 *   也会绿——假件最常见的恒绿来源就是"没拦到的请求悄悄返回了空"。
 */
import { vi } from 'vitest'

export interface FakeCall {
  url: string
  method: string
  body: unknown
}

/**
 * ⚠ 不能写成 `unknown | ((ctx: FakeCall) => unknown)`：`unknown` 是顶类型，
 *   会把整个联合吸收掉，函数式路由的参数随之失去上下文类型——vitest 照跑不误
 *   （它不做类型检查），但 `vue-tsc --noEmit` 会报 TS7031 隐式 any。
 *   用 `object` 兜住任意响应体（interface 也能赋值，不像 `Record<string, unknown>`
 *   会要求索引签名），联合里只留一个调用签名，参数就能推断成 `FakeCall`。
 */
export type FakeRoute =
  | ((ctx: FakeCall) => unknown)
  | object
  | string
  | number
  | boolean
  | null
  | undefined

/**
 * 让假件回一个**非 2xx** 响应，用于验证组件的失败分支。
 *
 * 为什么需要：只回 200 的假件测不到 `catch` —— 而本轮要验的恰好是
 * "脚本失败时 stdout/stderr 必须落进 `<pre>`"。让路由函数抛异常也能触发
 * catch，但那条路走的是 `request()` 的网络错误兜底（`ApiError(80003)` →
 * 「操作超时」），文案与后端真实错误无关；GET 还会因幂等重试拖慢用例。
 * 直接构造 `!res.ok` 才能连错误码映射、中文 message 透出一起验到。
 *
 * ⚠ code 别选 5xxxx/6xxxx/7xxxx 段：`errorText` 会把它们压成
 * 「文件/数据库/防火墙操作失败」，脚本原文就丢了（生产后端也不会用这些段）。
 */
export interface FakeErrorResponse {
  __fakeError: true
  status: number
  body: { code: number; message: string; detail?: unknown }
}

export function fakeError(
  status: number,
  code: number,
  message: string,
  detail?: unknown,
): FakeErrorResponse {
  return { __fakeError: true, status, body: { code, message, detail } }
}

function isFakeError(v: unknown): v is FakeErrorResponse {
  return typeof v === 'object' && v !== null
    && (v as { __fakeError?: unknown }).__fakeError === true
}

export interface ApiFake {
  calls: FakeCall[]
  /** 未登记请求（必须为空） */
  unexpected: string[]
  count(url: string, method?: string): number
  lastBody(url: string, method?: string): unknown
  assertClean(): void
  restore(): void
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function installApiFake(routes: Record<string, FakeRoute>): ApiFake {
  const calls: FakeCall[] = []
  const unexpected: string[] = []
  const keys = Object.keys(routes)
  const originalFetch = globalThis.fetch

  // 精确优先：'/db/1' 与 '/db/1/sql-meta' 同时登记时不能让短的那个先吃掉。
  const match = (path: string): string | undefined =>
    keys.find((k) => path === k) ?? keys.find((k) => path.startsWith(`${k}/`))

  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    calls.push({ url, method, body })

    const key = match(url.split('?')[0])
    if (key === undefined) {
      unexpected.push(`${method} ${url}`)
      return json({ code: 599, message: `API 假件未登记：${method} ${url}` }, 500)
    }
    const route = routes[key]
    const data = typeof route === 'function'
      ? (route as (ctx: FakeCall) => unknown)({ url, method, body })
      : route
    if (isFakeError(data)) return json(data.body, data.status)
    return json({ data }, 200)
  }

  vi.stubGlobal('fetch', fake)

  const callsTo = (url: string, method?: string) =>
    calls.filter((c) => (method === undefined || c.method === method)
      && (c.url === url || c.url.startsWith(`${url}?`)))

  return {
    calls,
    unexpected,
    count: (url, method) => callsTo(url, method).length,
    lastBody: (url, method) => {
      const hit = callsTo(url, method)
      return hit.length ? hit[hit.length - 1].body : undefined
    },
    assertClean: () => {
      if (unexpected.length > 0) {
        throw new Error(`API 假件收到 ${unexpected.length} 个未登记请求：\n  ${unexpected.join('\n  ')}`)
      }
    },
    restore: () => vi.stubGlobal('fetch', originalFetch),
  }
}
