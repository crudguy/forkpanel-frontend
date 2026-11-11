/**
 * 服务详情页操作按钮（启动 / 停止 / 重启）的禁用判定，抽成纯函数「单一事实源」。
 *
 * 为什么抽出来：之前「停止按钮在已停止时不禁用」这类联动缺陷，根因就是这层
 * 状态↔按钮的映射散在模板里各写各的（`state === 'active'` / `stopDisabled(s)`），
 * 加状态或改规则时极易漏改一处。抽到一处后，组件渲染、负向单测都从它取数，
 * 且能直接单测锁死「状态 ↔ 按钮可用性」的矩阵（见 serviceActionState.test.ts）。
 *
 * 判定依据 =「用户可见状态」（与 serviceStateLabel 同口径的 systemd 状态字符串）：
 *  - active                  运行中     → 启动已无意义（已处于目标态），禁用；停止/重启可用
 *  - inactive                已停止     → 停止无可停，禁用；启动/重启可用
 *  - failed                  失败       → 视为未运行（没有可停的进程），启动/重启可用、停止禁用
 *  - activating/deactivating 过渡态     → 状态正在变化，起停都不适用，统一禁用，避免对正在
 *                                        切换的服务重复起停
 *  - 叠加规则：无管理权限 / 正在执行(busy) 一律禁用；sshd/ssh 永不许停止（防失联，双保险）。
 */
export interface ServiceActionFlags {
  name: string
  state: string
  managed: boolean
  canManage: boolean
  /** 是否有某个启停操作正在进行中（与 action 一一对应，整组按钮统一锁住） */
  busy: boolean
}

export interface ServiceActionDisabled {
  start: boolean
  stop: boolean
  restart: boolean
  /** 停止被禁用是否因为 sshd 规则（与禁用判定同源，供 tooltip 使用） */
  ssh: boolean
}

export function serviceActionDisabled(f: ServiceActionFlags): ServiceActionDisabled {
  const running = f.state === 'active'
  const stopped = f.state === 'inactive' || f.state === 'failed'
  const transitioning = f.state === 'activating' || f.state === 'deactivating'
  // sshd/ssh 永不许停止：防失联。后端也会拒绝，此处是前端双保险。
  const ssh = f.name === 'sshd' || f.name === 'ssh'

  // 启动：仅当服务「已停止/失败」时可用；运行中或过渡态都属「已处于目标态」或
  // 「正在切换」，无需也不能再启动。
  const start = !f.canManage || f.busy || running || transitioning
  // 停止：仅当服务「运行中」且非 sshd 时可用；已停止/失败没有可停的进程，
  // 过渡态也不可停，避免对正在停止的服务重复下发 stop。
  const stop = !f.canManage || f.busy || !running || transitioning || ssh
  // 重启：运行中与已停止都允许（systemctl restart 对 dead 服务等价于启动）；
  // 仅过渡态禁用，避免对正在切换的服务叠加重启。
  const restart = !f.canManage || f.busy || transitioning

  return { start, stop, restart, ssh }
}
