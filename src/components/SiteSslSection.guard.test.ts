/**
 * SiteSslSection 的结构守卫（三条都是「三重门禁全绿、真机静默坏掉」的类型）。
 *
 * 这个组件是从 SiteFormDialog 整块搬出来的，搬的代价是**跨了组件边界**：
 *   - 跨列规则还留在父级 scoped 里 ⇒ 只对**子组件根节点**生效（[1]）
 *   - 浮层从「与主弹窗平级」变成「与区块平级」⇒ 区块的 v-if 不能吞掉它们（[2]）
 *   - 列表行入口的那份实例 `site=null` ⇒ 区块必须真的不渲染（[3]）
 *
 * 为什么断言源码而不是渲染：项目没配 @vue/test-utils / jsdom，且这三条本质是
 * **结构契约**（谁嵌在谁里面、根元素带什么 class），不是行为——渲染出来测反而更弱
 * （要造一整套 site / certs / 能力位，还只能测到 happy path 的那一面）。
 *
 * ⚠️ 判据一律「先剔注释、再按层级取」：只断言某串字出现过 = 恒绿。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./SiteSslSection.vue', import.meta.url), 'utf8')

const TEMPLATE = (() => {
  // ⚠️ 从标签**结束**处开始切：脚本注释里就有「别换成 `<template>` 多根」这句，
  //    若切在 `<template>` 开头，那段注释会被当成模板内容（且带一个悬空的 `-->`）。
  const open = SRC.indexOf('\n<template>')
  const a = open < 0 ? -1 : open + '\n<template>'.length
  const b = SRC.lastIndexOf('</template>')
  expect(a, '模板段定位失败：找不到开头的 <template> 标签').toBeGreaterThan(0)
  expect(b, '模板段定位失败：找不到 </template>').toBeGreaterThan(a)
  return SRC.slice(a, b).replace(/<!--[\s\S]*?-->/g, '')
})()

describe('[1] 区块根节点必须是带 class="ssl" 的 div —— 跨列规则的唯一命门', () => {
  it('模板第一层元素就是 <div v-if="editing" class="ssl">', () => {
    // 父级 scoped 的 `.modal-body .sector > .ssl { grid-column: 1/-1 }` 只作用于
    // **子组件根节点**（scoped 会给根节点补上父级的 data-v 属性）。给根节点套一层
    // 无 class 的包装、或改成多根（<template> / v-for），属性就落不到 .ssl 上，
    // 表现为：证书区从「跨两列」缩成「占一列」，而所有门禁全绿。
    // 跳过模板开头连续的注释块：`\n  <!-- ... -->` 可重复出现（本组件这里有一大段）。
    const body = TEMPLATE.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, '')
    const firstEl = body.trimStart().slice(0, 60)
    expect(firstEl, `模板第一个元素不是 .ssl 区块：${firstEl}`)
      .toMatch(/^<div v-if="editing" class="ssl">/)
  })

  it('模板只有一个根元素（多根时 Vue 不保证 scoped 属性落在 .ssl 上）', () => {
    // 顶层缩进两空格的元素（注释已剔除）。本组件刻意会有多个根（区块 + 两个浮层），
    // 所以这里断言的是**区块必须是其中一个**，而不是"只有它一个"——浮层同样需要
    // 父级的 data-v 才能拿到 .mask 的样式，故它们也必须留在根层级。
    const top = TEMPLATE.match(/^ {2}<(div|Site\w+|Teleport)(\s|>)/gm) ?? []
    expect(top.some(t => t.includes('div')), '根层级里没有区块 div').toBe(true)
  })

  it('跨列 grid-column: 1 / -1 写在本组件自己的 .ssl 规则里', () => {
    // 这是实测出来的硬结论：父级 scoped 的 `.modal-body .sector > .ssl` **永远命不中**
    // 子组件根节点（Vue 3.5 不给子组件根补父级 data-v），当时表现为宽 948→465、
    // 跨满两列缩成一列，而 vue-tsc / build / 单测全绿。
    // 所以跨列只能由本组件声明；父级那条规则删了也不影响（留着才是骗人的死代码）。
    const style = SRC.slice(SRC.indexOf('<style'))
    const m = style.match(/\.ssl\s*\{([^}]*)\}/)
    expect(m, '本组件样式里找不到独立的 `.ssl { ... }` 规则').not.toBeNull()
    expect(m![1].replace(/\s+/g, ' '), '`.ssl` 规则里没有 grid-column: 1 / -1')
      .toMatch(/grid-column:\s*1\s*\/\s*-1/)
  })

  it('父级不得再留一条命不中的 `.sector > .ssl` 跨列规则', () => {
    // 反向：若有人在父级又加回这条，它不会生效但会给后来者「以为已经跨列了」的错觉。
    const parent = readFileSync(new URL('./SiteFormDialog.vue', import.meta.url), 'utf8')
    expect(parent, '父级 `.modal-body .sector > .ssl` 是条永不会命中的死规则，应删掉')
      .not.toMatch(/^\s*\.modal-body \.sector > \.ssl,/m)
  })

  it('组件没有把 .ssl 之外的东西挂到根层级当「区块」', () => {
    // 反面：若有人为了「顺手加个提示条」给根层级再塞一个无 class 的 div，上面那条
    // 断言仍会通过，但 .ssl 就不再是 §sector 的直接子元素之一（顺序/语义被稀释）。
    // 这里钉死根层级 div 恰好一个，且就是 .ssl。
    const rootDivs = TEMPLATE.match(/^ {2}<div\s[^\n]*>/gm) ?? []
    expect(rootDivs, `根层级 div 有 ${rootDivs.length} 个：${rootDivs.join(' | ')}`).toHaveLength(1)
    expect(rootDivs[0]).toMatch(/class="ssl"/)
  })
})

describe('[2] 两个浮层与区块平级，且不嵌在区块的 v-if 里', () => {
  for (const tag of ['SiteSslDialog', 'SiteCaHelpDialog']) {
    it(`${tag} 出现在根层级，且全模板仅此一处`, () => {
      const top = TEMPLATE.match(new RegExp(`^ {2}<${tag}(\\s|>)`, 'gm')) ?? []
      expect(top.length, `${tag} 根层级出现 ${top.length} 次（应为 1）——`
        + '若为 0，它被塞进了区块的 v-if 块内：新建站点时整个区块不渲染，浮层跟着消失').toBe(1)

      // 深于根层级的实例 = 被嵌进了区块的 v-if 块（或 Teleport 等容器）⇒ 会随区块消失
      const nested = TEMPLATE.match(new RegExp(`^ {4,}<${tag}(\\s|>)`, 'gm')) ?? []
      expect(nested.length, `${tag} 有 ${nested.length} 处在缩进 ≥4 的位置——`
        + '它被包进了某个容器，区块不渲染时浮层会一起消失').toBe(0)
    })
  }

  it('区块 v-if 的起止可定位（结构变了必须重审本文件判据）', () => {
    expect(TEMPLATE).toMatch(/^ {2}<div v-if="editing" class="ssl">/m)
  })
})

describe('[3] 签发弹窗的四个回传都接上（少一个就是静默失效）', () => {
  const tag = (() => {
    const m = TEMPLATE.match(/^ {2}<SiteSslDialog[\s\S]*?\/>/m) ?? ['']
    return m[0]
  })()

  it('标签存在', () => {
    expect(tag, '根层级的 <SiteSslDialog ... /> 未找到').not.toBe('')
  })

  it('@update:req —— 签完/取消后弹窗关不掉', () => {
    expect(tag, '缺 @update:req：sslModal 永不置空，弹窗关不上').toMatch(/@update:req=/)
  })

  it('@update:busy —— 签发期间宿主不知道在忙', () => {
    expect(tag, '缺 @update:busy：签发进行中父级「保存并应用」仍可点').toMatch(/@update:busy=/)
  })

  it('@reload —— 自签成功后证书列表不刷新', () => {
    expect(tag, '缺 @reload：证书列表停留在签发前的数据').toMatch(/@reload=/)
  })

  it('@update:busy 是**转发给宿主**而不是本地忙态（本地忙态父级看不见）', () => {
    expect(tag, '父级不知道本组件在忙').toMatch(/@update:busy="\(v\) => emit\('update:busy', v\)"/)
  })
})

describe('[4] 自动续期开关只对 ACME 证书出现', () => {
  it('开关所在行带 v-if="c.source === \'acme\'"', () => {
    // 自签证书没有"续期任务"，给它一个开关等于让用户点一个永远不生效的东西。
    expect(TEMPLATE).toMatch(/<span v-if="c\.source === 'acme'" class="switch"/)
  })

  it('删除按钮按 canSsl 置灰（不是按 canManage：删证书走 ssl.manage）', () => {
    expect(TEMPLATE).toMatch(/class="btn-ghost btn-sm danger" :disabled="!canSsl"/)
  })
})

describe('[4b] 删除确认框必须压在主弹窗之上（level-2 → z-index 60）', () => {
  it('证书区的 ConfirmDialog 带 level2 修饰', () => {
    // 默认 `.mask` 是 z-index 50，与「编辑站点」主弹窗同级 ⇒ 谁在上面取决于 DOM 顺序。
    // 实测基线就是这样：确认框与主弹窗同为 50，靠碰运气。本组件永远叠在主弹窗内，
    // 所以必须显式 level-2。层级总表见 main.css。
    const tag = (TEMPLATE.match(/<ConfirmDialog[\s\S]*?\/>/) ?? [''])[0]
    expect(tag, '未找到 <ConfirmDialog ... />').not.toBe('')
    expect(tag, '删除证书确认框缺 level2：与主弹窗同为 z-index 50，可能被盖住').toMatch(/\blevel2\b/)
  })

  it('ConfirmDialog 支持 level2 并真的映射到 .level-2', () => {
    const cd = readFileSync(new URL('./ConfirmDialog.vue', import.meta.url), 'utf8')
    expect(cd, 'ConfirmDialog 没有 level2 prop').toMatch(/level2\?:\s*boolean/)
    expect(cd, 'level2 没有映射到 .mask 的 level-2 类').toMatch(/'level-2':\s*level2/)
  })
})

describe('[4c] 三个浮层都必须压在主弹窗之上', () => {
  // 本组件的浮层全部叠在「编辑站点」弹窗内 ⇒ 一律 level-2（z-index 60）。
  // 默认 .mask 是 50，与主弹窗同级，顺序一变就被盖住（表现为「点了没反应」）。
  for (const f of ['./SiteSslDialog.vue', './SiteCaHelpDialog.vue']) {
    it(`${f} 的遮罩带 level-2`, () => {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      const m = src.match(/<div v-if="[^"]+" class="mask([^"]*)"/)
      expect(m, `${f} 未找到 .mask 遮罩`).not.toBeNull()
      expect(m![1], `${f} 的遮罩缺 level-2`).toMatch(/level-2/)
    })
  }
})

describe('[5] 三个写接口的调用点各恰有一处', () => {
  // 只剔 `//` 行注释：块注释里不会出现 `API.certs.xxx(` 的真实调用，
  // 而贪婪的 `/\*[\s\S]*?\*/` 会把 `/**` 开头的大段实现整块吃掉（连调用一起），
  // 让这三条断言恒红——这正是「断言前剔注释」要剔得准的原因。
  const scriptEnd = SRC.indexOf('\n<template>')
  expect(scriptEnd, '脚本段边界定位失败').toBeGreaterThan(0)
  const script = SRC.slice(0, scriptEnd).replace(/^[ \t]*\/\/.*$/gm, '')

  it('续期 POST /certs/{id}/renew', () => {
    expect(script.match(/API\.certs\.renew\(/g) ?? []).toHaveLength(1)
  })
  it('自动续期 PATCH /certs/{id}/auto-renew', () => {
    expect(script.match(/API\.certs\.autoRenew\(/g) ?? []).toHaveLength(1)
  })
  it('删除 DELETE /certs/{id}', () => {
    expect(script.match(/API\.certs\.remove\(/g) ?? []).toHaveLength(1)
  })
})
