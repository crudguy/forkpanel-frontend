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
// 统一关闭出口（Esc / 点遮罩 / X 按钮 / 取消按钮都走它）：沿用原本的约束——
// 提交中不允许关（会留下半改状态），完成态只能点「完成」（要让用户确认看到结果）。
const { close: modalClose } = useModal(
  () => props.open,
  box,
  () => { if (!busy.value && !done.value) emit('close') },
)

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
  <div v-if="open" class="mask" @click.self="modalClose">
    <div ref="box" class="modal" role="dialog" aria-modal="true" aria-labelledby="pwd-title">
      <div class="modal-head">
        <h3 id="pwd-title" class="modal-title">
          <Icon name="key" :size="16" /> 修改密码
        </h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>

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
        <!-- 字段级 / 整段错误改用公共 .err-bar（此前 .err 只是纯红字，没有底色与图标，
             与站点弹窗的错误条长得完全不同） -->
        <p v-if="error" class="err-bar" role="alert">{{ error }}</p>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" :disabled="busy" @click="modalClose">取消</button>
            <button class="btn-primary" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '确认修改' }}</button>
          </div>
        </div>
      </template>

      <template v-else>
        <!-- 完成态是**非瞬态**信息（要一直看到用户点关闭），故不用 toast，
             用公共 .hint-note.is-ok —— 与站点弹窗的成功态同一套视觉。 -->
        <p class="hint-note is-ok">
          <Icon name="check" :size="16" class="ic" />
          <span>密码已修改。其他设备的登录会话已退出，当前会话不受影响。</span>
        </p>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-primary" @click="modalClose">完成</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩 / 弹窗框 / 标题行 / 关闭按钮 / 操作条 / 错误条 / 成功条全部取 main.css 公共类。
   此前这里整套私有复制（宽 400、圆角 12、padding 20、z-index 50），与全局不一致——
   守卫 check-modal 只扫 views 没扫 components，组件里因此长期漏网，现已无处可藏。 */
</style>
