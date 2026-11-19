// @vitest-environment jsdom
/**
 * 引擎清单由后端单一事实源驱动的真挂载行为测试。
 *
 * 源码断言挡不住「下拉漏了一项 / 默认值写死成二元三元 / 新增引擎静默选错端口」
 * ——这几样在 vue-tsc、build 和旧测试里全绿，用户却选不到新引擎或建出必失败的连接。
 * 这里真挂载组件、真改 select、真读 DOM 占位，验证后端下发的值确实决定 UI。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import { mountView, type Mounted } from '@/test/mount'
import DatabasesView from '@/views/DatabasesView.vue'

/** 与后端 ALL_ENGINES 对齐的 9 项夹具；顺序即下拉顺序 */
const ENGINES = [
  { key: 'sqlite', label: 'SQLite', default_port: null, default_user: null, external: false, user_required: false, client_ready: true, readonly_sql: true, artifact_ext: 'db', schema_label: 'catalog' },
  { key: 'mysql', label: 'MySQL', default_port: 3306, default_user: 'root', external: true, user_required: true, client_ready: false, readonly_sql: false, artifact_ext: 'sql', schema_label: '' },
  { key: 'mariadb', label: 'MariaDB', default_port: 3306, default_user: 'root', external: true, user_required: true, client_ready: false, readonly_sql: false, artifact_ext: 'sql', schema_label: '' },
  { key: 'postgres', label: 'PostgreSQL', default_port: 5432, default_user: 'postgres', external: true, user_required: true, client_ready: false, readonly_sql: false, artifact_ext: 'sql', schema_label: 'schema' },
  { key: 'mongodb', label: 'MongoDB', default_port: 27017, default_user: null, external: true, user_required: false, client_ready: false, readonly_sql: false, artifact_ext: 'archive', schema_label: 'collection' },
  { key: 'redis', label: 'Redis', default_port: 6379, default_user: null, external: true, user_required: false, client_ready: false, readonly_sql: false, artifact_ext: 'rdb', schema_label: '' },
  { key: 'mssql', label: 'SQL Server', default_port: 1433, default_user: 'sa', external: true, user_required: true, client_ready: false, readonly_sql: false, artifact_ext: 'sql', schema_label: 'schema' },
  { key: 'oracle', label: 'Oracle', default_port: 1521, default_user: 'system', external: true, user_required: true, client_ready: false, readonly_sql: false, artifact_ext: 'dmp', schema_label: 'schema' },
  { key: 'clickhouse', label: 'ClickHouse', default_port: 9000, default_user: 'default', external: true, user_required: true, client_ready: false, readonly_sql: false, artifact_ext: 'sql', schema_label: '' },
]

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

const PERMS = ['db.view', 'db.manage']

async function mount() {
  m = await mountView({
    component: DatabasesView,
    routes: {
      [API.db.connections()]: [],
      [API.db.engines()]: { engines: ENGINES },
    },
    perms: PERMS,
  })
  return m
}

function createCard(mounted: Mounted): HTMLElement {
  const card = mounted.host.querySelector<HTMLElement>('#db-create-card')
  if (!card) throw new Error('新增连接卡不存在（定位失效会静默空集通过）')
  return card
}

function pick(mounted: Mounted, key: string) {
  const sel = createCard(mounted).querySelector<HTMLSelectElement>('select')
  if (!sel) throw new Error('引擎下拉不存在')
  sel.value = key
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('数据库连接：引擎清单与默认值来自后端', () => {
  it('下拉完整渲染后端下发的 9 个引擎，顺序与显示名一致', async () => {
    const mounted = await mount()
    const sel = createCard(mounted).querySelector<HTMLSelectElement>('select')!
    expect([...sel.options].map((o) => o.value)).toEqual(ENGINES.map((e) => e.key))
    expect([...sel.options].map((o) => o.textContent?.trim())).toEqual(ENGINES.map((e) => e.label))
  })

  it('端口/账号占位随引擎元数据变化，不是 mysql ? 3306 : 5432 的二元三元', async () => {
    const mounted = await mount()
    // 端口/用户名输入框在 v-if="!isLocalEngine" 内，切换引擎会重建 DOM；
    // 每次都重新查询，不能缓存 SQLite 状态下为 null 的旧引用。
    const port = () => createCard(mounted).querySelector<HTMLInputElement>('input[inputmode=numeric]')!
    const user = () => [...createCard(mounted).querySelectorAll<HTMLInputElement>('input')]
      .find((i) => i.autocomplete === 'off')!

    pick(mounted, 'mariadb'); await mounted.flush()
    expect(port().placeholder).toBe('3306')
    expect(user().placeholder).toBe('root')

    pick(mounted, 'mongodb'); await mounted.flush()
    expect(port().placeholder).toBe('27017')
    // MongoDB 不强制账号：必填星号不应出现
    expect([...createCard(mounted).querySelectorAll('span[title]')]
      .some((s) => (s.getAttribute('title') ?? '').includes('必须指定账号'))).toBe(false)

    pick(mounted, 'oracle'); await mounted.flush()
    expect(port().placeholder).toBe('1521')
    expect(user().placeholder).toBe('system')
  })

  it('SQLite 不渲染端口/口令，且库名字段显示为文件路径', async () => {
    const mounted = await mount()
    const card = createCard(mounted)
    pick(mounted, 'sqlite'); await mounted.flush()
    expect(card.querySelector('input[inputmode=numeric]')).toBeNull()
    expect(card.textContent).toContain('数据库文件')
  })
})
