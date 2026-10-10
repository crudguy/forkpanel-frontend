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
    mfaEnroll: () => '/api/v1/auth/mfa/enroll',
    mfaVerify: () => '/api/v1/auth/mfa/verify',
    mfaDisable: () => '/api/v1/auth/mfa/disable',
  },

  system: {
    capabilities: () => '/api/v1/system/capabilities',
    overview: () => '/api/v1/system/overview',
    users: () => '/api/v1/system/users',
  },

  metrics: {
    realtime: () => '/api/v1/metrics/realtime',
    history: () => '/api/v1/metrics/history',
    snapshot: () => '/api/v1/metrics/snapshot',
  },

  processes: {
    list: () => '/api/v1/processes',
    kill: (pid: string) => `/api/v1/processes/${enc(pid)}/kill`,
  },

  services: {
    list: () => '/api/v1/services',
    // 按单元名直接查单个服务（绕开 list 的全量枚举；dead 服务也能查到）。
    // 详情页用它在列表里反查不到时（如刚装好还没启动的 nginx）兜底加载。
    show: (unit: string) => `/api/v1/services/${enc(unit)}`,
    status: (unit: string) => `/api/v1/services/${enc(unit)}/status`,
    start: (unit: string) => `/api/v1/services/${enc(unit)}/start`,
    stop: (unit: string) => `/api/v1/services/${enc(unit)}/stop`,
    restart: (unit: string) => `/api/v1/services/${enc(unit)}/restart`,
    setEnabled: (unit: string) => `/api/v1/services/${enc(unit)}/enabled`,
    journal: (unit: string) => `/api/v1/services/${enc(unit)}/journal`,
    // 日志跟随（SSE）：先补最近 N 行历史，再 journalctl -f 增量
    journalStream: (unit: string, lines?: number) =>
      `/api/v1/services/${enc(unit)}/journal/stream${lines ? `?lines=${lines}` : ''}`,
    config: (unit: string) => `/api/v1/services/${enc(unit)}/config`,
    configUpdate: (unit: string) => `/api/v1/services/${enc(unit)}/config`,
  },

  packages: {
    list: () => '/api/v1/packages',
    install: () => '/api/v1/packages/install',
    remove: (name: string) => `/api/v1/packages/${enc(name)}`,
    // 按需查询可用版本（安装弹窗打开时），刻意不随 packages_list 全量拉取
    versions: (name: string) => `/api/v1/packages/${enc(name)}/versions`,
    // 探测「有新版」（只读）。单独端点而非并入 list：要对白名单跑一次 apt-cache policy，
    // 而 list 是页面/轮询高频调用，混在一起每次刷新都多付子进程开销。
    // 判据是版本表最高版（跨源）而非 apt 的 Candidate —— 后者会被 pin 压低而漏报更新。
    upgradable: () => '/api/v1/packages/upgradable',
    // 升级到指定版本（不传 version = 升到源里最新版）
    upgrade: () => '/api/v1/packages/upgrade',
  },

  apps: {
    list: () => '/api/v1/apps',
    create: () => '/api/v1/apps',
    // 运行时目录：**前端下拉的唯一数据源**。后端 AppRuntime 是单一事实来源，
    // 前端不再硬编码语言表——两处各写一份必然漂移（新增运行时时前端静默缺项）。
    catalog: () => '/api/v1/apps/catalog',
    get: (id: number) => `/api/v1/apps/${id}`,
    patch: (id: number) => `/api/v1/apps/${id}`,
    remove: (id: number) => `/api/v1/apps/${id}`,
    // 启停/重启合并在一个端点（act=start|stop|restart），故只有一条路径
    act: (id: number) => `/api/v1/apps/${id}/act`,
  },

  sites: {
    list: () => '/api/v1/sites',
    create: () => '/api/v1/sites',
    apply: () => '/api/v1/sites/apply',
    root: () => '/api/v1/sites/root',
    get: (id: number) => `/api/v1/sites/${id}`,
    patch: (id: number) => `/api/v1/sites/${id}`,
    remove: (id: number) => `/api/v1/sites/${id}`,
    reload: (id: number) => `/api/v1/sites/${id}/reload`,
    /** 站点原始配置：GET 读 / PUT 存（写入即转「手动维护」，仅 owner 可写） */
    conf: (id: number) => `/api/v1/sites/${id}/conf`,
    /** 恢复面板托管（丢弃手工修改，按表单重新渲染下发；仅 owner） */
    confRestore: (id: number) => `/api/v1/sites/${id}/conf/restore`,
    /** 配置历史版本列表（最新在前，每站保留 20 版） */
    confVersions: (id: number) => `/api/v1/sites/${id}/conf/versions`,
    /** 单个历史版本正文（回滚前预览） */
    confVersion: (id: number, vid: number) => `/api/v1/sites/${id}/conf/versions/${vid}`,
    /** 回滚到指定历史版本（nginx -t 校验 → 留档 → 落盘 + reload；仅 owner） */
    confRollback: (id: number) => `/api/v1/sites/${id}/conf/rollback`,
    logs: (id: number) => `/api/v1/sites/${id}/logs`,
    sslApply: (id: number) => `/api/v1/sites/${id}/ssl/apply`,
  },

  certs: {
    list: () => '/api/v1/certs',
    // 面板本地根证书（ca.crt，PEM 包装的 X.509，供系统/浏览器信任库导入）。
    // 自签 leaf 全部由它签发：用户导入一次，此后全部本地 HTTPS 不再报「非私密连接」。
    ca: () => '/api/v1/ssl/ca',
    renewSweep: () => '/api/v1/certs/renew-sweep',
    renew: (id: number) => `/api/v1/certs/${id}/renew`,
    autoRenew: (id: number) => `/api/v1/certs/${id}/auto-renew`,
    remove: (id: number) => `/api/v1/certs/${id}`,
  },

  files: {
    list: () => '/api/v1/files/list',
    stat: () => '/api/v1/files/stat',
    upload: () => '/api/v1/files/upload',
    // 分片上传（大文件断点续传）
    multipartInit: () => '/api/v1/files/multipart/init',
    multipartChunk: (uploadId: string, index: number) =>
      `/api/v1/files/multipart/chunk?upload_id=${encodeURIComponent(uploadId)}&index=${index}`,
    multipartItem: (uploadId: string) => `/api/v1/files/multipart/${encodeURIComponent(uploadId)}`,
    multipartComplete: (uploadId: string) =>
      `/api/v1/files/multipart/${encodeURIComponent(uploadId)}/complete`,
    download: () => '/api/v1/files/download',
    read: () => '/api/v1/files/read',
    write: () => '/api/v1/files/write',
    mkdir: () => '/api/v1/files/mkdir',
    remove: () => '/api/v1/files/delete',
    trash: () => '/api/v1/files/trash',
    trashRestore: () => '/api/v1/files/trash/restore',
    trashPurge: () => '/api/v1/files/trash/purge',
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
    query: (conn: number) => `/api/v1/db/${conn}/query`,
  },

  backups: {
    list: () => '/api/v1/backups',
    create: () => '/api/v1/backups',
    patch: (id: number) => `/api/v1/backups/${id}`,
    remove: (id: number) => `/api/v1/backups/${id}`,
    run: (id: number) => `/api/v1/backups/${id}/run`,
    // 远端连接自检：真的 PUT 一个探针对象再删掉（用备份实际要用的操作验证）
    testRemote: () => '/api/v1/backups/test-remote',
    artifacts: (id: number) => `/api/v1/backups/${id}/artifacts`,
    restore: (id: number) => `/api/v1/backups/${id}/restore`,
  },
  containers: {
    list: () => '/api/v1/containers',
    images: () => '/api/v1/containers/images',
    install: () => '/api/v1/containers/install',
    // 把面板运行用户加入 docker 组（修复 daemon_unreachable 的高危操作）
    joinDockerGroup: () => '/api/v1/containers/join-docker-group',
    // 生命周期动作；id 为容器 ID 或名称（后端白名单校验）
    start: (id: string) => `/api/v1/containers/${id}/start`,
    stop: (id: string) => `/api/v1/containers/${id}/stop`,
    restart: (id: string) => `/api/v1/containers/${id}/restart`,
    remove: (id: string) => `/api/v1/containers/${id}`,
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
    stream: (source?: string, filter?: string, limit?: number) => {
      const p = new URLSearchParams()
      if (source) p.set('source', source)
      if (filter) p.set('filter', filter)
      if (limit) p.set('limit', String(limit))
      const q = p.toString()
      return `/api/v1/logs/stream${q ? '?' + q : ''}`
    },
    download: (id: string) => `/api/v1/logs/${enc(id)}/download`,
    stats: (id: string) => `/api/v1/logs/${enc(id)}/stats`,
    read: (id: string) => `/api/v1/logs/${enc(id)}`,
  },

  tasks: {
    list: () => '/api/v1/tasks',
    get: (id: number) => `/api/v1/tasks/${id}`,
    cancel: (id: number) => `/api/v1/tasks/${id}/cancel`,
    output: (id: number) => `/api/v1/tasks/${id}/output`,
  },

  notifications: {
    list: () => '/api/v1/notifications',
    unreadCount: () => '/api/v1/notifications/unread-count',
    readAll: () => '/api/v1/notifications/read-all',
    markRead: (id: number) => `/api/v1/notifications/${id}/read`,
    remove: (id: number) => `/api/v1/notifications/${id}`,
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

  roles: {
    list: () => '/api/v1/roles',
    create: () => '/api/v1/roles',
    item: (name: string) => `/api/v1/roles/${enc(name)}`,
  },

  audit: () => '/api/v1/audit',

  // 内置 Web 终端（WebSocket 升级，非 REST）。WS 地址由前端按当前 location 构造，
  // 不走本文件的字面量（避免把 ws(s)://host 写死）；这里的声明仅为契约门禁兜底。
  terminal: () => '/api/v1/terminal',
  assistant: {
    diagnose: () => '/api/v1/assistant/diagnose',
  },

  events: {
    metrics: () => '/api/v1/events/metrics',
    tasks: () => '/api/v1/events/tasks',
    logs: () => '/api/v1/events/logs',
  },
}
