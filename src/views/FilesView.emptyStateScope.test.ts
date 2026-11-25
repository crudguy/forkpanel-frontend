/**
 * FilesView 的「空态不给写入口」守卫。
 *
 * 背景：用户截图反馈「用户没有目录权限，不应该展示『可以上传文件或新建文件夹
 * 开始使用』和『上传文件』『新建文件夹』这些」。
 *
 * 根因：空态与工具栏只判 `canWrite`，而 `canWrite` 只看「有没有写权限」，
 * 不看「当前路径能不能访问」。当后端拒绝（如 50001「路径超出允许范围」）时
 * `error` 非空，但 `canWrite` 仍是 true ⇒ 空态给出「上传文件/新建文件夹」
 * 入口，点下去仍是 50001。观感是「给的按钮点不动」。
 *
 * 修法：`canWriteHere = canWrite && !error`，三处模板判断都改用它。
 *
 * 本守卫钉住「有 error 时不给写入口」这条判据。**必须指向被检查的那一份**——
 * 读 FilesView.vue 源码做断言，而不是自己另写一份判断逻辑（否则判据自己持有
 * 实现，恒绿）。
 *
 * ⚠ 扫描式守卫的纪律：**先断言「定义处恰好 N 处」再断言内容**。正则写错＝静默
 *   空转＝"没找到 = 通过"。本文件所有 `match` 都先断言命中数。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./FilesView.vue', import.meta.url), 'utf8')

/** 抽出 `canWriteHere` 的定义行（到行尾）。 */
function canWriteHereDef(): string {
  const m = SRC.match(/^const canWriteHere = .*$/m)
  return m ? m[0] : ''
}

describe('FilesView 空态/工具栏写入口判据', () => {
  it('canWriteHere 同时判 canWrite 与 !error（缺一即为回归）', () => {
    // ① 先断言「恰好 1 处定义」——正则写错或定义丢失都会在这里转红
    const defs = SRC.match(/^const canWriteHere = .*$/gm) ?? []
    expect(defs, 'canWriteHere 定义处数必须恰好 1（0=失踪，>1=重复定义）').toHaveLength(1)

    const def = defs[0]
    // ② 再断言内容
    expect(def, 'canWriteHere 必须判 canWrite').toMatch(/canWrite\.value/)
    expect(def, 'canWriteHere 必须判 !error').toMatch(/!error\.value/)
    // 负向：不能只判 canWrite（那是旧的 buggy 形态）
    expect(def, '不能退化成只判 canWrite').not.toMatch(
      /canWriteHere = computed\(\(\) => canWrite\.value\)/
    )
  })

  it('三处写入口都用 canWriteHere 门控，且不退回裸 canWrite', () => {
    // ① 先断言「canWriteHere 在模板里恰好 3 处引用」（工具栏×2 + 空态×1）
    const refs = SRC.match(/\bcanWriteHere\b/g) ?? []
    // 定义 1 处 + 模板 3 处 = 4
    expect(refs, 'canWriteHere 总引用数应为 4（1 定义 + 3 模板）').toHaveLength(4)

    // ② 三处模板判断必须是 `v-if="...canWriteHere..."`，且不含裸 canWrite
    // ⚠ 空态那处是 `v-else-if`（三元分支），正则必须同时覆盖 v-if / v-else-if，
    //   否则漏掉一处 → 断言 3 处恒失败（正则写错的另一种形态：少匹配而非空转）。
    const vIfs = SRC.match(/v-(?:else-)?if="[^"]*\bcanWriteHere\b[^"]*"/g) ?? []
    expect(vIfs, 'canWriteHere 的 v-if/v-else-if 应恰好 3 处').toHaveLength(3)
    for (const v of vIfs) {
      // 不能是 `canWrite.value && ...` 这种退回裸 canWrite 的形态
      expect(v, `「${v}」不得退回裸 canWrite`).not.toMatch(/canWrite\.value/)
    }

    // ③ 空态提示语必须只在 canWriteHere 分支（不能泄漏到无写权限分支）
    const emptyHint = SRC.match(/hint="可以上传文件或新建文件夹开始使用。"/g) ?? []
    expect(emptyHint, '「可以上传…开始使用」应恰好 1 处').toHaveLength(1)
    // 该 hint 所在的 EmptyState 必须是 canWriteHere 分支
    const hintCtx = SRC.match(/<EmptyState[^>]*hint="可以上传文件或新建文件夹开始使用。"/g) ?? []
    expect(hintCtx).toHaveLength(1)
    expect(hintCtx[0], '空态写提示必须挂在 canWriteHere 分支').toMatch(/canWriteHere/)
  })

  it('拖拽上传也要被 error 拦住', () => {
    // ① 先断言 onDrop 存在
    const drops = SRC.match(/function onDrop[\s\S]{0,600}?(?=\nfunction |\nconst |\n\/\/ ─)/g) ?? []
    expect(drops, 'onDrop 函数应恰好 1 个').toHaveLength(1)
    // ② 再断言它检查了 error
    expect(drops[0], 'onDrop 必须检查 error').toMatch(/if \(error\.value\) return/)
  })

  it('负向对照：把判据退回旧形态，上面三条必须转红', () => {
    // 坏样本 1：canWriteHere 退化成只判 canWrite
    const bad1 = SRC.replace(
      /^const canWriteHere = .*$/m,
      'const canWriteHere = computed(() => canWrite.value)'
    )
    const def1 = bad1.match(/^const canWriteHere = .*$/m)![0]
    expect(def1).not.toMatch(/!error\.value/)

    // 坏样本 2：空态退回裸 canWrite
    const bad2 = SRC.replace(
      /v-else-if="!loading && canWriteHere"/,
      'v-else-if="!loading && canWrite"'
    )
    const hintCtx2 = bad2.match(/<EmptyState[^>]*hint="可以上传文件或新建文件夹开始使用。"/g) ?? []
    expect(hintCtx2).toHaveLength(1)
    expect(hintCtx2[0]).not.toMatch(/canWriteHere/)

    // 坏样本 3：onDrop 去掉 error 检查
    const bad3 = SRC.replace(/if \(error\.value\) return\n/, '')
    const drops3 = bad3.match(/function onDrop[\s\S]{0,600}?(?=\nfunction |\nconst |\n\/\/ ─)/g) ?? []
    expect(drops3).toHaveLength(1)
    expect(drops3[0]).not.toMatch(/if \(error\.value\) return/)
  })
})
