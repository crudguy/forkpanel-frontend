<script setup lang="ts">
/**
 * 站点「新建 / 编辑」弹窗（含 SSL 证书区与日志区）。
 *
 * 从 SitesView 拆出来的边界：
 * - **只做「一个站点」的事**：表单回填 / 校验 / 保存下发 / SSL 签发续期删除 / 站点日志 /
 *   配置原文，全部是自成一体的动作，触发点也都在弹窗内（配置原文另归 SiteConfPanel）。
 * - **列表归父级**：批量操作、行内删除/重载、列显隐、检索都在 SitesView。
 * - 表单状态与后端对齐语义在 @/composables/useSiteForm；列治理在 useSiteColumns；
 *   能力 / 权限判定在 useSiteCaps（列表与弹窗共用同一份，避免两边各写一套后漂移）。
 *
 * ⚠️ 两个**双入口**动作决定了它们必须留在本组件而不是各自独立成组件：
 * - SSL 签发：列表行「证书」按钮与弹窗内「申请证书」都能触发。它对外的出口是
 *   `defineExpose({ applySsl })`——父级拿模板 ref 直接调用。证书弹窗本身是**独立于
 *   `open` 的顶层浮层**：列表入口触发时本弹窗并未打开，若把它放进 `v-if="open"`
 *   的块里，那条路径会静默失效（编译/类型全绿，只有运行时点了没反应）。
 * - 保存二选一（手动维护站点）：它是保存流程的一步，跟着 save() 走。
 *
 * ⚠️ 表单初始化由本组件**自持**（`watch(() => props.open)`）：父级 openEdit 里调
 *   子组件方法是行不通的——DOM 更新是异步的，那一刻子组件还没挂载。
 */
import { ref, computed, nextTick, watch } from 'vue'
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'
import { api, errorText, errorFieldDetail, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import {
  certLevel, certSourceLabel, fmtDate, fmtDateTime,
  type Cert, type RenewSweep, type Site,
} from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import InlineRemark from '@/components/InlineRemark.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import DirectoryPickerDialog from '@/components/DirectoryPickerDialog.vue'
import SiteConfPanel from '@/components/SiteConfPanel.vue'
import { useSiteCaps } from '@/composables/useSiteCaps'
import {
  APP_TEMPLATES, BACKEND_FIELD, DOMAIN_RE, SITE_NAME_RE, applyBody, confSpecNow,
  emptyForm, fieldMsg, newRoute, useSiteForm, type RouteRow,
} from '@/composables/useSiteForm'

const props = defineProps<{
  open: boolean
  /** 正在编辑的站点；null = 新建 */
  site: Site | null
  /** 全量证书（本组件按当前站点域名自行过滤） */
  certs: Cert[]
  /** 自动续期扫描状态（证书区展示「上次/下次扫描」） */
  sweep: RenewSweep
  /** 站点托管根目录（后端只读下发）：目录选择器的初始定位与边界说明 */
  siteRoot: string
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  /** 需要父级刷新列表：`silent` 用于配置区这类不该闪 loading 的场合 */
  reload: [boolean]
  /** 归属不到本弹窗的错误（列表行触发的证书操作失败等）→ 父级页面级错误条 */
  'page-error': [string]
}>()

// 能力 / 权限：与列表共用 useSiteCaps，同一条规则只有一份
const {
  canManage, canSsl, webSupported, isCaddy, webName, caddyNoop,
  sslSupported, selfSignedSupported, sslReady, sslHint, isOwner,
} = useSiteCaps()

// 表单状态（含多路由行、应用模板）与后端对齐语义在 @/composables/useSiteForm。
// 传 `onFieldChanged` 让模板预填后本组件能撤掉该字段的红字——表单模块刻意不认识
// 「错误」这个概念，错误归弹窗管。
const {
  form, appTpl, curTpl, tplRuntimeMissing, runtimeDetectable,
  probeRuntime, resetTemplate, useTemplate, detectTemplateFromUpstreams, addRoute, removeRoute,
} = useSiteForm({ onFieldChanged: clearFieldErr })

/** 弹窗内的**非字段**错误（网络失败 / 服务端异常等，归属不到某个输入框）。 */
const formError = ref('')
/** 弹窗内的**字段级**错误：键 = 表单字段名，值 = 给用户看的中文说明。 */
const fieldErrs = ref<Record<string, string>>({})
/**
 * 错误序号：每次保存失败自增，用作错误条的 `:key`。
 * 元素因此被重建，「抖动」动画才能**重复播放**——否则同一文案下 v-if 恒为 true、
 * 元素不重建，动画只播一次，用户连点「保存」得不到任何新反馈。
 */
const errSeq = ref(0)
const busy = ref(false)
/** 子组件（配置区）请求递增错误序号（错误条重建 → 抖动动画重播）。 */
function bumpErr() { errSeq.value++ }

/** 当前编辑的站点（null = 新建）。由 initForm 从 props.site 取值。 */
const editing = ref<Site | null>(null)

/**
 * 打开弹窗时按「编辑 / 新建」初始化表单。
 *
 * ⚠️ 必须由本组件 watch `open` 自持，不能由父级调用：DOM 更新是异步的，父级
 * openEdit 里调子组件方法时它还没挂载（SiteConfPanel 已踩过一次）。
 */
function initForm(s: Site | null) {
  editing.value = s
  // 清掉上一次遗留的报错：否则上次保存失败的红条会在重新打开弹窗时**立即**出现，
  // 让人误以为这次什么都还没提交就已经出错了。
  formError.value = ''
  fieldErrs.value = {}
  saveAsk.value = false
  if (!s) {
    form.value = emptyForm()
    resetTemplate()
    void probeRuntime()
    return
  }
  form.value = {
    ...emptyForm(),
    name: s.name, domains: s.domains.join(', '), root: s.root, enabled: s.enabled,
    // 类型**从站点真实值预填**。此前写死 'static'，于是「编辑反代站 → 应用」
    // 会把它静默改写成静态站（后端当时也没存真实类型，两侧一起错）。
    kind: ['proxy', 'php', 'redirect', 'routed'].includes(s.kind) ? s.kind : 'static',
    // 多路由回填：后端已校验并归一化过（末尾 / 已去重），可直接编辑。
    // 兜底缺失时补一条——正常不会发生（写入方已拦），但避免打开就是空表无从下手。
    routes: s.kind === 'routed' && (s.routes ?? []).length
      ? (s.routes ?? []).map((r): RouteRow => ({
          prefix: r.prefix,
          kind: r.kind,
          upstreams: (r.upstreams ?? []).join(', '),
          spa: !!r.spa,
          fpm: r.fpm ?? '',
          frontController: r.front_controller ?? '',
          root: r.root ?? '',
        }))
      : [newRoute('/', 'static')],
    // 后端已把 upstreams/fpm 落库（migration 009），编辑时回填真实值：
    // 否则编辑反代/PHP 站再应用，后端配置会被静默清空。
    upstreams: (s.upstreams ?? []).join(', '),
    fpm: s.fpm ?? '',
    // SPA 回退仅 static 类型有意义：编辑时回填真实值，其余类型恒 false。
    spa: s.kind === 'static' && s.spa,
    // 整站重定向：编辑时回填目标 URL 与状态码（kind=redirect 时才有意义）。
    redirectTarget: s.redirect_target ?? '',
    redirectCode: s.redirect_code ?? 301,
    wafOn: s.waf_enabled,
    wafProfile: s.waf_profile ?? 'basic',
    wafRate: s.waf_rate_per_sec ?? 0,
    wafBurst: s.waf_burst ?? 0,
    // 自定义片段回填（019）：null / 缺失一律落空串，textarea 里就是干净的空白。
    customConf: s.custom_conf ?? '',
    // 高级配置回填（020）：库里都有 DEFAULT，缺失时回落到与后端相同的默认值
    wwwRedirect: s.www_redirect || 'off',
    tlsProfile: s.tls_profile || 'modern',
    tlsMin: s.tls_min || 'TLSv1.2',
    hsts: !!s.hsts,
    hstsMaxAge: s.hsts_max_age ?? 300,
    hstsSub: !!s.hsts_include_sub,
    hstsPreload: !!s.hsts_preload,
    rewritePreset: s.rewrite_preset || 'none',
    rewriteCustom: s.rewrite_custom ?? '',
    // 访问控制 / 反代增强 / 站点日志（021）回填：库里都有 DEFAULT，缺失时回落到与后端相同的默认值
    ipAllow: (s.ip_allow ?? []).join(', '),
    ipDeny: (s.ip_deny ?? []).join(', '),
    authBasic: !!s.auth_basic,
    authUser: s.auth_user ?? '',
    authPass: '', // 口令只写不读，永不回填
    lbPolicy: s.lb_policy || 'least_conn',
    proxyConnectTimeout: s.proxy_connect_timeout ?? 60,
    proxySendTimeout: s.proxy_send_timeout ?? 60,
    proxyReadTimeout: s.proxy_read_timeout ?? 60,
    logAccess: !!s.log_access,
    logError: !!s.log_error,
    logErrorLevel: s.log_error_level || 'error',
    // 对象说明回填（022）
    remark: s.remark ?? '',
  }
  // 反推模板选中态：后端是 3000/8080/8000/5000 就点亮对应 chip（仅供辨识，不改数据）
  resetTemplate()
  detectTemplateFromUpstreams()
  void probeRuntime()
  // 表单规格基线：保存时据此判断「本次是否改了影响配置的字段」（手动维护站点要弹二选一）。
  confSpecBase.value = confSpecNow(form.value)
}

watch(() => props.open, (v) => { if (v) initForm(props.site) })

// 自动续期扫描状态摘要：供编辑弹窗内 SSL 区展示"上次/下次扫描"
function sweepSummary(): string {
  const s = props.sweep
  if (!s.last_at) return '尚未运行 · 每日约 04:05 自动扫描'
  const fmt = (t: number) => fmtDateTime(t)
  const queued = s.last_queued > 0 ? ` · 上次入队 ${s.last_queued} 张` : ''
  return `上次 ${fmt(s.last_at)} · 下次约 ${fmt(s.next_at)}${queued}`
}
// ── 新建 / 编辑弹窗 ──
/** 根目录选择器（复用 /files/list 在服务器浏览目录树）。 */
const pickerOpen = ref(false)
function onPickRoot(p: string) {
  form.value.root = p
  pickerOpen.value = false
}
// 路由级根目录选择器：记录当前编辑的路由下标（站点级用 pickerOpen/onPickRoot）。
// 同一时刻只能开一个 DirectoryPickerDialog，站点级与路由级互斥（不会同时开）。
const routePickerIdx = ref(-1)
const routePickerOpen = ref(false)
function openRouteRootPicker(i: number) {
  routePickerIdx.value = i
  routePickerOpen.value = true
}
function onPickRouteRoot(p: string) {
  if (routePickerIdx.value >= 0) form.value.routes[routePickerIdx.value].root = p
  routePickerOpen.value = false
  routePickerIdx.value = -1
}
// 站点编辑弹窗统一行为：Esc 关闭 + 焦点陷阱（审计 U1）
const modalBox = ref<HTMLElement | null>(null)
// 编辑弹窗全屏 + 左侧分段导航（2026-10-11，B 方案）：导航 rail 平滑滚动到对应分区，
// 滚动时高亮当前分区；打开弹窗时复位到顶部与首个分区。
const modalBody = ref<HTMLElement | null>(null)
// 段名必须**如实**对应段内实际内容：此前「安全与性能」里塞着自定义片段、www 跳转、
// 伪静态这类「站点行为」项，「日志与证书」里塞着整块 Nginx 原文与历史版本——
// 名字与内容不符，找东西只能靠猜。
const navSections = [
  { id: 'sec-basic', label: '基础' },
  { id: 'sec-routing', label: '路由与后端' },
  { id: 'sec-secure', label: '安全与高级' },
  { id: 'sec-ops', label: '日志 · 证书 · 原文' },
] as const
/** 表单字段 → 所属分区。仅用于把字段级错误映射回导航 rail（见 secErrs）。 */
const FIELD_SEC: Record<string, string> = {
  name: 'sec-basic', domains: 'sec-basic', root: 'sec-basic',
  upstreams: 'sec-routing', fpm: 'sec-routing',
  redirectTarget: 'sec-routing', redirectCode: 'sec-routing', routes: 'sec-routing',
  wafProfile: 'sec-secure', wafRate: 'sec-secure', wafBurst: 'sec-secure',
  customConf: 'sec-secure', authUser: 'sec-secure', authPass: 'sec-secure',
}
/** 分区是否有字段级错误：rail 上对应项亮红点，用户切到别的分区后仍知道哪儿没改对。 */
const secErrs = computed<Record<string, boolean>>(() => {
  const m: Record<string, boolean> = {}
  for (const k of Object.keys(fieldErrs.value)) {
    const s = FIELD_SEC[k]
    if (s) m[s] = true
  }
  return m
})
const activeSec = ref<string>('sec-basic')
function scrollToSec(id: string) {
  const body = modalBody.value
  if (!body) return
  const el = body.querySelector<HTMLElement>('#' + id)
  if (!el) return
  body.scrollTo({ top: Math.max(0, el.offsetTop - 14), behavior: 'smooth' })
  activeSec.value = id
}
function onBodyScroll() {
  const body = modalBody.value
  if (!body) return
  const top = body.scrollTop + 28
  let cur: string = navSections[0].id
  for (const s of navSections) {
    const el = body.querySelector<HTMLElement>('#' + s.id)
    if (el && el.offsetTop <= top) cur = s.id
  }
  activeSec.value = cur
}
watch(() => props.open, (v) => {
  if (!v) return
  nextTick(() => {
    modalBody.value?.scrollTo({ top: 0 })
    activeSec.value = 'sec-basic'
  })
})
// 统一关闭出口（离场动画 + 焦点返还）：X / 点遮罩 / 取消按钮 / Esc 都走它
const { close: modalClose } = useModal(() => props.open, modalBox, closeModal)
/** 对象说明（备注，022）：便签式内联保存，独立于大表单——保存站点要走 nginx
 *  校验与下发，一句备注不该拖住整张表单。仅编辑已有站点时可用（新建尚无 id）。 */
async function saveRemark(v: string) {
  if (!editing.value) return
  await api.patch(API.sites.remark(editing.value.id), { remark: v })
  form.value.remark = v
  editing.value.remark = v
}
function closeModal() {
  emit('update:open', false); editing.value = null
  // 关闭即清理：下次打开弹窗一定是干净的，不会"什么都还没提交就顶着上次的红条"。
  formError.value = ''; fieldErrs.value = {}
}
/** 用户一改动该字段就撤掉它的红字提示：问题正在被修，不该继续吓人。 */
function clearFieldErr(key: string) {
  if (fieldErrs.value[key]) delete fieldErrs.value[key]
}
/**
 * 把出问题的字段滚进视野。用 `nearest`——**已在视野内则纹丝不动**，
 * 只有真的看不见时才最小幅度滚动，避免"错误一出现页面就跳"。
 */
function revealField(key: string) {
  nextTick(() => {
    modalBox.value?.querySelector<HTMLElement>(`[data-f="${key}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}
/**
 * 保存站点 = ① 写数据模型 ② 下发配置（环境支持时）。
 *
 * 这两步与后端的职责划分一一对应：`create`/`patch` 管 `sites` 表（`patch` 还负责
 * `enabled` 的**真同步**：停用=摘配置+reload），`apply` 管渲染下发。
 * 此前它们被拆成页面上两个卡片（顶部「应用站点配置」+ 本弹窗），字段重复、
 * 同一份信息要填两遍，且「新建」按钮建出来的站点还得再去顶部点一次应用才能访问
 * ——现在合并为：**保存即下发**。SSL 证书管理同理并入本弹窗（见下方 .ssl 区块）。
 */
async function save() {
  busy.value = true; formError.value = ''; fieldErrs.value = {}
  const name = form.value.name.trim()
  const domains = form.value.domains.split(/[,\s]+/).filter(Boolean)
  try {
    // ── 前置校验：**逐字段收集**，而非抛出第一个就中断 ──
    // 好处有二：① 一次把所有问题都标出来，用户改一轮即可；② 每条都挂在**对应输入框旁**
    // （靠模板上的 data-f 定位），"域名错就提示在域名处、根目录错就提示在根目录处"，
    // 而不是所有错误统一堆在弹窗底部、让用户自己去猜哪个框填错了。
    const errs: Record<string, string> = {}
    if (!name) errs.name = '请填写站点名称'
    else if (!SITE_NAME_RE.test(name)) errs.name = '名称需以字母或数字开头，只能含字母、数字、. _ -，长度 1~63'
    if (!domains.length) errs.domains = '至少需要填写一个域名'
    else {
      for (const d of domains) {
        if (!DOMAIN_RE.test(d.toLowerCase())) {
          errs.domains = `域名「${d}」格式不正确：需至少两级，如 example.com`
          break
        }
      }
    }
    if (webSupported.value) {
      // 目标值的必填校验。proxy/php 的目标会**直接进 nginx 配置文本**，注入校验在后端；
      // 这里只做"别把空值递上去"的提示，不做安全判断（前端判断等于没有判断）。
      if (form.value.kind === 'proxy' && !form.value.upstreams.trim()) errs.upstreams = '反向代理需要填写至少一个后端地址'
      if (form.value.kind === 'php' && !form.value.fpm.trim()) errs.fpm = 'PHP 站点需要填写 php-fpm 目标'
      if (form.value.kind === 'redirect') {
        const t = form.value.redirectTarget.trim()
        if (!t) errs.redirectTarget = '整站重定向需要填写目标 URL'
        else if (!/^https?:\/\/\S+/i.test(t)) errs.redirectTarget = '目标 URL 必须以 http:// 或 https:// 开头'
      }
      if (form.value.kind === 'routed') {
        // 逐条收集（与整体校验同风格：一次把所有问题标出来，而不是抛第一个就中断）
        const rs = form.value.routes
        if (!rs.length) errs.routes = '至少需要一条路由'
        else {
          const seen = new Set<string>()
          for (let i = 0; i < rs.length; i++) {
            const r = rs[i]
            const p = r.prefix.trim()
            if (!p.startsWith('/')) { errs.routes = `第 ${i + 1} 条路由的前缀「${r.prefix}」必须以 / 开头`; break }
            if (seen.has(p)) { errs.routes = `路由前缀「${p}」重复`; break }
            seen.add(p)
            if (r.kind === 'proxy' && !r.upstreams.trim()) { errs.routes = `第 ${i + 1} 条路由（${p}）的反代需要后端地址`; break }
            if (r.kind === 'php') {
              if (!r.fpm.trim()) { errs.routes = `第 ${i + 1} 条路由（${p}）需要 php-fpm 目标`; break }
              if (!r.frontController.trim().startsWith('/')) {
                errs.routes = `第 ${i + 1} 条路由（${p}）的入口脚本必须以 / 开头（如 /public/index.php）`; break
              }
            }
          }
          if (!errs.routes && !seen.has('/')) errs.routes = '必须有一条前缀为 / 的兜底路由（否则漏掉的路径会落到别的站点）'
        }
      }
      // 自定义片段（019）：前端只挡「明知超限还提交」的必然失败；owner 判定与
      // 64 KiB 的权威校验仍在后端（前端判断不等于后端校验）。非 owner 不发送该字段。
      if (isOwner.value && form.value.customConf.trim()
        && new TextEncoder().encode(form.value.customConf).length > 64 * 1024) {
        errs.customConf = '自定义片段超过 64 KiB 上限（原始配置文本按字节计）'
      }
      // 访问控制（021）：Basic Auth 开启时必须填用户名；新站点首次开启还需口令
      if (form.value.authBasic) {
        const u = form.value.authUser.trim()
        if (!u) errs.authUser = '开启 Basic Auth 必须填写用户名'
        else if (u.includes(':') || /\s/.test(u)) errs.authUser = '用户名不能含冒号或空白'
        else if (!editing.value && !form.value.authPass) errs.authPass = '新站点首次开启 Basic Auth 需设置口令'
      }
    }
    const firstBad = Object.keys(errs)[0]
    if (firstBad) {
      fieldErrs.value = errs
      errSeq.value++             // 红字重建 → 抖动动画重播：连点保存也总有可见反馈
      revealField(firstBad)      // 把第一个出错的字段（含其红字）滚进视野
      return
    }
    // 手动维护站点：apply 不会自动更新磁盘配置（后端整段跳过渲染/下发）。若本次动了
    // 影响配置的字段（或站点此前已未同步），先弹二选一——默默跳过就是制造
    // 「面板显示 A、nginx 实际 B」的静默分叉（as11 真实踩过，017 迁移为它而立）。
    // ⚠ 判定源必须「实时 + 快照」双取：confManual / confStale 是配置区本次会话的
    //   实时状态（loadConf、保存配置后即刻更新），editing.* 是打开弹窗时的列表快照。
    //   曾只用快照：同一会话内先「保存配置」转手动、再改 WAF 保存，快照里 manual
    //   仍是 false → 不弹二选一、静默入库（实测复现）——正是 017 要消灭的分叉。
    if (
      (confManual.value || editing.value?.manual_conf) &&
      form.value.enabled &&
      (confStale.value || editing.value?.conf_stale || confSpecChanged())
    ) {
      saveAsk.value = true
      return
    }
    await commitSave(false)
  } catch (e) {
    mapSaveError(e)
  } finally { busy.value = false }
}

/** 保存失败的统一落点（本次保存 + 二选一续跑共用同一套字段映射与抖动反馈）。 */
function mapSaveError(e: unknown) {
  // **能定位到字段就挂在字段旁**；定位不到（网络/服务端异常）才用通用错误条。
  const fd = errorFieldDetail(e)
  if (fd) {
    const m = BACKEND_FIELD[fd.field]
    if (m) {
      fieldErrs.value = { [m.key]: fieldMsg(m.msg, fd.reason) }
      revealField(m.key)
    } else {
      formError.value = fieldMsg('提交内容有误，请检查后重试', fd.reason)
    }
  } else if ((e as { code?: number } | null)?.code === 50001) {
    // 50001 = 路径越界。本表单里唯一的路径输入就是根目录，落到它旁边。
    fieldErrs.value = { root: errorText(e) }
    revealField('root')
  } else {
    formError.value = errorText(e)
  }
  // 递增序号：错误条被重建 → 抖动动画重播，用户连点保存每次都得到可见反馈。
  errSeq.value++
}

/**
 * 校验通过后的实际保存：patch/create 落库 + apply 下发。
 *
 * `regenerate=true` 仅对「手动维护」站点有意义：按当前表单重新渲染并覆盖手写配置
 * （后端 regen_conf；覆盖前自动备份），站点恢复为面板托管、「未同步」解除。
 * 「仅保存」（false）时后端保持文件不动——若与表单分叉，后端会标记为「未同步」。
 */
async function commitSave(regenerate: boolean) {
  const name = form.value.name.trim()
  const domains = form.value.domains.split(/[,\s]+/).filter(Boolean)
  const root = form.value.root.trim() || undefined
  // regen 只对手动维护站点传递（其余站点后端会忽略，但不发明无用参数）。
  // ⚠ 与 save() 的弹窗判定同源：必须「实时（confManual）+ 快照（editing）」双取——
  //   同一会话内刚「保存配置」转手动时列表快照还是旧值，只查快照会漏传 regen_conf，
  //   用户点了「按表单重新生成」却实际不生成（静默失效）。
  const regen = regenerate && (confManual.value || editing.value?.manual_conf === true)
  // ① 数据模型。新建走 create（它能确立初始 enabled），编辑走 patch（它负责启停真同步）。
  if (editing.value) {
    // name 一并提交：后端 patch 自本次起支持改名（nginx 配置按域名派生、
    // root 已是绝对路径、证书按 domain，改名都不影响，也不会重新下发配置）
    await api.patch(API.sites.patch(editing.value.id), { name, domains, root, enabled: form.value.enabled })
  } else {
    await api.post(API.sites.create(), { name, domains, root, enabled: form.value.enabled })
  }
  // ② 下发。**停用态也照样调 apply**——它只落库不下发（与后端「停用守恒」一致），
  //    但类型 / 反代后端 / php-fpm / WAF 只有 apply 才会写进库。
  let msg: string
  if (webSupported.value) {
    const r = await deploy(name, domains, regen)
    msg = r && r.regenerated
      // 本次按表单重新生成：覆盖了手写配置（覆盖前已备份；备份失败也如实说）
      ? `已保存站点 ${name}：已按表单重新生成配置并覆盖磁盘文件${r.backup ? '（原配置已自动备份）' : '（注意：原配置备份失败，审计日志已记录）'}`
      : r && r.manual
        // 手动维护 + 选了「仅保存」：表单照常入库，磁盘配置**刻意不动**。
        // 只说"已保存"等于撒谎——要讲清"配置没改、以及怎么同步"。
        ? `已保存站点 ${name}：该站点为「手动维护」——表单改动已入库，配置文件未覆盖（如需同步到配置，请用配置区「按表单重新生成」）`
        : r && r.deployed === false
          ? `已保存站点 ${name}：当前为停用状态，配置已登记但未下发`
          : `已保存站点 ${name} 并下发配置`
  } else {
    msg = `已保存站点 ${name}（未接入 Web 服务器：仅登记，未下发）`
  }
  // 成功提示走浮层 toast（脱离文档流）：写成页面级 notice 会把下方内容整体下推，
  //   每次保存页面都抖一下，观感不稳——这正是本次改 toast 的原因。
  closeModal(); emit('reload', false); toast(msg)
}

/** 二选一后继续保存（「按表单重新生成」与「仅保存」两个动作按钮的落点）。 */
async function resumeSave(regenerate: boolean) {
  saveAsk.value = false
  busy.value = true
  try {
    await commitSave(regenerate)
  } catch (e) {
    mapSaveError(e)
  } finally { busy.value = false }
}

/**
 * 渲染并下发站点配置（「保存站点」的第二步；受 webserver 能力门禁）。
 *
 * 与列表行「重载」的区别：重载只是让 nginx 重读**磁盘上已有的**配置，不会重新渲染；
 * 改了域名 / 类型 / WAF 后必须走这里才会生效。
 */
async function deploy(name: string, domains: string[], regenerate = false) {
  // 响应字段供 commitSave 如实提示：
  // - manual（本站点处于「手动维护」，本次**未**重渲染/下发）
  // - regenerated/backup（本次选了「按表单重新生成」：已覆盖手写配置 + 备份路径，可 null）
  return api.post<{ deployed?: boolean; manual?: boolean; regenerated?: boolean; backup?: string | null }>(
    API.sites.apply(),
    applyBody(form.value, { name, domains, regenerate, includeCustomConf: isOwner.value }),
  )
}
// ── 站点日志（021）：查看 / 清空 ──
/** 查看日志：浏览器新标签打开下载端点（text/plain 直接渲染/下载）。 */
function viewLog(kind: 'access' | 'error') {
  if (!editing.value) return
  window.open(API.sites.logDownload(editing.value.id, kind), '_blank', 'noopener')
}
/** 清空日志（截断而非删除）：先弹内联二次确认（避免误清空），确认后 POST。 */
const clearAsk = ref<'access' | 'error' | null>(null)
async function clearLog(kind: 'access' | 'error') {
  if (!editing.value) return
  clearAsk.value = kind
}
async function confirmClear() {
  const kind = clearAsk.value
  clearAsk.value = null
  if (!kind || !editing.value) return
  // ⚠️ 清空日志发生在**编辑弹窗内**，错误绝不能写页面级 error——那行提示在 .mask 之后，
  //    用户只会看到"点了确认没反应"。走 formError（弹窗顶部吸顶条）。
  busy.value = true; formError.value = ''
  try {
    await api.post(API.sites.logClear(editing.value.id), { kind })
    toast(kind === 'access' ? '访问日志已清空' : '错误日志已清空')
  } catch (e) { formError.value = errorText(e); errSeq.value++ }
  finally { busy.value = false }
}
// ── SSL：证书管理已并入「编辑站点」弹窗 ──
/** 编辑弹窗内展示「当前站点」的证书：按域名过滤全局证书列表（证书以 domain 归属站点）。 */
const siteCerts = computed<Cert[]>(() =>
  editing.value ? props.certs.filter(c => (editing.value as Site).domains.includes(c.domain)) : [])

/** SSL 签发弹窗（审计 U6：替代 window.prompt 选方式/填邮箱）。 */
const sslModal = ref<{ site: Site; method: 'self-signed' | 'http-01'; email: string } | null>(null)
/**
 * 签发弹窗**自己**的错误位。
 *
 * 签发弹窗是叠在站点弹窗之上的第二层遮罩，此时页面级的 error/notice 会被两层遮罩
 * 挡在后面——用户什么都看不见，只看到点「申请」没反应。所以这一层的报错必须落在
 * 它自己的可见区域里。
 */
const sslErr = ref('')

/** 根证书安装指引弹窗。自签证书能被浏览器信任的**唯一**前提是把根 CA 装进信任库。 */
const caHelp = ref(false)

// 另外两个弹窗同样接统一关闭出口（此前 CA 指引与 SSL 签发都只有点遮罩一种关法，
// 没有 Esc，也没有焦点返还）
const caBox = ref<HTMLElement | null>(null)
const { close: closeCaHelp } = useModal(() => caHelp.value, caBox, () => { caHelp.value = false })
const sslBox = ref<HTMLElement | null>(null)
const { close: closeSslModal } = useModal(() => !!sslModal.value, sslBox, () => { sslModal.value = null })
/**
 * 下载面板根证书（ca.crt）。
 *
 * 用 location 直下而非 fetch——与 FilesView 下载同范式：GET + cookie 认证即可，
 * 不需要（也不能）带 CSRF 头，响应流交给浏览器原生处理（自动落到下载目录）。
 */
function downloadCa() {
  window.location.href = API.certs.ca()
}

/**
 * 把签发类错误放到**用户当下真正看得见的那一层**：签发弹窗 > 站点编辑弹窗 > 页面级。
 * 此前一律写页面级 error/notice，弹窗开着时全被遮罩挡在后面 → 表现为"点了没反应"。
 * `asNotice`：能力未接入（还没装上）属提示而非报错，改走中性 toast。
 * toast 是浮层、恒在遮罩之上，故不再需要"弹窗开着就降级到页面级"的分支。
 * ⚠️ 列表行「证书」按钮也走这条路径，那时本弹窗**没开**——错误只能交回页面级
 *   （父级），否则用户点列表的按钮、报错却永远看不见。
 */
function sslErrTo(msg: string, asNotice = false) {
  if (sslModal.value) { sslErr.value = msg; return }
  if (asNotice) { toast(msg, 'info'); return }
  if (props.open) { formError.value = msg; errSeq.value++ }
  else emit('page-error', msg)
}

/** 行内「SSL」快捷入口：直接开签发弹窗（仅一种渠道可用时立即执行，不给"必败选项"）。 */
function applySsl(s: Site) {
  if (!(selfSignedSupported.value && sslSupported.value)) {
    execSsl(s, selfSignedSupported.value ? 'self-signed' : 'http-01', '')
    return
  }
  sslErr.value = ''
  sslModal.value = { site: s, method: 'self-signed', email: '' }
}
/** 编辑弹窗内「申请证书」：作用对象即当前正在编辑的站点。 */
function applySslEditing() {
  if (editing.value) applySsl(editing.value)
}

async function execSsl(s: Site, method: 'self-signed' | 'http-01', email: string) {
  busy.value = true; sslErr.value = ''
  // ACME 必须有账户邮箱：CA 靠它发到期/异常通知，缺了就明确报错，不代填假地址
  if (method === 'http-01' && !email.trim()) {
    sslErrTo('ACME 签发需要账户邮箱')
    busy.value = false
    return
  }
  try {
    const r = await api.post<{ task_id?: string }>(
      API.sites.sslApply(s.id), { domains: s.domains, method, email: method === 'http-01' ? email.trim() : undefined })
    toast(method === 'self-signed'
      ? `已为 ${s.name} 签发面板自签证书（记得「重载」使配置生效）`
      : `已提交 ${s.name} 的 ACME 签发任务${r?.task_id ? `（${r.task_id}）` : ''}，可在任务中心查看进度`)
    sslModal.value = null
    if (method === 'self-signed') emit('reload', false)
  } catch (e) {
    // 能力未接入属于"还没装上"，沿用绿色提示语义；真出错才是红色。
    if (isUnsupported(e)) sslErrTo('当前环境未接入证书签发能力（需 openssl 或 ACME）', true)
    else sslErrTo(errorText(e))
  } finally { busy.value = false }
}

// ── 证书续期（自签同步 / ACME 任务化）/ 删除（纯数据操作）──
const delCert = ref<Cert | null>(null)
async function renewCert(c: Cert) {
  busy.value = true
  let ok = ''
  try {
    await api.post(API.certs.renew(c.id), {})
    ok = `已续期 ${c.domain} 的证书`
  } catch (e) {
    if (isUnsupported(e)) sslErrTo('当前环境未接入证书续期能力', true)
    else sslErrTo(errorText(e))
  } finally { busy.value = false; emit('reload', false); if (ok) toast(ok) }
}
async function setAutoRenew(c: Cert, val: boolean) {
  busy.value = true
  try {
    await api.patch(API.certs.autoRenew(c.id), { enabled: val })
    c.auto_renew = val
    toast(`${c.domain} 自动续期已${val ? '开启' : '关闭'}`)
  } catch (e) {
    if (isUnsupported(e)) sslErrTo('当前环境未接入 ACME，无法自动续期')
    else sslErrTo(errorText(e))
  } finally { busy.value = false }
}
async function doDeleteCert() {
  if (!delCert.value) return
  busy.value = true
  const dom = delCert.value.domain
  try {
    await api.del(API.certs.remove(delCert.value.id))
    delCert.value = null
    emit('reload', false)
    toast(`已删除证书 ${dom}`)
  } catch (e) {
    // 同 doDelete：失败必须关确认框，否则错误落在遮罩之后、表现为"点了没反应"
    delCert.value = null
    sslErrTo(errorText(e))
  } finally { busy.value = false }
}
// 站点「配置原文 + 历史版本与回滚」已抽成 <SiteConfPanel>：那段逻辑自带十余个独立
// 状态与 3 条写接口，且触发点全在块内，合在这里只是让找入口变难。
// 这里保留 `manual` / `stale` 两个开关——父级保存站点时要据此判断「手动维护站点的
// 表单改动会不会落盘」，决定是否弹「按表单重新生成」的二选一（见组件注释）。
const confManual = ref(false)
const confStale = ref(false)

/** 保存二选一弹窗：手动维护站点 + 表单改动了影响配置的字段（或已未同步） */
const saveAsk = ref(false)
/** 表单规格基线（openEdit 时快照）：判断「本次编辑是否改了影响配置的字段」 */
const confSpecBase = ref('')

/** 「保存手动维护的站点」二选一的说明文案（conf_stale 时点明现状）。 */
const saveAskLead = computed(() => {
  const n = editing.value?.name ?? '该站点'
  const why = confSpecChanged()
    ? '检测到表单中影响配置的字段有变更。'
    : '该站点此前已处于「未同步」状态（表单与磁盘配置不一致）。'
  return `「${n}」处于手动维护：「保存并应用」不会自动更新磁盘上的 Nginx 配置。${why}`
    + '「按表单重新生成」会用当前表单覆盖配置（原手动配置先自动备份）；'
    + '「仅保存」只把表单值入库、配置文件保持不变（站点会标记「未同步」）。'
})

/** 本次编辑是否改了影响配置的字段（基线在 openEdit 快照；新建站点恒 false）。 */
function confSpecChanged(): boolean {
  return confSpecBase.value !== '' && confSpecNow(form.value) !== confSpecBase.value
}

// 保存二选一弹窗的通用弹窗行为（Esc / 焦点陷阱 / 离场动画）——与全站弹窗同规。
const saveAskBox = ref<HTMLElement | null>(null)
const { close: closeSaveAsk } = useModal(() => saveAsk.value, saveAskBox, () => { saveAsk.value = false })

// 列表行「证书」按钮的入口：那时本弹窗没开，签发弹窗是独立顶层浮层，照样能弹。
defineExpose({ applySsl })

</script>

<template>
  <!-- ⚠️ 多个根元素**平级**：签发弹窗 / CA 指引 / 保存二选一都是浮层，绝不能嵌进
       主弹窗的 v-if 块内部（那样主弹窗一关它们就随宿主一起消失，且编译与类型检查
       全绿，只有运行时「点了没反应」）。 -->

  <!-- 新建 / 编辑弹窗 -->
  <div v-if="open" class="mask" @click.self="modalClose">
    <div ref="modalBox" class="modal wide site-modal" role="dialog" aria-modal="true">
      <!-- 标题行（公共 .modal-head，吸顶）里顺带承载通用错误条：只放**归属不到具体
           输入框**的错误。字段级错误各自挂在对应输入框旁（靠各 label 的 data-f 定位），
           不在这里重复——此前所有错误一律压在弹窗最底部，用户在中部滚动时点保存根本
           看不到，只能反复点。
           ⚠️ 错误条放在 head **内部**而不是做成另一个 sticky 元素：两个 sticky 都贴顶
           会互相盖住；放进同一容器则整体吸顶，也不需要估算 head 高度的魔法数字。
           `:key` 绑 errSeq：连点保存时元素重建，抖动动画得以重播，不会"点了没反应"。 -->
      <div class="modal-head">
        <h3 class="modal-title">{{ editing ? '编辑站点' : '新建站点' }}</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
        <p v-if="formError" :key="'fe' + errSeq" class="err-bar form-msg" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ formError }}</span>
        </p>
      </div>
    <div class="modal-mid">
      <nav class="nav-rail" aria-label="编辑分区">
        <button v-for="s in navSections" :key="s.id" type="button" class="nav-item"
          :class="{ active: activeSec === s.id, 'has-err': secErrs[s.id] }"
          :title="secErrs[s.id] ? '该分区内有字段未填对' : s.label"
          @click="scrollToSec(s.id)">{{ s.label }}<i v-if="secErrs[s.id]" class="nav-dot" aria-hidden="true" /></button>
      </nav>
      <div ref="modalBody" class="modal-body" @scroll="onBodyScroll">
      <!-- 未接入底座时：站点仍可登记，但配置下发不了。如实说明，不装作能开 -->
      <div v-if="!webSupported" class="hint-note is-warn">
        <Icon name="alert" :size="15" class="ic" />
        <span>未接入 Web 服务器：<b>只能保存站点登记信息，无法下发配置</b>；
          下方的类型 / 反代 / PHP / WAF 也需底座才能生效。</span>
      </div>
      <section class="sector" id="sec-basic">
        <h4 class="sector-h">基础信息</h4>
      <label class="blk" :class="{ 'has-err': fieldErrs.name }" data-f="name"
        title="站点标识，用作配置文件名与默认目录；仅小写字母、数字、连字符（如 my-site）">名称
        <input v-model="form.name" placeholder="my-site" :aria-invalid="!!fieldErrs.name"
          @input="clearFieldErr('name')" />
        <span v-if="fieldErrs.name" :key="'name' + errSeq" class="field-err">{{ fieldErrs.name }}</span>
      </label>
      <label class="blk"
        title="单路由=整站一种处理方式；多路由=按 URL 前缀分派到不同后端或目录">类型
        <select v-model="form.kind" :disabled="!webSupported">
          <option value="static">静态</option>
          <option value="proxy">反向代理 / 负载均衡</option>
          <option value="php">PHP (php-fpm)</option>
          <option value="redirect">整站重定向</option>
          <option value="routed">多路由（按前缀分派）</option>
        </select>
      </label>
      <label class="blk full" :class="{ 'has-err': fieldErrs.domains }" data-f="domains"
        title="可填多个，逗号分隔；须解析到本机 IP，否则 HTTPS 证书申请可能失败">域名（逗号分隔）
        <input v-model="form.domains" placeholder="example.com, www.example.com"
          :aria-invalid="!!fieldErrs.domains" @input="clearFieldErr('domains')" />
        <span v-if="fieldErrs.domains" :key="'domains' + errSeq" class="field-err">{{ fieldErrs.domains }}</span>
      </label>
      <label class="blk full" :class="{ 'has-err': fieldErrs.root }" data-f="root"
        title="站点文件的物理目录；留空则用站点名，且必须位于站点根目录内（防路径穿越）">根目录（留空用站点名，须落在站点根目录内）
        <div class="dir-row">
          <input v-model="form.root" placeholder="留空则用站点名" :aria-invalid="!!fieldErrs.root"
            @input="clearFieldErr('root')" />
          <button type="button" class="btn-ghost btn-sm" @click="pickerOpen = true">
            <Icon name="folder" :size="13" /> 浏览…
          </button>
        </div>
        <!-- 硬约束「必须落在站点根目录内」此前只写在 title 里——用户填错只能等后端 50001。
             后端下发了 siteRoot 就常驻展示边界（旧后端无此端点时不显示）。 -->
        <span v-if="siteRoot" class="root-hint dim tiny">站点根目录：<code class="mono">{{ siteRoot }}</code>（须落在其中）</span>
        <span v-if="fieldErrs.root" :key="'root' + errSeq" class="field-err">{{ fieldErrs.root }}</span>
      </label>
      <!-- 对象说明（备注，022）：便签式内联编辑，独立于大表单保存——保存站点要走
           nginx 校验与下发，一句备注不该拖住整张表单。新建时暂无 id，不渲染。 -->
      <div v-if="editing" class="blk full">
        <span class="remark-lb">备注（这台站点干嘛的）</span>
        <InlineRemark :model-value="form.remark" :editable="canManage"
          :saver="saveRemark" placeholder="如：客户的官网，PHP 版本锁 7.4 不能动" />
      </div>
      <!-- 应用模板：Node / Java / Python / .NET 在 nginx 这一层接入方式完全相同
           （都是 proxy_pass 到本机端口），差异只在运行时与启动命令——故做成预填
           模板，而不是给 SiteKind 加 4 个产出同一份配置的变体。
           再点同一个 chip 可取消选择；手改过「后端」后切模板不会覆盖你填的内容。 -->
      <!-- 「启用」是站点级全局属性，此前排在弹窗最底部（Nginx 原文编辑器之后）、
           不属于任何导航分区——要滚过整份配置才找得到，rail 上也没有入口。 -->
      <label class="blk full row-inline">
        <input type="checkbox" v-model="form.enabled" />
        <span>启用（纳入 Web 服务器配置）</span>
      </label>
      <div class="hint-note" :class="{ 'is-warn': !!editing }">
        <Icon name="info" :size="15" class="ic" />
        <span>{{ editing
          ? '保存后立即生效：取消勾选会从 Web 服务器移除该站点配置并重载，站点随即停止对外服务；重新勾选则按当前设置重新下发。'
          : '保存即下发：站点会立即对外服务。取消勾选则只登记站点、不下发配置。' }}</span>
      </div>
      </section>
      <section class="sector" id="sec-routing">
        <h4 class="sector-h">路由与后端</h4>
      <div v-if="form.kind === 'proxy'" class="tpl-row">
        <span class="tpl-label">应用模板</span>
        <button v-for="t in APP_TEMPLATES" :key="t.key" type="button" class="tpl-chip"
          :class="{ 'is-on': appTpl === t.key, 'is-warn': appTpl === t.key && tplRuntimeMissing }"
          :disabled="!webSupported" :title="`默认端口 ${t.port}｜启动命令 ${t.startCmd}`"
          @click="useTemplate(t)">{{ t.label }}<em>:{{ t.port }}</em></button>
      </div>
      <p v-if="form.kind === 'proxy' && curTpl" class="hint-note tpl-note">
        <Icon name="info" :size="14" class="ic" />
        <span>启动命令 <b>{{ curTpl.startCmd }}</b>（{{ curTpl.typical }}）<template
          v-if="curTpl.runtimePkg && runtimeDetectable">；系统包 <b :class="{ 'is-warn': tplRuntimeMissing }">{{
          curTpl.runtimePkg }}{{ tplRuntimeMissing ? ' 未装，可到「软件」页装' : ' 已装' }}</b></template>。
          模板只预填反代目标，<b>不会创建应用进程</b>——进程请到「服务」页托管（systemd），或用「容器」页跑 Docker。</span>
      </p>
      <label v-if="form.kind === 'proxy'" class="blk full" :class="{ 'has-err': fieldErrs.upstreams }" data-f="upstreams"
        title="上游服务地址，逗号分隔可负载均衡；格式 http://127.0.0.1:3000">后端（逗号分隔）
        <input v-model="form.upstreams" :disabled="!webSupported" :aria-invalid="!!fieldErrs.upstreams"
          placeholder="http://127.0.0.1:3000, http://127.0.0.1:3001" @input="clearFieldErr('upstreams')" />
        <span v-if="fieldErrs.upstreams" :key="'upstreams' + errSeq" class="field-err">{{ fieldErrs.upstreams }}</span>
      </label>
      <label v-if="form.kind === 'php'" class="blk full" :class="{ 'has-err': fieldErrs.fpm }" data-f="fpm"
        title="PHP-FPM 监听地址；unix:/run/php/php8.2-fpm.sock 或 127.0.0.1:9000">php-fpm
        <input v-model="form.fpm" :disabled="!webSupported" :aria-invalid="!!fieldErrs.fpm"
          placeholder="unix:/run/php/php8.2-fpm.sock 或 127.0.0.1:9000" @input="clearFieldErr('fpm')" />
        <span v-if="fieldErrs.fpm" :key="'fpm' + errSeq" class="field-err">{{ fieldErrs.fpm }}</span>
      </label>
      <!-- SPA history 路由回退：仅 static 类型有意义。开启后 nginx 用
           `try_files $uri $uri/ /index.html` 兜底，配合前端 history 模式单页应用。
           对反代 / PHP / 重定向类型无意义，故仅 static 时显示。
           说明文案刻意常显（而非勾选后才出现）：这个开关的**取舍**要在做决定前
           就看到——默认关闭，用户需要知道"我这是什么站点、该不该开"。 -->
      <label v-if="form.kind === 'static'" class="blk row-inline"
        title="history 模式单页应用（Vue/React Router）才需要；hash 模式（#/xxx）用不到">
        <input type="checkbox" v-model="form.spa" :disabled="!webSupported" />
        <span>SPA 回退（history 路由兜底到 index.html）</span>
      </label>
      <p v-if="form.kind === 'static'" class="hint-note">
        <Icon name="info" :size="14" class="ic" />
        <span>
          开启后，未命中文件的路径会改交 <code class="mono">/index.html</code>（HTTP 200），显示什么由前端路由决定——
          直接访问 <code class="mono">/settings</code>、刷新、分享链接才不会 404。
          <b>hash 模式（<code class="mono">#/xxx</code>）用不到</b>；多页站点别开（拼错的 URL 也会变成 200）。
          <br>前提：根目录里得有 <code class="mono">index.html</code>，否则整站 404。
          js/css 等资产缺失仍返回 404（不会被当成首页），便于定位构建产物问题。
        </span>
      </p>
      <!-- 整站重定向：仅 redirect 类型有意义。目标须 http(s):// 开头（后端校验），
           状态码限 301/302/307/308；$request_uri 自动追加，无需手填路径。 -->
      <template v-if="form.kind === 'redirect'">
        <label class="blk full" :class="{ 'has-err': fieldErrs.redirectTarget }" data-f="redirectTarget"
          title="访问该站点时跳转到的目标 URL，须以 http(s):// 开头">重定向目标 URL
          <input v-model="form.redirectTarget" :disabled="!webSupported" :aria-invalid="!!fieldErrs.redirectTarget"
            placeholder="https://example.com" @input="clearFieldErr('redirectTarget')" />
          <span v-if="fieldErrs.redirectTarget" :key="'rt' + errSeq" class="field-err">{{ fieldErrs.redirectTarget }}</span>
        </label>
        <label class="blk" :class="{ 'has-err': fieldErrs.redirectCode }" data-f="redirectCode"
          title="301/308 永久（可被缓存）；302/307 临时（保留请求方法）">状态码
          <select v-model.number="form.redirectCode" :disabled="!webSupported" @change="clearFieldErr('redirectCode')">
            <option :value="301">301 永久</option>
            <option :value="302">302 临时</option>
            <option :value="307">307 临时（保留方法）</option>
            <option :value="308">308 永久（保留方法）</option>
          </select>
          <span v-if="fieldErrs.redirectCode" :key="'rc' + errSeq" class="field-err">{{ fieldErrs.redirectCode }}</span>
        </label>
      </template>

      <!-- 多路由：一个站点内按 URL 前缀分派。渲染为多条 `location ^~ <前缀>`——
           用 ^~（而非正则）是刻意的：前缀一旦 ^~ 就永不再走正则，于是「用户写的
           前缀」与「deny/WAF 的正则规则」的优先级变得确定，不取决于书写顺序。 -->
      <div v-if="form.kind === 'routed'" class="routes" data-f="routes" :class="{ 'has-err': fieldErrs.routes }">
        <div class="routes-head">
          <span class="routes-title">路由表<em>按前缀长度降序匹配；必须有一条 / 兜底</em></span>
          <button type="button" class="btn-ghost btn-sm" @click="addRoute()">
            <Icon name="plus" :size="13" /> 添加路由
          </button>
        </div>
        <div v-for="(r, i) in form.routes" :key="i" class="route-row">
          <input v-model="r.prefix" class="rt-prefix" placeholder="/api" :aria-label="`第 ${i + 1} 条路由的前缀`" />
          <select v-model="r.kind" class="rt-kind" :aria-label="`第 ${i + 1} 条路由的类型`">
            <option value="static">静态</option>
            <option value="proxy">反向代理</option>
            <option value="php">PHP</option>
          </select>
          <input v-if="r.kind === 'proxy'" v-model="r.upstreams" class="rt-target"
            placeholder="http://127.0.0.1:3000" :aria-label="`第 ${i + 1} 条路由的后端`" />
          <input v-else-if="r.kind === 'php'" v-model="r.fpm" class="rt-target"
            placeholder="unix:/run/php/php8.2-fpm.sock" :aria-label="`第 ${i + 1} 条路由的 php-fpm`" />
          <template v-else-if="r.kind === 'static'">
            <label class="rt-root" :title="'留空则用站点根目录；填了则这条静态路由从它自己的目录读文件'">
              <input v-model="r.root" class="rt-target" placeholder="留空=站点根目录"
                :aria-label="`第 ${i + 1} 条路由的根目录`" />
              <button type="button" class="btn-ghost btn-sm rt-dir" :disabled="!canManage"
                @click="openRouteRootPicker(i)" :aria-label="`浏览第 ${i + 1} 条路由的根目录`">
                <Icon name="folder" :size="13" /> 目录
              </button>
            </label>
            <label class="rt-spa" :title="'未命中文件时回退到 /index.html（history 路由单页应用）'">
              <input type="checkbox" v-model="r.spa" /> SPA
            </label>
          </template>
          <input v-if="r.kind === 'php'" v-model="r.frontController" class="rt-target"
            placeholder="/public/index.php" :disabled="isCaddy"
            :title="isCaddy ? 'Caddy 下路由型 PHP 的入口脚本精确语义尚未实装，已置灰' : ''"
            :aria-label="`第 ${i + 1} 条路由的入口脚本`" />
          <button type="button" class="btn-ghost btn-sm rt-del" title="删除该路由"
            :disabled="form.routes.length <= 1" @click="removeRoute(i)">
            <Icon name="trash" :size="13" />
          </button>
        </div>
        <p class="field-err" v-if="fieldErrs.routes">{{ fieldErrs.routes }}</p>
        <p class="hint-note routes-note">
          <Icon name="info" :size="14" class="ic" />
          <span>典型用法：<b>/</b> 静态（SPA）+ <b>/api</b> 反代到后端；静态路由可**单独指定根目录**
            （如 <code>/</code> 前端产物 + <code>/blog</code> 另一套静态站，各自独立目录）。
            PHP 路由需填 <b>入口脚本</b>（如 <code>/public/index.php</code>）——多路由下不用
            <code>.php</code> 后缀匹配，而是把整个前缀交给该入口，由框架自己路由。</span>
        </p>
      </div>

      <!-- WAF：站点配置的一部分，与其它字段**同一次下发**，故同处一个表单 -->
      </section>
      <section class="sector" id="sec-secure">
        <h4 class="sector-h">安全与性能</h4>
      <div class="waf">
        <label class="inline" title="在被管理站点前生成拦截规则；规则集由系统内置，此处只能选档位与数值">
          <input type="checkbox" v-model="form.wafOn" :disabled="!webSupported" /> 启用 WAF
        </label>
        <template v-if="form.wafOn">
          <label :class="{ 'has-err': fieldErrs.wafProfile }" data-f="wafProfile"
            title="内置规则集档位：基础覆盖常见注入/穿越；严格额外拦截空 UA 与非常见方法（误杀率更高）">档位
            <select v-model="form.wafProfile" :disabled="!webSupported" @change="clearFieldErr('wafProfile')">
              <option value="basic">基础（SQLi / XSS / 穿越 / 敏感文件 / 恶意 UA）</option>
              <option value="strict">严格（+ 空 UA、非白名单方法，误杀率更高）</option>
            </select>
            <span v-if="fieldErrs.wafProfile" :key="'wp' + errSeq" class="field-err">{{ fieldErrs.wafProfile }}</span>
          </label>
          <label :class="{ 'has-err': fieldErrs.wafRate, 'is-dim': isCaddy }" data-f="wafRate"
            :title="isCaddy ? caddyNoop : '单客户端每秒最大请求数；0 = 不限速'">CC 限速（次/秒，0 = 不限）
            <input v-model.number="form.wafRate" type="number" min="0" max="1000" :disabled="!webSupported || isCaddy"
              :aria-invalid="!!fieldErrs.wafRate" @input="clearFieldErr('wafRate')" />
            <span v-if="fieldErrs.wafRate" :key="'wr' + errSeq" class="field-err">{{ fieldErrs.wafRate }}</span>
          </label>
          <label :title="isCaddy ? caddyNoop : (form.wafRate > 0 ? '0 = 由后端按 rate×2 计算' : '需先启用限速，否则后端会拒绝')"
            :class="{ 'has-err': fieldErrs.wafBurst, 'is-dim': isCaddy }" data-f="wafBurst">
            突发桶（0 = 自动）
            <input v-model.number="form.wafBurst" type="number" min="0" max="10000"
              :disabled="!webSupported || !form.wafRate || isCaddy" :aria-invalid="!!fieldErrs.wafBurst"
              @input="clearFieldErr('wafBurst')" />
            <span v-if="fieldErrs.wafBurst" :key="'wb' + errSeq" class="field-err">{{ fieldErrs.wafBurst }}</span>
          </label>
        </template>
      </div>
      <!-- caddy：WAF **规则集档位生效、限速不生效**（标准版无 rate_limit 指令，
           需第三方模块）。如实写明，否则用户会以为填了就在防 CC。 -->
      <p v-if="isCaddy && form.wafOn" class="hint-note is-warn">
        <Icon name="info" :size="14" class="ic" />
        <span>当前 Web 服务器为 Caddy：<b>规则集档位生效、限速不生效</b>——标准 Caddy 无 rate_limit 指令。</span>
      </p>

      <!-- 自定义配置片段（019）：原始 nginx 文本，插在主 server 块尾部（所有
           location 之后）。属**托管态**——随「保存并应用」重新渲染下发（与
           「手动维护」互补：那个是整文件被接管、这个是被渲染进去的片段）。
           仅 owner 可改（写坏≈root 级事故，后端 403 / 64KiB 双护栏），其他人只读。 -->
      <div class="cc">
        <div class="cc-head">
          <span class="cc-title"><Icon name="edit" :size="14" /> 自定义配置片段</span>
          <span v-if="!isOwner" class="dim tiny">仅 owner 可编辑</span>
        </div>
        <textarea v-model="form.customConf" class="mono cc-text" rows="5" spellcheck="false"
          :readonly="!canManage || !isOwner" :disabled="!webSupported || isCaddy"
          :aria-invalid="!!fieldErrs.customConf" data-f="customConf"
          placeholder="例如：location /static/ { expires 7d; }"></textarea>
        <span v-if="fieldErrs.customConf" :key="'cc' + errSeq" class="field-err">{{ fieldErrs.customConf }}</span>
        <p class="hint-note cc-note">
          <Icon name="info" :size="14" class="ic" />
          <span>插入在 server 块<b>尾部</b>（所有 location 之后），随「保存并应用」重新渲染下发；下发前经配置校验——写错不会上线。留空 = 不使用。</span>
        </p>
        <p v-if="isCaddy" class="hint-note cc-note is-warn">
          <Icon name="info" :size="14" class="ic" />
          <span>当前 Web 服务器为 Caddy：自定义片段是<b>原始 nginx 语法</b>，与 Caddyfile 语法不同、无法透传，已置灰。</span>
        </p>
      </div>

      <!-- 高级配置（020）：www 跳转 / TLS 强化 / 伪静态。
           三类都是「字段固定、极易写错、出错后果严重」——手写 `if ($host …)` 有陷阱、
           ssl_ciphers 抄错会让老客户端连不上、rewrite 是新手最大的坑，故做成表单
           由渲染器产出。TLS 项仅在站点已有证书时才会写进配置（前端如实说明）。 -->
      <div class="adv">
        <div class="adv-head">
          <span class="adv-title"><Icon name="shield" :size="14" /> 高级配置</span>
        </div>
        <label class="blk adv-row" title="只对主域名生效：子域不会被一起改写">
          www 跳转
          <select v-model="form.wwwRedirect">
            <option value="off">不处理</option>
            <option value="to_www">裸域 → www（example.com → www.example.com）</option>
            <option value="to_bare">www → 裸域（www.example.com → example.com）</option>
          </select>
        </label>
        <label class="blk adv-row"
          :title="isCaddy ? '影响启用的 TLS 版本：Caddy 最低只支持 TLSv1.2，更低的档位会如实回落' : '影响 ssl_protocols：只有下限及以上会被启用'">
          TLS 版本下限
          <select v-model="form.tlsMin">
            <option value="TLSv1" :disabled="isCaddy">TLSv1（最老客户端，不安全{{ isCaddy ? '，Caddy 不支持' : '' }}）</option>
            <option value="TLSv1.1" :disabled="isCaddy">TLSv1.1{{ isCaddy ? '（Caddy 不支持）' : '' }}</option>
            <option value="TLSv1.2">TLSv1.2（推荐）</option>
            <option value="TLSv1.3">TLSv1.3（仅新客户端）</option>
          </select>
        </label>
        <label class="blk adv-row" :class="{ 'is-dim': isCaddy }"
          :title="isCaddy ? caddyNoop : '影响 ssl_ciphers：档位越高越安全、老客户端越可能连不上'">
          加密套件档位
          <select v-model="form.tlsProfile" :disabled="isCaddy">
            <option value="compat">兼容（老客户端，含弱套件）</option>
            <option value="modern">现代（默认）</option>
            <option value="strict">严格（仅 TLSv1.3 + 前向保密）</option>
          </select>
        </label>
        <label class="blk row-inline" title="开启后浏览器在 max-age 内强制 HTTPS，服务端无法撤回">
          <input type="checkbox" v-model="form.hsts" />
          <span>启用 HSTS（浏览器强制 HTTPS，不可撤回）</span>
        </label>
        <template v-if="form.hsts">
          <label class="blk adv-row" title="默认 300 秒：先小步验证，确认无误再调大">
            有效期 max-age（秒）
            <input v-model.number="form.hstsMaxAge" type="number" min="0" max="63072000" />
          </label>
          <label class="blk row-inline" title="一并约束所有子域：确认全部子域都支持 HTTPS 再开">
            <input type="checkbox" v-model="form.hstsSub" /> <span>含子域（includeSubDomains）</span>
          </label>
          <label class="blk row-inline" title="申请进浏览器内置列表，几乎不可逆">
            <input type="checkbox" v-model="form.hstsPreload" /> <span>加入 preload 列表</span>
          </label>
          <p class="hint-note is-warn adv-warn">
            <Icon name="alert" :size="14" class="ic" />
            <span>HSTS 在 max-age 期间<b>无法从服务端撤回</b>：先用 300 秒验证，确认全站可用 HTTPS 后再调大；preload 更要三思。</span>
          </p>
        </template>
        <template v-if="form.kind === 'php'">
          <label class="blk adv-row" :class="{ 'is-dim': isCaddy }"
            :title="isCaddy ? caddyNoop : '预置模板替换默认的 try_files 兜底；不确定就选「无」'">
            伪静态模板
            <select v-model="form.rewritePreset" :disabled="isCaddy">
              <option value="none">无</option>
              <option value="wordpress">WordPress</option>
              <option value="laravel">Laravel</option>
              <option value="thinkphp">ThinkPHP（PATH_INFO）</option>
              <option value="typecho">Typecho</option>
              <option value="discuz">Discuz</option>
              <option value="custom">自定义…</option>
            </select>
          </label>
          <label v-if="form.rewritePreset === 'custom'" class="blk full adv-row"
            title="原样进 location / 内；上限 64 KiB">
            自定义 rewrite（location / 内）
            <textarea v-model="form.rewriteCustom" class="mono adv-text" rows="4" spellcheck="false"
              :disabled="isCaddy" placeholder="try_files $uri $uri/ /index.php?$args;"></textarea>
          </label>
        </template>
        <p class="hint-note adv-note">
          <Icon name="info" :size="14" class="ic" />
          <span>TLS 与 HSTS 仅在站点<b>已有证书</b>时才会写进配置；www 跳转与伪静态随「保存并应用」重新渲染。</span>
        </p>
      </div>

      <!-- 访问控制 / 反代增强（021）：三类「字段固定、极易写错、后果严重」——
           IP 黑白名单顺序匹配、Basic Auth 口令落盘、多后端负载策略，皆由渲染器产出。 -->
      <div class="adv">
        <div class="adv-head">
          <span class="adv-title"><Icon name="key" :size="14" /> 访问控制与反代</span>
        </div>
        <!-- IP 黑白名单（互斥：白名单非空时黑名单被忽略，对应 input 禁用） -->
        <label class="blk full adv-row" title="单 IP 或 CIDR（IPv4），逗号/空格分隔。白名单非空即只放行名单内、其余拒绝">
          IP 白名单（allow）
          <textarea v-model="form.ipAllow" class="mono adv-text" rows="2" spellcheck="false"
            :disabled="!!form.ipDeny.trim()" placeholder="192.168.1.10, 10.0.0.0/24"></textarea>
        </label>
        <label class="blk full adv-row" :class="{ 'is-dim': !!form.ipAllow.trim() }"
          title="单 IP 或 CIDR（IPv4）。白名单非空时被忽略">
          IP 黑名单（deny）
          <textarea v-model="form.ipDeny" class="mono adv-text" rows="2" spellcheck="false"
            :disabled="!!form.ipAllow.trim()" placeholder="1.2.3.4, 5.6.7.0/24"></textarea>
        </label>
        <p class="hint-note adv-note" v-if="form.ipAllow.trim()">
          <Icon name="info" :size="14" class="ic" />
          <span>已启用白名单：黑名单被忽略（白名单优先，名单外全部拒绝）。</span>
        </p>
        <!-- HTTP Basic Auth：口令不落库，仅设置时经 openssl 生成 apr1 摘要写入 htpasswd -->
        <label class="blk row-inline" :class="{ 'is-dim': isCaddy }"
          :title="isCaddy ? caddyNoop : '开启后访问站点需输入用户名口令（口令不落库）'">
          <input type="checkbox" v-model="form.authBasic" :disabled="isCaddy" /> <span>启用 Basic Auth（HTTP 基础认证）</span>
        </label>
        <template v-if="form.authBasic">
          <label class="blk full adv-row" data-f="authUser" :class="{ 'has-err': fieldErrs.authUser }"
            title="Basic Auth 用户名（不能含冒号或空白）">
            用户名
            <input v-model="form.authUser" @input="clearFieldErr('authUser')" :disabled="isCaddy"
              :aria-invalid="!!fieldErrs.authUser" placeholder="admin" />
            <span v-if="fieldErrs.authUser" :key="'authUser' + errSeq" class="field-err">{{ fieldErrs.authUser }}</span>
          </label>
          <label class="blk full adv-row" data-f="authPass" :class="{ 'has-err': fieldErrs.authPass }"
            title="留空 = 保留现有口令（仅设置时经 openssl 生成摘要写入 htpasswd，不落库、不回显）">
            口令{{ editing ? '（留空保留）' : '' }}
            <input type="password" v-model="form.authPass" @input="clearFieldErr('authPass')" :disabled="isCaddy"
              :aria-invalid="!!fieldErrs.authPass" placeholder="********" />
            <span v-if="fieldErrs.authPass" :key="'authPass' + errSeq" class="field-err">{{ fieldErrs.authPass }}</span>
          </label>
        </template>
        <!-- 反代增强：仅 proxy 类型有意义（单后端无 upstream 块、策略不生效） -->
        <template v-if="form.kind === 'proxy'">
          <label class="blk adv-row" :class="{ 'is-dim': isCaddy }"
            :title="isCaddy ? caddyNoop : '多后端时的负载均衡策略'">
            负载均衡策略
            <select v-model="form.lbPolicy" :disabled="isCaddy">
              <option value="least_conn">最小连接（默认）</option>
              <option value="ip_hash">按客户端 IP 哈希</option>
            </select>
          </label>
          <label class="blk adv-row" title="与上游建连超时（秒，1~3600）">
            建连超时（秒）
            <input v-model.number="form.proxyConnectTimeout" type="number" min="1" max="3600" :disabled="isCaddy" />
          </label>
          <label class="blk adv-row" title="向上游发送超时（秒，1~3600）">
            发送超时（秒）
            <input v-model.number="form.proxySendTimeout" type="number" min="1" max="3600" :disabled="isCaddy" />
          </label>
          <label class="blk adv-row" title="从上游读取超时（秒，1~3600）">
            读取超时（秒）
            <input v-model.number="form.proxyReadTimeout" type="number" min="1" max="3600" :disabled="isCaddy" />
          </label>
        </template>
      </div>

      </section>
      <section class="sector" id="sec-ops">
        <h4 class="sector-h">日志与证书</h4>
      <!-- 站点日志（021）：独立 access/error 开关 + 级别 + 查看/下载/清空 -->
      <div class="adv">
        <div class="adv-head">
          <span class="adv-title"><Icon name="file" :size="14" /> 站点日志</span>
        </div>
        <label class="blk row-inline" :class="{ 'is-dim': isCaddy }"
          :title="isCaddy ? caddyNoop : '开启后由面板指定路径记录本站访问日志，可查看/下载/清空'">
          <input type="checkbox" v-model="form.logAccess" :disabled="isCaddy" /> <span>记录访问日志（access.log）</span>
        </label>
        <label class="blk row-inline" :class="{ 'is-dim': isCaddy }"
          :title="isCaddy ? caddyNoop : '开启后由面板指定路径记录本站错误日志'">
          <input type="checkbox" v-model="form.logError" :disabled="isCaddy" /> <span>记录错误日志（error.log）</span>
        </label>
        <label class="blk adv-row" v-if="form.logError" :class="{ 'is-dim': isCaddy }"
          :title="isCaddy ? caddyNoop : '错误日志级别'">
          错误级别
          <select v-model="form.logErrorLevel" :disabled="isCaddy">
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="notice">notice</option>
            <option value="warn">warn</option>
            <option value="error">error（默认）</option>
            <option value="crit">crit</option>
            <option value="alert">alert</option>
            <option value="emerg">emerg</option>
          </select>
        </label>
        <div class="log-actions" v-if="editing">
          <button v-if="form.logAccess" class="btn-ghost btn-sm" :disabled="busy" type="button"
            @click="viewLog('access')"><Icon name="file" :size="13" /> 查看访问日志</button>
          <button v-if="form.logAccess" class="btn-ghost btn-sm" :disabled="busy" type="button"
            @click="clearLog('access')"><Icon name="trash" :size="13" /> 清空访问日志</button>
          <button v-if="form.logError" class="btn-ghost btn-sm" :disabled="busy" type="button"
            @click="viewLog('error')"><Icon name="file" :size="13" /> 查看错误日志</button>
          <button v-if="form.logError" class="btn-ghost btn-sm" :disabled="busy" type="button"
            @click="clearLog('error')"><Icon name="trash" :size="13" /> 清空错误日志</button>
        </div>
        <div class="log-confirm" v-if="clearAsk">
          <span>确定清空{{ clearAsk === 'access' ? '访问' : '错误' }}日志？将截断文件（保留并继续写入），不可恢复。</span>
          <button class="btn-ghost btn-sm" type="button" @click="clearAsk = null">取消</button>
          <button class="btn-danger btn-sm" type="button" :disabled="busy" @click="confirmClear">确认清空</button>
        </div>
        <p class="hint-note adv-note" v-if="!form.logAccess && !form.logError">
          <Icon name="info" :size="14" class="ic" />
          <span>未开启独立日志：站点沿用 Web 服务器全局日志（无法按站点查看/下载/清空）。</span>
        </p>
      </div>

      <!-- SSL 证书：站点配置的一部分，与站点同处一个编辑弹窗
           （此前是页面下方独立的「证书」区块——与应用站点配置同理，单独成块既多余、
            又让「该站点的证书」与「编辑该站点」割裂在两处；现在合并进来，
            申请 / 续期 / 删除 / 自动续期 / 信任根证书全在弹窗内完成）。
            仅编辑既有站点时出现：新建站点尚未落库、无法归属证书。 -->
      <div v-if="editing" class="ssl">
        <div class="ssl-head">
          <span class="ssl-title"><Icon name="lock" :size="14" /> SSL 证书</span>
          <button class="btn-primary btn-sm" :disabled="!sslReady" :title="sslReady ? '为当前站点申请证书' : sslHint" @click="applySslEditing">
            <Icon name="plus" :size="13" /> 申请证书
          </button>
        </div>
        <p class="cert-sweep dim tiny">自动续期扫描：{{ sweepSummary() }}</p>
        <div v-if="siteCerts.length" class="ssl-list">
          <div v-for="c in siteCerts" :key="c.id" class="ssl-row">
            <div class="ssl-meta">
              <span class="mono">{{ c.domain }}</span>
              <span class="dim tiny">{{ certSourceLabel(c.source) }} · 到期 {{ fmtDate(c.not_after) }} · <span :class="certLevel(c.days_left)">{{ c.days_left === null ? '—' : `${c.days_left} 天` }}</span></span>
            </div>
            <div class="ssl-ops">
              <span v-if="c.source === 'acme'" class="switch" :title="sslSupported ? '到期前 30 天内自动续期' : '需 ACME 支持'">
                <input type="checkbox" :checked="c.auto_renew" :disabled="!sslSupported || busy" @change="setAutoRenew(c, ($event.target as HTMLInputElement).checked)" /><i />
              </span>
              <button class="btn-ghost btn-sm" :disabled="!sslReady" :title="sslReady ? '续期这张证书' : sslHint" @click="renewCert(c)"><Icon name="refresh" :size="13" /> 续期</button>
              <button class="btn-ghost btn-sm danger" :disabled="!canSsl"
          :title="canSsl ? '' : '无 ssl.manage 权限'" @click="delCert = c"><Icon name="trash" :size="13" /> 删除</button>
            </div>
          </div>
        </div>
        <EmptyState v-else title="暂无证书" hint="点上方「申请证书」为该站点签发（需 openssl 或 ACME）" />
        <button class="btn-ghost btn-sm ca-link" title="导入根证书后，全部本地 HTTPS 站点不再报「非私密连接」" @click="caHelp = true">
          <Icon name="lock" :size="13" /> 信任根证书
        </button>
      </div>

      <!-- 站点「配置原文 / 历史版本与回滚」见 SiteConfPanel：状态与写接口自带，
           这里只负责把「作用在哪个站点」与「还能不能写」传进去。 -->
      <SiteConfPanel :site="editing" :web-supported="webSupported" :can-manage="canManage"
        :is-owner="isOwner" :web-name="webName" :busy="busy" :err-seq="errSeq"
        v-model:manual="confManual" v-model:stale="confStale"
        @changed="emit('reload', true)" @bump-err="bumpErr" />
      </section>
      <!-- 「启用」开关已上移到「基础」分区（见 sec-basic）：它是站点级全局属性，
           摆在弹窗最底部、Nginx 原文编辑器之后，既不属于任何导航分区也找不到。 -->
      <p class="tip">
        保存前会先跑一次 nginx 语法校验，失败不会影响正在运行的配置；反代后端只接受
        <code>http(s)://host:port</code>，WAF 与站点配置同一次下发。
      </p>
      <!-- 操作条吸底：弹窗比视口高时，按钮不会随内容滚走，矮窗口下也点得到。
           错误条**不再**挤在这里——它已上移到弹窗顶部吸顶（见上方 .form-msg），
           字段级错误则各自挂在出问题的输入框旁。 -->
      </div>
    </div>
      <div class="modal-foot">
        <div class="modal-actions">
          <button class="btn-ghost" @click="modalClose">取消</button>
          <button class="btn-primary" :disabled="busy" @click="save">
            {{ busy ? '保存中…' : (editing ? '保存并应用' : '创建并应用') }}</button>
        </div>
      </div>
    </div>
  </div>

  <ConfirmDialog :open="!!delCert" danger title="删除证书"
    :detail="delCert ? `将删除证书「${delCert.domain}」。` : ''"
    confirm-word="删除" @confirm="doDeleteCert" @cancel="delCert = null" />
  <!-- 保存二选一：手动维护站点 + 表单改了影响配置的字段（或已未同步）。
       不弹这步 = 表单值静默入库而磁盘配置不动 → 面板与 nginx 分叉（as11 真实踩过）。
       level-2：叠加在编辑弹窗之上（与目录选择器同级抬层）。 -->
  <div v-if="saveAsk" class="mask level-2" @click.self="closeSaveAsk">
    <div ref="saveAskBox" class="modal stack" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 class="modal-title">保存手动维护的站点</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="closeSaveAsk">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p class="modal-lead">{{ saveAskLead }}</p>
      <div class="modal-actions">
        <button class="btn-ghost" @click="closeSaveAsk">取消</button>
        <button class="btn-ghost" title="只把表单值入库；磁盘配置保持不变（随后会标记「未同步」）"
          @click="resumeSave(false)">仅保存（不覆盖配置）</button>
        <button class="btn-primary" title="按当前表单覆盖磁盘配置：先自动备份原配置，再重新渲染并重载"
          @click="resumeSave(true)">按表单重新生成</button>
      </div>
    </div>
  </div>

  <DirectoryPickerDialog :open="pickerOpen" :initial-path="form.root || siteRoot"
    @select="onPickRoot" @cancel="pickerOpen = false" />

  <DirectoryPickerDialog :open="routePickerOpen"
    :initial-path="(form.routes[routePickerIdx]?.root) || siteRoot"
    @select="onPickRouteRoot" @cancel="routePickerOpen = false" />

  <!-- 根证书安装指引：自签 leaf 由面板本地根 CA 签发，不把根装进信任库浏览器必然报不可信。
       这是「自签证书没法在本地用」的正解——不是换证书，而是装根。 -->
  <div v-if="caHelp" class="mask" @click.self="closeCaHelp">
    <div ref="caBox" class="modal wide" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 class="modal-title">安装面板根证书</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="closeCaHelp">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p class="modal-lead">
        面板自签的站点证书，全部由<b>本机这一张根 CA</b> 签发。浏览器只信任「已装进信任库的根 CA」，
        所以直接访问会提示「不受信任 / 非私密连接」——这是证书链原理，不是面板坏了。
        <b>导入一次</b>即可：这张 CA 签发的全部本地站点（含以后新建的）都直接受信，无需再点「继续前往」。
      </p>
      <!-- 公共 .hint-note.is-warn（此前 .ca-warn 私有复刻了一版警告样式） -->
      <p class="hint-note is-warn">
        <Icon name="alert" :size="14" class="ic" />
        <span>根证书仅用于本机开发。<b>不要</b>把它装到不受你控制的机器上——装上等于信任该 CA 签发的任何证书。</span>
      </p>

      <div class="ca-actions">
        <button class="btn-primary" @click="downloadCa()"><Icon name="download" :size="14" /> 下载根证书（ca.crt）</button>
      </div>

      <div class="ca-steps">
        <div class="ca-step">
          <div class="ca-step-h">① 下载</div>
          <p class="dim">点上方按钮，浏览器会保存 <code>forkpanel-local-ca.crt</code>（PEM 格式的 X.509 证书）。</p>
        </div>
        <div class="ca-step">
          <div class="ca-step-h">② 装入信任库</div>
          <p class="dim"><b>Debian / Ubuntu 系统级</b>（curl、wget 与部分 Chromium 读系统库）：</p>
          <pre class="ca-code">sudo cp forkpanel-local-ca.crt /usr/local/share/ca-certificates/forkpanel-local-ca.crt
sudo update-ca-certificates</pre>
          <p class="dim"><b>Firefox</b> 用的是自带信任库，系统级导入对它无效：设置 → 隐私与安全 → 证书 →
            查看证书 → 证书颁发机构 → 导入，选中该文件并勾选<b>「信任由此 CA 标识的网站」</b>。</p>
          <p class="dim"><b>Chrome / Chromium</b>：设置 → 隐私和安全 → 安全 → 管理证书 →
            受信任的根证书颁发机构 → 导入（Linux 上通常装完系统级后重启浏览器即可）。</p>
        </div>
        <div class="ca-step">
          <div class="ca-step-h">③ 验证</div>
          <pre class="ca-code">curl --cacert forkpanel-local-ca.crt -I https://127.0.0.1</pre>
          <p class="dim">返回 <code>HTTP/2 200</code> 且无证书告警即导入成功。浏览器需<b>完全退出后重开</b>才会重读信任库。</p>
        </div>
      </div>

      <div class="modal-foot">
        <div class="modal-actions">
          <button class="btn-ghost" @click="closeCaHelp">关闭</button>
        </div>
      </div>
    </div>
  </div>

  <!-- SSL 签发弹窗（审计 U6）：替代 window.prompt 选方式/填邮箱；行内「SSL」与编辑弹窗「申请证书」共用 -->
  <!-- 签发弹窗叠在站点弹窗之上 → .level-2（此前与父弹窗同为 z-50，只靠 DOM 顺序压住） -->
  <div v-if="sslModal" class="mask level-2" @click.self="closeSslModal">
    <div ref="sslBox" class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 class="modal-title">为「{{ sslModal.site.name }}」申请证书</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="closeSslModal">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <!-- 这里出的错若写页面级 error/notice，会被两层遮罩挡在后面，
           用户只觉得"点了申请没反应"。故在弹窗内自带错误位。 -->
      <p v-if="sslErr" class="err-bar" role="alert">
        <Icon name="alert" :size="15" class="ic" /><span>{{ sslErr }}</span>
      </p>
      <label class="ssl-opt">
        <input type="radio" value="self-signed" v-model="sslModal.method" />
        <span><b>面板自签</b><br /><span class="dim">离线可用、立即可得；需先导入面板根证书浏览器才受信（见「信任根证书」）</span></span>
      </label>
      <label class="ssl-opt">
        <input type="radio" value="http-01" v-model="sslModal.method" />
        <span><b>ACME http-01</b><br /><span class="dim">可信证书，需公网 80 端口可达 + certbot</span></span>
      </label>
      <label v-if="sslModal.method === 'http-01'" class="blk">
        ACME 账户邮箱（必填，用于到期与异常通知）
        <input v-model="sslModal.email" type="email" placeholder="ops@example.com" autocomplete="email" />
      </label>
      <div class="modal-foot">
        <div class="modal-actions">
          <button class="btn-ghost" @click="closeSslModal">取消</button>
          <button class="btn-primary" :disabled="busy || (sslModal.method === 'http-01' && !sslModal.email.trim())"
            @click="execSsl(sslModal.site, sslModal.method, sslModal.email)">
            {{ busy ? '提交中…' : '申请' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* WAF 区块：位于站点编辑弹窗内，用虚线分隔以表明它是站点配置的一部分而非并列项。
   ⚠️ 曾用 flex-wrap 排这 4 个控件：570px 内容宽装不下「勾选 + 档位 + CC + 突发桶」，
   且折点取决于「档位」下拉最长 option 的宽度（基础 ≈300px / 严格 ≈360px 折法不同）——
   实测要么折成 3+1、要么 2+2：勾选框浮在 select 行、突发桶标签与输入分家，视觉错乱。
   改为确定性网格：勾选行独占一行（与上方 SPA 回退的勾选行同构），字段行三段式——
   档位弹性吸收余量，CC / 突发桶两列按标签宽度自适应（max-content 保证标签不折行）。 */
.waf { display: grid; grid-template-columns: minmax(96px, 1fr) max-content max-content;
  align-items: start; gap: 10px 14px; margin-top: 10px;
  border-top: 1px dashed var(--c-border); padding-top: 10px; }
.waf > label.inline { grid-column: 1 / -1; }
.waf label { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-12); color: var(--c-text-dim); }
.waf label.inline { flex-direction: row; align-items: center; }
.waf label.inline input { width: auto; }
/* 窄窗（弹窗退到 94vw 后内容区不足 ~470px）：字段行退回单列堆叠，防止数值列挤没「档位」 */
@media (max-width: 500px) {
  .waf { grid-template-columns: minmax(0, 1fr); }
}
.cert-sweep { margin: 0 0 10px; padding-left: 2px; }
.blk { display: block; margin-bottom: 12px; font-size: var(--fs-13); color: var(--c-text-dim); }
.blk input { width: 100%; margin-top: 4px; }
/* 备注块（022）：标签与其它 blk 字段同规格；组件与标签间距同 input 的 margin-top */
.remark-lb { display: block; }
.remark-blk .iremark { margin-top: 4px; }
/* 多路由表：一个站点内多条 `location ^~ <前缀>`。逐行一条，窄屏自然换行。 */
.routes { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px; }
.routes-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.routes-title { font-size: var(--fs-12-5); color: var(--c-text); }
.routes-title em { font-style: normal; margin-left: 8px; color: var(--c-text-dim); font-size: var(--fs-12); }
/* 一条路由 = 一行：root 是唯一可伸缩项（grow/shrink），其余固定列永不错行；
   窄到放不下时由 root 收缩兜底，避免 SPA/删除被挤到第二行 */
.route-row { display: flex; gap: 5px; align-items: center; flex-wrap: nowrap; }
/* 前缀列固定宽：它是这张表的主键，太宽会让后面的目标字段被挤出视野 */
.route-row .rt-prefix { flex: 0 0 116px; min-width: 0; }
.route-row .rt-kind   { flex: 0 0 80px; }
.route-row .rt-target { flex: 1 1 220px; min-width: 0; }
.route-row .rt-spa { flex: none; display: flex; align-items: center; gap: 5px;
  font-size: var(--fs-12-5); color: var(--c-text-dim); white-space: nowrap; }
/* 原生勾选框必须复位 width——全局 `input { width: 100% }` 会让它撑满整行 */
.route-row .rt-spa input { width: auto; }
/* 路由级根目录：label 包 input + 目录按钮，整体占弹性宽 */
.route-row .rt-root { flex: 1 1 160px; min-width: 0; display: flex; gap: 8px; align-items: center; }
.route-row .rt-root input { flex: 1 1 auto; min-width: 0; }
.route-row .rt-dir { flex: none; }
.route-row .rt-del { flex: none; }
.routes.has-err .rt-prefix, .routes.has-err .rt-kind { border-color: var(--c-danger); }
.routes-note { margin: 2px 0 0; }
.routes-note code { font-size: var(--fs-12); }
/* 反向代理的「应用模板」选择条。Node/Java/Python/.NET 的接入方式相同（都是
   proxy_pass 到本机端口），差异只在运行时与启动命令——故做成预填模板而非新类型。 */
.tpl-row { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px;
  align-items: center; margin-top: 2px; }
.tpl-label { font-size: var(--fs-12-5); color: var(--c-text-dim); }
.tpl-chip { font: inherit; font-size: var(--fs-12-5); line-height: 1; padding: 6px 13px;
  cursor: pointer; border-radius: 999px; border: 1px solid var(--c-border);
  background: var(--c-surface-2); color: var(--c-text);
  transition: border-color .15s, background .15s; }
.tpl-chip em { font-style: normal; color: var(--c-text-mute); }
.tpl-chip:hover:not(:disabled) { border-color: var(--c-primary); }
.tpl-chip.is-on { border-color: var(--c-primary); background: var(--c-primary-soft); }
.tpl-chip.is-warn { border-color: var(--c-warn); background: var(--c-warn-bg); }
.tpl-chip:disabled { opacity: .5; cursor: not-allowed; }
/* 紧跟在模板条之后：收掉 .hint-note 默认的 14px 下边距，与相邻输入行的间距对齐 */
.tpl-note { margin-top: 2px; margin-bottom: 10px; }
.tpl-note b { font-weight: 500; }
.tpl-note b.is-warn { color: var(--c-warn); }
.row-inline { display: flex; align-items: flex-start; gap: 7px; }
/* 文字可能折行，勾选框对齐首行而非整体垂直居中；并复位 width——
   全局 `input{width:100%}` 会把原生勾选框拉成宽盒子，勾选框与文字之间出现大段空隙、
   文字被挤到右侧折行（与 .waf label.inline input / .chk input 同一处坑，故同样复位）。 */
.row-inline input[type="checkbox"] { width: auto; margin: 4px 0 0; }
/* 遮罩 / 弹窗框 / 标题行 / 关闭按钮 / 操作条基础式样统一取 main.css 公共类 */

/* 根证书引导与站点编辑都用宽版（宽度与滚动见公共 .modal.wide）；此处只补
   sticky 操作条需要的「下内边距归零」——底部留白改由操作条自己承担。 */
.modal.wide { padding-bottom: 0; }
/* 站点编辑弹窗：全屏面板 + 左侧分段导航（2026-10-11，B 方案）。
   结构：.modal(网格 标题 / 中部 / 操作条) > .modal-mid(导航 rail + .modal-body 滚动区)。
   覆盖公共 .modal.wide 的 620px → 全屏面板；特异性 (0,3,1) 压过公共 (0,2,0)。 */
.modal.wide.site-modal {
  /* 96vw 再叠加 .mask 的 clamp 内边距会溢出视口，改 100% 由 mask 统一控边 */
  width: min(1180px, 100%);
  height: min(94vh, 960px);
  max-height: 96vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  grid-template-columns: 1fr;
  padding: 0;
  /* ⚠️ 必须同步覆写这两个变量：公共 .modal-head 用它们的**负值**外扩
     （margin: -py -px 12px / padding: py px 12px），本是为抵消弹窗自身内边距而设计。
     padding 归零后不覆写，标题行会被推出容器、再被 overflow:hidden 裁掉——
     表现为标题与关闭按钮贴死上边与左边。与 TrashPanel / SqlConsole 同款全幅面板同口径。 */
  --modal-py: 0;
  --modal-px: 0;
  overflow: hidden;
}
/* 变量归零后 head 失去内边距，此处显式补（与 .modal-body 的 18/22 左对齐） */
.modal.wide.site-modal > .modal-head { grid-row: 1; margin: 0; padding: 14px 22px 12px;
  border-bottom: 1px solid var(--c-border); }
.modal.wide.site-modal > .modal-mid { grid-row: 2; display: flex; min-height: 0; }
.modal.wide.site-modal > .modal-foot {
  grid-row: 3; position: static; margin: 0; padding: 12px 22px;
  background: var(--c-surface-2); border-top: 1px solid var(--c-border);
}
/* 内部操作条不再自行吸底（弹窗为 grid 行，天然固定底部），吸底与背景由 grid 行承担。 */
.modal.wide.site-modal > .modal-foot .modal-actions { position: static; margin: 0;
  padding: 0; border-top: 0; background: none; }
/* 左侧分段导航 rail：点按平滑滚动到对应 .sector；当前分区由 onBodyScroll 高亮 */
.nav-rail {
  width: 176px; flex: none; overflow-y: auto;
  border-right: 1px solid var(--c-border);
  padding: 14px 10px; background: var(--c-surface-2);
  display: flex; flex-direction: column; gap: 2px;
}
.nav-item {
  display: block; width: 100%; text-align: left;
  border: 0; background: none; cursor: pointer;
  padding: 8px 10px; border-radius: 8px;
  font: inherit; font-size: var(--fs-13); color: var(--c-text);
}
.nav-item:hover { background: var(--c-hover); }
.nav-item.active { background: var(--c-primary-soft); color: var(--c-primary); font-weight: 600; }
/* 分区内有字段级错误：rail 上亮红点（用户切到别的分区后仍找得到问题在哪） */
.nav-item { position: relative; }
.nav-item.has-err { color: var(--c-danger); }
.nav-dot { position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
  width: 6px; height: 6px; border-radius: 50%; background: var(--c-danger); }
/* 内容滚动区与分区卡片 */
.modal-body { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; position: relative; padding: 18px 22px 8px; }
/* 全屏后横向空间充足：分区内简单输入框双列排布，宽块（路由表 / 代码编辑器 /
   证书列表 / 提示）整宽跨两列。整列块用 1fr 1fr，列间距 18、行距 14。 */
.modal-body .sector { max-width: 980px; margin: 0 auto 22px;
  display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; row-gap: 14px; align-items: start; }
/* 分区之间补一条分隔线：滚动长表单时边界只靠标题文字可辨，与左侧 rail 的「分段」感对不上 */
.modal-body .sector + .sector { border-top: 1px solid var(--c-border); padding-top: 20px; }
/* ⚠️ 必须写 margin:0 而不是只写 margin-bottom：main.css 的 `.modal .blk { margin: 12px 0 }`
   是**简写**，本页 .blk 只覆盖了 margin-bottom，margin-top:12px 仍在生效——与 row-gap
   叠加成 26px（设计为 14），首行字段与分区标题之间也凭空多 12px。 */
.modal-body .sector > .blk { margin: 0; }
/* 整宽元素：跨两列 */
.modal-body .sector > .blk.full,
.modal-body .sector > .routes,
.modal-body .sector > .tpl-row,
.modal-body .sector > .waf,
.modal-body .sector > .cc,
.modal-body .sector > .adv,
.modal-body .sector > .ssl,
.modal-body .sector > .hint-note { grid-column: 1 / -1; }
.modal-body .sector-h { grid-column: 1 / -1; font-size: var(--fs-14); font-weight: 700; margin: 0 0 2px; color: var(--c-text); }
/* 通用宽版弹窗（CA 指引等）操作条吸底：站点弹窗已在上方用 grid 行固定，不受影响 */
.modal.wide .modal-actions { position: sticky; bottom: 0; margin: 14px -20px 0;
  padding: 12px 20px; background: var(--c-surface-2); border-top: 1px solid var(--c-border); }

/* ── 弹窗内的报错：标题行内的通用条（吸顶）+ 字段级红字，两者分工明确 ── */
/* 通用消息条跟着公共 .modal-head **整体吸顶**（不再自己做第二个 sticky）：
   ① flex-basis:100% 让它独占标题下方的第二行；② 底色必须**不透明**，
   否则半透明底会让滚上来的字段文字透出；③ 外观取公共 .err-bar，此处只调排布。 */
.modal.wide.site-modal > .modal-head > .form-msg { flex-basis: 100%; margin: 0; }
/* .field-err / .err-bar（含抖动动画与 prefers-reduced-motion 降级）已提到 main.css
   公共规则；本页只保留 CA 指引的步骤式样。 */
.ca-actions { display: flex; gap: 10px; margin: 0 0 18px; }
.ca-steps { display: flex; flex-direction: column; gap: 14px; }
.ca-step-h { font-weight: 600; font-size: var(--fs-13); margin-bottom: 6px; color: var(--c-primary); }
.ca-step p { margin: 0 0 6px; font-size: var(--fs-12-5); line-height: 1.65; }
.ca-code { margin: 6px 0; padding: 9px 11px; border-radius: 8px; font-size: var(--fs-12); line-height: 1.6;
  overflow-x: auto; background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text); }
.ssl-opt { display: flex; align-items: flex-start; gap: 9px; padding: 9px 11px; border: 1px solid var(--c-border); border-radius: 8px; margin-bottom: 8px; cursor: pointer; font-size: var(--fs-13); line-height: 1.5; }
.ssl-opt:has(input:checked) { border-color: var(--c-primary); background: var(--c-primary-soft); }
.ssl-opt input { width: auto; margin-top: 2px; }
/* SSL 证书区块：位于「编辑站点」弹窗内，与 WAF 同用虚线分隔，表明它是站点配置的一部分 */
.ssl { margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px; }
.ssl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.ssl-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); }
.ssl-list { display: flex; flex-direction: column; gap: 8px; }
.ssl-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 11px;
  border: 1px solid var(--c-border); border-radius: 8px; background: var(--c-hover); }
.ssl-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ssl-meta .mono { font-family: var(--mono); font-size: var(--fs-13); }
.ssl-ops { display: flex; align-items: center; gap: 6px; flex: none; }
.ca-link { margin-top: 10px; }
/* 自定义配置片段（019）：与 WAF / SSL 同范式（虚线分隔 = 站点配置的一部分）。
   原文用等宽字体；只读态（非 owner）仍可选中复制。 */
.cc { margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px; }
.cc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.cc-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); }
.cc-text { width: 100%; min-height: 96px; resize: vertical; font-size: var(--fs-12); line-height: 1.55; }
.cc-note { margin: 6px 0 0; }
/* 高级配置（020）：与 WAF / SSL 同范式（虚线分隔 = 站点配置的一部分）。
   内部是纵向堆叠的几个字段：选项多、且 HSTS 勾开后还会长出附加项，
   做成两列网格反而会让跟随出现的输入框跳位。 */
.adv { margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px;
  display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; row-gap: 11px; align-items: start; }
/* 卡片内简单输入框双列；标题 / 整宽文本域 / 提示 / 日志操作条跨两列 */
/* 同 .sector：必须整条 margin 归零，否则 .modal .blk 的 margin-top:12px 与 row-gap 叠加 */
.modal-body .adv > .blk { margin: 0; }
.modal-body .adv > .adv-head,
.modal-body .adv > .blk.full,
.modal-body .adv > .adv-row.full,
.modal-body .adv > .hint-note,
.modal-body .adv > .adv-note,
.modal-body .adv > .adv-warn,
.modal-body .adv > .log-actions,
.modal-body .adv > .log-confirm { grid-column: 1 / -1; }
.adv-head { margin-bottom: 6px; }
.adv-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); }
.adv-row { margin-bottom: 8px; }
.adv-row select { width: 100%; margin-top: 4px; }
.adv-text { width: 100%; min-height: 74px; resize: vertical; font-size: var(--fs-12); line-height: 1.55; margin-top: 4px; }
.adv-warn { margin: 6px 0 8px; }
.adv-note { margin: 8px 0 0; }
/* 021：IP 黑名单在白名单非空时禁用 + 视觉降权 */
.is-dim { opacity: .5; }
.is-dim textarea { pointer-events: none; }
/* 021：站点日志操作区 + 内联清空确认条 */
.log-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 0; }
.log-confirm {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  margin: 8px 0 0; padding: 8px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--c-danger, #e5484d) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-danger, #e5484d) 35%, transparent);
  font-size: var(--fs-12); color: var(--c-text);
}
.log-confirm > span { flex: 1 1 auto; min-width: 180px; }
/* 窄视口（弹窗 ≈ 96vw 已不足 ~760px）回退单列：双列会被输入框宽度挤爆，
   且全宽项保持跨两列也无害（单列下本就整宽）。 */
@media (max-width: 760px) {
  .modal.wide.site-modal .modal-body .sector,
  .modal.wide.site-modal .modal-body .adv { grid-template-columns: 1fr; }
  .modal.wide.site-modal .modal-body .sector > .blk,
  .modal.wide.site-modal .modal-body .adv > .blk { grid-column: auto; }
  /* 窄屏 rail 转顶部横向 tab：176px 固定宽在 96vw 弹窗里会吃掉约 1/4 内容宽度 */
  .modal.wide.site-modal > .modal-mid { flex-direction: column; }
  .modal.wide.site-modal .nav-rail { width: auto; flex: none; flex-direction: row;
    overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--c-border); padding: 8px 10px; }
  .modal.wide.site-modal .nav-item { width: auto; white-space: nowrap; padding: 6px 12px; }
}
/* 矮窗（≤600px 高）：纵向 rail + 内容区双层滚动操作路径太长，同样转横向 tab 把高度让给内容 */
@media (max-height: 600px) {
  .modal.wide.site-modal > .modal-mid { flex-direction: column; }
  .modal.wide.site-modal .nav-rail { width: auto; flex: none; flex-direction: row;
    overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--c-border); padding: 8px 10px; }
  .modal.wide.site-modal .nav-item { width: auto; white-space: nowrap; padding: 6px 12px; }
}
/* 根目录字段下的「站点根目录」边界说明 */
.root-hint { display: block; margin-top: 5px; }
.root-hint code { font-size: var(--fs-12); }
/* 路由表条数无上限会让分区无限增长，给可视上限、滚动收在表内 */
.routes { max-height: 45vh; overflow-y: auto; }
/* 标题层级统一：区块标题一律 13px/600（.routes-title 原 12.5px 比同级低半级） */
.routes-title { font-size: var(--fs-13); }
/* 模板 chip 选中态加强：此前选中只改边框 + 浅底，与 hover（仅改边框）几乎分不出来 */
.tpl-chip.is-on { color: var(--c-primary); font-weight: 600; box-shadow: inset 0 0 0 1px var(--c-primary); }
/* 卡片列表行补 hover：表行有 tbody tr:hover，证书行 / 版本行此前完全没反馈 */
.ssl-row:hover { background: var(--c-active); }

</style>
