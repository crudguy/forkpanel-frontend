#!/usr/bin/env node
// 未定义 CSS 变量守卫。
//
// 为什么需要：`var(--font-mono)` 这种拼错**不会报错**——浏览器静默退回继承值，
// 构建、vue-tsc、现有 8 个 UI 守卫全绿。本项目曾因此让 6 处代码块丢掉等宽字体、
// 5 处字号声明完全失效（且违反「禁 <12px」约定）。
//
// 判据：src 下所有 `var(--x)` 的 x 必须在 main.css 有 `--x:` 定义（或在模板的
// `:style` / 内联 style 里动态定义）。
// 反向判据（T-03 清死兜底后补）：**已定义的变量不许再带兜底值**——兜底分支永远
// 走不到，只会让读代码的人把真实取值误判成另一个数。曾清掉 4 处：
// `var(--radius-sm, 7px)` ×2、`var(--radius, 10px)`、`var(--c-surface-2, transparent)`。
// 未定义变量的兜底仍合法（可能是模板动态注入），只走 soft 提示，不判红。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSS = join(ROOT, 'src/styles/main.css')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue') || p.endsWith('.css') || p.endsWith('.ts')) out.push(p)
  }
  return out
}

const css = readFileSync(CSS, 'utf8')
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))
const styleCount = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])).size

let refs = 0
let styleBlocks = 0
const missing = []
const soft = []
const deadFallbacks = []
let fileCount = 0

for (const f of walk(join(ROOT, 'src'))) {
  const src = readFileSync(f, 'utf8')
  fileCount += 1
  // 动态定义：模板里 `:style="{ '--w': ... }"` / style 属性里的 `--x:` 也算已定义
  const local = new Set([...src.matchAll(/(['"])(--[a-z0-9-]+)\1\s*:/gi)].map((m) => m[2]))
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    if (line.includes('<style')) styleBlocks += 1
    // 捕获 var() 的其余参数：含逗号 = 自带兜底值（未定义时不致静默失效）。
    for (const m of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)([^)]*)\)/g)) {
      refs += 1
      // --x 已有全局定义时兜底分支永远走不到：这类死兜底是误导，不是防御
      if (defined.has(m[1]) && m[2].includes(',')) {
        deadFallbacks.push(`${relative(ROOT, f)}:${i + 1}  ${m[1]}`)
      }
      if (!defined.has(m[1]) && !local.has(m[1])) {
        const rec = `${relative(ROOT, f)}:${i + 1}  ${m[1]}`
        if (m[2].includes(',')) soft.push(rec)
        else missing.push(rec)
      }
    }
  })
}

let failed = false
console.log('== 未定义 CSS 变量守卫 ==')
// 扫描自检：正则/目录一旦失效，下面「missing 为空」会变成恒绿
if (styleCount < 60) {
  console.error(`  ✗ 定义只解析到 ${styleCount} 个变量（期望 ≥60）：main.css 结构变了或正则失效`)
  failed = true
} else {
  console.log(`  ✓ [1] main.css 定义 ${styleCount} 个变量（去重后）`)
}
if (refs < 1000) {
  console.error(`  ✗ 只扫到 ${refs} 处 var() 引用（期望 ≥1000）：扫描链路失效`)
  failed = true
} else {
  console.log(`  ✓ [2] 扫过 ${fileCount} 个文件、${refs} 处 var() 引用、${styleBlocks} 个 style 块`)
}
// 反向判据自检：用样本证明「已定义变量 + 逗号」确实能被 m[2] 抓到，
// 否则下面 deadFallbacks 恒为空，判据会静默退化成恒绿。
const PROBE = 'x { padding: var(--radius-sm, 7px); }'
const probe = /var\(\s*(--[a-zA-Z0-9-]+)([^)]*)\)/.exec(PROBE)
if (!probe || probe[1] !== '--radius-sm' || !probe[2].includes(',')) {
  console.error('  ✗ 死兜底正则自检失败：样本应解析出 --radius-sm 且带逗号')
  failed = true
}
if (soft.length) {
  // 带兜底值的未定义变量不会静默失效（只是兜底成为唯一来源），不阻断但必须可见。
  console.log(`  · [3a] ${soft.length} 处未定义但有兜底（合法，但优先给 token 一个定义）：`)
  for (const m of soft.slice(0, 10)) console.log(`      ${m}`)
}
if (deadFallbacks.length) {
  console.error(`  ✗ ${deadFallbacks.length} 处死兜底（变量已定义，兜底值永不生效）：`)
  for (const d of deadFallbacks.slice(0, 20)) console.error(`      ${d}`)
  failed = true
} else {
  console.log('  ✓ [3c] 已定义变量的 var() 均未带死兜底')
}
if (missing.length) {
  console.error(`  ✗ ${missing.length} 处引用了未定义变量且无兜底（声明会静默失效）：`)
  for (const m of missing.slice(0, 20)) console.error(`      ${m}`)
  failed = true
} else {
  console.log('  ✓ [3b] 所有无兜底的 var(--x) 引用均有定义')
}

if (failed) process.exit(1)
console.log('PASS：CSS 变量引用全部有定义、无死兜底')
