/**
 * 文件列表的**本地过滤**语义（单一事实源）。
 *
 * ## 为什么是本地过滤而不是走后端
 * `list` 接口没有 search 参数，且它本身有 1000 项截断——给后端加搜索会引出
 * 「搜索是否也受截断」「匹配的是全库还是当前目录」一连串语义问题，而用户在
 * 文件管理器里要的只是「在这个已经看到的目录里快速找到某项」。本地过滤足够，
 * 且零接口变更。
 *
 * ## 三条硬语义（写进测试，别在这之外臆造）
 * 1. **只筛选、不排序**：目录优先的既有顺序由后端 `dirs_first` 决定，过滤只是
 *    在原顺序上挑子集。任何重排都会让「第几行」与用户预期脱节。
 * 2. **大小写不敏感的子串匹配**：文件名搜索的通行预期；不做前缀优先、不做模糊。
 *    查询串首尾空白会 trim——用户从别处粘贴时几乎总带空格。
 * 3. **空查询 / 纯空白 = 不过滤**：返回原数组本身（同一个引用），
 *    调用方可用 `filtered === entries` 判断「当前没有过滤」，无需再比长度。
 */

export interface FilterableEntry {
  name: string
  kind: string
  sensitive: boolean
}

/** 规范化查询串：trim + 小写。空串表示「不过滤」。 */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}

/**
 * 按查询串过滤条目。
 *
 * @returns 查询为空时返回**入参数组本身**（引用相等），否则返回新数组。
 */
export function filterEntries<T extends FilterableEntry>(entries: T[], query: string): T[] {
  const q = normalizeQuery(query)
  if (!q) return entries
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

/**
 * 过滤后的提示文案；无需提示时返回空串。
 *
 * 必须把「筛掉了多少」说出来：否则用户看到列表变短会以为文件被删了。
 * 0 条命中时文案不同——那通常是拼错了，提示「无匹配」比「筛掉 24 项」更有用。
 */
export function filterHint(total: number, shown: number, query: string): string {
  if (!normalizeQuery(query)) return ''
  if (shown === 0) return `没有匹配「${query.trim()}」的文件或文件夹`
  if (shown === total) return `共 ${total} 项，全部匹配`
  return `已按「${query.trim()}」筛选：显示 ${shown} / ${total} 项`
}
