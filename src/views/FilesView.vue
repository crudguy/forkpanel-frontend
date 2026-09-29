<script setup lang="ts">
/**
 * 文件管理。
 *
 * 三条 UI 纪律（对应后端三道防线）：
 * 1. 路径永远由后端返回的规范路径驱动，前端不拼接 `..`
 *    —— 前端拼路径毫无意义，后端沙箱才是唯一防线，前端只需不误导用户。
 * 2. 敏感文件标红且禁止打开（后端也会拒，但前端先挡一层）。
 * 3. 删除目录必须走带确认词的对话框 —— 面板不提供"一键 rm -rf"。
 */
import { ref, onMounted, watch, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface Entry {
  name: string; kind: 'dir' | 'file' | 'symlink' | 'other'
  size: number; mode: string | null; owner: string | null
  modified: number; sensitive: boolean
}
interface ListResp { path: string; entries: Entry[]; truncated: boolean }

const auth = useAuthStore()
const path = ref('/')
const entries = ref<Entry[]>([])
const truncated = ref(false)
const loading = ref(false)
const error = ref('')
const showHidden = ref(false)

const editing = ref<{ name: string; content: string; mtime: number } | null>(null)
const confirmDel = ref<{ name: string; isDir: boolean } | null>(null)

const canWrite = computed(() => auth.can('file.write'))

async function load() {
  loading.value = true; error.value = ''
  try {
    const r = await api.get<ListResp>('/api/v1/files/list', {
      params: { path: path.value, hidden: showHidden.value },
    })
    entries.value = r.entries; truncated.value = r.truncated
    path.value = r.path
  } catch (e) { error.value = errorText(e); entries.value = [] }
  finally { loading.value = false }
}

onMounted(load)
watch(showHidden, load)

function up() {
  const p = path.value.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  path.value = i <= 0 ? '/' : p.slice(0, i)
  load()
}
function enter(e: Entry) {
  if (e.kind !== 'dir') return open(e)
  path.value = (path.value.replace(/\/+$/, '') + '/' + e.name) || '/'
  load()
}

async function open(e: Entry) {
  if (e.sensitive) { error.value = '该文件受保护，不可通过面板读取'; return }
  try {
    const r = await api.get<{ content: string | null; binary: boolean; size: number }>(
      '/api/v1/files/read', {
        params: { path: `${path.value.replace(/\/+$/, '')}/${e.name}` },
      })
    if (r.binary) { error.value = '二进制文件不支持在线编辑'; return }
    editing.value = { name: e.name, content: r.content ?? '', mtime: e.modified }
  } catch (err) { error.value = errorText(err) }
}

async function save() {
  if (!editing.value) return
  try {
    await api.post('/api/v1/files/write', {
      path: path.value.replace(/\/+$/, '') + '/' + editing.value.name,
      content: editing.value.content,
      // 乐观锁：带上读到的 mtime，被别人改过则拒绝覆盖
      expect_mtime: editing.value.mtime,
    })
    editing.value = null
    load()
  } catch (e) { error.value = errorText(e) }
}

async function doDelete() {
  if (!confirmDel.value) return
  try {
    await api.post('/api/v1/files/delete', {
      path: path.value.replace(/\/+$/, '') + '/' + confirmDel.value.name,
      // 目录必须显式声明——后端默认拒绝，前端也必须显式确认
      allow_dir: confirmDel.value.isDir,
    })
    confirmDel.value = null
    load()
  } catch (e) { error.value = errorText(e) }
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">文件</h2>
        <p class="page-sub"><code class="cwd">{{ path }}</code></p>
      </div>
      <span class="spacer" />
      <label class="hid"><input v-model="showHidden" type="checkbox" /> 显示隐藏</label>
      <button class="btn-ghost" :disabled="path === '/'" @click="up"><Icon name="chevron" :size="14" /> 上级</button>
      <button class="btn-primary" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
    </div>

    <EmptyState v-if="!auth.supported(CAP.FILE_READ) && !entries.length"
      title="当前环境不支持文件管理"
      :reason="auth.capabilities[CAP.FILE_READ]?.reason ?? undefined" />

    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="truncated" class="warn">结果已被截断（单次最多 1000 项）</p>

    <div v-if="entries.length" class="card flush">
      <table>
        <thead><tr><th>名称</th><th>大小</th><th>权限</th><th>属主</th><th>修改时间</th><th /></tr></thead>
        <tbody>
          <tr v-for="e in entries" :key="e.name" :class="{ sens: e.sensitive }">
            <td>
              <a href="#" class="fname" @click.prevent="enter(e)">
                <Icon :name="e.kind === 'dir' ? 'folder' : 'file'" :size="15" />
                {{ e.name }}
              </a>
              <span v-if="e.sensitive" class="badge badge-danger">受保护</span>
            </td>
            <td class="num">{{ e.kind === 'dir' ? '—' : fmtSize(e.size) }}</td>
            <td class="num mono">{{ e.mode ?? '—' }}</td>
            <td>{{ e.owner ?? '—' }}</td>
            <td class="num">{{ new Date(e.modified * 1000).toLocaleString() }}</td>
            <td class="nowrap">
              <button v-if="canWrite && e.kind === 'file' && !e.sensitive" class="btn-ghost btn-sm" @click="open(e)">编辑</button>
              <button v-if="canWrite" class="btn-danger btn-sm" @click="confirmDel = { name: e.name, isDir: e.kind === 'dir' }">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <EmptyState v-else-if="!loading" title="空目录" />

    <div v-if="editing" class="card editor">
      <header>
        <Icon name="file" :size="16" />
        <strong>{{ editing.name }}</strong>
        <span class="spacer" />
        <button class="btn-ghost" @click="editing = null">取消</button>
        <button class="btn-primary" @click="save">保存</button>
      </header>
      <textarea v-model="editing.content" spellcheck="false" />
      <p class="tip">保存时会校验修改时间，若文件已被他人改动将拒绝覆盖</p>
    </div>

    <ConfirmDialog
      :open="!!confirmDel" danger
      :title="confirmDel?.isDir ? '删除目录（含其全部内容）' : '删除文件'"
      :detail="`即将删除 ${confirmDel?.name}。此操作不可撤销。`"
      :confirm-word="confirmDel?.isDir ? confirmDel.name : undefined"
      @confirm="doDelete" @cancel="confirmDel = null" />
  </div>
</template>

<style scoped>
.cwd { font-family: var(--mono); font-size: 12.5px; color: var(--c-text-dim); background: var(--c-surface-2); padding: 1px 7px; border-radius: 6px; }
.hid { display: flex; align-items: center; gap: 5px; font-size: 12px; margin: 0; color: var(--c-text-dim); }
.fname { display: inline-flex; align-items: center; gap: 7px; }
tr.sens { background: var(--c-warn-bg); }
.editor { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.editor header { display: flex; align-items: center; gap: 8px; }
.editor textarea { min-height: 320px; font-family: var(--mono); font-size: 13px; }
</style>
