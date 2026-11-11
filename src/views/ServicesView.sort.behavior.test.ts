// @vitest-environment jsdom
/**
 * 服务表格列头排序的行为测试（纯函数版）。
 *
 * 排序规则抽到 composables/svcTableSort.ts（纯函数），此处逐分支锁死：各列方向、
 * 状态语义严重度、布尔 1/0、空描述垫底、**同值一律按名字升序兜底**（不随方向翻转）。
 * 直接对纯函数断言，不挂真组件（组件只负责「点表头 → 调 sortSvcRows」），
 * 比在 catch-all 路由上硬切 Tab 稳，也不受 TabBar 渲染方式影响。
 */
import { describe, it, expect } from 'vitest'
import { sortSvcRows } from '@/composables/svcTableSort'
import type { ServiceInfo } from '@/api/types'

function svc(p: Partial<ServiceInfo> & { name: string }): ServiceInfo {
  return { state: 'active', enabled: false, description: null, managed: true, ...p }
}
const names = (xs: ServiceInfo[]) => xs.map(s => s.name)

const DATA = [
  svc({ name: 'nginx.service', state: 'active', enabled: true, description: 'A web server' }),
  svc({ name: 'apache2.service', state: 'failed', enabled: true, description: 'Apache' }),
  svc({ name: 'sshd.service', state: 'active', enabled: false, description: null }),
  svc({ name: 'cron.service', state: 'inactive', enabled: false, description: '' }),
]

describe('sortSvcRows', () => {
  it('服务名升 / 降序', () => {
    expect(names(sortSvcRows(DATA, 'name', 'asc')))
      .toEqual(['apache2.service', 'cron.service', 'nginx.service', 'sshd.service'])
    expect(names(sortSvcRows(DATA, 'name', 'desc')))
      .toEqual(['sshd.service', 'nginx.service', 'cron.service', 'apache2.service'])
  })

  it('按状态：健康（active）在前，failed/inactive 在后；同状态按名字兜底', () => {
    expect(names(sortSvcRows(DATA, 'state', 'asc')))
      .toEqual(['nginx.service', 'sshd.service', 'apache2.service', 'cron.service'])
    // 反向：inactive→failed→active，同状态内名字仍升序
    expect(names(sortSvcRows(DATA, 'state', 'desc')))
      .toEqual(['cron.service', 'apache2.service', 'nginx.service', 'sshd.service'])
  })

  it('按开机自启：是/否按 1/0 排，同值按名字兜底（不随方向翻转）', () => {
    // asc：否(0) 在前 ⇒ cron、sshd；是(1) 在后 ⇒ apache2、nginx
    expect(names(sortSvcRows(DATA, 'enabled', 'asc')))
      .toEqual(['cron.service', 'sshd.service', 'apache2.service', 'nginx.service'])
    // desc：是 在前 ⇒ apache2、nginx；否 在后 ⇒ cron、sshd
    expect(names(sortSvcRows(DATA, 'enabled', 'desc')))
      .toEqual(['apache2.service', 'nginx.service', 'cron.service', 'sshd.service'])
  })

  it('按说明：A→Z，空描述统一垫底；同值按名字兜底', () => {
    // 非空里 'A web server' < 'Apache'（第 2 字符空格 < h），故 nginx 先
    expect(names(sortSvcRows(DATA, 'desc', 'asc')))
      .toEqual(['nginx.service', 'apache2.service', 'cron.service', 'sshd.service'])
    expect(names(sortSvcRows(DATA, 'desc', 'desc')))
      .toEqual(['apache2.service', 'nginx.service', 'cron.service', 'sshd.service'])
  })

  it('不改动入参（返回新数组）', () => {
    const before = names(DATA).slice()
    sortSvcRows(DATA, 'state', 'desc')
    expect(names(DATA)).toEqual(before)
  })

  it('未知状态排在最后（rank 99）', () => {
    const xs = [
      svc({ name: 'a.service', state: 'failed' }),
      svc({ name: 'b.service', state: 'unknown' }),
      svc({ name: 'c.service', state: 'active' }),
    ]
    expect(names(sortSvcRows(xs, 'state', 'asc'))).toEqual(['c.service', 'a.service', 'b.service'])
  })
})
