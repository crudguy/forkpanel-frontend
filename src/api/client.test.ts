import { describe, it, expect, afterEach } from 'vitest'
import { api, ApiError, ValidationError, errorText, isUnsupported, errorFieldDetail } from './client'
import { API } from './endpoints'

/**
 * `errorText` 是**所有错误文案流向用户的唯一闸门**——它出错的表现不是崩溃，而是
 * 用户看到一句 `firewall.manage` 或 "invalid input" 这种不知所云的内部串。
 * 分支多（错误码映射 + 分段兜底 + 中文判定），此前零覆盖，这里逐条钉死。
 */
describe('errorText', () => {
  it('ValidationError 原样透出：视图写的人话文案不能被兜底吞掉', () => {
    // 吞掉它的后果是用户只看到「请求失败」，不知错在哪，只能反复点保存
    expect(errorText(new ValidationError('域名格式不正确，请填写合法域名'))).toBe('域名格式不正确，请填写合法域名')
    // 空 message 仍要有话说，不能渲染成空白
    expect(errorText(new ValidationError(''))).toBe('提交内容有误，请检查后重试')
  })

  it('非 HTTP 异常（TypeError 等）走兜底，不泄露技术细节', () => {
    expect(errorText(new TypeError('Cannot read properties of undefined'))).toBe('请求失败，请稍后重试')
    expect(errorText('boom')).toBe('请求失败，请稍后重试')
    expect(errorText(null)).toBe('请求失败，请稍后重试')
  })

  it('已知错误码给出中文文案，而不是后端英文原文', () => {
    expect(errorText(new ApiError(10002, 401, 'unauthorized'))).toBe('登录已过期，请重新登录')
    expect(errorText(new ApiError(10003, 403, 'forbidden'))).toBe('权限不足，请联系管理员')
    expect(errorText(new ApiError(10007, 403, 'read only'))).toBe('面板处于只读模式，无法执行写操作')
    expect(errorText(new ApiError(10008, 403, 'csrf'))).toBe('页面已过期，请刷新后重试')
    expect(errorText(new ApiError(10009, 501, 'firewall.manage'))).toBe('当前环境未接入该能力（缺少依赖或后端未实装）')
    expect(errorText(new ApiError(10005, 409, 'conflict: site name exists'))).toBe('已有同名资源，请换一个名称')
    expect(errorText(new ApiError(40002, 400, 'validate failed'))).toBe('配置校验未通过，已自动回滚')
    expect(errorText(new ApiError(50001, 400, 'path escape'))).toBe('路径超出允许范围')
    expect(errorText(new ApiError(80003, 0, 'timeout'))).toBe('操作超时')
  })

  it('10006 限流透出后端给的 retry_after_secs（没有则 60）', () => {
    const withSecs = new ApiError(10006, 429, 'rate limited', { retry_after_secs: 12 })
    expect(errorText(withSecs)).toBe('操作过于频繁，请 12 秒后再试')
    expect(errorText(new ApiError(10006, 429, 'rate limited'))).toBe('操作过于频繁，请 60 秒后再试')
  })

  it('10001 参数校验：有中文 reason 就透出，英文内部串才回落通用文案', () => {
    // 后端在 detail.reason 里写的是给人看的中文；压成一句「提交内容有误」等于
    // 让用户逐个输入框猜哪儿错了。
    const cn = new ApiError(10001, 400, 'bad request', { reason: '尚未配置 API Endpoint，无法测试' })
    expect(errorText(cn)).toBe('尚未配置 API Endpoint，无法测试')
    const en = new ApiError(10001, 400, 'bad request', { reason: 'missing endpoint' })
    expect(errorText(en)).toBe('提交内容有误，请检查后重试')
    expect(errorText(new ApiError(10001, 400, 'bad request'))).toBe('提交内容有误，请检查后重试')
  })

  it('分段兜底：5xxxx/6xxxx/7xxxx 给出大类说法', () => {
    expect(errorText(new ApiError(50010, 500, 'io error'))).toBe('文件操作失败')
    expect(errorText(new ApiError(60010, 500, 'db error'))).toBe('数据库操作失败')
    expect(errorText(new ApiError(70010, 500, 'nft error'))).toBe('防火墙操作失败')
  })

  it('未知码：后端 message 含中文则透出，纯英文则兜底', () => {
    expect(errorText(new ApiError(99999, 500, '磁盘空间不足'))).toBe('磁盘空间不足')
    expect(errorText(new ApiError(99999, 500, 'internal server error'))).toBe('请求失败，请稍后重试')
  })
})

describe('isUnsupported', () => {
  it('只认 code 10009，其它一律不算「能力未接入」', () => {
    expect(isUnsupported(new ApiError(10009, 501, 'firewall.manage'))).toBe(true)
    expect(isUnsupported(new ApiError(10003, 403, 'forbidden'))).toBe(false)
    // ⚠ 501 状态码本身不算——后端有「诚实 501」但 code 不是 10009 的情况
    expect(isUnsupported(new ApiError(10001, 501, 'bad request'))).toBe(false)
    expect(isUnsupported(new Error('10009'))).toBe(false)
    expect(isUnsupported(null)).toBe(false)
  })
})

describe('errorFieldDetail', () => {
  it('取出后端字段级校验信息，用于把错误精确落到对应输入框旁', () => {
    expect(errorFieldDetail(new ApiError(10001, 400, 'bad', { field: 'domains', reason: '域名格式不正确' })))
      .toEqual({ field: 'domains', reason: '域名格式不正确' })
  })

  it('缺失 / 类型不对时返回 null（调用方据此回落到整表单错误位）', () => {
    expect(errorFieldDetail(new ApiError(10001, 400, 'bad', { reason: 'x' }))).toBeNull()
    expect(errorFieldDetail(new ApiError(10001, 400, 'bad', { field: 123 }))).toBeNull()
    expect(errorFieldDetail(new ApiError(10001, 400, 'bad'))).toBeNull()
    expect(errorFieldDetail(new Error('x'))).toBeNull()
    // reason 非字符串时仍给出 field，reason 置空——不让调用方拿到 undefined
    expect(errorFieldDetail(new ApiError(10001, 400, 'bad', { field: 'name', reason: 42 })))
      .toEqual({ field: 'name', reason: '' })
  })
})


/**
 * `api.download` 的存在理由：CSV 导出不能走 `request()`（它强制
 * `Accept: application/json` 并把响应体当 JSON 解析，CSV 会被解析成
 * undefined ——「下载成功但文件是空的」静默故障），也不能走
 * `window.open`（拿不到 4xx 响应体，后端那句可执行建议就白写了）。
 *
 * 这两条各自对应下面一条用例；第三条钉的是**最容易写漏的一环**：
 * 错误必须把 `detail` 一起带出来，否则 `errorText` 对 10001 只读
 * `detail.reason`，用户看到的是「提交内容有误」而不是「请加 WHERE」。
 */
describe('api.download', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('200 → 返回 Blob，且 Accept 是 text/csv 而非 application/json', async () => {
    let seenAccept = '(unset)'
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      seenAccept = new Headers(init?.headers).get('Accept') ?? '(unset)'
      return new Response('id,name\r\n1,张三\r\n', {
        status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' },
      })
    }) as typeof fetch

    // 走真实端点构造器而非字面量：源码里不落 /api/v1/ 字面量——那会让
    // ci/check-api-contract.sh 的 [A] 把测试 URL 当成真实调用路径去后端
    // 路由里逐字比对（带实参的具体路径当然不在路由表里），恒红。
    // 测试不是调用点；顺带把「exportCsv 拼路径 + download」这个组合
    // 也钉住：拼错段数/漏 encode 在这里就红，不等运行期 404。
    const blob = await api.download(API.db.exportCsv(1, 'woaiyoulin', 'app_user'))
    expect(await blob.text()).toContain('id,name')
    expect(seenAccept).toBe('text/csv,*/*')
  })

  it('4xx → 抛 ApiError，且后端 detail.reason 的中文文案能到达 errorText', async () => {
    // 复刻后端 ApiError::bad_request 的真实形状：文案在 detail.reason，不在 message
    const body = JSON.stringify({
      code: 10001,
      message: 'invalid input',
      detail: { field: 'table', reason: '「big」超过 20000 行，已拒绝导出：请用 SQL 控制台加 WHERE 条件收窄后重试' },
    })
    globalThis.fetch = (async () => new Response(body, {
      status: 400, headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    const e = await api.download('/x').catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(errorText(e)).toContain('请用 SQL 控制台加 WHERE')
  })

  it('非 JSON 错误体 → 回落 statusText，不炸', async () => {
    globalThis.fetch = (async () => new Response('<html>502</html>', { status: 502 })) as typeof fetch
    const e = await api.download('/x').catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(errorText(e)).toBe('请求失败，请稍后重试')
  })
})
