#!/usr/bin/env node
/**
 * 曲线平滑接线守卫（2026-11-16）。
 *
 * 背景：主机监控页有 3 组 SVG、共 9 条数据曲线。改成平滑 path 后，若某个视图
 * 被复制/改写回 `<polyline>` 直连，vue-tsc / vite build / 单测全绿，只有肉眼看
 * 才能得到「又变生硬了」——这正是本项目反复出现的「写死常量 / 假控制」同族。
 *
 * 判据只指向**接线**本身：9 个绑定名必须齐全，每个都必须由统一构建函数产出，
 * 且两个构建函数只能调用 smoothSeriesPath。平滑算法本身由
 * `src/composables/smoothPath.test.ts` 以几何性质验证，不在本脚本里复述。
 *
 * 活性自检：先用夹具证明反例（polyline / 非登记绑定）真能被抓到，再做精确计数，
 * 避免「扫描为空 = 通过」的恒绿。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FILE = join(ROOT, 'src', 'views', 'SystemView.vue')

const EXPECTED = [
  'cpuPath', 'memPath', 'loadPath', 'diskPath', 'netInPath', 'netOutPath',
  'histCpuPath', 'histMemPath', 'histLoadPath',
]

// 剔注释：注释里出现旧写法 / 别名不该让守卫变红，也不该让它把注释当接线
function clean(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const hasPolyline = (src) => /\bpolyline\b/.test(clean(src))
const bindings = (src) => [...clean(src).matchAll(/<path\s+:d="([A-Za-z]\w*)"/g)].map(m => m[1])

const errors = []
console.log('== 曲线平滑接线守卫 ==')

// 活性自检：反例必须真的能被识别
if (!hasPolyline('<polyline :points="0,0 1,1" />')) {
  errors.push('判据失效：夹具里的 polyline 没被识别')
}
if (bindings('<path :d="cpuPath" />').length !== 1) {
  errors.push('判据失效：夹具里的 path 绑定没被识别')
}

const raw = readFileSync(FILE, 'utf8')
const src = clean(raw)

if (hasPolyline(src)) errors.push(`${FILE}: 仍存在 <polyline> 直连曲线`)
if (!/import\s*\{[^}]*\bsmoothSeriesPath\b[^}]*\}\s*from\s*'@\/composables\/smoothPath'/.test(src)) {
  errors.push('未从 smoothPath 导入 smoothSeriesPath（可能各页自写一套）')
}

const bound = bindings(src)
if (bound.length !== EXPECTED.length) {
  errors.push(`path 绑定数 ${bound.length} ≠ 预期 ${EXPECTED.length}（曲线被删或改回非 path 元素）`)
}
for (const name of EXPECTED) {
  if (!bound.includes(name)) {
    errors.push(`缺少 <path :d="${name}"> 绑定`)
    continue
  }
  // 声明块：从 const xxx = computed( 起到下一个 const 止；覆盖单行与多行写法
  const at = src.indexOf(`const ${name} = computed(`)
  if (at < 0) {
    errors.push(`${name} 只在模板里绑定、没有 computed 定义`)
    continue
  }
  const next = src.indexOf('\nconst ', at + 1)
  const block = src.slice(at, next < 0 ? src.length : next)
  if (!/\bbuild(?:Hist)?Path\s*\(/.test(block)) {
    errors.push(`${name} 未由 buildPath / buildHistPath 产出（绕过统一平滑实现）`)
  }
}

// 两个构建函数是唯一写入点：多一份手拼 path 就会在这里露出来
for (const fn of ['buildPath', 'buildHistPath']) {
  const n = (src.match(new RegExp(`function\\s+${fn}\\s*\\(`, 'g')) || []).length
  if (n !== 1) errors.push(`${fn} 定义出现 ${n} 次（期望恰好 1 次）`)
}
const calls = (src.match(/\bsmoothSeriesPath\s*\(/g) || []).length
if (calls !== 2) errors.push(`smoothSeriesPath 调用 ${calls} 处（期望恰好 2 处：实时 + 历史）`)

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(`FAIL：曲线平滑接线 ${errors.length} 项未通过`)
  process.exit(1)
}
console.log(`  ✓ 活性自检通过（反例可识别）`)
console.log(`  ✓ ${bound.length} 条曲线全部绑定 :d，且由唯一的两个平滑构建函数产出`)
console.log('PASS：没有曲线退回直连或另起一套平滑实现')
