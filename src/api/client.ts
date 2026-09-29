/**
 * HTTP 客户端。
 *
 * 三条纪律：
 * 1. 统一错误码映射（后端 §3.4 分段：10xxx 通用 / 5xxxx 文件 ...）。
 * 2. 401 自动跳登录；403 提示权限不足；10008 提示 CSRF 失效并刷新 token。
 * 3. 写请求自动附加 X-CSRF-Token（从**可读** Cookie panel_csrf 读取）。
 */

export const API_VERSION = '1.0'

export class ApiError extends Error {
  code: number
  status: number
  detail?: unknown
  constructor(code: number, status: number, message: string, detail?: unknown) {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}

type Options = RequestInit & { skipAuthRedirect?: boolean; params?: QueryParams }

/** 查询参数：只接受标量，避免把对象/数组悄悄序列化成意外格式 */
type QueryValue = string | number | boolean | undefined | null
type QueryParams = Record<string, QueryValue>

function buildUrl(u: string, params?: QueryParams): string {
  if (!params) return u
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    // 显式跳过 undefined/null：不发送空参数，避免后端把 "undefined" 当真值
    if (v === undefined || v === null || v === '') continue
    usp.set(k, String(v))
  }
  const qs = usp.toString()
  return qs ? `${u}${u.includes('?') ? '&' : '?'}${qs}` : u
}

async function request<T>(url: string, opts: Options = {}): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase()
  const headers = new Headers(opts.headers)
  headers.set('Accept', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('Content-Type', 'application/json')
    const csrf = readCookie('panel_csrf')
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }

  const target = buildUrl(url, opts.params)

  let res: Response
  try {
    res = await fetch(target, { ...opts, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 0, 'network_unreachable')
  }

  if (res.status === 204) return undefined as T

  let body: { code?: number; message?: string; data?: T; detail?: unknown } = {}
  const text = await res.text()
  if (text) {
    try { body = JSON.parse(text) } catch { /* 非 JSON（如 SSE/HTML） */ }
  }

  if (!res.ok) {
    const err = new ApiError(body.code ?? res.status, res.status, body.message ?? res.statusText, body.detail)
    if (res.status === 401 && !opts.skipAuthRedirect) {
      window.dispatchEvent(new CustomEvent('panel:unauthorized'))
    }
    if (body.code === 10008) {
      window.dispatchEvent(new CustomEvent('panel:csrf-expired'))
    }
    throw err
  }
  return body.data as T
}

export const api = {
  get: <T>(u: string, o?: Options) => request<T>(u, { ...o, method: 'GET' }),
  post: <T>(u: string, body?: unknown, o?: Options) =>
    request<T>(u, { ...o, method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(u: string, body?: unknown, o?: Options) =>
    request<T>(u, { ...o, method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(u: string, body?: unknown, o?: Options) =>
    request<T>(u, { ...o, method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(u: string, o?: Options) => request<T>(u, { ...o, method: 'DELETE' }),
}

/**
 * 判断错误是否为"功能尚未接入"（后端返回 501 / code 10009）。
 * 用于把占位端点的原始报错降级为友好的"功能即将推出"提示，
 * 而不是把 `process.list (M2: …)` 这种内部文案甩给用户。
 */
export function isUnsupported(e: unknown): boolean {
  return e instanceof ApiError && e.code === 10009
}

/** 人类可读的错误文案（按错误码分段，避免把英文原文直接丢给用户） */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return '请求失败，请稍后重试'
  const seg = Math.floor(e.code / 10000)
  switch (e.code) {
    case 10002: return '登录已过期，请重新登录'
    case 10003: return '权限不足，请联系管理员'
    case 10006: return `操作过于频繁，请 ${(e.detail as { retry_after_secs?: number })?.retry_after_secs ?? 60} 秒后再试`
    case 10007: return '面板处于只读模式，无法执行写操作'
    case 10008: return '页面已过期，请刷新后重试'
    case 10011: return '引导令牌无效或已过期，请在服务器终端重启 panel serve 重新获取'
    case 40002: return '配置校验未通过，已自动回滚'
    case 50001: return '路径超出允许范围'
    case 80003: return '操作超时'
    default:
      if (seg === 5) return '文件操作失败'
      if (seg === 6) return '数据库操作失败'
      if (seg === 7) return '防火墙操作失败'
      return e.message || '请求失败'
  }
}
