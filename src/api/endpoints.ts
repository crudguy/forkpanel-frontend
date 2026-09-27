/**
 * 接口契约表面（Interface Contract Surface）。
 *
 * ⚠️ 这是前端调用后端的**唯一路径来源**：组件禁止硬编码 /api/v1/* 字面量，
 * 一律从这里取。与后端 `docs/api/openapi.yaml` 一一对应；CI `ci/check-contract.sh`
 * 会校验本文件里的静态字面量都已在契约中声明。
 *
 * 设计约定：
 * - 无路径参数的端点用单引号字面量（CI 可静态校验）。
 * - 含路径参数的端点用模板字符串返回，参数一律 encodeURIComponent。
 * - 无关的查询参数（since/page/sort…）由调用方通过 `api.get(url, { params })` 传递，
 *   不写进本文件，避免把查询语义藏到路径里。
 */

const enc = encodeURIComponent

export const API = {
  version: () => '/api/v1/version',

  auth: {
    status: () => '/api/v1/auth/status',
    bootstrap: () => '/api/v1/auth/bootstrap',
    login: () => '/api/v1/auth/login',
    logout: () => '/api/v1/auth/logout',
    me: () => '/api/v1/auth/me',
    password: () => '/api/v1/auth/password',
  },

  system: {
    capabilities: () => '/api/v1/system/capabilities',
    overview: () => '/api/v1/system/overview',
  },

  metrics: {
    realtime: () => '/api/v1/metrics/realtime',
    history: () => '/api/v1/metrics/history',
  },

  processes: {
    list: () => '/api/v1/processes',
    kill: (pid: string) => `/api/v1/processes/${enc(pid)}/kill`,
  },

  services: {
    list: () => '/api/v1/services',
    status: (unit: string) => `/api/v1/services/${enc(unit)}/status`,
    start: (unit: string) => `/api/v1/services/${enc(unit)}/start`,
    stop: (unit: string) => `/api/v1/services/${enc(unit)}/stop`,
    restart: (unit: string) => `/api/v1/services/${enc(unit)}/restart`,
    setEnabled: (unit: string) => `/api/v1/services/${enc(unit)}/enabled`,
    journal: (unit: string) => `/api/v1/services/${enc(unit)}/journal`,
  },

  packages: {
    list: () => '/api/v1/packages',
    install: () => '/api/v1/packages/install',
    remove: (name: string) => `/api/v1/packages/${enc(name)}`,
  },

  sites: {
    list: () => '/api/v1/sites',
    create: () => '/api/v1/sites',
    apply: () => '/api/v1/sites/apply',
    get: (id: number) => `/api/v1/sites/${id}`,
    patch: (id: number) => `/api/v1/sites/${id}`,
    remove: (id: number) => `/api/v1/sites/${id}`,
    reload: (id: number) => `/api/v1/sites/${id}/reload`,
    logs: (id: number) => `/api/v1/sites/${id}/logs`,
    sslApply: (id: number) => `/api/v1/sites/${id}/ssl/apply`,
  },

  certs: {
    list: () => '/api/v1/certs',
    renew: (id: number) => `/api/v1/certs/${id}/renew`,
    remove: (id: number) => `/api/v1/certs/${id}`,
  },

  files: {
    list: () => '/api/v1/files/list',
    stat: () => '/api/v1/files/stat',
    upload: () => '/api/v1/files/upload',
    download: () => '/api/v1/files/download',
    read: () => '/api/v1/files/read',
    write: () => '/api/v1/files/write',
    mkdir: () => '/api/v1/files/mkdir',
    remove: () => '/api/v1/files/delete',
    rename: () => '/api/v1/files/rename',
    chmod: () => '/api/v1/files/chmod',
    action: () => '/api/v1/files/action',
  },

  db: {
    connections: () => '/api/v1/db/connections',
    databases: (conn: number) => `/api/v1/db/${conn}/databases`,
    tables: (conn: number, db: string) => `/api/v1/db/${conn}/${enc(db)}/tables`,
    rows: (conn: number, db: string, table: string) =>
      `/api/v1/db/${conn}/${enc(db)}/${enc(table)}/rows`,
    backup: (conn: number) => `/api/v1/db/${conn}/backup`,
    restore: (conn: number) => `/api/v1/db/${conn}/restore`,
  },

  firewall: {
    status: () => '/api/v1/firewall/status',
    setEnabled: () => '/api/v1/firewall/enabled',
    rules: () => '/api/v1/firewall/rules',
    removeRule: (id: string) => `/api/v1/firewall/rules/${enc(id)}`,
  },

  security: {
    baseline: () => '/api/v1/security/baseline',
    baselineApply: () => '/api/v1/security/baseline/apply',
    sessions: () => '/api/v1/security/sessions',
    revokeSession: (id: string) => `/api/v1/security/sessions/${enc(id)}`,
  },

  cron: {
    jobs: () => '/api/v1/cron/jobs',
    job: (id: string) => `/api/v1/cron/jobs/${enc(id)}`,
    run: (id: string) => `/api/v1/cron/jobs/${enc(id)}/run`,
    runs: (id: string) => `/api/v1/cron/jobs/${enc(id)}/runs`,
    preview: () => '/api/v1/cron/preview',
  },

  logs: {
    sources: () => '/api/v1/logs/sources',
    stream: () => '/api/v1/logs/stream',
    download: () => '/api/v1/logs/download',
    read: (id: string) => `/api/v1/logs/${enc(id)}`,
  },

  tasks: {
    list: () => '/api/v1/tasks',
    get: (id: number) => `/api/v1/tasks/${id}`,
    cancel: (id: number) => `/api/v1/tasks/${id}/cancel`,
    output: (id: number) => `/api/v1/tasks/${id}/output`,
  },

  settings: {
    get: () => '/api/v1/settings',
    patch: () => '/api/v1/settings',
  },

  users: {
    list: () => '/api/v1/users',
    create: () => '/api/v1/users',
    patch: (id: number) => `/api/v1/users/${id}`,
    remove: (id: number) => `/api/v1/users/${id}`,
  },

  audit: () => '/api/v1/audit',

  events: {
    metrics: () => '/api/v1/events/metrics',
    tasks: () => '/api/v1/events/tasks',
    logs: () => '/api/v1/events/logs',
  },
}
