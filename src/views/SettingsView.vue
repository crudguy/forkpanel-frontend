<script setup lang="ts">
/**
 * 设置页：展示能力矩阵与档位。
 *
 * 这个页面的价值在于排障——用户说"某功能用不了"时，让他把这里的能力矩阵
 * 和不支持原因贴出来，比反复问"你装的什么系统"高效得多。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const caps = computed(() => Object.entries(auth.capabilities))
const supportedCount = computed(() => caps.value.filter(([, c]) => c.supported).length)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">设置</h2>
        <p class="page-sub">运行环境与能力矩阵排查</p>
      </div>
    </div>

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
.kv { display: flex; flex-direction: column; }
.kv-row { display: flex; gap: 12px; font-size: 13px; padding: 7px 0; border-bottom: 1px solid var(--c-border); }
.kv-row:last-child { border-bottom: none; }
.kv-row > .k { width: 96px; flex: none; color: var(--c-text-dim); }
.perms { display: flex; flex-wrap: wrap; gap: 8px; }
.perms code { background: var(--c-primary-soft); color: var(--c-primary); padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-family: var(--mono); }
</style>
