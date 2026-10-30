import { ref } from 'vue'

/**
 * 能力矩阵类型与判定。
 *
 * ⚠️ 核心纪律：前端**禁止**写 `if (isLinux)` / `navigator.platform` / `target_os`。
 * 一切平台差异都由后端 capabilities 驱动（后端只支持 Linux，但前端仍不假设）。
 */

export interface Capability {
  supported: boolean
  backend: string | null
  reason: string | null
}

export type CapabilityMap = Record<string, Capability>

/** 高危操作的并发上限（/system/capabilities 的 limits）。 */
export interface Limits {
  terminal_max_sessions: number
}

export interface PlatformInfo {
  os: string
  arch: string
  init: string
  distro: string | null
  kernel: string | null
}

/** 目录与文件位置（/system/directories）：按用途分组的条目 */
export interface DirectoryItem {
  label: string
  path: string
  desc: string | null
}
export interface DirectoryGroup {
  key: string
  title: string
  items: DirectoryItem[]
}
export interface DirectoriesResp {
  binary: string
  frontend_embedded: boolean
  groups: DirectoryGroup[]
}

// ── 公网暴露向导（对应 openapi `ExposeStatus` / `ExposeApplyReq` / `ExposeApplyResp`）──
//
// 状态判据在**后端**（探测 expose-public.sh 落的两个文件），前端不自行推断：
// - exposed ← /etc/nginx/conf.d/forkpanel-public-access.conf 存在
// - tls     ← panel.service.d/panel-tls.conf 存在
// 因此这里没有任何「猜」的逻辑。
//
// ⚠ `supported` / `unsupported_reason` 与能力位同源（后端也取自
//   `state.capabilities`），由 status **冗余下发**以保持契约自洽。
//   本页整页门控的主判据仍是 `auth.supported(CAP.EXPOSE_MANAGE)`；但当能力位
//   尚未加载完（status.supported 已为真、能力位却还没到位）时，回落到
//   `!status?.supported` 作兜底，避免"能力位还没到就先弹置灰"的闪屏。
//   门控仍由能力位主导，status 仅补一道加载态兜底（见 ExposeWizardView.vue）。
export interface ExposeStatus {
  /** 是否正在对外暴露（nginx 反代配置存在） */
  exposed: boolean
  /** 是否启用 HTTPS 终结 */
  tls: boolean
  /** expose-public.sh 是否已安装（缺失时 apply 必失败） */
  script_installed: boolean
  /** 能力位 EXPOSE_MANAGE 是否支持 */
  supported: boolean
  /** 不支持的原因（need_nginx / script_missing / non_root）；supported=true 时为 null */
  unsupported_reason: string | null
}

/** POST /system/expose/apply 的请求体。
 *
 * 校验规则**不在此复制**（同约束放两处必漂移）：域名与 CIDR 的合法性由后端
 * `panel_core::expose` 判定并回中文原因，前端只做「空值就先别提交」这类即时提示。
 * ⚠️ fullchain / key 必须成对，且优先于 self_signed（脚本侧语义）。 */
export interface ExposeApplyReq {
  /** 对外域名，如 panel.example.com（至少两级，顶级域不含数字） */
  domain: string
  /** 允许访问的来源网段（IPv4 CIDR），至少一个；名单外一律拒绝 */
  allow: string[]
  /** true = 现场生成自签证书（浏览器会告警） */
  self_signed?: boolean
  /** 已有证书链路径（与 key 成对） */
  fullchain?: string | null
  /** 证书私钥路径（与 fullchain 成对） */
  key?: string | null
  /** true = 不自动放行防火墙端口 */
  no_firewall?: boolean
}

export interface ExposeApplyResp {
  /** 已生效的域名 */
  domain: string
  /** 脚本 stdout（逐步结果，原样展示给用户——那是失败时唯一的信息来源） */
  output: string
}

export interface ExposeRemoveResp {
  /** 脚本 stdout */
  output: string
}

/** 系统自动备份（面板库每日快照，`panel-<unix>.db`） */
export interface SystemBackup {
  name: string
  size: number
  mtime: number
}

/** `/backups/system` 响应：`keep` / `daily_backup` 是**进程里实际生效**的值
 *  （config.toml `[db]`）。页面必须显示它们，写死 7 会在改过配置的机器上说谎。 */
export interface SystemBackupsResp {
  dir: string
  items: SystemBackup[]
  keep: number
  daily_backup: boolean
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
  /// fail2ban 入侵防御：只取决于宿主是否有 fail2ban-client——与防火墙后端正交（nftables 下同样可用）
  FAIL2BAN: 'fail2ban.manage',
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
  /// 公网暴露向导（域名反代 + 防火墙白名单 + TLS）。
  ///
  /// ⚠️ 本能力位**不代表已经对外暴露**，只代表「具备开启条件」（有 nginx +
  /// expose 脚本已装 + 面板以 root 运行）。真实是否暴露看 `/system/expose/status`
  /// 的 `exposed` 字段——两者混用会让「能开」变成「已开」。
  EXPOSE_MANAGE: 'expose.manage',
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
    case 'no_engine': return '未检测到可用的数据库引擎'
    case 'no_log_source': return '未检测到可用的日志源'
    case 'daemon_unreachable': return '守护进程不可达（面板用户需加入 docker 组）'
    // compose 是 Docker 的 CLI 插件，与 daemon 可达性无关：宿主可能「docker 能用、
    // compose 没装」（Debian 的 docker.io 包不带插件，需另装 docker-compose-plugin）。
    // 不映射会让用户看到英文原文，也说不清该装什么。
    case 'compose_unavailable': return '未安装 Docker Compose 插件（需 docker-compose-plugin）'
    // 公网暴露向导的三条拒绝原因（panel-os::expose_capability）
    case 'need_nginx': return '当前 Web 服务器不是 nginx，公网暴露向导只支持 nginx'
    case 'script_missing': return '未安装 expose-public.sh（重跑 install.sh 或手动部署该脚本）'
    case 'non_root': return '面板未以 root 运行，无法改 nginx 与防火墙'
    default: return c.reason
  }
}

// ── 站点（对应后端 `SiteOut`，routes/sites.rs）──
//
// 此前 SitesView 与 WafView 各声明一份（后者是前者的删减副本，缺 tls/created_at），
// 两处独立维护必然漂移 —— 统一到此处。

/** 站点类型。**注意** 库内值是 `static|reverse_proxy|php`，API 呈现为 `static|proxy|php`
 *  （换算在后端 kind_to_api/kind_to_db）。 */
export const siteKindLabel = enumLabel({ static: '静态站点', proxy: '反向代理', php: 'PHP 站点', redirect: '整站重定向' })

/** 站点 WAF 档位（落库值 basic / strict，对应 migrations/008_site_waf.sql）。 */
export const wafProfileLabel = enumLabel({ basic: '基础', strict: '严格' })

/** WAF 策略模板（026）：一套 WAF + 访问控制预设，可套用到站点（套用 = 把该站 waf/ip 列设成模板值）。
 *  rate_per_sec=0 表示不限速、burst=0 表示由 rate×2 计算；ip_allow/ip_deny 空数组表示不设。 */
export interface WafTemplate {
  id: number
  name: string
  waf_profile: string
  rate_per_sec: number
  burst: number
  ip_allow: string[]
  ip_deny: string[]
  created_at: number
  updated_at: number
}

/** 拦截事件（027，威胁日志）。⚠ 无规则归因：WAF/敏感文件/IP 黑名单都返回同色 403，只记状态码；
 *  且仅采集「开了独立 access log」的站点。 */
export interface BlockEvent {
  id: number
  site: string
  ts: number
  remote_addr: string
  method: string
  uri: string
  status: number
  referer: string
  user_agent: string
}

export interface Site {
  id: number
  name: string
  domains: string[]
  root: string
  /** API 口径：static | proxy | php | redirect | routed */
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
  /** SPA history 路由回退：仅 static 类型生效（try_files 兜底 /index.html）。其余类型恒 false */
  spa: boolean
  /** 整站重定向目标 URL（kind=redirect 时存在）；其余为 null。后端校验须 http(s):// 开头 */
  redirect_target: string | null
  /** 整站重定向状态码（301/302/307/308，kind=redirect 时存在）；其余为 null */
  redirect_code: number | null
  /** 多路由表（kind=routed 时非空）。⚠ 后端保证非 routed 时为 `[]` 而非 null */
  routes: SiteRoute[]
  /**
   * 手动维护：true = 磁盘上的配置文件由用户**原始编辑**接管，表单「保存并应用」
   * 不再覆盖它（后端 apply 跳过渲染/下发，仅照常更新库内其它字段）。
   * 可经编辑弹窗的「按表单重新生成」清零；停用 / 重新启用也会清零。
   */
  manual_conf: boolean
  /**
   * 未同步（仅 manual_conf=true 且站点启用时有意义）：表单的部署相关字段与
   * 「磁盘配置最后一次落盘时的指纹」不一致——即**面板里看到的规格 ≠ 线上文件**
   * （表单改过、文件没跟上，后端 017 迁移按指纹判定）。
   */
  conf_stale: boolean
  /**
   * 自定义配置片段（owner 维护，019）：插在主 server 块尾部（所有 location 之后），
   * 随表单「保存并应用」重新渲染。null / 空 = 无。
   * 与「手动维护」互补——片段属托管态（随保存重渲染），整文件手动维护则不被覆盖。
   */
  custom_conf: string | null
  /**
   * www ↔ 非 www 跳转（020）：off | to_www | to_bare。
   * **只对主域名**（domains[0]）生效——子域不会被一起改写。
   */
  www_redirect: string
  /** 加密套件档位（020）：compat（老客户端）/ modern（默认）/ strict（仅 TLSv1.3） */
  tls_profile: string
  /** TLS 版本下限（020）：TLSv1 | TLSv1.1 | TLSv1.2 | TLSv1.3 */
  tls_min: string
  /** HSTS 开关（020）。⚠ 浏览器在 max-age 期间强制 HTTPS、服务端无法撤回 */
  hsts: boolean
  /** HSTS max-age（秒） */
  hsts_max_age: number
  hsts_include_sub: boolean
  hsts_preload: boolean
  /** 伪静态预置模板（020，仅 php）：none | wordpress | laravel | thinkphp | typecho | discuz | custom */
  rewrite_preset: string
  /** rewrite_preset=custom 时的原始 rewrite 文本；其余为 null */
  rewrite_custom: string | null
  /**
   * 外部修改（020）：磁盘上的配置文件与「最后一次落盘的内容」不一致——文件在面板
   * 之外被改动过。面板**不会**静默覆盖它，由用户决定重新生成 / 改片段 / 手动接管。
   */
  conf_external: boolean
  // ── 021：访问控制 / 反代增强 / 站点日志 ──
  /** IP 白名单（单 IP 或 CIDR，IPv4）；非空即白名单模式（只放行名单内，其余 deny all），此时 ip_deny 被忽略 */
  ip_allow: string[] | null
  /** IP 黑名单（单 IP 或 CIDR，IPv4）；ip_allow 非空时被忽略 */
  ip_deny: string[] | null
  /** HTTP Basic Auth 开关（口令不落库，仅设置时经 openssl 生成 apr1 摘要写入 htpasswd 文件） */
  auth_basic: boolean
  /** Basic Auth 用户名（auth_basic=true 时必填） */
  auth_user: string | null
  /** 多后端负载均衡策略（021）：least_conn | ip_hash。单后端时 upstream 块不存在、策略不生效 */
  lb_policy: string
  /** 反代建连超时（秒，1~3600） */
  proxy_connect_timeout: number
  /** 反代发送超时（秒，1~3600） */
  proxy_send_timeout: number
  /** 反代读取超时（秒，1~3600） */
  proxy_read_timeout: number
  /** 站点独立访问日志开关（021）：开启后由面板指定路径，可下载/清空 */
  log_access: boolean
  /** 站点独立错误日志开关（021） */
  log_error: boolean
  /** 错误日志级别（021）：debug | info | notice | warn | error | crit | alert | emerg */
  log_error_level: string
  /** 对象说明（备注，022）：站长维护的自由文本（≤500 字），随站点列表/详情返回，空串 = 无 */
  remark: string
  /**
   * 上次下发时间（023）：最近一次「配置写入磁盘且 nginx reload 成功」的 Unix 秒。
   * null = 从未成功下发过（区别于 0 = 1970）。停用站点不会刷新（撤下不是下发）。
   */
  last_applied_at: number | null
}

/** 配置历史版本（后端 GET /sites/{id}/conf/versions 列表项，最新在前） */
export interface ConfVersion {
  id: number
  /** content 的 SHA-256 十六进制（去重与「当前版本」标记用） */
  hash: string
  /** 写入口：apply（表单下发）/ regen（按表单重新生成）/ manual（手动保存）/ rollback（回滚） */
  source: string
  /** 触发用户名（与审计日志同源） */
  operator: string
  created_at: number
  /** 内容长度（字节） */
  size: number
  /** 内容是否与磁盘当前文件一致（文件缺失 / 未下发时全部 false） */
  current: boolean
}

/** 单个历史版本正文（GET /sites/{id}/conf/versions/{vid}，回滚前预览） */
export interface ConfVersionDetail {
  id: number
  content: string
  hash: string
  source: string
  operator: string
  created_at: number
}

/**
 * 单条路由（对应后端 SiteRoute / panel_os::SiteRoute）。
 *
 * `prefix` 会**直接进 nginx 配置文本**，后端已做注入白名单校验；
 * 前端只做「以 / 开头」这类即时提示，不复制注入规则（同约束放两处必漂移）。
 */
export interface SiteRoute {
  /** URL 前缀，须以 / 开头；/ 为兜底（最多且必须有一条） */
  prefix: string
  kind: 'proxy' | 'static' | 'php'
  /** kind=proxy：后端列表（至少 1 个） */
  upstreams?: string[]
  /** kind=static：未命中是否回退 /index.html */
  spa?: boolean
  /** kind=php：php-fpm 目标 */
  fpm?: string
  /**
   * kind=php：**入口脚本（必填，相对站点根、须以 / 开头）**。
   *
   * 多路由下一律用 front controller 形式——`location ^~` 会屏蔽 `~ \.php$`，
   * 没它就没有任何入口（Laravel/ThinkPHP 的标准部署姿势是 /public/index.php）。
   */
  front_controller?: string
  /**
   * kind=static：**该路由自己的根目录（可选，覆盖站点级 root）**。
   * 留空继承站点根目录（最常见的「整站一个根、各静态子路径共用」）；填了则这条
   * 静态路由从它自己的目录读文件（如 `/` 前端产物 + `/blog` 另一套静态站）。
   * 后端会约束其落在 site_root 之内，防路径穿越。
   */
  root?: string
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
/** 面板托管的应用（后端 AppRuntime 的镜像；枚举文案一律用后端给的 label）。 */
export interface AppInfo {
  id: number
  name: string
  runtime: string
  /** 展示名由后端给出（`runtimeLabel`），前端不自行翻译 */
  runtime_label: string
  workdir: string
  exec_start: string
  run_user: string | null
  /** 环境变量 [[k, v], ...]。⚠ 后端不加密存储，敏感值勿填 */
  env: [string, string][]
  port: number
  auto_restart: boolean
  enabled: boolean
  domains: string[]
  created_at: number
  /** systemd 单元名，可拿去服务日志页看输出 */
  unit: string
  /** systemd 状态；探测失败为 null（**不是** 'unknown'——两者含义不同） */
  state: string | null
}

/** 运行时元数据（`GET /api/v1/apps/catalog`）。前端下拉的唯一数据源。 */
export interface AppRuntimeInfo {
  key: string
  label: string
  default_port: number
  /** 面板包白名单里的系统包名；null = 面板不托管该运行时。
   *  **null 时不显示安装状态**——不做「你没有 X」这种面板无权判断的断言。 */
  runtime_pkg: string | null
  default_exec: string
  typical: string
  /** 用途：这个运行时是跑什么的（回答「Node 和 Python 我该选哪个」） */
  purpose: string
  /** 什么情况下该选它。刻意只给判断依据、不做性能排名 */
  choose_when: string
  /** 构建步骤提示（纯文案，面板不执行构建） */
  build_hint: string
}

/** 本机便签（025，多条）。id=1 恒为迁移 025 从旧单例「本机说明」迁入的那条。 */
export interface ServerNote {
  id: number
  content: string
  /** 最近更新时间（unix 秒） */
  updated_at: number
}

export interface PackageInfo {
  name: string
  label?: string
  version: string | null
  manager: string
  /** 是否被 apt-mark hold 钉住（后端按**真实包名**比对后回填）。true = 挡住 apt-get
   *  upgrade 的自动升级；不影响显式指定版本安装——是防误升，不是安全边界。
   *  仅已安装包有意义；非 apt 管理器恒 false。 */
  held?: boolean
  /** 该软件包对应的主服务单元（后端由 dpkg -L 推导，enabled 但当前未运行的服务也能关联）。
   *  为 null 表示该软件没有可管理的服务（如 certbot/ufw），UI 据此不渲染「服务管理」入口。 */
  unit?: ServiceRef | null
}

/** 白名单条目（GET /api/v1/packages 的 `catalog[]`）。
 *
 *  name/label/external 是包的身份；后四项是**面向用户的说明**，由后端随包一起下发。
 *  这些文案刻意不在前端硬编码：包集合的唯一事实源是后端 `ALLOWED_PACKAGES`，
 *  说明若另写一份，后端加包或改能力（某软件的入口页被下线）时前端不会有任何编译
 *  错误，只会静默说谎——而「说明写着有入口、界面里找不到」正是最伤人的一类。
 *  所以软件卡片上的「说明」直接渲染这四个字段。 */
export interface PackageCatalogEntry {
  name: string
  label: string
  /** 官方仓库通常不含此包，需先在目标机配置第三方软件源才能安装 */
  external?: boolean
  /** 用途：一句话说明这个软件是什么 */
  summary: string
  /** 主要功能：用户会实际用到的能力 */
  features: string
  /** 适用场景：什么情况下该装它 */
  scenes: string
  /** 使用方式 / 访问入口：面板内入口 + 面板外的真实访问方式（面板没有的会如实写明） */
  entry: string
  /**
   * 怎么配：到了 `entry` 所指页面之后具体填什么（必填项 / 典型值 / 常见错法）。
   * 与 `entry` 分开展示——「去哪」和「填什么」是用户卡住的两个不同位置。
   * 面板内无需填写的包写「无需填…」，不会是空串（后端有守卫测试钉住）。
   */
  howto: string
  /**
   * 该包在 systemd 上对应的服务单元名（`nginx.service` / `grafana-server.service`…）。
   *
   * 服务详情页拿**当前单元名**在这里反查，在本页直接展开软件说明，而不是把用户送去
   * 「软件」页再点一次 `?`。必须由后端下发：包名与单元名不是同一个字符串
   * （`mariadb-server`→`mariadb.service`、`grafana`→`grafana-server.service`、
   * `php-fpm`→`php8.4-fpm.service`），前端按包名拼会**全部落空且无任何报错**。
   *
   * 空数组（或字段缺失）= 该包没有常驻服务单元（运行时 / 工具链 / 元包）。
   */
  units?: string[]
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
  /** systemd 单元自带的 Description（多半是英文的一句话，如 "A high performance web server"）。
   *  它是**软件自己写的**元数据，不是面板文案：可能缺失、可能是纯英文、也可能只是
   *  "LSB: ..." 这种没信息量的占位。UI 不得把它当成"说明"全部——它只是佐证。 */
  description: string | null
  /** 是否受面板托管（未托管服务的停止需二次确认） */
  managed: boolean
}
/** 软件包关联的服务单元（精简版，仅软件卡片入口所需；不含 ServiceInfo 的完整字段）。
 *  name 是完整单元名（含 .service 后缀），state 是 systemd 口径状态字符串。 */
export interface ServiceRef {
  name: string
  state: string
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
  narrative?: string
  findings: AssistantFinding[]
  ctx: AssistantContext
}

/** 设置：三段诚实模型（runtime 可改即生效 / deployment 只读 / reserved 预留未接线） */
export interface SettingsReport {
  runtime: {
    endpoint: string | null
    model: string | null
    api_key_set: boolean
    /** P0-2：叙事层独立开关，缺省 false；false 时后端不外发任何诊断数据 */
    narrative: boolean
    /** 开启后会外发什么的披露文案（后端单一维护，原样展示） */
    narrative_note: string
  }
  deployment: {
    read_only: boolean
    tier: 'nano' | 'small' | 'standard'
    /** 连续登录失败达此次数即锁定账号（`[security] max_login_attempts`） */
    max_login_attempts: number
    /** 会话空闲超时，`fmt_dur` 产出，形如 `30m` / `12h` / `45s` */
    session_idle: string
    /** 会话绝对超时，格式同上 */
    session_absolute: string
    /** 审计日志保留天数（`[audit] retention_days`） */
    audit_retention_days: number
    /** 审计表单行数上限，超出即裁剪（`[audit] max_rows`） */
    audit_max_rows: number
    /**
     * `[server] localhost_only`：为真时 `Config::addr()` **强制只监听 127.0.0.1**
     * （覆盖 `bind`，故只改 bind 不生效）。
     *
     * 这是「面板为什么只能从本机访问」的唯一事实源。页面必须展示它并给出放开
     * 方式——否则用户只会看到"局域网连不上"，却无从知道该改哪里。
     */
    localhost_only: boolean
    /** 每日自动备份开关（`[db] daily_backup`） */
    db_daily_backup: boolean
    /** SQLite 落盘同步档，归一化大写（`[db] synchronous`） */
    db_synchronous: string
    /** 备份保留份数（`[db] backup_keep`） */
    db_backup_keep: number
    /** 安装与运行位置（只读；不是可 PATCH 的设置项） */
    installation: {
      app_version: string
      build: string
      platform: string
      bin_path: string
      config_dir: string
      data_dir: string
      log_dir: string
      service_manager: 'systemd'
      /** `systemctl is-active`；null = 无法判定（非 systemd / 命令缺失），不得当成「已停止」 */
      service_active: boolean | null
      /** `systemctl is-enabled`；null 同上 */
      service_enabled: boolean | null
      /** 仅 owner 为 true；admin 可改设置但不能重启服务 */
      can_restart: boolean
    }
    hint: string
  }
  reserved: {
    wired: false
    note: string
    values: Record<string, string>
  }
}

// ── 检查更新（对应 openapi `UpgradeCheck`）──
export interface UpgradeCheck {
  current: string
  latest: string | null
  latest_tag: string | null
  /** 数字核心版本更大才为 true；同核心的预发布不算可升级 */
  available: boolean
  prerelease: boolean
  published_at: string | null
  source: 'github'
  /** false = 宿主无 curl，无法检查 */
  supported: boolean
  checked_at: number
  /** 失败原因；null = 本次检查成功 */
  error: string | null
}

// ── 首启上手清单（C2，对应 openapi `OnboardingState`）──
/** 步骤 id 由后端固定给出（5 步）；前端不得自行发明或补充 */
export type OnboardingStepId =
  | 'trust_ca'
  | 'create_site'
  | 'issue_cert'
  | 'enable_waf'
  | 'backup_plan'

export interface OnboardingStep {
  id: OnboardingStepId
  title: string
  desc: string
  /** 前端路由：「前往」直达 */
  route: string
  /** 用户手动勾选 */
  checked: boolean
  /** 由后端真实状态判定已完成 —— 此时勾选框须禁用（勾了结果也不变） */
  auto: boolean
  /** checked || auto：渲染只看这个 */
  done: boolean
}

export interface OnboardingState {
  steps: OnboardingStep[]
  dismissed: boolean
  updated_at: number | null
  done_count: number
  total: number
}

/** PUT /settings/onboarding 的请求体：整体替换勾选集合 */
export interface OnboardingPut {
  checked: OnboardingStepId[]
  dismissed?: boolean
}

// ── C10 测试连接（对应 openapi `LlmTestResult`）──
export interface LlmTestResult {
  ok: boolean
  latency_ms: number
  endpoint: string
  model: string | null
  /** 配置的 model 是否出现在 /v1/models 列表里 */
  model_found: boolean
  /** 响应不是预期 JSON 时为 null */
  model_count: number | null
  /** 连不上 / 超时时为 null */
  status: number | null
  /** 人话结论：成功摘要或失败原因 */
  detail: string
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
  firewalld: 'firewalld', None: '无',
})

/** 证书（ssl_certs 行）。列表 / 续期 / 删除 / 自动续期在 CertsView 与 SitesView 共用，
 *  故提为全局类型，避免两处各存删减副本而漂移（Site 已如此处理）。 */
export interface Cert {
  id: number
  domain: string
  /** 签发者：自签为面板本地根 CA 的 CN；ACME 为 Let's Encrypt 等。 */
  issuer: string | null
  /** 到期时间（Unix 秒）。 */
  not_after: number | null
  /** 距到期天数（后端计算，可能为 null）。 */
  days_left: number | null
  auto_renew: boolean
  renew_state?: 'idle' | 'pending' | 'ok' | 'failed'
  /** 落库来源：acme / selfsigned / manual（见 certSourceLabel）。 */
  source: string
}

/** 证书来源（`ssl_certs.source` 落库值）。注意：申请接口的 **入参** method 用连字符形式
 *  （self-signed），落库后统一为 `selfsigned`——标签表必须按落库值建键，否则漏配会把
 *  生英文 `selfsigned` 直接渲染到「来源」列。 */
export const certSourceLabel = enumLabel({
  acme: 'ACME 签发', selfsigned: '自签', manual: '手动上传',
})

/** 证书自动续期扫描状态。 */
export const certRenewStateLabel = enumLabel({
  idle: '空闲', pending: '续期中', ok: '成功', failed: '失败',
})

/** 自动续期扫描状态（`GET /certs/renew-sweep`）。CertsView 与 SitesView 都要拉
 *  （SitesView 还要往下传给站点编辑弹窗展示「上次/下次扫描」），此前两处各声明一份
 *  同名字段完全相同的 interface——改字段就要改两处，故提到这里与 `Cert` 同处。 */
export interface RenewSweep {
  /** 上次扫描时刻（Unix 秒）；0 = 从未运行过。 */
  last_at: number
  /** 上次扫描实际入队的证书张数。 */
  last_queued: number
  /** 下次预计扫描时刻（Unix 秒）。 */
  next_at: number
}

/** 剩余天数 → 文本着色类（公共工具类 `.dim/.ok/.warn/.bad`，定义在 main.css）。
 *
 *  过去 CertsView 与 SiteFormDialog **逐字节各存一份**，属于「同一条刻度两个副本」：
 *  改阈值只改一处就会表现为「列表里 30 天是琥珀、弹窗里却是绿的」。现在两处 import
 *  同一份，刻度钉死在下面的单测里。
 *
 *  档位口径：`null` 未知 → dim（中性）；> 30 天 → ok；7~30 天 → warn；< 7 天 → bad。
 *  注意是**严格大于 30** 才算 ok——刚好 30 天进 warn（留一天余量给续期窗口）。
 */
export function certLevel(d: number | null): 'dim' | 'ok' | 'warn' | 'bad' {
  if (d === null) return 'dim'
  if (d > 30) return 'ok'
  if (d >= 7) return 'warn'
  return 'bad'
}

/** 备份计划类型。 */
export const backupKindLabel = enumLabel({ panel: '面板数据', site: '站点文件', db: '数据库连接' })

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

/** 审计结果的可选键（与 auditResultLabel 的键一一对应；下拉选项由此生成，避免前后端漂移） */
export const AUDIT_RESULT_KEYS = ['ok', 'changed', 'unchanged', 'queued', 'denied', 'error', 'fail'] as const

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
//
// 时区：默认跟随浏览器（local）；用户可在菜单切 UTC（C4）。timeMode 是模块级
// ref——fmt* 在模板渲染期读 timeMode.value，切换时已在视图里的绝对时间会自动重渲染。

export type TimeMode = 'local' | 'utc'

const K_TIME_MODE = 'forkpanel.time.mode'

function readTimeMode(): TimeMode {
  try { return localStorage.getItem(K_TIME_MODE) === 'utc' ? 'utc' : 'local' } catch { return 'local' }
}

/** 全局时区偏好（模块级 ref，保证模板渲染反应式）。 */
export const timeMode = ref<TimeMode>(readTimeMode())

/** 切时区并持久化；同时写到 <html data-time> 供需要 CSS 区分的场景使用。 */
export function setTimeMode(m: TimeMode) {
  timeMode.value = m
  try { localStorage.setItem(K_TIME_MODE, m) } catch { /* 隐私/配额：本次会话仍生效 */ }
  document.documentElement.dataset.time = m
}
// 初始化时同步一次 data-time（刷新后保持）。
// ⚠ 加 typeof 守卫：本模块同时被单测（node 环境，无 document）导入——一个
// 「格式化工具」模块不该因导入即碰 DOM 而无法在非浏览器环境加载。浏览器里
// document 恒存在，行为与原来逐字一致。
if (typeof document !== 'undefined') {
  document.documentElement.dataset.time = timeMode.value
}

/** 取年/月/日/时/分，按 timeMode 选本地或 UTC 取值器。 */
function ymdhmi(d: Date): { y: number; mo: number; da: number; h: number; mi: number } {
  if (timeMode.value === 'utc') {
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, da: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
  }
  return { y: d.getFullYear(), mo: d.getMonth() + 1, da: d.getDate(), h: d.getHours(), mi: d.getMinutes() }
}

/** 日期时间，如 `2026-10-03 14:05`。入参 Unix 秒。 */
export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const { y, mo, da, h, mi } = ymdhmi(d)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${y}-${p(mo)}-${p(da)} ${p(h)}:${p(mi)}`
}

/** 仅日期，如 `2026-10-03`。入参 Unix 秒。 */
export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const { y, mo, da } = ymdhmi(d)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${y}-${p(mo)}-${p(da)}`
}

/** 仅时分，如 `14:05`。入参 Unix 秒。 */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const { h, mi } = ymdhmi(d)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(h)}:${p(mi)}`
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
