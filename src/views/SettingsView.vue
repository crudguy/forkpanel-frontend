<script setup lang="ts">
/**
 * 设置页：展示能力矩阵与档位。
 *
 * 这个页面的价值在于排障——用户说"某功能用不了"时，让他把这里的能力矩阵
 * 和不支持原因贴出来，比反复问"你装的什么系统"高效得多。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const caps = computed(() => Object.entries(auth.capabilities))
const supportedCount = computed(() => caps.value.filter(([, c]) => c.supported).length)
</script>

<template>
  <div>
    <h2>设置</h2>

    <section>
      <h3>运行环境</h3>
      <p class="row"><span>平台</span><code>{{ auth.platform?.os ?? '—' }} / {{ auth.platform?.arch ?? '—' }}</code></p>
      <p class="row"><span>发行版</span><code>{{ auth.platform?.distro ?? '—' }}</code></p>
      <p class="row"><span>内核</span><code>{{ auth.platform?.kernel ?? '—' }}</code></p>
      <p class="row"><span>资源档位</span><code>{{ auth.me?.tier ?? '—' }}</code></p>
      <p class="row"><span>当前用户</span><code>{{ auth.me?.user }}（{{ auth.me?.role }}）</code></p>
    </section>

    <section>
      <h3>能力矩阵（{{ supportedCount }} / {{ caps.length }} 可用）</h3>
      <table>
        <thead><tr><th>能力</th><th>状态</th><th>后端</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="[k, c] in caps" :key="k">
            <td class="mono">{{ k }}</td>
            <td :class="c.supported ? 'ok' : 'bad'">{{ c.supported ? '可用' : '不可用' }}</td>
            <td class="dim">{{ c.backend ?? '—' }}</td>
            <td class="dim">{{ c.reason ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="tip">不可用项会在对应菜单自动置灰。原因码来自后端能力探测。</p>
    </section>

    <section>
      <h3>权限</h3>
      <div class="perms">
        <code v-for="p in auth.me?.permissions ?? []" :key="p">{{ p }}</code>
      </div>
    </section>
  </div>
</template>

<style scoped>
h2 { margin: 0 0 12px; font-size: 18px; }
h3 { margin: 16px 0 8px; font-size: 14px; }
section { margin-bottom: 8px; }
.row { display: flex; gap: 12px; font-size: 13px; margin: 4px 0; }
.row span { width: 90px; color: var(--c-text-dim); }
.mono { font-family: var(--mono); font-size: 12px; }
.dim { color: var(--c-text-dim); }
.ok { color: var(--c-ok); }
.bad { color: var(--c-danger); }
.tip { font-size: 12px; color: var(--c-text-dim); }
.perms { display: flex; flex-wrap: wrap; gap: 6px; }
.perms code { background: var(--c-hover); padding: 2px 8px; border-radius: 999px; font-size: 11px; }
</style>
