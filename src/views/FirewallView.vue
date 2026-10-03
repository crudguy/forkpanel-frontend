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
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fwActionLabel, fwBackendLabel, fwProtocolLabel } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

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
onMounted(load)

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
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <span class="badge" :class="active ? 'badge-ok' : 'badge-danger'">{{ active ? '已启用' : '未启用' }}</span>
        <span class="badge">后端：{{ fwBackendLabel(backend) }}</span>
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

      <section class="card">
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
          <button class="btn-primary" :disabled="busy || !ports" @click="apply">应用</button>
        </div>
        <p class="tip">
          仅支持放行（allow）。封禁端口可能导致 SSH 失联，需通过命令行操作。
          后端会在变更前自动快照，失败时回滚。
        </p>
      </section>

      <div class="card flush" v-if="rules.length">
        <table>
          <thead><tr><th>端口</th><th>协议</th><th>动作</th><th>方向</th><th>来源</th><th>备注</th><th>归属</th><th /></tr></thead>
          <tbody>
            <tr v-for="r in rules" :key="r.id">
              <td class="mono">{{ r.ports }}</td>
              <td>{{ fwProtocolLabel(r.protocol) }}</td>
              <td><span class="badge" :class="r.action === 'allow' ? 'badge-ok' : 'badge-danger'">{{ fwActionLabel(r.action) }}</span></td>
              <td>{{ r.direction === 'in' ? '入站' : '出站' }}</td>
              <td class="mono">{{ r.source ?? '任意' }}</td>
              <td class="dim">{{ r.comment ?? '—' }}</td>
              <td class="nowrap">
                <span v-if="r.panel_managed" class="badge badge-primary">面板管理</span>
                <span v-else class="badge" title="面板不会删除用户自建规则">用户自建</span>
              </td>
              <td class="nowrap">
                <button class="btn-danger btn-sm" :disabled="busy || !canManage || !r.panel_managed"
                  :title="r.panel_managed ? '删除此规则' : '用户自建规则不可删除'"
                  @click="askDelete(r)">
                  <Icon name="trash" :size="14" /> 删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="暂无规则" />
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
</style>
