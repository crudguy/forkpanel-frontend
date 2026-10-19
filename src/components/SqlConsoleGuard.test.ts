/**
 * 只读 SQL 控制台的**能力位纪律**守卫（源码级）。
 *
 * 为什么需要它：SQL 控制台从"只对 SQLite 开放"扩到 PostgreSQL 后，
 * 最容易出现的回归是前端把门控**退回硬编码引擎判断**——
 * `:disabled="c.engine === 'sqlite'"`。那种写法编译、类型、构建全绿，
 * 但后端明天给 MySQL 加了护栏，前端依然置灰，用户白白用不上已能用的功能
 * （置灰是前端单方面的承诺，后端没有任何东西阻止它失效）。
 *
 * 因此这条纪律必须有守卫钉住：**门控只能引用后端下发的 `readonly_sql`**。
 *
 * 同类防线还有：
 * - 后端 `panel_os::db_console_open` 全矩阵测试（引擎 × 客户端在位）；
 * - 后端 `sql_console_meta` 串味测试（PG 示例里不得出现 sqlite_master）。
 * 三层各自守住一段，任何一层单独失效都不会静默放行。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

// 测试文件位于 src/components/，故 '..' 即 src/；下方路径一律相对 src/ 传，
// 不能再带 src/ 前缀（否则拼成 src/src/...，ENOENT）。
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')

/** 剥掉注释行：纪律说明里本身就会出现 `engine === 'sqlite'` 这类字样，
 *  不剥就会把"注释在讲这件事"误判成"代码真这么写了"（恒绿陷阱的经典形态）。 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

/** 剥掉表达式内的**单引号**字符串字面量：置灰理由的文案里**合法地**会出现
 *  「MySQL 暂不支持」，但"代码里按引擎二选一"必须被抓住。剥掉引号内容后，
 *  `engine === 'sqlite'` 仍留下 `engine === `，而文案只剩空串——
 *  这样反向断言盯的是代码，不会把用户提示文案误判成硬判（也不会漏放真硬判）。
 *
 *  ⚠ 双引号**绝不能剥**：模板里 `:disabled="…"` 的双引号是属性定界符、
 *  不是代码字面量。剥双引号会把整个表达式连窝端成空串，反向断言被清空 →
 *  恒绿（比误判更糟：看似通过，实则什么都没查）。这是本轮 NC13 实测踩到的：
 *  第一版 stripStrings 剥了双引号，注入 `c.engine === 'sqlite'` 后测试照样全绿。 */
function stripStrings(src: string): string {
  return src.replace(/'[^']*'/g, "''")
}

/**
 * 取出 SQL 按钮那一段完整模板（从 `<button` 开标签到 `</button>`）。
 *
 * **必须限定区域**：对整个文件做 `expect(src).toContain('engine')` 是恒真的——
 * 表单里的"主机/数据库文件"切换本来就合法地用着 `engine === 'sqlite'`。
 * 断言要落在"这一个按钮"上，否则要么恒绿、要么误伤合法用法。
 *
 * 锚点取 `terminal` 图标（SQL 按钮独有），再**往前**找最近的 `<button`：
 * 属性（`:disabled` 等）写在开标签上、位于图标之前，只从图标开始切会切空。
 * `at - open` 的上界是防跑偏——万一哪天 terminal 图标被挪到别处，
 * `lastIndexOf` 会一路吃到几十行外的另一个按钮，那时应当响亮地失败，
 * 而不是安静地检查了一个错误的块。
 */
function sqlButtonBlock(src: string): string {
  const at = src.indexOf('name="terminal"')
  expect(at, 'DatabasesView 里应存在 SQL 按钮（terminal 图标）').toBeGreaterThan(-1)
  const open = src.lastIndexOf('<button', at)
  expect(open, 'terminal 图标前应有 <button 开标签').toBeGreaterThan(-1)
  expect(at - open, 'terminal 图标必须紧邻本按钮的开标签（防吃到别的按钮）').toBeLessThan(500)
  const end = src.indexOf('</button>', at)
  expect(end, 'SQL 按钮应有闭合标签').toBeGreaterThan(at)
  return src.slice(open, end)
}

describe('SQL 控制台门控只用后端能力位', () => {
  it('SQL 按钮的 disabled 引用 readonly_sql，且不出现引擎硬判', () => {
    const block = stripComments(sqlButtonBlock(read('views/DatabasesView.vue')))
    // 正向（看原始代码）：门控读的是后端下发的能力位
    expect(block).toMatch(/:disabled="[^"]*readonly_sql/)
    // 反向（看剥掉字符串字面量后的代码）：这一段里不得出现任何引擎判断。
    // 合法用法（表单的"数据库文件 vs 库名"切换）在文件别处，不受此约束；
    // 置灰文案里的引擎名（"MySQL 暂不支持"）由 stripStrings 剥掉，不算数。
    const code = stripStrings(block)
    expect(code).not.toMatch(/engine/)
    expect(code).not.toMatch(/sqlite|mysql|postgres/i)
  })

  it('SQL 按钮的 title 也不含引擎硬判（置灰理由同样由能力位驱动）', () => {
    const block = stripComments(sqlButtonBlock(read('views/DatabasesView.vue')))
    expect(block).not.toMatch(/:title="[^"]*engine/)
  })

  it('控制台默认语句来自后端 sql-meta，不写死某一引擎的 SQL', () => {
    const src = stripComments(read('components/SqlConsole.vue'))
    // 默认值必须由后端下发（meta.default_sql），初始化为空串而不是某句写死的 SQL
    expect(src).toMatch(/sql\s*=\s*ref\(''\)/)
    expect(src).toMatch(/sql\.value\s*=\s*meta\.value\.default_sql/)
    // 反向：文件里不得再出现写死的 sqlite_master 默认语句
    expect(src).not.toMatch(/ref\("SELECT name FROM sqlite_master/)
    // 也不得出现按引擎二选一的写死默认值（那是把引擎知识搬回前端）
    expect(src).not.toMatch(/engine\s*===\s*'(sqlite|postgres|mysql)'/)
  })

  it('控制台通过 sql-meta 端点取能力位与示例', () => {
    const src = stripComments(read('components/SqlConsole.vue'))
    expect(src).toMatch(/API\.db\.sqlMeta\(/)
    // 示例按钮渲染自 meta.samples，而非本地常量数组
    expect(src).toMatch(/meta\?\.samples\s*&&|\?\?\s*\[\]/)
    expect(src).not.toMatch(/const SAMPLES/)
  })

  it('Conn 类型带 readonly_sql 字段（与后端 ConnDto 对齐）', () => {
    const src = stripComments(read('views/DatabasesView.vue'))
    expect(src).toMatch(/readonly_sql:\s*boolean/)
  })
})
