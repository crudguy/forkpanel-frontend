<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fmtDateTime, roleLabel } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

/** 对应后端 `UserOut`（routes/users.rs）。此前用 `any[]`，字段拼写错误无从发现。 */
interface UserOut {
  id: number
  username: string
  role: string
  /** 目录作用域：文件与站点操作被限制在这些根内 */
  allowed_roots: string[]
  /** MFA 是否已启用：后端由 mfa_enabled_at IS NOT NULL 派生，与 /auth/me 口径一致 */
  mfa_enabled: boolean
  disabled: boolean
  created_at: number
  last_login_at: number | null
}

const auth = useAuthStore()
const users = ref<UserOut[]>([])
const error = ref('')
const loading = ref(true)
const notReady = ref(false)

/** 可分配的内置角色（owner 不可经 API 分配，故不在列）。 */
const ROLES = ['admin', 'operator', 'viewer']
const canManage = computed(() => auth.enabled(CAP.USER_MANAGE, 'user.manage'))

// 弹窗：新建 / 编辑共用
const editing = ref<UserOut | null>(null)
const showModal = ref(false)
const form = ref({ username: '', password: '', role: 'operator', rootsText: '', disabled: false })
const saving = ref(false)
const formErr = ref('')

// 删除确认
const delTarget = ref<UserOut | null>(null)

async function load() {
  error.value = ''; loading.value = true; notReady.value = false
  try {
    // 后端 GET /users 返回**裸数组** UserOut[]（不是包装对象）
    users.value = await api.get<UserOut[]>(API.users.list())
  } catch (e) {
    const t = errorText(e)
    // 后端用户管理仍占位（返回 unsupported）→ 友好提示而非报错
    if (t.includes('尚未接入') || t.includes('M5')) notReady.value = true
    else error.value = t
  } finally { loading.value = false }
}

function openCreate() {
  editing.value = null
  form.value = { username: '', password: '', role: 'operator', rootsText: '', disabled: false }
  formErr.value = ''
  showModal.value = true
}
function openEdit(u: UserOut) {
  editing.value = u
  form.value = {
    username: u.username, password: '', role: u.role,
    rootsText: (u.allowed_roots || []).join(', '), disabled: u.disabled,
  }
  formErr.value = ''
  showModal.value = true
}
async function save() {
  saving.value = true; formErr.value = ''
  const roots = form.value.rootsText.split(',').map(s => s.trim()).filter(Boolean)
  try {
    if (editing.value) {
      const body: any = { role: form.value.role, allowed_roots: roots, disabled: form.value.disabled }
      if (form.value.password) body.password = form.value.password
      await api.patch(API.users.patch(editing.value.id), body)
    } else {
      await api.post(API.users.create(), {
        username: form.value.username, password: form.value.password,
        role: form.value.role, allowed_roots: roots,
      })
    }
    showModal.value = false
    load()
  } catch (e) { formErr.value = errorText(e) }
  finally { saving.value = false }
}
function askDelete(u: UserOut) { delTarget.value = u }
async function doDelete() {
  if (!delTarget.value) return
  try { await api.del(API.users.remove(delTarget.value.id)); delTarget.value = null; load() }
  catch (e) { error.value = errorText(e) }
}
onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <span class="spacer" />
      <button class="btn-primary" :disabled="loading || notReady || !canManage" @click="openCreate">
        <Icon name="user-plus" :size="15" /> 新建用户
      </button>
      <button class="btn-ghost" :disabled="loading || notReady" @click="load">
        <Icon name="refresh" :size="15" /> 刷新
      </button>
    </div>

    <EmptyState v-if="!canManage" title="无用户管理权限" reason="需要 user.manage 权限" />

    <template v-else>
      <div v-if="notReady" class="card tip">
        <div class="sec-head"><Icon name="users" :size="16" /><span>用户管理即将推出</span></div>
        <p>用户管理模块尚在接入中（M5）。当前面板仅一个管理员账号，口令管理请在服务器终端执行：</p>
        <pre class="cmd">panel passwd &lt;用户名&gt;</pre>
      </div>

      <p v-else-if="error" class="err">{{ error }}</p>
      <div v-else-if="loading" class="skeleton box" />
      <div v-else class="card flush">
        <table>
          <thead><tr><th>用户名</th><th>角色</th><th>权限范围</th><th>状态</th><th>MFA</th><th>最后登录</th><th /></tr></thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td>{{ u.username }}</td>
              <td><span class="badge badge-primary">{{ roleLabel(u.role) }}</span></td>
              <td class="muted">{{ (u.allowed_roots || []).join(', ') || '全部' }}</td>
              <td><span class="badge" :class="u.disabled ? 'badge-danger' : 'badge-ok'">{{ u.disabled ? '已禁用' : '正常' }}</span></td>
              <td><span class="badge" :class="u.mfa_enabled ? 'badge-ok' : ''">{{ u.mfa_enabled ? '已启用' : '未启用' }}</span></td>
              <td class="muted">{{ u.last_login_at ? fmtDateTime(u.last_login_at) : '从未登录' }}</td>
              <td class="nowrap">
                <button v-if="u.role !== 'owner'" class="btn-ghost btn-sm" :disabled="!canManage" @click="openEdit(u)">
                  <Icon name="edit" :size="14" /> 编辑
                </button>
                <button v-if="u.role !== 'owner'" class="btn-danger btn-sm" :disabled="!canManage" @click="askDelete(u)">
                  <Icon name="trash" :size="14" /> 删除
                </button>
                <span v-else class="badge">引导账号</span>
              </td>
            </tr>
            <!-- colspan 必须等于表头列数（用户名/角色/权限范围/状态/MFA/最后登录/操作 = 7）。
                 此前写 5，空列表时 EmptyState 只占前 5 列，最后一列留空。 -->
            <tr v-if="!users.length"><td colspan="7"><EmptyState title="无用户" /></td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 新建 / 编辑弹窗 -->
    <div v-if="showModal" class="mask" @click.self="showModal = false">
      <div class="box">
        <div class="m-head">
          <Icon :name="editing ? 'edit' : 'user-plus'" :size="16" />
          <span>{{ editing ? '编辑用户' : '新建用户' }}</span>
        </div>
        <p v-if="formErr" class="err">{{ formErr }}</p>
        <div class="field">
          <label>用户名</label>
          <input v-model="form.username" :disabled="!!editing" :placeholder="editing ? '' : '登录名，1-64 字符'" />
        </div>
        <div class="field">
          <label>{{ editing ? '重置密码（留空不改）' : '密码' }}</label>
          <input v-model="form.password" type="password" :placeholder="editing ? '留空则保持原密码' : '至少 10 位，含两类字符'" />
        </div>
        <div class="field">
          <label>角色</label>
          <select v-model="form.role">
            <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
          </select>
        </div>
        <div class="field">
          <label>权限范围（目录白名单，逗号分隔，留空=全部）</label>
          <textarea v-model="form.rootsText" rows="2" placeholder="/srv/www,/var/backups" />
        </div>
        <div v-if="editing" class="field row">
          <label class="switch-row">
            <input type="checkbox" v-model="form.disabled" />
            <span class="switch" /><span>禁用该账号</span>
          </label>
        </div>
        <div class="m-acts">
          <button class="btn-ghost" :disabled="saving" @click="showModal = false">取消</button>
          <button class="btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog :open="!!delTarget" danger title="删除用户"
      :detail="delTarget ? `将删除 ${delTarget.username}（${delTarget.role}），其登录会话会立即失效。` : ''"
      @confirm="doDelete" @cancel="delTarget = null" />
  </div>
</template>

<style scoped>
.err { color: var(--c-danger); font-size: 13px; margin: 0 0 12px; }
.box { height: auto; }
.tip p { font-size: 13.5px; color: var(--c-text-dim); line-height: 1.7; margin: 6px 0; }
.cmd { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-sm);
       padding: 12px 14px; font-family: var(--mono); font-size: 13px; color: var(--c-primary); margin: 10px 0; }
.nowrap { white-space: nowrap; }
.muted { color: var(--c-text-dim); }
.badge-ok { color: var(--c-ok); }
.badge-danger { color: var(--c-danger); }

/* 弹窗（与 ServicesView/CronView 一致） */
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center;
        justify-content: center; z-index: 50; }
.box { width: 420px; max-width: 92vw; background: var(--c-surface); border: 1px solid var(--c-border);
       border-radius: var(--radius); padding: 18px 20px; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
.m-head { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 14px; }
.m-acts { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.field { margin-bottom: 14px; }
.field > label { display: block; font-size: 12.5px; color: var(--c-text-dim); margin-bottom: 6px; }
.field input, .field select, .field textarea {
  width: 100%; background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text);
  border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13.5px; font-family: inherit; }
.field textarea { resize: vertical; }
.field.row { display: flex; align-items: center; }
.switch-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.switch-row input { display: none; }
.switch { width: 38px; height: 20px; border-radius: 20px; background: var(--c-border); position: relative; transition: .15s; }
.switch-row input:checked + .switch { background: var(--c-primary); }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
                 border-radius: 50%; background: #fff; transition: .15s; }
.switch-row input:checked + .switch::after { left: 20px; }
</style>
