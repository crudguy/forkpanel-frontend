/**
 * 容器页「docker 原始串 → 界面文本」的展示规则 —— 从 `<script setup>` 抽出的纯逻辑。
 *
 * 为什么要单独成文件：这些判断必须能被单测钉住，而 vitest 只收 `src/**\/*.test.ts`
 * 且没装 Vue 插件，写在 `<script setup>` 里测不到（见 MEMORY「前端纯逻辑住 .vue
 * 里没法测 ⇒ 先抽 .ts」）。抽出时是**等价搬运**，没有顺手改文案。
 */

/**
 * 状态列里那串灰色原始文本的取舍。
 *
 * 背景：状态列 = 中文徽章（containerStateLabel，归一化）+ docker 原始 status（带运行
 * 时长 / 退出码）。但 docker 在 created / dead / removing 这三个状态下，Status 就是
 * 一个与 State 同义的单词（`Created` / `Dead` / `Removing`），于是拼出
 * 「已创建Created」这种中英重复。
 */
export function statusDetail(state: string, status: string): string {
  const s = (status ?? '').trim()
  if (!s) return ''
  // 判据取「与 state 仅大小写不同」而不是硬编码状态名单：docker 新增同义状态
  // （如 removing）时这里自动生效，不会漏一个就在界面上多一处中英重复。
  return s.toLowerCase() === (state ?? '').trim().toLowerCase() ? '' : s
}

/**
 * 网络表的「驱动」列。
 *
 * docker 对内置 `none` 网络的 DRIVER 输出的是**字面串** `null`（不是 JSON null），
 * 所以 `n.driver || '—'` 兜不住，界面直接显示一个像 bug 的 "null"。
 * 只在它确实是那个哨兵值时换成破折号，其余原样透传（bridge / host / overlay / macvlan）。
 */
export function driverText(d: string): string {
  const s = (d ?? '').trim()
  return !s || s === 'null' ? '—' : s
}
