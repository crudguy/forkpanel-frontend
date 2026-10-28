<script setup lang="ts">
/**
 * 公网暴露向导。
 *
 * ## 这一页在解决什么问题
 *
 * 面板默认只监听 `127.0.0.1`（零暴露默认）。要让没摸过命令行的用户开公网，
 * 原来只能让他 SSH 进去跑 `deploy/expose-public.sh -d 域名 -a 网段`。这一页把
 * 那次调用搬到网页上——但它**只是壳**：所有 fail-closed 判断（拒 `0.0.0.0/0`、
 * 拒在已裸奔时再装反代、端口探测不可信即拒）仍由脚本自己做，前端不重写、
 * 不"优化"、不替用户放宽。
 *
 * ## 三个刻意的设计
 *
 * 1. **不做表单级校验复制**。域名与 CIDR 的合法性唯一事实源是后端
 *    `panel_core::expose`（与 CLI、与脚本同源）。前端只在「空值就别提交」这种
 *    层面拦一下；复制一份规则必然漂移，而漂移的那份会让人按错误规则提交，
 *    再收到一个看不懂的 400。
 *
 * 2. **能力位 ≠ 已暴露**。`EXPOSE_MANAGE` 只代表「具备开启条件」（有机 nginx +
 *    脚本已装 + 面板跑在 root）。真实状态一律看 `/system/expose/status` 的
 *    `exposed` / `tls`。混用会让人把「能开」读成「已经开了」——在安全页这是
 *    最危险的一类误读。
 *
 * 3. **开启与撤销都要先看后果**。开启 = 把 root 面板挂到公网上（来源限制是唯一
 *    的闸门），撤销 = 可能让自己正在用的入口失效。两者都走 ConfirmDialog 复述
 *    后果，不用 `window.confirm`。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, unsupportedReason, type ExposeStatus, type ExposeApplyReq } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from '@/composables/useToast'

const auth = useAuthStore()

const status = ref<ExposeStatus | null>(null)
const error = ref('')
const busy = ref(false)

// ── 表单状态 ──
const domain = ref('')
/** 出口 IP / 网段，多行。刻意用 textarea 而非标签输入：用户通常从别处粘一串。 */
const allowText = ref('')

/** TLS 方式：none=不启用 HTTPS / self_signed=现场自签 / custom=已有证书 */
type TlsMode = 'none' | 'self_signed' | 'custom'
const tlsMode = ref<TlsMode>('none')
/** 用 X-Forwarded 场景才会用到，默认信任脚本的默认行为 */
const noFirewall = ref(false)
const fullchain = ref('')
const key = ref('')

async function load() {
  error.value = ''
  // 请求级门控：能力不支持时后端 status 仍返 200（以便本页说清原因），
  // 但 apply/remove 会 501。这里照常取状态——它正是"为什么不能用"的来源。
  busy.value = true
  try {
    status.value = await api.get<ExposeStatus>(API.system.expose.status())
  } catch (e) {
    if (isUnsupported(e)) status.value = null
    else error.value = errorText(e)
  } finally { busy.value = false }
}

const canManage = computed(() => auth.enabled(CAP.EXPOSE_MANAGE, 'system.manage'))
const capReason = computed(() => unsupportedReason(auth.capabilities, CAP.EXPOSE_MANAGE))

/** 把 textarea 拆成网段数组（去空行、去首尾空格）。 */
function parsedAllow(): string[] {
  return allowText.value.split('\n').map(s => s.trim()).filter(Boolean)
}

/** 脚本输出（成功或失败都可能有，失败时是唯一的信息来源）。 */
const output = ref('')
const outputTitle = ref('')

const confirmApply = ref(false)
const confirmRemove = ref(false)

/** 提交前的后果摘要：让用户在点确认前看清"将把什么挂到公网"。 */
const applySummary = computed(() => {
  const list = parsedAllow()
  const tlsLabel = tlsMode.value === 'self_signed' ? '自签证书（浏览器会告警）'
    : tlsMode.value === 'custom' ? '已有证书'
    : '不启用 HTTPS'
  return `将把面板通过 https://${domain.value || '（未填域名）'} 对外提供访问`
    + `（TLS：${tlsLabel}），只允许来源：${list.join('、') || '（未填）'}。`
    + `名单之外的请求一律拒绝；面板将不再只监听回环地址。`
})

function prepareApply() {
  if (!canManage.value) return
  if (!domain.value.trim()) { error.value = '请填写对外域名'; return }
  if (!parsedAllow().length) { error.value = '至少要给一个来源网段——留空等于把 root 面板开放给全网'; return }
  if (tlsMode.value === 'custom' && (!fullchain.value.trim() || !key.value.trim())) {
    error.value = '证书链与私钥必须成对填写（或改用自签）'; return
  }
  error.value = ''
  confirmApply.value = true
}

async function doApply() {
  confirmApply.value = false
  busy.value = true; error.value = ''
  const body: ExposeApplyReq = {
    domain: domain.value.trim(),
    allow: parsedAllow(),
    self_signed: tlsMode.value === 'self_signed',
    fullchain: tlsMode.value === 'custom' ? fullchain.value.trim() : null,
    key: tlsMode.value === 'custom' ? key.value.trim() : null,
    no_firewall: noFirewall.value,
  }
  try {
    const r = await api.post<{ domain: string; output: string }>(API.system.expose.apply(), body)
    outputTitle.value = `已在 ${r.domain} 开启公网访问`
    output.value = r.output ?? ''
    toast('公网访问已开启')
    await load()
  } catch (e) {
    // 失败不是"静默没了"：脚本的 stdout/stderr 就是用户唯一能看到的原因，
    // 后端把它拼在错误信息里，这里原样展示（不止 toast 一闪而过）。
    outputTitle.value = '开启失败'
    output.value = errorText(e)
    error.value = ''
  } finally { busy.value = false }
}

async function doRemove() {
  confirmRemove.value = false
  busy.value = true; error.value = ''
  try {
    const r = await api.post<{ output: string }>(API.system.expose.remove())
    outputTitle.value = '已撤销公网访问'
    output.value = r.output ?? ''
    toast('已撤销公网访问')
    await load()
  } catch (e) {
    outputTitle.value = '撤销失败'
    output.value = errorText(e)
  } finally { busy.value = false }
}

onMounted(load)
</script>

<template>
  <div class="expose-view">
    <EmptyState v-if="!auth.supported(CAP.EXPOSE_MANAGE)"
      title="当前环境不支持公网暴露向导"
      hint="公网暴露需要 nginx、expose-public.sh 脚本，且面板以 root 运行"
      :reason="capReason ?? undefined" />

    <template v-else>
      <div class="tools-row">
        <div class="status-line">
          <span class="badge" :class="status?.exposed ? 'badge-warn' : 'badge-ok'">
            {{ status?.exposed ? '正在对外暴露' : '仅本机可访问' }}
          </span>
          <span v-if="status?.exposed" class="badge" :class="status.tls ? 'badge-ok' : 'badge-danger'">
            {{ status.tls ? 'HTTPS 已启用' : '无 HTTPS' }}
          </span>
          <span v-if="status && !status.script_installed" class="badge badge-danger">脚本缺失</span>
        </div>
        <span class="spacer" />
        <RefreshBtn :disabled="busy" @click="load" />
      </div>

      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <RiskBanner v-if="status && !status.script_installed" level="danger"
        title="expose-public.sh 未安装"
        text="没有这个脚本就无法改 nginx 与防火墙，向导的开关会失败。重跑 install.sh 或手动把 deploy/expose-public.sh 装到 /usr/local/share/forkpanel/ 后刷新本页。" />

      <!-- 已暴露态：先给"怎么访问 / 怎么撤"，表单收起来避免误改 -->
      <section v-if="status?.exposed" class="card">
        <div class="sec-head"><Icon name="globe" :size="16" /> 公网访问已开启</div>
        <p class="tip">
          面板当前通过 nginx 反向代理对外提供访问，来源受限。<b>撤销</b>后会退回到只监听
          回环地址，SSH 隧道照常可用。
        </p>
        <RiskBanner level="warn" title="撤销前请确认你还有别的入口"
          text="撤销会移除本页写入的 nginx 配置与 systemd drop-in。如果你此刻正是通过这个公网域名操作面板，撤销后当前页面会失效——请先准备好 SSH 隧道或本机访问。" />
        <div class="row">
          <button class="btn-ghost danger" :disabled="busy || !canManage"
            :title="canManage ? '' : '无 system.manage 权限'"
            @click="confirmRemove = true">撤销公网访问</button>
        </div>
      </section>

      <!-- 未暴露态：向导表单 -->
      <section v-else-if="status" class="card">
        <div class="sec-head"><Icon name="network" :size="16" /> 开启公网访问</div>
        <p class="tip">
          面板默认只监听 <code>127.0.0.1</code>。开启后会由 nginx 反向代理对外提供访问，
          并用防火墙把来源限制在你填写的网段内。
        </p>

        <div class="form">
          <label class="field">
            <span class="lbl">对外域名 <em>必填</em></span>
            <input v-model="domain" placeholder="panel.example.com" autocomplete="off" />
            <span class="hint">至少两级，且顶级域不能是数字（防止把 IP 填进来）。需已解析到本机。</span>
          </label>

          <label class="field">
            <span class="lbl">允许访问的来源网段 <em>必填</em></span>
            <textarea v-model="allowText" rows="3"
              placeholder="203.0.113.10&#10;198.51.100.0/24" />
            <span class="hint">
              一行一个，IPv4 或 IPv4/CIDR。<b>名单之外的请求一律拒绝</b>——这是唯一的闸门，
              请把掩码写小而不是图省事填 <code>0.0.0.0/0</code>（脚本会直接拒绝）。
            </span>
          </label>

          <div class="field">
            <span class="lbl">HTTPS</span>
            <div class="radios">
              <label class="radio"><input v-model="tlsMode" type="radio" value="none" /> 不启用</label>
              <label class="radio"><input v-model="tlsMode" type="radio" value="self_signed" /> 自签证书</label>
              <label class="radio"><input v-model="tlsMode" type="radio" value="custom" /> 用已有证书</label>
            </div>
            <span v-if="tlsMode === 'self_signed'" class="hint warn-hint">
              自签证书没有可信第三方背书，浏览器会显示"非私密连接"。仅适合临时或内网自用。
            </span>
          </div>

          <template v-if="tlsMode === 'custom'">
            <label class="field">
              <span class="lbl">证书链路径 <em>与私钥成对</em></span>
              <input v-model="fullchain" placeholder="/etc/ssl/certs/panel.fullchain.pem" class="mono" />
            </label>
            <label class="field">
              <span class="lbl">私钥路径</span>
              <input v-model="key" placeholder="/etc/ssl/private/panel.key" class="mono" />
              <span class="hint">两个都给才算数；只给一个后端会拒绝（避免静默回退成自签）。</span>
            </label>
          </template>

          <label class="check">
            <input v-model="noFirewall" type="checkbox" />
            不自动放行防火墙端口
            <span class="hint">勾选后由你自己放行 80/443；面板不碰防火墙规则。</span>
          </label>
        </div>

        <div class="row">
          <button class="btn-primary" :disabled="busy || !canManage"
            :title="canManage ? '' : '无 system.manage 权限'"
            @click="prepareApply">开启公网访问</button>
        </div>
      </section>

      <p v-else-if="busy" class="tip">读取状态中…</p>

      <!-- 脚本输出：成功给个"它做了什么"的交代，失败给唯一的排查线索 -->
      <section v-if="output" class="card">
        <div class="sec-head"><Icon name="file" :size="16" /> {{ outputTitle }}</div>
        <pre class="output">{{ output }}</pre>
        <button class="btn-ghost btn-sm" @click="output = ''">收起</button>
      </section>
    </template>

    <ConfirmDialog :open="confirmApply" danger title="确认开启公网访问"
      :detail="applySummary"
      @confirm="doApply" @cancel="confirmApply = false" />

    <ConfirmDialog :open="confirmRemove" danger title="确认撤销公网访问"
      detail="将移除本向导写入的 nginx 反代配置与 systemd drop-in，面板退回只监听 127.0.0.1。若你正通过公网域名访问面板，撤销后本页会立即失效。"
      @confirm="doRemove" @cancel="confirmRemove = false" />
  </div>
</template>

<style scoped>
.expose-view { display: flex; flex-direction: column; gap: 4px; }
.status-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.form { display: flex; flex-direction: column; gap: 14px; margin: 4px 0 14px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: var(--fs-13); color: var(--c-text); font-weight: 600; }
.lbl em { font-style: normal; font-weight: 400; font-size: var(--fs-12); color: var(--c-text-dim); margin-left: 6px; }
.hint { font-size: var(--fs-12); color: var(--c-text-dim); line-height: 1.6; }
.hint code { font-family: var(--mono); background: color-mix(in srgb, var(--c-border) 60%, transparent);
  padding: 1px 4px; border-radius: 4px; }
.warn-hint { color: var(--c-warn); }
textarea { font-family: var(--mono); resize: vertical; }
.radios { display: flex; gap: 16px; flex-wrap: wrap; }
.radio { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-13); cursor: pointer; }
.check { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13); cursor: pointer; flex-wrap: wrap; }
.check .hint { margin-left: 2px; }

.output {
  margin: 0 0 10px; padding: 12px; max-height: 340px; overflow: auto;
  background: var(--c-surface-2); border: 1px solid var(--c-border); border-radius: 8px;
  font-family: var(--mono); font-size: var(--fs-12); line-height: 1.6;
  color: var(--c-text); white-space: pre-wrap; word-break: break-word;
}
</style>
