<script setup lang="ts">
/**
 * 防火墙。
 *
 * 三个刻意的安全设计：
 * 1. 表单支持 Allow/Deny/Reject。封禁端口是"把自己锁在门外"的主因，
 *    命中当前 SSH 端口时不再允许"确认后硬封"，而是必须先填写一个新端口：
 *    面板先把 SSH 迁过去并放行，再封禁旧端口，任一步失败全程回滚。
 *    受保护端口集由后端 GET /rules 现读下发，前端不猜端口——否则 SSH
 *    改到 2222 后会继续盯 22，保护错位。
 * 2. 提交前用确认弹窗展示"本次将封禁哪些端口 / 来源"，让用户看清再点（prepareApply 实现）。
 * 3. 后端在 apply 前会无条件做快照并在失败时回滚，UI 明确告知这一点。
 */
import { ref, onMounted, computed, nextTick, watch } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fwActionLabel, fwBackendLabel, fwProtocolLabel } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
import { useTableControls, type SortColumn } from '@/composables/useTableControls'
import { toast } from '@/composables/useToast'
import { matchFields } from '@/composables/listSearch'
import { parsePorts, hitsProtectedPort, applyConfirm, needsMigration, newPortError, applyToast, portExposure, portExposureLabel, type FirewallAction } from '@/composables/firewallRules'

interface Rule {
  id: string; ports: string; protocol: string; action: string
  direction: string; source: string | null; comment: string | null; panel_managed: boolean
}

const auth = useAuthStore()
const rules = ref<Rule[]>([])

// ── 规则表：分页 + 排序（全站表格约定，共享 useTableControls / SortTh / TablePager）──
/** 端口是字符串，且可能是 "80" / "80,443" / "8000-8100"：取首个数字按数值比较
 *  （`Number("80,443")` 是 NaN，直接相减会让整列顺序失效）；解析不出数字的排最后。 */
function portNum(s: string): number {
  const m = /^\d+/.exec((s ?? '').trim())
  return m ? Number(m[0]) : Infinity
}
const ruleSortCols: SortColumn<Rule>[] = [
  { key: 'ports', dir: 'asc', compare: (a, b) => { const x = portNum(a.ports), y = portNum(b.ports); return x === y ? 0 : x - y } },
  { key: 'protocol', dir: 'asc', compare: (a, b) => (a.protocol ?? '').localeCompare(b.protocol ?? '') },
  { key: 'action', dir: 'asc', compare: (a, b) => (a.action ?? '').localeCompare(b.action ?? '') },
  { key: 'direction', dir: 'asc', compare: (a, b) => (a.direction ?? '').localeCompare(b.direction ?? '') },
  { key: 'source', dir: 'asc', compare: (a, b) => (a.source ?? '').localeCompare(b.source ?? '') },
  { key: 'comment', dir: 'asc', compare: (a, b) => (a.comment ?? '').localeCompare(b.comment ?? '') },
  { key: 'panel_managed', dir: 'asc', compare: (a, b) => Number(a.panel_managed) - Number(b.panel_managed) },
]
// 默认按端口升序：这张表的常见用途是查「某端口放没放行」，升序让同端口族（22/80/443、
// 8000-8100）彼此相邻；同时给出稳定顺序，不必依赖后端每次返回的排列。
// 规则表本地检索：端口 / 来源 / 备注 / 协议都是肉眼定位规则时用的字段。
// 协议存的是枚举值，故同时匹配 label（用户会搜「tcp」「TCP」，也会搜中文显示名）。
const q = ref('')
const filteredRules = computed(() => rules.value.filter(r => matchFields(q.value, [
  r.ports, r.source, r.comment, r.protocol, fwProtocolLabel(r.protocol),
])))
const { size, page, pageCount, pageRows, total, sortDir, toggleSort, changeSize, gotoPage, isSorted } =
  useTableControls<Rule>({
    rows: filteredRules, defaultSize: 100, defaultSort: { key: 'ports', dir: 'asc' }, columns: ruleSortCols,
    persistKey: 'firewall.rules',
  })
/** 改搜索词回第一页 */
watch(q, () => { page.value = 1 })

const backend = ref('')
const active = ref(false)
const error = ref('')
/** 警告通道：后端 warnings（部分生效/部分忽略）不是失败，不当错误渲染 */
const warn = ref('')
const busy = ref(false)
/** 空态「放行端口」CTA：滚动到放行表单 */
const allowCard = ref<HTMLElement | null>(null)
function focusAllow() {
  nextTick(() => allowCard.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
const ports = ref('80,443')
const action = ref<FirewallAction>('allow')
/** 后端现读 sshd 配置下发的受保护端口；前端不自行推断 SSH 端口 */
const protectedPorts = ref<number[]>([])
/** 只读观察值：面板链的默认策略 + 本机监听端口，解释「为什么列表里没有 22」 */
const defaultPolicy = ref<string | null>(null)
const listeningPorts = ref<number[]>([])
/** 封禁 SSH 端口时必需的新端口：先迁移过去再封禁，避免失联 */
const newSshPort = ref('')
/** 实时判定：填中 SSH 端口就展开新端口输入行，不必先点「应用」才知道要迁移 */
const migrationRequired = computed(() =>
  needsMigration(action.value, hitsProtectedPort(parsePorts(ports.value, action.value), protectedPorts.value))
)
const source = ref('')
const comment = ref('')

async function load() {
  error.value = ''
  // 请求级门控：能力位为 no 时后端返 501。template 里的 EmptyState 只挡渲染，
  // 不挡请求——不 gate 的话用户先看到红色报错再看到"不支持"，体验割裂。
  if (!auth.supported(CAP.FIREWALL_MANAGE)) return
  try {
    const r = await api.get<{ backend: string; active: boolean; rules: Rule[]; protected_ports?: number[]; default_policy?: string | null; listening_ports?: number[] }>(API.firewall.rules())
    backend.value = r.backend; active.value = r.active
    // 兜底：后端无规则时可能返 null（表格的 sorted/统计都假定是数组）
    rules.value = r.rules ?? []
    // 旧后端/读失败时为空：后端 apply 仍会独立兜底拦截，前端只是提前提示
    protectedPorts.value = r.protected_ports ?? []
    // 旧后端没有这两个字段时保持 null/[]，UI 如实显示「读不到」，不猜放行/封禁
    defaultPolicy.value = r.default_policy ?? null
    listeningPorts.value = r.listening_ports ?? []
    loaded.value = true
  } catch (e) { loaded.value = false; error.value = errorText(e) }
}

/** 本机监听端口 + 由显式规则与默认策略推断的状态（只读观察值，不是可删规则） */
const listeningRows = computed(() => [...listeningPorts.value]
  .sort((a, b) => a - b)
  .map(port => ({ port, exposure: portExposure(port, rules.value, defaultPolicy.value) })))

const canManage = computed(() => auth.enabled(CAP.FIREWALL_MANAGE, 'firewall.manage'))
/** fail2ban 按钮的门控：后端只要求 firewall.manage 权限 + FAIL2BAN 能力（后者由区块 v-if 保证） */
const canF2b = computed(() => auth.can('firewall.manage'))
/** 是否成功读到过真实状态：失败时不能把「未知」渲染成「未启用」（会诱导用户去点启用） */
const loaded = ref(false)

async function apply() {
  busy.value = true; error.value = ''; confirmAllow.value = false; fieldErrs.value = {}
  // 清空前留一份：提示文案要说清处理了哪些端口，下面几行就把 ports 清掉了
  const applied = ports.value
  const act = action.value
  const parsed = parsePorts(applied, act)
  const migrate = needsMigration(act, hitsProtectedPort(parsed, protectedPorts.value))
  const newPort = newSshPort.value.trim()
  try {
    // 兜底：有人绕过 prepareApply 直接触发提交时，仍要拦住缺失/不安全的新端口。
    if (migrate) {
      const reason = newPortError(newPort, parsed, protectedPorts.value)
      if (reason) { fieldErrs.value = { newPort: reason }; return }
    }
    const r = await api.post<{ added: number; removed: number; unchanged: number; warnings: string[]; ssh_migrated_to?: number }>(
      API.firewall.rules(),
      { rules: [{ ports: applied, protocol: 'tcp', action: act,
                  source: source.value || undefined, comment: comment.value || undefined }],
        // 封禁 SSH 端口时后端要求新端口做迁移；放行/普通封禁绝不传
        new_ssh_port: migrate ? Number(newPort) : undefined })
    warn.value = r.warnings?.length ? r.warnings.join('；') : ''
    ports.value = ''; source.value = ''; comment.value = ''; newSshPort.value = ''
    // 后端幂等：同一规则重复提交计 unchanged、added 为 0。不区分的话用户会以为"又加了一条"。
    toast(r.ssh_migrated_to
      ? `已将 SSH 迁移到端口 ${r.ssh_migrated_to}，请用新端口重新连接`
      : applyToast(act, applied, r.added))
    // await：重载完成前 busy 保持 true，否则这段窗口里用户能再点一次
    await load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

// P1：放行端口校验 + 提交前确认（注释设计点 2 的落地）
const confirmAllow = ref(false)
const allowSummary = ref('')
const allowTitle = ref('确认放行端口')
const allowDanger = ref(false)
const allowErr = ref('')
/** 字段级校验错误：就近挂在出问题的那个输入框下方。
 *  校验规则与文案原样不动，只改落点；allowErr 只留归属不到具体输入框的错误。 */
const fieldErrs = ref<Partial<Record<'ports' | 'source' | 'newPort', string>>>({})
function clearFieldErr(k: 'ports' | 'source' | 'newPort') {
  if (fieldErrs.value[k]) delete fieldErrs.value[k]
}
function validSource(s: string): boolean {
  if (!s.trim()) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(s.trim())
  if (!m) return false
  // IPv4 每段 0-255，并拒绝前导零（01 这类写法在部分后端语义不同）
  const octets = [m[1], m[2], m[3], m[4]]
  if (octets.some(o => (o.length > 1 && o.startsWith('0')) || Number(o) > 255)) return false
  if (m[5] !== undefined) {
    // 前缀长度必须 0-32；同时拒绝 00/01 这类前导零写法
    if (m[5].length > 1 && m[5].startsWith('0')) return false
    if (Number(m[5]) > 32) return false
  }
  return true
}
function prepareApply() {
  allowErr.value = ''
  fieldErrs.value = {}
  if (!canManage.value) return
  const p = parsePorts(ports.value, action.value)
  if (!p.ok) { fieldErrs.value = { ports: p.msg! }; return }
  if (!validSource(source.value)) { fieldErrs.value = { source: '来源格式无效（应为 IPv4 或 IPv4/CIDR，如 1.2.3.4 或 1.2.3.0/24）' }; return }
  const highRisk = migrationRequired.value
  if (highRisk) {
    // 命中 SSH 时新端口必填且必须安全：拦在弹窗之前，别让用户确认完才发现无效
    const reason = newPortError(newSshPort.value, p, protectedPorts.value)
    if (reason) { fieldErrs.value = { newPort: reason }; return }
  }
  const c = applyConfirm(action.value, ports.value, source.value, highRisk)
  allowTitle.value = c.title
  allowSummary.value = c.detail
  allowDanger.value = c.danger
  confirmAllow.value = true
}

/** 待确认的关闭动作（审计 U5：window.confirm → ConfirmDialog）。开启无风险不需确认。 */
const confirmOff = ref(false)

// 原实现把「关闭」与「启用」压在一个 toggleActive 里：关闭分支置 confirmOff 后
// 直接 return，而确认框回调又指回同一函数 → active 仍为 true，永远走不到发请求的
// 分支（且模板里根本没有 confirmOff 对应的确认框，点了完全没反应）；
// 同时「启用」分支的 body 写死 enabled:false，点启用实际是下发关闭。
// 现拆成：按钮只决定「要不要先确认」，实际下发统一走 setActive(on)。
function toggleActive() {
  // 状态未知时 active 是首屏默认 false，照旧切换会把「读失败」当成「未启用」，
  // 一次点击可能反向关掉正在运行的防火墙。按钮已禁用，这里再兜一道程序化触发。
  if (!loaded.value) return
  if (active.value) { confirmOff.value = true; return }
  void setActive(true)
}

async function setActive(on: boolean) {
  // 确认框回调也会走这里：等待确认期间若状态读取失败，同样不许下发。
  if (!loaded.value) return
  busy.value = true
  try {
    await api.put(API.firewall.setEnabled(), { enabled: on })
    toast(on ? '已启用防火墙' : '已关闭防火墙')
    // await：重载完成前 busy 保持 true，避免这段窗口里重复切换
    await load()
  }
  catch (e) { error.value = errorText(e) }
  finally { busy.value = false; confirmOff.value = false }
}

// ── 删除规则 ──
// 只允许删面板自己创建的（后端同样会拒绝用户自建规则，这里是双保险）：
// 删掉用户手动加的防火墙规则，等于替用户拆掉他自己的安全措施。
const delTarget = ref<Rule | null>(null)
function askDelete(r: Rule) { if (r.panel_managed) delTarget.value = r }

async function doDelete() {
  const r = delTarget.value
  if (!r) return
  // 关框后 delTarget 就清空了，提示文案必须先从规则上取下来（规则无 name，用方向+端口/协议）
  const label = `${r.direction === 'in' ? '入站' : '出站'} ${r.ports}/${r.protocol}`
  busy.value = true
  try {
    await api.del(API.firewall.removeRule(r.id))
    delTarget.value = null
    toast(`已删除规则 ${label}`)
    await load()
  // 失败也关框：否则确认框继续盖着、错误在遮罩后，用户只看到「点了没反应」
  } catch (e) { delTarget.value = null; toast(`删除规则失败：${errorText(e)}`, 'err') }
  finally { busy.value = false }
}

// ── fail2ban 入侵防御（独立能力位 fail2ban.manage 门控；按 fail2ban-client 是否安装判定，与防火墙后端正交）──
interface Jail {
  name: string; enabled: boolean
  currently_failed: number; total_failed: number; banned: number
  banned_ips: string[]
}
const f2b = ref<{ available: boolean; active: boolean; jails: Jail[] } | null>(null)
const f2bError = ref('')
const f2bBusy = ref(false)
const jailBusy = ref<string | null>(null)   // 正在切换的 jail 名
const unbanBusy = ref<string | null>(null)  // 正在解封的 `${jail}|${ip}`

async function loadFail2ban() {
  f2bError.value = ''
  if (!auth.supported(CAP.FAIL2BAN)) return
  f2bBusy.value = true
  try {
    const r = await api.get<{ available: boolean; active: boolean; jails: Jail[] }>(API.firewall.fail2ban())
    f2b.value = { available: r.available, active: r.active, jails: r.jails ?? [] }
  } catch (e) {
    // 未装 fail2ban-client 时后端返 501：不当硬错误，降级为「未安装」空态
    if (isUnsupported(e)) f2b.value = { available: false, active: false, jails: [] }
    else f2bError.value = errorText(e)
  } finally { f2bBusy.value = false }
}

// 启停某 jail：读取复选框当前值（:checked + @change，避免 v-model 竞态），失败时回滚
async function toggleJail(j: Jail, e: Event) {
  const cb = e.target as HTMLInputElement
  const want = cb.checked
  const prev = j.enabled
  jailBusy.value = j.name
  try {
    await api.post(API.firewall.fail2banJail(), { name: j.name, enabled: want })
    j.enabled = want
    toast(`已${want ? '启用' : '停用'} jail「${j.name}」`)
  } catch (err) {
    // :checked 单向绑定：j.enabled 仍是 prev，Vue 不重绘 DOM，须显式把勾选框拨回，
    // 否则 UI 显示已开启但后端未改——安全开关尤其不能"撒谎"。
    cb.checked = prev
    j.enabled = prev
    f2bError.value = errorText(err)
  } finally { jailBusy.value = null }
}

// 解封某 jail 下指定 IP（截断封禁，不影响其它 IP）
async function unban(jail: string, ip: string) {
  const key = `${jail}|${ip}`
  unbanBusy.value = key
  try {
    await api.post(API.firewall.fail2banUnban(), { jail, ip })
    const j = f2b.value?.jails.find(x => x.name === jail)
    if (j) { j.banned_ips = j.banned_ips.filter(x => x !== ip); j.banned = Math.max(0, j.banned - 1) }
    toast(`已解封 ${ip}（${jail}）`)
  } catch (e) { f2bError.value = errorText(e) }
  finally { unbanBusy.value = null }
}

// jail 封禁参数（运行期值；面板不写 jail.local，重启后回落）
interface JailParams {
  jail: string; maxretry: number; bantime: number; findtime: number; persistent: boolean
}
const paramsJail = ref<string | null>(null)
const paramsDraft = ref({ maxretry: 5, bantime: 600, findtime: 600 })
const paramsBusy = ref(false)
const paramsError = ref('')

async function openParams(j: Jail) {
  if (paramsJail.value === j.name) { paramsJail.value = null; return }
  paramsError.value = ''
  paramsBusy.value = true
  try {
    const r = await api.get<JailParams>(API.firewall.fail2banParams(j.name))
    paramsDraft.value = { maxretry: r.maxretry, bantime: r.bantime, findtime: r.findtime }
    paramsJail.value = j.name
  } catch (e) { f2bError.value = errorText(e) }
  finally { paramsBusy.value = false }
}

async function saveParams(j: Jail) {
  paramsBusy.value = true
  paramsError.value = ''
  try {
    await api.post(API.firewall.fail2banParamsSave(), { jail: j.name, ...paramsDraft.value })
    toast(`已更新 jail「${j.name}」的封禁参数`)
    paramsJail.value = null
  } catch (e) { paramsError.value = errorText(e) }
  finally { paramsBusy.value = false }
}

onMounted(() => { load(); loadFail2ban() })
</script>

<template>
  <div>
    <div class="tools-row">
      <div>
        <!-- 无可用后端时 `active/backend` 从未被赋值（请求被门控挡掉），此时若照常渲染
             「未启用 / 后端：—」，会被读成"防火墙关了，点『启用』就行"——而真实情况是
             根本没有受支持的后端。故不支持时给出「不可用」，原因交给下方 EmptyState 说明。 -->
        <template v-if="auth.supported(CAP.FIREWALL_MANAGE)">
          <span class="badge" :class="!loaded ? 'badge-warn' : (active ? 'badge-ok' : 'badge-danger')">{{ !loaded ? '状态未知' : (active ? '已启用' : '未启用') }}</span>
          <span class="badge">后端：{{ fwBackendLabel(backend) }}</span>
        </template>
        <span v-else class="badge">不可用</span>
      </div>
      <span class="spacer" />
      <button class="btn-ghost" :disabled="busy || !canManage || !loaded"
        :title="!loaded ? '状态未知，请点刷新重试' : (canManage ? '' : '无 firewall.manage 权限')"
        @click="toggleActive">{{ !loaded ? '状态未知' : (active ? '关闭' : '启用') }}</button>
      <RefreshBtn :disabled="busy" @click="load" />
    </div>

    <EmptyState v-if="!auth.supported(CAP.FIREWALL_MANAGE)"
      title="未检测到受支持的防火墙后端"
      hint="面板不会自行创建防火墙规则"
      :reason="auth.capabilities[CAP.FIREWALL_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>
      <p v-if="warn" class="warn" role="status">⚠ {{ warn }}</p>

      <section class="card" ref="allowCard">
        <div class="sec-head"><Icon name="firewall" :size="16" /> 端口规则</div>
        <div class="row">
          <label class="fw-form-act">动作
            <select v-model="action" class="fw-action" aria-label="规则动作">
              <option value="allow">放行（allow）</option>
              <option value="deny">拒绝（deny）</option>
              <option value="reject">拒绝并回复（reject）</option>
            </select>
          </label>
          <label class="fw-form-port" :class="{ 'has-err': !!fieldErrs.ports }">端口
            <input v-model="ports" placeholder="80,443 或 8000-8100" :aria-invalid="!!fieldErrs.ports"
              @input="clearFieldErr('ports')" />
            <span v-if="fieldErrs.ports" class="field-err" role="alert">{{ fieldErrs.ports }}</span>
          </label>
          <label class="fw-form-src" :class="{ 'has-err': !!fieldErrs.source }">来源（可选）
            <input v-model="source" placeholder="0.0.0.0/0 或留空" :aria-invalid="!!fieldErrs.source"
              @input="clearFieldErr('source')" />
            <span v-if="fieldErrs.source" class="field-err" role="alert">{{ fieldErrs.source }}</span>
          </label>
          <label class="fw-form-cmt">备注
            <input v-model="comment" placeholder="web" />
          </label>
          <button class="btn-primary" :disabled="busy || !canManage || !ports"
            :title="!canManage ? '无 firewall.manage 权限' : (ports ? '' : '先填写端口')" @click="prepareApply">应用</button>
        </div>
        <!-- 命中 SSH 端口才展开：新端口是迁移目标。面板先迁移并放行它，再封禁旧端口。 -->
        <div v-if="migrationRequired" class="row migrate-row">
          <label :class="{ 'has-err': !!fieldErrs.newPort }">新 SSH 端口（迁移目标）
            <input v-model="newSshPort" class="fw-newport" placeholder="如 2222" inputmode="numeric"
              :aria-invalid="!!fieldErrs.newPort" @input="clearFieldErr('newPort')" />
            <span v-if="fieldErrs.newPort" class="field-err" role="alert">{{ fieldErrs.newPort }}</span>
          </label>
          <p class="migrate-tip">本次封禁含当前 SSH 端口。请填一个不在封禁范围内、且不同于当前端口的新端口；面板会先迁移并放行它，再封禁旧端口，失败自动回滚。</p>
        </div>
        <!-- 仅归属不到某个输入框的错误（无权限等）走整段条；字段校验就近挂在上方各输入框下。 -->
        <p v-if="allowErr" class="err">{{ allowErr }}</p>
        <!-- 说明条是本卡片最后一个元素：传 last 让间距翻到上方，否则会紧贴端口输入行、
             同时把 14px 下边距叠在卡片 padding 上（看上去黏在编辑区底下）。 -->
        <RiskBanner last level="warn" title="封禁端口需二次确认"
          text="封禁当前 SSH 端口会导致失联；命中时必须填写新 SSH 端口，面板先迁移并放行新端口、再封禁旧端口。变更前自动快照，任一步失败全程回滚。" />
      </section>

      <!-- 入站生效状态：回答「为什么规则列表里没有 22」。这些是只读观察值，不是可删除的规则。 -->
      <section class="card exposure-card">
        <div class="sec-head"><Icon name="shield" :size="16" /> 入站生效状态</div>
        <p class="exposure-policy" :class="defaultPolicy === 'accept' ? 'is-open' : ''">
          <template v-if="defaultPolicy === 'accept'">⚠ 入站默认策略：<b>放行（accept）</b>——下方规则表未列出的端口默认可访问，包括当前 SSH 端口。</template>
          <template v-else-if="defaultPolicy === 'drop' || defaultPolicy === 'reject'">入站默认策略：<b>拒绝（{{ defaultPolicy }}）</b>——只有下方显式放行的端口可访问。</template>
          <template v-else>入站默认策略：<b>读不到</b>——无法判断未列端口状态，请以服务器实际配置为准。</template>
        </p>
        <p class="exposure-hint">封禁规则（deny/reject）优先生效：新封禁会插到规则链首，与下方列表的排序无关；要放行已被封禁的端口，需先删除对应封禁规则。</p>
        <template v-if="listeningRows.length">
          <p class="exposure-hint">本机对外监听的 TCP 端口（不含仅本机可访问的 127.0.0.1/::1；只读观察值，不对应可删除的规则）：</p>
          <div class="exposure-chips">
            <span v-for="row in listeningRows" :key="row.port" class="exposure-chip">
              <b class="mono">{{ row.port }}</b>
              <span :class="portExposureLabel(row.exposure).tone === 'dim' ? 'badge' : `badge-${portExposureLabel(row.exposure).tone}`">{{ portExposureLabel(row.exposure).text }}</span>
            </span>
          </div>
        </template>
        <p v-else class="tip">读不到本机监听端口（ss 不可用或执行失败），无法列出当前暴露面。</p>
      </section>

      <!-- 卡片按原始规则数渲染：搜不到时表体给独立空态，搜索框仍在，用户能就地清空 -->
      <div class="card flush toolbar-card" v-if="rules.length">
        <div class="card-toolbar">
          <span class="count">
            <template v-if="q.trim()">找到 {{ filteredRules.length }} / 共 {{ rules.length }} 条规则</template>
            <template v-else>共 {{ rules.length }} 条规则</template>
          </span>
          <span class="spacer" />
          <input v-model="q" class="filter" type="search" autocomplete="off" placeholder="搜索端口 / 来源 / 备注…"
            aria-label="搜索防火墙规则" />
          <button v-if="q" class="btn-ghost btn-sm" type="button" title="清空搜索" @click="q = ''">清空</button>
        </div>
        <div class="t-scroll">
        <table class="fixed" v-table-nav>
          <!-- 列宽（站点表范式）：来源为唯一弹性列；方向列窄屏隐藏（.col-opt，恒为入站/出站枚举）。 -->
          <colgroup>
            <col class="w-fwport" /><col class="w-fwproto" /><col class="w-fwact" /><col class="w-fwdir" /><col class="w-fwsrc" /><col class="w-fwcmt" /><col class="w-fwown" /><col class="w-fwacts" />
          </colgroup>
          <thead><tr>
            <SortTh label="端口" :active="isSorted('ports')" :dir="sortDir" @sort="toggleSort('ports')" />
            <SortTh label="协议" :active="isSorted('protocol')" :dir="sortDir" @sort="toggleSort('protocol')" />
            <SortTh label="动作" :active="isSorted('action')" :dir="sortDir" @sort="toggleSort('action')" />
            <SortTh class="col-opt" label="方向" :active="isSorted('direction')" :dir="sortDir" @sort="toggleSort('direction')" />
            <SortTh label="来源" :active="isSorted('source')" :dir="sortDir" @sort="toggleSort('source')" />
            <SortTh label="备注" :active="isSorted('comment')" :dir="sortDir" @sort="toggleSort('comment')" />
            <SortTh label="归属" :active="isSorted('panel_managed')" :dir="sortDir" @sort="toggleSort('panel_managed')" />
            <th />
          </tr></thead>
          <tbody>
            <tr v-for="r in pageRows" :key="r.id">
              <td class="mono">{{ r.ports }}</td>
              <td>{{ fwProtocolLabel(r.protocol) }}</td>
              <td><span class="badge" :class="r.action === 'allow' ? 'badge-ok' : 'badge-danger'">{{ fwActionLabel(r.action) }}</span></td>
              <td class="col-opt">{{ r.direction === 'in' ? '入站' : '出站' }}</td>
              <td class="mono">{{ r.source ?? '任意' }}</td>
              <td class="dim ellipsis" :title="r.comment ?? ''">{{ r.comment ?? '—' }}</td>
              <td class="nowrap">
                <span v-if="r.panel_managed" class="badge">面板管理</span>
                <span v-else class="badge" title="面板不会删除用户自建规则">用户自建</span>
              </td>
              <td class="nowrap">
                <button class="btn-ghost btn-sm danger" :disabled="busy || !canManage || !r.panel_managed"
                  :title="r.panel_managed ? '删除此规则' : '用户自建规则不可删除'"
                  @click="askDelete(r)">
                  <Icon name="trash" :size="14" /> 删除
                </button>
              </td>
            </tr>
            <tr v-if="!pageRows.length"><td colspan="8">
              <EmptyState :title="`没有匹配「${q.trim()}」的规则`"
                hint="换个关键词，或清空搜索查看全部规则。">
                <template #cta>
                  <button class="btn-ghost" type="button" @click="q = ''">清空搜索</button>
                </template>
              </EmptyState>
            </td></tr>
          </tbody>
        </table>
        </div>
        <TablePager :total="total" :page="page" :size="size" :page-count="pageCount"
          @update:page="gotoPage" @update:size="changeSize" />
      </div>
      <EmptyState v-else-if="!rules.length" title="暂无规则">
        <template #cta>
          <button class="btn-primary" :disabled="!canManage"
            :title="canManage ? '' : '无 firewall.manage 权限'" @click="focusAllow">放行第一个端口</button>
        </template>
      </EmptyState>

    </template>

    <!-- fail2ban 入侵防御：独立能力位 fail2ban.manage 门控（按 fail2ban-client 是否安装判定，与防火墙后端正交）；未装时 f2b.available=false 走空态。
         必须在「防火墙不支持」的 v-else 之外——它是独立能力位，不能让防火墙后端缺失把它一起隐藏。 -->
    <section class="card f2b" v-if="auth.supported(CAP.FAIL2BAN)">
      <div class="sec-head"><Icon name="shield" :size="16" /> fail2ban 入侵防御
        <span v-if="f2b" class="badge" :class="f2b.active ? 'badge-ok' : ''">{{ f2b.active ? '运行中' : '未运行' }}</span>
      </div>

      <p v-if="f2bError" class="err" role="alert">{{ f2bError }}</p>

      <template v-if="f2b && f2b.available">
        <p v-if="!f2b.jails.length" class="tip">尚未启用任何 jail。安装 fail2ban 后通常需在 <code>jail.local</code> 中启用具体服务（如 sshd）才会开始监控。</p>
        <div v-else class="f2b-list">
          <div class="f2b-jail" v-for="j in f2b.jails" :key="j.name">
            <div class="f2b-jail-head">
              <span class="mono f2b-name">{{ j.name }}</span>
              <span class="f2b-stats dim">失败 {{ j.currently_failed }} / 累计 {{ j.total_failed }} · 封禁 {{ j.banned }}</span>
              <span class="spacer" />
              <button class="btn-ghost btn-sm" type="button" :disabled="!canF2b || paramsBusy"
                :title="`配置 ${j.name} 的封禁参数`" @click="openParams(j)">
                {{ paramsJail === j.name ? '收起' : '参数' }}
              </button>
              <label class="switch-row">
                <span class="switch">
                  <input type="checkbox" :checked="j.enabled" :disabled="!canF2b || jailBusy === j.name"
                    @change="toggleJail(j, $event)" /><i />
                </span>
              </label>
            </div>
            <div v-if="paramsJail === j.name" class="f2b-params">
              <label>失败次数 <input v-model.number="paramsDraft.maxretry" type="number" min="1" max="10000" /></label>
              <label>封禁秒数 <input v-model.number="paramsDraft.bantime" type="number" min="1" max="2592000" /></label>
              <label>统计窗口 <input v-model.number="paramsDraft.findtime" type="number" min="1" max="2592000" /></label>
              <button class="btn-primary btn-sm" type="button" :disabled="!canF2b || paramsBusy"
                @click="saveParams(j)">保存</button>
              <p class="tip">仅运行期生效；重启 fail2ban 后回落 jail.local。</p>
              <p v-if="paramsError" class="err" role="alert">{{ paramsError }}</p>
            </div>
            <div class="f2b-ips" v-if="j.banned_ips.length">
              <span class="dim tiny">已封禁：</span>
              <span class="ip-chip" v-for="ip in j.banned_ips" :key="ip">
                <span class="mono">{{ ip }}</span>
                <button class="ip-x" type="button" :disabled="!canF2b || unbanBusy === `${j.name}|${ip}`"
                  :aria-label="`解封 ${ip}`" :title="`解封 ${ip}`" @click="unban(j.name, ip)">
                  <Icon name="close" :size="12" />
                </button>
              </span>
            </div>
          </div>
        </div>
      </template>

      <EmptyState v-else-if="f2b && !f2b.available" title="未检测到 fail2ban"
        hint="本机未安装 fail2ban-client，无法在此管理入侵封禁。装好后刷新即可。" />
      <p v-else-if="f2bBusy" class="tip">加载中…</p>
    </section>

    <ConfirmDialog :open="confirmOff" danger title="关闭防火墙"
      detail="关闭后面板创建的所有放行规则将不再生效，正在放行的端口（含 SSH）会随后端策略变化，可能导致无法远程连接。请确认你了解此操作的后果。"
      @confirm="setActive(false)" @cancel="confirmOff = false" />

    <ConfirmDialog :open="!!delTarget" danger title="删除防火墙规则"
      :detail="delTarget ? `将删除 ${delTarget.direction === 'in' ? '入站' : '出站'} ${delTarget.ports}/${delTarget.protocol}（${delTarget.action}）${delTarget.comment ? ' · ' + delTarget.comment : ''}。后端会先快照，失败时自动回滚。` : ''"
      @confirm="doDelete" @cancel="delTarget = null" />

    <ConfirmDialog :open="confirmAllow" :danger="allowDanger" :title="allowTitle"
      :detail="allowSummary"
      @confirm="apply" @cancel="confirmAllow = false" />

    <!-- ⚠️ 此前这里还挂着**第二个**同样 `:open="confirmOff"` 的确认框（detail 与
         @confirm 各不相同）：点一次「关闭」会同时弹两个矛盾的确认框——一个说
         「规则将不再生效、可能影响 SSH」，另一个说「所有端口直接暴露」。而后者
         的 @confirm 又回调 `toggleActive`，该函数在 active 为真时只会再把
         confirmOff 置回 true，等于点了没反应。保留上面那条（文案更准确、直接调
         setActive(false)），删掉这一个。 -->
  </div>
</template>

<style scoped>
/* 规则表列宽（站点表范式）：实测内容宽 + 唯一弹性列，禁百分比。
   百分比会让弹性列在宽屏吸走全部余量（实测 1440 下来源 360px 全是空白、
   1024 下动作被压到 59.5px 截断「拒绝并回复」）。按字体实测的内容需求
   （含 26px 单元格 padding）定固定列：端口 41 / 协议 27 / 动作 27 /
   方向 27 / 归属 54，各留排序箭头与徽章余量；来源承载 CIDR 作唯一弹性列。 */
col.w-fwport { width: 96px; }
col.w-fwproto { width: 72px; }
col.w-fwact { width: 76px; }
col.w-fwdir { width: 68px; }
col.w-fwsrc { width: auto; }
col.w-fwcmt { width: 120px; }
col.w-fwown { width: 104px; }
col.w-fwacts { width: 100px; }
/* 宽屏档（>=1440）：8 列全定宽，避免来源列独吞余量（实测仅定宽时 1920 下来源
   涨到 1004px、全是空白）。table-layout:fixed 下 Chrome 把容器余量按这些宽度
   等比分给每一列（同 WafView 的成熟做法），各列一起放大而不失衡。
   ⚠ 断点与列宽绑定：总和 1120px <= 1440 视口实测表宽 1150px，否则这一档横滚；
   ⚠ 基础档必须排在 @media 之前：scoped 编译后特异性相同、谁在后谁赢。 */
@media (min-width: 1440px) {
  col.w-fwport { width: 120px; }
  col.w-fwproto { width: 96px; }
  col.w-fwact { width: 96px; }
  col.w-fwdir { width: 88px; }
  col.w-fwsrc { width: 320px; }
  col.w-fwcmt { width: 180px; }
  col.w-fwown { width: 120px; }
  col.w-fwacts { width: 100px; }
}

/* 表单行四列按内容需求分配，不再 flex:1 均分（1440 下四列各 254px）：
   动作最长选项实测只需 147px，端口 placeholder 需 147px、实际输入常更长，
   备注实际输入典型 143px。用相对权重让窄屏自动收敛——实测三档：
     1440 → 181 / 305 / 226 / 305
     1280 → 152 / 257 / 190 / 257
     1024 → 140 / 160 / 140 / 160（动作/来源触到全局 min-width:140px 下限）
   ⚠ 别把动作列写死 px：1024 下 168px 会比端口/备注的 146px 还宽，本末倒置。 */
.row > label.fw-form-act  { flex: 0.8 1 0%; }
.row > label.fw-form-port { flex: 1.35 1 0%; }
.row > label.fw-form-src  { flex: 1 1 0%; }
.row > label.fw-form-cmt  { flex: 1.35 1 0%; }

/* 动作下拉必须撑满所在列（width:100%），和端口/来源/备注的输入框左右对齐。
   ⚠ 曾写死 width:128px：label 列宽 254px，下拉右边空出 126px，
   到端口框的视觉间距 136px，而其它列间只有 10px（老板截图圈出的空白）。
   ⚠ 不能写 `flex: 0 0 Npx`：.row > label 是 column flex，主轴=垂直，
   该缩写的 flex-basis 会落在高度上，把 select 撑成 N px 高（实测 45px 错位）。
   flex:none 只锁高度按内容、不碰横向宽度。 */
select.fw-action { width: 100%; flex: none; }

/* 入站生效状态：只读观察值，与下方「可编辑规则表」视觉上明确分开 */
.exposure-card .sec-head { margin-bottom: 8px; }
.exposure-policy { margin: 0 0 8px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--c-surface-2); font-size: var(--fs-13); color: var(--c-text-dim); line-height: 1.5; }
.exposure-policy.is-open { background: var(--c-primary-soft); color: var(--c-primary); }
.exposure-hint { margin: 0 0 8px; font-size: var(--fs-13); color: var(--c-text-dim); }
.exposure-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.exposure-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-sm); font-size: var(--fs-12); }
.exposure-chip .mono { font-weight: 600; }

/* 迁移新端口行：label 是 column flex，锁宽只能 width + flex:none（用 flex 缩写会把
   basis 落到高度上，把输入框撑成 200px）。说明文字同排，窄屏自动折行。 */
.migrate-row { margin-top: 12px; }
.migrate-row > label { width: 200px; flex: none; }
.migrate-tip { flex: 1; min-width: 220px; margin: 0; font-size: var(--fs-13); color: var(--c-text-dim); line-height: 1.5; }

/* ── fail2ban 入侵防御 ── */
.f2b-list { display: flex; flex-direction: column; gap: 10px; }
.f2b-jail { border: 1px solid var(--c-border); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--c-surface-2); }
.f2b-jail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.f2b-name { font-weight: 600; font-size: var(--fs-13); }
.f2b-stats { font-size: var(--fs-12); }
.f2b-ips { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.f2b-params { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--c-border); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.f2b-params label { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-13); color: var(--c-text-dim); }
.f2b-params input { width: 96px; }
.f2b-params .tip { flex-basis: 100%; margin: 0; }
.ip-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border: 1px solid var(--c-border-strong); border-radius: 999px; background: var(--c-bg); font-size: var(--fs-12); }
.ip-x { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: 0; border-radius: 50%; background: transparent; color: var(--c-text-dim); cursor: pointer; }
/* 命中区扩到 28×28（16 + 2×6），视觉圆圈仍是 16px；伪元素随按钮一起接收点击。 */
.ip-x::after { content: ''; position: absolute; inset: -6px; }
.ip-x:hover:not(:disabled) { background: var(--c-danger-soft); color: var(--c-danger); }
.ip-x:disabled { opacity: .5; cursor: not-allowed; }

/* 开关（与 CronView / SitesView 自动续期同一套外观：实心主色底 + 白滑块 42×24） */
.switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-13); color: var(--c-text-dim); cursor: pointer; user-select: none; }
/* 开关样式统一走 main.css 全局 .switch（42×24，input+i 结构）；本视图标记
   <span class="switch"><input><i></i></span> 与之兼容，不再私有重定义。 */
</style>
