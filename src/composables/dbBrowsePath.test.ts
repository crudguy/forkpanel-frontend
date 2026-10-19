/**
 * `dbBrowsePath` 的测试。
 *
 * 这里有两条**反恒绿**的纪律：
 * 1. 断言按 `hint.key` 而不是文案——按文案断言的话，改一个标点就翻红，
 *    而真正该抓的回归（层级判错、说错层）反而看不出来。
 * 2. 每个分支都要有「**不该命中它**」的对照：比如「该库为空」必须证明
 *    「没选库」「清单在途」「有视图」这三种情况**不会**掉进它。
 *    只测阳性分支的话，一个把所有情况都判成 `objects` 的实现也能全绿。
 */
import { describe, expect, it } from 'vitest'
import {
  dbCrumbs,
  dbHint,
  dbLevel,
  defaultSchema,
  hasSchemaLayer,
  isSchemaBlocked,
  tableOptionLabel,
  type DbLevelInput,
  type DbSchemaNode,
} from './dbBrowsePath'

const base = (over: Partial<DbLevelInput> = {}): DbLevelInput => ({
  db: '',
  schemas: [],
  schema: '',
  tables: [],
  tablesLoading: false,
  ...over,
})

const PG_SCHEMAS: DbSchemaNode[] = [
  { name: 'information_schema', previewable: false },
  { name: 'public', previewable: true },
]

describe('hasSchemaLayer / isSchemaBlocked', () => {
  it('空清单 = 没有 schema 层（MySQL / SQLite 的真实口径，不是"这层是空的"）', () => {
    expect(hasSchemaLayer([])).toBe(false)
    expect(hasSchemaLayer(PG_SCHEMAS)).toBe(true)
  })

  it('没有 schema 层时，isSchemaBlocked 恒为 false —— 空 schema 名不能被误判', () => {
    // 反面：若实现写成 `scope !== 'public'` 而不先判层级，MySQL 的 schema='' 会
    // 被判成 blocked，整页直接显示"仅展示 public"的警示 —— 这是最容易犯的一版
    expect(isSchemaBlocked([], '')).toBe(false)
    expect(isSchemaBlocked([], 'anything')).toBe(false)
  })

  it('schema 层存在：public 可预览，其余按后端 previewable 判定', () => {
    expect(isSchemaBlocked(PG_SCHEMAS, 'public')).toBe(false)
    expect(isSchemaBlocked(PG_SCHEMAS, 'information_schema')).toBe(true)
    // 没选 schema（还没点）不算 blocked，只是还没选
    expect(isSchemaBlocked(PG_SCHEMAS, '')).toBe(false)
  })

  it('清单里查不到的 schema 名按不可预览处理（不假装能预览再报错）', () => {
    expect(isSchemaBlocked(PG_SCHEMAS, 'evil_schema')).toBe(true)
  })
})

describe('defaultSchema：选库后自动选中哪个', () => {
  it('有 schema 层 → 选中第一个可预览的（PG 即 public）', () => {
    expect(defaultSchema(PG_SCHEMAS)).toBe('public')
  })

  it('没有 schema 层 → 空串（MySQL/SQLite 不该凭空选中一个）', () => {
    expect(defaultSchema([])).toBe('')
  })

  it('一个可预览的都没有 → 空串，不假装选好了一个', () => {
    // 此时应走 schemaBlocked 分支把原因说清，而不是默认选中一个点不开的 schema
    expect(defaultSchema([{ name: 'private', previewable: false }])).toBe('')
  })

  it('清单里 previewable 缺省视为可预览（老后端没这个字段时不至于全不可选）', () => {
    expect(defaultSchema([{ name: 'app_schema' }])).toBe('app_schema')
  })
})

describe('dbLevel：四种层级的判定', () => {
  it('还没选库 → state（不能落到"这一层没有对象"）', () => {
    expect(dbLevel(base())).toBe('state')
    // 连接下有库清单也一样，缺 db 就是 state
    expect(dbLevel(base({ schemas: PG_SCHEMAS }))).toBe('state')
  })

  it('选了库、表为空、已查完 → objects（这才是唯一可以说"这层是空的"的情形）', () => {
    expect(dbLevel(base({ db: 'app', tables: [] }))).toBe('objects')
  })

  it('清单在途 → 仍算 tables 层，不能提前报"空库"', () => {
    // 这是"闪一下空库再变成有表"那类闪烁的根因：把在途与查完为空混成一个判据
    expect(dbLevel(base({ db: 'app', tables: [], tablesLoading: true }))).toBe('tables')
  })

  it('有表 → tables', () => {
    expect(dbLevel(base({ db: 'app', tables: [{ name: 'users', rows: 3 }] }))).toBe('tables')
  })

  it('选了不可预览的 schema → schemaBlocked（优先于 objects，两种话不能混）', () => {
    expect(dbLevel(base({ db: 'app', schemas: PG_SCHEMAS, schema: 'information_schema' })))
      .toBe('schemaBlocked')
  })

  it('选了 public、表为空 → objects（不是 schemaBlocked，不能连带冤枉 public）', () => {
    expect(dbLevel(base({ db: 'app', schemas: PG_SCHEMAS, schema: 'public' }))).toBe('objects')
  })

  it('只有视图 → objects（视图不能充数成表，否则提示会说"共 1 张表"）', () => {
    expect(dbLevel(base({ db: 'app', tables: [{ name: 'v', rows: 4, kind: 'view' }] })))
      .toBe('objects')
  })
})

describe('dbHint：每层各说各的话', () => {
  it('state 说"先去选库"，不说任何关于表的话', () => {
    const h = dbHint('state', base(), 'mysql')
    expect(h?.key).toBe('pick-db')
    // 反面判据：这句话里不该出现「表」相关的断言，否则又回到本次要修的毛病
    expect(h?.text).not.toMatch(/没有表|无表/)
  })

  it('SQLite 的 state 额外说明一般只有 main（避免用户等第二个库）', () => {
    expect(dbHint('state', base(), 'sqlite')?.text).toContain('main')
    expect(dbHint('state', base(), 'mysql')?.text).not.toContain('main')
  })

  it('objects 说清"这个库为空"并给出下一步，而不是干巴巴的"无表"', () => {
    const h = dbHint('objects', base({ db: 'app' }), 'mysql')
    expect(h?.key).toBe('layer-empty')
    expect(h?.text).toContain('app')
    // 给了下一步（SQL 控制台），否则用户只知道自己碰壁了
    expect(h?.text).toContain('SQL')
  })

  it('SQLite 的空库解释口径不同（内建文件、不提供建表），换引擎不能复用同一句', () => {
    const sqlite = dbHint('objects', base({ db: 'main' }), 'sqlite')
    const mysql = dbHint('objects', base({ db: 'main' }), 'mysql')
    expect(sqlite?.text).not.toBe(mysql?.text)
    expect(sqlite?.text).toContain('SQLite')
  })

  it('postgres 的空层要提醒本版只读 public —— 否则用户以为库真的空', () => {
    const h = dbHint('objects', base({ db: 'app', schema: 'public', schemas: PG_SCHEMAS }), 'postgres')
    expect(h?.key).toBe('layer-empty')
    expect(h?.text).toContain('public')
  })

  it('只有视图 → objects 层的 views-only（不能被算成"有表"）', () => {
    const i = base({ db: 'app', tables: [{ name: 'v_active', rows: 4, kind: 'view' }] })
    // ⚠ 层级必须**由 dbLevel 判出来**，不能直调 dbHint 硬塞一个 level。
    // 旧写法直接 dbHint('objects', …) 造出了真实 UI 走不到的组合，
    // 于是把一条死代码"证明"成了活的（假绿）：dbLevel 从来不会返回 objects。
    expect(dbLevel(i)).toBe('objects')
    const h = dbHint(dbLevel(i), i, 'sqlite')
    expect(h?.key).toBe('views-only')
    expect(h?.text).toContain('1 个视图')
    // 反面：只有视图时不该再说"共 N 张表"（那 N 其实是视图，信息是错的）
    expect(h?.text).not.toMatch(/共 \d+ 张表/)
  })

  it('表与视图并存 → tables 层，两个数量分开说', () => {
    const i = base({
      db: 'app',
      tables: [
        { name: 'users', rows: 3 },
        { name: 'v_active', rows: 4, kind: 'view' },
      ],
    })
    expect(dbLevel(i)).toBe('tables')
    const h = dbHint(dbLevel(i), i, 'sqlite')
    expect(h?.key).toBe('pick-table')
    expect(h?.text).toContain('共 1 张表')
    expect(h?.text).toContain('1 个视图')
  })

  it('tablesLoading → loading，不与"共 N 张表"并存', () => {
    expect(dbHint('tables', base({ db: 'app', tablesLoading: true }), 'sqlite')?.key).toBe('loading')
  })

  it('schemaBlocked 明确是"本版只读 public"，不能说成这个 schema 是空的', () => {
    const h = dbHint('schemaBlocked',
      base({ db: 'app', schemas: PG_SCHEMAS, schema: 'information_schema' }), 'postgres')
    expect(h?.key).toBe('schema-blocked')
    expect(h?.tone).toBe('warn')
    expect(h?.text).toContain('public')
    expect(h?.text).toContain('information_schema')
    // 反面：不能把责任推给用户的数据
    expect(h?.text).not.toContain('没有可预览的表')
  })

  it('已选中表（tables 层且有数据）仍然给 pick-table —— 它说的是"共 N 张，在下方选"', () => {
    // 数据区自己表达选中结果，这里不另造一条"已选中"提示（避免同屏两句话打架）
    const h = dbHint('tables', base({ db: 'app', tables: [{ name: 'a', rows: 1 }] }), 'sqlite')
    expect(h?.key).toBe('pick-table')
    expect(h?.text).toContain('共 1 张表')
  })
})

describe('tableOptionLabel：行数取不到时不能说成 -1 行', () => {
  it('rows=-1 → 行数未知', () => {
    expect(tableOptionLabel({ name: 't', rows: -1 })).toBe('t（行数未知）')
    // 反面：绝不能把 -1 渲染成数字
    expect(tableOptionLabel({ name: 't', rows: -1 })).not.toContain('-1')
  })

  it('rows=0 是真实空表，照常显示 0 行（与取不到要分开）', () => {
    expect(tableOptionLabel({ name: 't', rows: 0 })).toBe('t（0 行）')
  })

  it('视图标注种类，表不标注（不给最常见的种类加噪音）', () => {
    expect(tableOptionLabel({ name: 'v', rows: 2, kind: 'view' })).toBe('v（视图）（2 行）')
    expect(tableOptionLabel({ name: 't', rows: 2, kind: 'table' })).toBe('t（2 行）')
  })

})

describe('dbCrumbs：只出真实存在的层', () => {
  it('没有 schema 层时不出空段（MySQL / SQLite）', () => {
    expect(dbCrumbs(base({ db: 'app' }))).toEqual([{ text: 'app', current: true }])
  })

  it('PG 选了 schema → 库 / schema 两段，最后一段是当前', () => {
    expect(dbCrumbs(base({ db: 'app', schemas: PG_SCHEMAS, schema: 'public' }))).toEqual([
      { text: 'app', current: false },
      { text: 'public', current: true },
    ])
  })

  it('还没选库 → 空（不渲染一个光秃秃的 /）', () => {
    expect(dbCrumbs(base())).toEqual([])
  })

  it('有 schema 层但还没选 schema → 只有库那一段且为当前', () => {
    expect(dbCrumbs(base({ db: 'app', schemas: PG_SCHEMAS }))).toEqual([
      { text: 'app', current: true },
    ])
  })
})
