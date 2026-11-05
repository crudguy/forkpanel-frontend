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
  // 2026-11-05 A7 审计新增：批量作用域（筛选后"全选/已选/批量入参"必须同源于可见集合）
  'check-bulk-scope.mjs',
  // 2026-11-05 Q-09 新增：升级/重装/重启的等待逻辑必须走 serviceResume，判据形态不得降级
  'check-maintenance-wait.mjs',
  // 2026-11-05 Q-09 新增：容器 6 个 Tab 的加载动作必须走 useRowLoad/useAsync
  'check-tab-load.mjs',
  // 2026-11-05 Q-09 新增：弹窗表单骨架只能有一份，变体集合钉住防止再复制
  'check-dialog-form.mjs',
  // 2026-11-05 P2 修复新增：模板里的 PascalCase 组件必须真绑定（漏 import 会静默渲染空元素）
  'check-component-imports.mjs',
  // 2026-11-05 F-05/F-09：侧栏/Tab/顶栏/命令面板/路由守卫必须共用同一份可达性判据
  'check-nav-policy.mjs',
  // 2026-11-05 Q-11：静默 catch 必须自证理由（吞掉根因的代价是「界面正常但功能全关」）
  'check-silent-catch.mjs',
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
