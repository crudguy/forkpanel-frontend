// @vitest-environment node
//
// F-18 后半的接线守卫：**写后重载必须被 await**。
//
// 为什么这几处只能源码断言：去掉 `await` 后唯一的差别是「busy 早解除几微秒」，
// 而假件的路由函数是在 fetch 调用的**同步阶段**跑的，此刻 finally 还没执行——
// 用 DOM 读不出区别。FirewallView 那一处用延迟响应把窗口撑开做了真行为测试
// （`FirewallView.writeFeedback.behavior.test.ts` 的「重载还没回来之前不许解除 busy」）；
// 其余几处的重载在测试里瞬间完成，行为层确实不可区分。
//
// 判据必须指向**被检查的那一份**：先按函数名切出函数体，只在函数体内断言。
// 绝不能用全文 `toContain('await load(')`——只要有一处 await，全身都能绿
// （本项目的「恒绿守卫」头号成因就是判据指向错对象）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf-8')
}

/** 剔除 HTML 注释 / 块注释 / 整行行注释：注释里出现 `load(` 会喂饱下面的断言。 */
function stripComments(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const FW_RAW = read('src/views/FirewallView.vue')
const FW = stripComments(FW_RAW)
const CERT = stripComments(read('src/views/CertsView.vue'))
const TASK = stripComments(read('src/views/TasksView.vue'))

/** 顶层函数体：从 `function <name>(` 到行首那个 `}`（嵌套块都带缩进，不会误截）。 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到 function ${name}（守卫前提不成立）`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`找不到 ${name} 的结束花括号`)
  return src.slice(start, end)
}

/** 未被 await 的 `load(`：前面不是 `await `。`loadSilent(` 不含 `load(`，不会误判。 */
const UNAWAITED_LOAD = /(?<!await )\bload\(/

const SITES: Array<[string, string, string]> = [
  ['FirewallView', 'apply', FW],
  ['FirewallView', 'setActive', FW],
  ['FirewallView', 'doDelete', FW],
  ['CertsView', 'setAutoRenew', CERT],
  ['CertsView', 'doDeleteCert', CERT],
  ['CertsView', 'execSsl', CERT],
  ['TasksView', 'cancel', TASK],
]

describe('F-18 后半 接线守卫（写后重载必须被 await）', () => {
  it('活性自检：抽取器与「未 await」正则都真的在工作', () => {
    const body = fnBody(FW, 'apply')
    expect(body.length).toBeGreaterThan(200)
    expect(body).toContain('api.post')
    // 正则自身：能抓到裸调用，且不误伤已 await 的写法（否则下面每条都恒绿）
    expect(UNAWAITED_LOAD.test('\n  load()\n')).toBe(true)
    expect(UNAWAITED_LOAD.test('\n  await load()\n')).toBe(false)
    // 剔注释生效：剔完必须比原文短，否则注释里的 `load(` 会喂饱断言
    expect(FW.length).toBeLessThan(FW_RAW.length)
  })

  it.each(SITES)('%s.%s 里的 load 调用全部带 await', (_file, fn, src) => {
    const body = fnBody(src, fn)
    expect(body, `${fn} 里没有 await load：写后重载不会阻塞 busy，能给重复提交留窗口`)
      .toContain('await load(')
    expect(UNAWAITED_LOAD.test(body), `${fn} 里还有未 await 的 load 调用`).toBe(false)
  })
})
