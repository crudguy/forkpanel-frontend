/**
 * 能力矩阵类型与判定。
 *
 * ⚠️ 核心纪律：前端**禁止**写 `if (isLinux)` / `navigator.platform` / `target_os`。
 * 一切平台差异都由后端 capabilities 驱动。这样 Windows/macOS 接入时前端零改动。
 */

export interface Capability {
  supported: boolean
  backend: string | null
  reason: string | null
}

export type CapabilityMap = Record<string, Capability>

export interface PlatformInfo {
  os: string
  arch: string
  init: string
  distro: string | null
  kernel: string | null
}

export const CAP = {
  METRICS_READ: 'metrics.read',
  PROCESS_LIST: 'process.list',
  PROCESS_SIGNAL: 'process.signal',
  FILE_READ: 'file.read',
  FILE_WRITE: 'file.write',
  SERVICE_MANAGE: 'service.manage',
  PACKAGE_INSTALL: 'package.install',
  PACKAGE_UPGRADE: 'package.upgrade',
  FIREWALL_MANAGE: 'firewall.manage',
  WEBSERVER_MANAGE: 'webserver.manage',
  SCHEDULER_MANAGE: 'scheduler.manage',
  LOGS_READ: 'logs.read',
  DBMS_MANAGE: 'dbms.manage',
  SSL_ACME: 'ssl.acme',
  // 面板自签证书：本机有 openssl 即可（离线可用）
  SSL_SELFSIGNED: 'ssl.selfsigned',
  // 备份计划：面板内建（SQLite 在线备份 + tar），恒支持
  BACKUP_MANAGE: 'backup.manage',
  // 容器：取决于宿主 Docker 守护进程**可达性**（二进制存在 ≠ 可用）
  CONTAINER_MANAGE: 'container.manage',
  CONTAINER_VIEW: 'container.view',
  /// 内置 Web 终端：本机存在可用交互 shell（bash/sh）。高危面——能力位只管"能不能开"，
  /// 真正准入还叠加 system.manage 权限 + 只读拒绝（见后端 routes/terminal.rs）。
  TERMINAL_MANAGE: 'terminal.manage',
  /// 用户与角色管理：面板内建功能（非 OS 能力），恒支持
  USER_MANAGE: 'user.manage',
} as const

/** 不支持时的可读原因（用于菜单置灰的 tooltip） */
export function unsupportedReason(caps: CapabilityMap, key: string): string | null {
  const c = caps[key]
  if (!c || c.supported) return null
  switch (c.reason) {
    case 'not_implemented': return '当前版本尚未实现'
    case 'binary_missing': return '未检测到所需组件'
    case 'no_package_manager': return '未检测到受支持的包管理器'
    case 'init_unknown': return '未识别的服务管理器'
    case 'unsupported_os': return '当前操作系统不支持'
    // 以下 reason 由 panel-os 的 capabilities() 实际产出，缺映射会让 tooltip
    // 直接显示英文原文（2026-10-03 核对时发现）
    case 'certbot_missing': return '未安装 certbot，无法申请 ACME 证书'
    case 'openssl_missing': return '未安装 openssl，无法签发自签证书'
    case 'caddy_render_not_implemented': return '已检测到 caddy，但配置渲染尚未实装'
    case 'no_engine': return '未检测到可用的数据库引擎'
    case 'no_log_source': return '未检测到可用的日志源'
    case 'daemon_unreachable': return '守护进程不可达（面板用户需加入 docker 组）'
    default: return c.reason
  }
}

// ── 站点（对应后端 `SiteOut`，routes/sites.rs）──
//
// 此前 SitesView 与 WafView 各声明一份（后者是前者的删减副本，缺 tls/created_at），
// 两处独立维护必然漂移 —— 统一到此处。

/** 站点类型。**注意** 库内值是 `static|reverse_proxy|php`，API 呈现为 `static|proxy|php`
 *  （换算在后端 kind_to_api/kind_to_db）。 */
export const siteKindLabel = enumLabel({ static: '静态站点', proxy: '反向代理', php: 'PHP 站点' })

export interface Site {
  id: number
  name: string
  domains: string[]
  root: string
  /** API 口径：static | proxy | php */
  kind: string
  /** 期望状态：是否已纳入 Web 服务器配置（新建默认 true）。**不**代表正在服务 */
  enabled: boolean
  /** 配置是否已真实下发到 Web 服务器（apply 写入 conf_path 后为 true） */
  deployed: boolean
  tls: boolean
  created_at?: number
  waf_enabled: boolean
  waf_profile: string | null
  /** CC 限速（次/秒）；null = 不限速 */
  waf_rate_per_sec: number | null
  waf_burst: number | null
  /** 反代后端列表（kind=proxy 时存在）；static/php 为 null */
  upstreams: string[] | null
  /** php-fpm 目标（kind=php 时存在）；其余为 null */
  fpm: string | null
}

// ── 专业监控页：完整系统快照（对应后端 panel_os::SystemSnapshot）──
export interface CpuSample {
  total_pct: number
  per_core_pct: number[] | null
  load1: number
  load5: number
  load15: number
}
export interface MemSample {
  total_kib: number
  used_kib: number
  available_kib: number
  buffers_kib: number
  cached_kib: number
  swap_total_kib: number
  swap_used_kib: number
}
export interface DiskSample {
  mount_point: string
  device: string
  fs_type: string
  total_bytes: number
  used_bytes: number
  is_network_fs: boolean
}
export interface NetSample {
  iface: string
  rx_bytes: number
  tx_bytes: number
  rx_rate_bps: number
  tx_rate_bps: number
}
// 温度传感器（对应后端 panel_os::TempSample；无 hwmon 的机器为空数组）
export interface TempSample {
  chip: string
  label: string
  celsius: number
  critical: boolean
}
export interface SystemSnapshot {
  ts_unix: number
  uptime_sec: number
  cpu: CpuSample
  mem: MemSample
  disks: DiskSample[]
  nets: NetSample[]
  proc_count: number
  tcp_conns: number
  temps: TempSample[]
}
// Top 进程（对应后端 panel_os::ProcessInfo）
export interface ProcessInfo {
  pid: number
  ppid: number
  name: string
  cpu_pct: number
  rss_kib: number
  cmdline: string
  user: string | null
}

// ── 软件与服务（对应后端 /api/v1/packages、/api/v1/services/{unit}/journal）──
export interface PackageInfo {
  name: string
  label?: string
  version: string | null
  manager: string
}
/** 可升级条目（GET /api/v1/packages/upgradable 的 items[]）。
    name 是**逻辑包名**（与 PackageInfo.name 同域），UI 按它匹配已安装卡片；
    已在后端过滤到白名单，故不会返回面板管不到的系统库。 */
export interface UpgradablePkg {
  name: string
  label?: string
  /** 当前已安装版本 */
  current: string
  /** 可升级到的版本 */
  candidate: string
  /** 是否跨主版本升级（current 与 candidate 首段数字不同）。跨主版本可能不向后兼容，
   *  需要数据迁移或服务重配，前端据此弹窗二次确认。 */
  major?: boolean
}
/** 服务条目（GET /api/v1/services 的 services[]）。
    列表页与服务详情页共用——两处各自定义必然漂移，故提到 types.ts 单一事实源。 */
export interface ServiceInfo {
  name: string
  state: string
  enabled: boolean
  description: string | null
  /** 是否受面板托管（未托管服务的停止需二次确认） */
  managed: boolean
}
export interface ServiceJournal {
  name: string
  lines: string[]
}
/** 服务配置（GET/PUT /api/v1/services/{unit}/config） */
export interface ServiceConfig {
  path: string
  content: string
  /** false=位于发行版目录，修改可能在包升级时被覆盖，建议改用 drop-in */
  writable: boolean
  /** 文件是否已存在；target=dropin 时 false 表示"保存即新建" */
  exists: boolean
  /** 本次读写目标：unit=单元文件本体 / dropin=override.conf */
  target: 'unit' | 'dropin'
}
/** 任务中心条目（GET /api/v1/tasks，用于安装/卸载进度轮询） */
export interface TaskRun {
  id: number
  key: string
  kind: string
  state: string
  progress: number
  started_at: number | null
  finished_at: number | null
  exit_code: number | null
  needs_human?: boolean
}

/** AI 助手：诊断域（关键词路由结果） */
export type AssistantScope = 'all' | 'cpu' | 'mem' | 'disk' | 'log' | 'service' | 'security' | 'backup'

/** AI 助手：诊断发现（evidence 为真实数据引用；action 仅 navigate，处置人工确认） */
export interface AssistantFinding {
  id: string
  severity: 'info' | 'warn' | 'crit'
  title: string
  evidence: string[]
  suggestion: string
  action: { kind: 'navigate'; view: string } | null
}

/** AI 助手：体检基线 */
export interface AssistantContext {
  cpu_pct: number
  load1: number
  load5: number
  load15: number
  mem_used_kib: number
  mem_total_kib: number
  proc_count: number
  uptime_sec: number
  top_disk: { mount: string; used_pct: number } | null
}

/** AI 助手：诊断报告（POST /api/v1/assistant/diagnose） */
export interface AssistantReport {
  question: string
  scope: AssistantScope
  generated_at: number
  summary: string
  findings: AssistantFinding[]
  ctx: AssistantContext
}

/** 设置：三段诚实模型（runtime 可改即生效 / deployment 只读 / reserved 预留未接线） */
export interface SettingsReport {
  runtime: {
    endpoint: string | null
    model: string | null
    api_key_set: boolean
  }
  deployment: {
    read_only: boolean
    tier: 'nano' | 'small' | 'standard'
    hint: string
  }
  reserved: {
    wired: false
    note: string
    values: Record<string, string>
  }
}

// ── 备份远端副本（对应 openapi `RemoteConfig`）──
//
// 这张表在**两处**使用（新建计划、给已有计划改远端），所以定义放在共享模块里：
// 复制一份必然漂移，而漂移的那份会让人按错误的字段名提交，然后收到一个看不懂的 400。
//
// ⚠️ 与后端严格对齐的语义：**凭据永不回显**（列表只回 `remote_has_secret`），
// 因此 `secret` 永远是空初值，空值 = "不改动"。想清空凭据请改为匿名访问
// （清空用户名），而不是把密码框留空——留空不会清掉任何东西。
export interface RemoteConfig {
  /** '' = 只用本地；'webdav' | 's3' = 启用远端副本 */
  kind: '' | 'webdav' | 's3'
  url: string
  bucket: string
  prefix: string
  region: string
  user: string
  secret: string
}

/** 空配置：新建计划的初始值，也用于"关闭远端"。 */
export function emptyRemote(): RemoteConfig {
  return { kind: '', url: '', bucket: '', prefix: '', region: '', user: '', secret: '' }
}

// ── 任务状态词表（唯一事实源：后端 crates/panel-task/src/lib.rs `TaskState`）──
//
// 历史教训：TasksView 判终态 'ok'、ServicesView 判 'done'——而后者根本不是
// 后端会发的值，导致安装任务实际完成后轮询永不停止，且同一任务两处颜色不同。
// 所以下面的映射**同时兼容**历史脏数据（done/cancelled），但判定后端口径为准。
//
// 后端枚举：queued / running / ok / failed / canceled / interrupted（美式拼写）。

/** 终态集合：轮询停止判定。含 done/cancelled 是为兼容历史库里的旧值。 */
export const TASK_FINISHED = new Set<string>([
  'ok', 'failed', 'canceled', 'interrupted', 'done', 'cancelled',
])

/** 状态中文映射；未知值原样返回（后端加新状态时前端不至显示空白）。 */
export function taskStateLabel(s: string): string {
  const m: Record<string, string> = {
    queued: '排队中',
    running: '进行中',
    ok: '完成',
    done: '完成',
    failed: '失败',
    canceled: '已取消',
    cancelled: '已取消',
    interrupted: '已中断',
  }
  return m[s] ?? s
}

/** 状态徽标 class（与 main.css 的 badge-* 对应）。 */
export function taskStateBadge(s: string): string {
  if (s === 'running') return 'badge-primary'
  if (s === 'ok' || s === 'done') return 'badge-ok'
  if (s === 'failed' || s === 'canceled' || s === 'cancelled' || s === 'interrupted') return 'badge-danger'
  return 'badge-warn'
}

// ────────────── 通用枚举词表 ──────────────
// 后端一律存/返英文枚举，直接渲染会让面板中英混杂。集中在此映射，
// 各视图引用（勿在视图内各写一份——必漂移）。
//
// 约定：未知值原样返回（后端加新枚举时前端不至显示空白），与
// taskStateLabel 保持一致。

/** 生成"英文→中文"映射函数。未知 key 原样返回。 */
function enumLabel(m: Record<string, string>) {
  return (v: string | null | undefined): string => (v == null || v === '' ? '—' : (m[v] ?? v))
}

/** 服务状态（后端 systemd 口径）。 */
export const serviceStateLabel = enumLabel({
  active: '运行中', inactive: '已停止', failed: '失败',
  activating: '启动中', deactivating: '停止中', unknown: '未知',
})

/** 服务状态 → 徽标配色。语义与 serviceStateLabel、taskStateBadge 一致：
 *  - active      运行中  绿
 *  - failed      失败    红
 *  - activating/deactivating 过渡态 琥珀
 *  - 其余（inactive/unknown 等）中性、不挂底色
 *  抽成共享函数，避免各列表页各写一份 stateBadge 导致加新状态时漂移。 */
export function serviceStateBadge(s: string): string {
  if (s === 'active') return 'badge-ok'
  if (s === 'failed') return 'badge-danger'
  if (s === 'activating' || s === 'deactivating') return 'badge-warn'
  return ''
}

/** 容器状态（docker/podman CLI 口径）。 */
export const containerStateLabel = enumLabel({
  running: '运行中', exited: '已退出', created: '已创建',
  paused: '已暂停', restarting: '重启中', dead: '已死',
})

/** 容器状态 → 徽标配色。语义与 containerStateLabel、serviceStateBadge 一致：
 *  - running                 运行中          绿
 *  - restarting/paused/created 过渡/暂停态    琥珀
 *  - 其余（exited/dead 等）   不在运行        红
 *  抽成共享函数，避免各列表页各写一份 stateClass 导致加新状态时漂移。 */
export function containerStateBadge(s: string): string {
  if (s === 'running') return 'badge-ok'
  if (s === 'restarting' || s === 'paused' || s === 'created') return 'badge-warn'
  return 'badge-danger'
}

/** 防火墙规则的协议 / 动作 / 方向。 */
export const fwProtocolLabel = enumLabel({ tcp: 'TCP', udp: 'UDP', icmp: 'ICMP', any: '任意' })
export const fwActionLabel = enumLabel({ allow: '允许', deny: '拒绝', reject: '拒绝并回复' })
export const fwDirectionLabel = enumLabel({ in: '入站', out: '出站' })

/** 防火墙后端（能力位 backend 字段）。 */
export const fwBackendLabel = enumLabel({
  nftables: 'nftables', iptables: 'iptables', ufw: 'ufw',
  firewalld: 'firewalld', pf: 'pf', windows: 'Windows', None: '无',
})

/** 证书来源。注：ssl_apply 的**入参**用连字符形式（self-signed），与此处输出不同。 */
export const certSourceLabel = enumLabel({
  acme: 'ACME 签发', 'self-signed': '自签', manual: '手动上传',
})

/** 证书自动续期扫描状态。 */
export const certRenewStateLabel = enumLabel({
  idle: '空闲', pending: '续期中', ok: '成功', failed: '失败',
})

/** 备份计划类型。 */
export const backupKindLabel = enumLabel({ panel: '面板数据', site: '站点文件' })

/** 备份最近一次结果。partial = 本地成功但远端失败。 */
export const backupResultLabel = enumLabel({
  ok: '成功', partial: '部分成功（远端失败）', fail: '失败',
})

/** 备份远端存储类型；空串 = 仅本地。 */
export const remoteKindLabel = enumLabel({ webdav: 'WebDAV', s3: 'S3' })

/** 计划任务类型。 */
export const cronKindLabel = enumLabel({
  script: '脚本', backup: '备份', cert_renew: '证书续期', internal: '内部任务',
})

/** 文件条目类型。 */
export const fileKindLabel = enumLabel({
  dir: '目录', file: '文件', symlink: '符号链接', other: '其他',
})

/** 通知级别（后端对非法值归一为 warn）。 */
export const notifLevelLabel = enumLabel({ info: '信息', warn: '警告', error: '错误' })

/** 审计结果。`queued` = 已入队（异步任务类写操作），`denied` = 被权限/只读拒绝。 */
export const auditResultLabel = enumLabel({
  ok: '成功', changed: '已变更', unchanged: '无变更',
  queued: '已入队', denied: '已拒绝', error: '出错', fail: '失败',
})

/** 内置角色。 */
export const roleLabel = enumLabel({
  owner: '拥有者', admin: '管理员', operator: '操作员', viewer: '只读',
})

// ── 统一时间格式化 ──
// 后端时间戳一律 Unix **秒**（i64，无毫秒）。渲染前必须 *1000。
//
// 此前 9 处各写 `new Date(ts*1000).toLocaleString()`，跟随浏览器 locale：
// 同一面板里证书到期日是「2026/10/03」，扫描时间可能是「10/3/2026」。
// 统一到本函数：固定 zh-CN + 24 小时制 + 中文日期格式。

/** 日期时间，如 `2026-10-03 14:05`。入参 Unix 秒。 */
export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 仅日期，如 `2026-10-03`。入参 Unix 秒。 */
export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 仅时分，如 `14:05`。入参 Unix 秒。 */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 字节数格式化，如 `1.5 GB`。此前 FilesView/BackupsView/TrashPanel 各写一份，
 *  且 BackupsView 那份只到 MB（100GB 显示成 "102400.0 MB"）。 */
export function fmtSize(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

/** 相对时间，如 `3 天前` / `2 小时前`。入参 Unix 秒。 */
export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() / 1000 - ts
  if (diff < 0) return fmtDateTime(ts)   // 未来时间（定时任务）直接给绝对值
  if (diff < 60) return '刚刚'
  const units: [number, string][] = [[86400, '天'], [3600, '小时'], [60, '分钟']]
  for (const [sec, name] of units) {
    if (diff >= sec) return `${Math.floor(diff / sec)} ${name}前`
  }
  return '刚刚'
}
