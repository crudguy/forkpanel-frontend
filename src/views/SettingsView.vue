<script setup lang="ts">
/**
 * 设置页 = 运行环境排障（能力矩阵） + 面板设置（三段诚实模型）。
 *
 * 设置三段（与后端 routes/settings.rs 严格对应）：
 * - runtime：AI 助手 LLM 三键，可改即生效；api_key 经主密钥加密，后端永不明文回传
 * - deployment：部署级配置只读展示（改 config.toml / PANEL_READ_ONLY 并重启）
 * - reserved：种子预留键未接线（wired:false），如实标注，绝不伪装成可生效
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useAuthStore } from '@/stores/auth'
import type { SettingsReport } from '@/api/types'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const route = useRoute()
const canManage = computed(() => auth.can('settings.manage'))

// 深链定位（topbar 系统信息胶囊直达 /settings#caps）：
// 本页有 v-if="report" 的异步分区，路由 scrollBehavior 触发时它们尚未渲染，
// 内容补上后锚点会被顶偏，故在数据就绪后再定位一次。
function scrollToHash() {
  const id = route.hash ? route.hash.slice(1) : ''
  if (!id) return
  requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}
watch(() => route.hash, scrollToHash)

const caps = computed(() => Object.entries(auth.capabilities))
const supportedCount = computed(() => caps.value.filter(([, c]) => c.supported).length)

// ── 面板设置（三段）──
const report = ref<SettingsReport | null>(null)
const loading = ref(false)
const saving = ref(false)
const formError = ref('')
const notice = ref('')
const llmEndpoint = ref('')
const llmModel = ref('')
const llmKey = ref('')            // 留空 = 保持不变；输入 = 覆盖
const showKey = ref(false)

// ── 角色管理（RBAC 自定义角色）──
// 安全判断全在后端：防提权（权限必须是自身权限的子集）、内置角色名保留、
// 被用户引用的角色不可删。前端只把后端给的 known_permissions 渲染成勾选项，
// **绝不自己发明权限名**——前端多一个后端不认的名字，只会得到一次 400。
interface RoleRow { name: string; permissions: string[]; builtin: boolean; created_at: number | null }
const roles = ref<RoleRow[]>([])
const knownPerms = ref<string[]>([])
const roleName = ref('')
const rolePerms = ref<string[]>([])
const roleBusy = ref(false)
const roleErr = ref('')
const canRoles = computed(() => auth.can('user.manage'))

async function loadRoles() {
  if (!canRoles.value) return
  try {
    const r = await api.get<{ roles: RoleRow[]; known_permissions: string[] }>(API.roles.list())
    roles.value = r.roles
    knownPerms.value = r.known_permissions
  } catch (e) { roleErr.value = errorText(e) }
}

async function createRole() {
  if (!roleName.value.trim() || !rolePerms.value.length) {
    roleErr.value = '需要角色名与至少一项权限'
    return
  }
  roleBusy.value = true; roleErr.value = ''
  try {
    await api.post(API.roles.create(), { name: roleName.value.trim(), permissions: rolePerms.value })
    roleName.value = ''; rolePerms.value = []
    await loadRoles()
  } catch (e) { roleErr.value = errorText(e) }
  finally { roleBusy.value = false }
}

/** 待删除角色（审计 U5：window.confirm → ConfirmDialog） */
const delRole = ref<string | null>(null)
async function deleteRole(name: string) {
  roleErr.value = ''
  try {
    await api.del(API.roles.item(name))
    delRole.value = null
    await loadRoles()
  } catch (e) { roleErr.value = errorText(e) }
}

async function load() {
  if (!canManage.value) return
  loading.value = true
  formError.value = ''
  try {
    report.value = await api.get<SettingsReport>(API.settings.get())
    llmEndpoint.value = report.value.runtime.endpoint ?? ''
    llmModel.value = report.value.runtime.model ?? ''
  } catch (e) {
    formError.value = errorText(e)
  } finally { loading.value = false }
}

async function save() {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  notice.value = ''
  try {
    const patch: Record<string, string | null> = {
      'assistant.llm_endpoint': llmEndpoint.value.trim() || null,
      'assistant.llm_model': llmModel.value.trim() || null,
    }
    if (llmKey.value.trim()) patch['assistant.llm_api_key'] = llmKey.value.trim()
    report.value = await api.patch<SettingsReport>(API.settings.patch(), { settings: patch })
    llmKey.value = ''
    notice.value = '设置已保存并即时生效'
  } catch (e) {
    formError.value = errorText(e)
  } finally { saving.value = false }
}

async function clearKey() {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  notice.value = ''
  try {
    report.value = await api.patch<SettingsReport>(API.settings.patch(), {
      settings: { 'assistant.llm_api_key': null },
    })
    llmKey.value = ''
    notice.value = 'API 密钥已清除'
  } catch (e) {
    formError.value = errorText(e)
  } finally { saving.value = false }
}

onMounted(async () => {
  await load()
  // 角色列表需要 user.manage；loadRoles 内部自判权限，非管理员直接跳过
  await loadRoles()
  scrollToHash()
})
</script>

<template>
  <div>
    <!-- ── 面板设置（仅 settings.manage 可见）── -->
    <template v-if="canManage">
      <section class="card">
        <div class="sec-head"><Icon name="sparkles" :size="16" /> AI 助手 · LLM 接入</div>
        <p class="sec-sub">为「AI 助手」的自然语言层预留。当前诊断内核为内置规则引擎，配置 LLM 后叙事层自动启用。</p>
        <div v-if="loading" class="dim">加载中…</div>
        <template v-else-if="report">
          <div class="form">
            <label class="field">
              <span class="lbl">API Endpoint</span>
              <input v-model="llmEndpoint" class="inp" type="url" placeholder="https://api.openai.com/v1" />
            </label>
            <label class="field">
              <span class="lbl">Model</span>
              <input v-model="llmModel" class="inp" type="text" placeholder="gpt-4o-mini / deepseek-chat …" />
            </label>
            <label class="field">
              <span class="lbl">API Key <span :class="report.runtime.api_key_set ? 'set-ok' : 'dim'">
                {{ report.runtime.api_key_set ? '已设置（加密存储，留空保持不变）' : '未设置' }}
              </span></span>
              <div class="key-row">
                <input v-model="llmKey" class="inp" :type="showKey ? 'text' : 'password'"
                  :placeholder="report.runtime.api_key_set ? '••••••••（留空保持不变）' : 'sk-…'" autocomplete="off" />
                <button class="btn-ghost" type="button" :title="showKey ? '隐藏' : '显示'" @click="showKey = !showKey">
                  <Icon :name="showKey ? 'lock' : 'key'" :size="14" />
                </button>
                <button v-if="report.runtime.api_key_set" class="btn-ghost danger" type="button" :disabled="saving" @click="clearKey">
                  清除
                </button>
              </div>
            </label>
          </div>
          <p class="sec-note">密钥经主密钥 AES-GCM 加密落库，界面与接口均不回显明文。</p>
          <p v-if="formError" class="err" role="alert">{{ formError }}</p>
          <p v-if="notice" class="ok" role="status">{{ notice }}</p>
          <div class="actions">
            <button class="btn-primary" :disabled="saving" @click="save">
              <Icon name="check" :size="15" /> {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </template>
        <p v-else-if="formError" class="err">{{ formError }}</p>
      </section>

      <section v-if="report" class="card">
        <div class="sec-head"><Icon name="gear" :size="16" /> 部署配置（只读）</div>
        <div class="kv">
          <div class="kv-row"><span class="k">只读模式</span>
            <code class="mono">{{ report.deployment.read_only ? '开启（PANEL_READ_ONLY=1）' : '关闭' }}</code></div>
          <div class="kv-row"><span class="k">资源档位</span><code class="mono">{{ report.deployment.tier }}</code></div>
        </div>
        <p class="sec-note">{{ report.deployment.hint }}</p>
      </section>

      <section v-if="report" class="card">
        <div class="sec-head"><Icon name="clock" :size="16" /> 预留项（未接线）</div>
        <p class="sec-sub">{{ report.reserved.note }}</p>
        <div class="kv">
          <div class="kv-row" v-for="(v, k) in report.reserved.values" :key="k">
            <span class="k mono">{{ k }}</span><code class="mono">{{ v }}</code>
          </div>
        </div>
      </section>
    </template>

    <!-- ── 运行环境排障（所有人可见）── -->
    <section class="card">
      <div class="sec-head"><Icon name="server" :size="16" /> 运行环境</div>
      <div class="kv">
        <div class="kv-row"><span class="k">平台</span><code class="mono">{{ auth.platform?.os ?? '—' }} / {{ auth.platform?.arch ?? '—' }}</code></div>
        <div class="kv-row"><span class="k">发行版</span><code class="mono">{{ auth.platform?.distro ?? '—' }}</code></div>
        <div class="kv-row"><span class="k">内核</span><code class="mono">{{ auth.platform?.kernel ?? '—' }}</code></div>
        <div class="kv-row"><span class="k">资源档位</span><code class="mono">{{ auth.me?.tier ?? '—' }}</code></div>
        <div class="kv-row"><span class="k">当前用户</span><code class="mono">{{ auth.me?.user }}（{{ auth.me?.role }}）</code></div>
      </div>
    </section>

    <!-- 能力矩阵：排障时第一个要看的东西（菜单为什么置灰、功能为什么 501），
         故挂在锚点 #caps 上，topbar 系统信息胶囊一键直达。 -->
    <section id="caps" class="card">
      <div class="sec-head"><Icon name="shield" :size="16" /> 能力矩阵（{{ supportedCount }} / {{ caps.length }} 可用）</div>
      <table>
        <thead><tr><th>能力</th><th>状态</th><th>后端</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="[k, c] in caps" :key="k">
            <td class="mono">{{ k }}</td>
            <td><span class="badge" :class="c.supported ? 'badge-ok' : 'badge-danger'">{{ c.supported ? '可用' : '不可用' }}</span></td>
            <td class="dim">{{ c.backend ?? '—' }}</td>
            <td class="dim">{{ c.reason ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="tip">不可用项会在对应菜单自动置灰。原因码来自后端能力探测。</p>
    </section>

    <section class="card">
      <div class="sec-head"><Icon name="key" :size="16" /> 权限</div>
      <div class="perms">
        <code v-for="p in auth.me?.permissions ?? []" :key="p">{{ p }}</code>
      </div>
    </section>

    <!-- 角色管理（RBAC，需 user.manage） -->
    <section v-if="canRoles" class="card">
      <div class="sec-head"><Icon name="users" :size="16" /> 角色（RBAC）</div>
      <p class="sec-note">
        内置角色的权限由<strong>代码</strong>定义，不可改也不可删。自定义角色的权限必须是
        <strong>你自己拥有权限的子集</strong>——否则任何拿到用户管理权的人都能造出一个权限更大的角色
        再把自己升上去。另：角色权限变更对<strong>已登录会话</strong>需重新登录才生效（权限在登录时快照）。
      </p>
      <p v-if="roleErr" class="err" role="alert">{{ roleErr }}</p>

      <div v-if="roles.length" class="card flush">
        <table>
          <thead><tr><th>角色</th><th class="num">权限</th><th>来源</th><th /></tr></thead>
          <tbody>
            <tr v-for="r in roles" :key="r.name">
              <td class="mono">{{ r.name }}</td>
              <td class="num">
                {{ r.permissions.length }} 项
                <span v-if="!r.permissions.length" class="danger">（无法解析）</span>
              </td>
              <td>{{ r.builtin ? '内置' : '自定义' }}</td>
              <td class="nowrap">
                <button v-if="!r.builtin" class="btn-ghost btn-sm" @click="delRole = r.name">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="form" style="margin-top:12px">
        <div class="field">
          <span class="lbl">新角色名（小写字母开头，2~32 位，可用字母/数字/_/-）</span>
          <input v-model="roleName" class="inp" placeholder="ops-readonly" />
        </div>
        <div class="field">
          <span class="lbl">权限（勾选；列表来自后端白名单，前端不自行发明名字）</span>
          <div class="perm-grid">
            <label v-for="p in knownPerms" :key="p" class="perm-chk">
              <input v-model="rolePerms" type="checkbox" :value="p" />
              <code>{{ p }}</code>
            </label>
          </div>
        </div>
        <div class="actions">
          <button class="btn-primary" :disabled="roleBusy || !roleName.trim() || !rolePerms.length" @click="createRole">
            {{ roleBusy ? '创建中…' : '创建角色' }}
          </button>
        </div>
      </div>
    </section>

    <ConfirmDialog
      :open="!!delRole" danger title="删除角色"
      :detail="delRole ? `删除角色「${delRole}」？此操作不可撤销。` : ''"
      @confirm="delRole && deleteRole(delRole)" @cancel="delRole = null"
    />
  </div>
</template>

<style scoped>
.sec-sub { color: var(--c-text-mute); font-size: 12.5px; margin: 4px 0 10px; }
.sec-note { color: var(--c-text-mute); font-size: 12px; margin: 8px 0 0; }
.form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: 12.5px; color: var(--c-text-dim); }
.inp {
  background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 10px;
  padding: 9px 12px; color: var(--c-text); font-size: 13.5px; font-family: var(--mono);
}
.inp:focus { outline: none; border-color: var(--c-primary); }
.key-row { display: flex; gap: 8px; align-items: center; }
.key-row .inp { flex: 1; }
.set-ok { color: var(--c-ok); }
.danger { color: var(--c-danger); }
.actions { margin-top: 10px; }
.perm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px 14px; }
.perm-chk { display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer; }
.perm-chk code { font-family: var(--mono); color: var(--c-text-dim); }
.err { color: var(--c-danger); font-size: 13px; margin: 8px 0 0; }
.ok { color: var(--c-ok); font-size: 13px; margin: 8px 0 0; }
.kv { display: flex; flex-direction: column; }
.kv-row { display: flex; gap: 12px; font-size: 13px; padding: 7px 0; border-bottom: 1px solid var(--c-border); }
.kv-row:last-child { border-bottom: none; }
.kv-row > .k { width: 220px; flex: none; color: var(--c-text-dim); }
.perms { display: flex; flex-wrap: wrap; gap: 8px; }
.perms code { background: var(--c-primary-soft); color: var(--c-primary); padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-family: var(--mono); }
</style>
