/**
 * 文件页（FilesView）与目录选择器的**路径纯逻辑单一事实源**。
 *
 * 抽出来的原因不是"整洁"：这几个函数在 `.vue` 的 `<script setup>` 里时
 * vitest 收不到（vitest 只收 `src/**\/*.test.ts` 且无 vue 插件），等于**结构上不可测**。
 * 而它们恰恰是三处各写一份、边界各差一点的那一类：
 * - `DirectoryPickerDialog` 的 `norm/basename/parentOf/joinDir`
 * - `AppsView` 的 `dirnameOf`
 * - `FilesView` 的 `tabLabel / up / full / 面包屑`
 * 语义差异是真实的（详见各函数注释），收口时逐个核对过，**只收敛等价的那些**。
 *
 * 三条硬边界（三者都是"不知道就会静默出错"）：
 * 1. 根 `/` 不得参与拼接产生 `//x`——拼出来的路径照样能过一次网络请求，但
 *    作为 key 去比对时 `/home` 与 `//home` 是两个值（目录树的展开链会因此断掉）。
 * 2. 上级目录到顶一律停在 `/`，不返回空串。
 * 3. 输入可能带尾斜杠（`/a/`），一律先归一化再处理。
 */

/** 面包屑的一段：label 是显示文案，to 是点击直达的路径。 */
export interface Crumb {
  label: string
  to: string
}

/** 归一化：去掉尾斜杠；空串（含全是斜杠）视为根。 */
export function normalizePath(p: string): string {
  return p.replace(/\/+$/, '') || '/'
}

/** 路径的最后一段；根路径返回 `/`（调用方据此判断"已在根"）。 */
export function baseName(p: string): string {
  const n = normalizePath(p)
  if (n === '/') return '/'
  return n.slice(n.lastIndexOf('/') + 1) || '/'
}

/** 上级目录；到顶一律停在 `/`。 */
export function parentPath(p: string): string {
  const n = normalizePath(p)
  if (n === '/') return '/'
  const i = n.lastIndexOf('/')
  return i <= 0 ? '/' : n.slice(0, i)
}

/**
 * 目录 + 条目名 → 完整路径。
 *
 * ⚠ 根目录下的拼接是 `'' + '/' + name`，**不是** `'/' + '/' + name`：
 * `//bin` 能过网络请求，但按路径字符串做 key 的地方（目录树的 expandTo、
 * 选中集合的条目名比对）会把它与 `/bin` 当成两个东西。
 */
export function joinPath(base: string, name: string): string {
  const n = normalizePath(base)
  return (n === '/' ? '' : n) + '/' + name
}

/** 标签 / 标题用的目录名：根显示为「根目录」。 */
export function dirLabel(p: string): string {
  if (normalizePath(p) === '/') return '根目录'
  return baseName(p) || '根目录'
}

/**
 * 面包屑：逐段拼回绝对路径。
 *
 * 后端返回的 path 已是规范路径（resolve 后的 SafePath 显示值），所以逐段累加
 * 就是合法路径，**前端不解析 `..`**——拼路径在前端毫无意义，后端沙箱才是唯一防线。
 */
export function buildCrumbs(path: string): Crumb[] {
  const segs = normalizePath(path).split('/').filter(Boolean)
  const out: Crumb[] = [{ label: '根目录', to: '/' }]
  let acc = ''
  for (const s of segs) {
    acc += '/' + s
    out.push({ label: s, to: acc })
  }
  return out
}

/**
 * 面包屑折叠：超过 `maxShown` 段时中段折成一个可点的「…」。
 *
 * 折叠段落在第 2 段（根目录之后第一级），而不是"折叠位置的前一段"——它是给
 * 用户的落脚点，必须是一段真实存在的、能一路点回来的路径。
 *
 * 只返回数组：原实现还带一个 `collapsedFrom`，但模板里**没有任何地方读它**
 * （折叠与否看元素个数即可）。留着就是"登记了没人读"的字段。
 */
export function collapseCrumbs(crumbs: Crumb[], maxShown = 6): Crumb[] {
  if (crumbs.length <= maxShown) return crumbs
  return [
    ...crumbs.slice(0, 2),
    { label: '…', to: crumbs[1].to },
    ...crumbs.slice(-3),
  ]
}

/** 八进制权限位（如 644 / 0755）：3-4 位 0-7，允许两侧空白。 */
export function isOctalMode(v: string): boolean {
  return /^[0-7]{3,4}$/.test(v.trim())
}
