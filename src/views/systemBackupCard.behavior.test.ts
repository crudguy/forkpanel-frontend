// @vitest-environment jsdom
/**
 * 系统自动备份卡显示**实际生效值**——真挂载行为测试。
 *
 * 取代 `systemBackupCard.test.ts`（那份读 `.vue` 源码，断言出现
 * `{{ sysKeep }}` 与 `sysKeep.value = r.keep` 这两行字）。文本断言证明不了
 * "用户在自己机器上把 backup_keep 改成 30，页面真的显示 30"——而那正是
 * 这条纪律的全部价值：说得出值的文案才有用，只提配置名的文案信息量为零。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import BackupsView from '@/views/BackupsView.vue'
import { mountView, type Mounted } from '@/test/mount'

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

function sys(over: { keep?: number; daily_backup?: boolean } = {}) {
  return {
    dir: '/var/lib/forkpanel/backups',
    items: [],
    keep: 7,
    daily_backup: true,
    ...over,
  }
}

/** onMounted 会并发打这三个端点，少登记一个就会被 assertClean 抓到。 */
function routesFor(s: ReturnType<typeof sys>) {
  return {
    [API.backups.system()]: s,
    [API.backups.list()]: [],
    [API.db.connections()]: [],
  }
}

describe('系统自动备份卡：显示后端下发的实际生效值', () => {
  it('keep=7 时页面显示「实际保留 7 份」', async () => {
    m = await mountView({ component: BackupsView, routes: routesFor(sys({ keep: 7 })) })
    expect(m.host.textContent ?? '').toContain('实际保留 7 份')
    m.fake.assertClean()
  })

  it('把生效值改成 30，页面跟着变 30（不是写死的一句配置名）', async () => {
    m = await mountView({ component: BackupsView, routes: routesFor(sys({ keep: 30 })) })
    const text = m.host.textContent ?? ''
    expect(text).toContain('实际保留 30 份')
    expect(text).not.toContain('实际保留 7 份')
  })

  it('daily_backup=false 时明确提示「每日自动备份已关闭」', async () => {
    m = await mountView({ component: BackupsView, routes: routesFor(sys({ daily_backup: false })) })
    expect(m.host.textContent ?? '').toContain('每日自动备份已关闭')
  })

  it('daily_backup=true 时不出现「已关闭」误报', async () => {
    m = await mountView({ component: BackupsView, routes: routesFor(sys({ daily_backup: true })) })
    expect(m.host.textContent ?? '').not.toContain('每日自动备份已关闭')
  })

  it('后端没下发 keep 时如实显示 0，不编造默认值', async () => {
    const s = sys()
    // 模拟旧后端/降级响应缺字段：运行时 JS 完全可能拿到 undefined
    const degraded = { dir: s.dir, items: s.items, daily_backup: s.daily_backup }
    m = await mountView({
      component: BackupsView,
      routes: {
        ...routesFor(s),
        [API.backups.system()]: degraded,
      },
    })
    expect(m.host.textContent ?? '').toContain('实际保留 0 份')
  })
})
