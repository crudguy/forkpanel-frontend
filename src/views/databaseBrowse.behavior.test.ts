// @vitest-environment jsdom
/**
 * 数据浏览入口的真挂载行为测试。
 *
 * 钉住三件在 vue-tsc / build 里全绿、但用户实际会踩的事：
 * 1. 列表行点「浏览」后，连接的 default_db 必须自动落到库下拉并真的下钻到表；
 * 2. SQLite 的 default_db 是文件路径、库清单是 main，不能把路径直接塞进下拉；
 * 3. 直接点「数据浏览」页签时空态必须能选连接，而不是只能回到另一个页签。
 *
 * 假件未登记的请求会记入 unexpected，assertClean() 会翻红——所以
 * 「没下钻、没发请求」这类假绿不会被漏过去。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import { mountView, type Mounted } from '@/test/mount'
import DatabasesView from '@/views/DatabasesView.vue'

const ENGINES = [
  { key: 'sqlite', label: 'SQLite', default_port: null, default_user: null, external: false, user_required: false, client_ready: true, readonly_sql: true, artifact_ext: 'db', schema_label: 'catalog' },
  { key: 'postgres', label: 'PostgreSQL', default_port: 5432, default_user: 'postgres', external: true, user_required: true, client_ready: true, readonly_sql: true, artifact_ext: 'sql', schema_label: 'schema' },
]

interface Conn {
  id: number; name: string; engine: string; host: string | null; port: number | null
  default_db: string | null; client_ready: boolean; readonly_sql: boolean
  has_password: boolean; remark: string
}
function conn(over: Partial<Conn> = {}): Conn {
  return {
    id: 7, name: 'app', engine: 'sqlite', host: null, port: null,
    default_db: '/var/lib/forkpanel/app.db', client_ready: true, readonly_sql: true,
    has_password: false, remark: '', ...over,
  }
}

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

/** 连接列表行的「浏览」（不是页签按钮，也不是空态里的「打开浏览」） */
function rowBrowse(host: HTMLElement): HTMLButtonElement {
  const hit = [...host.querySelectorAll<HTMLButtonElement>('tbody button')]
    .find((b) => (b.textContent ?? '').includes('浏览'))
  if (!hit) throw new Error('连接行的「浏览」按钮不存在')
  return hit
}

function visiblePane(host: HTMLElement): HTMLElement {
  const hit = [...host.querySelectorAll<HTMLElement>('.tab-pane')]
    .find((p) => p.style.display !== 'none')
  if (!hit) throw new Error('没有可见页签面板')
  return hit
}

function clickTab(host: HTMLElement, label: string) {
  const hit = [...host.querySelectorAll<HTMLButtonElement>('.tabs .tab')]
    .find((b) => (b.textContent ?? '').includes(label))
  if (!hit) throw new Error(`找不到页签「${label}」`)
  hit.click()
}

/** Vue 受控 <select>：走原生 setter + change，不能只改 value 就以为响应式生效了 */
function setSelect(sel: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTMLSelectElement.prototype.value 没有 setter')
  setter.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

const TABLES = [{ name: 'users', rows: 3, engine: 'sqlite', kind: 'table' }]

describe('数据浏览：默认库预选', () => {
  it('SQLite 的 default_db 是文件路径 → 自动选中清单里的 main 并下钻到表', async () => {
    const c = conn()
    m = await mountView({
      component: DatabasesView,
      routes: {
        [API.db.connections()]: [c],
        [API.db.engines()]: { engines: ENGINES },
        [API.db.databases(c.id)]: ['main'],
        [API.db.schemas(c.id, 'main')]: [],
        [API.db.tables(c.id, 'main')]: TABLES,
      },
    })
    rowBrowse(m.host).click()
    await m.flush()

    const pane = visiblePane(m.host)
    const selects = [...pane.querySelectorAll<HTMLSelectElement>('select')]
    expect(selects[0].value).toBe('main')
    expect(selects[1].options[1]?.value).toBe('users')
    expect(m.fake.count(API.db.tables(c.id, 'main'))).toBe(1)
    m.fake.assertClean()
  })

  it('远端引擎：default_db 命中清单 → 预选并自动选中可预览的 schema', async () => {
    const c = conn({ id: 8, engine: 'postgres', host: '127.0.0.1', port: 5432, default_db: 'appdb' })
    m = await mountView({
      component: DatabasesView,
      routes: {
        [API.db.connections()]: [c],
        [API.db.engines()]: { engines: ENGINES },
        [API.db.databases(c.id)]: ['postgres', 'appdb'],
        [API.db.schemas(c.id, 'appdb')]: [{ name: 'public', previewable: true }],
        [API.db.tables(c.id, 'appdb')]: TABLES,
      },
    })
    rowBrowse(m.host).click()
    await m.flush()

    const selects = [...visiblePane(m.host).querySelectorAll<HTMLSelectElement>('select')]
    expect(selects[0].value).toBe('appdb')
    expect(selects[1].value).toBe('public')
    expect(m.fake.count(API.db.tables(c.id, 'appdb'))).toBe(1)
    m.fake.assertClean()
  })

  it('远端引擎 default_db 不在清单里 → 停在「选择库…」，不静默挑另一个库', async () => {
    // SQLite 有 main 兜底是引擎特例；这里用远端引擎测"命中失败"的一般情形
    const c = conn({ engine: 'postgres', host: '127.0.0.1', port: 5432, default_db: 'gone' })
    m = await mountView({
      component: DatabasesView,
      routes: {
        [API.db.connections()]: [c],
        [API.db.engines()]: { engines: ENGINES },
        [API.db.databases(c.id)]: ['appdb'],
      },
    })
    rowBrowse(m.host).click()
    await m.flush()

    const pane = visiblePane(m.host)
    expect(pane.querySelector<HTMLSelectElement>('select')?.value).toBe('')
    expect(pane.textContent).toContain('先在下方「库」里选一个')
    expect(m.fake.count(API.db.databases(c.id))).toBe(1)
    m.fake.assertClean()
  })
})

describe('数据浏览：空态连接选择器', () => {
  it('有连接时给出选择器；默认选客户端就绪项，缺客户端项禁用；切换后打开发起对应请求', async () => {
    const a = conn({ id: 7, name: 'ready-a' })
    const b = conn({ id: 8, name: 'ready-b' })
    const noClient = conn({ id: 9, name: 'no-client', client_ready: false })
    m = await mountView({
      component: DatabasesView,
      routes: {
        [API.db.connections()]: [a, b, noClient],
        [API.db.engines()]: { engines: ENGINES },
        [API.db.databases(a.id)]: ['main'],
        [API.db.schemas(a.id, 'main')]: [],
        [API.db.tables(a.id, 'main')]: TABLES,
        [API.db.databases(b.id)]: ['main'],
        [API.db.schemas(b.id, 'main')]: [],
        [API.db.tables(b.id, 'main')]: TABLES,
      },
    })
    clickTab(m.host, '数据浏览')
    await m.flush()

    const pane = visiblePane(m.host)
    const picker = pane.querySelector<HTMLSelectElement>('select[aria-label="选择要浏览的连接"]')
    if (!picker) throw new Error('空态连接选择器不存在')
    expect(picker.value).toBe(String(a.id))
    expect([...picker.options].find((o) => o.textContent?.includes('no-client'))?.disabled).toBe(true)

    setSelect(picker, String(b.id))
    await m.flush()
    const open = [...pane.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => (b.textContent ?? '').includes('打开浏览'))
    if (!open) throw new Error('「打开浏览」按钮不存在')
    open.click()
    await m.flush()

    expect(m.fake.count(API.db.databases(b.id))).toBe(1)
    expect(m.fake.count(API.db.databases(a.id))).toBe(0)
    expect(visiblePane(m.host).textContent).toContain('浏览：ready-b')
    m.fake.assertClean()
  })
})
