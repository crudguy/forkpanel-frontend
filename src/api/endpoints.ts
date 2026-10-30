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
    // 首启向导「从文件读取令牌」按钮：仅在 localhost 可取（后端对回环硬拒），避免手抄终端令牌
    bootstrapToken: () => '/api/v1/auth/bootstrap-token',
    password: () => '/api/v1/auth/password',
    mfaEnroll: () => '/api/v1/auth/mfa/enroll',
    mfaVerify: () => '/api/v1/auth/mfa/verify',
    mfaDisable: () => '/api/v1/auth/mfa/disable',
  },

  system: {
    capabilities: () => '/api/v1/system/capabilities',
    overview: () => '/api/v1/system/overview',
    users: () => '/api/v1/system/users',
    directories: () => '/api/v1/system/directories',
    /** 重启面板（owner + system.manage）。202 = job 已交给 PID 1；
     *  前端把请求失败也视作已发起，轮询 /version 判定恢复。 */
    restart: () => '/api/v1/system/restart',
    /** 检查更新（只读，不下载/不写盘）。system.manage + 只读限流；
     *  网络失败仍是 200，由 data.error 说明原因。 */
    upgradeCheck: () => '/api/v1/system/upgrade/check',
    /** 触发 Web 升级（默认关闭；owner + [danger] allow_web_upgrade + systemd-run）。
     *  202 只代表已交给瞬时单元；是否成功看 /version 是否恢复。 */
    upgrade: () => '/api/v1/system/upgrade',
    /** 公网暴露向导（域名反代 + 防火墙白名单 + TLS）。
     *  status 只需 system.view（状态不是秘密）；apply / remove 需 system.manage
     *  且经 CSRF。能力位 EXPOSE_MANAGE 不支持时三者分别返 200（status 带
     *  supported=false）/ 501。**只有 apply / remove 会真的改动系统**。 */
    expose: {
      status: () => '/api/v1/system/expose/status',
      apply: () => '/api/v1/system/expose/apply',
      remove: () => '/api/v1/system/expose/remove',
    },
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
    // 设置/取消升级钉住（apt-mark hold/unhold）。POST 幂等：重复 hold/unhold 同一包
    // 都返回成功。非 apt 管理器（mock/预览模式）后端返回 501，UI 据此隐藏入口。
    hold: (name: string) => `/api/v1/packages/${enc(name)}/hold`,
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
    /** 对象说明（备注，022）：这台站点干嘛的、为什么这么配。PATCH 内联保存（site.manage） */
    remark: (id: number) => `/api/v1/sites/${id}/remark`,
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
    /** 站点独立日志：下载（021，kind=access|error 走 query） */
    logDownload: (id: number, kind: string) => `/api/v1/sites/${id}/log/download?kind=${encodeURIComponent(kind)}`,
    /** 站点独立日志：清空（021，截断而非删除；body 可选 kind） */
    logClear: (id: number) => `/api/v1/sites/${id}/log/clear`,
    sslApply: (id: number) => `/api/v1/sites/${id}/ssl/apply`,
  },
  // WAF 策略模板（026）：与站点解耦的 WAF+访问控制预设；套用由前端经 sites.apply 编排
  waf: {
    alert: { get: () => '/api/v1/waf/alert', put: () => '/api/v1/waf/alert' },
    events: { list: () => '/api/v1/waf/events' },
    templates: {
      list: () => '/api/v1/waf/templates',
      create: () => '/api/v1/waf/templates',
      get: (id: number) => `/api/v1/waf/templates/${id}`,
      update: (id: number) => `/api/v1/waf/templates/${id}`,
      remove: (id: number) => `/api/v1/waf/templates/${id}`,
    },
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
    conn: (id: number) => `/api/v1/db/connections/${id}`,
    databases: (conn: number) => `/api/v1/db/${conn}/databases`,
    /** 「库」的下一级（PG → schema；MySQL/SQLite → 空数组）。与 tables 是两个不同问题 */
    schemas: (conn: number, db: string) => `/api/v1/db/${conn}/${enc(db)}/schemas`,
    tables: (conn: number, db: string) => `/api/v1/db/${conn}/${enc(db)}/tables`,
    rows: (conn: number, db: string, table: string) =>
      `/api/v1/db/${conn}/${enc(db)}/${enc(table)}/rows`,
    /**
     * 全量表导出 CSV。与 rows 分开成路径（而非 `?format=csv`）：
     * 一个回 JSON 一个回 text/csv，混在一个端点上契约说不清。
     * 前端走 api.download 而非 window.open：超限拒绝的可执行建议
     * （「请用 SQL 控制台加 WHERE」）在 4xx 响应体里，window.open 拿不到。
     */
    exportCsv: (conn: number, db: string, table: string) =>
      `/api/v1/db/${conn}/${enc(db)}/${enc(table)}/export`,
    backup: (conn: number) => `/api/v1/db/${conn}/backup`,
    restore: (conn: number) => `/api/v1/db/${conn}/restore`,
    query: (conn: number) => `/api/v1/db/${conn}/query`,
    /**
     * SQL 控制台元数据（能力位 + 引擎相关的默认语句与示例）。
     *
     * 与 query 分开成两个路径：这个回答「该不该开控制台、从哪句开始」，
     * query 回答「执行这一条」。示例 SQL 是引擎知识，由后端单点下发——
     * 前端**不存**任何引擎判断，避免与后端口径漂移。
     */
    sqlMeta: (conn: number) => `/api/v1/db/${conn}/sql-meta`,
    /** 数据库连接说明（备注，022）。PATCH 内联保存（db.manage）；conn 为 id 或 name */
    remark: (conn: string | number) => `/api/v1/db/${enc(conn)}/remark`,
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
    // 产物下载（流式；后端会校验 plan<id>- 前缀 + 沙箱父目录）
    // 远端副本清单（本地盘出事时，只有它能告诉你异地还有哪几份）
    remoteArtifacts: (id: number) => `/api/v1/backups/${id}/remote/artifacts`,
    artifactDownload: (id: number, name: string) =>
      `/api/v1/backups/${id}/artifacts/${encodeURIComponent(name)}`,
    // 系统自动备份（面板库每日快照）：此前只写不列，页面完全看不到
    system: () => '/api/v1/backups/system',
    systemDownload: (name: string) => `/api/v1/backups/system/${encodeURIComponent(name)}`,
    restore: (id: number) => `/api/v1/backups/${id}/restore`,
  },
  containers: {
    list: () => '/api/v1/containers',
    /** 创建容器（`docker create`，默认不启动）；POST 上述同一路径，body 见 openapi */
    create: () => '/api/v1/containers',
    images: () => '/api/v1/containers/images',
    /** 拉取 / 更新镜像（等价 `docker pull`；写操作，需 container.manage + 镜像引用安全校验）。 */
    pull: () => '/api/v1/containers/images/pull',
    install: () => '/api/v1/containers/install',
    // 把面板运行用户加入 docker 组（修复 daemon_unreachable 的高危操作）
    joinDockerGroup: () => '/api/v1/containers/join-docker-group',
    // 生命周期动作；id 为容器 ID 或名称（后端白名单校验）
    start: (id: string) => `/api/v1/containers/${id}/start`,
    stop: (id: string) => `/api/v1/containers/${id}/stop`,
    restart: (id: string) => `/api/v1/containers/${id}/restart`,
    remove: (id: string, force = false) => `/api/v1/containers/${id}${force ? '?force=true' : ''}`,
    /** 容器备注（022）：GET 读 / PATCH 写（container.manage）。容器不入库，存引用表 */
    remark: (id: string) => `/api/v1/containers/${enc(id)}/remark`,
    /** 容器日志查看（`docker logs`，只读最近 N 行快照，不带 --follow）。GET 读，需 container.view；
     *  query: tail（默认 200，上限 2000）/ timestamps（带 RFC3339 前缀）。前端用 api.get 的 params 拼。 */
    logs: (id: string) => `/api/v1/containers/${id}/logs`,
    /** 全部容器的资源用量快照（`docker stats --no-stream --all`，非流式）。GET 读，
     *  需 container.view；无参数（一次返回所有容器），故无注入面。 */
    stats: () => `/api/v1/containers/stats`,
    /** 网络列举（只读）：docker network ls --no-trunc，需 container.view */
    networks: () => '/api/v1/containers/networks',
    /** 卷列举（只读）：docker volume ls（无 --no-trunc，卷名默认不截断），需 container.view */
    volumes: () => '/api/v1/containers/volumes',
    /** Compose 项目列举（只读）：docker compose ls --all --format json（compose 的
     *  --format 只接受 table | json 两个字面量，Go 模板形态会被拒），需 container.view */
    composeProjects: () => '/api/v1/containers/compose',
    // Compose 生命周期动作（写，container.manage）：up / stop / restart / down。
    // down 需 confirm_token = 项目名；up 需 working_dir。后端永不传 -v（不删卷）。
    composeAct: (project: string) =>
      `/api/v1/containers/compose/${encodeURIComponent(project)}/act`,
    // 面板编排（stack 定义）：读写 <data_dir>/compose-stacks/ 下的文件。
    // ⚠ 这组端点不依赖 docker daemon（改编排定义与部署是两件事）。
    stacks: () => '/api/v1/containers/stacks',
    stack: (project: string) =>
      `/api/v1/containers/stacks/${encodeURIComponent(project)}`,
  },

  server: {
    /** 本机便签（025，多条）。GET 列表（全员）/ POST 新建（system.manage） */
    notes: () => '/api/v1/server/notes',
    /** 单条便签：PATCH 更新 / DELETE 删除（均需 system.manage） */
    note: (id: number | string) => `/api/v1/server/notes/${enc(id)}`,
  },

  firewall: {
    status: () => '/api/v1/firewall/status',
    setEnabled: () => '/api/v1/firewall/enabled',
    rules: () => '/api/v1/firewall/rules',
    removeRule: (id: string) => `/api/v1/firewall/rules/${enc(id)}`,
    // fail2ban 入侵防御（未装 fail2ban-client 时 GET 返 501，由视图友好提示）
    fail2ban: () => '/api/v1/firewall/fail2ban',
    fail2banJail: () => '/api/v1/firewall/fail2ban/jail',
    fail2banUnban: () => '/api/v1/firewall/fail2ban/unban',
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
    // Webhook：测试任意 URL 可达性 / 触发某任务已配置的 webhook（发一条 test 事件）
    webhookTest: () => '/api/v1/cron/webhook/test',
    webhookTrigger: (id: string) => `/api/v1/cron/jobs/${enc(id)}/webhook`,
  },

  logs: {
    sources: () => '/api/v1/logs/sources',
    stream: (source?: string, filter?: string, limit?: number, level?: string, since?: number) => {
      const p = new URLSearchParams()
      if (source) p.set('source', source)
      if (filter) p.set('filter', filter)
      if (limit) p.set('limit', String(limit))
      if (level) p.set('level', level)
      if (since) p.set('since', String(since))
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
    dashboard: () => '/api/v1/settings/dashboard',
    // C2 首启上手清单（GET 只需登录 / PUT 需 settings.manage）
    onboarding: () => '/api/v1/settings/onboarding',
    // C10 测试连接：真实探测 /v1/models（仅探测，不改配置）
    llmTest: () => '/api/v1/settings/llm/test',
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
