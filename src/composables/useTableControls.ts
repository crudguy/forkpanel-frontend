/**
 * 数据表「分页 + 排序」的通用组合式（项目规范，全站表格共用）。
 *
 * 设计目标（与 `procPaging.ts` 同口径，但上升到"每个表格都长一个样"）：
 *  - 分页默认 100 条，可切 10 / 20 / 50 / 100 或「全部」（不分页整表展示）——
 *    `size` 是响应式变量，不再是写死常量；
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
 *
 * 适用范围（项目规范）：**记录列表**——行数随数据增长、按列可比的集合。纯 KV / 详情 /
 * 实时指标表（设置项、容器统计、compose 详情）不加分页也不加表头排序：给固定 6 行的
 * 表配「第 1/1 页」只是噪音，还会把 `--row-py` 省下的空间又吃回去。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { clampPage, pageCountOf, pageSlice } from './procPaging'

/** 全站统一的「每页条数」候选（项目规范） */
export const TABLE_PAGE_SIZES = [10, 20, 50, 100] as const
export type PageSize = (typeof TABLE_PAGE_SIZES)[number]
export type SortDir = 'asc' | 'desc'

/**
 * 「全部」哨兵：作为每页条数时表示不分页、整表一次展示。
 *
 * 取一个足够大的有限值（而非 0 / -1）是关键：`pageCountOf(total, ALL)` 天然算成 1 页、
 * `pageSlice(rows, 1, ALL)` 天然返回整表，两条分页纯函数**一行都不用改**；同时 0 与负数
 * 仍被 `changeSize` 判为非法（存量脏值/误调用不会把表撑爆）。「全部」是独立选项而不是
 * 塞进 `TABLE_PAGE_SIZES`——那四档是「真实行数」的候选，混进哨兵会让档位断言与
 * `Math.min(...sizes)` 的可见性门槛一起失真。
 */
export const PAGE_SIZE_ALL = Number.MAX_SAFE_INTEGER

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
  /** 记忆键：给了就把「每页条数」按表存进 localStorage，下次进来还是用户选的那档 */
  persistKey?: string
}

const K_SIZE = 'forkpanel.table.size'

/** 读回用户上次选的每页条数；只认 [10,20,50,100] 与「全部」哨兵（存量脏值不能把表撑爆） */
function readSize(key: string | undefined, fallback: number): number {
  if (!key) return fallback
  try {
    const raw = Number(localStorage.getItem(`${K_SIZE}.${key}`))
    // 「全部」也要认得：用户特意选了整表展示，下次进来不能被悄悄改回 100
    return raw === PAGE_SIZE_ALL || (TABLE_PAGE_SIZES as readonly number[]).includes(raw) ? raw : fallback
  } catch {
    return fallback
  }
}

function writeSize(key: string | undefined, v: number) {
  if (!key) return
  try {
    localStorage.setItem(`${K_SIZE}.${key}`, String(v))
  } catch {
    /* 隐私模式 / 配额满：不记忆而已，本次会话仍然生效，不打扰用户 */
  }
}

export function useTableControls<Row>(opts: UseTableControlsOpts<Row>) {
  const size = ref<number>(readSize(opts.persistKey, opts.defaultSize ?? 100))
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
  /** 改每页条数：同样回第一页，避免停在越界页；非法值（0 / 负数 / NaN）直接忽略 */
  function changeSize(n: number) {
    if (!Number.isFinite(n) || n <= 0) return
    size.value = n
    page.value = 1
    writeSize(opts.persistKey, n)
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
