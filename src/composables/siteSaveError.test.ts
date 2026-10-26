import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveSaveError } from './siteSaveError'
import { ApiError } from '@/api/client'
import { BACKEND_FIELD } from './useSiteForm'

/** 后端「字段级校验失败」错误的夹具：code 10001 + detail.field/detail.reason。 */
function fieldErr(field: string, reason: string) {
  return new ApiError(10001, 400, 'invalid input', { field, reason })
}

/**
 * 这张决策表决定「保存失败后红字出现在哪儿」。
 *
 * 它此前住在 `SiteFormDialog.vue` 的 `mapSaveError()` 里、直接操作三个 ref，
 * 因此**一行都测不到**（vitest 无 vue 插件，读不了 `.vue`）。抽成纯函数后
 * 四种分支可以穷举——而这四种分支的代价各不相同：
 *  - 映射漏了 ⇒ 用户只看到"提交内容有误"，后端辛苦给出的原因被丢掉
 *  - 50001 落错字段 ⇒ 红字出现在无关输入框旁，用户改哪儿都不对
 *  - 该挂字段却挂成通用条 ⇒ 用户要自己猜是哪一项错了
 */
describe('resolveSaveError', () => {
  it('后端指名了已知字段 → 挂到对应表单字段，且用后端的中文 reason', () => {
    // 注意：后端用下划线/点号（redirect_target），表单用驼峰（redirectTarget）——
    // 映射由 BACKEND_FIELD 承担，这条断言钉住"跨命名风格"这一层不能坏。
    expect(resolveSaveError(fieldErr('redirect_target', '必须是 http(s) 开头'))).toEqual({
      kind: 'field',
      key: 'redirectTarget',
      message: '必须是 http(s) 开头',
    })
  })

  it('后端字段名含点号（waf.rate_per_sec）也能映射到 wafRate', () => {
    expect(resolveSaveError(fieldErr('waf.rate_per_sec', '限速不能为负'))).toEqual({
      kind: 'field', key: 'wafRate', message: '限速不能为负',
    })
  })

  it('reason 不是中文 → 用前端兜底文案（不把英文原文甩给用户）', () => {
    // fieldMsg 的职责：reason 含中文才透出，否则用 fallback。
    // 用 upstreams 验证，fallback 是「后端地址不合法」。
    expect(resolveSaveError(fieldErr('upstreams', 'invalid url'))).toEqual({
      kind: 'field', key: 'upstreams', message: '后端地址不合法',
    })
  })

  it('后端指名了字段但我们没有对应输入框 → 退回通用条，且**保留**后端 reason', () => {
    // 关键：不能因为映射缺失就把后端的说明丢掉（那是最具体的信息）
    const r = resolveSaveError(fieldErr('some_future_field', '该字段暂不支持'))
    expect(r.kind).toBe('form')
    expect(r.message).toBe('该字段暂不支持')
  })

  it('映射缺失且 reason 非中文 → 通用条用兜底文案', () => {
    const r = resolveSaveError(fieldErr('some_future_field', 'boom'))
    expect(r).toEqual({ kind: 'form', message: '提交内容有误，请检查后重试' })
  })

  it('50001（路径越界）→ 落 root 字段，因为它是本表单唯一的路径输入', () => {
    const r = resolveSaveError(new ApiError(50001, 400, 'path escapes site root'))
    expect(r.kind).toBe('field')
    expect(r.kind === 'field' && r.key).toBe('root')
  })

  it('普通网络错误 → 通用条，文案来自 errorText 的兜底', () => {
    expect(resolveSaveError(new TypeError('fetch failed'))).toEqual({
      kind: 'form', message: '请求失败，请稍后重试',
    })
  })

  it('null / undefined 也不会抛（保存链路上游可能传空）', () => {
    expect(resolveSaveError(null).kind).toBe('form')
    expect(resolveSaveError(undefined).kind).toBe('form')
  })

  /**
   * 反向守卫：BACKEND_FIELD 里每条映射的 `key` 必须**真的存在于模板的 data-f**。
   *
   * ⚠ 这条曾经写成"拿 BACKEND_FIELD 的值和自己比"，于是它恒绿——把 key 改成
   * `custom_conf_typo`（模板里根本没有这个字段）测试照样全过。判据指向了错误的
   * 那一份（表自身），而不是被检查的那一份（模板）。
   * 现在直接读 `.vue` 源码取 `data-f="..."` 集合：加了映射却拼错 key，这里真红。
   *
   * 为什么这条值得存在：key 拼错在运行时**没有任何报错**，表现只是"红字不出现"，
   * 用户看到保存失败却看不到原因。vue-tsc 也管不到——key 是 string。
   */
  it('BACKEND_FIELD 每个 key 都真实存在于模板的 data-f（防拼错后红字静默不显示）', () => {
    const src = readFileSync(
      new URL('../components/SiteFormDialog.vue', import.meta.url), 'utf8')
    const present = new Set(
      [...src.matchAll(/data-f="([A-Za-z]+)"/g)].map(m => m[1]))
    expect(present.size, '模板里一个 data-f 都没读到，说明正则或路径坏了').toBeGreaterThan(5)
    for (const [backendField, spec] of Object.entries(BACKEND_FIELD)) {
      expect(present, `BACKEND_FIELD['${backendField}'].key='${spec.key}' 在模板里没有对应 data-f`).toContain(spec.key)
    }
  })
})
