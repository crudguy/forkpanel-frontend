// @vitest-environment jsdom
/**
 * 列表搜索的真挂载行为测试。
 *
 * 只测 matchFields 纯函数挡不住「搜索框渲染了但没接进列表 / 空态 CTA 没绑事件」：
 * 这类退化在 vue-tsc、build 里全绿。这里挂载两个在 dev 环境恰好**没有数据**的
 * 列表页（应用、证书），用 API 假件给数据，实际派发 input 事件走完整条响应式链。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import { mountView, type Mounted } from '@/test/mount'
import AppsView from '@/views/AppsView.vue'
import CertsView from '@/views/CertsView.vue'

let m: Mounted | null = null
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  f.assertClean()
})

/** Vue 受控输入必须用原生 setter 触发 input，直接赋值不会进响应式。 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('jsdom 缺少 HTMLInputElement.value setter')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function searchInput(host: HTMLElement, label: string): HTMLInputElement {
  const el = [...host.querySelectorAll<HTMLInputElement>('input.filter[type=search]')]
    .find(x => x.getAttribute('aria-label') === label)
  if (!el) throw new Error(`找不到搜索框「${label}」（定位失效会静默空集通过）`)
  return el
}

function rowText(host: HTMLElement): string[] {
  return [...host.querySelectorAll('tbody tr')].map(tr => tr.textContent?.trim() ?? '')
}

function clickClearCta(host: HTMLElement) {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.empty .cta button')]
    .find(x => x.textContent?.trim() === '清空搜索')
  if (!b) throw new Error('无结果态里找不到「清空搜索」CTA')
  b.click()
}

const APPS = [
  {
    id: 1, name: 'web-api', runtime: 'node', runtime_label: 'Node.js',
    workdir: '/srv/web', exec_start: 'node app.js', run_user: 'root',
    env: [] as [string, string][], port: 3000, auto_restart: true, enabled: true,
    domains: ['api.example.com'], created_at: 1, unit: 'web-api.service', state: 'active',
  },
  {
    id: 2, name: 'cache-api', runtime: 'python', runtime_label: 'Python',
    workdir: '/srv/cache', exec_start: 'python app.py', run_user: 'root',
    env: [] as [string, string][], port: 8000, auto_restart: true, enabled: true,
    domains: ['cache.example.com'], created_at: 2, unit: 'cache-api.service', state: 'active',
  },
]

const CERTS = [
  {
    id: 1, domain: 'www.example.com', issuer: null, not_after: 1800000000,
    days_left: 30, auto_renew: true, source: 'acme',
  },
  {
    id: 2, domain: 'blog.example.org', issuer: null, not_after: 1800000000,
    days_left: 90, auto_renew: false, source: 'selfsigned',
  },
]

describe('应用页搜索', () => {
  it('按名称/域名过滤，无结果可一键清空', async () => {
    m = await mountView({
      component: AppsView,
      routes: {
        [API.apps.list()]: APPS,
        [API.apps.catalog()]: { runtimes: [] },
        [API.system.users()]: [],
      },
    })
    const input = searchInput(m.host, '搜索应用')
    expect(rowText(m.host)).toHaveLength(2)

    typeInto(input, 'web')
    await m.flush()
    expect(rowText(m.host)).toHaveLength(1)
    expect(rowText(m.host)[0]).toContain('web-api')

    typeInto(input, 'zzzznotfound')
    await m.flush()
    expect(m.host.querySelector('.empty .title')?.textContent).toContain('没有匹配')
    expect(m.host.textContent).toContain('找到 0 / 共 2 个应用')

    clickClearCta(m.host)
    await m.flush()
    expect(input.value).toBe('')
    expect(rowText(m.host)).toHaveLength(2)
  })

  it('按域名也能命中（关键字段不只名称）', async () => {
    m = await mountView({
      component: AppsView,
      routes: {
        [API.apps.list()]: APPS,
        [API.apps.catalog()]: { runtimes: [] },
        [API.system.users()]: [],
      },
    })
    typeInto(searchInput(m.host, '搜索应用'), 'cache.example.com')
    await m.flush()
    expect(rowText(m.host)).toHaveLength(1)
    expect(rowText(m.host)[0]).toContain('cache-api')
  })
})

describe('证书页搜索', () => {
  it('按域名过滤，站点名、无结果与清空均可用', async () => {
    m = await mountView({
      component: CertsView,
      routes: {
        [API.certs.list()]: CERTS,
        [API.sites.list()]: [
          { id: 1, name: 'blog-site', domains: ['blog.example.org'] },
        ],
        [API.certs.renewSweep()]: { last_at: 0, last_queued: 0, next_at: 0 },
      },
    })
    const input = searchInput(m.host, '搜索证书')
    expect(rowText(m.host)).toHaveLength(2)

    // 站点名不在证书记录上，靠 siteOf 反查——搜 blog-site 也应命中那张证书。
    typeInto(input, 'blog-site')
    await m.flush()
    expect(rowText(m.host)).toHaveLength(1)
    expect(rowText(m.host)[0]).toContain('blog.example.org')

    typeInto(input, 'zzzznotfound')
    await m.flush()
    expect(m.host.querySelector('.empty .title')?.textContent).toContain('没有匹配')

    clickClearCta(m.host)
    await m.flush()
    expect(rowText(m.host)).toHaveLength(2)
  })
})
