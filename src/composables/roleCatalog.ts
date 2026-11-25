/**
 * 角色目录的**唯一事实源**：`GET /api/v1/roles` → 可分配选项。
 *
 * 为什么需要它：新建用户弹窗曾把角色写死成 `['admin','operator','viewer']`
 * 三个内置名，于是**在「设置 → 角色权限」里建出来的自定义角色，谁也没法指派**
 * ——角色建好了却无法挂到任何账号上，看起来就是「角色权限功能不正常」。
 * 后端 `ensure_role_assignable` 一直是「内置可分配名单 ∪ 库里的自定义角色」，
 * 口径从来没丢，丢的是前端没去读。
 *
 * 三条前端判据，缺任何一条都会退化成"看起来能用、其实没生效"：
 * 1. **选项来自后端**：内置 + 自定义，不再写死数组。
 * 2. **选项旁边给权限**：只让人看到角色名，等价于让他在看不见权限的情况下授权，
 *    而角色权限正是本次被质疑「不准」的那一层。选中即展开该角色的权限集合。
 * 3. **超权角色置灰**：后端 `ensure_no_escalation` 会 400，这里提前禁用，
 *    并说清缺哪一项，不让用户提交一次注定失败的请求。
 *
 * ⚠ 前端过滤只是省一次 400，**不是安全边界**：判定与拒绝仍以
 *   `routes/users.rs::ensure_no_escalation` 为准。
 */
import { api } from '@/api/client'
import { API } from '@/api/endpoints'

export interface RoleRow {
  name: string
  permissions: string[]
  builtin: boolean
  created_at: number | null
}

/** `GET /roles` 的响应（后端 `{ roles, known_permissions }`） */
export interface RoleCatalog {
  roles: RoleRow[]
  knownPermissions: string[]
}

/** `owner` 只能由引导流程/CLI 产生，不可经 API 分配（多 owner 会让「唯一不可剥夺的管理员」消失）。 */
export const NON_ASSIGNABLE_ROLES: readonly string[] = ['owner']

export async function loadRoleCatalog(): Promise<RoleCatalog> {
  const r = await api.get<{ roles?: RoleRow[]; known_permissions?: string[] }>(API.roles.list())
  return {
    roles: (r.roles ?? []).map(x => ({
      name: x.name,
      permissions: x.permissions ?? [],
      builtin: !!x.builtin,
      created_at: x.created_at ?? null,
    })),
    knownPermissions: r.known_permissions ?? [],
  }
}

/** 可经 API 分配给账号的角色（顺序即下拉框顺序：先内置四档，再自定义按名）。 */
export function assignableRoles(cat: RoleCatalog | null): RoleRow[] {
  if (!cat) return []
  return cat.roles.filter(r => !NON_ASSIGNABLE_ROLES.includes(r.name))
}

/** 该角色中**当前登录者没有**的权限（非空 ⇒ 不可分配，后端会 400）。 */
export function missingFromGranted(rolePerms: string[], granted: string[]): string[] {
  const have = new Set(granted)
  return rolePerms.filter(p => !have.has(p))
}

/** 角色显示名：只写权限项容易被当成"只有这些权限"，补一句类别。 */
export function roleOptionLabel(r: RoleRow): string {
  return r.builtin ? r.name : `${r.name}（自定义）`
}
