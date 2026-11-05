// @vitest-environment jsdom
/**
 * 容器页「刻意不提供的操作」的上下文引导——真挂载行为测试。
 *
 * 取代 `boundaryGuidance.test.ts`（那份读 `.vue` 源码、剥注释、断言
 * `<RiskBanner … />` 这个**标签**里含某关键词）。标签存在 ≠ 用户看得见：
 * 把 banner 挪进 `v-if="rows.length"` 块里，源码断言照样全绿，而空环境
 * （恰恰最需要解释"为什么没有创建按钮"的地方）用户看到的是一片空白。
 *
 * 所以这里四个 Tab 全部以 `active: true` + **空列表**挂载，断言 `.risk`
 * 真的出现在 DOM 里、文案点名那一项、并给出可执行的下一步。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { API } from '@/api/endpoints'
import ContainersTab from './ContainersTab.vue'
import NetworksTab from './NetworksTab.vue'
import VolumesTab from './VolumesTab.vue'
import ComposeTab from './ComposeTab.vue'
import { mountView, type Mounted } from '@/test/mount'

let m: Mounted | null = null
afterEach(() => { m?.cleanup(); m = null })

/** 四个 Tab 挂载时可能打到的全部端点，一律回空列表（空环境是主判据）。 */
const ROUTES = {
  [API.containers.list()]: [],
  [API.containers.networks()]: [],
  [API.containers.volumes()]: [],
  [API.containers.composeProjects()]: [],
  [API.containers.stacks()]: [],
}

const cases = [
  {
    name: 'ContainersTab', component: ContainersTab,
    props: { active: true, canManage: true, canViewLogs: true, supported: true },
    keyword: 'docker exec',
  },
  { name: 'NetworksTab', component: NetworksTab, props: { active: true }, keyword: '创建 / 删除网络' },
  { name: 'VolumesTab', component: VolumesTab, props: { active: true }, keyword: '创建 / 删除卷' },
  {
    name: 'ComposeTab', component: ComposeTab,
    props: { active: true, canManage: true, supported: true },
    keyword: '项目级日志',
  },
]

describe('容器 Tab：空环境里也必须看得到边界引导', () => {
  for (const c of cases) {
    it(`${c.name} 渲染 RiskBanner，点明「${c.keyword}」并给出可执行下一步`, async () => {
      m = await mountView({ component: c.component, props: c.props, routes: ROUTES })
      const banners = [...m.host.querySelectorAll('.risk')]
      expect(banners.length, '该 Tab 必须真的渲染出 RiskBanner（不能只写在源码里）')
        .toBeGreaterThan(0)
      const text = banners.map((b) => b.textContent ?? '').join('\n')
      expect(text, `banner 文案须点明「${c.keyword}」`).toContain(c.keyword)
      expect(text, '只说"不行"没用，须给出可执行下一步').toMatch(/docker CLI|终端/)
      m.fake.assertClean()
    })
  }
})
