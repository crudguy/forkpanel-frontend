/**
 * 站点表单模型（新建 / 编辑弹窗的形状，以及它的下游产物）。
 *
 * 抽出来的边界是「**只依赖表单本身、不依赖 DOM / 列表 / 路由**」的那一半：
 * - 表单默认值、多路由行的形状、路由行 → API 口径的转换；
 * - 应用模板的预填纪律；
 * - 字段级校验常量（正则 / 后端字段映射 / 文案兜底）；
 * - 提交给 apply 的载荷（`applyBody`）与「哪些字段影响配置」的指纹（`confSpecNow`）。
 *
 * 剩下的数据编排与 DOM 交互（保存 / 下发 / 错误滚动 / 焦点）留在视图：它们要碰
 * `toast`、页面级 `error` 与模板 ref，抽进来只会让边界更模糊。
 *
 * ⚠ 与后端严格对齐的四条语义，改字段名 / 默认值前先看 `panel-api/routes/sites.rs`：
 *   ① `waf` **缺省 = 保留库中现值**（不是关闭）；② `rate_per_sec: 0` = 不限速；
 *   ③ `burst` 只在限速且有值时下发（不限速却带 burst 会被后端 400——"配了但没生效"
 *      属静默失败，后端刻意拒绝）；④ `routes` 省略 ≠ 清空。
 *   同理 `upstreams` / `fpm` 虽已落库，但「编辑时回填真实值」才能避免再次下发时
 *   被静默清空——这条由视图的 `openEdit` 负责，本模块只提供空形。
 */
import { computed, ref } from 'vue'
import { api } from '@/api/client'
import { API } from '@/api/endpoints'
import { CAP, type PackageInfo, type SiteRoute } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
// IP 名单提交口径与 WafView 共用同一出处：两页提交的是同一个后端 ip_allow/ip_deny
import { normIp } from './siteWaf'

// ── 应用模板（仅反向代理） ──
//
// Node / Java / Python / .NET 在 nginx 这一层**接入方式完全相同**——都是
// `proxy_pass` 到本机端口，渲染出的配置逐字节一致（见 panel-os 的 render_nginx）。
// 它们的差异只在「装什么运行时、用什么命令把进程拉起来」，所以做成**预填模板**，
// 而不是新的 `SiteKind` 变体：加 4 个类型 = 4 份产出同一份配置的 match 分支。
// 真正够格独立成类型的只有**协议不同**者（PHP 走 fastcgi_pass、将来的 gRPC 走 grpc_pass）。
export interface AppTemplate {
  key: string
  label: string
  /** 应用默认监听端口（仅作预填，用户可改） */
  port: number
  /** 面板包白名单里的运行时包名，用于「已装/未装」检测；null = 面板不托管该运行时 */
  runtimePkg: string | null
  /** 启动命令示例。**纯提示文案**，不进 nginx 配置——进程本身由 systemd / Docker 托管 */
  startCmd: string
  /** 典型框架，帮用户确认自己没选错 */
  typical: string
}

export const APP_TEMPLATES: AppTemplate[] = [
  { key: 'node', label: 'Node.js', port: 3000, runtimePkg: 'nodejs',
    startCmd: 'node server.js', typical: 'Express / NestJS / Next.js' },
  { key: 'java', label: 'Java', port: 8080, runtimePkg: 'default-jdk',
    startCmd: 'java -jar app.jar', typical: 'Spring Boot（内置 Tomcat）' },
  { key: 'python', label: 'Python', port: 8000, runtimePkg: null,
    startCmd: 'gunicorn app:app -b 127.0.0.1:8000', typical: 'Django / Flask / FastAPI' },
  { key: 'dotnet', label: '.NET', port: 5000, runtimePkg: null,
    startCmd: 'dotnet App.dll --urls http://127.0.0.1:5000', typical: 'ASP.NET Core（Kestrel）' },
]

/** 表单里的一条路由（`upstreams` 存成逗号分隔的字符串，便于 v-model 绑定）。 */
export interface RouteRow {
  prefix: string
  kind: 'proxy' | 'static' | 'php'
  upstreams: string
  spa: boolean
  fpm: string
  frontController: string
  /** kind=static：该路由自己的根目录（可选，覆盖站点级 root）；留空继承站点根 */
  root: string
}

export function newRoute(prefix: string, kind: RouteRow['kind']): RouteRow {
  return { prefix, kind, upstreams: '', spa: false, fpm: '', frontController: '', root: '' }
}

/** `RouteRow` → API 口径（只填该 kind 需要的字段，其余留空由后端忽略）。 */
export function rowToRoute(r: RouteRow): SiteRoute {
  if (r.kind === 'proxy') {
    return { prefix: r.prefix.trim(), kind: 'proxy', upstreams: r.upstreams.split(/[,\s]+/).filter(Boolean) }
  }
  if (r.kind === 'php') {
    return { prefix: r.prefix.trim(), kind: 'php', fpm: r.fpm.trim(), front_controller: r.frontController.trim() }
  }
  return { prefix: r.prefix.trim(), kind: 'static', spa: !!r.spa, root: r.root.trim() || undefined }
}

// ── 错误定位常量：把后端报错落到**出问题的那个输入框旁边** ──

/** 与后端 is_valid_domain 的语法段同口径（TLD 真实性只由后端校验，前端不内嵌列表）。 */
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
/** 与后端 is_valid_site_name 同口径：字母数字开头，后可接字母数字与 . _ -，长度 1~63。 */
export const SITE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/

/**
 * 后端 400 的字段名 → 表单字段 key + 中文兜底文案（见 panel-api `ApiError::bad_request`）。
 * 后端 reason 已是中文时优先用它（更具体），否则回退到这里的兜底（避免把英文甩给用户）。
 */
export const BACKEND_FIELD: Record<string, { key: string; msg: string }> = {
  name: { key: 'name', msg: '站点名称格式不正确' },
  domains: { key: 'domains', msg: '域名格式不正确' },
  root: { key: 'root', msg: '根目录不合法' },
  upstreams: { key: 'upstreams', msg: '后端地址不合法' },
  fpm: { key: 'fpm', msg: 'php-fpm 目标不合法' },
  redirect_target: { key: 'redirectTarget', msg: '重定向目标 URL 不合法' },
  redirect_code: { key: 'redirectCode', msg: '重定向状态码不合法' },
  'waf.profile': { key: 'wafProfile', msg: 'WAF 档位不合法' },
  'waf.rate_per_sec': { key: 'wafRate', msg: '限速取值不合法' },
  'waf.burst': { key: 'wafBurst', msg: '突发桶取值不合法' },
  custom_conf: { key: 'customConf', msg: '自定义片段不合法' },
}

/** 后端 reason 是否已是给人看的中文——是则原样透出（更具体），否则用前端中文兜底。 */
export function fieldMsg(fallback: string, reason: string) {
  return /[\u4e00-\u9fff]/.test(reason) ? reason : fallback
}

/** 空表单。`wafRate: 0` / `wafBurst: 0` 与后端的"不限速 / 自动"语义一一对应。 */
export function emptyForm() {
  return {
    name: '', domains: '', root: '', enabled: true,
    kind: 'static', upstreams: '', fpm: '',
    spa: false, redirectTarget: '', redirectCode: 301,
    // 多路由表。**新建时给一条 `/` 静态兜底**——不是默认值，是必要条件：
    // 缺兜底的路由表会被后端拒（漏掉的路径会落到别的站点去，用户无从预期）。
    routes: [newRoute('/', 'static')] as RouteRow[],
    wafOn: false, wafProfile: 'basic', wafRate: 0, wafBurst: 0,
    // 自定义配置片段（019）：插在主 server 块尾部（所有 location 之后），随保存并应用
    // 重新渲染下发；仅 owner 可改（后端 403 + 64KiB 双护栏）。空串 = 不使用。
    customConf: '',
    // 高级配置（020）：www 跳转 / TLS 强化 / 伪静态。默认值与后端 020 迁移一致
    wwwRedirect: 'off', tlsProfile: 'modern', tlsMin: 'TLSv1.2',
    hsts: false, hstsMaxAge: 300, hstsSub: false, hstsPreload: false,
    rewritePreset: 'none', rewriteCustom: '',
    // 访问控制 / 反代增强 / 站点日志（021）：默认值与后端 021 迁移一致
    ipAllow: '', ipDeny: '', authBasic: false, authUser: '', authPass: '',
    lbPolicy: 'least_conn', proxyConnectTimeout: 60, proxySendTimeout: 60, proxyReadTimeout: 60,
    logAccess: false, logError: false, logErrorLevel: 'error',
    // 对象说明（备注，022）：便签式内联编辑，独立于大表单保存
    remark: '',
  }
}

export type SiteForm = ReturnType<typeof emptyForm>

/** 组装 apply 的 waf 段。 */
export function wafPayload(f: SiteForm) {
  if (!f.wafOn) return { enabled: false }
  const p: Record<string, unknown> = {
    enabled: true,
    profile: f.wafProfile,
    rate_per_sec: f.wafRate,   // 0 = 不限速（后端语义）
  }
  // burst 只在限速且有值时下发：不限速却带 burst 会被后端 400（"配了但没生效"
  // 属于静默失败，后端刻意拒绝）；缺省时让后端按 rate×2 计算。
  if (f.wafRate > 0 && f.wafBurst > 0) p.burst = f.wafBurst
  return p
}

/** 站点类型 → apply 载荷里的目标值（proxy / php / redirect 的目标会直接进 nginx 配置文本）。 */
export function kindTargets(f: SiteForm) {
  const kind = f.kind
  if (kind === 'proxy') return { upstreams: f.upstreams.split(/[,\s]+/).filter(Boolean) }
  if (kind === 'php') return { fpm: f.fpm.trim() }
  if (kind === 'redirect') return { redirect_target: f.redirectTarget.trim(), redirect_code: f.redirectCode }
  // 多路由：整表下发。省略 ≠ 清空（后端 `routes` 缺省 = 保留库中现有表）。
  if (kind === 'routed') return { routes: f.routes.map(rowToRoute) }
  return {}
}

/**
 * 组装 `POST /sites/apply` 的载荷（「渲染并下发站点配置」这一步）。
 *
 * 与列表行「重载」的区别：重载只让 nginx 重读**磁盘上已有的**配置、不重新渲染；
 * 改了域名 / 类型 / WAF 后必须走这里才会生效。
 *
 * @param includeCustomConf 仅 owner 传 true——后端语义是「缺省 = 保留库中现值」，
 *                          非 owner 传 values 反而在服务端不生效，不传才不会误清。
 */
export function applyBody(
  f: SiteForm,
  o: { name: string; domains: string[]; regenerate?: boolean; includeCustomConf: boolean },
) {
  return {
    name: o.name,
    domains: o.domains,
    root: f.root.trim() || o.name,
    force_https: true,
    kind: f.kind,
    // SPA 回退仅对 static 类型有意义：其余类型强制 false，避免误带入反代/重定向。
    spa: f.kind === 'static' ? !!f.spa : false,
    ...kindTargets(f),
    // 仅「手动维护 + 用户选了重新生成」才带：后端据此按本次表单覆盖手写配置
    ...(o.regenerate ? { regen_conf: true } : {}),
    // 自定义片段（019，仅 owner）：空串 = 清空、非空 = 覆盖；非 owner **不传**
    ...(o.includeCustomConf ? { custom_conf: f.customConf } : {}),
    // 高级配置（020）：显式传即覆盖（校验在后端走白名单/区间）
    www_redirect: f.wwwRedirect,
    tls_profile: f.tlsProfile,
    tls_min: f.tlsMin,
    hsts: f.hsts,
    hsts_max_age: f.hstsMaxAge,
    hsts_sub: f.hstsSub,
    hsts_preload: f.hstsPreload,
    rewrite_preset: f.rewritePreset,
    rewrite_custom: f.rewriteCustom,
    // 访问控制 / 反代增强 / 站点日志（021）：IP 名单以逗号分隔字符串提交（后端解析/校验）
    ip_allow: normIp(f.ipAllow),
    ip_deny: normIp(f.ipDeny),
    auth_basic: f.authBasic,
    auth_user: f.authUser.trim() || null,
    // 口令只写不读：仅在本次填写了才提交（否则保留现有 htpasswd 文件，不误清）
    ...(f.authPass ? { auth_pass: f.authPass } : {}),
    lb_policy: f.lbPolicy,
    proxy_connect_timeout: f.proxyConnectTimeout,
    proxy_send_timeout: f.proxySendTimeout,
    proxy_read_timeout: f.proxyReadTimeout,
    log_access: f.logAccess,
    log_error: f.logError,
    log_error_level: f.logErrorLevel,
    waf: wafPayload(f),
  }
}

/**
 * 表单规格的本地指纹：供视图判断「本次编辑是否改了影响配置的字段」
 * （决定手动维护站点保存前是否弹二选一）。
 *
 * ⚠ 字段清单与后端 `deploy_fingerprint`（panel-api/routes/sites.rs）保持一致——
 *   两边新增「影响 render 输出」的字段时必须同步加，否则该字段改动不触发保存时
 *   弹窗（兜底：后端 conf_stale 仍会把它标成「未同步」，属事后提醒而非漏报）。
 */
export function confSpecNow(f: SiteForm): string {
  return JSON.stringify([
    f.name.trim(),
    f.domains.trim(),
    f.root.trim(),
    f.kind,
    !!f.spa,
    f.upstreams.split(/[,\s]+/).filter(Boolean),
    f.fpm.trim(),
    f.redirectTarget.trim(),
    f.redirectCode,
    f.wafOn,
    f.wafProfile,
    f.wafRate,
    f.wafBurst,
    f.routes.map(rowToRoute),
    // 019：片段也是渲染输出的一部分（插在 server 块尾）——不进指纹的话，手动站点
    // 只改片段后保存不会弹二选一、磁盘文件静默不动（后端 018 起指纹同款含它）。
    f.customConf,
    // 高级配置（020）：同样改变渲染输出，漏了就不会弹「未同步」二选一
    f.wwwRedirect,
    f.tlsProfile,
    f.tlsMin,
    f.hsts,
    f.hstsMaxAge,
    f.hstsSub,
    f.hstsPreload,
    f.rewritePreset,
    f.rewriteCustom,
  ])
}

/**
 * 表单状态 + 应用模板 + 多路由行编辑。
 *
 * @param opts.onFieldChanged 某字段的值被本模块改写后的回调——视图据此撤掉该字段的
 *   红字提示（问题正在被修，不该继续吓人）。本模块刻意不认识「错误」这个概念。
 */
export function useSiteForm(opts: { onFieldChanged?: (key: string) => void } = {}) {
  const auth = useAuthStore()

  const form = ref(emptyForm())

  /** 当前选中的应用模板 key；空串 = 未用模板（自定义后端） */
  const appTpl = ref('')
  /** 上一次由模板写进 `upstreams` 的值——用于判断用户是否手改过（手改过就不再覆盖） */
  const tplFilled = ref('')
  /** 已安装的运行时包名集合（仅在 runtimeDetectable 为真时有意义） */
  const runtimeInstalled = ref<Set<string>>(new Set())
  /** 运行时检测是否可用：需 package.install 能力位 + package.manage 权限点，缺一即失败 */
  const runtimeDetectable = ref(false)
  /** 是否已尝试探测过（避免每次打开弹窗都发一次请求） */
  const runtimeProbed = ref(false)
  const curTpl = computed(() => APP_TEMPLATES.find(t => t.key === appTpl.value) ?? null)
  /** 选中的模板其运行时**未安装**——用于把该 chip 与提示标成警示色 */
  const tplRuntimeMissing = computed(() => {
    const t = curTpl.value
    return !!(t && t.runtimePkg && runtimeDetectable.value && !runtimeInstalled.value.has(t.runtimePkg))
  })

  /**
   * 拉运行时安装状态，只为在模板提示里显示「已装 / 未装」。
   *
   * 双重门控：能力位 `package.install`（决定枚举端点是否可用）+ 权限点 `package.manage`
   * （后端 packages_list 正是按它签发的）——两者分属**两套命名空间**，写错不会报错、
   * 只会静默 disable（守卫 ci/check-permissions.sh）。
   * 失败**静默降级**：这只是锦上添花的提示，不该影响站点编辑主流程。
   *
   * ⚠ **口径是「包管理器里的系统包」**（apt 的 `nodejs` / `default-jdk`），**不等于**
   * 「这台机器上有没有 Node」——用 nvm / 官方安装包装好的运行时不在这里出现
   * （实测本机 `PATH` 有 node 22 而 apt 未装 nodejs）。故文案一律写「系统包 xxx 未装」，
   * 不做「你没有 Node」这种断言；`runtimePkg: null` 的语言干脆不显示状态。
   */
  async function probeRuntime() {
    if (runtimeProbed.value) return
    runtimeProbed.value = true
    if (!auth.enabled(CAP.PACKAGE_INSTALL, 'package.manage')) return
    try {
      const r = await api.get<{ packages: PackageInfo[] }>(API.packages.list())
      runtimeInstalled.value = new Set((r.packages ?? []).map(x => x.name))
      runtimeDetectable.value = true
    } catch { runtimeDetectable.value = false }
  }

  /**
   * 复位应用模板选中态。每次打开弹窗都要做——否则上次的选择会残留在下一次新建里。
   */
  function resetTemplate() {
    appTpl.value = ''
    tplFilled.value = ''
  }

  /**
   * 套用应用模板：把反代目标预填为 `http://127.0.0.1:<port>`。
   *
   * **刻意不覆盖用户手输的内容**——只在「后端」为空、或仍等于上次由模板写入的值时才填。
   * 否则用户先手填了 `http://10.0.0.5:9000` 再点一下模板，输入就被静默吞掉（很难发现）。
   * 再点一次同一个 chip 表示取消选择。
   */
  function useTemplate(t: AppTemplate) {
    if (appTpl.value === t.key) { resetTemplate(); return }
    const cur = form.value.upstreams.trim()
    if (cur === '' || cur === tplFilled.value) {
      const v = `http://127.0.0.1:${t.port}`
      form.value.upstreams = v
      tplFilled.value = v
    }
    appTpl.value = t.key
    opts.onFieldChanged?.('upstreams')
  }

  /**
   * 编辑已有站点时，若其后端**恰好**是某个模板的默认端口，就把该模板点亮——
   * 让用户一眼看出"这是个 Node 应用"，不必回想当初选了什么。
   * 只在「单一后端且完全匹配」时命中，多后端（负载均衡）不强猜。
   */
  function detectTemplateFromUpstreams() {
    const list = form.value.upstreams.split(/[,\s]+/).filter(Boolean)
    if (list.length !== 1) return
    const hit = APP_TEMPLATES.find(t => list[0] === `http://127.0.0.1:${t.port}`)
    if (hit) appTpl.value = hit.key
  }

  /**
   * 新增一条路由。前缀给一个**不与现有重复**的默认值（`/api`、`/api2`…），
   * 免得用户点一下就撞上「前缀重复」报错还要自己想名字。
   */
  function addRoute() {
    const used = new Set(form.value.routes.map((r) => r.prefix.trim()))
    let p = '/api'
    for (let i = 2; used.has(p) && i < 50; i++) p = `/api${i}`
    form.value.routes.push(newRoute(p, 'proxy'))
  }

  /** 删除一条路由。**至少保留一条**——空表无法保存，且用户多半只是想改不是想删光。 */
  function removeRoute(i: number) {
    if (form.value.routes.length <= 1) return
    form.value.routes.splice(i, 1)
  }

  return {
    form,
    appTpl,
    curTpl,
    tplRuntimeMissing,
    runtimeDetectable,
    probeRuntime,
    resetTemplate,
    useTemplate,
    detectTemplateFromUpstreams,
    addRoute,
    removeRoute,
  }
}
