import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// ── 公网暴露向导（ExposeWizardView）行为守卫 ──
//
// 这一页是全项目**唯一**能把 root 面板挂到公网上的界面，出错的代价不是"页面难看"
// 而是"机器被扫"。所以这里不当普通 UI 测试写，只钉四条"改坏了会出事"的不变量：
//
// 1. 三个端点都从 `API.system.expose.*` 取，不许出现 `/api/v1` 字面量
//    （`check-api-contract.sh` 会把测试里的字面量当真实调用⇒恒红，且字面量
//    绕过了契约门禁的静态校验）。
// 2. 开启与撤销都必须先经 ConfirmDialog，不许直接绑到按钮上——这一页没有
//    "点错了再点回来"的余地。
// 3. 能力不支持时必须走 EmptyState 并带上**原因**，不许静默置灰
//    （用户会以为面板坏了，而真实原因可能是"面板没以 root 跑"）。
// 4. 脚本输出必须落到 `<pre>`，不能只 toast：脚本失败时它的 stdout/stderr
//    是用户唯一的排查线索，一闪而过的提示等于没有。
//
// ⚠️ 判据纪律：读 `.vue` 源码断言（vitest 未装 vue 插件，纯逻辑若住在 `.vue`
// 里就测不到行为），按标签边界截取 `script` / `template`，且**剔注释行**——
// 本文件上方这几段注释里就写着 `apply()` / `remove()`，不断注释的断言会被
// 自己的注释满足而恒绿。

const SRC = readFileSync(new URL('../views/ExposeWizardView.vue', import.meta.url), 'utf8')

/** 剔注释行与空行后 join（needle 不依赖缩进）。 */
function strip(s: string): string {
  return s.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('<!--'))
    .join('\n')
}

/** 按标签截取区段：含开标签行到闭标签行之间（截不到就抛——不许静默空串）。 */
function section(tag: 'script' | 'template'): string {
  const open = `<${tag}`
  const close = `</${tag}>`
  const a = SRC.indexOf(open)
  const b = SRC.lastIndexOf(close)
  if (a < 0 || b < 0) throw new Error(`ExposeWizardView.vue 找不到 <${tag}> 区段`)
  return strip(SRC.slice(a, b + close.length))
}

function exactly(s: string, needle: string, want: number, who: string) {
  const got = s.split(needle).length - 1
  expect(got, `${who}：\`${needle}\` 应恰好出现 ${want} 次，实际 ${got} 次`).toBe(want)
}

describe('端点来源（组件不得硬编码 /api/v1）', () => {
  const s = section('script')

  it('三个端点全部走 API.system.expose.*，一个不少', () => {
    exactly(s, 'API.system.expose.status()', 1, 'status')
    exactly(s, 'API.system.expose.apply()', 1, 'apply')
    exactly(s, 'API.system.expose.remove()', 1, 'remove')
  })

  it('script 区段里没有任何 /api/v1 字面量', () => {
    expect(s).not.toContain('/api/v1')
  })
})

describe('二次确认（开启与撤销都不可直接触发）', () => {
  const t = section('template')

  it('两个按钮都只打开确认框，不直接调提交函数', () => {
    // 按钮的 @click 必须是置 confirm 标志，而不是 doApply/doRemove。
    expect(t).toContain('@click="prepareApply"')
    expect(t).toContain('@click="confirmRemove = true"')
    expect(t, '按钮不得直接绑 doApply').not.toContain('@click="doApply"')
    expect(t, '按钮不得直接绑 doRemove').not.toContain('@click="doRemove"')
  })

  it('确认框的 @confirm 才真正调提交函数（两个各一次）', () => {
    exactly(t, '@confirm="doApply"', 1, '开启确认')
    exactly(t, '@confirm="doRemove"', 1, '撤销确认')
  })

  it('两个确认框都是 danger：这一页没有可逆的小事', () => {
    exactly(t, 'danger title="确认开启公网访问"', 1, '开启确认框')
    exactly(t, 'danger title="确认撤销公网访问"', 1, '撤销确认框')
  })
})

describe('能力不支持：说明原因，而非静默置灰', () => {
  const t = section('template')

  it('不支持时渲染 EmptyState 且绑定 reason', () => {
    expect(t).toContain('v-if="!auth.supported(CAP.EXPOSE_MANAGE)"')
    exactly(t, ':reason="capReason ?? undefined"', 1, 'EmptyState.reason')
  })

  it('EmptyState 的 reason 来自 unsupportedReason（含中文映射）', () => {
    const s = section('script')
    exactly(s, 'unsupportedReason(auth.capabilities, CAP.EXPOSE_MANAGE)', 1, 'capReason')
  })

  it('写操作门控 = 能力位 AND system.manage（与后端 require 同口径）', () => {
    const s = section('script')
    exactly(s, 'auth.enabled(CAP.EXPOSE_MANAGE, \'system.manage\')', 1, 'canManage')
  })
})

describe('脚本输出必须可见（失败时是唯一线索）', () => {
  const t = section('template')

  it('输出渲染进 <pre>，不是只走 toast', () => {
    exactly(t, '<pre class="output">{{ output }}</pre>', 1, 'output')
  })

  it('apply 失败时把错误文本写进 output（而非只设 error）', () => {
    // 失败分支里 output 必须被赋值——否则 <pre> 整块不渲染，用户看不到任何原因。
    const s = section('script')
    const applyBody = s.slice(s.indexOf('async function doApply'))
    expect(applyBody.slice(0, applyBody.indexOf('async function doRemove')))
      .toContain('output.value = errorText(e)')
  })
})

describe('状态未知不得伪装成「仅本机可访问」', () => {
  const t = section('template')

  // 徽章此前无条件渲染：`status?.exposed` 为 undefined 时走 else 分支，显示绿色
  // 「仅本机可访问」。于是首帧加载中、或读取失败时，用户看到的是**确定的**
  // "未暴露"结论——在安全页上，这与"以为已暴露"是同样危险的一类误读。
  it('徽章外层有 v-if="status"，不是无条件渲染', () => {
    expect(t).toContain('<template v-if="status">')
  })

  it('未知态有独立文案，且不与确定态文案混在同一分支', () => {
    const a = t.indexOf('<template v-if="status">')
    expect(a, '找不到 status 分支').toBeGreaterThanOrEqual(0)
    const b = t.indexOf('</template>', a)
    expect(b, 'status 分支未闭合').toBeGreaterThan(a)
    const inner = t.slice(a, b)
    // 确定态结论只在 status 分支内出现
    expect(inner).toContain('正在对外暴露')
    // 未知态结论**不得**出现在确定态分支里
    expect(inner).not.toContain('状态未知')
    // 未知态结论存在于模板中（v-else 分支）
    expect(t).toContain('状态未知')
  })
})

describe('证书成对（只给一个会让脚本静默回退成自签）', () => {
  const s = section('script')

  it('custom 模式下两个都空就先拦，不进请求', () => {
    expect(s).toContain("tlsMode.value === 'custom' && (!fullchain.value.trim() || !key.value.trim())")
  })

  it('请求体里证书仅在 custom 模式下发，其余为 null', () => {
    exactly(s, "tlsMode.value === 'custom' ? fullchain.value.trim() : null", 1, 'fullchain')
    exactly(s, "tlsMode.value === 'custom' ? key.value.trim() : null", 1, 'key')
  })
})
