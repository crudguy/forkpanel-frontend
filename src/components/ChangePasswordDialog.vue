<script setup lang="ts">
/**
 * 修改密码弹窗（topbar 用户菜单入口）。
 *
 * 调 POST /api/v1/auth/password（{ old, new }，成功 204）。
 * 后端行为（routes/auth.rs change_password）：
 * - 旧密码错 / 新旧相同 / 不满足策略 → 400（code 10001，detail.field 指明字段）；
 *   刻意不是 401，避免前端误判会话失效而全局登出。
 * - 成功后吊销**其他**会话，当前会话保留。
 * 策略本地镜像与后端 check_password_policy 同规则：≥10 位 + ≥2 字符类（同 LoginView）。
 */
import { ref, computed, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { api, errorText, ApiError } from '@/api/client'
import { API } from '@/api/endpoints'
import { useModal } from '@/composables/useModal'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// 弹窗统一行为：Esc 关闭 + 焦点陷阱（审计 U1）
const box = ref<HTMLElement | null>(null)
useModal(() => props.open, box, () => { if (!busy.value && !done.value) emit('close') })

const old = ref('')
const nw = ref('')
const confirm2 = ref('')
const busy = ref(false)
const error = ref('')
const done = ref(false)

// 每次打开重置表单，避免残留上次输入
watch(() => props.open, (v) => {
  if (v) {
    old.value = ''; nw.value = ''; confirm2.value = ''
    error.value = ''; done.value = false; busy.value = false
  }
})

// 与后端 check_password_policy 同规则的本地镜像（≥10 位 + ≥2 字符类）
const policyOk = computed(() => {
  const p = nw.value
  if (p.length < 10) return false
  const classes =
    (/[a-z]/.test(p) ? 1 : 0) + (/[A-Z]/.test(p) ? 1 : 0) +
    (/\d/.test(p) ? 1 : 0) + (/[^a-zA-Z0-9]/.test(p) ? 1 : 0)
  return classes >= 2
})

async function submit() {
  if (busy.value || done.value) return
  error.value = ''
  if (!old.value) { error.value = '请输入当前密码'; return }
  if (!policyOk.value) { error.value = '新密码需至少 10 位，且包含至少两类字符'; return }
  if (nw.value === old.value) { error.value = '新密码需与当前密码不同'; return }
  if (nw.value !== confirm2.value) { error.value = '两次输入的新密码不一致'; return }
  busy.value = true
  try {
    await api.post(API.auth.password(), { old: old.value, new: nw.value })
    done.value = true
  } catch (e) {
    const detail = (e as ApiError).detail as { field?: string } | undefined
    if ((e as ApiError).status === 400 && detail?.field === 'old') error.value = '当前密码不正确'
    else error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div ref="box" class="modal" role="dialog" aria-modal="true" aria-labelledby="pwd-title">
      <h3 id="pwd-title">
        <Icon name="key" :size="16" /> 修改密码
      </h3>

      <template v-if="!done">
        <label class="blk">当前密码
          <input v-model="old" type="password" autocomplete="current-password" :disabled="busy" />
        </label>
        <label class="blk">新密码
          <input v-model="nw" type="password" autocomplete="new-password" :disabled="busy"
            placeholder="至少 10 位，含两类字符" />
        </label>
        <label class="blk">确认新密码
          <input v-model="confirm2" type="password" autocomplete="new-password" :disabled="busy"
            @keyup.enter="submit" />
        </label>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn-ghost" :disabled="busy" @click="emit('close')">取消</button>
          <button class="btn-primary" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '确认修改' }}</button>
        </div>
      </template>

      <template v-else>
        <p class="ok-note"><Icon name="check" :size="16" /> 密码已修改。其他设备的登录会话已退出，当前会话不受影响。</p>
        <div class="modal-actions">
          <button class="btn-primary" @click="emit('close')">完成</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: min(400px, 92vw); background: var(--c-surface-2); border: 1px solid var(--c-border);
  border-radius: 12px; padding: 20px; }
.modal h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; }
.blk { display: block; margin-bottom: 12px; font-size: 13px; color: var(--c-text-dim); }
.blk input { width: 100%; margin-top: 4px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.ok-note { display: flex; align-items: center; gap: 8px; color: var(--c-ok, #3fb950); font-size: 13.5px; margin: 4px 0 12px; }
</style>
