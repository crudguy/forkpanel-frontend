/**
 * 「编辑资源限制」弹窗的**纯逻辑**：校验 / 脏检查 / 载荷组装 / 现值展示。
 *
 * 为什么单独放 .ts：vitest 只收 `src/**\/*.test.ts`（没有 vue 插件），逻辑写在
 * `.vue` 里等于测不到；而这些函数恰好是"界面上说给用户听的话"与"实际发给后端
 * 的东西"之间的唯一换算处，错了就是假控制（比如让 `0` 通过校验 —— docker 会
 * 静默忽略它，界面显示保存成功而值纹丝不动）。
 *
 * ⚠ 后端会**再校验一次**（前端校验不可作数），这里只是为了让用户在提交前
 * 就看到问题，而不是吃一个 400。
 */

/** 表单里三个输入框的原始文本。 */
export interface LimitsForm {
  cpuQuota: string
  memLimit: string
  restart: string
}

/** `GET /containers/{id}/limits` 的返回：`null` 表示**未设上限**（不是 0）。 */
export interface CurrentLimits {
  cpu_quota: number | null
  mem_limit: string | null
  restart: string
}

/** 与后端 `mem_limit_is_safe` 同口径：数字 + 可选单个 k/m/g（大小写不敏感）。 */
const MEM_RE = /^\d+[kmg]?$/i

/**
 * CPU 输入的校验消息（空串 = 通过）。
 *
 * 留空**不是**"不限制"，而是"保持不变"——`docker update --cpus 0` 会被守护
 * 进程静默忽略，所以"取消限制"这件事在编辑里根本做不到，给个空值当"不限"
 * 只会做出一个点了没反应的按钮。要彻底去掉限制只能删容器重建。
 */
export function cpuError(v: string): string {
  const t = v.trim()
  if (!t) return ''
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return 'CPU 配额须为正数（留空 = 保持不变）'
  return ''
}

/** 内存输入的校验消息（空串 = 通过）。口径与后端 `mem_limit_is_safe` 一致。 */
export function memError(v: string): string {
  const t = v.trim()
  if (!t) return ''
  if (!MEM_RE.test(t)) return '格式应为数字 + 可选 k/m/g，如 512m、2g（留空 = 保持不变）'
  if (Number(t.replace(/[kmg]$/i, '')) <= 0) return '内存上限须大于 0（留空 = 保持不变）'
  return ''
}

/** 整个表单是否可以提交：两项都无错、现值已加载、且确实有变更。 */
export function canSubmit(f: LimitsForm, cur: CurrentLimits | null): boolean {
  if (!cur) return false // 还没读到现值：不知道会改成什么，不允许提交
  if (cpuError(f.cpuQuota) || memError(f.memLimit)) return false
  return isDirty(f, cur)
}

/**
 * 是否有实际变更。
 *
 * 用于禁用提交按钮——没有变更时点一下会白白调一次 `docker update`，
 * 而 `docker update` 成功返回 204，用户看到"已保存"却什么都没发生。
 * 留空的字段视为"不改"，故不参与比较。
 */
export function isDirty(f: LimitsForm, cur: CurrentLimits | null): boolean {
  if (!cur) return false
  if ((f.restart || 'no') !== (cur.restart || 'no')) return true
  const cpu = f.cpuQuota.trim()
  if (cpu && (cur.cpu_quota == null || Number(cpu) !== cur.cpu_quota)) return true
  const mem = f.memLimit.trim()
  if (mem && (cur.mem_limit == null || mem.toLowerCase() !== cur.mem_limit.toLowerCase())) return true
  return false
}

/** 组装 PATCH 载荷：**留空字段直接省略**（后端把"未提供"当保持不变）。 */
export function buildPayload(f: LimitsForm): {
  cpu_quota?: number
  mem_limit?: string
  restart?: string
} {
  const p: { cpu_quota?: number; mem_limit?: string; restart?: string } = {}
  const cpu = f.cpuQuota.trim()
  if (cpu) p.cpu_quota = Number(cpu)
  const mem = f.memLimit.trim()
  if (mem) p.mem_limit = mem
  if (f.restart) p.restart = f.restart
  return p
}

/** 现值的人类可读串（弹窗顶部"当前：…"），`null` 明确写成"不限"而不是 0。 */
export function fmtCurrent(cur: CurrentLimits | null): string {
  if (!cur) return '—'
  const cpu = cur.cpu_quota == null ? '不限' : `${cur.cpu_quota} 核`
  const mem = cur.mem_limit == null ? '不限' : cur.mem_limit
  return `CPU ${cpu} · 内存 ${mem} · 重启 ${cur.restart || 'no'}`
}

/** 表单初值：从现值回填（`null` → 空串，表示"这项没设限制，留空就是不动它"）。 */
export function formFromCurrent(cur: CurrentLimits): LimitsForm {
  return {
    cpuQuota: cur.cpu_quota == null ? '' : String(cur.cpu_quota),
    memLimit: cur.mem_limit ?? '',
    restart: cur.restart || 'no',
  }
}
