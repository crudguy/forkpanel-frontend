/**
 * `@click="load"` 事件误传守卫
 *
 * 模板里写裸 `@click="load"` 时，Vue 会把原生事件对象作为第一个实参传入。
 * 若 `load` 恰好声明了位置参数（典型是 `load(silent = false)`），事件对象会
 * 被当成该参数：`silent` 变成 PointerEvent（truthy）⇒ 手动刷新被误判为「静默
 * 刷新」，失败不再落错误态。2026-10-29 给 `load` 加 `silent` 参数时就踩过一次，
 * 当时靠 `vue-tsc` 报 TS2345 才发现——但若参数类型是 `unknown`/`any`，编译器
 * 不会报，缺陷就会静默上线。
 *
 * 规则：**同一文件内**，若本地 `load` 定义带任何参数，则模板里不得出现裸
 * `@click="load"` / `@change="load"` 等（必须写成 `load()` 或 `load(true)`）。
 *
 * 恒绿防护：
 *   [1] 扫到的 .vue 文件数低于阈值 → 疑似扫错目录，直接 fail；
 *   [2] `load` 定义数与裸绑定数均为 0 → 正则失效，守卫不可信，直接 fail。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), 'src')
const MIN_VUE = 50

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

let files
try {
  files = walk(root)
} catch {
  console.log(`FAIL：读不到源码目录 ${root}（不能静默跳过）`)
  process.exit(1)
}

console.log('== @click="load" 事件误传守卫 ==')

if (files.length < MIN_VUE) {
  console.log(`  ✗ [1] .vue 文件数=${files.length}，少于阈值 ${MIN_VUE} —— 疑似扫错目录，守卫不可信`)
  process.exit(1)
}
console.log(`  ✓ [1] 扫过 ${files.length} 个 .vue 文件`)

// 本地 load 定义（带参数）
const DEFS = [
  /(?:async\s+)?function\s+load\s*\(([^)]*)\)/g,
  /(?:const|let)\s+load\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g,
]
// 模板里把 load 直接交给事件（未加括号）
const BARE = /@(?:click|change|submit|input|dblclick)(?:\.[\w-]+)*\s*=\s*"load\s*"/g

let defCount = 0
let bareCount = 0
const bad = []

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  let hasParam = false
  for (const re of DEFS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) {
      defCount++
      if (m[1].trim() !== '') hasParam = true
    }
  }
  BARE.lastIndex = 0
  const bares = src.match(BARE) || []
  bareCount += bares.length
  if (hasParam && bares.length > 0) {
    const rel = file.slice(process.cwd().length + 1)
    bad.push(`${rel}（load 带参数，却有 ${bares.length} 处裸事件绑定）`)
  }
}

if (defCount === 0 || bareCount === 0) {
  console.log(`  ✗ [2] load 定义=${defCount} / 裸绑定=${bareCount} —— 正则可能失效，守卫不可信`)
  console.log('      若裸绑定是有意清零，请删除本守卫而不是放宽它')
  process.exit(1)
}
console.log(`  ✓ [2] load 定义 ${defCount} 处，裸事件绑定 ${bareCount} 处`)

if (bad.length > 0) {
  console.log(`  ✗ 发现 ${bad.length} 个文件把带参数的 load 直接交给事件：`)
  for (const b of bad) console.log(`      - ${b}`)
  console.log('    改法：模板写 load() 或 load(true)，不要依赖事件对象')
  process.exit(1)
}
console.log('  ✓ 所有裸事件绑定都指向无参 load')
