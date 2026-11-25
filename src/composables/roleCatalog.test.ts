// @vitest-environment jsdom
/**
 * 角色目录与权限分配判据的行为测试。
 *
 * 钉住本次的真实回归：**新建用户弹窗把角色写死成三个内置名**，导致设置页里
 * 建出来的自定义角色无法指派给任何账号。判据必须验证「目录里有什么」，
 * 而不是"代码里有没有 ROLES 常量"——后者在弹窗写死时也是绿的。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { installApiFake, type ApiFake, type FakeRoute } from '@/test/apiFake'
import { API } from '@/api/endpoints'
import {
  loadRoleCatalog, assignableRoles, missingFromGranted, roleOptionLabel, type RoleRow,
} from './roleCatalog'

let fake: ApiFake | null = null
afterEach(() => { fake?.restore(); fake = null })

const ROLES: RoleRow[] = [
  { name: 'admin', permissions: ['system.view', 'user.manage'], builtin: true, created_at: null },
  { name: 'operator', permissions: ['system.view', 'site.manage'], builtin: true, created_at: null },
  { name: 'owner', permissions: ['system.view', 'user.manage'], builtin: true, created_at: null },
  { name: 'viewer', permissions: ['system.view'], builtin: true, created_at: null },
  { name: 'site-ops', permissions: ['system.view', 'site.view'], builtin: false, created_at: 1700000000 },
]

function seeded(route: FakeRoute) {
  fake = installApiFake({ [API.roles.list()]: route })
}

describe('loadRoleCatalog', () => {
  it('把后端 {roles, known_permissions} 解析成目录（含自定义角色）', async () => {
    seeded({ roles: ROLES, known_permissions: ['system.view', 'site.view', 'user.manage'] })
    const cat = await loadRoleCatalog()
    expect(cat.roles.map(r => r.name)).toContain('site-ops')
    expect(cat.knownPermissions).toEqual(['system.view', 'site.view', 'user.manage'])
    fake!.assertClean()
  })

  it('字段缺失时降级为空数组而不是抛（后端异常路径返 null）', async () => {
    seeded({})
    const cat = await loadRoleCatalog()
    expect(cat.roles).toEqual([])
    expect(cat.knownPermissions).toEqual([])
    fake!.assertClean()
  })
})

describe('assignableRoles', () => {
  it('**自定义角色必须出现在可分配清单里**（本次回归的正主）', () => {
    const got = assignableRoles({ roles: ROLES, knownPermissions: [] })
    expect(got.map(r => r.name)).toContain('site-ops')
  })

  it('owner 被排除（只能由引导流程产生），其余三项内置保留', () => {
    const got = assignableRoles({ roles: ROLES, knownPermissions: [] }).map(r => r.name)
    expect(got).not.toContain('owner')
    expect(got).toEqual(['admin', 'operator', 'viewer', 'site-ops'])
  })

  it('目录未加载时为空数组（不崩、不默认给出"看似可选"的假选项）', () => {
    expect(assignableRoles(null)).toEqual([])
  })
})

describe('missingFromGranted（防提权前端预判）', () => {
  it('角色权限全在自身权限内 → 空（可分配）', () => {
    expect(missingFromGranted(['site.view'], ['site.view', 'site.manage'])).toEqual([])
  })

  it('角色含自己没有的权限 → 逐项列出（用于精确提示，而不是笼统"不能分配"）', () => {
    expect(missingFromGranted(['site.view', 'user.manage'], ['site.view'])).toEqual(['user.manage'])
  })

  it('内置 admin 对只有 site 权限的账号不可分配（与后端 ensure_no_escalation 同口径）', () => {
    const admin = ROLES.find(r => r.name === 'admin')!
    expect(missingFromGranted(admin.permissions, ['system.view', 'site.view'])).toContain('user.manage')
  })
})

describe('roleOptionLabel', () => {
  it('自定义角色带后缀，内置保持原名', () => {
    expect(roleOptionLabel(ROLES[0])).toBe('admin')
    expect(roleOptionLabel(ROLES[4])).toBe('site-ops（自定义）')
  })
})
