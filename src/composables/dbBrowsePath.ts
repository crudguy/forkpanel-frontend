/**
 * 数据库只读浏览的「路径层级 + 该层该说什么」。
 *
 * 为什么单独一个模块：这段判定原本写在 `DatabasesView.vue` 的模板表达式里
 * （`v-else-if="browse.db && browse.tables.length === 0"` → 「该库无表」），
 * 而 SFC 里的逻辑**测不了**（vitest 只收 `src/**\/*.test.ts`，本项目没装 vue 插件）。
 * 于是"什么情况该说哪句话"永远只是写在模板里的承诺，没有任何东西钉住它。
 *
 * 要修的现实问题（用户原话）：
 *   「浏览数据库，选择不同路径，提示不准确，比如库，数据库，不应该都展示没有表，
 *     应该去找对应的下级」
 *
 * 根因有两层，都不在文案而在**模型**：
 *
 * 1) **层级缺失**。真实结构是 连接 → 库 → （schema）→ 表 → 行，但状态只有
 *    `dbs / db / tables / data` 四层，没有 schema 这一层。PostgreSQL 库里
 *    再往下一层是 schema，于是「库」和「库下的表」被硬塞进同一个判断里。
 *
 * 2) **两个不同的问题共用一个判据**。`tables.length === 0` 同时承在了三件事上：
 *    ① 还没选库  ② 该库确实没有表  ③ 当前实现只查了 `public`、而库里的表在别的 schema。
 *    这三件事该说的话完全不同（「请在下面选一个库」/「这个库是空的，可以去 SQL 控制台
 *    自己建」/「表在别的 schema 里，本版只展示 public」），共用一个判据就必然有两句是错的。
 *
 * 所以这里把「当前停在哪一层」和「这一层的事实」拆开：
 * - `DbLevel`：state（还没选库）/ objects（该库这一层没有可预览对象）/ tables / schemaBlocked
 * - `dbNotice(level, facts)`：把「层级 + 事实」映射成一句准确的话，且**每句都能被测试钉住**。
 *
 * 性能口径一律用「还没查过」而不是「查到了 0 个」：网络请求在途和真的为空是两回事，
 * 混在一起就会出现「刚点进去闪一下『空库』再变成有表」的闪烁，而且让人误以为库是空的。
 */

/** 一个库的下一级对象（PostgreSQL 的 schema）。 */
export interface DbSchemaNode {
  name: string
  /** 点进这一层能否列出可预览的对象。**这是实现能力，不是"有没有东西"**——见后端 DbSchema 说明 */
  previewable?: boolean
}

/** 表对象种类。后端 `DbTable.kind` 下发；老版本后端没这个字段时按 table 处理。 */
export type DbTableKind = 'table' | 'view'

/**
 * 浏览面板当前**停在哪一层**。
 *
 * - `state`：还没选库（只有连接和库清单）
 * - `schemaBlocked`：选了库、也选了 schema，但该 schema 当前不可预览（实现能力所限）
 * - `objects`：选了库（未启用 schema 层），这一层没有可预览的对象
 * - `tables`：有可预览的对象（含已选中某张表 → 再细分由 `dbHint` 决定）
 *
 * 「该层有没有东西」由 `tables` 表达，不用另一个枚举值——`objects` 只有在此层
 * 已查完且为空时才成立，判据集中在 `dbLevel()` 一处。
 */
export type DbLevel = 'state' | 'schemaBlocked' | 'objects' | 'tables'

export interface DbLevelInput {
  /** 当前选中的库（空串 = 还没选） */
  db: string
  /** 该库的下一级对象（空数组 = 该引擎没有更下一层，或还没查） */
  schemas: DbSchemaNode[]
  /** 当前选中的 schema（空串 = 未选 / 该引擎没有这一层） */
  schema: string
  /** 该库（该 schema 下）可预览的表对象。`rows` 可缺省：层级判定不关心行数 */
  tables: { name: string; kind?: DbTableKind; rows?: number }[]
  /** 表清单请求是否在途（在途时 `tables` 为空不代表没有表） */
  tablesLoading?: boolean
}

/**
 * 这次浏览**是否存在 schema 这一层**。
 *
 * 判据是「该库的下一级清单非空」而不是「引擎是不是 postgres」——后者会让前端硬编码
 * 引擎知识，而后端在 `schemas()` 里已经如实回答了「有没有下一层」（MySQL / SQLite 返回空数组）。
 * 前端只消费这个事实，不猜。
 */
export function hasSchemaLayer(schemas: DbSchemaNode[]): boolean {
  return schemas.length > 0
}

/**
 * 当前选中的 schema 是否不可预览。
 *
 * 只对**存在 schema 层**的情况生效：没选 schema 时（MySQL/SQLite）不适用，
 * 否则「空串 ≠ public」会把它误判成"不可预览"，整页直接掉进"仅展示 public"的说明里。
 */
export function isSchemaBlocked(schemas: DbSchemaNode[], schema: string): boolean {
  if (!hasSchemaLayer(schemas)) return false
  if (!schema) return false
  const hit = schemas.find(s => s.name === schema)
  // 清单里查不到的 schema 名字（理论上不会发生）按不可预览处理：
  // 与其假装能预览再报错，不如提前说清。
  if (!hit) return true
  return hit.previewable === false
}

/**
 * 选库之后该**自动选中**哪个 schema。
 *
 * 为什么需要自动选中：`tables()` 本来就固定读 public，界面若停在「未选」
 * 就会显示"选了库、还没选 schema"，而实际查的正是 public——界面与事实不一致。
 * 返回 `''` 表示「不自动选」：该引擎没有 schema 层（MySQL/SQLite），
 * 或者一个可预览的都没有（此时由 schemaBlocked 提示说明原因，不假装选好了一个）。
 */
export function defaultSchema(schemas: DbSchemaNode[]): string {
  if (!hasSchemaLayer(schemas)) return ''
  const first = schemas.find(s => s.previewable !== false)
  return first ? first.name : ''
}

/** 当前停在哪一层。**这道判定是本次修复的核心**，测试逐条覆盖。 */
export function dbLevel(i: DbLevelInput): DbLevel {
  if (!i.db) return 'state'
  if (isSchemaBlocked(i.schemas, i.schema)) return 'schemaBlocked'
  // 「表」与「视图」必须分开数：只有视图的库**不算**有表。
  // 此前按 tables.length 判，视图被算进"表"的份里 → 恒进 'tables' 层，
  // 于是 dbHint 里"有 N 个视图、没有表"那条永远走不到（死代码）。
  // 后果：库里全是视图时用户看到"共 1 张表"——那 1 个其实是视图，信息是错的。
  const views = i.tables.filter((t) => t.kind === 'view').length
  if (i.tables.length - views > 0) return 'tables'
  // 清单在途 / 还没查 → 仍算「表这一层」，只是还没拿到东西（由 dbHint 说"正在读"）
  if (i.tablesLoading) return 'tables'
  return 'objects'
}

/** 一条层级提示。`tone` 决定渲染成普通说明还是警示条。 */
export interface DbHint {
  /** 稳定标识：测试与 UI（`data-hint`）都按它定位，避免按文案断言（改一个字就翻红） */
  key: string
  text: string
  tone: 'info' | 'warn'
}

/**
 * 把「层级 + 事实」映射成一句准确的话。
 *
 * 设计原则：**只说这一层能确定的事**。
 * - 还没选库 → 告诉用户下一步动作（选库），不说任何关于表的话
 * - 该库为空 → 说清是「这个库」为空，并给出可做的事（SQL 控制台），而不是一句干巴巴的「无表」
 * - 只有视图 → 说「有 N 个视图但没有表」，因为这多半是视图本身就算对象（不该被判成空库）
 * - schema 不可预览 → 说清是**本版只展示 public**，不能让用户以为那个 schema 是空的
 * - 什么都没选 → 提示下面列表里选一张，并说明行数在哪看
 *
 * 返回 `null` 表示「不显示提示」（例如已选中表、正在展示数据）。
 */
export function dbHint(level: DbLevel, i: DbLevelInput, engine: string): DbHint | null {
  const views = i.tables.filter(t => t.kind === 'view').length
  const tables = i.tables.length - views

  switch (level) {
    case 'state': {
      // 连接到的是「库」这一层。三种引擎的「库」不是同一种东西，措辞要能兼容：
      // MySQL 的库就是库；PG 的库下面还有 schema；SQLite 是文件里的 catalog。
      // 连接级别的库清单本身由外部传入的 `dbs` 展示，这里只说下一步动作。
      return {
        key: 'pick-db',
        text: '先在下方「库」里选一个，才会列出它下面的对象。'
          + (engine === 'sqlite' ? '（SQLite 一般只有 main）' : ''),
        tone: 'info',
      }
    }

    case 'schemaBlocked':
      return {
        key: 'schema-blocked',
        text: `本版只读取 ${engine === 'postgres' ? 'public' : '默认'} schema：schema「${i.schema}」下的对象当前无法列出。`
          + `换到 public 再试，或到「SQL」控制台按 schema 查。`,
        tone: 'warn',
      }

    case 'objects':
      if (i.tables.length === 0) {
        // 这里能确定：**查过了，这一层确实没有可预览的对象**。
        // 不同引擎给不同的下一步——说错了会让人去找一个不存在的入口。
        // 注意别再重复一句"没有表"：前半句已经说了，后半句只负责**下一步**。
        const next = engine === 'sqlite'
          ? '这是面板内建的 SQLite 文件；面板不提供建表入口，可用「SQL」控制台做只读查询'
          : `可到「SQL」控制台确认${engine === 'postgres' ? '（注意本版只读 public）' : ''}`
        return {
          key: 'layer-empty',
          text: `「${i.schema || i.db}」下没有表或视图。${next}。`,
          tone: 'info',
        }
      }
      // 有对象但全是视图：`tables` 里包含了 view，所以这条能命中 → 说明判据没错，
      // 只是数量关系需要说清，否则用户会以为「明明有东西却说我这里没有」。
      return {
        key: 'views-only',
        text: `${i.schema || i.db} 下有 ${views} 个视图、没有表。视图可以在下方列表里直接预览。`,
        tone: 'info',
      }

    case 'tables':
      if (i.tablesLoading) return { key: 'loading', text: '正在读取表清单…', tone: 'info' }
      // 已选中具体表 → 由数据区自己表达，不叠加一句废话
      return {
        key: 'pick-table',
        text: `共 ${tables} 张表${views ? `、${views} 个视图` : ''}，在下方选择要预览的对象；行数取不到时显示为「—」。`,
        tone: 'info',
      }
  }
}

/**
 * 表选择器的一行选项文案。
 *
 * `rows < 0` 是后端**如实**给的「行数取不到」，不是一个能展示的数字。
 * 此前直接渲染成 `-1 行`——那看起来像"负数行"，用户无从判断是出错还是空表。
 */
export function tableOptionLabel(t: { name: string; rows: number; kind?: DbTableKind }): string {
  const name = t.kind === 'view' ? `${t.name}（视图）` : t.name
  return t.rows < 0 ? `${name}（行数未知）` : `${name}（${t.rows} 行）`
}

/**
 * 面包屑：从「连接」到当前层的一条路径。
 *
 * 只包含**真实存在的层**：没有 schema 层（MySQL / SQLite）就只出 库 → 对象，
 * 不为了整齐而补一个 `/`。`current` 指向最后一段（高亮、不可点）。
 */
export function dbCrumbs(i: DbLevelInput): { text: string; current: boolean }[] {
  const out: { text: string; current: boolean }[] = []
  if (i.db) out.push({ text: i.db, current: false })
  if (hasSchemaLayer(i.schemas) && i.schema) out.push({ text: i.schema, current: false })
  if (out.length) out[out.length - 1].current = true
  return out
}
