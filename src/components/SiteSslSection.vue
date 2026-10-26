<script setup lang="ts">
/**
 * 站点「SSL 证书」区（编辑站点弹窗内的 `.ssl` 区块 + 「申请证书」浮层）。
 *
 * 为什么从 SiteFormDialog 里抽出来：这一块自带 5 个动作（申请 / 续期 / 删除 /
 * 自动续期开关 / 信任根证书）与 3 条写接口，且**全部触发点都在块内**——它不需要
 * 知道表单长什么样，只需要知道「作用在哪个站点」「还能不能写」。留在 1470 行的弹窗里
 * 只是让找入口变难（与 SiteConfPanel 同一个理由，同一个边界）。
 *
 * ⚠️ 三处**契约**，改这个文件前先看：
 *
 * 1. **根元素必须用 `class="ssl"`**：`.modal-body .sector > .ssl { grid-column: 1/-1 }`
 *    那条跨列规则住在 SiteFormDialog 的 scoped 样式里，而 scoped 的属性选择器只作用
 *    于**子组件根节点**。若给根元素加插槽 / 加外层 `div` / 换成 `<template>` 多根，
 *    属性就落不到 `.ssl` 上，`grid-column` 静默失效（`1 / -1` → `auto`），而
 *    vue-tsc / build / 单测**全绿**——只有量 computed style 才看得见。
 *
 * 2. **本组件不持有「关不关」**：`site` 为 null 时直接不渲染整个区块（新建站点尚未
 *    落库、无法归属证书）。这是父级的 `v-if`，不是内部状态——父级还要据它决定
 *    「申请证书」按钮要不要显示。
 *
 * 3. **证书来自 props 而非自取**：列表页已经拉过全量证书，这里按站点域名过滤
 *    （证书以 domain 归属站点）。自取会与列表页的 `reload` 形成两条数据源。
 *
 * 浮层 `<SiteSslDialog>` / `<SiteCaHelpDialog>` 都在本组件内部、但**都在区块的
 * `v-if` 之外**（在 `Teleport` 里或同级）：它们各自管自己的开关，且关闭时不能连带
 * 影响区块本体。
 */
import { computed, ref, toRef } from 'vue'
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import {
  certLevel, certSourceLabel, fmtDate, fmtDateTime,
  type Cert, type RenewSweep, type Site,
} from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import SiteCaHelpDialog from '@/components/SiteCaHelpDialog.vue'
import SiteSslDialog from '@/components/SiteSslDialog.vue'

const props = defineProps<{
  /** 作用对象；null = 新建站点尚未落库，整块不渲染 */
  site: Site | null
  /** 全量证书（本组件按站点域名自行过滤） */
  certs: Cert[]
  /** 自动续期扫描状态（展示「上次/下次扫描」） */
  sweep: RenewSweep
  /** 宿主忙碌态（父级正在保存等）：连带禁用本区块动作，避免并发写同一张证书 */
  busy: boolean
  /* ── 能力 / 权限：由父级用 useSiteCaps 算好后传入，本组件不自己再算一份 ── */
  canSsl: boolean
  /** ACME 可用（只影响 ACME 证书的「自动续期」开关是否可点） */
  sslSupported: boolean
  /** 自签可用（决定签发弹窗的默认方式：有自签就默认自签，不必逼用户先配 ACME） */
  selfSignedSupported: boolean
  sslReady: boolean
  sslHint: string
}>()

const emit = defineEmits<{
  /** 需要父级重拉列表：证书数据变了 */
  reload: []
  /** 本层看不到的错误 → 交给父级决定落点（弹窗开着则写弹窗，否则写页面级） */
  'ssl-error': [msg: string]
  /** 同 `ssl-error`，但属「能力未接入」的提示（走中性 toast 而非报错） */
  'ssl-notice': [msg: string]
  /** 忙碌态变化：申请证书这一步会占用宿主的 busy（保存按钮一并置灰） */
  'update:busy': [boolean]
}>()

const editing = computed(() => props.site)
/** 别名让搬过来的代码块**逐字保持原样**（原代码读的就是同名 props）。 */
const sslSupported = toRef(props, 'sslSupported')
const selfSignedSupported = toRef(props, 'selfSignedSupported')
const sslReady = toRef(props, 'sslReady')
const sslHint = toRef(props, 'sslHint')
const canSsl = toRef(props, 'canSsl')

// ── SSL：证书管理 ──
/** 展示「当前站点」的证书：按域名过滤全局证书列表（证书以 domain 归属站点）。 */
const siteCerts = computed<Cert[]>(() =>
  editing.value ? props.certs.filter(c => (editing.value as Site).domains.includes(c.domain)) : [])

/** 自动续期扫描状态摘要：供 SSL 区展示"上次/下次扫描" */
function sweepSummary(): string {
  const s = props.sweep
  if (!s.last_at) return '尚未运行 · 每日约 04:05 自动扫描'
  const fmt = (t: number) => fmtDateTime(t)
  const queued = s.last_queued > 0 ? ` · 上次入队 ${s.last_queued} 张` : ''
  return `上次 ${fmt(s.last_at)} · 下次约 ${fmt(s.next_at)}${queued}`
}

/** SSL 签发弹窗（审计 U6：替代 window.prompt 选方式/填邮箱）。弹窗本体见 <SiteSslDialog>。 */
const sslModal = ref<{ site: Site; method: 'self-signed' | 'http-01'; email: string } | null>(null)

/** 根证书安装指引弹窗。自签证书能被浏览器信任的**唯一**前提是把根 CA 装进信任库。
 *  弹窗本体（含关法与下载动作）见 <SiteCaHelpDialog>。 */
const caHelp = ref(false)

/**
 * 「申请证书」的开窗动作。
 *
 * 只有**两种渠道都可用**时才值得弹窗让用户选；只剩一种时直接执行——给一个"必败选项"
 * 让用户二选一，等于让他点两次才得到同一个结果。
 *
 * ⚠️ 签发失败与「ACME 缺邮箱」的报错由 <SiteSslDialog> 自持（`sslErr`）：
 *   签发弹窗叠在站点区块之上，错误写在这里的 `formError` 会被两层遮罩挡在后面。
 */
function applySsl(s: Site) {
  sslModal.value = { site: s, method: selfSignedSupported.value ? 'self-signed' : 'http-01', email: '' }
}
/** 区块内「申请证书」：作用对象即当前站点。 */
function applySslEditing() {
  if (editing.value) applySsl(editing.value)
}

/**
 * 把证书类错误放到**用户当下真正看得见的那一层**。
 *
 * ⚠️ 本组件**不再知道**那层是弹窗还是页面：这一步只有父级知道（列表行「证书」按钮
 *   触发时弹窗根本没开）。故一律交回父级，由它按 `open` 决定落点——错误信息本身
 *   不在这里被丢弃或改写。
 */
function sslErrTo(msg: string, asNotice = false) {
  if (asNotice) { emit('ssl-notice', msg); return }
  emit('ssl-error', msg)
}

// ── 证书续期（自签同步 / ACME 任务化）/ 删除（纯数据操作）──
const delCert = ref<Cert | null>(null)
async function renewCert(c: Cert) {
  emit('update:busy', true)
  let ok = ''
  try {
    await api.post(API.certs.renew(c.id), {})
    ok = `已续期 ${c.domain} 的证书`
  } catch (e) {
    if (isUnsupported(e)) sslErrTo('当前环境未接入证书续期能力', true)
    else sslErrTo(errorText(e))
  } finally { emit('update:busy', false); emit('reload'); if (ok) toast(ok) }
}
async function setAutoRenew(c: Cert, val: boolean) {
  emit('update:busy', true)
  try {
    await api.patch(API.certs.autoRenew(c.id), { enabled: val })
    c.auto_renew = val
    toast(`${c.domain} 自动续期已${val ? '开启' : '关闭'}`)
  } catch (e) {
    if (isUnsupported(e)) sslErrTo('当前环境未接入 ACME，无法自动续期')
    else sslErrTo(errorText(e))
  } finally { emit('update:busy', false) }
}
async function doDeleteCert() {
  if (!delCert.value) return
  emit('update:busy', true)
  const dom = delCert.value.domain
  try {
    await api.del(API.certs.remove(delCert.value.id))
    delCert.value = null
    emit('reload')
    toast(`已删除证书 ${dom}`)
  } catch (e) {
    // 同 doDelete：失败必须关确认框，否则错误落在遮罩之后、表现为"点了没反应"
    delCert.value = null
    sslErrTo(errorText(e))
  } finally { emit('update:busy', false) }
}

defineExpose({ applySsl })
</script>

<template>
  <!-- SSL 证书：站点配置的一部分，与站点同处一个编辑弹窗
       （此前是页面下方独立的「证书」区块——与应用站点配置同理，单独成块既多余、
        又让「该站点的证书」与「编辑该站点」割裂在两处；现在合并进来，
        申请 / 续期 / 删除 / 自动续期 / 信任根证书全在弹窗内完成）。
        仅编辑既有站点时出现：新建站点尚未落库、无法归属证书。
       ⚠️ 根元素 class 必须留 `ssl`：跨列规则 `.modal-body .sector > .ssl` 靠它命中。 -->
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
    <!-- 删除确认框必须 Teleport 到 body：本组件嵌在站点编辑弹窗内部（`.mask` 50），
         留在原地会被父弹窗的 v-if 子树吞掉（SiteConfPanel 踩过同一个坑）。 -->
    <Teleport to="body">
      <ConfirmDialog :open="!!delCert" danger level2 title="删除证书"
        :detail="delCert ? `将删除证书「${delCert.domain}」。` : ''"
        confirm-word="删除" @confirm="doDeleteCert" @cancel="delCert = null" />
    </Teleport>
  </div>

  <!-- 两个浮层与区块**平级**、各自独立挂载：区块的 `v-if` 关掉时它们不该受影响
       （信任根证书说明与签发弹窗都是独立动作）。 -->
  <SiteCaHelpDialog v-model:open="caHelp" />
  <SiteSslDialog :req="sslModal" :busy="busy"
    @update:req="(v) => sslModal = v" @update:busy="(v) => emit('update:busy', v)" @reload="emit('reload')" />
</template>

<style scoped>
.cert-sweep { margin: 0 0 10px; padding-left: 2px; }
/* SSL 证书区块：位于「编辑站点」弹窗内，与 WAF 同用虚线分隔，表明它是站点配置的一部分。
   ⚠️ `grid-column: 1 / -1` 必须写在这里（本组件自己的 scoped 样式）。
   原先它写在 SiteFormDialog 的 `.modal-body .sector > .ssl` 里，以为 scoped 会给
   **子组件根节点**补上父级的 data-v——**实测不会**：`.ssl` 上只有本组件的
   `data-v-823400de`，父级的 `data-v-7a70bb55` 根本没落下，于是
   `grid-column` 静默失效、宽 948→465、跨满两列缩成一列，而
   vue-tsc / build / 单测全绿。跨列是**本组件的布局事实**，就该由本组件声明。 */
.ssl {
  grid-column: 1 / -1;
  margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px;
}
.ssl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.ssl-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); }
.ssl-list { display: flex; flex-direction: column; gap: 8px; }
.ssl-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 11px;
  border: 1px solid var(--c-border); border-radius: 8px; background: var(--c-hover); }
.ssl-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ssl-meta .mono { font-family: var(--mono); font-size: var(--fs-13); }
.ssl-ops { display: flex; align-items: center; gap: 6px; flex: none; }
.ca-link { margin-top: 10px; }
/* 卡片列表行补 hover：表行有 tbody tr:hover，证书行此前完全没反馈 */
.ssl-row:hover { background: var(--c-active); }
</style>
