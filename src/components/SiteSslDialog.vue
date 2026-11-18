<script setup lang="ts">
/**
 * 「为某站点申请证书」弹窗（审计 U6：替代 window.prompt 选方式 / 填邮箱）。
 *
 * 从 SiteFormDialog 搬出来的边界：**自己持有全部可变状态**（选中方式 + ACME 邮箱 +
 * 本层错误位）与**唯一的提交动作**（POST /sites/{id}/ssl/apply）。
 *
 * 两个入口共用它，这正是它必须自持状态的原因：
 * - 站点编辑弹窗内「申请证书」→ 作用对象是正在编辑的站点；
 * - 列表行「SSL」按钮 → 那时**编辑弹窗根本没打开**（SiteFormDialog 通过
 *   `defineExpose({ applySsl })` 暴露给父级调用）。
 *
 * ⚠️ 入参只给「作用对象」与「初值」，**不回写父级**：子组件改 `props` 字段既违反单向
 *    数据流，也不会触发响应式更新（对象字段原地赋值，父级的 ref 引用没变）。
 *
 * ⚠️ 错误**必须落在本层**（`sslErr`）：签发弹窗叠在站点弹窗之上，写页面级 error 会被
 *    两层遮罩挡在后面，用户只看到「点了申请没反应」。
 */
import { ref, watch, computed } from 'vue'
import { useModal } from '@/composables/useModal'
import { toast } from '@/composables/useToast'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import type { Site, DnsCred } from '@/api/types'
import { dns01Gate, dns01Hint, providerLabel } from '@/composables/dnsCred'
import Icon from '@/components/Icon.vue'

export type SslMethod = 'self-signed' | 'http-01' | 'dns-01'

const props = defineProps<{
  /** null = 关闭；有值 = 为该站点签发 */
  req: { site: Site; method: SslMethod; email: string } | null
  /** 宿主正在跑别的请求（续期 / 删除）：签发按钮一并置灰，避免并发写同一张证书 */
  busy: boolean
  /**
   * 已配置的 DNS 凭据（dns-01 用）。由宿主传入而不是本弹窗自己拉：
   * 一来宿主（证书页/站点表单）本来就要知道有没有凭据来决定入口文案，
   * 二来弹窗内再发一次请求会让"两层遮罩下的请求失败"更难排查。
   * 缺省空数组 = 没配过，dns-01 选项据此置灰并给出指引。
   */
  dnsCreds?: DnsCred[]
}>()
const emit = defineEmits<{
  'update:req': [null]
  'update:busy': [boolean]
  /** 自签签发成功后宿主需要刷新列表（证书列表按站点过滤，数据变了要重拉） */
  reload: []
}>()

/** 本组件自持的填报状态：`watch(req)` 时从入参取一次初值，之后与父级无关。 */
const method = ref<SslMethod>('self-signed')
const email = ref('')
/** dns-01 用哪家（空串 = 只有一家时自动选中，见 dns01Gate） */
const dnsProvider = ref('')
watch(() => props.req, (r) => {
  if (!r) return
  method.value = r.method
  email.value = r.email
  dnsProvider.value = ''
  sslErr.value = ''
}, { immediate: true })

/** dns-01 的提交前判定（缺凭据 / 解不开 / 未指定）。 */
const dnsGate = computed(() => dns01Gate(props.dnsCreds ?? [], dnsProvider.value))
/** 可用于签发的方式里是否有 dns-01（有凭据才让选）。 */
const dnsUsable = computed(() => dns01Gate(props.dnsCreds ?? [], null).ok || (props.dnsCreds ?? []).some((c) => c.usable))

/**
 * 签发弹窗**自己**的错误位。
 *
 * 签发弹窗是叠在站点弹窗之上的第二层遮罩，此时页面级的 error/notice 会被两层遮罩
 * 挡在后面——用户什么都看不见，只看到点「申请」没反应。所以这一层的报错必须落在
 * 它自己的可见区域里。
 */
const sslErr = ref('')

const box = ref<HTMLElement | null>(null)
const { close } = useModal(() => !!props.req, box, () => { emit('update:req', null) })

async function submit() {
  const r = props.req
  if (!r) return
  emit('update:busy', true); sslErr.value = ''
  // ACME 必须有账户邮箱：CA 靠它发到期/异常通知，缺了就明确报错，不代填假地址。
  // http-01 与 dns-01 走的是同一个 ACME 账户，这条对两者一视同仁。
  const isAcme = method.value === 'http-01' || method.value === 'dns-01'
  if (isAcme && !email.value.trim()) {
    sslErr.value = 'ACME 签发需要账户邮箱'
    emit('update:busy', false)
    return
  }
  // dns-01 前置判定必须在请求之前：缺凭据时提交，后端只会回一句"未找到凭据"，
  // 用户据此不知道要去哪配。这里直接把该做的事说出来。
  if (method.value === 'dns-01' && !dnsGate.value.ok) {
    sslErr.value = dnsGate.value.reason
    emit('update:busy', false)
    return
  }
  try {
    const res = await api.post<{ task_id?: string }>(
      API.sites.sslApply(r.site.id),
      {
        domains: r.site.domains,
        method: method.value,
        email: isAcme ? email.value.trim() : undefined,
        // 仅 dns-01 传；空串在此视为"未指定"，由 decided provider 兜底
        dns_provider: method.value === 'dns-01' ? (dnsGate.value.resolved || undefined) : undefined,
      })
    toast(method.value === 'self-signed'
      ? `已为 ${r.site.name} 签发面板自签证书（记得「重载」使配置生效）`
      : `已提交 ${r.site.name} 的 ACME 签发任务${res?.task_id ? `（${res.task_id}）` : ''}，可在任务中心查看进度`)
    const selfSigned = method.value === 'self-signed'
    emit('update:req', null)
    if (selfSigned) emit('reload')
  } catch (e) {
    // 能力未接入是"还没装上"，不是用户做错了什么——走中性提示而非红色报错。
    if (isUnsupported(e)) {
      sslErr.value = ''
      toast('当前环境未接入证书签发能力（需 openssl 或 ACME）', 'info')
    } else {
      sslErr.value = errorText(e)
    }
  } finally { emit('update:busy', false) }
}
</script>

<template>
  <!-- SSL 签发弹窗（审计 U6）：替代 window.prompt 选方式/填邮箱；行内「SSL」与编辑弹窗「申请证书」共用 -->
  <!-- 签发弹窗叠在站点弹窗之上 → .level-2（此前与父弹窗同为 z-50，只靠 DOM 顺序压住） -->
  <div v-if="req" class="mask level-2" @click.self="close">
    <div ref="box" class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 class="modal-title">为「{{ req.site.name }}」申请证书</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="close">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <!-- 这里出的错若写页面级 error/notice，会被两层遮罩挡在后面，
           用户只觉得"点了申请没反应"。故在弹窗内自带错误位。 -->
      <p v-if="sslErr" class="err-bar" role="alert">
        <Icon name="alert" :size="15" class="ic" /><span>{{ sslErr }}</span>
      </p>
      <label class="ssl-opt">
        <input type="radio" value="self-signed" v-model="method" />
        <span><b>面板自签</b><br /><span class="dim">离线可用、立即可得；需先导入面板根证书浏览器才受信（见「信任根证书」）</span></span>
      </label>
      <label class="ssl-opt">
        <input type="radio" value="http-01" v-model="method" />
        <span><b>ACME http-01</b><br /><span class="dim">可信证书，需公网 80 端口可达 + certbot</span></span>
      </label>
      <!-- dns-01：内网机 / 只开 443 / 域名暂未指向本机时的唯一可行方式。
           凭据没配好时**不置灰**而是仍可点选——置灰会让用户完全不知道有这个选项，
           点进去才看到"先去配凭据"的指引比一个灰掉的单选更有效。 -->
      <label class="ssl-opt">
        <input type="radio" value="dns-01" v-model="method" />
        <span><b>ACME dns-01</b><br /><span class="dim">{{ dns01Hint() }}</span></span>
      </label>
      <label v-if="method === 'http-01' || method === 'dns-01'" class="blk">
        ACME 账户邮箱（必填，用于到期与异常通知）
        <input v-model="email" type="email" placeholder="ops@example.com" autocomplete="email" />
      </label>
      <!-- 有凭据才显示选择器；没凭据时下方那条 dnsGate.reason 已经把该做的事说清了 -->
      <label v-if="method === 'dns-01' && dnsUsable" class="blk">
        DNS 提供商
        <select v-model="dnsProvider">
          <option value="">自动（唯一可用的一家）</option>
          <option v-for="c in (dnsCreds ?? []).filter((x) => x.usable)" :key="c.provider" :value="c.provider">
            {{ providerLabel(c.provider) }}{{ c.label ? `（${c.label}）` : '' }}
          </option>
        </select>
      </label>
      <!-- dns-01 的前置缺口必须在这里可见：它是用户在弹窗里唯一的线索。
           用 warn 而非 err：缺凭据是"还没配"，不是"配错了"。 -->
      <p v-if="method === 'dns-01' && !dnsGate.ok" class="dns-gate" role="status">
        <Icon name="alert" :size="14" class="ic" /><span>{{ dnsGate.reason }}</span>
      </p>
      <div class="modal-foot">
        <div class="modal-actions">
          <button class="btn-ghost" @click="close">取消</button>
          <button class="btn-primary"
            :disabled="busy || ((method === 'http-01' || method === 'dns-01') && !email.trim()) || (method === 'dns-01' && !dnsGate.ok)"
            @click="submit">
            {{ busy ? '提交中…' : '申请' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ssl-opt { display: flex; align-items: flex-start; gap: 9px; padding: 9px 11px; border: 1px solid var(--c-border); border-radius: var(--radius-xs); margin-bottom: 8px; cursor: pointer; font-size: var(--fs-13); line-height: 1.5; }
.ssl-opt:has(input:checked) { border-color: var(--c-primary); background: var(--c-primary-soft); }
.ssl-opt input { width: auto; margin-top: 2px; }
/* dns-01 前置缺口提示：信息色（"还差一步"），与红底 .err-bar（做错了）区分开。
   刻意不新造 --c-warn-soft：main.css 没有这个变量，自造一个就会绕开全站配色基线。 */
.dns-gate {
  display: flex; align-items: flex-start; gap: 7px;
  margin: 2px 0 10px; padding: 8px 10px; font-size: var(--fs-12); line-height: 1.55;
  border-radius: var(--radius-xs); color: var(--c-text);
  background: var(--c-info-soft); border: 1px solid var(--c-border);
}
.dns-gate .ic { flex: none; margin-top: 1px; color: var(--c-info); }
</style>
