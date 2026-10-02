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
    default: return c.reason
  }
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
  version: string | null
  manager: string
}
export interface ServiceJournal {
  name: string
  lines: string[]
}
/** 服务单元文件（GET /api/v1/services/{unit}/config） */
export interface ServiceConfig {
  path: string
  content: string
  /** false=位于发行版目录，修改可能在包升级时被覆盖，建议改用 drop-in */
  writable: boolean
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
