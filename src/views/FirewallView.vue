<script setup lang="ts">
/**
 * 防火墙。
 *
 * 三个刻意的安全设计：
 * 1. 表单只允许 Allow（放行端口）。封禁端口是"把自己锁在门外"的主因，
 *    需要单独的高危流程 + 输入端口确认词，MVP 不提供图形入口。
 * 2. 提交前展示"本次将放行哪些端口"，让用户看清再点。
 * 3. 后端在 apply 前会无条件做快照并在失败时回滚，UI 明确告知这一点。
 */
import { ref, onMounted, computed, nextTick } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fwActionLabel, fwBackendLabel, fwProtocolLabel } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from '@/composables/useToast'

interface Rule {
  id: string; ports: string; protocol: string; action: string
  direction: string; source: string | null; comment: string | null; panel_managed: boolean
}

const auth = useAuthStore()
const rules = ref<Rule[]>([])
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
const source = ref('')
const comment = ref('')

async function load() {
  error.value = ''
  // 请求级门控：能力位为 no 时后端返 501。template 里的 EmptyState 只挡渲染，
  // 不挡请求——不 gate 的话用户先看到红色报错再看到"不支持"，体验割裂。
  if (!auth.supported(CAP.FIREWALL_MANAGE)) return
  try {
    const r = await api.get<{ backend: string; active: boolean; rules: Rule[] }>(API.firewall.rules())
    backend.value = r.backend; active.value = r.active
    // 兜底：后端无规则时可能返 null（表格的 sorted/统计都假定是数组）
    rules.value = r.rules ?? []
  } catch (e) { error.value = errorText(e) }
}

const canManage = computed(() => auth.enabled(CAP.FIREWALL_MANAGE, 'firewall.manage'))

async function apply() {
  busy.value = true; error.value = ''
  try {
    const r = await api.post<{ added: number; removed: number; unchanged: number; warnings: string[] }>(
      API.firewall.rules(),
      { rules: [{ ports: ports.value, protocol: 'tcp', action: 'allow',
                  source: source.value || undefined, comment: comment.value || undefined }] })
    warn.value = r.warnings?.length ? r.warnings.join('；') : ''
    ports.value = ''; source.value = ''; comment.value = ''
    load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

/** 待确认的关闭动作（审计 U5：window.confirm → ConfirmDialog）。开启无风险不需确认。 */
const confirmOff = ref(false)

// 原实现把「关闭」与「启用」压在一个 toggleActive 里：关闭分支置 confirmOff 后
// 直接 return，而确认框回调又指回同一函数 → active 仍为 true，永远走不到发请求的
// 分支（且模板里根本没有 confirmOff 对应的确认框，点了完全没反应）；
// 同时「启用」分支的 body 写死 enabled:false，点启用实际是下发关闭。
// 现拆成：按钮只决定「要不要先确认」，实际下发统一走 setActive(on)。
function toggleActive() {
  if (active.value) { confirmOff.value = true; return }
  void setActive(true)
}

async function setActive(on: boolean) {
  busy.value = true
  try { await api.put(API.firewall.setEnabled(), { enabled: on }); load() }
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
  busy.value = true
  try {
    await api.del(API.firewall.removeRule(r.id))
    delTarget.value = null
    await load()
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = false }
}

// ── fail2ban 入侵防御（与防火墙相邻，复用 FIREWALL_MANAGE 门控）──
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
  if (!auth.supported(CAP.FIREWALL_MANAGE)) return
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
  const want = (e.target as HTMLInputElement).checked
  jailBusy.value = j.name
  try {
    await api.post(API.firewall.fail2banJail(), { name: j.name, enabled: want })
    j.enabled = want
    toast(`已${want ? '启用' : '停用'} jail「${j.name}」`)
  } catch (err) {
    j.enabled = !want // 回滚 UI
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

onMounted(() => { load(); loadFail2ban() })
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <!-- 无可用后端时 `active/backend` 从未被赋值（请求被门控挡掉），此时若照常渲染
             「未启用 / 后端：—」，会被读成"防火墙关了，点『启用』就行"——而真实情况是
             根本没有受支持的后端。故不支持时给出「不可用」，原因交给下方 EmptyState 说明。 -->
        <template v-if="auth.supported(CAP.FIREWALL_MANAGE)">
          <span class="badge" :class="active ? 'badge-ok' : 'badge-danger'">{{ active ? '已启用' : '未启用' }}</span>
          <span class="badge">后端：{{ fwBackendLabel(backend) }}</span>
        </template>
        <span v-else class="badge">不可用</span>
      </div>
      <span class="spacer" />
      <button class="btn-ghost" :disabled="busy || !canManage" @click="toggleActive">{{ active ? '关闭' : '启用' }}</button>
      <button class="btn-primary" :disabled="busy" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <EmptyState v-if="!auth.supported(CAP.FIREWALL_MANAGE)"
      title="未检测到受支持的防火墙后端"
      hint="面板不会自行创建防火墙规则"
      :reason="auth.capabilities[CAP.FIREWALL_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="warn" class="warn" role="status">⚠ {{ warn }}</p>

      <section class="card" ref="allowCard">
        <div class="sec-head"><Icon name="firewall" :size="16" /> 放行端口</div>
        <div class="row">
          <label>端口
            <input v-model="ports" placeholder="80,443 或 8000-8100" />
          </label>
          <label>来源（可选）
            <input v-model="source" placeholder="0.0.0.0/0 或留空" />
          </label>
          <label>备注
            <input v-model="comment" placeholder="web" />
          </label>
          <button class="btn-primary" :disabled="busy || !canManage || !ports" @click="apply">应用</button>
        </div>
        <RiskBanner level="warn" title="仅支持放行（allow）"
          text="封禁端口可能导致 SSH 失联，需通过命令行操作。后端会在变更前自动快照，失败时回滚。" />
      </section>

      <div class="card flush" v-if="rules.length">
        <table class="fixed">
          <!-- 列宽（站点表范式）：来源为唯一弹性列；方向列窄屏隐藏（.col-opt，恒为入站/出站枚举）。 -->
          <colgroup>
            <col class="w-fwport" /><col class="w-fwproto" /><col class="w-fwact" /><col class="w-fwdir" /><col class="w-fwsrc" /><col class="w-fwcmt" /><col class="w-fwown" /><col class="w-fwacts" />
          </colgroup>
          <thead><tr><th>端口</th><th>协议</th><th>动作</th><th class="col-opt">方向</th><th>来源</th><th>备注</th><th>归属</th><th /></tr></thead>
          <tbody>
            <tr v-for="r in rules" :key="r.id">
              <td class="mono">{{ r.ports }}</td>
              <td>{{ fwProtocolLabel(r.protocol) }}</td>
              <td><span class="badge" :class="r.action === 'allow' ? 'badge-ok' : 'badge-danger'">{{ fwActionLabel(r.action) }}</span></td>
              <td class="col-opt">{{ r.direction === 'in' ? '入站' : '出站' }}</td>
              <td class="mono">{{ r.source ?? '任意' }}</td>
              <td class="dim ellipsis" :title="r.comment ?? ''">{{ r.comment ?? '—' }}</td>
              <td class="nowrap">
                <span v-if="r.panel_managed" class="badge badge-primary">面板管理</span>
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
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="暂无规则">
        <template #cta>
          <button class="btn-primary btn-sm" @click="focusAllow">放行第一个端口</button>
        </template>
      </EmptyState>

      <!-- fail2ban 入侵防御：与防火墙同一能力门控；未装时 f2b.available=false 走空态 -->
      <section class="card f2b" v-if="auth.supported(CAP.FIREWALL_MANAGE)">
        <div class="sec-head"><Icon name="shield" :size="16" /> fail2ban 入侵防御
          <span v-if="f2b" class="badge" :class="f2b.active ? 'badge-ok' : 'badge-dim'">{{ f2b.active ? '运行中' : '未运行' }}</span>
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
                <label class="switch-row">
                  <span class="switch">
                    <input type="checkbox" :checked="j.enabled" :disabled="!canManage || jailBusy === j.name"
                      @change="toggleJail(j, $event)" /><i />
                  </span>
                </label>
              </div>
              <div class="f2b-ips" v-if="j.banned_ips.length">
                <span class="dim tiny">已封禁：</span>
                <span class="ip-chip" v-for="ip in j.banned_ips" :key="ip">
                  <span class="mono">{{ ip }}</span>
                  <button class="ip-x" type="button" :disabled="!canManage || unbanBusy === `${j.name}|${ip}`"
                    :title="`解封 ${ip}`" @click="unban(j.name, ip)">
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
    </template>

    <ConfirmDialog :open="confirmOff" danger title="关闭防火墙"
      detail="关闭后面板创建的所有放行规则将不再生效，正在放行的端口（含 SSH）会随后端策略变化，可能导致无法远程连接。请确认你了解此操作的后果。"
      @confirm="setActive(false)" @cancel="confirmOff = false" />

    <ConfirmDialog :open="!!delTarget" danger title="删除防火墙规则"
      :detail="delTarget ? `将删除 ${delTarget.direction === 'in' ? '入站' : '出站'} ${delTarget.ports}/${delTarget.protocol}（${delTarget.action}）${delTarget.comment ? ' · ' + delTarget.comment : ''}。后端会先快照，失败时自动回滚。` : ''"
      @confirm="doDelete" @cancel="delTarget = null" />

    <ConfirmDialog :open="confirmOff" danger title="关闭防火墙"
      detail="关闭后本机所有端口将直接对外暴露，不再有任何过滤。确认继续？"
      @confirm="toggleActive" @cancel="confirmOff = false" />
  </div>
</template>

<style scoped>
/* 规则表列宽（站点表范式）：来源为唯一弹性列；操作列 100px 容下「删除」。 */
col.w-fwport { width: 10%; }
col.w-fwproto { width: 8%; }
col.w-fwact { width: 8%; }
col.w-fwdir { width: 7%; }
col.w-fwsrc { width: auto; }
col.w-fwcmt { width: 16%; }
col.w-fwown { width: 11%; }
col.w-fwacts { width: 100px; }

/* ── fail2ban 入侵防御 ── */
.f2b-list { display: flex; flex-direction: column; gap: 10px; }
.f2b-jail { border: 1px solid var(--c-border); border-radius: 10px; padding: 10px 12px; background: var(--c-surface-2); }
.f2b-jail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.f2b-name { font-weight: 600; font-size: 13px; }
.f2b-stats { font-size: 12px; }
.f2b-ips { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ip-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border: 1px solid var(--c-border-strong); border-radius: 999px; background: var(--c-bg); font-size: 12px; }
.ip-x { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: 0; border-radius: 50%; background: transparent; color: var(--c-text-dim); cursor: pointer; }
.ip-x:hover:not(:disabled) { background: var(--c-danger-soft); color: var(--c-danger); }
.ip-x:disabled { opacity: .5; cursor: not-allowed; }
.badge-dim { background: var(--c-surface-2); color: var(--c-text-dim); border: 1px solid var(--c-border); }
.tiny { font-size: 12px; }
/* 开关（与 CronView / SitesView 自动续期同一套外观：实心主色底 + 白滑块 42×24） */
.switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--c-text-dim); cursor: pointer; user-select: none; }
.switch { position: relative; display: inline-block; width: 42px; height: 24px; flex: none; }
.switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.switch i { position: absolute; inset: 0; border-radius: 999px; background: var(--c-border-strong); transition: background .15s; pointer-events: none; }
.switch i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s; }
.switch input:checked + i { background: var(--c-primary); }
.switch input:checked + i::after { transform: translateX(18px); }
.switch input:disabled { cursor: not-allowed; }
</style>
