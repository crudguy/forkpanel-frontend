<script setup lang="ts">
/**
 * 登录页。
 *
 * 刻意不做的事：
 * - 不用 GET 提交口令（口令不得进 URL / 访问日志 / Referer）
 * - 不在前端做任何"记住用户名"（减少信息泄露面）
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { errorText } from '@/api/client'

const auth = useAuthStore()
const router = useRouter()

const username = ref('')
const password = ref('')
const totp = ref('')
const needTotp = ref(false)
const error = ref('')
const busy = ref(false)

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await auth.login(username.value, password.value, needTotp.value ? totp.value : undefined)
    await router.replace('/')
  } catch (e) {
    error.value = errorText(e)
    // 后端在开启 MFA 时返回特定码，此处引导输入动态口令
    if ((e as { code?: number }).code === 10010) needTotp.value = true
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="card" @submit.prevent="submit">
      <h1>服务器管理面板</h1>
      <p class="sub">请登录以继续</p>

      <label>
        <span>用户名</span>
        <input v-model="username" autocomplete="username" required :disabled="busy" />
      </label>

      <label>
        <span>密码</span>
        <input v-model="password" type="password" autocomplete="current-password" required :disabled="busy" />
      </label>

      <label v-if="needTotp">
        <span>动态口令</span>
        <input v-model="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位数字" />
      </label>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <button type="submit" :disabled="busy">
        {{ busy ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login { display: grid; place-items: center; min-height: 100vh; padding: 24px; }
.card { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 14px; }
h1 { font-size: 20px; margin: 0; }
.sub { color: var(--c-text-dim); margin: -8px 0 4px; font-size: 13px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; margin: 0; }
</style>
