#!/usr/bin/env node
// 样式硬编码色值「棘轮」守卫。
//
// 现状：`<style>` 块里仍有相当数量的 hex/rgba 字面量绕过 --c-* / --chart-* token
// （具体条数见下方 BASELINE，本文件不复述数字——两个数字迟早打架）。
// 一刀切禁止会让守卫立刻恒红，所以这里用**只减不增**的棘轮：
//   - 当前数量不得高于基线；
//   - 新增文件不得出现硬编码色值（文件不在基线清单里 ⇒ 必须用 token）。
// 每清理一处，请把 BASELINE 同步调小——这样它才会持续收敛，而不是给现状盖章。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 2026-11-05 清到 0 处后，这条棘轮正式变成**硬规则**：style 块内不再允许任何
// hex/rgba 字面量。要加新颜色，先在 main.css 的 token 表里给它一个名字
// （主题色、品牌底上的白、遮罩、图表色都有对应 token）；确实不能命名的，
// 用 color-mix() 从既有 token 派生，而不是把某个主题的取值抄进组件。
const BASELINE = 0

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue')) out.push(p)
  }
  return out
}

const COLOR = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b|rgba?\(/g
let total = 0
let styleBlocks = 0
const perFile = []

for (const f of walk(join(ROOT, 'src'))) {
  const src = readFileSync(f, 'utf8')
  const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
    // 注释里的色值不计：源码里大量「原先这里写死 #xxxxxx」的说明文字会把计数虚高，
    // 而注释里的整条声明本来就是死代码，同样不该计入。
    (m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ' '),
  )
  styleBlocks += blocks.length
  let n = 0
  for (const b of blocks) n += (b.match(COLOR) || []).length
  if (n > 0) {
    total += n
    perFile.push([relative(ROOT, f), n])
  }
}

let failed = false
console.log('== 样式硬编码色值棘轮 ==')
// 活性自检：剔除注释后若正则也跟着失效（例如写成不匹配任何东西），total 恒为 0，
// 基线 0 会让守卫无条件通过。先拿样本证明「它确实能抓到字面量、且不抓 token」。
const PROBE = 'color: #abc; background: rgba(1, 2, 3, .5); border-color: var(--c-border);'
const probeHits = (PROBE.match(COLOR) || []).length
if (probeHits !== 2) {
  console.error(`  ✗ 正则自检失败：样本应命中 2 处字面量、0 处 token，实得 ${probeHits} 处`)
  failed = true
}
if (styleBlocks < 80) {
  console.error(`  ✗ 只抽到 ${styleBlocks} 个 style 块（期望 ≥80）：扫描失效`)
  failed = true
} else {
  console.log(`  ✓ [1] 扫过 ${styleBlocks} 个 style 块`)
}
if (total > BASELINE) {
  console.error(`  ✗ 硬编码色值 ${total} 处 > 基线 ${BASELINE}：新增样式请用 --c-* / --chart-* token`)
  failed = true
} else {
  console.log(`  ✓ [2] 硬编码色值 ${total} 处 ≤ 基线 ${BASELINE}`)
  if (total < BASELINE) console.log(`      ↓ 已优于基线，请把 BASELINE 调为 ${total}（棘轮只减不增）`)
}
if (perFile.length > 0) {
  const top = perFile.sort((a, b) => b[1] - a[1]).slice(0, 5)
  console.log(`  · 重灾：${top.map(([f, n]) => `${f}(${n})`).join('、')}`)
}

if (failed) process.exit(1)
console.log('PASS：样式色值未突破基线')
