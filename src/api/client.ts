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

/**
 * 前端主动抛出的**面向用户**的校验错误（非 HTTP 错误）。
 *
 * 存在理由：`errorText` 出于「不把内部报错甩给用户」的纪律，对普通 Error 一律
 * 兜底成「请求失败，请稍后重试」。于是视图里的 `throw new Error('域名格式不正确…')`
 * 这类**已经写好的人话文案会被静默吞掉**，用户只看到一句无信息量的兜底——
 * 不知道错在哪，只能反复点保存。用本类显式标记后，`errorText` 原样透出 message，
 * 同时运行时异常（TypeError 等）仍走兜底，不会泄露技术细节。
 */
export class ValidationError extends Error {}

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

/** 请求超时（毫秒）。调用方自带 signal 时优先级更高，不挂超时。 */
const REQUEST_TIMEOUT_MS = 15_000
/** 限流/瞬时失败的最大重试次数（含首次，即最多额外 2 次）。 */
const MAX_ATTEMPTS = 3

function delay(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }
/** 指数退避：500ms → 1s → 2s，封顶 8s。 */
function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1))
}

async function request<T>(url: string, opts: Options = {}): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase()
  const headers = new Headers(opts.headers)
  headers.set('Accept', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') {
    // Content-Type 已由调用方设置（如 putRaw 的 octet-stream）则不覆盖
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const csrf = readCookie('panel_csrf')
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }

  const target = buildUrl(url, opts.params)
  // 幂等方法（GET/HEAD/PUT/DELETE）在网络抖动时可安全重试；POST 可能重复提交，不重试。
  const idempotent = method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE'

  let attempt = 0
  while (true) {
    attempt++
    let res: Response
    try {
      const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      res = await fetch(target, { ...opts, headers, credentials: 'same-origin', signal })
    } catch (e) {
      // 调用方主动取消（AbortError 且自带 signal）：原样透传，不重试
      if (e instanceof DOMException && e.name === 'AbortError' && opts.signal) {
        throw new ApiError(0, 0, 'request_cancelled')
      }
      // 仅幂等方法在网络/超时失败时重试，避免写操作被重复提交
      if (idempotent && attempt < MAX_ATTEMPTS) { await delay(backoff(attempt)); continue }
      throw new ApiError(80003, 0, '请求超时或网络不可达，请稍后重试')
    }

    if (res.status === 204) return undefined as T

    let body: { code?: number; message?: string; data?: T; detail?: unknown } = {}
    const text = await res.text()
    if (text) {
      try { body = JSON.parse(text) } catch { /* 非 JSON（如 SSE/HTML） */ }
    }

    // 限流（429）：服务端尚未处理请求，重试安全；按 retry_after 退避（封顶 5s）。
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const ra = (body.detail as { retry_after_secs?: number } | undefined)?.retry_after_secs ?? 1
      await delay(Math.min(ra, 5) * 1000)
      continue
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
}

export const api = {
  get: <T>(u: string, o?: Options) => request<T>(u, { ...o, method: 'GET' }),
  post: <T>(u: string, body?: unknown, o?: Options) =>
    request<T>(u, { ...o, method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(u: string, body?: unknown, o?: Options) =>
    request<T>(u, { ...o, method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  /** 原始字节上传（octet-stream）：body 原样发送，不 JSON 序列化；仍带 CSRF 与统一错误处理 */
  putRaw: <T>(u: string, body: BodyInit, o?: Options) =>
    request<T>(u, { ...o, method: 'PUT', body, headers: new Headers(o?.headers) }),
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

/**
 * 后端 400 的**字段级**校验信息（`detail = { field, reason }`，见 panel-api 的
 * `ApiError::bad_request`）。
 *
 * 存在的理由：后端已经把"错在哪个字段"告诉了我们（`domains` / `name` /
 * `upstreams` / `fpm` / `redirect_target` / `waf.*`…），若把它压成一句笼统的
 * 「保存失败」堆在弹窗底部，用户得自己逐个输入框猜哪儿填错了。取出来后可以
 * 精确落到对应表单项旁边——"域名错就提示在域名处"。
 */
export function errorFieldDetail(e: unknown): { field: string; reason: string } | null {
  if (!(e instanceof ApiError)) return null
  const d = e.detail as { field?: unknown; reason?: unknown } | undefined
  if (!d || typeof d.field !== 'string') return null
  return { field: d.field, reason: typeof d.reason === 'string' ? d.reason : '' }
}

/** 人类可读的错误文案（按错误码分段，避免把英文原文直接丢给用户） */
export function errorText(e: unknown): string {
  // 视图主动抛的校验文案（ValidationError）**原样透出**：它就是写给用户看的，
  // 吞掉等于让用户面对一句「请求失败」反复点保存却不知错在哪。
  if (e instanceof ValidationError) return e.message || '提交内容有误，请检查后重试'
  // 其余非 HTTP 异常（多为运行时 TypeError 等）仍走兜底，不把技术细节泄露给用户。
  if (!(e instanceof ApiError)) return '请求失败，请稍后重试'
  const seg = Math.floor(e.code / 10000)
  switch (e.code) {
    case 10002: return '登录已过期，请重新登录'
    case 10003: return '权限不足，请联系管理员'
    case 10006: return `操作过于频繁，请 ${(e.detail as { retry_after_secs?: number })?.retry_after_secs ?? 60} 秒后再试`
    case 10007: return '面板处于只读模式，无法执行写操作'
    case 10008: return '页面已过期，请刷新后重试'
    case 10011: return '引导令牌无效或已过期，请在服务器终端重启 panel serve 重新获取'
    // 10009 = 能力未接入（后端 `ApiError::unsupported`）。它的 message 是**内部能力键名**
    // （如 `firewall.manage`），直接回显等于把内部标识甩给用户——站点/服务/专业快照三页
    // 各自用 isUnsupported 给过具体文案，其余视图没有，于是用户看到的就是 `firewall.manage`
    // 这种不知所云的字符串。补一条通用兜底，全项目一次生效；需要更具体说法的视图仍可
    // 用 isUnsupported 在自己的 catch 里覆盖。
    case 10009: return '当前环境未接入该能力（缺少依赖或后端未实装）'
    // 10005 = 冲突（重名等）。后端 message 是内部英文串（如 "conflict: site name exists"），
    // 直接透出等于把内部报错甩给用户——给一句中文，别让用户去猜英文。
    case 10005: return '已有同名资源，请换一个名称'
    case 40002: return '配置校验未通过，已自动回滚'
    case 50001: return '路径超出允许范围'
    case 80003: return '操作超时'
    default:
      if (seg === 5) return '文件操作失败'
      if (seg === 6) return '数据库操作失败'
      if (seg === 7) return '防火墙操作失败'
      // 10001 = 参数校验失败。后端在 `detail.reason` 里写的是**给人看的中文原因**
      // （"尚未配置 API Endpoint，无法测试"、"未知步骤 id `nope`"…），此前一律丢掉
      // 换成一句通用「提交内容有误」——用户知道错了，却不知道错在哪，只能反复试。
      // 有中文 reason 就透出；仍是英文内部串才回落到通用文案（与下面 message 的
      // 纪律一致：不把内部英文甩给用户）。
      if (e.code === 10001) {
        const r = (e.detail as { reason?: unknown } | undefined)?.reason
        return typeof r === 'string' && /[\u4e00-\u9fff]/.test(r)
          ? r
          : '提交内容有误，请检查后重试'
      }
      // 后端 message 多为内部英文（如 "invalid input" / "not found"）——不甩给用户；
      // 已是中文的后端文案（部分校验原因）则原样透出，保住"具体"这一价值。
      return /[\u4e00-\u9fff]/.test(e.message) ? e.message : '请求失败，请稍后重试'
  }
}
