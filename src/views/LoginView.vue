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
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import Icon from '@/components/Icon.vue'
import { generateStrongPassword, passwordPolicyOk } from '@/utils/password'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

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

/** 登录后回跳：只接受站内绝对路径，拒绝 //evil.com 与 http(s):// 外链 */
function safeRedirect(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  return s.startsWith('/') && !s.startsWith('//') ? s : '/'
}

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await auth.login(username.value, password.value, needTotp.value ? totp.value : undefined)
    await router.replace(safeRedirect(route.query.redirect))
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code === 10010) {
      // 后端在开启 MFA 时返回特定码，此处引导输入动态口令
      needTotp.value = true
      error.value = '该账户已启用两步验证，请输入动态口令'
    } else if (code === 10002) {
      // 后端对"用户名不存在 / 口令错 / 动态口令错"一律返回 401 + 10002（防用户名
      // 枚举），而通用 errorText 把 10002 翻成"登录已过期，请重新登录"——在登录页
      // 上这话是错的：人已经站在登录页，"重新登录"只会让他反复输同一个错口令。
      // 此处按上下文改说凭据问题，并区分是否已在输动态口令。
      error.value = needTotp.value
        ? '动态口令不正确，或恢复码已被使用'
        : '用户名或口令不正确（用户名不存在与口令错误不会区分）'
    } else {
      error.value = errorText(e)
    }
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
const reveal = ref(false)        // 口令明文/掩码切换（含生成后的可见性）
const copied = ref(false)        // 「已复制」瞬时反馈

// 与后端 check_password_policy 同规则的本地镜像（≥10 位 + ≥2 字符类）
const policyOk = computed(() => passwordPolicyOk(bPassword.value))

// 小白一键生成强口令：填充两框并立即明文展示，避免手抄随机串出错
function genPassword() {
  const p = generateStrongPassword()
  bPassword.value = p
  bPassword2.value = p
  reveal.value = true
}

// 复制到剪贴板（优先异步 Clipboard API，退化到 execCommand 兜底）
async function copyPassword() {
  if (!bPassword.value) return
  try {
    await navigator.clipboard.writeText(bPassword.value)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = bPassword.value
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* 剪贴板不可用，忽略 */ }
    document.body.removeChild(ta)
  }
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1500)
}

// 首启「从文件读取令牌」：浏览器经 localhost 端点取服务器磁盘上的明文令牌，
// 免手抄终端输出。仅 localhost 可取（远程 / 反代在 non-loopback 终结 → 403）；
// 面板已初始化（owner 已存在 / 令牌已用 / 过期）→ 404。
const readTokenError = ref('')
async function readTokenFromFile() {
  if (bBusy.value) return
  readTokenError.value = ''
  try {
    const d = await api.get<{ token: string }>(API.auth.bootstrapToken(), { skipAuthRedirect: true })
    if (d?.token) {
      bToken.value = d.token
      bError.value = ''        // 取到令牌清掉可能的「令牌过期」提示
    } else {
      readTokenError.value = '未能取到令牌，请在服务器本地访问面板'
    }
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code === 10003) {
      readTokenError.value = '该操作仅限本机（localhost）访问：请在服务器本地或经 SSH 隧道（ssh -L）访问面板'
    } else if (code === 10004) {
      readTokenError.value = '面板已完成初始化或令牌不可用，请直接登录'
      mode.value = 'login'
    } else {
      readTokenError.value = errorText(e)
    }
  }
}

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
        <div class="pw-field">
          <input v-model="bToken" autocomplete="off" spellcheck="false" required :disabled="bBusy" placeholder="32 位十六进制" />
          <button type="button" class="pw-toggle" :disabled="bBusy" @click="readTokenFromFile">从文件读取</button>
        </div>
      </label>
      <p v-if="readTokenError" class="error" role="alert">{{ readTokenError }}</p>

      <label>
        <span>管理员用户名</span>
        <input v-model="bUsername" autocomplete="username" required :disabled="bBusy" placeholder="默认 admin" />
      </label>

      <label>
        <span>密码</span>
        <div class="pw-field">
          <input v-model="bPassword" :type="reveal ? 'text' : 'password'" autocomplete="new-password" required :disabled="bBusy" />
          <button type="button" class="pw-toggle" :disabled="bBusy" @click="reveal = !reveal">{{ reveal ? '隐藏' : '显示' }}</button>
        </div>
      </label>
      <div class="pw-actions">
        <button type="button" class="btn-ghost btn-sm" :disabled="bBusy" @click="genPassword">生成强口令</button>
        <button type="button" class="btn-ghost btn-sm" :disabled="bBusy || !bPassword" @click="copyPassword">{{ copied ? '已复制' : '复制' }}</button>
      </div>
      <p class="hint" :class="{ ok: policyOk }">{{ policyOk ? '密码强度达标' : '至少 10 位，且包含字母 / 数字 / 符号中的两类' }}</p>

      <label>
        <span>确认密码</span>
        <input v-model="bPassword2" :type="reveal ? 'text' : 'password'" autocomplete="new-password" required :disabled="bBusy" />
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
h1 { font-size: var(--fs-20); margin: 0; text-align: center; }
label { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-13); }
.error { color: var(--c-danger); font-size: var(--fs-13); margin: 0; }
.warn {
  color: var(--c-warn); background: var(--c-warn-bg);
  border-radius: 8px; padding: 10px 12px; font-size: var(--fs-13); margin: 0;
}
.warn code { font-size: var(--fs-12); }
.hint { color: var(--c-text-dim); font-size: var(--fs-12); margin: -6px 0 0; }
.hint.ok { color: var(--c-ok); }
.tip { color: var(--c-text-dim); font-size: var(--fs-12); margin: 4px 0 0; text-align: center; }
.tip code { font-size: var(--fs-12); }
.pw-field { display: flex; gap: 8px; align-items: stretch; }
.pw-field input { flex: 1; min-width: 0; }
.pw-toggle {
  flex: none; padding: 0 12px; font-size: var(--fs-13);
  border-radius: var(--radius-xs); border: 1px solid var(--c-border);
  background: transparent; color: var(--c-text-dim); cursor: pointer;
}
.pw-toggle:hover:not(:disabled) { color: var(--c-text); }
.pw-actions { display: flex; gap: 8px; margin: -2px 0 2px; }
</style>
