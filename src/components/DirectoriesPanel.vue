<script setup lang="ts">
/**
 * 目录与文件位置：面板自身 / 数据 / 日志 / Web 服务器 / 前端内嵌。
 *
 * 数据源 `/api/v1/system/directories`（静态信息，加载一次即可，不轮询）。
 *
 * **为什么抽成独立组件**：这块内容与「实时趋势」毫无关系，原先却挂在
 * `SystemView` 的最底部（真机实测在 1139px 处、而视口只有 577px——等于藏起来）。
 * 用户想查"装到哪"时不会想到点"实时趋势"。现在它由 `/system/dirs` 独立 Tab
 * 承载，一处真相、一处入口。
 *
 * 所有路径来自后端 `PathLayout`（配置感知），与运行时实际落点一致；
 * 前端**不拼路径、不写默认值**——否则就成了"文档和现实各说一套"。
 */
import { ref, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import Icon from '@/components/Icon.vue'
import type { DirectoriesResp } from '@/api/types'

const dirs = ref<DirectoriesResp | null>(null)
const dirError = ref('')

async function load() {
  try {
    dirs.value = await api.get<DirectoriesResp>(API.system.directories())
    dirError.value = ''
  } catch (e) {
    // 任何失败都要说出来：这一页的全部价值就是"如实告诉用户装到哪"，
    // 静默空白会让人以为没有这功能。
    dirError.value = errorText(e)
  }
}

onMounted(load)
</script>

<template>
  <div class="dirs-panel">
    <div class="sec-head"><Icon name="folder" :size="16" /> 目录与文件位置
      <span class="legend">装到了哪 · 数据 · 日志 · Web 服务器</span>
    </div>
    <p v-if="dirError" class="err" role="alert">{{ dirError }}</p>
    <p v-else-if="!dirs" class="dirs-loading">正在读取目录信息…</p>
    <div v-else class="dir-grid">
      <section v-for="g in dirs.groups" :key="g.key" class="card dir-card">
        <h3 class="dir-title">{{ g.title }}</h3>
        <ul class="dir-list">
          <li v-for="(it, i) in g.items" :key="i" class="dir-row">
            <span class="dir-label">{{ it.label }}</span>
            <code class="dir-path">{{ it.path }}</code>
            <span v-if="it.desc" class="dir-desc">{{ it.desc }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* `.sec-head` / `.err` / `.card` / `.dim` 由 main.css 全局提供，此处不重复。
   `.legend` 与 `.dir-*` 原先是 SystemView 的 scoped 样式——scoped 不跨组件，
   必须随模板一起搬过来（注意 `.legend` 在 SystemView 里还有别处在用，
   那边保留、这边也留一份，两边各自作用域内生效）。 */
.legend { margin-left: auto; display: inline-flex; gap: 14px; align-items: center;
  font-size: var(--fs-12); color: var(--c-text-dim); font-weight: 500; }
.dirs-loading { padding: 4px 2px 0; margin: 0; color: var(--c-text-dim); font-size: var(--fs-12-5); }
.dir-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; margin: 4px 2px 14px; }
.dir-card { padding: 12px 14px; }
.dir-title { margin: 0 0 8px; font-size: var(--fs-13); font-weight: 600; color: var(--c-text); }
.dir-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.dir-row { display: flex; flex-direction: column; gap: 2px; padding-bottom: 7px;
  border-bottom: 1px dashed color-mix(in srgb, var(--c-border) 70%, transparent); }
.dir-row:last-child { border-bottom: none; padding-bottom: 0; }
.dir-label { font-size: var(--fs-12-5); color: var(--c-text); font-weight: 500; }
.dir-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-12);
  color: var(--c-primary); background: color-mix(in srgb, var(--c-border) 55%, transparent);
  padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; word-break: break-all; }
.dir-desc { font-size: var(--fs-11-5); color: var(--c-text-dim); line-height: 1.5; }
</style>
