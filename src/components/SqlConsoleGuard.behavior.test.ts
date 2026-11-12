// @vitest-environment jsdom
/**
 * 只读 SQL 控制台的**能力位纪律**——真挂载行为测试。
 *
 * 取代 `SqlConsoleGuard.test.ts`（那份读 `.vue` 源码、剥注释剥字符串后断言
 * "SQL 按钮块里不得出现 engine 字样"）。文本断言只证明代码这么写，不证明
 * "后端下发的 readonly_sql 真的决定了按钮能不能点"；而后者才是用户可观察的、
 * 也是唯一会伤人的：后端明天给 PG 加了护栏，前端若仍硬判引擎，按钮就一直灰着。
 *
 * 夹具刻意让 engine 与 readonly_sql **不相关**：sqlite 开、postgres 关、
 * postgres 又开、mysql 开。任何退回按引擎硬判的实现都会在这四行里至少错两行；
 * 同是 postgres 的两行一个开一个关，更是直接排除了"按引擎查表"的一切写法。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import DatabasesView from '@/views/DatabasesView.vue'
import SqlConsole from '@/components/SqlConsole.vue'
import { mountView, type Mounted } from '@/test/mount'

interface FakeConn {
  id: number
  name: string
  engine: string
  host: string | null
  port: number | null
  default_db: string | null
  client_ready: boolean
  has_password: boolean
  readonly_sql: boolean
  remark: string
}

function conn(over: Partial<FakeConn> & Pick<FakeConn, 'id'>): FakeConn {
  return {
    name: `conn-${over.id}`, engine: 'sqlite', host: null, port: null,
    default_db: null, client_ready: true, has_password: false,
    readonly_sql: true, remark: '', ...over,
  }
}

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

/** 每行一个 SQL 按钮。调用方必须自检数量——定位失效会静默空集通过。 */
function sqlButtons(mounted: Mounted): HTMLButtonElement[] {
  return [...mounted.host.querySelectorAll<HTMLButtonElement>('button')]
    .filter((b) => b.textContent?.trim() === 'SQL')
}

const CONNS: FakeConn[] = [
  conn({ id: 1, name: 'sqlite-open', engine: 'sqlite', readonly_sql: true }),
  conn({ id: 2, name: 'pg-closed', engine: 'postgres', readonly_sql: false }),
  conn({ id: 3, name: 'pg-open', engine: 'postgres', readonly_sql: true }),
  conn({ id: 4, name: 'mysql-open', engine: 'mysql', readonly_sql: true }),
]

describe('SQL 控制台门控：后端 readonly_sql 决定按钮状态', () => {
  it('能力位为 true 才启用；同一种引擎两个值给出两个结果', async () => {
    m = await mountView({
      component: DatabasesView,
      routes: { [API.db.connections()]: CONNS },
    })
    const btns = sqlButtons(m)
    expect(btns.length, '每个连接必须渲染一个 SQL 按钮（定位失效会静默空集）').toBe(CONNS.length)
    expect(btns.map((b) => b.disabled)).toEqual([false, true, false, false])
    m.fake.assertClean()
  })

  it('置灰理由也由能力位驱动，同引擎不同能力位给出不同 title', async () => {
    m = await mountView({
      component: DatabasesView,
      routes: { [API.db.connections()]: CONNS },
    })
    const btns = sqlButtons(m)
    expect(btns.length).toBe(CONNS.length)
    expect(btns[0].title).toBe('执行只读查询')
    expect(btns[2].title).toBe('执行只读查询')
    expect(btns[1].title).toContain('只读护栏')
    expect(btns[1].title).not.toBe(btns[2].title)
  })

  it('能力位全关时一个按钮都不许能点', async () => {
    m = await mountView({
      component: DatabasesView,
      routes: { [API.db.connections()]: CONNS.map((c) => ({ ...c, readonly_sql: false })) },
    })
    const btns = sqlButtons(m)
    expect(btns.length).toBe(CONNS.length)
    expect(btns.every((b) => b.disabled)).toBe(true)
  })
})

const META = {
  engine: 'postgres',
  readonly_sql: true,
  default_sql: 'SELECT now() FROM backend_meta',
  samples: [
    { label: '甲', sql: 'SELECT 1' },
    { label: '乙', sql: 'SELECT 2' },
  ],
  note: '后端下发的只读护栏说明',
}

const CONSOLE_PROPS = { conn: { id: 7, name: 'pg', engine: 'postgres' } }

describe('SQL 控制台：默认语句、示例与说明都来自后端 sql-meta', () => {
  it('textarea 初值是 meta.default_sql（不是写死的 sqlite_master）', async () => {
    m = await mountView({
      component: SqlConsole, props: CONSOLE_PROPS,
      routes: { [API.db.sqlMeta(7)]: META },
    })
    const ta = m.host.querySelector<HTMLTextAreaElement>('.lined-ta')
    expect(ta, '找不到 SQL textarea').not.toBeNull()
    expect(ta!.value).toBe(META.default_sql)
    expect(ta!.value).not.toContain('sqlite_master')
    m.fake.assertClean()
  })

  it('默认语句只看后端 meta，不看 conn.engine（防按引擎二选一）', async () => {
    m = await mountView({
      component: SqlConsole,
      // 引擎故意报 sqlite，meta 却给 PG 风格默认语句：任何"按引擎二选一"
      // 的写法都会在这里拿到 sqlite_master，而不是后端下发的值。
      props: { conn: { id: 7, name: 'sqlite-labeled', engine: 'sqlite' } },
      routes: { [API.db.sqlMeta(7)]: META },
    })
    const ta = m.host.querySelector<HTMLTextAreaElement>('.lined-ta')
    expect(ta, '找不到 SQL textarea').not.toBeNull()
    expect(ta!.value).toBe(META.default_sql)
  })

  it('示例按钮数量与文案随 meta.samples 变（不是本地常量数组）', async () => {
    m = await mountView({
      component: SqlConsole, props: CONSOLE_PROPS,
      routes: {
        [API.db.sqlMeta(7)]: {
          ...META, samples: [...META.samples, { label: '丙', sql: 'SELECT 3' }],
        },
      },
    })
    const labels = [...m.host.querySelectorAll('.sp-samples button')]
      .map((b) => b.textContent?.trim())
    expect(labels).toEqual(['甲', '乙', '丙'])
  })

  it('点示例按钮后 textarea 变成该条 sql', async () => {
    m = await mountView({
      component: SqlConsole, props: CONSOLE_PROPS,
      routes: { [API.db.sqlMeta(7)]: META },
    })
    const btns = [...m.host.querySelectorAll<HTMLButtonElement>('.sp-samples button')]
    expect(btns.length).toBe(2)
    btns[1].click()
    await m.flush()
    expect(m.host.querySelector<HTMLTextAreaElement>('.lined-ta')!.value).toBe('SELECT 2')
  })

  it('只读护栏说明原样显示 meta.note', async () => {
    m = await mountView({
      component: SqlConsole, props: CONSOLE_PROPS,
      routes: { [API.db.sqlMeta(7)]: META },
    })
    expect(m.host.querySelector('.hint-note')?.textContent).toContain(META.note)
  })
})
