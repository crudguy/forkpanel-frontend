// @vitest-environment jsdom
//
// 新建用户弹窗的角色下拉必须由 `GET /roles` 的响应驱动。
//
// 曾经的 bug：UsersView 里写死 `const ROLES = ['admin','operator','viewer']`，
// 于是设置页里创建的自定义角色永远不可能指派给账号——后端 RBAC 一直是对的，
// 用户看到的却是"什么角色权限都是全部"。这组用例钉住三件事：
//   1. 自定义角色真的出现在下拉里（不是只信内置三件套）；
//   2. 选项文案带上权限项数，且自定义角色有「（自定义）」后缀；
//   3. owner 不可指派（后端 ASSIGNABLE_ROLES 排除它，前端也不许列出来）。
//
// ⚠ 判据纪律：断言的是**挂载后 DOM 里的 option**，不是源码字符串——
//   `readFileSync + toContain('assignableRoles')` 只能证明写了这行字，
//   证明不了下拉里真的有自定义角色。
//
// ⚠ 每个用例必须 `cleanup()`：`mountView` 把组件挂在 document.body 上，
//   漏收尾会留下未卸载的 app 与上一轮的 `.mask`，`document.querySelector`
//   抓到的是**上一个用例的弹窗**——负向对照因此假红（实测踩过：只回内置
//   角色的用例仍看到了上一轮的自定义角色）。
import { describe, it, expect, afterEach } from 'vitest'
import UsersView from './UsersView.vue'
import { mountView, capsAllOk, type Mounted } from '@/test/mount'
import { API } from '@/api/endpoints'
import { buttonByText } from '@/test/toastHarness'

/** 已挂载实例：afterEach 统一收尾，谁漏了 cleanup 由这个兜住。 */
const mounted: Mounted[] = []

afterEach(() => {
  while (mounted.length) mounted.pop()!.cleanup()
})

const ALL = [
  'system.view', 'system.manage', 'service.view', 'service.manage',
  'site.view', 'site.manage', 'user.manage', 'settings.manage',
]

const ROLES = [
  { name: 'owner', permissions: ALL, builtin: true, created_at: null },
  { name: 'admin', permissions: ALL.slice(0, 7), builtin: true, created_at: null },
  { name: 'operator', permissions: ['system.view', 'service.view', 'site.view'], builtin: true, created_at: null },
  { name: 'viewer', permissions: ['system.view'], builtin: true, created_at: null },
  // 设置页里自建的角色——就是它在旧实现里指派不出去
  { name: 'read-ops', permissions: ['system.view', 'service.view', 'site.view'], builtin: false, created_at: 1_700_000_000 },
]

const USERS = [
  { id: 1, username: 'admin', role: 'owner', disabled: false, created_at: 1, last_login_at: null, mfa_enabled: false, allowed_roots: [] },
]

async function mountUsers(roles = ROLES): Promise<Mounted> {
  const m = await mountView({
    component: UsersView,
    caps: capsAllOk(),
    perms: ALL,
    routes: {
      [API.users.list()]: USERS,
      [API.roles.list()]: { roles, known_permissions: ALL },
    },
  })
  mounted.push(m)
  return m
}

/** 打开「新建用户」弹窗并返回角色下拉。 */
async function openCreate(m: Mounted): Promise<HTMLSelectElement> {
  buttonByText(m.host, /新建用户|添加用户|新增用户/).click()
  await m.flush()
  const sel = document.querySelector('.mask select') as HTMLSelectElement | null
  if (!sel) throw new Error('新建用户弹窗里找不到角色下拉')
  return sel
}

describe('新建用户 · 角色下拉来自接口', () => {
  it('自定义角色出现在可指派清单里（旧实现写死 3 个内置名，此处会缺 read-ops）', async () => {
    const m = await mountUsers()
    const sel = await openCreate(m)
    const values = [...sel.options].map(o => o.value)
    expect(values, '自定义角色 read-ops 必须可指派').toContain('read-ops')
  })

  it('内置三件套仍在，owner 不可指派', async () => {
    const m = await mountUsers()
    const sel = await openCreate(m)
    const values = [...sel.options].map(o => o.value)
    expect(values).toEqual(expect.arrayContaining(['admin', 'operator', 'viewer']))
    expect(values, 'owner 不能经 API 指派，前端不许列出来').not.toContain('owner')
  })

  it('选项文案带权限项数，自定义角色有（自定义）后缀', async () => {
    const m = await mountUsers()
    const sel = await openCreate(m)
    const byValue = new Map([...sel.options].map(o => [o.value, o.textContent ?? '']))
    expect(byValue.get('operator')).toMatch(/3\s*项权限/)
    expect(byValue.get('read-ops')).toMatch(/read-ops/)
    expect(byValue.get('read-ops')).toMatch(/自定义/)
    expect(byValue.get('read-ops')).toMatch(/3\s*项权限/)
  })

  it('选中受限角色后回显它的权限标签（让用户能自证"范围不是全部"）', async () => {
    const m = await mountUsers()
    const sel = await openCreate(m)
    sel.value = 'read-ops'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await m.flush()
    const block = document.querySelector('.role-perms')
    expect(block, '选中角色后应有权限回显区块').not.toBeNull()
    const tags = [...block!.querySelectorAll('code')].map(c => c.textContent?.trim())
    expect(tags).toEqual(['system.view', 'service.view', 'site.view'])
  })

  it('负向对照：接口只回内置角色时，不得凭空多出 read-ops', async () => {
    const m = await mountUsers(ROLES.filter(r => r.builtin))
    const sel = await openCreate(m)
    const values = [...sel.options].map(o => o.value)
    expect(values).not.toContain('read-ops')
    expect(values).toEqual(expect.arrayContaining(['admin', 'operator', 'viewer']))
  })
})
