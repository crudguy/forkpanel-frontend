/**
 * 命令面板的纯逻辑：从路由表生成候选 + 模糊过滤。
 *
 * 为什么从 `router.getRoutes()` 生成而不是手抄一份 NAV_ITEMS：
 * 手抄清单必然漂移——新增 Tab、改名、重定向都会让面板里出现点不到的假入口，
 * 而"命令面板里有但点不开"比"没有命令面板"更伤信任。路由表是唯一事实源。
 */
export interface RouteLike {
  name?: unknown
  path: string
  meta?: { title?: unknown } | unknown
  /** 重定向记录没有 name，会被 buildCommands 自然过滤；此处仅为类型兼容 */
  redirect?: unknown
}

export interface CommandItem {
  name: string
  title: string
  path: string
}

/** 登录页/404/带参数的详情页不入面板：前者无布局壳，后两者无法直接跳转。 */
const EXCLUDED = new Set(['login', 'not-found', 'service-detail'])

export function buildCommands(routes: readonly RouteLike[]): CommandItem[] {
  const seen = new Set<string>()
  const out: CommandItem[] = []
  for (const r of routes) {
    if (typeof r.name !== 'string' || EXCLUDED.has(r.name)) continue
    const meta = (r.meta ?? {}) as { title?: unknown }
    if (typeof meta.title !== 'string' || !meta.title) continue
    const path = r.path
    // 重定向记录没有 name（上面已排除）；动态段路径即使有 name 也不能跳
    if (!path.startsWith('/') || path.includes(':')) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ name: r.name, title: meta.title, path })
  }
  return out
}

/**
 * 空格分词后全部命中才返回（AND）；标题前缀 > 标题包含 > 路径/路由名包含。
 * 标题与路径都搜，"audit" 和 "审计" 都能找到审计日志。
 */
export function filterCommands(items: readonly CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  const terms = q.split(/\s+/)
  return items
    .map((it) => {
      const title = it.title.toLowerCase()
      const path = it.path.toLowerCase()
      const name = it.name.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (title.startsWith(t)) score += 3
        else if (title.includes(t)) score += 2
        else if (path.includes(t) || name.includes(t)) score += 1
        else return null
      }
      return { it, score }
    })
    .filter((x): x is { it: CommandItem; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it)
}
