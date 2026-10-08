<script setup lang="ts">
/**
 * WAF 总览（统一管理入口）。
 *
 * 站点 WAF 本来就是 nginx 配置的一部分——与站点配置**同一次 apply** 下发，
 * 真正的配置项入口在「网站 → 编辑站点」弹窗里。本页只是把各站的 WAF
 * 状态收到一屏，可就地调整并应用，省去逐个打开编辑弹窗。
 *
 * 与后端严格对齐的两条语义（与 SitesView 一致，勿改）：
 * - `waf` 缺省 = 保留库中现值（不是关闭）→ 本页**总是显式下发** `waf` 段；
 * - `rate_per_sec: 0` = 不限速；`burst` 仅在限速时才有意义（不限速却带 burst
 *   会被后端 400 —— 那属于"配了但没生效"的静默失败，后端刻意拒绝）。
 *
 * ⚠️ 已知副作用（如实写在界面上，不藏着）：后端 apply 的 upsert 会把站点
 *    `enabled` 置 1，所以**已停用的站点**在本页禁用「应用」，
 *    避免用户只想改 WAF 却被静默启用站点。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, type Site } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'

/** 每站点一份草稿：就地编辑，点「应用」才下发 */
interface Draft { on: boolean; profile: string; rate: number; burst: number }

const auth = useAuthStore()
const sites = ref<Site[]>([])
const drafts = ref<Record<number, Draft>>({})
const error = ref('')
const notice = ref('')
const busyId = ref<number | null>(null)

const canManage = computed(() => auth.can('site.manage'))
const webSupported = computed(() => auth.supported(CAP.WEBSERVER_MANAGE))
// 下发 WAF 就是下发 nginx 配置 → 与 SitesView 的 canApply 同款门禁
const canApply = computed(() => webSupported.value && canManage.value)

function toDraft(s: Site): Draft {
  return {
    on: s.waf_enabled,
    profile: s.waf_profile ?? 'basic',
    rate: s.waf_rate_per_sec ?? 0,
    burst: s.waf_burst ?? 0,
  }
}

async function load() {
  error.value = ''; notice.value = ''
  try {
    sites.value = await api.get<Site[]>(API.sites.list())
    // 每次加载都重置草稿：下拉/输入是"当前生效值"的镜像，不留上次未应用的脏值
    drafts.value = Object.fromEntries(sites.value.map(s => [s.id, toDraft(s)]))
  } catch (e) { error.value = errorText(e) }
}

/** 是否有未应用的改动 */
function dirty(s: Site): boolean {
  const d = drafts.value[s.id]; if (!d) return false
  if (d.on !== s.waf_enabled) return true
  return d.on && (d.profile !== (s.waf_profile ?? 'basic')
    || d.rate !== (s.waf_rate_per_sec ?? 0)
    || d.burst !== (s.waf_burst ?? 0))
}

async function applyWaf(s: Site) {
  const d = drafts.value[s.id]; if (!d) return
  busyId.value = s.id; error.value = ''; notice.value = ''
  try {
    const waf = !d.on
      ? { enabled: false }
      : {
          enabled: true,
          profile: d.profile,
          rate_per_sec: d.rate,           // 0 = 不限速（后端语义）
          // burst 只在限速且有值时下发，缺省让后端按 rate×2 计算
          ...(d.rate > 0 && d.burst > 0 ? { burst: d.burst } : {}),
        }
    // 其余字段原样回传：apply 是"期望状态"覆盖，漏传 upstreams/fpm 会把反代/PHP
    // 站的后端地址清空（migration 009 已落库，列表里拿得到真实值）。
    await api.post(API.sites.apply(), {
      name: s.name,
      domains: s.domains,
      // 后端 root 是必填 String（非 Option），恒有值；此前 `|| s.name` 的兜底
      // 与 SitesView 的 `root: s.root` 不一致，且会静默把空 root 变成站点名
      root: s.root,
      force_https: true,
      kind: s.kind,
      upstreams: s.kind === 'proxy' ? (s.upstreams ?? []) : undefined,
      fpm: s.kind === 'php' ? (s.fpm ?? '') : undefined,
      waf,
    })
    notice.value = d.on ? `已为 ${s.name} 应用 WAF（${d.profile}）` : `已关闭 ${s.name} 的 WAF`
    await load()
  } catch (e) {
    if (isUnsupported(e)) notice.value = '当前环境未接入 Web 服务器，无法应用配置'
    else error.value = errorText(e)
  } finally { busyId.value = null }
}

function kindLabel(k: string): string {
  if (k === 'proxy') return '反代'
  if (k === 'php') return 'PHP'
  return '静态'
}

/** 停用站点不可应用的原因（后端 apply 会把它置为启用） */
function blockedReason(s: Site): string {
  if (!canApply.value) return webSupported.value ? '无 site.manage 权限' : '当前环境未接入 Web 服务器'
  if (!s.enabled) return '站点已停用；应用配置会一并启用它，请先启用站点'
  return ''
}

onMounted(load)
</script>

<template>
  <div class="view">
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div class="sec-head">
      <Icon name="firewall" :size="16" /> 站点 WAF
      <span class="spacer" />
      <button class="btn-ghost" :disabled="!sites.length" @click="load">
        <Icon name="refresh" :size="15" /> 刷新
      </button>
    </div>

    <EmptyState v-if="!sites.length && !error" title="暂无站点"
      desc="先在「网站」建站，再回来统一配置 WAF" />

    <div v-else-if="sites.length" class="card flush">
      <table>
        <thead>
          <tr>
            <th>站点</th><th>域名</th><th>类型</th><th>WAF</th>
            <th>档位</th><th>CC 限速</th><th>突发桶</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in sites" :key="s.id">
            <td>{{ s.name }}</td>
            <td class="mono dim">{{ s.domains.join(', ') }}</td>
            <td>{{ kindLabel(s.kind) }}</td>
            <td>
              <input type="checkbox" v-model="drafts[s.id].on"
                :disabled="!canApply || !s.enabled" :title="blockedReason(s)" />
            </td>
            <td>
              <select v-if="drafts[s.id].on" v-model="drafts[s.id].profile"
                :disabled="!canApply || !s.enabled">
                <option value="basic">基础</option>
                <option value="strict">严格</option>
              </select>
              <span v-else class="dim">—</span>
            </td>
            <td>
              <input v-if="drafts[s.id].on" v-model.number="drafts[s.id].rate"
                type="number" min="0" max="1000" class="num"
                :disabled="!canApply || !s.enabled" />
              <span v-else class="dim">—</span>
            </td>
            <td>
              <input v-if="drafts[s.id].on" v-model.number="drafts[s.id].burst"
                type="number" min="0" max="10000" class="num"
                :disabled="!canApply || !s.enabled || !drafts[s.id].rate"
                :title="drafts[s.id].rate > 0 ? '0 = 由后端按 rate×2 计算' : '需先启用限速'" />
              <span v-else class="dim">—</span>
            </td>
            <td>
              <button class="btn-primary" :disabled="!canApply || !s.enabled || !dirty(s) || busyId === s.id"
                :title="blockedReason(s) || (dirty(s) ? '' : '无改动')" @click="applyWaf(s)">
                {{ busyId === s.id ? '应用中…' : '应用' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="tip">
      WAF 与站点配置<b>同一次下发</b>（它本来就是 nginx 配置的一部分）：规则集由系统内置，
      此处只能选档位与数值。基础档拦 SQLi / XSS / 路径穿越 / 敏感文件探测 / 恶意 UA；
      严格档追加空 UA 与非白名单方法，<b>误杀率更高</b>故不作默认。限速超限返回
      <code>429</code>，<code>/.well-known</code> 始终放行——否则会把 ACME 证书续期打死。
      <b>已停用的站点不可在此应用</b>：后端应用配置会一并启用站点。
    </p>
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 14px; }
.sec-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.spacer { flex: 1; }
.num { width: 92px; }
.dim { color: var(--c-text-dim); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.btn-ghost {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
  border: 1px solid var(--c-border); border-radius: 8px; background: transparent;
  color: var(--c-text-dim); cursor: pointer; font-size: 13px; font-family: inherit;
}
.btn-ghost:hover:not(:disabled) { background: var(--c-hover); color: var(--c-text); }
.btn-ghost:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary {
  padding: 6px 14px; border: none; border-radius: 8px; cursor: pointer;
  background: var(--gradient); color: #fff; font-size: 13px; font-family: inherit; font-weight: 600;
}
.btn-primary:disabled { opacity: .45; cursor: not-allowed; }
.err { color: var(--c-danger); font-size: 13px; }
.notice {
  color: var(--c-ok); background: var(--c-ok-soft);
  border: 1px solid color-mix(in srgb, var(--c-ok) 35%, transparent);
  padding: 8px 12px; border-radius: 8px; font-size: 13px;
}
.tip { color: var(--c-text-dim); font-size: 12.5px; line-height: 1.7; }
</style>
