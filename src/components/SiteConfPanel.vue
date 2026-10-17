<script setup lang="ts">
/**
 * 站点配置原文（Nginx）+ 历史版本与回滚。
 *
 * 为什么从 SitesView 里抽出来：这一块自带十余个独立状态与 3 条写接口（手动保存 /
 * 按表单重新生成 / 回滚），且**所有触发点都在块内**——它不需要知道表单长什么样，
 * 只需要知道「作用在哪个站点」「还能不能写」。合在 2900 行里改它要在别的事情
 * 中间找入口，抽出后边界就是这里。
 *
 * ⚠ 两个必须守住的语义（都是后端真约束，别"顺手优化"）：
 * 1. `manual` / `stale` 由**本组件**写、由**父级**读——父级保存站点时要据此判断
 *    「要不要弹覆盖配置的二选一」（手动维护站点的表单改动不会自动落盘）。故这两个值
 *    走 v-model 而不是组件内部状态：单一真值在父级，单一写者在子级。
 * 2. 两个二次确认框用 `<Teleport to="body">`：本组件挂在站点编辑弹窗内部，
 *    浮层若留在原地会被嵌进父弹窗的 `v-if` 树里（此前 ConfirmDialog 就是这样
 *    静默弹不出来的）。
 */
import { computed, ref, watch, toRef } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { fmtDateTime, type ConfVersion, type ConfVersionDetail, type Site } from '@/api/types'
import { toast } from '@/composables/useToast'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import NginxEditor from '@/components/NginxEditor.vue'

const props = defineProps<{
  /** 正在编辑的站点；新建站点尚未落库时为 null（此时本区块不渲染） */
  site: Site | null
  /** 是否接入 Web 服务器（未接入则不可写） */
  webSupported: boolean
  canManage: boolean
  isOwner: boolean
  /** 父级 Web 服务器名（报错文案用） */
  webName: string
  /** 全局忙碌态（父级正在保存/删除时连带禁用本区块动作） */
  busy: boolean
  /** 站点是否处于「手动维护」（本组件写，父级保存时读） */
  manual: boolean
  /** 站点是否与磁盘配置不一致（同 manual） */
  stale: boolean
  /** 父级错误序号：用于让红字重建、抖动动画重播 */
  errSeq: number
}>()

const emit = defineEmits<{
  changed: []
  'update:manual': [v: boolean]
  'update:stale': [v: boolean]
  bumpErr: []
}>()

// 下面这些别名让搬过来的代码块**逐字保持原样**：它们原本读的是视图里的同名 ref。
// （typed ref 的意义在此：把 props 包装成 Ref 后，原有 `.value` 用法一行都不用改。）
const editing = computed(() => props.site)
const webSupported = toRef(props, 'webSupported')
const canManage = toRef(props, 'canManage')
const isOwner = toRef(props, 'isOwner')
const webName = toRef(props, 'webName')
const errSeq = computed(() => props.errSeq)
/** 写—发—读单向：本组件写，父级保存决策读。 */
const confManual = computed({ get: () => props.manual, set: (v) => emit('update:manual', v) })
const confStale = computed({ get: () => props.stale, set: (v) => emit('update:stale', v) })
/** 错误序号只有父级能递增（它在全弹窗范围内共用），这里只请求递增。 */
function bumpErr() { emit('bumpErr') }
// ── 站点原始配置（编辑弹窗内「站点配置（Nginx）」区）：查看 / 编辑 / 按表单重新生成 ──
//
// 这份文件是「表单 → render → 校验 → 下发」的**产物**。手动维护（后端 manual_conf）
// 让用户直接改这份产物成为一等状态：保存成功后表单「保存并应用」不再覆盖它，
// 直到「按表单重新生成」按表单重新渲染覆盖（或停用/重新启用清零标记）。
// 路径唯一来源是后端按落库 conf_path 的返回——前端**不拼路径**，后端也拒绝前端传路径。
const confLoading = ref(false)
/** 配置文件落盘路径；null = 尚未下发（停用态或从未 apply） */
const confPath = ref<string | null>(null)
/** 编辑区内容（与原文件同构；保存时原样提交） */
const confText = ref('')
/** 站点是否处于「手动维护」（后端 manual_conf） */
/**
 * 本区块**独立**的错误位（与弹窗顶部 formError 分开）：
 * 配置区校验失败时，错误必须落在**配置区自己身上**——用户正在看的就是这段文本，
 * 甩到弹窗顶部等于让人自己去找是哪儿写坏了。
 */
const confErr = ref('')
const confBusy = ref(false)
/** 「按表单重新生成」二次确认（覆盖手工内容；覆盖前自动备份，但仍不可逆） */
const confAsk = ref(false)
/** 未同步（后端 stale，017 迁移）：表单规格与磁盘配置不一致——面板所见 ≠ nginx 实际生效 */
/** 外部修改（020）：磁盘内容与最后一次留档不一致——文件在面板之外被改过 */
const confExternal = ref(false)

const confHint = computed(() => {
  if (!canManage.value) return '无 site.manage 权限'
  if (!isOwner.value) return '仅 owner 可保存原始配置'
  if (!webSupported.value) return '需安装并启动 Web 服务器'
  if (!editing.value?.enabled) return '站点已停用（配置已移除）；先在下方勾选「启用」并保存，再回来编辑'
  return '保存到磁盘并重载（保存前自动做配置校验；失败不会动旧文件）'
})

/** 当前编辑中的配置字节数（UTF-8）：给超长配置一个可感知的量级（后端上限 64 KiB）。 */
const confSize = computed(() => new TextEncoder().encode(confText.value).length)
/** 接近 64 KiB 上限时警示（后端对该值做权威校验，这里只是提前提醒）。 */
const confTooBig = computed(() => confSize.value > 64 * 1024)

/** 「按表单重新生成」的提示：与「保存配置」后果完全不同，不能共用 confHint。 */
const regenHint = computed(() => {
  if (!canManage.value) return '无 site.manage 权限'
  if (!isOwner.value) return '仅 owner 可重新生成配置'
  if (!webSupported.value) return '需安装并启动 Web 服务器'
  return '按当前表单重新渲染并覆盖磁盘上的这份配置：丢弃手工修改（覆盖前自动备份到服务器），站点恢复为面板托管'
})

/** 清空本区块状态（重新打开编辑弹窗时调用，避免上一站点的内容/报错残留）。 */
function resetConf() {
  confPath.value = null; confText.value = ''; confManual.value = false
  confErr.value = ''; confBusy.value = false; confAsk.value = false
  confStale.value = false; confExternal.value = false
  // 版本面板同样归零：上一站点展开的列表/报错/详情不能残留到下一个站点
  versOpen.value = false; versList.value = []; versErr.value = ''
  versOpenId.value = null; versDetail.value = null
  versLoading.value = false; rollbackTarget.value = null
}

/** 拉取当前站点配置（打开编辑弹窗时调用；失败落本区块错误位，不阻塞弹窗其它功能）。 */
async function loadConf(id: number) {
  confLoading.value = true; confErr.value = ''
  try {
    const d = await api.get<{ path: string | null; content: string | null; manual: boolean; stale: boolean; external?: boolean }>(
      API.sites.conf(id))
    confPath.value = d.path ?? null
    confText.value = d.content ?? ''
    confManual.value = d.manual
    // stale：表单规格 vs 磁盘配置的指纹不一致（后端 017）——面板所见 ≠ nginx 实际生效
    confStale.value = d.stale
    confExternal.value = !!d?.external
  } catch (e) {
    confErr.value = errorText(e)
  } finally { confLoading.value = false }
}

/**
 * 配置区错误文案：40002（nginx -t 校验失败）**必须透出原始输出**。
 *
 * errorText 的 40002 分支只给一句「配置校验未通过」——对表单保存够用，但对
 * 正在直接编辑原文的用户等于没有信息：人要知道的是「哪一行、什么错」。nginx 的
 * 原始输出正是那个可执行的答案（如 `nginx: [emerg] unexpected "}" ...:42`），
 * 属**命令诊断输出**而非内部英文标识，透出是刻意为之（后有 CJK 兜底纪律约束其它分支）。
 */
function confErrText(e: unknown) {
  if ((e as { code?: number } | null)?.code === 40002) {
    const out = (e as { detail?: { output?: unknown } }).detail?.output
    const s = typeof out === 'string' ? out.trim() : ''
    if (s) return `配置校验未通过（${webName.value}）：\n${s}`
  }
  return errorText(e)
}

/** 保存原始配置 → 转「手动维护」。门控前置（能力位 + 权限 + owner），否则只等来 501/403。 */
async function saveConf() {
  if (!editing.value || !canManage.value || !isOwner.value || !webSupported.value) return
  if (!editing.value.enabled) { confErr.value = '站点已停用（配置已移除），请先启用并保存后再编辑'; return }
  if (!confText.value.trim()) { confErr.value = '配置内容不能为空'; return }
  confBusy.value = true; confErr.value = ''
  try {
    const d = await api.put<{ path: string; manual: boolean; stale?: boolean; reloaded: boolean }>(
      API.sites.conf(editing.value.id), { content: confText.value })
    confPath.value = d?.path ?? confPath.value
    confManual.value = !!d?.manual
    // 保存原文 = 文件与表单在当前时刻对齐（后端快照即当前指纹）→ 未同步解除
    confStale.value = !!d?.stale
    toast('站点配置已保存并重载；此后表单「保存并应用」不再覆盖该文件')
    emit('changed')
    if (versOpen.value) await loadVersions()  // 本次保存已留档新版本——展开的列表同步刷新
  } catch (e) {
    confErr.value = confErrText(e)
    bumpErr()  // 重建错误条，抖动动画可重播（与表单错误同一机制）
  } finally { confBusy.value = false }
}

/** 按表单重新生成：按表单规格重新渲染覆盖（丢弃手工内容，覆盖前自动备份），成功后重新拉取本区内容。 */
async function restoreConf() {
  if (!editing.value || !canManage.value || !isOwner.value || !webSupported.value) return
  confAsk.value = false
  confBusy.value = true; confErr.value = ''
  try {
    const d = await api.post<{ backup?: string | null }>(API.sites.confRestore(editing.value.id), {})
    // 备份是安全网：有/无都要如实说（无 = 文件缺失或备份失败，审计日志已记录）
    toast(d?.backup
      ? '已按表单重新生成配置并下发（原手动配置已自动备份）'
      : '已按表单重新生成配置并下发（注意：原配置备份失败，手工修改未留存副本）')
    const id = editing.value.id
    await loadConf(id)
    emit('changed')
    if (versOpen.value) await loadVersions()  // 重新生成同样在版本链留档
  } catch (e) {
    confErr.value = confErrText(e)
    bumpErr()
  } finally { confBusy.value = false }
}

// ── 配置历史版本与回滚（018 迁移）──
//
// 每次成功写盘——保存并应用（apply）、按表单重新生成（regen）、手动保存（manual）、
// 回滚（rollback）——都会把「当时落盘的内容」留档（每站保留最近 20 版，同内容去重）。
// 回滚 = nginx -t 校验 → 现场留档 → 原子替换 → reload → 按「版本指纹 vs 当前表单
// 指纹」自动定态（一致 ⇒ 面板托管；否则转手动维护）。属 root 级写入面，仅 owner。

/** 版本面板是否展开（懒加载：首次展开才拉列表——不进弹窗就不发请求） */
const versOpen = ref(false)
const versLoading = ref(false)
/** 版本列表的独立错误位：加载/回滚失败只染红这一块，不该泼到整个配置区 */
const versErr = ref('')
const versList = ref<ConfVersion[]>([])
/** 正在展开查看正文的版本 id（null = 全部收起） */
const versOpenId = ref<number | null>(null)
const versDetailLoading = ref(false)
const versDetail = ref<ConfVersionDetail | null>(null)
/** 回滚二次确认的目标版本（ConfirmDialog 的 open 判据） */
const rollbackTarget = ref<ConfVersion | null>(null)

/** 版本来源 → 中文名（键 = 后端落库值 source，勿写成展示口径）。 */
function versSourceLabel(s: string) {
  if (s === 'apply') return '保存并应用'
  if (s === 'regen') return '重新生成'
  if (s === 'manual') return '手动保存'
  if (s === 'rollback') return '回滚'
  return s
}

/** 字节数的紧凑展示（版本行空间小，不做 KB/MB 自适应堆叠）。 */
function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

async function toggleVersions() {
  versOpen.value = !versOpen.value
  if (versOpen.value && !versList.value.length && !versLoading.value) await loadVersions()
}

async function loadVersions() {
  if (!editing.value) return
  versLoading.value = true; versErr.value = ''
  try {
    const d = await api.get<{ items: ConfVersion[] }>(API.sites.confVersions(editing.value.id))
    versList.value = d.items ?? []
  } catch (e) {
    versErr.value = confErrText(e)
  } finally { versLoading.value = false }
}

/** 展开 / 收起某版本正文（按需单取——列表不一次拉 20 份全文）。 */
async function toggleVersDetail(v: ConfVersion) {
  if (!editing.value) return
  if (versOpenId.value === v.id) { versOpenId.value = null; return }
  versOpenId.value = v.id
  versDetail.value = null
  versDetailLoading.value = true; versErr.value = ''
  try {
    versDetail.value = await api.get<ConfVersionDetail>(API.sites.confVersion(editing.value.id, v.id))
  } catch (e) {
    versErr.value = confErrText(e)
    versOpenId.value = null
  } finally { versDetailLoading.value = false }
}

/** 回滚按钮的禁用原因（tooltip）；可执行时讲清动作与后果。 */
function rollbackHint(v: ConfVersion): string {
  if (!canManage.value) return '无 site.manage 权限'
  if (!isOwner.value) return '仅 owner 可回滚配置（原始配置文本属 root 级写入面）'
  if (!webSupported.value) return '需安装并启动 Web 服务器'
  if (!editing.value?.enabled) return '站点已停用（配置已移除）；请先启用并保存后再回滚'
  if (v.current) return '该版本与磁盘上的当前文件一致，无需回滚'
  return `回滚到 ${fmtDateTime(v.created_at)} 的这版（${versSourceLabel(v.source)}）：先做配置校验，替换前把当前文件留档进版本链（可再次回滚找回），然后重载生效`
}

/** 回滚（二次确认后执行）：成功后整区重取——磁盘内容、手动/未同步态、版本列表。 */
async function doRollback() {
  if (!editing.value || !rollbackTarget.value) return
  if (!canManage.value || !isOwner.value || !webSupported.value) return
  const id = editing.value.id
  const vid = rollbackTarget.value.id
  rollbackTarget.value = null
  confBusy.value = true; confErr.value = ''; versErr.value = ''
  try {
    const d = await api.post<{ path: string; manual: boolean; stale: boolean; reloaded: boolean }>(
      API.sites.confRollback(id), { version_id: vid })
    confPath.value = d?.path ?? confPath.value
    confManual.value = !!d?.manual
    confStale.value = !!d?.stale
    toast(d?.manual
      ? '已回滚到所选版本并重载；内容与当前表单不一致，站点转入「手动维护」（表单再变更会标「未同步」）'
      : '已回滚到所选版本并重载；站点保持面板托管')
    await loadConf(id)
    await loadVersions()
    emit('changed')
  } catch (e) {
    versErr.value = confErrText(e)
    bumpErr()
  } finally { confBusy.value = false }
}
/**
 * 换站点即换全部状态。
 *
 * 原先由父级的 `openEdit` 手动调用 `resetConf()` + `loadConf(id)`。搬到子组件后
 * 父级在调用那一刻本组件**还没挂载**（DOM 更新是异步的），重写续调用的时序会丢失一次
 * reset ——残留上一站点的内容正是这段代码要消灭的东西。故改为**由本组件自持**：
 * 只要 `site.id` 变了就无条件复位重取，谁先谁后都不重要。
 */
// ⚠ 必须 `immediate: true`：组件随弹窗一起挂载，此时 props.site 已经就位，
//   watch 默认**不会**为初始值触发回调——漏了它，第一次打开编辑弹窗就永远读不到
//   配置原文（实测 .conf 子树从 464 个元素掉到 27 个：编辑器拿不到内容）。
watch(() => props.site?.id ?? null, (id) => {
  resetConf()
  if (id != null) void loadConf(id)
}, { immediate: true })
</script>
<template>
        <!-- 站点原始配置：查看 / 编辑原文 / 按表单重新生成。
             这份文件是「表单 → render → 校验 → 下发」的**产物**；「手动维护」让直接改
             产物成为一等状态——保存后表单「保存并应用」不再覆盖它（后端 manual_conf）。
             路径由后端按落库 conf_path 给出：前端不拼路径，后端也不接受前端传路径。
             仅编辑既有站点时出现：新建站点尚未落库、没有配置文件可读。 -->
        <div v-if="editing" class="conf">
          <div class="conf-head">
            <span class="conf-title">
              <Icon name="file" :size="14" /> 站点配置（Nginx）
              <span v-if="confManual" class="badge" :class="confStale ? 'badge-danger' : 'badge-warn'"
                :title="confStale
                  ? '表单规格已变更，但磁盘上的这份配置没有跟着更新——面板显示的将不是 nginx 实际生效的内容；点「按表单重新生成」同步'
                  : '已手动接管：表单「保存并应用」不会覆盖磁盘上的这份配置；点「按表单重新生成」交还控制权'">
                {{ confStale ? '未同步' : '手动维护' }}</span>
            </span>
            <span v-if="confLoading" class="dim tiny">读取中…</span>
            <span v-else class="mono dim tiny ellipsis conf-path"
              :title="confPath || '尚未下发：保存「并应用」后生成'">{{ confPath || '尚未下发' }}</span>
            <!-- 字节数：超长配置此前完全没有量级感知（后端 64 KiB 上限只在提交后才报错） -->
            <span v-if="!confLoading && confText" class="dim tiny conf-size"
              :class="{ 'is-warn-text': confTooBig }"
              :title="confTooBig ? '已超过 64 KiB 上限，保存会被后端拒绝' : '当前配置大小（后端上限 64 KiB）'">
              {{ fmtBytes(confSize) }}</span>
          </div>
          <!-- 未同步警示（后端 017 指纹判定）：表单规格与磁盘配置分叉时，先说清现状再给操作 -->
          <p v-if="confStale" class="hint-note is-warn conf-stale">
            <Icon name="info" :size="14" class="ic" />
            <span>表单中影响配置的字段（如 WAF／域名／根目录）已变更，磁盘上的这份配置<b>没有跟着更新</b>——当前面板显示的将不是 nginx 实际生效的内容。点「按表单重新生成」同步，或继续在此手动编辑原文件。</span>
          </p>
          <!-- 外部修改（020）：面板不静默覆盖——是人工有意、脚本误写还是攻击无从判断 -->
          <p v-if="confExternal" class="hint-note is-warn conf-external">
            <Icon name="alert" :size="14" class="ic" />
            <span>检测到<b>外部修改</b>：磁盘上的这份配置与面板最后一次下发的内容不一致（文件在面板之外被改过）。面板不会擅自覆盖它——可点「按表单重新生成」覆盖，或把需要的改动改写成上方的「自定义配置片段」。</span>
          </p>
          <!-- 读取失败要给重试出口：此前失败只留一条红字，编辑区仍是空白 + 「尚未下发」
               占位符，用户会误判成"这个站点确实没有配置文件"。 -->
          <div v-if="confErr" :key="'cf' + errSeq" class="err-bar conf-msg conf-fail" role="alert">
            <Icon name="alert" :size="14" class="ic" />
            <span>{{ confErr }}</span>
            <button class="btn-ghost btn-sm" type="button" :disabled="confLoading"
              @click="editing && loadConf(editing.id)">重试</button>
          </div>
          <!-- 只读态要说清**为什么**不能改：NginxEditor 只读时外观虽已变化（底纹变灰），
               但原因此前只藏在按钮 title 里。 -->
          <p v-if="!canManage || !isOwner || !webSupported" class="hint-note is-warn conf-ro">
            <Icon name="lock" :size="14" class="ic" />
            <span>{{ !webSupported ? '未接入 Web 服务器（nginx）：配置只读'
              : (!isOwner ? '仅 owner 可编辑原始配置（当前为只读）' : '无 site.manage 权限：配置只读') }}</span>
          </p>
          <NginxEditor v-model="confText" class="conf-editor" :rows="10" :spellcheck="false"
            :readonly="!canManage || !isOwner || !webSupported"
            :placeholder="confLoading ? '读取中…' : (confErr ? '（读取失败：请点上方「重试」）' : '（配置文件为空或尚未下发——先保存「并应用」生成）')"
            aria-label="站点 Nginx 配置原文" />
          <div class="conf-ops">
            <p class="hint-note conf-hint">
              <Icon name="info" :size="14" class="ic" />
              <span v-if="confManual">保存原文将直接生效（先跑 nginx -t，失败不动旧文件）。<b>按表单重新生成</b>会丢弃你对这份配置的手工修改，按表单重新渲染（覆盖前自动备份）。</span>
              <span v-else>保存原文将<b>接管</b>这份配置：此后表单「保存并应用」不再覆盖它，直到「按表单重新生成」交还。</span>
            </p>
            <div class="conf-btns">
              <button v-if="confManual" class="btn-ghost btn-sm"
                :disabled="confBusy || !isOwner || !webSupported"
                :title="regenHint" @click="confAsk = true">
                <Icon name="refresh" :size="13" /> 按表单重新生成
              </button>
              <button class="btn-ghost btn-sm"
                :disabled="confBusy || !canManage || !isOwner || !webSupported || !editing?.enabled"
                :title="confHint" @click="saveConf">
                <Icon name="check" :size="13" /> {{ confBusy ? '保存中…' : '保存配置' }}
              </button>
            </div>
          </div>
          <!-- 历史版本与回滚（018）：每次成功写盘（保存并应用 / 重新生成 / 手动保存 /
               回滚）都会留档，每站保留最近 20 版。懒加载：展开才拉列表；正文按需单取。 -->
          <div class="vers">
            <button class="btn-ghost btn-sm vers-toggle" @click="toggleVersions">
              <Icon name="clock" :size="13" />
              {{ versOpen ? '收起历史版本' : '历史版本与回滚' }}
            </button>
            <div v-if="versOpen" class="vers-panel">
              <p v-if="versLoading" class="dim tiny">加载中…</p>
              <p v-else-if="versErr" :key="'ve' + errSeq" class="err-bar conf-msg" role="alert">{{ versErr }}</p>
              <p v-else-if="!versList.length" class="dim tiny">暂无历史版本：每次「保存并应用」、重新生成、手动保存与回滚都会在此留档（每站保留最近 20 版）。</p>
              <template v-else>
                <div v-for="v in versList" :key="v.id" class="vers-row">
                  <div class="vers-meta">
                    <span class="vers-src">{{ versSourceLabel(v.source) }}</span>
                    <span class="dim tiny vers-when">{{ fmtDateTime(v.created_at) }} · {{ v.operator }} · {{ fmtBytes(v.size) }}</span>
                    <span v-if="v.current" class="badge badge-ok vers-cur" title="该版本与磁盘上的当前文件一致">当前</span>
                  </div>
                  <div class="vers-ops">
                    <button class="btn-ghost btn-sm" @click="toggleVersDetail(v)">
                      {{ versOpenId === v.id ? '收起' : '查看' }}
                    </button>
                    <button class="btn-ghost btn-sm"
                      :disabled="confBusy || !isOwner || !webSupported || !editing?.enabled || v.current"
                      :title="rollbackHint(v)" @click="rollbackTarget = v">
                      <Icon name="restart" :size="13" /> 回滚
                    </button>
                  </div>
                  <pre v-if="versOpenId === v.id" class="vers-content mono">{{ versDetailLoading ? '加载中…' : (versDetail?.content ?? '') }}</pre>
                </div>
              </template>
            </div>
          </div>
        </div>

    <!-- 二次确认框必须 Teleport 到 body：本组件嵌在站点编辑弹窗内部，
         浮层留在原地会被包进父弹窗的 v-if 子树（历史 bug：点了不弹）。 -->
    <Teleport to="body">
    <ConfirmDialog :open="confAsk" danger title="按表单重新生成"
      :detail="editing ? `将按当前表单重新渲染「${editing.name}」的配置并覆盖磁盘上的现有文件——你对它做的全部手工修改都会丢失（覆盖前会自动备份到服务器，但请勿依赖它找回）。` : ''"
      confirm-word="重新生成" @confirm="restoreConf" @cancel="confAsk = false" />

    <!-- 回滚二次确认（018）：替换前会把当前文件留档进版本链（可再回滚找回），
         但为避免误点仍要求输入确认词。 -->
    <ConfirmDialog :open="!!rollbackTarget" danger title="回滚配置版本"
      :detail="rollbackTarget ? `将把「${editing?.name ?? ''}」的磁盘配置替换为 ${fmtDateTime(rollbackTarget.created_at)} 留档的版本（${versSourceLabel(rollbackTarget.source)}）。替换前先把当前文件留档进版本链（可再次回滚找回），随后执行 nginx -t 校验并重载。` : ''"
      confirm-word="回滚" @confirm="doRollback" @cancel="rollbackTarget = null" />
    </Teleport>
</template>
<style scoped>
/* 这些规则从 SitesView **原样搬来**（声明逐字未改）。
   scoped 只给**末位**选择器加 data-v 属性，祖先部分（如 `.modal-body .sector >`）照常命中，
   故跨组件层级仍然成立——这也是为什么可以直接搬、不必改写选择器。
   ⚠ 父级删掉的只是复合规则里含 .conf / .vers 的那几个分支；同一条规则里的其余目标
   （.tpl-row / .waf / .cc / .adv / .ssl / .hint-note 等）仍留在父级，别再往这里抄一份。 */
.modal-body .sector > .conf { grid-column: 1 / -1; }

.conf { margin-top: 10px; border-top: 1px dashed var(--c-border); padding-top: 12px; display: grid; gap: 8px; }

.conf-head { display: flex; align-items: center; gap: 8px; min-width: 0; }

.conf-title { display: flex; align-items: center; gap: 6px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); flex: none; }

.conf-path { margin-left: auto; max-width: 56%; text-align: right; }

.conf-msg { margin: 0; white-space: pre-wrap; }

.conf-ops { display: flex; align-items: flex-start; gap: 10px; }

.conf-hint { margin: 0; flex: 1; min-width: 0; }

.conf-btns { display: flex; gap: 6px; flex: none; margin-top: 2px; }

.conf-badge { margin-left: 4px; }

.conf-stale { margin: 0; }

.conf-external { margin: 0; }

.vers { display: flex; flex-direction: column; gap: 8px; }

.vers-toggle { align-self: flex-start; }

.vers-panel { display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--c-border); border-radius: 8px; padding: 4px 10px 8px; background: var(--c-hover); }

.vers-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center;
  padding: 5px 0; border-bottom: 1px dashed var(--c-border); }

.vers-row:last-child { border-bottom: 0; }

.vers-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }

.vers-src { flex: none; font-size: var(--fs-12-5); color: var(--c-text); }

.vers-when { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.vers-cur { flex: none; }

.vers-ops { display: flex; gap: 4px; flex: none; }

.vers-content { grid-column: 1 / -1; margin: 4px 0 2px; padding: 8px 10px; max-height: 240px; overflow: auto;
  background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 6px;
  font-size: var(--fs-12); line-height: 1.55; white-space: pre-wrap; word-break: break-all; }

.conf-fail { align-items: center; flex-wrap: wrap; gap: 8px; }

.conf-fail > span { flex: 1 1 auto; min-width: 0; }

.conf-ro { margin: 0 0 8px; }

.vers-row:hover { background: var(--c-active); }

.conf-size { flex: none; margin-left: 8px; }

/* ⚠ 这两个工具类**不是** main.css 的公共类，原先只定义在 SitesView 的 scoped 样式里。
   组件化后它们够不到本组件的元素——实测 .conf-path 字号从 12px 掉到 14px、且 .ellipsis
   的 max-width:0 失效（路径不再省略号截断）。故按同一声明在此重新给一份。
   ⚠ 顺序不能前移：.ellipsis 与 .conf-path 的 max-width 同特异性，靠**后者胜出**得到
   max-width:0；把它放到 .conf-path 之前会让路径不再省略号截断。 */
.tiny { font-size: var(--fs-12); }
.ellipsis { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
