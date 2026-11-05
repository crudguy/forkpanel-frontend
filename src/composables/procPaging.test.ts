// @vitest-environment node
//
// 纯逻辑测试，不需要 DOM。夹具刻意用**真实进程名形状**（含 systemd 的
// 长名与 www-data 这类带连字符的用户），因为「大小写/连字符是否影响匹配」
// 正是这段代码唯一的出错点。
import { describe, expect, it } from 'vitest'
import {
  PROC_PAGE_SIZE, clampPage, filterProcs, pageCountOf, pageSlice, type ProcLike,
} from './procPaging'

const rows: ProcLike[] = [
  { pid: 1, name: 'systemd', user: 'root' },
  { pid: 12, name: 'nginx', user: 'www-data' },
  { pid: 123, name: 'nginx-debug', user: 'www-data' },
  { pid: 5120, name: 'php-fpm8.4', user: 'www-data' },
  { pid: 9001, name: 'postgres', user: 'postgres' },
  { pid: 9002, name: null, user: null },
]

describe('filterProcs', () => {
  /** 活性自检：夹具空了，下面所有「不包含」类断言都会恒真 */
  it('夹具非空且字段齐全', () => {
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.some((r) => r.name === 'nginx')).toBe(true)
    expect(rows.some((r) => r.name === null)).toBe(true)
  })

  it('空关键字返回同一引用（下游 computed 不应被无谓触发）', () => {
    expect(filterProcs(rows, '')).toBe(rows)
    // 纯空白同样视为「没有筛选」——用户在输入框里按了个空格不该看到空表
    expect(filterProcs(rows, '   ')).toBe(rows)
  })

  it('名称按子串匹配且大小写不敏感', () => {
    expect(filterProcs(rows, 'NGINX').map((r) => r.pid)).toEqual([12, 123])
    expect(filterProcs(rows, 'fpm').map((r) => r.pid)).toEqual([5120])
  })

  it('用户字段也参与匹配', () => {
    expect(filterProcs(rows, 'postgres').map((r) => r.pid)).toEqual([9001])
    expect(filterProcs(rows, 'www-data').map((r) => r.pid)).toEqual([12, 123, 5120])
  })

  it('PID 必须精确匹配：输 12 不该把 123 / 5120 也捞出来', () => {
    expect(filterProcs(rows, '12').map((r) => r.pid)).toEqual([12])
    expect(filterProcs(rows, '123').map((r) => r.pid)).toEqual([123])
    // 反向：如果实现写成 includes，这条会返回 [12, 123]，用例即红
    expect(filterProcs(rows, '12').map((r) => r.pid)).not.toContain(123)
  })

  it('无匹配返回空数组而不是抛错；name/user 为 null 的行不炸', () => {
    expect(filterProcs(rows, 'zzz-not-exist')).toEqual([])
    // 上面 rows 里有一条 name/user 全为 null —— 若不写 `?? ''`，这里会 TypeError
    expect(filterProcs(rows, '9').length).toBe(0)
  })
})

describe('pageCountOf', () => {
  it('0 条也算 1 页（0 页会让「第 1 / 0 页」和永远禁用的下一页按钮）', () => {
    expect(pageCountOf(0)).toBe(1)
  })
  it('恰好整页不多算一页', () => {
    expect(pageCountOf(100)).toBe(1)
    expect(pageCountOf(101)).toBe(2)
  })
  it('后端上限 8192 条 → 82 页（PROC_PAGE_SIZE=100）', () => {
    expect(PROC_PAGE_SIZE).toBe(100)
    expect(pageCountOf(8192)).toBe(82)
  })
  it('size<=0 不得除零', () => {
    expect(pageCountOf(500, 0)).toBe(1)
    expect(Number.isFinite(pageCountOf(500, 0))).toBe(true)
  })
})

describe('pageSlice', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ pid: i + 1, name: `p${i + 1}` }))

  it('第 1 页取前 size 条', () => {
    expect(pageSlice(many, 1).length).toBe(PROC_PAGE_SIZE)
    expect(pageSlice(many, 1)[0].pid).toBe(1)
    expect(pageSlice(many, 1)[99].pid).toBe(100)
  })
  it('第 2 页从 size+1 开始（不是重复第一页）', () => {
    expect(pageSlice(many, 2)[0].pid).toBe(101)
  })
  it('末页不满一页时只返回剩余条数', () => {
    const last = pageSlice(many, 3)
    expect(last.length).toBe(50)
    expect(last[0].pid).toBe(201)
    expect(last[last.length - 1].pid).toBe(250)
  })
  it('越界页返回空数组（不抛错），且与 pageCount 一致', () => {
    expect(pageSlice(many, pageCountOf(many.length) + 1)).toEqual([])
  })
  it('size<=0 退化为全量（不静默返回空表）', () => {
    expect(pageSlice(many, 1, 0).length).toBe(250)
  })
})

describe('clampPage', () => {
  it('下限 1、上限 pageCount', () => {
    expect(clampPage(0, 5)).toBe(1)
    expect(clampPage(-3, 5)).toBe(1)
    expect(clampPage(99, 5)).toBe(5)
  })
  it('非法输入回落 1，而不是把 NaN 传进 slice（slice(NaN) 会静默返回空表）', () => {
    expect(clampPage(Number.NaN, 5)).toBe(1)
    expect(clampPage(Number.POSITIVE_INFINITY, 5)).toBe(1)
  })
  it('小数取整', () => {
    expect(clampPage(2.9, 5)).toBe(2)
  })
  it('pageCount 为 0 时仍返回 1', () => {
    expect(clampPage(1, 0)).toBe(1)
  })
})
