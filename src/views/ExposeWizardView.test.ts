import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 公网暴露向导的**契约 lint 守卫**（Q-06 B 拆分后只留这一组）。
 *
 * 这一页能把 root 面板挂到公网，其余可观察行为（二次确认、能力门控、
 * 失败输出、状态未知、证书成对）已全部转到
 * `ExposeWizardView.behavior.test.ts` 的真挂载测试——源码文本断言只能证明
 * "代码这么写"，证明不了"按钮点了真的没提交"。
 *
 * 只保留两条**行为测试覆盖不到**的静态纪律：
 * 1. 端点必须取自 `API.system.expose.*`，各恰好一次。
 * 2. script 段里不许出现 `/api/v1` 字面量：它会绕过 `check-api-contract.sh`
 *    的静态校验；而行为测试用 `API.*()` 登记路由时，分不清组件用的是契约
 *    函数还是值相同的字符串常量，这条只能靠静态断言钉住。
 *
 * ⚠ 判据纪律：`scriptSection()` 必须自证抓到了内容——`not.toContain` 对空串
 *   恒真，标签改名 / 文件挪走导致截取失效时会静默变绿。
 */

const SRC = readFileSync(new URL('../views/ExposeWizardView.vue', import.meta.url), 'utf8')

/** 剔注释行与空行后 join（needle 不依赖缩进）。 */
function strip(s: string): string {
  return s.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('<!--'))
    .join('\n')
}

function scriptSection(): string {
  const close = '</script>'
  const a = SRC.indexOf('<script')
  const b = SRC.lastIndexOf(close)
  if (a < 0 || b < 0) throw new Error('ExposeWizardView.vue 找不到 <script> 区段')
  const out = strip(SRC.slice(a, b + close.length))
  // 哨兵 + 长度下限：证明扫描确实抓到了 script 内容，空串不许走到断言。
  if (!out.includes('const auth = useAuthStore()') || out.length < 400) {
    throw new Error(`script 区段截取异常（仅 ${out.length} 字符）——扫描前提不成立，不许静默通过`)
  }
  return out
}

function exactly(s: string, needle: string, want: number, who: string) {
  const got = s.split(needle).length - 1
  expect(got, `${who}：\`${needle}\` 应恰好出现 ${want} 次，实际 ${got} 次`).toBe(want)
}

describe('端点来源（组件不得硬编码 /api/v1）', () => {
  const s = scriptSection()

  it('三个端点全部走 API.system.expose.*，一个不少', () => {
    exactly(s, 'API.system.expose.status()', 1, 'status')
    exactly(s, 'API.system.expose.apply()', 1, 'apply')
    exactly(s, 'API.system.expose.remove()', 1, 'remove')
  })

  it('script 区段里没有任何 /api/v1 字面量', () => {
    expect(s).not.toContain('/api/v1')
  })
})
