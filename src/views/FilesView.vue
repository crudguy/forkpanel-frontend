<script setup lang="ts">
/**
 * 文件管理。
 *
 * 三条 UI 纪律（对应后端三道防线）：
 * 1. 路径永远由后端返回的规范路径驱动，前端不拼接 `..`
 *    —— 前端拼路径毫无意义，后端沙箱才是唯一防线，前端只需不误导用户。
 * 2. 敏感文件标红且禁止打开（后端也会拒，但前端先挡一层）。
 * 3. 删除目录必须走带确认词的对话框 —— 面板不提供"一键 rm -rf"。
 *
 * 上传/下载（#45 后续闭环）：上传走 putRaw（octet-stream 原始字节，≤100MB）；
 * 下载用同源 <a href> 直链（GET 带 Cookie，浏览器原生保存）；批量操作走
 * /files/action 逐项报告。
 */
import { ref, onMounted, watch, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import TrashPanel from '@/components/TrashPanel.vue'

interface Entry {
  name: string; kind: 'dir' | 'file' | 'symlink' | 'other'
  size: number; mode: string | null; owner: string | null
  modified: number; sensitive: boolean
}
interface ListResp { path: string; entries: Entry[]; truncated: boolean }
interface ActionItem { path: string; ok: boolean; error?: string | null }
interface ActionResp { op: string; results: ActionItem[]; ok_count: number; fail_count: number }

const auth = useAuthStore()
const path = ref('/')
const entries = ref<Entry[]>([])
const truncated = ref(false)
const loading = ref(false)
const error = ref('')
const showHidden = ref(false)

const editing = ref<{ name: string; content: string; mtime: number; hasMore: boolean } | null>(null)
const confirmDel = ref<{ name: string; isDir: boolean } | null>(null)

/** 批量选择：存条目名（当前目录内唯一） */
const selected = ref<Set<string>>(new Set())
const uploading = ref(false)
const batchBusy = ref(false)
const batchErr = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

/** 软删除的反馈（"已移入回收站"），与 error 分开：它不是错误 */
const notice = ref('')
const showTrash = ref(false)

const canWrite = computed(() => auth.can('file.write'))

function full(p: string) {
  return path.value.replace(/\/+$/, '') + '/' + p
}

async function load() {
  loading.value = true; error.value = ''
  try {
    const r = await api.get<ListResp>(API.files.list(), {
      params: { path: path.value, hidden: showHidden.value },
    })
    entries.value = r.entries; truncated.value = r.truncated
    path.value = r.path
    selected.value = new Set() // 换目录即清空选择
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
    const r = await api.get<{ content: string | null; binary: boolean; size: number; has_more: boolean }>(
      API.files.read(), {
        params: { path: `${path.value.replace(/\/+$/, '')}/${e.name}` },
      })
    if (r.binary) { error.value = '二进制文件不支持在线编辑'; return }
    // has_more 为真说明后端按 2MB 上限截断了：完整文件比这大，编辑框里只有前半截。
    // 若允许写回，会用截断版覆盖原文件——这是唯一会造成不可逆数据丢失的口子，必须拦死。
    editing.value = { name: e.name, content: r.content ?? '', mtime: e.modified, hasMore: r.has_more }
  } catch (err) { error.value = errorText(err) }
}

async function save() {
  if (!editing.value) return
  // 截断预览严禁写回：否则覆盖原文件即丢失后半截（不可逆）
  if (editing.value.hasMore) {
    error.value = '当前文件大于 2MB，编辑器只载入了前半部分；保存会截断原文件，已禁止。请下载后用本地编辑器修改。'
    return
  }
  try {
    await api.post(API.files.write(), {
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
  const name = confirmDel.value.name
  try {
    // 默认**软删除**：误删是高频事件，走回收站留出恢复窗口。
    // 回收站里的「彻底删除」才是不可逆的那一步——两步分开，责任清晰。
    // 也正因如此这里不再需要 allow_dir：软的，可撤销。
    await api.post(API.files.trash(), { path: full(name) })
    notice.value = `已移入回收站：${name}`
    confirmDel.value = null
    load()
  } catch (e) { error.value = errorText(e) }
}

// ── 上传（多选，逐文件 PUT 原始字节）──
function pickUpload() { fileInput.value?.click() }
/** 超过这个大小就走分片通道。小文件走单请求更省往返（分片至少要 3 次 HTTP）。 */
const MULTIPART_THRESHOLD = 8 * 1024 * 1024

/** 分片上传进度文案（如 "big.iso（3/12 片）"）；空串表示当前没有进行中的上传 */
const uploadLabel = ref('')

/**
 * 分片上传：init → 查已传分片 → 逐片 PUT → complete。
 *
 * 先查 status 再传，是为了**断点续传**：同一会话重试时（例如网络抖了一下、用户重选
 * 同一个文件）能跳过已成功的分片。注意每次 init 都会新建会话，所以当前实现是
 * "会话内续传"——它覆盖了"单片传输失败后重试"这类最常见的中断。真正跨会话的续传
 * 需要按文件指纹索引历史会话，那是另一个量级的设计，不做半成品。
 */
async function uploadMultipart(f: File, onProgress: (done: number, total: number) => void) {
  const init = await api.post<{ upload_id: string; chunk_size: number; total_chunks: number }>(
    API.files.multipartInit(), { path: full(f.name), size: f.size })
  const { upload_id, chunk_size, total_chunks } = init
  const st = await api.get<{ received: number[] }>(API.files.multipartItem(upload_id))
  const have = new Set(st.received)
  for (let i = 0; i < total_chunks; i++) {
    if (!have.has(i)) {
      const start = i * chunk_size
      const blob = f.slice(start, Math.min(start + chunk_size, f.size))
      await api.putRaw(API.files.multipartChunk(upload_id, i), blob)
    }
    onProgress(i + 1, total_chunks)
  }
  return api.post<{ path: string; size: number }>(API.files.multipartComplete(upload_id))
}

async function onUploadFiles(ev: Event) {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 允许重复选同一文件
  if (!files.length || !canWrite.value) return
  uploading.value = true; error.value = ''; notice.value = ''
  const failed: string[] = []
  const usedMultipart = files.some(f => f.size > MULTIPART_THRESHOLD)
  try {
    for (const f of files) {
      try {
        if (f.size > MULTIPART_THRESHOLD) {
          uploadLabel.value = `${f.name}（准备中…）`
          await uploadMultipart(f, (done, total) => {
            uploadLabel.value = `${f.name}（${done}/${total} 片）`
          })
        } else {
          await api.putRaw<{ path: string; size: number }>(
            API.files.upload(), f, { params: { path: full(f.name) } })
        }
      } catch (err) { failed.push(`${f.name}: ${errorText(err)}`) }
      finally { uploadLabel.value = '' }
    }
    if (failed.length) error.value = `部分上传失败 — ${failed.join('；')}`
    else if (usedMultipart) notice.value = `已上传 ${files.length} 个文件（大文件走了分片通道）`
    await load()
  } finally { uploading.value = false; uploadLabel.value = '' }
}

// ── 下载（同源直链：GET 带 Cookie，浏览器原生保存）──
function download(e: Entry) {
  window.location.href = `/api/v1/files/download?path=${encodeURIComponent(full(e.name))}`
}

// ── 通用输入弹窗（审计 F3/U5）：替代 window.prompt——原生弹窗脱离设计系统
//    且无校验；此处统一收集输入，确认后关闭并回调，错误走页面既有通道
const ask = ref<{
  title: string; label: string; value: string; placeholder?: string; okText?: string;
  validate?: (v: string) => string | null;
  onOk: (v: string) => void;
} | null>(null)
function askOk() {
  const a = ask.value; if (!a) return
  if (a.validate) {
    const err = a.validate(a.value)
    if (err) { error.value = err; return }
  }
  const cb = a.onOk
  ask.value = null
  cb(a.value.trim())
}

// ── 建目录 / 重命名 / 改权限（审计 F3：后端路由早已注册，此前前端零调用）──
function askMkdir() {
  ask.value = {
    title: '新建文件夹', label: '文件夹名称', value: '', placeholder: 'new-folder',
    okText: '创建',
    onOk: (v) => {
      api.post(API.files.mkdir(), { path: full(v) })
        .then(() => { notice.value = `已创建 ${v}`; load() })
        .catch((e) => { error.value = errorText(e) })
    },
  }
}

function askRename(e: Entry) {
  ask.value = {
    title: '重命名', label: '新名称', value: e.name, okText: '重命名',
    validate: (v) => (!v.trim() ? '名称不能为空' : null),
    onOk: (v) => {
      api.post(API.files.rename(), { from: full(e.name), to: full(v) })
        .then(() => { notice.value = `已重命名为 ${v}`; load() })
        .catch((err) => { error.value = errorText(err) })
    },
  }
}

function askChmod(e: Entry) {
  ask.value = {
    title: '修改权限', label: '八进制权限（如 644 / 755）',
    value: e.mode ?? '', placeholder: '644', okText: '应用',
    validate: (v) => (/^[0-7]{3,4}$/.test(v.trim()) ? null : '必须是 3-4 位八进制数，如 644'),
    onOk: (v) => {
      api.post(API.files.chmod(), { path: full(e.name), mode: v })
        .then(() => { notice.value = `已修改 ${e.name} 权限为 ${v}`; load() })
        .catch((err) => { error.value = errorText(err) })
    },
  }
}

// ── 批量 ──
const allChecked = computed({
  get: () => entries.value.filter(e => !e.sensitive).length > 0 &&
    entries.value.filter(e => !e.sensitive).every(e => selected.value.has(e.name)),
  set: (v: boolean) => {
    selected.value = v
      ? new Set(entries.value.filter(e => !e.sensitive).map(e => e.name))
      : new Set()
  },
})
function toggle(e: Entry) {
  if (e.sensitive) return
  const s = new Set(selected.value)
  s.has(e.name) ? s.delete(e.name) : s.add(e.name)
  selected.value = s
}
const selectedEntries = computed(() =>
  entries.value.filter(e => selected.value.has(e.name)))

const confirmBatchDel = ref(false)
function runBatch(op: 'trash' | 'move' | 'copy') {
  const paths = selectedEntries.value.map(e => full(e.name))
  if (!paths.length || batchBusy.value) return
  batchErr.value = ''
  notice.value = ''
  if (op !== 'trash') {
    // 目标目录改走统一弹窗（审计 U5：替代 window.prompt）
    ask.value = {
      title: op === 'move' ? '移动到…' : '复制到…',
      label: `目标目录（${op === 'move' ? '移动' : '复制'}到该目录下，同名跳过）`,
      value: path.value, okText: op === 'move' ? '移动' : '复制',
      validate: (v) => (!v.trim() ? '目标目录不能为空' : null),
      onOk: (dest) => execBatch(op, paths, dest),
    }
    return
  }
  execBatch(op, paths)
}

async function execBatch(op: 'trash' | 'move' | 'copy', paths: string[], dest?: string) {
  batchBusy.value = true
  try {
    const r = await api.post<ActionResp>(API.files.action(), { op, paths, dest })
    if (r.fail_count > 0) {
      batchErr.value = `${op} 完成：成功 ${r.ok_count}，失败 ${r.fail_count} — ` +
        r.results.filter(x => !x.ok).slice(0, 3).map(x => `${x.path}: ${x.error}`).join('；')
    }
    if (op === 'trash' && r.ok_count > 0) {
      notice.value = `已移入回收站（${r.ok_count} 项），可在回收站恢复`
    }
    selected.value = new Set()
    await load()
  } catch (e) { batchErr.value = errorText(e) }
  finally { batchBusy.value = false }
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
        <p class="page-sub"><code class="cwd">{{ path }}</code></p>
      </div>
      <span class="spacer" />
      <label class="hid"><input v-model="showHidden" type="checkbox" /> 显示隐藏</label>
      <button class="btn-ghost" :disabled="path === '/'" @click="up"><Icon name="chevron" :size="14" /> 上级</button>
      <button class="btn-ghost" :disabled="loading" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
      <button v-if="canWrite" class="btn-ghost" :disabled="loading" @click="askMkdir"><Icon name="plus" :size="15" /> 新建文件夹</button>
      <button class="btn-ghost" :disabled="!auth.supported(CAP.FILE_READ)" title="回收站：被移入的文件可在这里恢复" @click="showTrash = true">
        <Icon name="trash" :size="15" /> 回收站
      </button>
      <button v-if="canWrite" class="btn-primary" :disabled="uploading" @click="pickUpload"
        :title="`超过 ${MULTIPART_THRESHOLD / 1024 / 1024} MB 的文件自动走分片上传（中断后可续传）`">
        <Icon name="plus" :size="15" /> {{ uploadLabel || (uploading ? '上传中…' : '上传') }}
      </button>
      <input ref="fileInput" type="file" multiple hidden @change="onUploadFiles" />
    </div>

    <EmptyState v-if="!auth.supported(CAP.FILE_READ) && !entries.length"
      title="当前环境不支持文件管理"
      :reason="auth.capabilities[CAP.FILE_READ]?.reason ?? undefined" />

    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok-msg" role="status">{{ notice }}</p>
    <!-- batchErr 是批量操作失败，与 error 同类 → 同用红色错误通道（审计 U14）；
         truncated / hasMore 是提示性警告，保留黄色 -->
    <p v-if="batchErr" class="err" role="alert">{{ batchErr }}</p>
    <p v-if="truncated" class="warn">结果已被截断（单次最多 1000 项）</p>

    <!-- 批量操作条 -->
    <div v-if="selected.size > 0 && canWrite" class="card batch">
      <strong>已选 {{ selected.size }} 项</strong>
      <span class="spacer" />
      <button class="btn-ghost btn-sm" :disabled="batchBusy" @click="runBatch('copy')">复制到…</button>
      <button class="btn-ghost btn-sm" :disabled="batchBusy" @click="runBatch('move')">移动到…</button>
      <button class="btn-danger btn-sm" :disabled="batchBusy" @click="confirmBatchDel = true">移入回收站</button>
      <button class="btn-ghost btn-sm" @click="selected = new Set()">取消选择</button>
    </div>

    <div v-if="entries.length" class="card flush">
      <table>
        <thead><tr>
          <th v-if="canWrite" class="chk"><input type="checkbox" aria-label="全选" :checked="allChecked" @change="allChecked = !allChecked" /></th>
          <th>名称</th><th>大小</th><th>权限</th><th>属主</th><th>修改时间</th><th />
        </tr></thead>
        <tbody>
          <tr v-for="e in entries" :key="e.name" :class="{ sens: e.sensitive }">
            <td v-if="canWrite" class="chk">
              <input v-if="!e.sensitive" type="checkbox" :aria-label="`选择 ${e.name}`"
                :checked="selected.has(e.name)" @change="toggle(e)" />
            </td>
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
              <button v-if="e.kind === 'file' && !e.sensitive" class="btn-ghost btn-sm" @click="download(e)">下载</button>
              <button v-if="canWrite && e.kind === 'file' && !e.sensitive" class="btn-ghost btn-sm" @click="open(e)">编辑</button>
              <!-- 重命名 / 权限（审计 F3）：行内直接入口，目录与文件均可 -->
              <button v-if="canWrite && !e.sensitive" class="btn-ghost btn-sm" @click="askRename(e)">重命名</button>
              <button v-if="canWrite && !e.sensitive" class="btn-ghost btn-sm" @click="askChmod(e)">权限</button>
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
        <button class="btn-primary" :disabled="editing.hasMore" @click="save">保存</button>
      </header>
      <p v-if="editing.hasMore" class="warn" role="alert">
        该文件大于 2MB，编辑器仅载入了前半部分内容。保存已禁用，以免覆盖并截断原文件。请用「下载」取到完整文件后在本地编辑。
      </p>
      <textarea v-model="editing.content" spellcheck="false" aria-label="文件内容" />
      <p class="tip">保存时会校验修改时间，若文件已被他人改动将拒绝覆盖</p>
    </div>

    <ConfirmDialog
      :open="!!confirmDel" danger
      :title="confirmDel?.isDir ? '删除目录（含其全部内容）' : '删除文件'"
      :detail="`即将把 ${confirmDel?.name} 移入回收站（可在回收站恢复）。`"
      :confirm-word="confirmDel?.isDir ? confirmDel.name : undefined"
      @confirm="doDelete" @cancel="confirmDel = null" />

    <ConfirmDialog
      :open="confirmBatchDel"
      title="批量移入回收站"
      :detail="`即将把已选的 ${selected.size} 项移入回收站（含目录全部内容，可在回收站恢复）。`"
      @confirm="confirmBatchDel = false; runBatch('trash')" @cancel="confirmBatchDel = false" />

    <!-- 通用输入弹窗（新建文件夹 / 重命名 / 权限 / 批量目标） -->
    <div v-if="ask" class="mask" @click.self="ask = null">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>{{ ask.title }}</h3>
        <label class="blk">{{ ask.label }}
          <input v-model="ask.value" :placeholder="ask.placeholder" @keyup.enter="askOk" />
        </label>
        <div class="modal-actions">
          <button class="btn-ghost" @click="ask = null">取消</button>
          <button class="btn-primary" @click="askOk">{{ ask.okText ?? '确定' }}</button>
        </div>
      </div>
    </div>

    <TrashPanel v-if="showTrash" @close="showTrash = false" @changed="load()" />
  </div>
</template>

<style scoped>
.cwd { font-family: var(--mono); font-size: 12.5px; color: var(--c-text-dim); background: var(--c-surface-2); padding: 1px 7px; border-radius: 6px; }
.hid { display: flex; align-items: center; gap: 5px; font-size: 12px; margin: 0; color: var(--c-text-dim); }
.ok-msg { color: var(--c-ok, #3fb950); font-size: 12.5px; margin: 6px 0; }
.fname { display: inline-flex; align-items: center; gap: 7px; }
tr.sens { background: var(--c-warn-bg); }
.batch { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 10px 14px; }
.chk { width: 34px; text-align: center; }
.editor { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.editor header { display: flex; align-items: center; gap: 8px; }
.editor textarea { min-height: 320px; font-family: var(--mono); font-size: 13px; }
/* 通用输入弹窗（与 DatabasesView 同形态） */
.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: var(--c-surface-2); border: 1px solid var(--c-border-strong); border-radius: 12px; padding: 20px 24px; width: min(400px, 92vw); }
.modal h3 { margin: 0 0 12px; font-size: 16px; }
.modal .blk { display: block; margin-bottom: 12px; font-size: 13px; }
.modal .blk input { margin-top: 6px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
</style>
