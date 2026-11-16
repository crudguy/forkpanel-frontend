// @vitest-environment jsdom
/**
 * 「新建应用」弹窗分区导航的真挂载行为测试。
 *
 * 纯源码断言挡不住「导航渲染了但没绑点击 / 分区声明了但模板里没有对应 section /
 * 字段搬走后校验红点落不到正确的段」——这些在 vue-tsc、build 里全绿。
 * 这里挂载 AppsView，实际点开弹窗、点导航、触发校验，量的是 DOM 与 class 的真实结果。
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { API } from '@/api/endpoints'
import { mountView, type Mounted } from '@/test/mount'
import AppsView from '@/views/AppsView.vue'

let m: Mounted | null = null
afterEach(() => {
  if (!m) return
  const f = m.fake
  m.cleanup()
  m = null
  f.assertClean()
})

beforeAll(() => {
  // jsdom 不实现 Element.scrollTo；生产浏览器才有。这里补一个空实现，
  // 让「点击导航是否切换高亮」这类判据不因测试环境缺失而假红。
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

const APPS = [{
  id: 1, name: 'web-api', runtime: 'node', runtime_label: 'Node.js',
  workdir: '/srv/web', exec_start: 'node app.js', run_user: 'root',
  env: [] as [string, string][], port: 3000, auto_restart: true, enabled: true,
  domains: ['api.example.com'], created_at: 1, unit: 'web-api.service', state: 'active',
}]

// 给一个真实运行时：openCreate 会预选它，于是「基础」段里只有名称一个错误，
// 才能验出「改对某字段 → 该段红点熄灭」而不是被同段另一处错误盖住。
const ROUTES = {
  [API.apps.list()]: APPS,
  [API.apps.catalog()]: {
    runtimes: [{
      key: 'node', label: 'Node.js', default_port: 3000, runtime_pkg: null,
      default_exec: 'node app.js', typical: 'Express / NestJS',
      purpose: '跑 JavaScript 服务端', choose_when: '已有 Node 项目',
      build_hint: '先在项目目录 npm install',
    }],
  },
  [API.system.users()]: [],
}
const PERMS = ['service.manage', 'site.manage', 'system.view']

function findBtn(text: string): HTMLButtonElement {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(x => x.textContent?.trim().includes(text))
  if (!b) throw new Error(`找不到按钮「${text}」（定位失效会静默空集通过）`)
  return b
}

async function openModal() {
  findBtn('新建应用').click()
  await m!.flush()
  const modal = document.querySelector<HTMLElement>('.app-modal')
  if (!modal) throw new Error('点「新建应用」后弹窗没渲染')
  return modal
}

function railItems(modal: HTMLElement): HTMLButtonElement[] {
  const items = [...modal.querySelectorAll<HTMLButtonElement>('.nav-rail .nav-item')]
  if (items.length !== 4) throw new Error(`导航项应为 4 个，实际 ${items.length}`)
  return items
}

describe('新建应用弹窗的分区导航', () => {
  it('四个分区与全部原有字段都在，点导航可切换高亮', async () => {
    m = await mountView({ component: AppsView, routes: ROUTES, perms: PERMS })
    const modal = await openModal()

    const items = railItems(modal)
    expect(items.map(x => x.textContent?.trim())).toEqual(['基础', '进程配置', '网站托管', '环境变量'])
    const sections = [...modal.querySelectorAll<HTMLElement>('.modal-body > .sector')]
    expect(sections.map(s => s.id)).toEqual(['sec-basic', 'sec-process', 'sec-hosting', 'sec-env'])

    // 原有字段一个不少：拆分只改组织方式，不改数据模型与提交流程
    for (const f of ['name', 'runtime', 'port', 'workdir', 'exec_start', 'run_user', 'domains']) {
      expect(modal.querySelector(`[data-f="${f}"]`), `缺字段 ${f}`).toBeTruthy()
    }
    expect(modal.querySelector('#app-env-toggle')).toBeTruthy()
    expect(modal.querySelector('#app-restart')).toBeTruthy()
    expect(modal.querySelector('.env-box')).toBeTruthy()

    expect(items[0].classList.contains('active')).toBe(true)
    items[2].click()
    await m.flush()
    expect(items[2].classList.contains('active')).toBe(true)
    expect(items[0].classList.contains('active')).toBe(false)
  })

  it('校验失败后在出错字段所属分区亮红点，改对后红点消失', async () => {
    m = await mountView({ component: AppsView, routes: ROUTES, perms: PERMS })
    const modal = await openModal()
    const items = railItems(modal)

    findBtn('创建并托管').click()
    await m.flush()

    // 空表单：名称/运行时在工作目录与域名之前就报错，三个段都应亮红点
    expect(items[0].classList.contains('has-err')).toBe(true)
    expect(items[1].classList.contains('has-err')).toBe(true)
    expect(items[2].classList.contains('has-err')).toBe(true)
    expect(items[3].classList.contains('has-err')).toBe(false)
    expect(modal.querySelectorAll('.nav-dot')).toHaveLength(3)
    expect(modal.querySelector('.modal-head .form-msg')).toBeTruthy()

    // 把名称补上：name 的错误撤掉，但其它段仍有错，基础段红点应熄灭
    const name = modal.querySelector<HTMLInputElement>('[data-f="name"] input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('jsdom 缺少 HTMLInputElement.value setter')
    setter.call(name, 'my-blog')
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await m.flush()
    expect(items[0].classList.contains('has-err')).toBe(false)
    expect(items[1].classList.contains('has-err')).toBe(true)
  })

  it('编辑态沿用同一套分区，且应用名仍不可改', async () => {
    m = await mountView({ component: AppsView, routes: ROUTES, perms: PERMS })
    // 行内编辑按钮（第一个 title=编辑）
    const edit = [...document.querySelectorAll<HTMLButtonElement>('button[title="编辑"]')][0]
    if (!edit) throw new Error('找不到编辑按钮')
    edit.click()
    await m.flush()

    const modal = document.querySelector<HTMLElement>('.app-modal')!
    expect(railItems(modal)).toHaveLength(4)
    expect(modal.querySelectorAll('.modal-body > .sector')).toHaveLength(4)
    const name = modal.querySelector<HTMLInputElement>('[data-f="name"] input')!
    expect(name.disabled).toBe(true)
    expect(name.value).toBe('web-api')
  })
})
