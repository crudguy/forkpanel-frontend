#!/usr/bin/env node
// 守卫：全局错误兜底必须真的接线（main.ts），且模块两个入口都真的会提示。
//
// 为什么：`app.config.errorHandler` 只覆盖 Vue 组件树内。树外 rejection 的兜底
// 若只写了模块、忘了在 main.ts 挂监听，tsc / vite build / 单测全绿，真机上却
// 一个提示都不弹——本项目反复出现的「定义处有了、接线断了」恒绿变种。
//
// 判据一律指向**被检查的那份文件**，断言前剥注释（注释里写「已接线」不算数）。
// 行为正确性由 src/composables/globalErrors.test.ts 覆盖，本守卫只钉接线与活性。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
const MOD = readFileSync(join(ROOT, 'src/composables/globalErrors.ts'), 'utf8')

function clean(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}
const main = clean(MAIN)
const mod = clean(MOD)
const errors = []

// ── 活性自检：先证明扫描真的抓到了东西，否则「零违规」可能是空集恒真 ──
const listeners = (main.match(/window\.addEventListener\s*\(/g) || []).length
if (listeners < 4) {
  errors.push(`活性自检失败：main.ts 只扫到 ${listeners} 个 window.addEventListener（预期 ≥4：会话 2 + 全局兜底 2），扫描器可能已失效`)
}
if (!mod.includes('createGlobalErrorHandlers')) {
  errors.push('活性自检失败：globalErrors.ts 里找不到 createGlobalErrorHandlers 定义')
}

// ── 1) main.ts 接线 ──
if (!/import\s*\{[^}]*createGlobalErrorHandlers[^}]*\}\s*from\s*'@\/composables\/globalErrors'/.test(main)) {
  errors.push('main.ts 未从 @/composables/globalErrors 导入 createGlobalErrorHandlers')
}
const calls = (main.match(/createGlobalErrorHandlers\s*\(/g) || []).length
if (calls !== 1) {
  errors.push(`main.ts 里 createGlobalErrorHandlers( 恰好应有 1 处，实测 ${calls} 处（多了=重复注册，少了=没接线）`)
}
if (!/window\.addEventListener\s*\(\s*'unhandledrejection'\s*,\s*globalErrors\.onUnhandledRejection\s*\)/.test(main)) {
  errors.push('main.ts 未把 globalErrors.onUnhandledRejection 挂到 window 的 unhandledrejection')
}
if (!/window\.addEventListener\s*\(\s*'error'\s*,\s*globalErrors\.onError\s*\)/.test(main)) {
  errors.push('main.ts 未把 globalErrors.onError 挂到 window 的 error')
}

// ── 2) 模块活性：两个入口都必须真的会弹提示 ──
const shows = (mod.match(/show\s*\(\s*\)/g) || []).length
if (shows !== 2) {
  errors.push(`globalErrors.ts 里 show() 调用应恰好 2 处（两个 handler 各一），实测 ${shows} 处`)
}
const notifies = (mod.match(/sink\.notify\s*\(/g) || []).length
if (notifies !== 1) {
  errors.push(`globalErrors.ts 里 sink.notify( 应恰好 1 处，实测 ${notifies} 处`)
}
const ignores = (mod.match(/isIgnorableGlobalError\s*\(/g) || []).length
if (ignores < 2) {
  errors.push(`globalErrors.ts 里 isIgnorableGlobalError( 应至少 2 处（定义 + 调用），实测 ${ignores} 处`)
}

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error('check-global-errors: FAIL')
  process.exit(1)
}
console.log(`check-global-errors: PASS（main.ts 接线齐全，两个入口均会提示；活性 ${listeners} 个监听）`)
