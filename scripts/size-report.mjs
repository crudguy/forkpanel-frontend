/**
 * 体积报告：把"资源占用"变成可回归的约束。
 * 输出 dist 各 chunk 的 raw / gzip 大小，并对照 ci/budgets.json 判定。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const dist = 'dist/assets'
let files = []
try { files = readdirSync(dist) } catch { console.error('未找到 dist，请先构建'); process.exit(1) }

// 预算文件随前端仓走（本仓 ci/budgets.json），脚本从仓根目录运行
const budgets = JSON.parse(readFileSync('ci/budgets.json', 'utf8'))
let firstScreenGzip = 0
let totalGzip = 0
const rows = []

for (const f of files) {
  const p = join(dist, f)
  const raw = statSync(p).size
  const gz = gzipSync(readFileSync(p)).length
  totalGzip += gz
  // 首屏 = 入口 JS + CSS（vendor 懒加载部分不计入）
  if (/^index|main/.test(f) || f.endsWith('.css')) firstScreenGzip += gz
  rows.push({ file: f, raw, gzip: gz })
}

// 单 chunk 上限：单个文件过大意味着懒加载没切开（TerminalView 因 xterm 天然偏大，
// 预算按「现状 297KB + 余量」取 350KB；真要继续瘦身应评估 xterm 的 WebGL addon
// 或把终端视图本身改成按需 import）
const maxChunkRawKb = budgets.frontend_max_chunk_raw_kb
const overChunks = rows.filter(r => r.raw / 1024 > maxChunkRawKb)

rows.sort((a, b) => b.gzip - a.gzip)
console.log('file'.padEnd(46), 'raw'.padStart(10), 'gzip'.padStart(10))
for (const r of rows) {
  console.log(r.file.padEnd(46), String(r.raw).padStart(10), String(r.gzip).padStart(10))
}
console.log('---')
console.log(`首屏 JS+CSS (gzip): ${(firstScreenGzip / 1024).toFixed(1)} KB  预算 ${budgets.frontend_first_screen_gzip_kb} KB`)
console.log(`全量 (gzip):        ${(totalGzip / 1024).toFixed(1)} KB  预算 ${budgets.frontend_total_gzip_kb} KB`)
console.log(`最大单 chunk (raw): ${(Math.max(...rows.map(r => r.raw)) / 1024).toFixed(1)} KB  预算 ${maxChunkRawKb} KB`)

for (const r of overChunks) {
  console.error(`超预算：${r.file} raw ${(r.raw / 1024).toFixed(1)} KB > ${maxChunkRawKb} KB`)
}

const fail = firstScreenGzip / 1024 > budgets.frontend_first_screen_gzip_kb
  || totalGzip / 1024 > budgets.frontend_total_gzip_kb
  || overChunks.length > 0
process.exit(fail ? 1 : 0)
