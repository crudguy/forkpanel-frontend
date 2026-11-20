/**
 * 防火墙规则表单的纯逻辑（端口解析 + SSH 失联判定 + 确认文案）。
 *
 * 为什么单独一个文件：`vitest.config.ts` 只收 `src/**\/*.test.ts`，逻辑写在
 * `.vue` 里没法测（本仓已因此漏过一版静默失败）。这里只放可单测的纯函数。
 */

export type FirewallAction = 'allow' | 'deny' | 'reject'

export interface PortParse {
  ok: boolean
  msg?: string
  singles: number[]
  ranges: Array<[number, number]>
  all: boolean
}

const fail = (msg: string): PortParse => ({ ok: false, msg, singles: [], ranges: [], all: false })

/** 解析 "80,443,8000-8100,all"，口径与后端 `parse_ports` 一致。 */
export function parsePorts(raw: string, action: FirewallAction): PortParse {
  const verb = action === 'allow' ? '放行' : '封禁'
  const toks = raw.split(',').map(t => t.trim()).filter(Boolean)
  if (!toks.length) return fail(`请填写要${verb}的端口`)
  const singles: number[] = []
  const ranges: Array<[number, number]> = []
  let all = false
  for (const t of toks) {
    if (t === 'all' || t === '*') { all = true; continue }
    if (/^\d+$/.test(t)) {
      const n = Number(t)
      if (n < 1 || n > 65535) return fail(`端口 ${t} 超出范围（1-65535）`)
      singles.push(n)
      continue
    }
    const m = /^(\d+)-(\d+)$/.exec(t)
    if (!m) return fail(`无法识别的端口「${t}」（支持单端口或范围，如 80 或 8000-8100）`)
    const a = Number(m[1]), b = Number(m[2])
    if (a < 1 || b > 65535 || a > b) return fail(`端口范围 ${t} 无效`)
    ranges.push([a, b])
  }
  return { ok: true, singles, ranges, all }
}

/**
 * 是否命中受保护的 SSH 端口。受保护端口集由后端 GET /rules 现读下发，
 * 前端不猜端口——否则 SSH 改到 2222 后会继续盯 22，保护错位。
 *
 * `all` 无条件命中：封全部端口必然封掉 SSH，即便端口集暂时读不到也要
 * 走二次确认（后端 `PortSpec::All` 同样无条件拦）。
 */
export function hitsProtectedPort(p: PortParse, protectedPorts: number[]): boolean {
  if (!p.ok) return false
  if (p.all) return true
  return p.singles.some(n => protectedPorts.includes(n))
    || p.ranges.some(([a, b]) => protectedPorts.some(n => n >= a && n <= b))
}

export interface ApplyConfirm {
  title: string
  detail: string
  danger: boolean
}

/** 确认弹窗文案。命中 SSH 时必须把失联后果说透，不能只写「确定吗」。 */
export function applyConfirm(
  action: FirewallAction, ports: string, source: string, hitsSsh: boolean,
): ApplyConfirm {
  const verb = action === 'allow' ? '放行' : '封禁'
  const list = ports.split(',').map(t => t.trim()).filter(Boolean).join('、')
  const src = source.trim() ? `（来源：${source.trim()}）` : '（来源：任意）'
  // 放行端口即使命中 SSH 也不是高危：只有 deny/reject 才会失联。
  // 调用方可能粗心地把「端口命中」直接传进来，这里必须自己按动作收敛。
  if (action === 'allow' || !hitsSsh) {
    return { title: `确认${verb}端口`, detail: `将${verb}端口：${list}${src}`, danger: false }
  }
  return {
    title: '确认封禁 SSH 端口（高危）',
    detail: `将封禁端口：${list}${src}。其中含当前 SSH 端口，封禁后将直接失联且无法从面板恢复。请确认已通过其它通道登录，或已保留回退方案。`,
    danger: true,
  }
}

/** 提交时是否带 `allow_lockout_risk`（后端二次确认开关，仅命中时给）。 */
export function needsLockoutAck(action: FirewallAction, hitsSsh: boolean): boolean {
  return action !== 'allow' && hitsSsh
}

/** toast 文案：区分放行 / 封禁，不能封禁成功也报「已放行」。 */
export function applyToast(action: FirewallAction, ports: string, added: number): string {
  const verb = action === 'allow' ? '放行' : '封禁'
  return added > 0 ? `已${verb}端口 ${ports}` : `端口 ${ports} 已在${verb}列表中`
}
