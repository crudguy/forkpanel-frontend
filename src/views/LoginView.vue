<script setup lang="ts">
/**
 * 登录页 + 首启向导。
 *
 * 刻意不做的事：
 * - 不用 GET 提交口令（口令不得进 URL / 访问日志 / Referer）
 * - 不在前端做任何"记住用户名"（减少信息泄露面）
 * - 不做常驻注册：首启向导只在后端数据库无 owner 且引导令牌有效时可用，
 *   令牌由 `panel serve` 首启打印到服务器终端（一次性、30 分钟）。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const router = useRouter()

// checking：status 查询中；bootstrap：首启向导；done：建号成功待登录
const mode = ref<'checking' | 'login' | 'bootstrap' | 'done'>('checking')
const tokenActive = ref(false)

onMounted(async () => {
  try {
    const s = await api.get<{ needs_bootstrap: boolean; token_active: boolean }>(API.auth.status())
    if (s.needs_bootstrap) {
      mode.value = 'bootstrap'
      tokenActive.value = s.token_active
      return
    }
  } catch { /* status 不可用时降级为登录表单，提交时后端会给出明确错误 */ }
  mode.value = 'login'
})

// ── 登录表单 ──
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

// ── 首启向导 ──
const bToken = ref('')
const bUsername = ref('')
const bPassword = ref('')
const bPassword2 = ref('')
const bError = ref('')
const bBusy = ref(false)

// 与后端 check_password_policy 同规则的本地镜像（≥10 位 + ≥2 字符类）
const policyOk = computed(() => {
  const p = bPassword.value
  if (p.length < 10) return false
  const classes =
    (/[a-z]/.test(p) ? 1 : 0) + (/[A-Z]/.test(p) ? 1 : 0) +
    (/\d/.test(p) ? 1 : 0) + (/[^a-zA-Z0-9]/.test(p) ? 1 : 0)
  return classes >= 2
})

async function submitBootstrap() {
  if (bBusy.value) return
  bError.value = ''
  if (!policyOk.value) { bError.value = '密码需至少 10 位，且包含至少两类字符'; return }
  if (bPassword.value !== bPassword2.value) { bError.value = '两次输入的密码不一致'; return }
  bBusy.value = true
  try {
    // skipAuthRedirect：令牌错误返回 401 时不触发全局"跳登录"事件
    await api.post(API.auth.bootstrap(), {
      token: bToken.value.trim(),
      username: bUsername.value.trim(),
      password: bPassword.value,
    }, { skipAuthRedirect: true })
    mode.value = 'done'
  } catch (e) {
    const code = (e as { code?: number }).code
    bError.value = code === 10005 ? '该面板已完成初始化，请直接登录' : errorText(e)
  } finally {
    bBusy.value = false
  }
}
</script>

<template>
  <div class="login">
    <!-- 品牌 LOGO（橙红渐变方块 + 狗头，与侧边栏品牌一致），所有模式共用 -->
    <div class="brand-logo"><Icon name="dog" :size="34" /></div>

    <!-- 首启：检测中 -->
    <form v-if="mode === 'checking'" class="card" @submit.prevent>
      <h1>叉叉面板 ForkPanel</h1>
    </form>

    <!-- 首启：创建 owner -->
    <form v-else-if="mode === 'bootstrap'" class="card" @submit.prevent="submitBootstrap">
      <h1>初始化面板</h1>

      <p v-if="!tokenActive" class="warn" role="alert">
        引导令牌不存在或已过期：在服务器上重启 <code>panel serve</code> 可重新生成
      </p>

      <label>
        <span>引导令牌</span>
        <input v-model="bToken" autocomplete="off" spellcheck="false" required :disabled="bBusy" placeholder="32 位十六进制" />
      </label>

      <label>
        <span>管理员用户名</span>
        <input v-model="bUsername" autocomplete="username" required :disabled="bBusy" placeholder="默认 admin" />
      </label>

      <label>
        <span>密码</span>
        <input v-model="bPassword" type="password" autocomplete="new-password" required :disabled="bBusy" />
      </label>
      <p class="hint" :class="{ ok: policyOk }">{{ policyOk ? '密码强度达标' : '至少 10 位，且包含字母 / 数字 / 符号中的两类' }}</p>

      <label>
        <span>确认密码</span>
        <input v-model="bPassword2" type="password" autocomplete="new-password" required :disabled="bBusy" />
      </label>

      <p v-if="bError" class="error" role="alert">{{ bError }}</p>

      <button type="submit" :disabled="bBusy">
        {{ bBusy ? '创建中…' : '创建管理员账号' }}
      </button>
    </form>

    <!-- 首启：成功 -->
    <form v-else-if="mode === 'done'" class="card" @submit.prevent>
      <h1>初始化完成</h1>
      <button type="submit" @click="mode = 'login'">去登录</button>
    </form>

    <!-- 常规登录 -->
    <form v-else class="card" @submit.prevent="submit">
      <h1>叉叉面板 ForkPanel</h1>

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

      <!-- 面板没有注册/找回页：重置口令只能在本机 CLI 完成，这里给出明确出口 -->
      <p class="tip">
        忘记口令？在服务器执行 <code>panel passwd &lt;用户名&gt;</code>
      </p>
    </form>
  </div>
</template>

<style scoped>
.login { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; min-height: 100vh; padding: 24px; }
.brand-logo {
  width: 64px; height: 64px; border-radius: 16px;
  display: grid; place-items: center;
  background: var(--gradient); box-shadow: var(--glow);
}
.card { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 14px; }
h1 { font-size: 20px; margin: 0; text-align: center; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; margin: 0; }
.warn {
  color: var(--c-warn); background: var(--c-warn-bg);
  border-radius: 8px; padding: 10px 12px; font-size: 13px; margin: 0;
}
.warn code { font-size: 12px; }
.hint { color: var(--c-text-dim); font-size: 12px; margin: -6px 0 0; }
.hint.ok { color: var(--c-ok); }
.tip { color: var(--c-text-dim); font-size: 12px; margin: 4px 0 0; text-align: center; }
.tip code { font-size: 12px; }
</style>
