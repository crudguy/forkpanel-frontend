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
    title: '确认封禁 SSH 端口（须迁移）',
    detail: `将封禁端口：${list}${src}。其中含当前 SSH 端口，直接封禁会导致失联。面板会先把 SSH 迁移到你在表单中填写的新端口并放行，再封禁旧端口；任一步失败自动回滚。迁移完成后请用新端口重新连接。`,
    danger: true,
  }
}

/**
 * 封禁 SSH 端口时是否必须迁移到新端口。
 * 只有 deny/reject 命中受保护端口才需要；放行不需要。
 */
export function needsMigration(action: FirewallAction, hitsSsh: boolean): boolean {
  return action !== 'allow' && hitsSsh
}

/**
 * 校验用户填写的"新 SSH 端口"（与后端 new_port_is_safe 同口径）。
 * 三条判据：合法范围 / 不等于当前 SSH 端口 / 不在本次封禁范围内。
 * 返回 null 表示可用，否则是可直接展示给用户的错误原因。
 */
export function newPortError(
  raw: string, parsed: PortParse, protectedPorts: number[],
): string | null {
  if (!/^\d+$/.test(raw.trim())) return '请填写新 SSH 端口（1-65535 的数字）'
  const n = Number(raw.trim())
  if (n < 1 || n > 65535) return '新 SSH 端口超出范围（1-65535）'
  if (protectedPorts.includes(n)) return `新 SSH 端口 ${n} 与当前 SSH 端口相同，等于没有迁移`
  if (parsed.ok) {
    if (parsed.all) return '不能封禁全部端口：没有任何端口可用于 SSH 迁移，请先缩小封禁范围'
    if (parsed.singles.includes(n)) return `新 SSH 端口 ${n} 也在本次封禁的端口中，迁过去仍会被封`
    if (parsed.ranges.some(([a, b]) => n >= a && n <= b)) {
      return `新 SSH 端口 ${n} 在本次封禁的端口范围内，迁过去仍会被封`
    }
  }
  return null
}

/** toast 文案：区分放行 / 封禁，不能封禁成功也报「已放行」。 */
export function applyToast(action: FirewallAction, ports: string, added: number): string {
  const verb = action === 'allow' ? '放行' : '封禁'
  return added > 0 ? `已${verb}端口 ${ports}` : `端口 ${ports} 已在${verb}列表中`
}

/** 本机监听端口的入站状态。只读观察值，不对应任何可删除的规则。 */
export type PortExposure =
  | 'explicit-allow' | 'explicit-deny' | 'by-source'
  | 'default-allow' | 'default-deny' | 'unknown'

export interface ExposureRule { ports: string; action: string; source?: string | null }

/**
 * 计算某端口当前的入站状态：先看面板显式规则，再看链默认策略。
 *
 * 判据优先级：显式封禁 > 带来源规则（只对特定来源成立，不能说成全局）> 显式放行
 * > 默认策略。读不到默认策略时返回 unknown——绝不把"未知"渲染成"放行"。
 */
export function portExposure(
  port: number, rules: ExposureRule[], defaultPolicy: string | null,
): PortExposure {
  let deny = false, allow = false, bySource = false
  for (const r of rules) {
    const act: FirewallAction | null =
      r.action === 'allow' ? 'allow'
      : r.action === 'deny' || r.action === 'reject' ? 'deny'
      : null
    if (!act) continue
    const p = parsePorts(r.ports, act)
    if (!p.ok) continue
    const hit = p.all || p.singles.includes(port) || p.ranges.some(([a, b]) => port >= a && port <= b)
    if (!hit) continue
    if (r.source?.trim()) { bySource = true; continue }
    if (act === 'deny') deny = true; else allow = true
  }
  if (deny) return 'explicit-deny'
  if (bySource) return 'by-source'
  if (allow) return 'explicit-allow'
  if (defaultPolicy === 'accept') return 'default-allow'
  if (defaultPolicy === 'drop' || defaultPolicy === 'reject') return 'default-deny'
  return 'unknown'
}

/** 状态文案与色调：默认放行是风险项，用品牌橙（primary）而不是 ok，避免虚假安全感。 */
export function portExposureLabel(e: PortExposure): { text: string; tone: string } {
  switch (e) {
    case 'explicit-allow': return { text: '显式放行', tone: 'ok' }
    case 'explicit-deny': return { text: '显式封禁', tone: 'danger' }
    case 'by-source': return { text: '按来源区分', tone: 'info' }
    case 'default-allow': return { text: '默认放行', tone: 'primary' }
    case 'default-deny': return { text: '默认拒绝', tone: 'ok' }
    case 'unknown': return { text: '状态未知', tone: 'dim' }
  }
}
