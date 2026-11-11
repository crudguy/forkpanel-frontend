// @vitest-environment jsdom
//
// 共享分页/排序组合式的单测。
//
// 为什么这些断言必须存在：`useTableControls` 现在是**全站每张表**的底座，四条自愈路径
// （换序回第 1 页、改每页条数回第 1 页、总数变少夹回页码、脏偏好回落默认值）任何一条
// 断掉，症状都是「表格看起来正常，但翻到第 5 页后换排序，人还停在一个内容全变的位置」
// ——构建、tsc、其它页的守卫都不会红。这里逐条钉死。
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { useTableControls, TABLE_PAGE_SIZES, type SortColumn } from './useTableControls'

interface Row { id: number; name: string; n: number }

const mk = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `r${String(i + 1).padStart(3, '0')}`, n: i + 1 }))

const cols: SortColumn<Row>[] = [
  { key: 'name', dir: 'asc', compare: (a, b) => a.name.localeCompare(b.name) },
  { key: 'n', dir: 'desc', compare: (a, b) => a.n - b.n },
]

beforeEach(() => {
  localStorage.clear()
})

describe('useTableControls：分页', () => {
  it('默认每页 100 条、停在第 1 页', () => {
    const rows = ref(mk(250))
    const t = useTableControls({ rows, columns: cols })
    expect(t.size.value).toBe(100)
    expect(t.page.value).toBe(1)
    expect(t.pageCount.value).toBe(3)
    expect(t.pageRows.value).toHaveLength(100)
    expect(t.pageRows.value[0].id).toBe(1)
  })

  it('换每页条数后立刻回第 1 页，且切片跟着变', () => {
    const rows = ref(mk(250))
    const t = useTableControls({ rows, columns: cols })
    t.gotoPage(3)
    expect(t.page.value).toBe(3)
    t.changeSize(10)
    expect(t.size.value).toBe(10)
    expect(t.page.value).toBe(1)
    expect(t.pageRows.value).toHaveLength(10)
    expect(t.pageCount.value).toBe(25)
  })

  it('非法页大小被忽略（0 / 负数 / NaN 不能把表清空）', () => {
    const rows = ref(mk(30))
    const t = useTableControls({ rows, columns: cols })
    t.changeSize(0)
    t.changeSize(-5)
    t.changeSize(Number.NaN)
    expect(t.size.value).toBe(100)
    expect(t.pageRows.value).toHaveLength(30)
  })

  it('总数变少时页码夹回最后一页（不渲染空表）', async () => {
    const rows = ref(mk(250))
    const t = useTableControls({ rows, columns: cols })
    t.gotoPage(3)
    rows.value = mk(120) // 3 页 → 2 页
    await nextTick()
    expect(t.pageCount.value).toBe(2)
    expect(t.page.value).toBe(2)
    expect(t.pageRows.value).toHaveLength(20)
  })

  it('页码越界被夹住：gotoPage(999) 落在末页，gotoPage(0) 落在首页', () => {
    const rows = ref(mk(250))
    const t = useTableControls({ rows, columns: cols })
    t.gotoPage(999)
    expect(t.page.value).toBe(3)
    t.gotoPage(0)
    expect(t.page.value).toBe(1)
  })

  it('0 条数据时仍算 1 页，切片为空数组（页码不会是 0，分页栏不会自己消失出错）', () => {
    const t = useTableControls({ rows: ref<Row[]>([]), columns: cols })
    expect(t.total.value).toBe(0)
    expect(t.pageCount.value).toBe(1)
    expect(t.pageRows.value).toEqual([])
  })
})

describe('useTableControls：排序', () => {
  it('首次点某列用该列的默认方向，再点切反，第三次回到原方向', () => {
    const t = useTableControls({ rows: ref(mk(5)), columns: cols })
    t.toggleSort('n') // 数值列默认降序
    expect(t.sortKey.value).toBe('n')
    expect(t.sortDir.value).toBe('desc')
    expect(t.sorted.value.map((r) => r.n)).toEqual([5, 4, 3, 2, 1])
    t.toggleSort('n')
    expect(t.sortDir.value).toBe('asc')
    expect(t.sorted.value.map((r) => r.n)).toEqual([1, 2, 3, 4, 5])
  })

  it('切到另一列时，方向取新列自己的默认值而不是沿用上一列', () => {
    const t = useTableControls({ rows: ref(mk(5)), columns: cols })
    t.toggleSort('n') // desc
    t.toggleSort('name') // 文本列默认 asc
    expect(t.sortDir.value).toBe('asc')
    expect(t.sortKey.value).toBe('name')
  })

  it('排序后回到第 1 页（停在第 3 页看换过序的数据毫无意义）', () => {
    const rows = ref(mk(250))
    const t = useTableControls({ rows, columns: cols })
    t.gotoPage(3)
    t.toggleSort('n')
    expect(t.page.value).toBe(1)
  })

  it('未登记的列不参与排序：点它不改变任何状态（防止拼错 key 静默失效）', () => {
    const t = useTableControls({ rows: ref(mk(5)), columns: cols, defaultSort: { key: 'name' } })
    t.toggleSort('nmae')
    expect(t.sortKey.value).toBe('name')
  })

  it('不传 columns 时不排序，原顺序返回', () => {
    const t = useTableControls({ rows: ref(mk(5)) })
    expect(t.sorted.value.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
    expect(t.isSorted('n')).toBe(false)
  })

  it('isSorted / sortInd 与当前列一致', () => {
    const t = useTableControls({ rows: ref(mk(3)), columns: cols, defaultSort: { key: 'n', dir: 'desc' } })
    expect(t.isSorted('n')).toBe(true)
    expect(t.isSorted('name')).toBe(false)
    expect(t.sortInd('n')).toBe(' ▼')
    t.toggleSort('n')
    expect(t.sortInd('n')).toBe(' ▲')
    expect(t.sortInd('name')).toBe('')
  })
})

describe('useTableControls：每页条数记忆（persistKey）', () => {
  it('写入后新实例能读回同一档位', () => {
    const t1 = useTableControls({ rows: ref(mk(50)), columns: cols, persistKey: 'sites.main' })
    t1.changeSize(20)
    const t2 = useTableControls({ rows: ref(mk(50)), columns: cols, persistKey: 'sites.main' })
    expect(t2.size.value).toBe(20)
  })

  it('不同表互不影响（键名带表标识）', () => {
    useTableControls({ rows: ref(mk(50)), columns: cols, persistKey: 'a' }).changeSize(10)
    const b = useTableControls({ rows: ref(mk(50)), columns: cols, persistKey: 'b' })
    expect(b.size.value).toBe(100)
  })

  it('存量脏值（不在 [10,20,50,100] 里）回落 defaultSize，不把表撑成 9999 行', () => {
    localStorage.setItem('forkpanel.table.size.sites.main', '9999')
    const t = useTableControls({ rows: ref(mk(50)), columns: cols, persistKey: 'sites.main', defaultSize: 50 })
    expect(t.size.value).toBe(50)
  })

  it('非数字的存量值同样回落默认值', () => {
    localStorage.setItem('forkpanel.table.size.sites.main', 'abc')
    const t = useTableControls({ rows: ref(mk(50)), columns: cols, persistKey: 'sites.main' })
    expect(t.size.value).toBe(100)
  })

  it('候选档位就是规范里的四档', () => {
    expect([...TABLE_PAGE_SIZES]).toEqual([10, 20, 50, 100])
  })
})
