/**
 * 数据表「分页 + 排序」的通用组合式（项目规范，全站表格共用）。
 *
 * 设计目标（与 `procPaging.ts` 同口径，但上升到"每个表格都长一个样"）：
 *  - 分页默认 100 条，可切 10 / 20 / 50 / 100 —— `size` 是响应式变量，不再是写死常量；
 *  - 表头点击排序：升/降切换，且切换后**回到第 1 页**（停在一个内容全变的旧页码无意义）；
 *  - 总数变少（搜索 / 进程退出 / 换页大小）时**夹回**合法页码，不渲染空表；
 *  - 分页纯函数（`pageCountOf` / `pageSlice` / `clampPage`）仍在 `procPaging.ts`，
 *    这里只负责把它们接成响应式 + 维护排序状态，逻辑不重抄（避免两份漂）。
 *
 * 为什么抽组件/组合式而不是继续各页自造：此前 ServicesView / FilesView / ProcessesView
 * 各自实现排序与分页，列宽、页脚、排序指示都长得不一样；新增一个表格就要重造一遍，
 * 还容易漏"换序回第一页"这种自愈路径。现在统一走 `useTableControls` + `TablePager`
 * + `SortTh`，视觉与交互一处改、处处变。
 *
 * 服务端分页的页面（审计 / 数据库）**不用**本组合式算切片——它们自己拉 `{items,total}`，
 * 只复用 `<TablePager>` 把 `size` / `page` 回传到接口即可；`columns` 不传即可（表头不在此处排序）。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { clampPage, pageCountOf, pageSlice } from './procPaging'

/** 全站统一的「每页条数」候选（项目规范） */
export const TABLE_PAGE_SIZES = [10, 20, 50, 100] as const
export type PageSize = (typeof TABLE_PAGE_SIZES)[number]
export type SortDir = 'asc' | 'desc'

/** 一列的排序描述：用什么函数比较两个行对象（数值 / localeCompare 由调用方决定） */
export interface SortColumn<Row> {
  key: string
  /** 首次点该列时的默认方向：数值列默认降序（高占用在前），文本列默认升序 */
  dir: SortDir
  compare: (a: Row, b: Row) => number
}

export interface UseTableControlsOpts<Row> {
  /** 已过滤 / 全量集合（搜索作用在它之外，本组合式只排序 + 切片） */
  rows: Ref<Row[]>
  /** 默认每页条数，缺省 100（沿用进程页历史默认） */
  defaultSize?: number
  /** 初始排序（key 必须在 columns 里） */
  defaultSort?: { key: string; dir?: SortDir }
  /** 可排序的表头描述；不传则不做客户端排序（服务端分页页用不到） */
  columns?: SortColumn<Row>[]
}

export function useTableControls<Row>(opts: UseTableControlsOpts<Row>) {
  const size = ref<number>(opts.defaultSize ?? 100)
  const page = ref(1)
  const sortKey = ref<string | null>(opts.defaultSort?.key ?? null)
  const sortDir = ref<SortDir>(opts.defaultSort?.dir ?? 'asc')
  const columns = opts.columns ?? []
  const colMap = new Map(columns.map((c) => [c.key, c]))

  /** 排序后的全量集合（切片前）。无排序列时原样返回 */
  const sorted = computed<Row[]>(() => {
    const arr = opts.rows.value.slice()
    const key = sortKey.value
    const col = key ? colMap.get(key) : undefined
    if (!col) return arr
    const d = sortDir.value === 'asc' ? 1 : -1
    arr.sort((a, b) => col.compare(a, b) * d)
    return arr
  })

  const total = computed(() => opts.rows.value.length)
  const pageCount = computed(() => pageCountOf(total.value, size.value))
  const pageRows = computed<Row[]>(() => pageSlice(sorted.value, page.value, size.value))

  /** 总数 / 页大小变化夹回页码：否则停在旧页码会渲染空表，用户以为「数据没了」 */
  watch([total, pageCount, size], () => {
    if (page.value > pageCount.value) page.value = pageCount.value
  })

  function toggleSort(key: string) {
    const col = colMap.get(key)
    if (!col) return
    if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    else {
      sortKey.value = key
      sortDir.value = col.dir
    }
    // 换序后停在第 5 页没有意义（那一页内容全变了），统一回第一页
    page.value = 1
  }
  /** 改每页条数：同样回第一页，避免停在越界页 */
  function changeSize(n: number) {
    size.value = n
    page.value = 1
  }
  function gotoPage(p: number) { page.value = clampPage(p, pageCount.value) }
  function next() { gotoPage(page.value + 1) }
  function prev() { gotoPage(page.value - 1) }
  function sortInd(key: string): string {
    if (sortKey.value !== key) return ''
    return sortDir.value === 'asc' ? ' ▲' : ' ▼'
  }
  function isSorted(key: string): boolean { return sortKey.value === key }

  return {
    size, page, sortKey, sortDir, total, pageCount, sorted, pageRows,
    toggleSort, changeSize, gotoPage, next, prev, sortInd, isSorted,
  }
}
