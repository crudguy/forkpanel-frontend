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
import { CAP, wafProfileLabel, type Site } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import { toast } from '@/composables/useToast'
import { useAsync } from '@/composables/useAsync'

/** 每站点一份草稿：就地编辑，点「应用」才下发 */
interface Draft { on: boolean; profile: string; rate: number; burst: number }

const auth = useAuthStore()
const sites = ref<Site[]>([])
const drafts = ref<Record<number, Draft>>({})
const { error, loading, run } = useAsync()
const busyId = ref<number | null>(null)
/** 帮助抽屉（A6）：页面头部「?」打开，承载 WAF 完整约束说明 */
const helpOpen = ref(false)

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
  await run(async () => {
    sites.value = await api.get<Site[]>(API.sites.list())
    // 每次加载都重置草稿：下拉/输入是"当前生效值"的镜像，不留上次未应用的脏值
    drafts.value = Object.fromEntries(sites.value.map(s => [s.id, toDraft(s)]))
  })
}

/** 是否有未应用的改动 */
function dirty(s: Site): boolean {
  const d = drafts.value[s.id]; if (!d) return false
  if (d.on !== s.waf_enabled) return true
  return d.on && (d.profile !== (s.waf_profile ?? 'basic')
    || d.rate !== (s.waf_rate_per_sec ?? 0)
    || d.burst !== (s.waf_burst ?? 0))
}

/**
 * 下发体构造——**单站点「应用」与「应用全部」共用**。
 *
 * ⚠️ 抽成函数而不是各写一份：同一约束走两条路径必漏配（项目高频 bug）。
 * 两处都要满足的约束（漏一个就出事故）：
 * - 其余字段原样回传：apply 是「期望状态」覆盖，漏传 upstreams/fpm 会把
 *   反代 / PHP 站的后端地址清空（migration 009 已落库，列表里拿得到真实值）；
 * - `burst` 只在限速且有值时下发，缺省让后端按 rate×2 计算（不限速却带 burst
 *   会被后端 400 —— 那属于「配了但没生效」的静默失败，后端刻意拒绝）。
 */
function applyBody(s: Site, d: Draft) {
  const waf = !d.on
    ? { enabled: false }
    : {
        enabled: true,
        profile: d.profile,
        rate_per_sec: d.rate,           // 0 = 不限速（后端语义）
        ...(d.rate > 0 && d.burst > 0 ? { burst: d.burst } : {}),
      }
  return {
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
  }
}

async function applyWaf(s: Site) {
  const d = drafts.value[s.id]; if (!d) return
  busyId.value = s.id; error.value = ''
  try {
    await api.post(API.sites.apply(), applyBody(s, d))
    toast(d.on ? `已为 ${s.name} 应用 WAF（${wafProfileLabel(d.profile)}）` : `已关闭 ${s.name} 的 WAF`)
    await load()
  } catch (e) {
    if (isUnsupported(e)) toast('当前环境未接入 Web 服务器，无法应用配置', 'warn')
    else error.value = errorText(e)
  } finally { busyId.value = null }
}

/** 「应用全部」的目标：已启用站点中确有改动、且当前环境可下发的那些。 */
const pending = computed(() =>
  sites.value.filter((s) => s.enabled && canApply.value && dirty(s)))
/** 有改动但**不能**下发的（站点已停用）——如实计数并说明，不静默跳过。 */
const blockedPending = computed(() =>
  sites.value.filter((s) => s.enabled === false && dirty(s)).length)
const batchBusy = ref(false)

/**
 * 逐个下发。刻意**不**复用 applyWaf：它每次成功都 `await load()`，而 load 会把
 * 草稿重置成刚落库的值——循环到第二个站点时 drafts 已被换掉，后面的改动会丢失。
 * 故批量走一条不重置草稿的路径，全部跑完再统一 load 一次。
 */
async function applyAll() {
  const targets = pending.value.slice()
  if (!targets.length) return
  batchBusy.value = true; error.value = ''
  let ok = 0
  try {
    for (const s of targets) {
      const d = drafts.value[s.id]; if (!d) continue
      try {
        await api.post(API.sites.apply(), applyBody(s, d))
        ok++
      } catch (e) {
        // 一个失败即停：多半是环境/权限类问题，继续跑只会把后面站点也刷成同样的错
        if (isUnsupported(e)) toast('当前环境未接入 Web 服务器，无法应用配置', 'warn')
        else error.value = `${s.name} 下发失败：${errorText(e)}`
        break
      }
    }
    if (ok) toast(`已应用 ${ok} 个站点的 WAF 配置`)
  } finally { batchBusy.value = false; await load() }
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
    <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>

    <!-- 首屏必须先给骨架：此前本页 `useAsync()` 只解构了 `{ error, run }`，
         请求还在飞就渲染了「暂无…」空态（带 CTA），数据到达后整块跳变；
         且加载失败时列表区与空列表长得一样，用户分不清是"没有"还是"没加载出来"。 -->
    <div v-if="loading && !sites.length" class="skeleton box" />
    <EmptyState v-else-if="!sites.length && !error" title="暂无站点"
      hint="先在「网站」建站，再回来统一配置 WAF">
      <template #cta>
        <RouterLink class="btn-primary btn-sm" to="/sites">去建站</RouterLink>
      </template>
    </EmptyState>

    <div v-else-if="sites.length" class="card flush toolbar-card">
      <div class="card-toolbar">
        <span class="count">共 {{ sites.length }} 个站点</span>
        <span class="spacer" />
        <button class="btn-icon ghost" type="button" title="WAF 说明" aria-label="WAF 说明" @click="helpOpen = true">
          <Icon name="help" :size="16" />
        </button>
        <!-- 有改动但因站点停用而下发不了的，如实计数：不然用户会以为「都改完了」 -->
        <span v-if="blockedPending" class="dim tiny"
          :title="`${blockedPending} 个站点已停用，改动无法下发；应用配置会一并启用该站点`">
          · {{ blockedPending }} 项不可下发
        </span>
        <RefreshBtn :disabled="batchBusy" sm @click="load" />
        <!-- 批量下发：改了多个站点时省去逐个点「应用」 -->
        <button class="btn-primary btn-sm" :disabled="!pending.length || batchBusy" @click="applyAll"
          :title="pending.length ? `一次下发这 ${pending.length} 个站点的改动` : '暂无待下发的改动'">
          <Icon name="check" :size="15" /> 应用全部{{ pending.length ? `（${pending.length}）` : '' }}
        </button>
      </div>
      <!-- 横滚只发生在表格上：卡片已改 overflow:hidden，否则窄屏横滚会把工具条一起带走 -->
      <div class="t-scroll">
      <table class="fixed" aria-label="站点 WAF 配置" v-table-nav>
        <!-- 列宽（站点表范式）：域名为唯一弹性列；CC/突发桶列按控件实测宽（输入框 92px + 内边距）。 -->
        <colgroup>
          <col class="w-wfname" /><col class="w-wfdom" /><col class="w-wfkind" /><col class="w-wfon" /><col class="w-wfprof" /><col class="w-wfrate" /><col class="w-wfburst" /><col class="w-wfacts" />
        </colgroup>
        <thead>
          <!-- scope="col"（审计 A3）；.col-opt 标记次要列，窄屏由公共规则隐藏 -->
          <tr>
            <th scope="col">站点</th><th scope="col">域名</th><th scope="col" class="col-opt">类型</th><th scope="col">WAF</th>
            <th scope="col">档位</th><th scope="col">CC 限速</th><th scope="col" class="col-opt">突发桶</th><th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in sites" :key="s.id">
            <td class="ellipsis" :title="s.name">{{ s.name }}</td>
            <td class="mono dim ellipsis" :title="s.domains.join(', ')">{{ s.domains.join(', ') }}</td>
            <td class="col-opt">{{ kindLabel(s.kind) }}</td>
            <td>
              <!-- aria-label 给出「哪个站点的什么开关」：读屏只念 checkbox 无法定位 -->
              <input type="checkbox" v-model="drafts[s.id].on" :aria-label="`${s.name} 启用 WAF`"
                :disabled="!canApply || !s.enabled" :title="blockedReason(s)" />
            </td>
            <td>
              <select v-if="drafts[s.id].on" v-model="drafts[s.id].profile" :aria-label="`${s.name} 防护档位`"
                :disabled="!canApply || !s.enabled">
                <option value="basic">基础</option>
                <option value="strict">严格</option>
              </select>
              <span v-else class="dim">—</span>
            </td>
            <td>
              <input v-if="drafts[s.id].on" v-model.number="drafts[s.id].rate"
                type="number" min="0" max="1000" class="num" :aria-label="`${s.name} CC 限速（每秒请求数）`"
                :disabled="!canApply || !s.enabled" />
              <span v-else class="dim">—</span>
            </td>
            <td class="col-opt">
              <input v-if="drafts[s.id].on" v-model.number="drafts[s.id].burst"
                type="number" min="0" max="10000" class="num" :aria-label="`${s.name} 突发桶`"
                :disabled="!canApply || !s.enabled || !drafts[s.id].rate"
                :title="drafts[s.id].rate > 0 ? '0 = 由后端按 rate×2 计算' : '需先启用限速'" />
              <span v-else class="dim">—</span>
            </td>
            <td class="acts">
              <button class="btn-primary" :disabled="!canApply || !s.enabled || !dirty(s) || busyId === s.id || batchBusy"
                :title="blockedReason(s) || (dirty(s) ? '' : '无改动')" @click="applyWaf(s)">
                {{ busyId === s.id ? '应用中…' : '应用' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>

    <!-- 完整说明收进帮助抽屉（A6）：底部不再重复长文；「?」在列表卡顶栏。
         浮层组件放链尾：**不得**插在 v-if / v-else 链中间（会打断相邻性，模板编译直接报错）。 -->
    <HelpDrawer :open="helpOpen" title="WAF 说明" @close="helpOpen = false">
      <p>WAF 是站点配置的一部分，与站点配置<b>同一次 apply</b> 下发。本页把各站的 WAF 状态收到一屏，可就地调整并应用，省去逐个打开编辑弹窗。</p>
      <h4>档位</h4>
      <ul>
        <li><b>基础档</b>：拦 SQL 注入 / XSS / 路径穿越 / 敏感文件探测 / 恶意 UA。</li>
        <li><b>严格档</b>：基础档之上追加空 UA 与非白名单方法拦截，<b>误杀率更高</b>，不建议作默认。</li>
      </ul>
      <h4>CC 限速</h4>
      <p><code>rate_per_sec</code> 为 0 表示不限速；设置限速时 <code>burst</code> 才有意义（不限速却带 burst 会被后端拒绝）。超限请求返回 <code>429</code>；<code>/.well-known</code> 路径始终放行——否则会把 ACME 证书续期打死。</p>
      <h4>已知副作用</h4>
      <p>后端 apply 的 upsert 会把站点 <code>enabled</code> 置 1，因此<b>已停用的站点</b>在本页禁用「应用」，避免用户只想改 WAF 却被静默启用站点。</p>
    </HelpDrawer>
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 14px; }
/* 仅保留布局级宽度；按钮 / 文字色 / 区块标题等一律复用 main.css 公共类，
   不再私有重定义（审计 V1：WAF 页自造按钮样式曾与全局漂移）。 */
.num { width: 92px; }
/* 配置表列宽（站点表范式）：域名为唯一弹性列；控件列按实测控件宽定宽
   （CC/突发桶输入框自身 92px + 单元格内边距 26px）。 */
col.w-wfname { width: 10%; }
col.w-wfdom { width: auto; }
col.w-wfkind { width: 7%; }
col.w-wfon { width: 64px; }
col.w-wfprof { width: 104px; }
col.w-wfrate { width: 120px; }
col.w-wfburst { width: 120px; }
col.w-wfacts { width: 130px; }
/* 操作列下限（审计 U-窄屏）：auto 布局下 col 的 width 只是建议，min-width 须落
   在 td 上；单「应用」按钮在窄列里也需保住完整宽，避免「应用中…」被裁。 */
.acts { white-space: nowrap; min-width: 130px; }
</style>
