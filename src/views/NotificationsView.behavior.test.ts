// @vitest-environment jsdom
/**
 * 通知页的**用户可见行为**：级别中文、来源跳转、正文纯文本、确认权限、分页与失败态。
 *
 * 为什么必须真挂载：英文级别、死链、星号外露、"没有权限却可清空全局未读"、
 * 以及"只有前 100 条可达"这些问题，vue-tsc / 构建 / 源码断言全都看不出来。
 * 这里用真 fetch 假件跑完整链路（组件 → api → fetch → store），断言 DOM 与 store。
 */
import { describe, it, expect } from 'vitest'
import NotificationsView from './NotificationsView.vue'
import { mountView } from '@/test/mount'
import { fakeError, type FakeRoute } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import { useNotificationsStore } from '@/stores/notifications'

interface Item {
  id: number
  ts: number
  level: string
  source: string
  title: string
  body: string | null
  read: boolean
}

const PERMS = ['system.view', 'system.manage', 'notification.manage']
const VIEWER_PERMS = ['system.view']
const NOW = 1_794_887_208

/** 一个会随写操作变化的后端：未读数与列表保持真实关系（不是两套写死常量）。 */
function backend() {
  const items: Item[] = [
    { id: 1, ts: NOW, level: 'crit', source: 'restore', title: '恢复计划失败', body: '请人工确认现场', read: false },
    { id: 2, ts: NOW - 3600, level: 'warn', source: 'backup', title: '远端上传失败', body: '**异地副本缺失**，请检查', read: false },
  ]
  let count = 2
  return {
    routes: {
      [API.notifications.list()]: () => items,
      [API.notifications.unreadCount()]: () => ({ count }),
      [API.notifications.markRead(1)]: () => { items[0].read = true; count -= 1; return true },
      [API.notifications.readAll()]: () => {
        for (const n of items) n.read = true
        const updated = count
        count = 0
        return { updated }
      },
    },
    items,
  }
}

const rows = () => Array.from(document.querySelectorAll('.list .item'))
const badge = () => document.querySelector('.tools-row .badge')?.textContent?.trim() ?? null
const button = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.tools-row button, .list button'))
    .find((b) => b.textContent?.includes(text))
const anyButton = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => b.textContent?.includes(text))
const refreshButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .filter((b) => b.textContent?.trim() === '刷新')

describe('通知页：级别、来源、正文', () => {
  it('crit 显示「错误」而不是英文原值；来源中文化；正文星号不外露', async () => {
    const be = backend()
    const m = await mountView({ component: NotificationsView, perms: PERMS, routes: be.routes })
    try {
      await m.flush()
      expect(rows()).toHaveLength(2)
      expect(rows()[0].querySelector('.lvl')?.textContent).toBe('错误')
      expect(rows()[1].querySelector('.lvl')?.textContent).toBe('警告')
      expect(rows()[0].textContent).not.toContain('crit')
      expect(Array.from(document.querySelectorAll('.tag')).map((e) => e.textContent)).toEqual(['恢复', '备份'])
      expect(rows()[1].querySelector('.body')?.textContent).toBe('异地副本缺失，请检查')
      // 级别类必须带前缀：main.css 里有全局工具类 `.warn { color: var(--c-warn) }`，
      // 把 level 裸当类名会让整行（含标题）变成琥珀色，而 jsdom 不加载全局样式表、
      // 单测/构建全都看不出来。这条断言钉住「别裸用」。
      expect(rows()[0].className).toContain('lv-crit')
      expect(rows()[1].className).toContain('lv-warn')
      expect(rows()[1].classList.contains('warn'), '不能裸用 level 当类名（撞全局 .warn 文字色）').toBe(false)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })

  it('标题按来源跳业务页；未登记来源退化为纯文本，不给死链', async () => {
    const be = backend()
    be.items.push({ id: 3, ts: NOW - 7200, level: 'info', source: 'plugin', title: '第三方事件', body: null, read: true })
    const m = await mountView({ component: NotificationsView, perms: PERMS, routes: be.routes })
    try {
      await m.flush()
      const links = Array.from(document.querySelectorAll('.title-link')) as HTMLAnchorElement[]
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['/backups', '/backups'])
      expect(rows()[2].querySelector('strong')?.textContent).toBe('第三方事件')
      expect(rows()[2].querySelector('a')).toBeNull()
      m.fake.assertClean()
    } finally { m.cleanup() }
  })
})

describe('通知页：写操作权限', () => {
  it('标记单条已读：store 未读数与页面徽标同步减一', async () => {
    const be = backend()
    const m = await mountView({ component: NotificationsView, perms: PERMS, routes: be.routes })
    try {
      await m.flush()
      const store = useNotificationsStore()
      expect(store.unread, '首屏未读数应来自 store').toBe(2)
      expect(badge()).toBe('未读 2')

      button('标记已读')!.click()
      await m.flush()

      expect(be.items[0].read).toBe(true)
      expect(store.unread).toBe(1)
      expect(badge()).toBe('未读 1')
      expect(rows()[0].className).toContain('read')
      expect(m.fake.count(API.notifications.markRead(1), 'POST')).toBe(1)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })

  it('全部已读：store 清零，徽标消失（顶栏读同一份状态）', async () => {
    const be = backend()
    const m = await mountView({ component: NotificationsView, perms: PERMS, routes: be.routes })
    try {
      await m.flush()
      const store = useNotificationsStore()
      expect(store.unread).toBe(2)

      button('全部已读')!.click()
      await m.flush()

      expect(store.unread).toBe(0)
      expect(badge()).toBeNull()
      expect(rows().every((r) => r.className.includes('read'))).toBe(true)
      expect(m.fake.count(API.notifications.readAll(), 'POST')).toBe(1)
      // 不能重拉列表：用户可能已经「加载更多」翻过几页，重拉会把它们丢回第一页、
      // 滚动位置也回到顶部。全读是幂等状态，本地置已读即可。
      expect(m.fake.count(API.notifications.list(), 'GET'), '全部已读后不应重拉列表').toBe(1)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })

  it('只读角色能看列表，但看不到任何确认按钮（全局 read 旗标不是只读可改的）', async () => {
    const be = backend()
    const m = await mountView({ component: NotificationsView, perms: VIEWER_PERMS, routes: be.routes })
    try {
      await m.flush()
      expect(rows()).toHaveLength(2)
      expect(badge()).toBe('未读 2')
      expect(button('标记已读')).toBeUndefined()
      expect(button('全部已读')).toBeUndefined()
      expect(m.fake.count(API.notifications.readAll(), 'POST')).toBe(0)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })
})

describe('通知页：分页与失败态', () => {
  it('满一页给「加载更多」，追加后再显示已加载全部', async () => {
    const first: Item[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, ts: NOW - i, level: 'warn', source: 'backup', title: `历史通知 ${i + 1}`, body: null, read: true,
    }))
    const second: Item[] = [
      { id: 101, ts: NOW - 100, level: 'warn', source: 'backup', title: '更早通知 1', body: null, read: true },
      { id: 102, ts: NOW - 101, level: 'warn', source: 'backup', title: '更早通知 2', body: null, read: true },
    ]
    const list: FakeRoute = (ctx) => {
      const offset = Number(new URL(ctx.url, 'http://local').searchParams.get('offset') ?? 0)
      return offset === 0 ? first : second
    }
    const m = await mountView({
      component: NotificationsView, perms: PERMS,
      routes: {
        [API.notifications.list()]: list,
        [API.notifications.unreadCount()]: { count: 0 },
      },
    })
    try {
      await m.flush()
      expect(rows()).toHaveLength(100)
      expect(anyButton('加载更多')).toBeTruthy()
      expect(document.body.textContent).not.toContain('已加载全部')

      anyButton('加载更多')!.click()
      await m.flush()

      expect(rows()).toHaveLength(102)
      expect(rows()[101].textContent).toContain('更早通知 2')
      expect(document.body.textContent).toContain('已加载全部 102 条通知')
      expect(anyButton('加载更多')).toBeUndefined()
      expect(m.fake.calls.some((c) => c.url.includes('offset=100'))).toBe(true)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })

  it('翻页期间来了新通知导致下一页重复时，按 id 去重不留重复行', async () => {
    // offset 分页的真实缺陷：翻页期间插入一条更新的通知，整个窗口后移一位，
    // 第二页会把第一页最后那条再返回一次。不去重则 Vue 因重复 key 复用错行，
    // 用户也会看到两条一模一样的通知。
    const first: Item[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, ts: NOW - i, level: 'warn', source: 'backup', title: `历史通知 ${i + 1}`, body: null, read: true,
    }))
    const second: Item[] = [
      { id: 100, ts: NOW - 99, level: 'warn', source: 'backup', title: '历史通知 100', body: null, read: true },
      { id: 101, ts: NOW - 100, level: 'warn', source: 'backup', title: '更早通知 1', body: null, read: true },
    ]
    const list: FakeRoute = (ctx) => {
      const offset = Number(new URL(ctx.url, 'http://local').searchParams.get('offset') ?? 0)
      return offset === 0 ? first : second
    }
    const m = await mountView({
      component: NotificationsView, perms: PERMS,
      routes: {
        [API.notifications.list()]: list,
        [API.notifications.unreadCount()]: { count: 0 },
      },
    })
    try {
      await m.flush()
      expect(rows()).toHaveLength(100)

      anyButton('加载更多')!.click()
      await m.flush()

      // 重复的 100 号被丢掉，只多出 101 号
      expect(rows()).toHaveLength(101)
      expect(rows()[100].textContent).toContain('更早通知 1')
      expect(rows().filter((r) => r.textContent?.includes('历史通知 100'))).toHaveLength(1)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })

  it('列表加载失败只显示错误条，不再假报「暂无通知」', async () => {
    const be = backend()
    const m = await mountView({
      component: NotificationsView, perms: PERMS,
      routes: { ...be.routes, [API.notifications.list()]: fakeError(500, 10901, '后端炸了') },
    })
    try {
      await m.flush()
      expect(document.querySelector('.err-bar')?.textContent).toContain('后端炸了')
      expect(document.body.textContent).not.toContain('暂无通知')
      m.fake.assertClean()
    } finally { m.cleanup() }
  })
})

describe('通知页：刷新入口唯一', () => {
  // 空态里曾额外放一个 RefreshBtn，与右上角工具行那个都调 load()：
  // 用户看到两个一模一样的按钮，点哪个都一样。jsdom 不求值 CSS，
  // 只能靠真挂载数 DOM 才能挡住「又加回来」。
  it('空态只有右上角一个刷新，点击它重拉列表', async () => {
    const m = await mountView({
      component: NotificationsView, perms: PERMS,
      routes: { [API.notifications.list()]: () => [], [API.notifications.unreadCount()]: { count: 0 } },
    })
    try {
      await m.flush()
      expect(document.querySelector('.empty')).not.toBeNull()
      expect(refreshButtons()).toHaveLength(1)
      expect(document.querySelector('.tools-row')?.contains(refreshButtons()[0])).toBe(true)

      refreshButtons()[0].click()
      await m.flush()
      expect(m.fake.count(API.notifications.list(), 'GET')).toBe(2)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })

  it('有列表时也只有一个刷新', async () => {
    const be = backend()
    const m = await mountView({ component: NotificationsView, perms: PERMS, routes: be.routes })
    try {
      await m.flush()
      expect(rows()).toHaveLength(2)
      expect(refreshButtons()).toHaveLength(1)
      m.fake.assertClean()
    } finally { m.cleanup() }
  })
})
