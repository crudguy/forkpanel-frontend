#!/usr/bin/env node
/**
 * 语法高亮守卫：单一事实源 + 调用点登记表。
 *
 * 为什么需要它：单测能证明共享 tokenizer 算得对，却挡不住两类退化——
 *   ① 有人把规则复制回组件里（修了共享模块，另一个编辑框仍用旧正则）；
 *   ② 新增一个编辑框调用点忘了传 language / filename，于是它永远 plain，
 *      界面看着正常、没有任何报错，只是「这个框怎么没有高亮」。
 * 判据一律指向生效代码（先剔注释），并做扫描链路自检（空集必须判红）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
let failed = 0
const fail = (msg) => { console.error('✗ ' + msg); failed += 1 }
const pass = (msg) => console.log('✓ ' + msg)

const rel = (p) => relative(ROOT, p).split(sep).join('/')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

const vueFiles = walk(SRC)

// ---- A. 规则只有一份 -------------------------------------------------------
const SHARED = 'src/composables/syntaxHighlight.ts'
const OWNERS = ['src/components/LinedTextarea.vue', 'src/components/NginxEditor.vue']
const shared = stripComments(read(SHARED))
for (const [name, re] of [
  ['detectLanguage', /export function detectLanguage\b/g],
  ['tokenize', /export function tokenize\b/g],
]) {
  const n = (shared.match(re) ?? []).length
  if (n !== 1) fail(`${SHARED}：${name} 定义应恰好 1 处，实际 ${n} 处`)
}
for (const f of OWNERS) {
  const src = stripComments(read(f))
  if (!/import\s*\{[^}]*\btokenize\b[^}]*\}\s*from\s*'@\/composables\/syntaxHighlight'/.test(src)) {
    fail(`${f}：未从共享模块 import tokenize（各写一份规则会让修复只落一处）`)
  }
  if (/\bfunction\s+tokenize\s*\(|\bconst\s+TOKEN_RE\b/.test(src)) {
    fail(`${f}：仍保留自己的 tokenizer 实现，必须删除`)
  }
}
pass('规则：两个编辑框共用 syntaxHighlight.ts，无第二份 tokenizer')

// ---- B. 调用点登记表 -------------------------------------------------------
let calls = 0
for (const f of vueFiles) {
  const name = rel(f)
  const src = stripComments(read(name))
  const tagRe = /<(LinedTextarea|NginxEditor|ExpandableTextarea)\b([\s\S]*?)>/g
  let m
  while ((m = tagRe.exec(src))) {
    calls += 1
    const line = src.slice(0, m.index).split('\n').length
    if (!/(?:^|\s):?(?:language|filename)\s*=/.test(m[2])) {
      fail(`${name}:${line}：<${m[1]}> 未提供 language / filename（该框会静默变成无高亮）`)
    }
  }
}
// 扫描链路自检：正则写错 / 目录搬走导致空集时必须判红，不能「没找到就算过」
if (calls === 0) fail('登记表扫描链路空转：一个编辑框调用点都没找到')
console.log(`  登记表扫描了 ${calls} 处调用点（异常项见上方 ✗）`)

// ---- C. 配色只有一份 -------------------------------------------------------
const css = read('src/styles/main.css')
for (const cls of ['tok-comment', 'tok-string', 'tok-var', 'tok-directive', 'tok-num', 'tok-punc']) {
  const n = (css.match(new RegExp('^\\.' + cls + '\\s*\\{', 'gm')) ?? []).length
  if (n !== 1) fail(`main.css：.${cls} 配色应恰好 1 处，实际 ${n} 处`)
}
for (const f of vueFiles) {
  const name = rel(f)
  if (/\.tok-[a-z]+\s*\{[^}]*color\s*:/.test(read(name))) {
    fail(`${name}：组件里仍写 .tok-* 配色（应统一到 main.css）`)
  }
}
pass('配色：6 个 token class 只在 main.css 定义一份')

// ---- D. 接线活性自检 -------------------------------------------------------
const runner = read('scripts/run-ui-guards.mjs')
if (!/'check-syntax-highlight\.mjs'/.test(runner)) {
  fail('本守卫未登记在 run-ui-guards.mjs（存在≠在跑）')
}
console.log('  接线活性自检完成（异常项见上方 ✗）')

if (failed > 0) {
  console.error(`\n${failed} 项未通过`)
  process.exit(1)
}
console.log('\ncheck-syntax-highlight: PASS')
