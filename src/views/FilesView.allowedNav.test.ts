/**
 * FilesView「只能在授权目录内切换」的接线守卫。
 *
 * 纯逻辑（isWithinRoots / buildAllowedCrumbs）另有 filePath.test.ts 验证；
 * 这里只钉**接线**：逻辑再对，少接一个入口，用户仍能点到未授权路径。
 *
 * 判据指向被检查的 FilesView.vue 源码，不另写一份实现（否则判据自持实现＝恒绿）。
 * 扫描式纪律：先断言「定义处恰好 N 处」，再断言内容。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./FilesView.vue', import.meta.url), 'utf8')

function bodyOf(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  expect(start, `找不到 ${name} 定义`).toBeGreaterThan(-1)
  const end = SRC.indexOf('\n}', start)
  expect(end, `${name} 函数体没闭合`).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('FilesView 白名单导航接线', () => {
  it('面包屑必须走 buildAllowedCrumbs(path, allowedRoots)', () => {
    const defs = SRC.split('\n').filter((l) => l.includes('const crumbs = computed('))
    expect(defs, 'crumbs computed 应恰好 1 处').toHaveLength(1)
    expect(defs[0]).toMatch(/buildAllowedCrumbs\(path\.value, allowedRoots\.value\)/)
    expect(defs[0], '不能回退到会生成 to:/ 的旧版').not.toMatch(/buildCrumbs\(/)
  })

  it('goto / up / enter 三个入口都必须过 isAllowedPath，且早于 load', () => {
    for (const name of ['goto', 'up', 'enter']) {
      const defs = SRC.match(new RegExp(`^function ${name}\\(`, 'gm')) ?? []
      expect(defs, `${name} 定义处应恰好 1`).toHaveLength(1)
      const body = bodyOf(name)
      expect(body, `${name} 必须校验白名单`).toMatch(/if \(!isAllowedPath\(p\)\) return/)
      expect(body, `${name} 校验必须早于 load`)
        .toMatch(/if \(!isAllowedPath\(p\)\) return\n  load\(p\)/)
    }
  })

  it('「上级」按钮 disabled 必须判白名单，不能只看 path === /', () => {
    const btns = SRC.split('\n').filter((l) => l.includes('aria-label="上一级目录"'))
    expect(btns, '上级按钮应恰好 1 处').toHaveLength(1)
    expect(btns[0]).toMatch(/:disabled="!isAllowedPath\(parentPath\(path\)\)"/)
    expect(btns[0], '只剩这一个根时上级必须置灰').not.toMatch(/path === '\/'/)
  })

  it('多根切换器存在，且 switchRoot 只落到白名单内', () => {
    const selects = SRC.split('\n').filter((l) => l.includes('class="root-pick"'))
    expect(selects, '授权目录选择器应恰好 1 处').toHaveLength(1)
    expect(selects[0]).toMatch(/v-if="allowedRoots\.length > 1"/)
    expect(bodyOf('switchRoot')).toMatch(/if \(isAllowedPath\(p\)\) load\(p\)/)
  })

  it('负向对照：抽掉 goto 的白名单校验，上面的接线断言必须转红', () => {
    const bad = SRC.replace(
      /function goto\(p: string\) \{\n  if \(!isAllowedPath\(p\)\) return\n  load\(p\)\n\}/,
      'function goto(p: string) { load(p) }'
    )
    // 坏样本把 goto 压成单行，不能再按 `\n}` 抽函数体（会吞进下一个函数）。
    const gotoLine = bad.split('\n').find((l) => l.startsWith('function goto('))
    expect(gotoLine, '坏样本必须真的失去校验').not.toMatch(/isAllowedPath/)
    expect(gotoLine, '坏样本必须真的只剩裸 load').toMatch(/load\(p\)/)
  })
})
