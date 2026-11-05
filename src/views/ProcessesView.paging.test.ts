// @vitest-environment node
//
// ProcessesView 的分页接线守卫。
//
// 为什么必须源码级钉住：`procPaging.ts` 的 19 条单测覆盖了**纯逻辑**，但覆盖不到
// 「页面有没有真的调它」——把 `<tr v-for="p in pageRows">` 改回 `sorted`，
// 所有单测照样全绿，唯一症状是 8192 个进程时每 3 秒卡 2 秒（面板不会报错、
// 构建也不会失败）。这类"功能完全正确、性能静默退回"的改动只能靠接线断言。
//
// 断言前**剔除注释**：本文件旁边就有一大段解释「为什么不用虚拟滚动」的注释，
// 里面提到 `v-table-nav`、`PAGE_SIZE` 等词。若不剔注释，把实现改坏后仍能
// 从注释里 grep 到关键字而恒绿——本项目踩过「活性自检被同文件测试字符串喂饱」。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const RAW = readFileSync(resolve(process.cwd(), 'src/views/ProcessesView.vue'), 'utf-8')

/** 剔除 HTML 注释 / 块注释 / 整行行注释；本文件没有含 `//` 的字符串字面量，故安全 */
function stripComments(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const SRC = stripComments(RAW)

describe('ProcessesView 分页接线', () => {
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
  })

  it('三个 computed 都走 procPaging 的纯函数（逻辑不许留在 .vue 里）', () => {
    expect(SRC).toContain('filterProcs(sorted.value, q.value)')
    expect(SRC).toContain('pageCountOf(filtered.value.length, PROC_PAGE_SIZE)')
    expect(SRC).toContain('pageSlice(filtered.value, page.value, PROC_PAGE_SIZE)')
    expect(SRC).toContain('clampPage(p, pageCount.value)')
    // 反例：留着内联 slice 说明有人把逻辑又抄回来了一份（两份迟早漂）
    expect(SRC).not.toContain('filtered.value.slice(')
  })

  it('分页条只在超过一页时出现，且带上下页按钮', () => {
    expect(SRC).toContain('v-if="filtered.length > PROC_PAGE_SIZE"')
    expect(SRC).toContain('@click="gotoPage(page - 1)"')
    expect(SRC).toContain('@click="gotoPage(page + 1)"')
  })

  it('搜索框绑定到 q', () => {
    expect(SRC).toContain('v-model="q"')
  })

  it('两条自愈路径都在：换排序回第一页 / 总数变少时夹回页码', () => {
    // ⚠ 这条断言必须限定在 toggleSort 的函数体里：
    // `page.value = 1` 在 `watch(q, ...)` 里也有一次，用全文 toContain 的话
    // 删掉 toggleSort 里那行仍然命中 → **恒绿**（本项目「空集恒真 / 断言指错对象」
    // 这一类错误）。区间右界用代码锚点而不是注释（注释已被 stripComments 剔掉）。
    const from = SRC.indexOf('function toggleSort')
    const to = SRC.indexOf('const q = ref')
    expect(from, '没找到 toggleSort（判据前提不成立）').toBeGreaterThan(-1)
    expect(to, '没找到 const q = ref（区间右界失效）').toBeGreaterThan(from)
    const toggleSortBody = SRC.slice(from, to)
    expect(toggleSortBody, '换排序后没有回到第 1 页：用户会停在一个内容全变的旧页码上')
      .toContain('page.value = 1')

    // 进程退出导致页数变少 → 停在旧页码就是空表，用户以为「进程都没了」
    expect(SRC).toContain('if (page.value > pageCount.value) page.value = pageCount.value')
  })

  it('空态区分「没有匹配」与「无数据」', () => {
    expect(SRC).toContain("q.trim() ? '没有匹配的进程' : '无进程数据'")
  })
})
