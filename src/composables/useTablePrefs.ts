/**
 * 表格偏好（评估报告 B8 密度切换 + A3 列显隐）。
 *
 * 为什么抽成模块而不是各视图自己写：`localStorage` 键名、默认值、写入时机一旦
 * 重复实现，必然漂移——同一份偏好在 A 页存了、B 页读不到，用户就会觉得"设置
 * 时灵时不灵"。这里只留一处读写，视图只管用。
 *
 * 两个偏好性质不同，故存储粒度也不同：
 * - **密度是全局的**：用户调一次，期望所有表一起变（"我在看进程表，眼睛累"）。
 *   落在 `<html data-density>` 上，由 CSS 变量驱动，全站表格一次性生效——
 *   给每张表加 class 的做法一定会漏掉某几张。
 * - **列显隐是按表的**：站点表关心的列和审计表完全不同，必须各自记忆。
 *
 * 存储失败（隐私模式 / 配额）一律静默：偏好丢了只是回到默认值，不该弹错误。
 */
import { ref, watch, type Ref } from 'vue'

export type TableDensity = 'compact' | 'default' | 'comfy'

/** 每档对应 `--row-py`（单元格上下内边距）。
 *
 * ⚠ 这里只说**内边距**这个精确值，不写「行高约 32px」之类的话：行高 = 内容高 + 2×row-py，
 *   而内容高按表不同（进程表一行纯文本 ~22px；站点表挂了 25px 高的徽章 ~29px），
 *   写成固定行高必然与实机不符——实测默认档站点表是 49px 而非 40px。
 *   文案与行为一致比给一个好看的数字重要。 */
export const DENSITY_OPTIONS: { value: TableDensity; label: string; hint: string }[] = [
  { value: 'compact', label: '紧凑', hint: '上下留白 6px，一屏看更多行' },
  { value: 'default', label: '默认', hint: '上下留白 10px' },
  { value: 'comfy', label: '宽松', hint: '上下留白 14px，长时间阅读更舒服' },
]

const K_DENSITY = 'forkpanel.table.density'
const K_COLS = 'forkpanel.table.cols'
const VALID: TableDensity[] = ['compact', 'default', 'comfy']

function readDensity(): TableDensity {
  try {
    const v = localStorage.getItem(K_DENSITY)
    return (VALID as string[]).includes(v ?? '') ? (v as TableDensity) : 'default'
  } catch {
    return 'default'
  }
}

// 模块级单例：密度是全站共享状态，不能每个视图各持一份 ref（各持一份就会互相覆盖）
const density = ref<TableDensity>(readDensity())

function apply(d: TableDensity) {
  document.documentElement.dataset.density = d
}
apply(density.value)

watch(density, (d) => {
  apply(d)
  try {
    localStorage.setItem(K_DENSITY, d)
  } catch {
    /* 隐私模式 / 配额满：偏好写不进去，本次会话仍生效（已 apply），不打扰用户 */
  }
})

export function useTableDensity() {
  function setDensity(d: TableDensity) {
    density.value = d
  }
  return { density, setDensity }
}

// ────────────────── 列显隐（按表持久化）──────────────────

interface ColsEntry {
  hidden: Ref<string[]>
  defaults: string[]
}

// 按表 key 缓存：同一个 key 多次调用（视图重挂载、两处读同一张表）共享一份状态，
// 否则 A 处勾选、B 处读到的还是旧值。
const colsCache = new Map<string, ColsEntry>()

function loadHidden(key: string, defaults: string[]): string[] {
  try {
    const raw = localStorage.getItem(`${K_COLS}.${key}`)
    if (raw == null) return [...defaults]
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return [...defaults]
    return arr.filter((x): x is string => typeof x === 'string')
  } catch {
    // 存量脏值（手改 / 旧版本格式）不能让整张表报错：回落默认列集
    return [...defaults]
  }
}

/**
 * 某张表的列显隐。
 *
 * @param key  表标识（如 `sites.main`）——同一 key 共享同一份偏好
 * @param defaultHidden 默认隐藏的列 id（如站点表把 4 个次要列收进行展开）
 *
 * 只存「隐藏了哪些」而非「显示了哪些」：新增列时不需要迁移存量偏好，
 * 新列天然可见；反之若存显示集，每次加列都得给所有用户补默认值。
 */
export function useTableCols(key: string, defaultHidden: string[] = []) {
  let entry = colsCache.get(key)
  if (!entry) {
    entry = { hidden: ref(loadHidden(key, defaultHidden)), defaults: [...defaultHidden] }
    colsCache.set(key, entry)
  }
  // 注意：闭包捕获的是本次 entry（缓存命中即同一个），多次调用状态一致
  const { hidden, defaults } = entry

  function persist(v: string[]) {
    try {
      localStorage.setItem(`${K_COLS}.${key}`, JSON.stringify(v))
    } catch {
      /* 同上：写失败只是不记忆，不打扰 */
    }
  }

  function shown(id: string): boolean {
    return !hidden.value.includes(id)
  }
  function toggle(id: string) {
    hidden.value = hidden.value.includes(id)
      ? hidden.value.filter((x) => x !== id)
      : [...hidden.value, id]
    persist(hidden.value)
  }
  function reset() {
    hidden.value = [...defaults]
    persist(hidden.value)
  }
  return { hidden, shown, toggle, reset }
}

// ────────────────── 窄屏断点（表格列显隐用）──────────────────

/** 与 main.css 里 `@media (max-width: 720px)` 同一个值——**两处必须一起改**。 */
const NARROW_MQ = '(max-width: 720px)'

const narrow = ref(window.matchMedia(NARROW_MQ).matches)
// 在模块作用域只挂一次监听（应用生命周期内常驻）：若放视图里，每个视图都要自己
// addEventListener + 在卸载时 removeEventListener，漏摘就是常驻内存的僵尸回调。
window.matchMedia(NARROW_MQ).addEventListener('change', (e) => {
  narrow.value = e.matches
})

/**
 * 当前是否窄屏（≤720px）。
 *
 * 视图为什么需要知道：窄屏下次要列由 CSS `.col-opt` 隐藏，但 **colgroup 的列数 /
 * 行展开的 colspan 必须与"实际渲染的列"一致**——只靠 CSS 隐藏时 JS 仍按全列算，
 * 实测（480px + 全列开启）表格凭空多出 4 个空列、操作列被压到 58px。
 * 故「渲染几列」这件事只能有一个判断源，这里统一出口。
 */
export function useNarrow() {
  return narrow
}
