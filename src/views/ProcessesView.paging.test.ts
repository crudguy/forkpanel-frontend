// @vitest-environment node
//
// ProcessesView 的分页 / 排序接线守卫。
//
// 为什么必须源码级钉住：`procPaging.ts` 与 `useTableControls.ts` 的纯逻辑单测覆盖了
// 「算得对」，但覆盖不到「页面有没有真的用上它们」——把 `<tr v-for="p in pageRows">`
// 改回 `sorted`，或把分页脚换成没接 `changeSize` 的裸按钮，所有纯逻辑单测照样全绿，
// 唯一症状是 8192 个进程时每 3 秒卡 2 秒、或每页条数选择框只是个摆设。
//
// 断言前**剔除注释**：本文件旁就有一大段解释「为什么不用虚拟滚动」的注释，里面提到
// `v-table-nav`、`PAGE_SIZE` 等词。若不剔注释，把实现改坏后仍能从注释里 grep 到关键字
// 而恒绿——本项目踩过「活性自检被同文件测试字符串喂饱」。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const RAW = readFileSync(resolve(process.cwd(), 'src/views/ProcessesView.vue'), 'utf-8')
const CTRL = readFileSync(resolve(process.cwd(), 'src/composables/useTableControls.ts'), 'utf-8')

/** 剔除 HTML 注释 / 块注释 / 整行行注释；本文件没有含 `//` 的字符串字面量，故安全 */
function stripComments(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const SRC = stripComments(RAW)
const CTRLSRC = stripComments(CTRL)

describe('ProcessesView 分页 / 排序接线', () => {
  it('活性自检：扫到的是真文件，且注释确实被剔掉了', () => {
    expect(RAW.length).toBeGreaterThan(10_000)
    // 证明扫的是 ProcessesView 而不是别的视图
    expect(SRC).toContain('API.processes.list()')
    expect(SRC).toContain('v-table-nav')
    // 剔注释生效：剔完必须比原文短（否则正则失效，下面所有断言都会变成扫全文）
    expect(SRC.length).toBeLessThan(RAW.length)
  })

  it('表格渲染的是分页切片，不是全量排序结果', () => {
    expect(SRC).toContain('v-for="p in pageRows"')
    // 退回全量的确切写法：这一行在就是 8192 行全渲染 + 每 3s 卡 2 秒
    expect(SRC).not.toContain('v-for="p in sorted"')
    expect(SRC).not.toContain('v-for="p in procs"')
    // 切片来自共享组合式的 pageRows（逻辑不许内联回 .vue）
    expect(SRC).toContain('useTableControls<Proc>(')
  })

  it('分页脚用共享 TablePager 且每页条数可切换（10/20/50/100 由组合式统一）', () => {
    expect(SRC).toContain('<TablePager')
    // 页脚把页码与每页条数都回传给组合式：否则下拉框只是个摆设
    expect(SRC).toContain('@update:page="gotoPage"')
    expect(SRC).toContain('@update:size="changeSize"')
    // 默认每页 100（沿用进程页历史默认），且只在一页以上才显示分页脚
    expect(SRC).toContain('defaultSize: 100')
    expect(SRC).toContain('v-if="filtered.length > size"')
  })

  it('搜索框绑定到 q', () => {
    expect(SRC).toContain('v-model="q"')
  })

  it('两条自愈路径都在：换排序回第一页 / 总数变少时夹回页码（逻辑在共享组合式）', () => {
    // 换序 / 改每页条数后回第一页——删掉会让用户停在一个内容全变的旧页码上。
    // 这段逻辑已抽到 useTableControls，守卫要去那里钉，而不是在页面里找。
    const from = CTRLSRC.indexOf('function toggleSort')
    const to = CTRLSRC.indexOf('function changeSize')
    expect(from, '没找到 toggleSort（判据前提不成立）').toBeGreaterThan(-1)
    expect(to, '没找到 changeSize（区间右界失效）').toBeGreaterThan(from)
    const body = CTRLSRC.slice(from, to)
    expect(body, '换排序后没有回到第 1 页').toContain('page.value = 1')

    // 总数变少 → 停在旧页码就是空表，用户以为「进程都没了」
    expect(CTRLSRC).toContain('if (page.value > pageCount.value) page.value = pageCount.value')
  })

  it('空态区分「没有匹配」与「无数据」', () => {
    expect(SRC).toContain("q.trim() ? '没有匹配的进程' : '无进程数据'")
  })
})
