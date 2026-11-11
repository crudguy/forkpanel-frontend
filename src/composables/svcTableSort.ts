/**
 * 「软件与服务」页·服务表格的列头排序：纯函数单一事实源（有单测）。
 *
 * 为什么抽到 .ts：SFC 里的函数 vitest 收不到，而排序规则（状态按严重度、布尔
 * 列 1/0、空描述垫底、同值按名字兜底稳定序）最容易写反——抽出来逐分支锁死，
 * 视图只负责「点表头 → 调它」，行为测试直接对纯函数断言，比挂真组件稳得多。
 */
import type { ServiceInfo } from '@/api/types'

export type SvcSortKey = 'name' | 'state' | 'enabled' | 'desc'
export type SvcSortDir = 'asc' | 'desc'

/** 状态语义严重度：运行中最健康、已停止次之、未知最靠后。同状态再按名字稳定。 */
export const STATE_RANK: Record<string, number> = {
  active: 0, activating: 1, deactivating: 2, failed: 3, inactive: 4, unknown: 5,
}

/** 在一份**已确定**的服务集合上排序（不改动入参，返回新数组）。
 *  调用方先把筛选结果（如「仅看失败」）备好再传入，排序与筛选正交。
 *
 *  约定：主键按 dir 排，**同值时一律按服务名升序兜底**（不随 dir 翻转）——
 *  这样「是/否」「同一状态」内部的相对顺序永远稳定可读，不会倒序时名字也倒过来。 */
export function sortSvcRows(input: ServiceInfo[], key: SvcSortKey, dir: SvcSortDir): ServiceInfo[] {
  const d = dir === 'asc' ? 1 : -1
  const byName = (x: ServiceInfo, y: ServiceInfo) => x.name.localeCompare(y.name, 'en')
  return input.slice().sort((a, b) => {
    switch (key) {
      case 'state': {
        const ra = STATE_RANK[a.state] ?? 99, rb = STATE_RANK[b.state] ?? 99
        return ra === rb ? byName(a, b) : (ra - rb) * d
      }
      case 'enabled': {
        const ea = a.enabled ? 1 : 0, eb = b.enabled ? 1 : 0
        return ea === eb ? byName(a, b) : (ea - eb) * d
      }
      case 'desc': {
        const da = a.description ?? '', db = b.description ?? ''
        // 空描述统一排末尾（与「—」占位视觉一致），独立于 dir
        if (!da && db) return 1
        if (db && !da) return -1
        const c = da.localeCompare(db, 'zh')
        return c === 0 ? byName(a, b) : c * d
      }
      case 'name':
      default:
        return byName(a, b) * d
    }
  })
}
