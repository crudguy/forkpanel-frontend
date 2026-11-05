#!/usr/bin/env node
// UI 守卫的唯一清单。
//
// 为什么要有这个文件：此前 `make check`（CI 实际跑的）串了 6 个脚本，
// `package.json` 的 `check:ui` 串了 8 个 ⇒ `check-hint-note` 与
// `check-load-binding` 从未在 CI 执行。两处各写一份清单，漏一个不会有任何提示。
//
// 新增守卫时**只改这里**：Makefile 与 package.json 都转发到本文件。
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const UI_GUARDS = [
  'check-sidenav.mjs',
  'check-page-head.mjs',
  'check-modal.mjs',
  'check-icon-names.mjs',
  'check-overlay-teleport.mjs',
  'check-subtitles.mjs',
  'check-hint-note.mjs',
  'check-load-binding.mjs',
  // 2026-11-05 复盘新增：样式层此前完全无断言
  'check-css-vars.mjs',
  'check-raw-colors.mjs',
  'check-zindex.mjs',
]

let failed = 0
for (const name of UI_GUARDS) {
  console.log(`\n== ${name} ==`)
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', name)], { stdio: 'inherit' })
  if (r.status !== 0) {
    failed += 1
    console.error(`✗ ${name} 未通过（exit ${r.status}）`)
  }
}

if (failed > 0) {
  console.error(`\nFAIL：${failed}/${UI_GUARDS.length} 个 UI 守卫未通过`)
  process.exit(1)
}
console.log(`\nPASS：${UI_GUARDS.length} 个 UI 守卫全部通过`)
