/**
 * 「等面板/机器恢复」必须走共用实现守卫（Q-09）
 *
 * 背景：升级、重装、重启面板、重启系统这四处的等待逻辑骨架完全一样（睡一会儿 →
 * 探一次 /version → 判断够不够格刷新 → 到点提示），差异只在「多久探一次」「什么算
 * 恢复」「超时复位什么」。此前顶栏（`TopbarMaintenance.vue`）与设置页
 * （`SettingsView.vue`）各写一份，其中 `waitForUpgrade`、`waitForRestart` 两份**逐字
 * 相同**——改超时或改判据时漏一处，两边行为就分叉，且这种分叉只在"刚好在另一个页面
 * 操作"时才看得见。
 *
 * 现在已抽到 `src/composables/serviceResume.ts`（`isRecovered` 纯判据 +
 * `waitForRecovery` 轮询骨架）。本守卫钉的**不是**那份实现（它有 14 条行为单测），
 * 而是「调用方不许再各写一份」，以及「判据语义不许在调用方被降级」。
 *
 * 为什么判据要在调用方钉：`after-down`（重启系统）要求**先见过断连**才算恢复，
 * 若被顺手改成 `any-response`（能应答就算恢复），那么 reboot 因权限不足根本没生效时
 * 页面也会立刻刷新、显示一切正常——用户以为机器重启过了。单测挡不住这种改动：
 * 单测验的是 `isRecovered` 本身，而这里错的是"哪个场景传哪个 rule"。
 *
 * 恒绿防护：
 *  [1] 登记文件读不到 / 为空 → fail（不静默跳过）
 *  [2] 全部登记文件里 `waitForRecovery(` 的总数必须等于登记条数之和，否则说明
 *      调用被删/被改名，规则正则已失效 → fail（"空集恒真"防护）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

// 登记表：每处维护操作 = 一行判据形态。新增维护操作时**必须**在这里加一行，
// 否则 [2] 的总数对不上（刻意如此：漏登记会当场变红，而不是悄悄放行）。
const TARGETS = [
  {
    file: 'src/components/TopbarMaintenance.vue',
    // 升级 / 重装 → version-changed；重启面板 → any-response；重启系统 → after-down
    kinds: ['version-changed', 'any-response', 'after-down'],
  },
  {
    file: 'src/views/SettingsView.vue',
    // 升级 → version-changed；重启面板 → any-response
    kinds: ['version-changed', 'any-response'],
  },
]

const TOTAL = TARGETS.reduce((n, t) => n + t.kinds.length, 0)
const bad = []
let callsSeen = 0

console.log('== 「等面板恢复」共用实现守卫 ==')

for (const t of TARGETS) {
  let src = ''
  try {
    src = readFileSync(join(ROOT, t.file), 'utf8')
  } catch {
    bad.push(`${t.file}：读不到（不能静默跳过）`)
    continue
  }
  if (src.trim() === '') {
    bad.push(`${t.file}：内容为空（不能静默跳过）`)
    continue
  }

  if (!/\bwaitForRecovery\b/.test(src)) {
    bad.push(`${t.file}：没有 import/调用共用实现 waitForRecovery（又自己写了一份等待？）`)
    continue
  }

  const calls = src.match(/\bwaitForRecovery\s*\(/g)?.length ?? 0
  callsSeen += calls
  if (calls !== t.kinds.length) {
    bad.push(`${t.file}：waitForRecovery 调用 ${calls} 处，登记 ${t.kinds.length} 处——数量不符（漏登记或漏接）`)
  }

  // 每处判据形态恰好一次：少一个 = 语义被合并（如 after-down 被并进 any-response），
  // 多一个 = 新加的调用没登记到本表。
  for (const kind of t.kinds) {
    const re = new RegExp(`kind:\\s*'${kind}'`, 'g')
    const n = src.match(re)?.length ?? 0
    if (n !== 1) bad.push(`${t.file}：判据 '${kind}' 出现 ${n} 次，应为 1 次（语义被合并或漏登记）`)
  }

  // 自写的刷新 / 等待一律不许：这就是"各写一份"重新长出来的形态。
  const SELF = [
    ['location.reload', /\blocation\.reload\b/],
    ['自写轮询 setTimeout', /\bsetTimeout\s*\(/],
    ['自写超时 Date.now', /\bDate\.now\s*\(/],
  ]
  for (const [name, re] of SELF) {
    if (re.test(src)) {
      bad.push(`${t.file}：出现${name}——等待/刷新必须走 serviceResume，不要在本文件里重写`)
    }
  }
}

if (callsSeen !== TOTAL) {
  bad.push(`全部登记文件里 waitForRecovery 调用共 ${callsSeen} 处，登记表合计 ${TOTAL} 处——规则正则可能已失效，守卫不可信`)
}

if (bad.length > 0) {
  console.log(`  ✗ ${bad.length} 条不满足：`)
  for (const b of bad) console.log(`      - ${b}`)
  console.log('    改法：见 src/composables/serviceResume.ts 文件头；判据形态按场景选，不要"统一"成一个。')
  process.exit(1)
}

console.log(`  ✓ [1] ${TARGETS.length} 个文件共 ${callsSeen} 处等待全部走共用实现`)
console.log('  ✓ [2] 判据形态与登记表 1:1，无自写刷新/轮询')
