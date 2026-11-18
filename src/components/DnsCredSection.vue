<script setup lang="ts">
/**
 * DNS 提供商凭据管理（P2-10 dns-01 的前提）。
 *
 * # 为什么单独成一个组件
 * 它是「配置」而不是「签发」——凭据配一次、签发用很多次。塞进签发弹窗会让
 * 每次申请证书都要重看一遍 Token 表单；而它又必须在证书页可达（用户配完就想
 * 立刻试签发）。所以做成证书页里的一个可折叠区块，自带增删改查。
 *
 * # 三条必须守住的界面纪律
 * 1. **永远不回填明文**：接口只给掩码。编辑表单的 token 输入框留空 = 保持原值，
 *    这条必须写在 placeholder 里，否则用户会以为空着会把凭据清掉。
 * 2. **解不开的凭据不能用来签发**，但仍要显示出来并引导重填——直接藏掉会让用户
 *    困惑「我明明配过」。
 * 3. **状态徽章用 badge-* 药丸**，不用 `.ok/.warn/.err` 文字色工具类（那是灰底彩字，
 *    不是药丸，全站已统一为药丸）。
 */
import { ref, computed, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import type { DnsCred } from '@/api/types'
import { toast, toastError } from '@/composables/useToast'
import {
  DNS_PROVIDERS, providerLabel, credBadge, credCheckText, validateCredInput,
  stripErrorWrappers,
} from '@/composables/dnsCred'
import Icon from '@/components/Icon.vue'

const props = defineProps<{
  /** 是否有 `ssl.manage` 权限（无权限时全部动作置灰，但**列表照常展示**） */
  canManage: boolean
}>()
const emit = defineEmits<{ changed: [] }>()

const creds = ref<DnsCred[]>([])
const loading = ref(false)
const err = ref('')
/** 展开状态：默认收起（凭据是配置项，不是高频操作） */
const open = ref(false)
/** 编辑中的 provider（空串 = 表单关闭） */
const editing = ref('')
const formLabel = ref('')
const formSecret = ref('')
const formZone = ref('')
const formErr = ref('')
const busyProv = ref('')

const hasAny = computed(() => creds.value.length > 0)

async function load() {
  loading.value = true; err.value = ''
  try {
    const r = await api.get<{ items: DnsCred[] }>(API.dns.creds())
    creds.value = r?.items ?? []
  } catch (e) {
    // 失败要如实显示：凭据列表拉不到时，若静默成空数组，用户会以为"被清空了"
    err.value = errorText(e)
    creds.value = []
  } finally { loading.value = false }
}

function startAdd() {
  editing.value = DNS_PROVIDERS[0]
  formLabel.value = ''; formSecret.value = ''; formZone.value = ''; formErr.value = ''
}

function startEdit(c: DnsCred) {
  editing.value = c.provider
  formLabel.value = c.label
  // 不回填 token：接口只给掩码，回填掩码会让用户以为那是真 token
  formSecret.value = ''
  formZone.value = c.zone_hint
  formErr.value = ''
}

function cancelEdit() {
  editing.value = ''; formErr.value = ''
}

/** 当前编辑的是"新增"还是"更新"——决定 secret 是否必填 */
const isNew = computed(() => !creds.value.some((c) => c.provider === editing.value))

async function save() {
  const v = validateCredInput(editing.value, formSecret.value, isNew.value)
  if (v) { formErr.value = v; return }
  busyProv.value = editing.value; formErr.value = ''
  try {
    await api.put(API.dns.creds(), {
      provider: editing.value,
      label: formLabel.value.trim(),
      // 留空 = 保持原值（后端按此语义处理）；不要传掩码
      secret: formSecret.value.trim(),
      zone_hint: formZone.value.trim(),
    })
    toast(`已保存 ${providerLabel(editing.value)} 凭据`)
    editing.value = ''
    await load()
    emit('changed')
  } catch (e) {
    // 后端 Validation 的 Display 会带 `invalid input: field:` 前缀，provider 侧
    // 还会再包一层——不剥的话用户看到三重前缀、真正原因埋到最后。
    formErr.value = stripErrorWrappers(errorText(e))
  } finally { busyProv.value = '' }
}

async function check(c: DnsCred) {
  busyProv.value = c.provider
  try {
    const r = await api.post<{ ok: boolean; message: string }>(API.dns.check(c.provider))
    toast(r?.ok ? `${providerLabel(c.provider)} 凭据可用` : `校验未通过：${r?.message || '原因未返回'}`,
      r?.ok ? 'ok' : 'err')
    await load()
  } catch (e) {
    toastError(e)
  } finally { busyProv.value = '' }
}

async function remove(c: DnsCred) {
  busyProv.value = c.provider
  try {
    await api.del(API.dns.cred(c.provider))
    toast(`已删除 ${providerLabel(c.provider)} 凭据`)
    await load()
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally { busyProv.value = '' }
}

onMounted(load)

/** 让父级能主动刷新（例如签发失败后回来重看凭据状态） */
defineExpose({ reload: load })
</script>

<template>
  <section class="dns-creds">
    <header class="dc-head">
      <button class="dc-toggle" type="button" :aria-expanded="open" @click="open = !open">
        <!-- chevron 默认朝右；展开时靠 CSS 转 90°，与 SideNav 同一套约定 -->
        <Icon name="chevron" :size="14" :class="['dc-chev', { on: open }]" />
        <b>DNS 凭据</b>
        <span class="dim">（dns-01 签发的前提，配置一次即可复用）</span>
        <span v-if="hasAny" class="dc-count">{{ creds.length }}</span>
      </button>
    </header>

    <div v-if="open" class="dc-body">
      <p v-if="err" class="err-bar" role="alert">
        <Icon name="alert" :size="15" class="ic" /><span>{{ err }}</span>
      </p>

      <div v-if="loading" class="dim dc-empty">读取中…</div>
      <!-- 空态：说清"为什么需要它"而不是只写"暂无数据" -->
      <div v-else-if="!creds.length && !editing" class="dc-empty">
        <span class="dim">
          尚未配置任何 DNS 凭据。使用 <b>dns-01</b> 签发证书（不要求本机 80 端口可达）需要先在这里添加
          DNS 提供商的 API Token。
        </span>
      </div>

      <table v-if="creds.length" class="dc-table">
        <thead>
          <tr>
            <th style="width: 130px">提供商</th>
            <th style="width: 140px">备注</th>
            <th style="width: 200px">Token</th>
            <th style="width: 190px">状态</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in creds" :key="c.provider">
            <td><b>{{ providerLabel(c.provider) }}</b></td>
            <td>{{ c.label || '—' }}</td>
            <td class="dc-mask"><code>{{ c.secret_masked }}</code></td>
            <td>
              <span :class="['badge', `badge-${credBadge(c)}`]">{{ credCheckText(c) }}</span>
            </td>
            <td class="col-actions">
              <button class="btn-sm" :disabled="!canManage || busyProv === c.provider" @click="check(c)">
                校验</button>
              <button class="btn-sm" :disabled="!canManage" @click="startEdit(c)">编辑</button>
              <button class="btn-sm btn-danger" :disabled="!canManage || busyProv === c.provider" @click="remove(c)">
                删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 表单：编辑中才显示。用 .blk 布局（字段名在上、控件满宽） -->
      <div v-if="editing" class="dc-form">
        <h4>{{ isNew ? '添加 DNS 凭据' : `编辑 ${providerLabel(editing)} 凭据` }}</h4>
        <p v-if="formErr" class="err-bar" role="alert">
          <Icon name="alert" :size="15" class="ic" /><span>{{ formErr }}</span>
        </p>
        <label class="blk">
          API Token
          <input v-model="formSecret" type="password" autocomplete="new-password"
            :placeholder="isNew ? '粘贴 Cloudflare API Token' : '留空 = 保持原有 Token 不变'" />
        </label>
        <label class="blk">
          备注名（可选）
          <input v-model="formLabel" type="text" placeholder="例如：主账号" />
        </label>
        <label class="blk">
          默认 zone（可选）
          <input v-model="formZone" type="text" placeholder="留空 = 按域名自动探测所属 zone" />
        </label>
        <div class="modal-actions">
          <button class="btn-ghost" :disabled="!!busyProv" @click="cancelEdit">取消</button>
          <button class="btn-primary" :disabled="!canManage || !!busyProv" @click="save">保存</button>
        </div>
      </div>

      <div v-if="!editing" class="dc-foot">
        <button class="btn-ghost" :disabled="!canManage" @click="startAdd">
          <Icon name="plus" :size="14" /> 添加凭据
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dns-creds { border: 1px solid var(--c-border); border-radius: var(--radius-sm); background: var(--c-surface); }
.dc-head { border-bottom: 1px solid transparent; }
.dc-toggle {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 10px 13px; background: none; border: 0; cursor: pointer;
  font-size: var(--fs-13); color: var(--c-text); font-family: inherit; text-align: left;
}
.dc-count {
  margin-left: auto; padding: 0 7px; border-radius: 999px; font-size: var(--fs-12);
  background: var(--c-primary-soft); color: var(--c-primary);
}
.dc-chev { transition: transform 0.15s; color: var(--c-text-dim); }
.dc-chev.on { transform: rotate(90deg); }
.dc-body { padding: 0 13px 13px; }
.dc-empty { padding: 12px 0; font-size: var(--fs-13); line-height: 1.6; }
.dc-table { width: 100%; margin: 8px 0 10px; }
.dc-mask code { font-size: var(--fs-12); color: var(--c-text-dim); }
.dc-form { margin-top: 10px; padding: 12px; border: 1px solid var(--c-border); border-radius: var(--radius-xs); }
.dc-form h4 { margin: 0 0 10px; font-size: var(--fs-13); }
.dc-foot { padding-top: 4px; }
</style>
