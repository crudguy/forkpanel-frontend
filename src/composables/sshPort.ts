/**
 * SSH 端口修改的**纯逻辑**（表单校验 + 提示文案）。
 *
 * 为什么单独一个文件：`vitest.config.ts` 只收 `src/**\/*.test.ts`，
 * 逻辑写在 `.vue` 里就没法测（本仓已因此漏过一版静默失败）。
 * 这里只放可单测的纯函数，视图负责渲染与调用。
 */

/** 二次确认词，必须与后端 `SSH_PORT_CONFIRM_WORD` 逐字一致。 */
export const SSH_PORT_CONFIRM_WORD = '确认改端口'

/** 后端 SSH 端口的只读现状（与 openapi `SshPortState` 对齐）。 */
export interface SshPortState {
  effective: number
  explicit: boolean
  source_file: string
  configured: number[]
  sshd_present: boolean
}

/** 改端口结果（与 openapi `SshPortChange` 对齐）。 */
export interface SshPortChange {
  changed: boolean
  effective: number
  target_file: string
  backup: string | null
  validated: boolean
  listening_ports: number[]
  next_steps: string[]
}

/**
 * 端口输入校验。返回错误文案，空串表示合法。
 *
 * 前端拦一道是**必要的**（用户能立刻看到哪里错），但**不是安全边界**——
 * 后端同样校验，绕过 API 也拦得住。两处共用同一套判据口径。
 */
export function validatePortInput(raw: string, current: number | null): string {
  const s = raw.trim()
  if (!s) return '请输入端口号'
  // 只认纯数字：`0x16`、`2_222`、` 22 `、`+22` 在 `Number()` 下都能变成数字，
  // 但 sshd 只接受十进制字面量，放过它们等于让用户以为改成了另一个端口。
  if (!/^\d+$/.test(s)) return '端口必须是纯数字'
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return '端口必须在 1-65535 之间'
  if (current !== null && n === current) return '与当前端口相同，无需修改'
  return ''
}

/** 端口是否与现状相同（用于禁用提交按钮，与校验文案分开以便各自断言）。 */
export function isSamePort(raw: string, current: number | null): boolean {
  return current !== null && raw.trim() === String(current)
}

/**
 * 现状摘要文案。
 *
 * 刻意把 `effective` 与 `configured` **分开说**：sshd 会同时监听配置里的
 * 每一个 Port，只报一个数字会让用户以为「改成 2222 了，22 已经关了」。
 */
export function portSummary(s: SshPortState | null): string {
  if (!s) return '未读取到 SSH 配置'
  if (!s.sshd_present) return '未检测到 SSH 服务：本机可能没装 sshd，改端口无意义'
  const base = s.explicit
    ? `当前生效端口 ${s.effective}（来自 ${s.source_file}）`
    : `当前生效端口 ${s.effective}（未显式配置，走 OpenSSH 编译默认）`
  const extra = s.configured.filter(p => p !== s.effective)
  if (extra.length === 0) return base
  // 如实告知还有别的端口在听——这是「改完以为旧端口关了」的根源
  return `${base}；配置里另有端口 ${extra.join('、')} 也在监听`
}

/** 改动前的风险提示：必须让用户知道改错端口的后果。 */
export function riskNotice(): string {
  return '改 SSH 端口会让当前连接断开，且新端口必须先放行防火墙才能连上。'
    + '建议保留旧端口作为回退通道，确认新端口可登录后再收敛。'
}

/**
 * 提交按钮是否可用。
 * 三个条件缺一不可：端口合法、与现状不同、已输入正确确认词。
 */
export function canSubmit(raw: string, current: number | null, confirmWord: string): boolean {
  return validatePortInput(raw, current) === '' && confirmWord.trim() === SSH_PORT_CONFIRM_WORD
}

/**
 * 结果提示文案（toast 用）。
 *
 * `next_steps` 非空时**必须**把它们带出来——只回一句「已修改」然后让用户
 * 自己想起来要放行防火墙，就是把人往锁在门外的路上推。
 */
export function changeMessage(r: SshPortChange): string {
  if (!r.changed) return `已是端口 ${r.effective}，未做改动`
  const head = `已改为 ${r.effective} 端口`
  const backup = r.backup ? `，原配置备份 ${r.backup}` : ''
  if (r.next_steps.length === 0) return head + backup
  return `${head}${backup}。还需：${r.next_steps.join('；')}`
}
