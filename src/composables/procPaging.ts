/**
 * 进程列表的搜索 / 分页纯逻辑（Q-10）。
 *
 * 为什么单独成文件而不是留在 `ProcessesView.vue` 里：本仓库的 vitest 只收
 * `src/**\/*.test.ts` 且没装 vue 插件，住在 `.vue` 里的 computed 无法直接断言——
 * 而这里恰恰是最需要断言的部分（页码夹取、末页不满一页、搜索把结果缩到 0 条）。
 * 抽出来是**等价搬运**：表达式与 `.vue` 里原来的写法逐字一致。
 *
 * 页面侧只负责把 computed 接上（`filtered` / `pageRows` / `pageCount`），
 * 接线由 `ProcessesView.paging.test.ts` 的源码守卫钉住。
 */

/** 每页行数。100 行的整表 patch 约 7ms（实测口径见 ProcessesView 里 PAGE_SIZE 上方） */
export const PROC_PAGE_SIZE = 100

/** 搜索/排序只需要这三个字段；用泛型而非耦合 ProcessInfo，便于夹具构造 */
export interface ProcLike {
  pid: number
  name?: string | null
  user?: string | null
}

/**
 * 按关键字过滤：名称与用户做**大小写不敏感的子串匹配**，PID 做**精确**匹配。
 *
 * PID 用精确匹配而不是子串：输入 `12` 时若命中 123、1200、512，用户会以为
 * 筛选坏了——PID 是标识符不是文本，找 12 号进程就该只看到 12 号。
 * 空关键字（或纯空白）返回原数组**同一引用**，让 `computed` 的下游保持稳定。
 */
export function filterProcs<T extends ProcLike>(rows: T[], q: string): T[] {
  const k = q.trim().toLowerCase()
  if (!k) return rows
  return rows.filter((p) =>
    (p.name ?? '').toLowerCase().includes(k)
    || (p.user ?? '').toLowerCase().includes(k)
    || String(p.pid) === k,
  )
}

/**
 * 总页数。**至少 1 页**：0 条进程时若算出 0 页，分页栏会显示「第 1 / 0 页」，
 * 且「下一页」的 `page >= pageCount` 判据会变成永远禁用——虽然此时分页栏因
 * 「总数不够一页」不渲染，但 `pageCount` 也会被别处引用，留个 0 迟早出事。
 */
export function pageCountOf(total: number, size: number = PROC_PAGE_SIZE): number {
  if (size <= 0) return 1
  return Math.max(1, Math.ceil(total / size))
}

/** 取第 page 页（1 起）的切片；越界页返回空数组，不抛错 */
export function pageSlice<T>(rows: T[], page: number, size: number = PROC_PAGE_SIZE): T[] {
  if (size <= 0) return rows
  const from = (page - 1) * size
  if (!Number.isFinite(from) || from < 0) return rows.slice(0, size)
  return rows.slice(from, from + size)
}

/** 把页码夹回 [1, pageCount]：进程退出导致总数变少时，停在旧页码会渲染空表 */
export function clampPage(p: number, pageCount: number): number {
  if (!Number.isFinite(p)) return 1
  return Math.min(Math.max(1, Math.floor(p)), Math.max(1, pageCount))
}
