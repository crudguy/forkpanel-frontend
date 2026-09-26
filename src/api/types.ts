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
  SERVICE_MANAGE: 'service.manage',
  PACKAGE_INSTALL: 'package.install',
  FIREWALL_MANAGE: 'firewall.manage',
  WEBSERVER_MANAGE: 'webserver.manage',
  SCHEDULER_MANAGE: 'scheduler.manage',
  LOGS_READ: 'logs.read',
  DBMS_MANAGE: 'dbms.manage',
  SSL_ACME: 'ssl.acme',
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
