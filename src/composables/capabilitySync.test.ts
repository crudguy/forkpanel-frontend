import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// ── 能力位置灰点守卫（二轮审计 P1-22）──
//
// 背景：`auth.supported(CAP.X)` 是前端「单方面的承诺」——后端没有同口径的 501
// 时，适配器一旦改判（新平台缺 procfs / caddy render 实装 / 包管理器变化），
// 前端静默置灰而后端照常服务，用户白白用不上已能用的功能。caddy 那一组早有
// 渲染守卫（caddy_render_emits_none_of_the_fields_frontend_greys_out），
// 其余置灰点零覆盖——本文件补上「前端这一半」：
// 置灰点不许被静默删掉（删了＝用户点到 501），也不许多（重复接线会漂移）。
//
// 后端那一半由 `capability_gates_census`（panel-api/src/routes.rs 测试）
// 按文件钉门控次数；两侧合起来才是完整的「置灰 ⇔ 501」同步不变量。
//
// 判据指向被检查的那一份：各文件生产段，剔注释行（//、*、/*、<!--）——
// 不断注释就会被自己的注释绊倒（注释里写着要实现什么，断言恒真）。

/** 读生产段：剔注释行与空行，trim 后拼接（ needle 不依赖缩进）。 */
function prod(rel: string): string {
  const raw = readFileSync(new URL(rel, import.meta.url), 'utf8')
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('<!--'))
    .join('\n')
}

/** 断言 needle 恰好出现 want 次（少＝接线被删，多＝重复接线/写法漂移）。 */
function exactly(prod: string, needle: string, want: number, who: string) {
  const got = prod.split(needle).length - 1
  expect(got, `${who}：\`${needle}\` 应恰好出现 ${want} 次，实际 ${got} 次`).toBe(want)
}

describe('useSiteCaps 置灰点（P1-22：webSupported / sslSupported / canReload / canCreate）', () => {
  const p = prod('../composables/useSiteCaps.ts')

  it('webSupported 读 WEBSERVER_MANAGE（建站/下发/重载的共同前提）', () => {
    exactly(p, 'auth.supported(CAP.WEBSERVER_MANAGE)', 1, 'useSiteCaps.webSupported')
  })

  it('sslSupported / selfSignedSupported 分别读 ACME 与自签两个独立位', () => {
    exactly(p, 'auth.supported(CAP.SSL_ACME)', 1, 'useSiteCaps.sslSupported')
    exactly(p, 'auth.supported(CAP.SSL_SELFSIGNED)', 1, 'useSiteCaps.selfSignedSupported')
  })

  it('sslReady 三条前提缺一不可（底座 + 签发渠道 + 权限）', () => {
    exactly(p, 'webSupported.value && (sslSupported.value || selfSignedSupported.value)', 1, 'useSiteCaps.sslReady')
  })

  it('canReload 与 canCreate 都要求底座在位（后端同口径 501）', () => {
    exactly(p, 'webSupported.value && canManage.value', 2, 'useSiteCaps.canReload/canCreate')
  })
})

describe('整页置灰点（P1-22：后端无同口径 501 时置灰即单方面承诺）', () => {
  it('ProcessesView 整页置灰读 PROCESS_LIST（后端 processes::list 已补门）', () => {
    exactly(prod('../views/ProcessesView.vue'), 'supported(CAP.PROCESS_LIST)', 1, 'ProcessesView')
  })

  it('DatabasesView 整页置灰读 DBMS_MANAGE（后端 14 个 handler 已补门）', () => {
    exactly(prod('../views/DatabasesView.vue'), 'supported(CAP.DBMS_MANAGE)', 1, 'DatabasesView')
  })

  it('ContainersView 置灰读 CONTAINER_MANAGE（后端 ensure_supported 11 处）', () => {
    exactly(prod('../views/ContainersView.vue'), 'supported(CAP.CONTAINER_MANAGE)', 1, 'ContainersView')
  })

  it('CronView 两处（脚本早退 + 模板空态）都读 SCHEDULER_MANAGE', () => {
    exactly(prod('../views/CronView.vue'), 'supported(CAP.SCHEDULER_MANAGE)', 2, 'CronView')
  })
})
