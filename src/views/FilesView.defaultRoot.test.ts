/**
 * FilesView 的「默认落点 = 白名单第一个目录」守卫。
 *
 * 背景（用户实测反馈）：「用户 1 只授权了 /home，但是现在打开文件，默认是 /
 * 导致没有权限」——`makeTab('/')` 写死根目录，而白名单是 `/home` 时 `/` 会被
 * `resolve_impl` 拒为 50001「路径超出允许范围」。用户一进来就撞红。
 *
 * 修法：`defaultRoot()` 返回白名单第一个目录；空=不限制目录（owner 默认态）⇒ `/`。
 *
 * 判据必须指向被检查的那一份——读 FilesView.vue 源码做断言，而不是自己另写一份
 * 判断逻辑（否则判据自己持有实现，恒绿）。
 *
 * ⚠ 扫描式守卫纪律：**先断言「定义处恰好 N 处」再断言内容**。正则写错＝静默空转。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./FilesView.vue', import.meta.url), 'utf8')

describe('FilesView 默认落点', () => {
  it('defaultRoot 必须存在且取 allowed_roots 第一个（空则 /）', () => {
    // ① 先断言「恰好 1 处定义」
    const defs = SRC.match(/^function defaultRoot\(\): string \{$/gm) ?? []
    expect(defs, 'defaultRoot 定义处应恰好 1（0=失踪，>1=重复）').toHaveLength(1)

    // ② 抽出函数体（到下一个顶层 `}`）
    const start = SRC.indexOf('function defaultRoot(): string {')
    expect(start, '找不到 defaultRoot 起点').toBeGreaterThan(-1)
    const end = SRC.indexOf('\n}', start)
    const body = SRC.slice(start, end)
    // 必须读 auth.me?.allowed_roots
    expect(body, 'defaultRoot 必须读 allowed_roots').toMatch(/allowed_roots/)
    // 必须返回第一个（不是 join / 任意一个）
    expect(body, 'defaultRoot 必须取第一个').toMatch(/roots\[0\]/)
    // 空白名单必须落 /
    expect(body, '空白名单必须落 /').toMatch(/\/'/)
  })

  it('makeTab 初始值必须走 defaultRoot()，不能写死 /', () => {
    // ① 先断言 makeTab **调用**恰好 2 处（初始 tab + 新建标签）。
    //    ⚠ 不能用 `makeTab\([^)]*\)` 直接数——会踩两个坑：
    //      a) 定义 `makeTab(path: string, id?: string)` 也被算上；
    //      b) 注释里解释性的 `makeTab('/')` 也被算上（L90 的 doc comment）；
    //      c) `[^)]*` 遇到 `makeTab(defaultRoot())` 会在内层 `)` 就停，匹配被截断。
    //    解法：只数「不在 // 注释行」且「不是定义」的调用。
    const calls = SRC.split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n')
      .match(/makeTab\([^)]*\)/g) ?? []
    const realCalls = calls.filter((c) => !c.includes('path: string'))
    expect(realCalls, 'makeTab 调用应恰好 2 处（初始 + 新建标签）').toHaveLength(2)

    // ② 初始 tab 那处必须是 defaultRoot()
    const initCalls = calls.filter((c) => c.includes('defaultRoot'))
    expect(initCalls, '初始 tab 必须走 defaultRoot()').toHaveLength(1)

    // ③ 新建标签那处必须沿用 activeTab.value.path（不走 defaultRoot）
    const newTabCalls = calls.filter((c) => c.includes('activeTab.value.path'))
    expect(newTabCalls, '新建标签必须沿用当前标签路径').toHaveLength(1)

    // ④ 负向：代码里不能有 makeTab('/') 这种写死根目录的
    //    ⚠ 只扫代码行——doc comment 里解释「此前写死 /」的 `makeTab('/')` 是合法引用。
    const codeOnly = SRC.split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n')
    expect(codeOnly, '代码里不得写死 makeTab(\'/\')').not.toMatch(/makeTab\('\/'\)/)
    expect(codeOnly, '代码里不得写死 makeTab("/")').not.toMatch(/makeTab\("\/"\)/)
  })

  it('负向对照：把 defaultRoot 退回写死 /，上面两条必须转红', () => {
    // 坏样本 1：defaultRoot 拿掉 allowed_roots 分支
    const bad1 = SRC.replace(
      /function defaultRoot\(\): string \{[\s\S]*?\n\}/,
      "function defaultRoot(): string { return '/' }"
    )
    const body1 = bad1.slice(
      bad1.indexOf('function defaultRoot(): string {'),
      bad1.indexOf('\n}', bad1.indexOf('function defaultRoot(): string {'))
    )
    expect(body1).not.toMatch(/allowed_roots/)
    expect(body1).not.toMatch(/roots\[0\]/)

    // 坏样本 2：初始 tab 退回 makeTab('/')
    const bad2 = SRC.replace(
      'const tabs = ref<FileTab[]>([makeTab(defaultRoot())])',
      "const tabs = ref<FileTab[]>([makeTab('/')])"
    )
    expect(bad2).toMatch(/makeTab\('\/'\)/)
    const initCalls2 = (bad2.match(/makeTab\([^)]*\)/g) ?? []).filter((c) => c.includes('defaultRoot'))
    expect(initCalls2).toHaveLength(0)
  })
})
