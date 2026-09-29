<script setup lang="ts">
/**
 * 设置页 = 运行环境排障（能力矩阵） + 面板设置（三段诚实模型）。
 *
 * 设置三段（与后端 routes/settings.rs 严格对应）：
 * - runtime：AI 助手 LLM 三键，可改即生效；api_key 经主密钥加密，后端永不明文回传
 * - deployment：部署级配置只读展示（改 config.toml / PANEL_READ_ONLY 并重启）
 * - reserved：种子预留键未接线（wired:false），如实标注，绝不伪装成可生效
 */
import { ref, computed, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import type { SettingsReport } from '@/api/types'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const canManage = computed(() => auth.can('settings.manage'))

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

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">设置</h2>
        <p class="page-sub">面板设置 · 运行环境与能力矩阵排查</p>
      </div>
    </div>

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

    <section class="card">
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
.err { color: var(--c-danger); font-size: 13px; margin: 8px 0 0; }
.ok { color: var(--c-ok); font-size: 13px; margin: 8px 0 0; }
.kv { display: flex; flex-direction: column; }
.kv-row { display: flex; gap: 12px; font-size: 13px; padding: 7px 0; border-bottom: 1px solid var(--c-border); }
.kv-row:last-child { border-bottom: none; }
.kv-row > .k { width: 220px; flex: none; color: var(--c-text-dim); }
.perms { display: flex; flex-wrap: wrap; gap: 8px; }
.perms code { background: var(--c-primary-soft); color: var(--c-primary); padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-family: var(--mono); }
</style>
