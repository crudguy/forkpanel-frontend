// @vitest-environment jsdom
/**
 * API 假件自身的行为测试。
 *
 * 假件是所有 Q-06 组件行为测试的地基：它一旦"未登记也返回空"或"restore 不干净"，
 * 上层的组件断言就会成片假绿。所以先把它自己钉住。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { api, ApiError, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { installApiFake, fakeError, type ApiFake } from './apiFake'

let fake: ApiFake | null = null
afterEach(() => { fake?.restore(); fake = null })

describe('API 假件', () => {
  it('按 API.*() 路径返回 {data}，api.get 拿到解包后的值', async () => {
    fake = installApiFake({ [API.db.connections()]: [{ id: 1, name: 'main' }] })
    const r = await api.get<{ id: number; name: string }[]>(API.db.connections())
    expect(r).toEqual([{ id: 1, name: 'main' }])
    expect(fake.count(API.db.connections())).toBe(1)
    fake.assertClean()
  })

  it('未登记请求记入 unexpected、回 500，assertClean 响亮失败', async () => {
    fake = installApiFake({})
    await expect(api.get(API.db.connections())).rejects.toBeDefined()
    expect(fake.unexpected).toHaveLength(1)
    expect(() => fake!.assertClean()).toThrow(/未登记/)
  })

  it('写请求能取到 POST body（二次确认断言依赖它）', async () => {
    fake = installApiFake({ [API.system.expose.apply()]: { ok: true } })
    await api.post(API.system.expose.apply(), { domain: 'panel.example.com' })
    expect(fake.lastBody(API.system.expose.apply(), 'POST')).toEqual({ domain: 'panel.example.com' })
    fake.assertClean()
  })

  it('函数式路由能按请求方法动态回', async () => {
    fake = installApiFake({
      [API.db.connections()]: ({ method }) => (method === 'GET' ? ['get'] : ['post']),
    })
    expect(await api.get(API.db.connections())).toEqual(['get'])
    expect(await api.post(API.db.connections(), {})).toEqual(['post'])
  })

  it('带 query 的 URL 仍能命中登记路径', async () => {
    fake = installApiFake({ [API.db.connections()]: 7 })
    const r = await api.get<number>(API.db.connections(), { params: { page: 2 } })
    expect(r).toBe(7)
    fake.assertClean()
  })

  it('精确路径优先于前缀路径', async () => {
    fake = installApiFake({
      [API.db.connections()]: 'short',
      [`${API.db.connections()}/x`]: 'long',
    })
    expect(await api.get(API.db.connections())).toBe('short')
    expect(await api.get(`${API.db.connections()}/x`)).toBe('long')
  })

  it('fakeError 回非 2xx，errorText 能透出后端中文原文（脚本失败分支依赖）', async () => {
    const msg = 'expose-public.sh: nginx 配置校验失败（第 3 行）'
    fake = installApiFake({ [API.system.expose.apply()]: fakeError(500, 10901, msg) })
    let caught: unknown
    try { await api.post(API.system.expose.apply(), { domain: 'panel.example.com' }) }
    catch (e) { caught = e }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).status).toBe(500)
    expect(errorText(caught)).toBe(msg)
    fake.assertClean()
  })

  it('函数式路由可按方法分别回成功 / 失败（同一路径 GET 与 POST 不串）', async () => {
    const msg = '撤销失败：nginx 反代配置不存在'
    fake = installApiFake({
      [API.system.expose.status()]: ({ method }) =>
        method === 'GET' ? { exposed: false } : fakeError(500, 10901, msg),
    })
    expect(await api.get(API.system.expose.status())).toEqual({ exposed: false })
    await expect(api.post(API.system.expose.status(), {})).rejects.toBeDefined()
    fake.assertClean()
  })

  it('restore 后 fetch 回到原值（不污染后续用例）', () => {
    const before = globalThis.fetch
    fake = installApiFake({})
    expect(globalThis.fetch).not.toBe(before)
    fake.restore()
    expect(globalThis.fetch).toBe(before)
    fake = null
  })
})
