import { describe, it, expect } from 'vitest'
import {
  APP_TEMPLATES,
  applyBody,
  confSpecNow,
  emptyForm,
  fieldMsg,
  rowToRoute,
  wafPayload,
  type SiteForm,
} from './useSiteForm'

/**
 * 站点表单 → apply 载荷的行为约定。
 *
 * 这组用例是 `SitesView.vue` 拆分的**安全网**：`SitesView` 里那些与后端严格对齐的
 * 语义此前只有注释写着（注释 drift 了没人知道），搬进 `useSiteForm` 后有了可执行
 * 的定义。每一条都对应后端 `panel-api/routes/sites.rs` 的一条真实约束。
 */
function form(): SiteForm {
  const f = emptyForm()
  f.name = 'demo'
  f.domains = 'demo.com'
  return f
}

describe('emptyForm', () => {
  it('新建默认给一条 / static 兜底路由（缺兜底会被后端拒）', () => {
    const routes = emptyForm().routes
    expect(routes).toHaveLength(1)
    expect(routes[0].prefix).toBe('/')
    expect(routes[0].kind).toBe('static')
  })

  it('每次调用返回全新对象——上一轮的手提内容不会串到下一次新建', () => {
    const a = emptyForm()
    a.upstreams = 'http://10.0.0.5:9000'
    expect(emptyForm().upstreams).toBe('')
    expect(emptyForm().routes[0]).not.toBe(a.routes[0])
  })
})

describe('rowToRoute', () => {
  it('proxy：逗号/空格分隔的上游切成数组，前缀只 trim', () => {
    const r = { prefix: '  /api  ', kind: 'proxy' as const, upstreams: 'http://a:1, http://b:2', spa: false, fpm: '', frontController: '', root: '' }
    expect(rowToRoute(r)).toEqual({ prefix: '/api', kind: 'proxy', upstreams: ['http://a:1', 'http://b:2'] })
  })

  it('末尾斜杠刻意不归一化——去重/去尾斜是后端写入侧的职责（openEdit 的回填已是归一化结果）', () => {
    const r = { prefix: '/api/', kind: 'proxy' as const, upstreams: 'http://a:1', spa: false, fpm: '', frontController: '', root: '' }
    expect(rowToRoute(r).prefix).toBe('/api/')
  })

  it('static：根目录留空时不下发 root（由后端继承站点根）', () => {
    const base = { prefix: '/', kind: 'static' as const, upstreams: '', spa: true, fpm: '', frontController: '', root: '' }
    expect(rowToRoute(base)).toEqual({ prefix: '/', kind: 'static', spa: true, root: undefined })
    expect(rowToRoute({ ...base, root: '/srv/x' })).toEqual({ prefix: '/', kind: 'static', spa: true, root: '/srv/x' })
  })
})

describe('wafPayload（后端四条对齐语义）', () => {
  it('未启用 → 只带 enabled:false', () => {
    const f = form()
    f.wafOn = false
    expect(wafPayload(f)).toEqual({ enabled: false })
  })

  it('rate 0 = 不限速；不限速时不带 burst（带了会被后端 400）', () => {
    const f = form()
    f.wafOn = true
    f.wafRate = 0
    f.wafBurst = 30
    const p = wafPayload(f)
    expect(p.rate_per_sec).toBe(0)
    expect(p.burst, '不限速却带 burst 属静默失败，后端刻意拒绝').toBeUndefined()
  })

  it('限速且给了 burst 才下发 burst；burst 为 0 则让后端按 rate×2 算', () => {
    const f = form()
    f.wafOn = true
    f.wafRate = 10
    expect(wafPayload(f).burst).toBeUndefined()
    f.wafBurst = 20
    expect(wafPayload(f).burst).toBe(20)
  })
})

describe('applyBody', () => {
  it('root 留空时回落站点名（后端约定：不填就用 name）', () => {
    const f = form()
    expect(applyBody(f, { name: 'demo', domains: ['demo.com'], includeCustomConf: false }).root).toBe('demo')
    f.root = '  /srv/demo  '
    expect(applyBody(f, { name: 'demo', domains: ['demo.com'], includeCustomConf: false }).root).toBe('/srv/demo')
  })

  it('spa 回退只对 static 生效——其余类型强制 false，不误入反代/重定向', () => {
    const f = form()
    f.spa = true
    expect(applyBody(f, { name: 'demo', domains: [], includeCustomConf: false }).spa).toBe(true)
    f.kind = 'proxy'
    expect(applyBody(f, { name: 'demo', domains: [], includeCustomConf: false }).spa).toBe(false)
  })

  it('非 owner 不带 custom_conf（缺省=保留库中现值，传空串才会误清）', () => {
    const f = form()
    f.customConf = '# 手写片段'
    expect(applyBody(f, { name: 'demo', domains: [], includeCustomConf: true })).toHaveProperty('custom_conf', '# 手写片段')
    expect(applyBody(f, { name: 'demo', domains: [], includeCustomConf: false })).not.toHaveProperty('custom_conf')
  })

  it('regen_conf 仅在 regenerate 时出现（手动维护站点覆盖手写配置的开关）', () => {
    const f = form()
    expect(applyBody(f, { name: 'demo', domains: [], includeCustomConf: false })).not.toHaveProperty('regen_conf')
    expect(applyBody(f, { name: 'demo', domains: [], includeCustomConf: false, regenerate: true })).toHaveProperty('regen_conf', true)
  })

  it('IP 名单归一成逗号串；auth_pass 仅在本次填了才出现（未填=保留现有 htpasswd）', () => {
    const f = form()
    f.ipAllow = '192.168.1.1, 10.0.0.0/8'
    f.authBasic = true
    f.authUser = 'alice'
    const noPass = applyBody(f, { name: 'demo', domains: [], includeCustomConf: false })
    expect(noPass.ip_allow).toBe('192.168.1.1,10.0.0.0/8')
    expect(noPass).toHaveProperty('auth_user', 'alice')
    expect(noPass, '口令留空时不提交，避免误清现有口令').not.toHaveProperty('auth_pass')
    f.authPass = 's3cret'
    expect(applyBody(f, { name: 'demo', domains: [], includeCustomConf: false })).toHaveProperty('auth_pass', 's3cret')
  })

  it('waf 段由 wafPayload 负责（本函数不承担它的语义）', () => {
    const f = form()
    expect(applyBody(f, { name: 'demo', domains: [], includeCustomConf: false }).waf).toEqual({ enabled: false })
  })
})

describe('confSpecNow（「哪些字段影响配置」的指纹）', () => {
  it('同内容同指纹', () => expect(confSpecNow(form())).toBe(confSpecNow(form())))

  it.each([['kind'], ['wafRate'], ['customConf'], ['hsts'], ['tlsMin']])(
    '改了 %s 会变指纹（这些都会改变 render 输出）',
    (field) => {
      const a = form()
      const b = form()
      ;(b as unknown as Record<string, unknown>)[field] = '__changed__'
      expect(confSpecNow(b)).not.toBe(confSpecNow(a))
    },
  )

  it('改 remark 不变指纹——备注是大表单之外的便签，不该触发「未同步」二选一', () => {
    const a = form()
    const b = form()
    b.remark = '同事也能看懂的一句话'
    expect(confSpecNow(b)).toBe(confSpecNow(a))
  })
})

describe('fieldMsg', () => {
  it('后端 reason 已是中文则原样透出（更具体）', () =>
    expect(fieldMsg('兜底文案', '域名不能包含空格')).toBe('域名不能包含空格'))

  it('英文/空 reason 回落到前端中文兜底', () => {
    expect(fieldMsg('兜底文案', 'invalid domain')).toBe('兜底文案')
    expect(fieldMsg('兜底文案', '')).toBe('兜底文案')
  })
})

describe('APP_TEMPLATES', () => {
  it('key 唯一（模板 chip 的选中态按 key 判定，重复会互相抢高亮）', () => {
    const keys = APP_TEMPLATES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('端口唯一：反推模板选中态靠端口完全匹配，撞端口会点错 chip', () => {
    const ports = APP_TEMPLATES.map((t) => t.port)
    expect(new Set(ports).size).toBe(ports.length)
  })
})
