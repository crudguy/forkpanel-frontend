#!/usr/bin/env node
/**
 * 构建产物「只保留代码」守卫：dist/assets 下的 js/css 不得残留注释。
 *
 * 为什么需要：esbuild 的 minifier 会剥掉**所有普通注释**，唯一可能残留的是
 * 「法务注释」（`/*! *\/`、`@license`、`@preserve`、版权头）与
 * `sourceMappingURL` 指令。vite.config.ts 已设 `esbuild.legalComments:'none'`；
 * 本脚本在 build 末尾复核，防止配置被改回去而无人发觉。
 *
 * 判定只查上述几类标记，**不**用裸 `/*` —— 压缩后的 Vue 代码里有
 * `startsWith("/*")` 这样的字符串字面量，裸查会误杀（已实测）。
 *
 * 用法：node scripts/check-no-comments.mjs [dist/assets 目录]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.argv[2] ?? 'dist/assets'
const MARKERS = [
  ['/*! 法务块注释', /\/\*!/],
  ['@license 版权头', /\/\*[\s\S]{0,300}?@license/i],
  ['@preserve 版权头', /\/\*[\s\S]{0,300}?@preserve/i],
  ['Copyright 版权头', /\/\*[\s\S]{0,300}?copyright/i],
  ['//! 法务行注释', /\/\/!/],
  ['sourceMappingURL 指令', /\/\/#\s*sourceMappingURL/],
]

const files = readdirSync(DIR).filter((f) => /\.(js|css)$/.test(f))
if (!files.length) {
  console.error(`check-no-comments: ${DIR} 下没有 js/css 产物（先跑 vite build）`)
  process.exit(1)
}

let bad = 0
for (const f of files) {
  const text = readFileSync(join(DIR, f), 'utf8')
  for (const [name, re] of MARKERS) {
    if (re.test(text)) {
      bad++
      console.error(`  ✗ ${f}: 命中「${name}」`)
    }
  }
}
if (bad) {
  console.error(`check-no-comments: ${bad} 处注释残留——构建规则：产物只保留代码`)
  process.exit(1)
}
console.log(`check-no-comments: PASS（${files.length} 个 js/css 产物无注释）`)
