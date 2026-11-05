/**
 * 容器 Tab 的加载动作必须统一（Q-09）
 *
 * 6 个 Tab 从 ContainersView 拆出来后，每个都手写了一遍
 * 「非 silent 置 loading → 成功清错 → 失败清列表 + 落 errorText → finally 复位」。
 * 六份写法还不一样：网络/卷 Tab 根本没有 silent 分支，容器/镜像/资源 Tab 有；
 * "成功清错"有的写在 `try` 里、有的写在 `if (silent)` 分支里。这类差异没有任何设计
 * 理由，只是抄写时的手感——而手感会漂移（漏一次 finally 就是骨架卡死，漏一次清列表
 * 就是旧行与错误条并排显示）。
 *
 * 现已收敛：5 个列表 Tab 用 `composables/useRowLoad.ts`（= useAsync + 列表页三条固定
 * 策略），ComposeTab 一次拉两份数据，直接用 `composables/useAsync.ts`。
 *
 * 本守卫**不重测状态机**（useAsync 有 7 条行为测试、useRowLoad 有 5 条），只钉住
 * 「调用方别再各写一份」。手写状态机的特征形态就是自己持有 loading 标志，所以判据是
 * `loading.value =` / `const loading = ref(`。
 *
 * 顺带钉住 `@click="load()"` 的括号：`useRowLoad` 返回的 `load(silent = false)` 带参数，
 * 裸绑定会把 PointerEvent 传成 silent（truthy）⇒ 手动刷新被当成轮询、既不置 loading
 * 也不落错。`check-load-binding.mjs` 靠"本地 load 定义带参数"来判，而这 5 个文件的
 * load 是**解构来的**、本地没有定义，所以那条守卫在这里是盲的——必须在此补上。
 *
 * 恒绿防护：扫描到的 Tab 文件数与登记表不符 → fail（路径/正则失效时不能空集通过）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'src', 'components', 'containers')

const TABS = [
  { file: 'ContainersTab.vue', helper: 'useRowLoad', loadTakesSilent: true },
  { file: 'ImagesTab.vue', helper: 'useRowLoad', loadTakesSilent: true },
  { file: 'StatsTab.vue', helper: 'useRowLoad', loadTakesSilent: true },
  { file: 'NetworksTab.vue', helper: 'useRowLoad', loadTakesSilent: true },
  { file: 'VolumesTab.vue', helper: 'useRowLoad', loadTakesSilent: true },
  // 一次拉两份数据（项目清单 + 容器列表），列表策略用不上，直接吃状态机
  { file: 'ComposeTab.vue', helper: 'useAsync', loadTakesSilent: false },
]

console.log('== 容器 Tab 加载动作统一守卫 ==')

const bad = []
const seen = []

for (const t of TABS) {
  let src = ''
  try {
    src = readFileSync(join(DIR, t.file), 'utf8')
  } catch {
    bad.push(`${t.file}：读不到（不能静默跳过）`)
    continue
  }
  seen.push(t.file)

  if (!src.includes(`from '@/composables/${t.helper}'`)) {
    bad.push(`${t.file}：没有 import ${t.helper}——加载状态机又被手写回来了？`)
  }
  // 解构里必须同时拿到 loading 与 error（名字无所谓，含义必须是这两个）
  const destructure = src.match(/const\s*\{([^}]*)\}\s*=\s*(useRowLoad|useAsync)\s*\(/)
  if (!destructure) {
    bad.push(`${t.file}：找不到 const { … } = ${t.helper}(…) 的解构`)
  } else {
    const names = destructure[1].split(',').map((x) => x.split(':').pop().trim())
    for (const need of ['loading', 'error']) {
      if (!names.includes(need)) bad.push(`${t.file}：解构里缺 ${need}`)
    }
  }

  if (/\bloading\.value\s*=/.test(src)) {
    bad.push(`${t.file}：出现 loading.value = …——loading 只能由 ${t.helper} 持有`)
  }
  if (/const\s+loading\s*=\s*ref\(/.test(src)) {
    bad.push(`${t.file}：又自己声明了 loading ref`)
  }

  if (t.loadTakesSilent) {
    if (!/@click="load\(\)"/.test(src)) {
      bad.push(`${t.file}：找不到 @click="load()"——刷新/重试入口少了括号，会被当成轮询`)
    }
    if (/@click="load"/.test(src)) {
      bad.push(`${t.file}：出现裸 @click="load"——PointerEvent 会被当成 silent`)
    }
  }
}

const rowLoadCount = TABS.filter((t) => t.helper === 'useRowLoad').length
if (seen.length !== TABS.length) {
  bad.push(`扫描到 ${seen.length} 个 Tab 文件，登记 ${TABS.length} 个——目录/文件名变了？`)
}

if (bad.length > 0) {
  console.log(`  ✗ ${bad.length} 条不满足：`)
  for (const b of bad) console.log(`      - ${b}`)
  console.log('    改法：见 src/composables/useRowLoad.ts 文件头。')
  process.exit(1)
}

console.log(`  ✓ [1] ${TABS.length} 个 Tab 全部走共用加载动作（useRowLoad × ${rowLoadCount}、`
  + `useAsync × ${TABS.length - rowLoadCount}）`)
console.log('  ✓ [2] 无自持 loading、带参 load 的模板绑定全部加了括号')
