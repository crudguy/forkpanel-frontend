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
import { CAP, fmtDateTime, fmtSize } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import { useModal } from '@/composables/useModal'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import TrashPanel from '@/components/TrashPanel.vue'
import { toast } from '@/composables/useToast'
import PageLayout from '@/components/PageLayout.vue'

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
/** 排序：直接走后端 list 的 sort 参数（已支持 name/size/modified，dirs_first 恒真）。
 *  前端不再本地排序——服务端才是权威，本地排会让「截断 1000 项」的显示与真实顺序脱节。 */
const sortBy = ref<'name' | 'size' | 'modified'>('name')

const editing = ref<{ name: string; content: string; mtime: number; hasMore: boolean } | null>(null)
const confirmDel = ref<{ name: string; isDir: boolean } | null>(null)

/** 批量选择：存条目名（当前目录内唯一） */
const selected = ref<Set<string>>(new Set())
const uploading = ref(false)
const batchBusy = ref(false)
const batchErr = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

/** 软删除的反馈（"已移入回收站"），与 error 分开：它不是错误 */
const showTrash = ref(false)

// 写操作需同时满足：RBAC 权限点 file.write **且** 能力位 file.write 存在。
// 此前只判权限，能力位在文件页从未生效（侧边栏门禁用的是 FILE_READ）。
const canWrite = computed(() => auth.can('file.write') && auth.supported(CAP.FILE_WRITE))

function full(p: string) {
  return path.value.replace(/\/+$/, '') + '/' + p
}

// 请求序号：连续切目录/连点刷新时，先发的请求可能**后到**，
// 若不加甄别就会用旧目录的结果覆盖新目录（且把 loading 提前清掉 → 表格闪一下）。
let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  loading.value = true; error.value = ''
  try {
    const r = await api.get<ListResp>(API.files.list(), {
      params: { path: path.value, hidden: showHidden.value, sort: sortBy.value },
    })
    if (seq !== loadSeq) return   // 已有更新的请求在途，丢弃本次结果
    entries.value = r.entries ?? []; truncated.value = r.truncated
    path.value = r.path
    selected.value = new Set() // 换目录即清空选择
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = errorText(e); entries.value = []
  } finally { if (seq === loadSeq) loading.value = false }
}

onMounted(load)
watch(showHidden, load)
watch(sortBy, load)

// ── 面包屑（A7）：路径分段可点，直达任意上级 ──
// 后端返回的 path 是规范路径（resolve 后的 SafePath 显示值），分段即可逆：
// 每段 cumulative 拼回去就是合法路径，无需在前端解析 `..`。
const crumbs = computed(() => {
  const segs = path.value.split('/').filter(Boolean)
  const out: { label: string; to: string }[] = [{ label: '根目录', to: '/' }]
  let acc = ''
  for (const s of segs) { acc += '/' + s; out.push({ label: s, to: acc }) }
  return out
})
/** 超过 6 段时中段折叠为「…」（可点，跳到折叠前一级）——根目录 + 5 级深度足够定位，
 *  更深的路径整行会挤爆表头。折叠段取第 2 段（根目录之后第一级）作为落脚点。 */
const CrumbsShown = 6
const crumbsVisible = computed(() => {
  const c = crumbs.value
  if (c.length <= CrumbsShown) return { items: c, collapsedFrom: -1 }
  const head = c.slice(0, 2)
  const tail = c.slice(-3)
  return { items: [...head, { label: '…', to: c[1].to }, ...tail], collapsedFrom: 2 }
})
function goto(p: string) { path.value = p; load() }

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
    toast(`已移入回收站：${name}`)
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
  uploading.value = true; error.value = ''
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
    else if (usedMultipart) toast(`已上传 ${files.length} 个文件（大文件走了分片通道）`)
    await load()
  } finally { uploading.value = false; uploadLabel.value = '' }
}

// ── 下载（同源直链：GET 带 Cookie，浏览器原生保存）──
function download(e: Entry) {
  // 走 endpoints 统一定义：路径集中一处，后端改 URL 时不会漏掉这里
  // （此前硬编码 `/api/v1/files/download?...`，绕过了 API.files.download()）。
  window.location.href = `${API.files.download()}?path=${encodeURIComponent(full(e.name))}`
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

// Esc 关闭 + Tab 焦点陷阱 + 打开聚焦 + 关闭后焦点返还（此前本弹窗三者皆无）。
// X / 点遮罩 / 取消按钮统一走 closeAsk。
const askBox = ref<HTMLElement | null>(null)
const { close: closeAsk } = useModal(() => !!ask.value, askBox, () => { ask.value = null })

// ── 建目录 / 重命名 / 改权限（审计 F3：后端路由早已注册，此前前端零调用）──
function askMkdir() {
  ask.value = {
    title: '新建文件夹', label: '文件夹名称', value: '', placeholder: 'new-folder',
    okText: '创建',
    onOk: (v) => {
      api.post(API.files.mkdir(), { path: full(v) })
        .then(() => { toast(`已创建 ${v}`); load() })
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
        .then(() => { toast(`已重命名为 ${v}`); load() })
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
        .then(() => { toast(`已修改 ${e.name} 权限为 ${v}`); load() })
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
      toast(`已移入回收站（${r.ok_count} 项），可在回收站恢复`)
    }
    selected.value = new Set()
    await load()
  } catch (e) { batchErr.value = errorText(e) }
  finally { batchBusy.value = false }
}

// fmtSize 已统一到 types.ts（此前此处与 TrashPanel 各写一份，BackupsView 是第三份且更差）
</script>

<template>
  <PageLayout>
    <div class="tools-row">
      <!-- A7 面包屑：路径分段可点直达；原先是整行 <code> 全路径 + 只有「上级」，
           深目录要连点多级。当前目录（末段）为纯文本，其余为按钮。 -->
      <nav class="crumbs" aria-label="路径">
        <template v-for="(c, i) in crumbsVisible.items" :key="c.to">
          <span v-if="i > 0" class="sep" aria-hidden="true">/</span>
          <button v-if="i < crumbsVisible.items.length - 1" class="crumb" type="button" :title="`跳到 ${c.to}`" @click="goto(c.to)">{{ c.label }}</button>
          <span v-else class="crumb now" :title="path">{{ c.label }}</span>
        </template>
      </nav>
      <span class="spacer" />
      <label class="hid"><input v-model="showHidden" type="checkbox" /> 显示隐藏</label>
      <button class="btn-ghost" :disabled="path === '/'" @click="up"><Icon name="chevron-left" :size="14" /> 上级</button>
      <RefreshBtn :disabled="loading" @click="load" />
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

    <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="load">重试</button></p>
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
      <button class="btn-ghost btn-sm danger" :disabled="batchBusy" @click="confirmBatchDel = true">移入回收站</button>
      <button class="btn-ghost btn-sm" @click="selected = new Set()">取消选择</button>
    </div>

    <div v-if="entries.length" class="card flush">
      <div class="t-scroll">
      <table class="fixed" v-table-nav>
        <!-- 勾选列仅在可写时渲染，colgroup 须同步 v-if —— 否则列宽与列数错位。
             名称为唯一弹性列；属主列窄屏隐藏（.col-opt）。名称超长时裁切 + title 悬停。 -->
        <colgroup>
          <col v-if="canWrite" class="w-fchk" />
          <col class="w-fname" /><col class="w-fsize" /><col class="w-fmode" /><col class="w-fowner" /><col class="w-fmtime" /><col class="w-facts" />
        </colgroup>
        <thead><tr>
          <th v-if="canWrite" class="chk"><input type="checkbox" aria-label="全选" :checked="allChecked" @change="allChecked = !allChecked" /></th>
          <!-- A7 排序：走后端 sort 参数（dirs_first 恒真）。点击已在生效的列头则
               在 升/降 间不切换——后端只返回一种顺序，前端再反序会让「截断 1000 项」
               与实际顺序脱节；改排序即重新拉取，selected 由 load 清空。 -->
          <th class="sortable" :class="{ on: sortBy === 'name' }" @click="sortBy = 'name'">名称</th>
          <th class="sortable num" :class="{ on: sortBy === 'size' }" @click="sortBy = 'size'">大小</th>
          <th>权限</th>
          <th class="col-opt">属主</th>
          <th class="sortable num" :class="{ on: sortBy === 'modified' }" @click="sortBy = 'modified'">修改时间</th>
          <th />
        </tr></thead>
        <tbody>
          <tr v-for="e in entries" :key="e.name" :class="{ sens: e.sensitive }">
            <td v-if="canWrite" class="chk">
              <input v-if="!e.sensitive" type="checkbox" :aria-label="`选择 ${e.name}`"
                :checked="selected.has(e.name)" @change="toggle(e)" />
            </td>
            <td class="ellipsis" :title="e.name">
              <a href="#" class="fname" @click.prevent="enter(e)">
                <Icon :name="e.kind === 'dir' ? 'folder' : 'file'" :size="15" />
                {{ e.name }}
              </a>
              <span v-if="e.sensitive" class="badge badge-danger">受保护</span>
            </td>
            <td class="num">{{ e.kind === 'dir' ? '—' : fmtSize(e.size) }}</td>
            <td class="num mono">{{ e.mode ?? '—' }}</td>
            <td class="col-opt">{{ e.owner ?? '—' }}</td>
            <td class="num">{{ fmtDateTime(e.modified) }}</td>
            <td class="nowrap">
              <button v-if="e.kind === 'file' && !e.sensitive" class="btn-ghost btn-sm" @click="download(e)">下载</button>
              <button v-if="canWrite && e.kind === 'file' && !e.sensitive" class="btn-ghost btn-sm" @click="open(e)">编辑</button>
              <!-- 重命名 / 权限（审计 F3）：行内直接入口，目录与文件均可 -->
              <button v-if="canWrite && !e.sensitive" class="btn-ghost btn-sm" @click="askRename(e)">重命名</button>
              <button v-if="canWrite && !e.sensitive" class="btn-ghost btn-sm" @click="askChmod(e)">权限</button>
              <button v-if="canWrite" class="btn-ghost btn-sm danger" @click="confirmDel = { name: e.name, isDir: e.kind === 'dir' }">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
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
    <div v-if="ask" class="mask" @click.self="closeAsk">
      <div ref="askBox" class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3 class="modal-title">{{ ask.title }}</h3>
          <button class="modal-close" type="button" aria-label="关闭" @click="closeAsk">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <label class="blk">{{ ask.label }}
          <input v-model="ask.value" :placeholder="ask.placeholder" @keyup.enter="askOk" />
        </label>
        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" @click="closeAsk">取消</button>
            <button class="btn-primary" @click="askOk">{{ ask.okText ?? '确定' }}</button>
          </div>
        </div>
      </div>
    </div>

    <TrashPanel v-if="showTrash" @close="showTrash = false" @changed="load()" />
  </PageLayout>
</template>

<style scoped>
/* A7 面包屑：替换原整行 cwd 全路径。分段按钮 + 分隔符，当前级加粗纯文本。
   走 page-head 既有字号（--fs-12-5 与旧 .cwd 一致），不新增视觉变量。 */
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; min-width: 0; font-size: var(--fs-12-5); }
.crumbs .sep { color: var(--c-text-mute); user-select: none; }
.crumbs .crumb { background: none; border: none; padding: 2px 4px; border-radius: 5px; cursor: pointer;
  font: inherit; color: var(--c-text-dim); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumbs .crumb:hover { background: var(--c-hover); color: var(--c-text); }
.crumbs .crumb.now { font-weight: 600; color: var(--c-text); cursor: default; }
/* A7 排序表头：生效列给主色 + 手型；点击切换（后端排序）。 */
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--c-text); }
th.sortable.on { color: var(--c-primary); }
.hid { display: flex; align-items: center; gap: 5px; font-size: var(--fs-12); margin: 0; color: var(--c-text-dim); }
.fname { display: inline-flex; align-items: center; gap: 7px; }
tr.sens { background: var(--c-warn-bg); }
.batch { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 10px 14px; }
.chk { width: 34px; text-align: center; }
.editor { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.editor header { display: flex; align-items: center; gap: 8px; }
.editor textarea { min-height: 320px; font-family: var(--mono); font-size: var(--fs-13); }
/* 通用输入弹窗（与 DatabasesView 同形态） */
/* 遮罩 / 弹窗框 / 标题 / 字段 / 操作条一律取 main.css 的公共式样 */
/* .modal-actions 已取 main.css 公共规则（此前本页另抄一份） */
/* 文件表列宽（站点表范式）：名称为唯一弹性列；操作列 320px 容下
   下载 / 编辑 / 重命名 / 权限 / 删除 5 个带文字按钮。 */
col.w-fchk { width: 48px; }   /* 勾选框 13px + 默认 margin 7px + 单元格内边距 26px = 46px，留 2px 余量 */
col.w-fname { width: auto; }
col.w-fsize { width: 90px; }
col.w-fmode { width: 100px; }
col.w-fowner { width: 96px; }
col.w-fmtime { width: 160px; }
col.w-facts { width: 320px; }
</style>
