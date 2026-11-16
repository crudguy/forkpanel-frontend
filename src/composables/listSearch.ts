/**
 * 列表页搜索的包含匹配判据（全站共用）。
 *
 * 为什么抽出来：这段判据一旦散落在各 `.vue` 的 `<script setup>` 里，vitest 的
 * `include` 只收 `src/**\/*.test.ts`，就没有任何测试能钉住它。而 trim / 大小写 /
 * 空值这三件事写错任何一件，症状都是「搜索框摆在那里但搜不到」——
 * 类型检查、构建、肉眼点一遍全绿，属于典型的静默失败。
 *
 * 口径：空查询（含纯空白）恒真；否则对传入字段做不区分大小写的包含匹配，
 * 任一字段命中即为 true。调用方负责决定「哪些是关键字段」。
 */
export function matchFields(
  query: string,
  fields: readonly (string | null | undefined)[],
): boolean {
  const k = query.trim().toLowerCase()
  if (!k) return true
  return fields.some(f => (f ?? '').toLowerCase().includes(k))
}
