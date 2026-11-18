// @vitest-environment jsdom
// 审计页「导出 CSV」与「校验完整性」（P2-9 / P2-11）。
//
// 真挂载而不是源码断言：这两条功能的价值全在"点下去真的发生了一件事"——
// 导出必须真的走 api.download 并触发一次下载（而不是静默失败），校验必须
// 把三种状态**如实**呈现（尤其 not_chained 不能被说成"通过"）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import AuditView from './AuditView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { fakeError, fakeRaw } from '@/test/apiFake'
import { API } from '@/api/endpoints'

const PERMS = ['audit.view', 'system.view']
const PAGE = {
  items: [
    { id: 3, ts: 1_700_000_003, actor: 'admin', actor_ip: '1.2.3.4', action: 'auth.login', target: 'admin', result: 'ok', detail_json: '{}' },
    { id: 2, ts: 1_700_000_002, actor: 'admin', actor_ip: '1.2.3.4', action: 'site.apply', target: 's1', result: 'ok', detail_json: '{}' },
  ],
  page: 1, page_size: 20, total: 2,
}

function btn(m: Mounted, label: RegExp): HTMLButtonElement {
  const hit = [...m.host.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => label.test((b.textContent ?? '').trim()))
  if (!hit) throw new Error(`找不到按钮 ${label}`)
  return hit
}

async function setup(routes: Record<string, unknown> = {}): Promise<Mounted> {
  const m = await mountView({
    component: AuditView,
    caps: capsAllOk(),
    perms: PERMS,
    routes: { [API.audit()]: PAGE, ...routes } as never,
  })
  await m.flush()
  return m
}

let createdUrls: string[] = []
let revokedUrls: string[] = []

beforeEach(() => {
  createdUrls = []
  revokedUrls = []
  // jsdom 没有 createObjectURL：打桩并记录，用来证明"确实生成过下载 URL"
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:fake-${createdUrls.length}`
    createdUrls.push(u)
    return u
  }) as never
  URL.revokeObjectURL = vi.fn((u: string) => { revokedUrls.push(u) }) as never
  // 拦截 a.click()：jsdom 里会真的导航并打印 "Not implemented"
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('审计页：导出 CSV', () => {
  it('点击导出会请求导出端点，并触发一次下载', async () => {
    const m = await setup({ [API.auditExport()]: fakeRaw('\ufeffid,时间\n1,2026-01-01 00:00:00\n') })
    await btn(m, /导出 CSV/).click()
    await m.flush()

    expect(m.fake.count(API.auditExport())).toBe(1)
    // 真的生成了一个 objectURL 并立刻撤销（不撤销会一直占内存）
    expect(createdUrls).toHaveLength(1)
    expect(revokedUrls).toEqual(createdUrls)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    m.fake.assertClean()
    m.cleanup()
  })

  it('导出会带上当前筛选条件（与列表共用同一份，不是另起一套）', async () => {
    const m = await setup({ [API.auditExport()]: fakeRaw('id\n') })
    const actorInput = m.host.querySelector<HTMLInputElement>('input[placeholder="操作人"]')!
    // 受控输入必须用原生 setter + input 事件，否则 v-model 不响应
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(actorInput, 'alice')
    actorInput.dispatchEvent(new Event('input', { bubbles: true }))
    await m.flush()

    await btn(m, /导出 CSV/).click()
    await m.flush()

    const url = m.fake.calls.filter((c) => c.url.startsWith(API.auditExport()))[0].url
    expect(url).toContain('actor=alice')
    m.fake.assertClean()
    m.cleanup()
  })

  it('导出失败时把后端错误显示出来，而不是静默什么都没发生', async () => {
    const m = await setup({
      [API.auditExport()]: fakeError(403, 10003, 'permission denied', { required: 'audit.export' }),
    })
    await btn(m, /导出 CSV/).click()
    await m.flush()

    const err = m.host.querySelector('.err')?.textContent ?? ''
    expect(err).not.toBe('')
    // 失败时不该凭空造一个下载
    expect(createdUrls).toHaveLength(0)
    m.fake.assertClean()
    m.cleanup()
  })
})

describe('审计页：哈希链校验', () => {
  it('intact 显示"链完整"并带已校验条数', async () => {
    const m = await setup({
      [API.auditVerify()]: { status: 'intact', checked: 12, unchained: 0, broken_at_id: null, reason: null },
    })
    await btn(m, /校验完整性/).click()
    await m.flush()

    const chip = m.host.querySelector('.chain-chip')!
    expect(chip.textContent).toContain('链完整')
    expect(chip.textContent).toContain('12')
    m.fake.assertClean()
    m.cleanup()
  })

  it('有历史未上链记录时必须一并说明，不能只说"完整"', async () => {
    const m = await setup({
      [API.auditVerify()]: { status: 'intact', checked: 5, unchained: 7, broken_at_id: null, reason: null },
    })
    await btn(m, /校验完整性/).click()
    await m.flush()

    const t = m.host.querySelector('.chain-chip')!.textContent ?? ''
    expect(t).toContain('链完整')
    expect(t).toContain('7')
    expect(t).toMatch(/未上链/)
    m.cleanup()
  })

  it('broken 显示篡改位置与原因，且用危险色', async () => {
    const m = await setup({
      [API.auditVerify()]: { status: 'broken', checked: 0, unchained: 0, broken_at_id: 42, reason: '内容与 hash 不符' },
    })
    await btn(m, /校验完整性/).click()
    await m.flush()

    const chip = m.host.querySelector('.chain-chip')!
    expect(chip.textContent).toContain('42')
    expect(chip.textContent).toContain('内容与 hash 不符')
    expect(chip.classList.contains('badge-danger')).toBe(true)
    m.cleanup()
  })

  it('not_chained 绝不能被渲染成"通过"', async () => {
    const m = await setup({
      [API.auditVerify()]: { status: 'not_chained', checked: 0, unchained: 0, broken_at_id: null, reason: null },
    })
    await btn(m, /校验完整性/).click()
    await m.flush()

    const chip = m.host.querySelector('.chain-chip')!
    expect(chip.textContent).toContain('尚未上链')
    expect(chip.textContent).not.toContain('完整')
    // 不能给"成功"色
    expect(chip.classList.contains('badge-ok')).toBe(false)
    m.cleanup()
  })

  it('主密钥缺失（501）时把原因透出给用户', async () => {
    const m = await setup({
      [API.auditVerify()]: fakeError(501, 10009, 'master key not loaded'),
    })
    await btn(m, /校验完整性/).click()
    await m.flush()

    expect(m.host.querySelector('.err')?.textContent ?? '').not.toBe('')
    expect(m.host.querySelector('.chain-chip')).toBeNull()
    m.cleanup()
  })
})

describe('审计页：导出按钮的可用性', () => {
  it('列表为空时导出按钮置灰（没有可导出内容）', async () => {
    const m = await mountView({
      component: AuditView,
      caps: capsAllOk(),
      perms: PERMS,
      routes: { [API.audit()]: { items: [], page: 1, page_size: 20, total: 0 } },
    })
    await m.flush()
    expect(btn(m, /导出 CSV/).disabled).toBe(true)
    m.cleanup()
  })
})
