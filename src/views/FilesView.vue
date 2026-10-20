<script setup lang="ts">
/**
 * 文件管理（多页签）。
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
 *
 * 多页签（2026-10-16）：每个标签是一个独立目录视图，各自持有 path / entries /
 * 选中 / 排序 / 是否显示隐藏，互不干扰、切回不重新拉取。所有顶层 ref（path /
 * entries / selected / sortBy / showHidden / loading / error / truncated）改为
 * 对「当前激活标签」的 computed 代理，既最小化改动面，又让既有逻辑（enter /
 * goto / up / load / 批量……）原样工作。列表接口本就按 path 拉取，故后端零改动。
 */
import { ref, onMounted, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fmtDateTime, fmtSize } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import HelpBtn from '@/components/HelpBtn.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import { useModal } from '@/composables/useModal'
import { filterEntries, filterHint } from '@/composables/fileFilter'
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

/** 单个文件标签：一份独立的目录视图状态。 */
interface FileTab {
  id: string
  path: string
  entries: Entry[]
  loading: boolean
  error: string
  truncated: boolean
  selected: Set<string>
  sortBy: 'name' | 'size' | 'modified'
  showHidden: boolean
  /** 该标签独立的请求序号：切标签 / 连点刷新时先到的结果不会覆盖后发的 */
  seq: number
  /** 该标签的目录内筛选词（本地筛，不走后端）。**必须每标签一份**：
   *  存在全局单 ref 里时，两个标签处在不同目录会互相串——A 标签筛着 "log"，
   *  切到 B 标签发现 B 也被筛没了（实测过）。其余状态本就每标签一份，它没理由例外。 */
  filter: string
}

function makeTab(path: string, id?: string): FileTab {
  return {
    id: id ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    path, entries: [], loading: false, error: '', truncated: false,
    selected: new Set(), sortBy: 'name', showHidden: false, seq: 0, filter: '',
  }
}

const auth = useAuthStore()
const tabs = ref<FileTab[]>([makeTab('/')])
const activeId = ref(tabs.value[0].id)
const activeTab = computed<FileTab>(() => tabs.value.find((t) => t.id === activeId.value) ?? tabs.value[0])

/** 顶层 ref 全部代理到当前激活标签，既让既有逻辑零改动，又保证每标签状态独立。 */
const path = computed({ get: () => activeTab.value.path, set: (v) => { activeTab.value.path = v } })
const entries = computed({ get: () => activeTab.value.entries, set: (v) => { activeTab.value.entries = v } })
const truncated = computed({ get: () => activeTab.value.truncated, set: (v) => { activeTab.value.truncated = v } })
const loading = computed({ get: () => activeTab.value.loading, set: (v) => { activeTab.value.loading = v } })
const error = computed({ get: () => activeTab.value.error, set: (v) => { activeTab.value.error = v } })
const selected = computed({ get: () => activeTab.value.selected, set: (v) => { activeTab.value.selected = v } })
const sortBy = computed({ get: () => activeTab.value.sortBy, set: (v) => { activeTab.value.sortBy = v } })
const showHidden = computed({ get: () => activeTab.value.showHidden, set: (v) => { activeTab.value.showHidden = v } })

/** 当前标签的过滤串（本地筛选，不走后端——见 composables/fileFilter.ts 的语义说明）。
 *  按标签存放：切标签时两边各自记住自己的查询词，不会串（见 FileTab.filter 注释）。 */
const filterQuery = computed({
  get: () => activeTab.value.filter,
  set: (v: string) => { activeTab.value.filter = v },
})
/** 过滤后的可见条目：查询为空时**就是 entries 本身**（引用相等），模板直接渲染它 */
const visibleEntries = computed(() => filterEntries(entries.value, filterQuery.value))
/** 过滤提示（空串表示无需提示，由模板 v-if 控制） */
const filterTip = computed(() =>
  filterHint(entries.value.length, visibleEntries.value.length, filterQuery.value))

/** 排序：直接走后端 list 的 sort 参数（已支持 name/size/modified，dirs_first 恒真）。
 *  前端不再本地排序——服务端才是权威，本地排会让「截断 1000 项」的显示与真实顺序脱节。 */
function setSortBy(v: 'name' | 'size' | 'modified') { activeTab.value.sortBy = v; load() }
function setShowHidden(v: boolean) { activeTab.value.showHidden = v; load() }

// 请求序号按标签隔离：连续切目录/连点刷新时，先发的请求可能**后到**，
// 若不加甄别就会用旧目录的结果覆盖新目录（且把 loading 提前清掉 → 表格闪一下）。
/**
 * 拉取目录列表。
 * @param toPath 目标目录；省略 = 重新拉取当前目录（刷新/上传后/删除后）。
 *               传了新路径时**由本函数负责赋值**——调用方一律不要自己改 path.value，
 *               否则 pathChanged 会退化成「新 vs 新」，恒为 false（见 goto 处的注释）。
 */
async function load(toPath?: string) {
  const tab = activeTab.value
  // 目标路径在**发起请求前**就定下（不能用 tab.path：它可能已被本函数之外改过）
  const target = toPath ?? tab.path
  const seq = ++tab.seq
  tab.loading = true; tab.error = ''
  try {
    const r = await api.get<ListResp>(API.files.list(), {
      params: { path: target, hidden: tab.showHidden, sort: tab.sortBy },
    })
    if (seq !== tab.seq) return   // 已有更新的请求在途，丢弃本次结果
    // 后端返回的是规范路径（可能被归一化），故以 r.path 为准；
    // 比较用的「旧路径」是本次请求发起时的 tab.path，此刻尚未被覆盖。
    const pathChanged = tab.path !== r.path
    tab.entries = r.entries ?? []; tab.truncated = r.truncated
    tab.path = r.path
    // 目录变了才清空选择与查询；同一目录刷新（上传后/删除后/手动刷新）**都保留**——
    // 勾选留着省得重勾，查询留着因为用户正在找的那个东西不该被重置。
    if (pathChanged) {
      tab.selected = new Set()
      // 过滤只对「当前目录的这一次列表」有意义：换目录后旧查询会让人以为文件不见了。
      // 按 tab 清（不是只清激活标签的）：换目录的可能是后台标签（如回收站恢复回调）。
      tab.filter = ''
    }
  } catch (e) {
    if (seq !== tab.seq) return
    tab.error = errorText(e); tab.entries = []
    // 失败也要把路径落到目标上：否则面包屑还停在旧目录、错误却说的是新目录，
    // 用户点「重试」会静默去重试旧目录（看起来"重试没用"）。
    tab.path = target
  } finally { if (seq === tab.seq) tab.loading = false }
}

onMounted(load)

// ── 标签栏（多页签）──
function tabLabel(p: string): string {
  if (p === '/') return '根目录'
  const seg = p.replace(/\/+$/, '').split('/').pop()
  return seg || '根目录'
}
/** 新建标签：以当前激活标签所在目录为起点开一个分支（沿用用户选定的交互模型）。 */
function openTab() {
  const t = makeTab(activeTab.value.path)
  tabs.value.push(t)
  activeId.value = t.id
  // 必须走无参 load()（内部取 activeTab.value，即响应式代理）——若传原始对象 t，
  // 对其 entries/loading 的赋值不会触发响应式，新标签会停在「空目录」空态直到手动刷新。
  // 新标签的 path 与当前标签相同，故不会触发 pathChanged，也就不会清空查询。
  load()
}
function switchTab(id: string) {
  if (id === activeId.value) return
  activeId.value = id
  // 切标签时收起可能指向旧目录的浮层，避免保存/删除落到错目录
  editing.value = null; ask.value = null; confirmDel.value = null; confirmBatchDel.value = false
}
function closeTab(id: string) {
  if (tabs.value.length <= 1) return // 至少保留一个标签
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx < 0) return
  const wasActive = id === activeId.value
  tabs.value.splice(idx, 1)
  if (wasActive) {
    activeId.value = tabs.value[Math.max(0, idx - 1)].id
    editing.value = null; ask.value = null; confirmDel.value = null; confirmBatchDel.value = false
  }
}

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
// ⚠⚠ 导航（goto/up/enter）**不得自己改 tab.path**：一律把目标路径交给 load()。
//
// 曾经的写法是「先 path.value = 新目录，再 load()」，于是 load() 里
// `pathChanged = tab.path !== r.path` 比较的是**新目录 vs 新目录**，恒为 false —
// 结果是「换目录清空勾选 / 清空查询」这两条**永远不执行**（真机实测：进入 /dev
// 后查询词仍是 "dev"，点面包屑回根目录后仍是 "zz"）。这是一个静默故障：
// 编译、类型、build、UI 守卫全绿，只有真机点一遍才看得见。
//
// 现在由 load(toPath?) 独占「改路径」这一动作：它在**赋值之前**拿旧路径与目标
// 比较，因此 pathChanged 的语义是真的「目录换了没」。所有入口都走同一条路，
// 不存在第二个地方偷偷改 path 让判据失真。
function goto(p: string) { load(p) }

function up() {
  const p = path.value.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  load(i <= 0 ? '/' : p.slice(0, i))
}
function enter(e: Entry) {
  if (e.kind !== 'dir') return open(e)
  load((path.value.replace(/\/+$/, '') + '/' + e.name) || '/')
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
  } catch (e) {
    // 失败也必须关掉确认框：否则弹窗原地不动、用户以为「点了没反应」，
    // 而真正的失败原因显示在弹窗背后的页面级 .err 上（被遮罩挡住看不见）。
    // 实测过：失败时 dialogStillOpen=true 且错误文案不可见。
    confirmDel.value = null
    error.value = errorText(e)
  }
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
// 全选的语义必须**基于可见项**（visibleEntries），不能基于 entries：过滤生效时若
// 按 entries 全选，会选中一批用户当前看不见的条目——后面的「移动到…/移入回收站」
// 于是作用在这些隐形条目上，用户无法从界面上核对哪些会被动到。这是最危险的一类
// 不一致（列表看不见 ≠ 不会被操作），所以判定与写入都用同一份 visibleEntries。
// 副作用是「过滤时全选只选匹配项」，这正是用户看着屏幕时的预期。
const visibleSelectable = computed(() => visibleEntries.value.filter(e => !e.sensitive))
const allChecked = computed({
  get: () => visibleSelectable.value.length > 0 &&
    visibleSelectable.value.every(e => selected.value.has(e.name)),
  set: (v: boolean) => {
    if (!v) { selected.value = new Set(); return }
    // 勾「全选」是**并集**而非替换：过滤时反复变换查询词逐批全选，是常见操作；
    // 若每次替换，前一批已选的会被悄悄取消。取消全选仍是清空（无法只取消不可见的）。
    selected.value = new Set([...selected.value, ...visibleSelectable.value.map(e => e.name)])
  },
})
function toggle(e: Entry) {
  if (e.sensitive) return
  const s = new Set(selected.value)
  s.has(e.name) ? s.delete(e.name) : s.add(e.name)
  selected.value = s
}
// 批量动作的作用范围**只认可见项**：即便 selected 里残留着被过滤掉的旧名字
// （先全选再改查询词就会这样），也不会把它们带进「移动到…/移入回收站」。
// 这与上面对 allChecked 的处理是同一条纪律：看得见的才动得着。
const selectedEntries = computed(() =>
  visibleEntries.value.filter(e => selected.value.has(e.name)))

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

const editing = ref<{ name: string; content: string; mtime: number; hasMore: boolean } | null>(null)
const confirmDel = ref<{ name: string; isDir: boolean } | null>(null)

/** 批量选择：存条目名（当前目录内唯一） */
const selectedSet = selected // 别名，便于阅读（selected 已是代理）
const uploading = ref(false)
const batchBusy = ref(false)
const batchErr = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

/** 软删除的反馈（"已移入回收站"），与 error 分开：它不是错误 */
const showTrash = ref(false)
const helpOpen = ref(false)

// 写操作需同时满足：RBAC 权限点 file.write **且** 能力位 file.write 存在。
// 此前只判权限，能力位在文件页从未生效（侧边栏门禁用的是 FILE_READ）。
const canWrite = computed(() => auth.can('file.write') && auth.supported(CAP.FILE_WRITE))

function full(p: string) {
  return path.value.replace(/\/+$/, '') + '/' + p
}

// fmtSize 已统一到 types.ts（此前此处与 TrashPanel 各写一份，BackupsView 是第三份且更差）
</script>

<template>
  <PageLayout>
    <!-- 多页签：每个标签是一个独立目录视图；「+ 新标签」以当前目录为起点开分支 -->
    <div class="tabbar" role="tablist" aria-label="文件标签">
      <div v-for="t in tabs" :key="t.id" class="tab" :class="{ on: t.id === activeId }"
        role="tab" :aria-selected="t.id === activeId" tabindex="0"
        @click="switchTab(t.id)" @keydown.enter.prevent="switchTab(t.id)">
        <Icon name="folder" :size="14" />
        <span class="tab-label" :title="t.path">{{ tabLabel(t.path) }}</span>
        <button v-if="tabs.length > 1" class="tab-x" type="button" aria-label="关闭标签"
          @click.stop="closeTab(t.id)"><Icon name="close" :size="12" /></button>
      </div>
      <button class="tab add" type="button" aria-label="新建标签" @click="openTab">
        <Icon name="plus" :size="14" /> 新标签
      </button>
    </div>

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
      <!-- 目录内过滤：只筛**当前目录已拉回的条目**（纯前端，不发请求）。
           不提供「递归搜索」是刻意的——那需要后端新接口与遍历预算控制，
           半成品的全文搜索会让用户以为「找不到 = 文件不存在」。
           type=search 自带 Esc 清空提示；清除按钮另给，兼容不显示原生叉的浏览器。 -->
      <div class="fsearch">
        <Icon name="search" :size="14" />
        <input v-model="filterQuery" class="fsearch-in" type="search"
          :placeholder="entries.length ? `在 ${entries.length} 项中筛选…` : '筛选当前目录…'"
          aria-label="筛选当前目录的文件名" autocomplete="off" spellcheck="false" />
        <button v-if="filterQuery" class="fsearch-x" type="button" aria-label="清除筛选"
          title="清除筛选" @click="filterQuery = ''"><Icon name="close" :size="12" /></button>
      </div>
      <HelpBtn title="文件管理说明" aria-label="文件管理说明" :expanded="helpOpen" @click="helpOpen = true" />
      <label class="hid"><input type="checkbox" :checked="showHidden" @change="setShowHidden(($event.target as HTMLInputElement).checked)" /> 显示隐藏</label>
      <button class="btn-ghost" :disabled="path === '/'" @click="up"><Icon name="chevron-left" :size="14" /> 上级</button>
      <RefreshBtn :disabled="loading" @click="() => load()" />
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

    <p v-if="error" class="err" role="alert">{{ error }}<button class="btn-ghost btn-sm err-retry" type="button" @click="() => load()">重试</button></p>
    <!-- batchErr 是批量操作失败，与 error 同类 → 同用红色错误通道（审计 U14）；
         truncated / hasMore 是提示性警告，保留黄色 -->
    <p v-if="batchErr" class="err" role="alert">{{ batchErr }}</p>
    <p v-if="truncated" class="warn">结果已被截断（单次最多 1000 项）</p>
    <!-- 过滤提示：替代「顶部截断提示」的位置语义——它描述的是**当前列表被缩窄了多少**，
         必须紧贴表格上方，否则用户看着过滤后的空表不知道自己在看什么。
         走 .warn 之外的独立中性样式：过滤生效不是异常。 -->
    <p v-if="filterTip" class="filter-tip">{{ filterTip }}</p>

    <!-- 批量操作条 -->
    <!-- 批量操作条。数量显示用 selectedEntries.length（= 可见的已选项）而不是
         selectedSet.size：后者含被过滤隐藏的旧选择，会让「已选 N 项」与实际会被
         操作的条目数不符。取消选择仍是清空全部（含隐藏的）——见下方 @click。 -->
    <div v-if="selectedEntries.length > 0 && canWrite" class="card batch">
      <strong>已选 {{ selectedEntries.length }} 项</strong>
      <span class="spacer" />
      <button class="btn-ghost btn-sm" :disabled="batchBusy" @click="runBatch('copy')">复制到…</button>
      <button class="btn-ghost btn-sm" :disabled="batchBusy" @click="runBatch('move')">移动到…</button>
      <button class="btn-ghost btn-sm danger" :disabled="batchBusy" @click="confirmBatchDel = true">移入回收站</button>
      <button class="btn-ghost btn-sm" @click="selectedSet = new Set()">取消选择</button>
    </div>

    <!-- 表格存在条件用 visibleEntries 而非 entries：过滤到零命中时若仍按 entries
         渲染，会留下一张只有表头的空表，比直接给空态更让人困惑。 -->
    <div v-if="visibleEntries.length" class="card flush">
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
          <th class="sortable" :class="{ on: sortBy === 'name' }" @click="setSortBy('name')">名称</th>
          <th class="sortable num" :class="{ on: sortBy === 'size' }" @click="setSortBy('size')">大小</th>
          <th>权限</th>
          <th class="col-opt">属主</th>
          <th class="sortable num" :class="{ on: sortBy === 'modified' }" @click="setSortBy('modified')">修改时间</th>
          <th />
        </tr></thead>
        <tbody>
          <tr v-for="e in visibleEntries" :key="e.name" :class="{ sens: e.sensitive }">
            <td v-if="canWrite" class="chk">
              <input v-if="!e.sensitive" type="checkbox" :aria-label="`选择 ${e.name}`"
                :checked="selectedSet.has(e.name)" @change="toggle(e)" />
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
    <!-- 三种「没东西可看」必须分开说，否则用户无法判断下一步该做什么：
         · 加载中 → 什么都不渲染（避免空态闪一下）
         · 有文件但被过滤器挡光 → 给出清除筛选的动作（不是「空目录」！）
         · 真的空目录 → 可写时给上传/新建的入口，不可写就是纯空
         ⚠ EmptyState 的按钮插槽是**具名** `#cta`：写成默认插槽不会渲染（静默）。
         ⚠ reason 会渲染成「原因：xxx」（用于能力不支持），过滤不到并非故障 → 用 hint。 -->
    <EmptyState v-else-if="!loading && entries.length"
      :title="`没有匹配「${filterQuery.trim()}」的条目`"
      hint="筛选只作用于当前目录已列出的条目，清除筛选即可看到全部。">
      <template #cta>
        <button class="btn-ghost" type="button" @click="filterQuery = ''">清除筛选</button>
      </template>
    </EmptyState>
    <EmptyState v-else-if="!loading && canWrite" title="空目录"
      hint="可以上传文件或新建文件夹开始使用。">
      <template #cta>
        <button class="btn-ghost" type="button" @click="pickUpload">上传文件</button>
        <button class="btn-ghost" type="button" @click="askMkdir">新建文件夹</button>
      </template>
    </EmptyState>
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
      :detail="`即将把已选的 ${selectedEntries.length} 项移入回收站（含目录全部内容，可在回收站恢复）。`"
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

    <HelpDrawer :open="helpOpen" title="文件管理说明" @close="helpOpen = false">
      <p>文件管理用于在面板允许的根目录内浏览、上传、编辑与整理文件。所有路径都<strong>由后端返回并校验</strong>——前端不拼接 <code>..</code>，真正的越权防护在后端沙箱。</p>

      <h4>多页签</h4>
      <ul>
        <li>顶部标签栏可同时打开多个目录：点「<strong>新标签</strong>」以当前所在目录为起点开一个分支标签，点文件夹在当前标签内进入。</li>
        <li>每个标签独立保留列表、选中项、排序与「显示隐藏」；切回标签不重新拉取（除非手动刷新）。点标签上的「×」关闭（至少保留一个）。</li>
      </ul>

      <h4>导航与排序</h4>
      <ul>
        <li>顶部面包屑的每一段都可点击直达；层级过深时中段会折叠成一个可点的「…」。</li>
        <li>点表头「名称 / 大小 / 修改时间」切换排序；<strong>目录永远排在文件前面</strong>，排序只在目录群内生效，当前生效列显示为主色。</li>
      </ul>

      <h4>上传与下载</h4>
      <ul>
        <li>超过 8 MB 自动走分片上传、中断后可续传；小文件单请求直传。</li>
        <li>下载走同源直链，由浏览器原生保存。</li>
      </ul>

      <h4>批量与回收站</h4>
      <ul>
        <li>勾选多项后可<strong>复制到 / 移动到 / 移入回收站</strong>，每项结果逐条回报成功或失败。</li>
        <li>「回收站」列出被软删除的文件，可在这里恢复；面板不提供「一键 <code>rm -rf</code>」。</li>
        <li>删除目录必须输入确认词，防止误删整棵目录树。</li>
      </ul>

      <h4>权限与敏感文件</h4>
      <ul>
        <li>点「权限」可改文件 mode；写操作需要 <code>file.write</code> 权限且宿主具备文件写能力位。</li>
        <li>标红「受保护」的敏感文件（如 <code>/etc/shadow</code>）前端禁止打开与删除，后端同样会拒绝。</li>
      </ul>

      <p>单次列目录最多返回 1000 项，超过会提示「结果已被截断」，可进入子目录查看其余内容。</p>
    </HelpDrawer>
  </PageLayout>
</template>

<style scoped>
/* 多页签标签栏（2026-10-16）：与容器页「容器/镜像」TabBar 风格错位但同源——同用
   玻璃底 + 激活主色。标签是目录视图，不是页面级主操作，故「+ 新标签」走中性色，
   不抢走 tools-row 里唯一的 btn-primary（上传）。 */
.tabbar { display: flex; align-items: stretch; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
.tab { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; padding: 6px 10px;
  border: 1px solid var(--c-border); border-radius: var(--radius-sm, 7px); background: var(--c-glass);
  color: var(--c-text-dim); cursor: pointer; font-size: var(--fs-12-5); user-select: none; }
.tab:hover { background: var(--c-hover); color: var(--c-text); }
.tab.on { background: var(--c-primary); color: #fff; border-color: var(--c-primary); }
.tab .tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  margin-left: 2px; border: none; background: none; color: inherit; border-radius: 4px; cursor: pointer; padding: 0; }
.tab-x:hover { background: rgba(127, 127, 127, 0.28); }
.tab.on .tab-x:hover { background: rgba(255, 255, 255, 0.28); }
.tab.add { color: var(--c-text-dim); }
.tab.add:hover { color: var(--c-primary); }
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
/* 目录内筛选框。刻意**不**复制 ContainersView 的 `.filter` 全量声明（那会变成
   第三份边框/高度/背景的副本）——这里只做布局与尺寸，外观全部继承 main.css 的
   `input` 基础规则（含 :focus-visible 的主色环与 placeholder 色）。
   搜索图标绝对定位在框内左侧，输入框给 padding-left 让位。 */
.fsearch { position: relative; display: flex; align-items: center; flex: 0 1 260px; min-width: 140px; }
.fsearch > .icon { position: absolute; left: 9px; color: var(--c-text-dim); pointer-events: none; }
.fsearch-in { padding: 7px 26px 7px 29px; font-size: var(--fs-13); }
/* 清除按钮：有内容才出现（v-if），压住原生 type=search 的取消叉（宽度给它留出）。 */
.fsearch-x { position: absolute; right: 5px; display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0; border: none; border-radius: 50%; cursor: pointer;
  background: transparent; color: var(--c-text-dim); }
.fsearch-x:hover { background: var(--c-hover); color: var(--c-text); }
/* 过滤提示条：中性信息，不用 .warn（那是"出了状况"的黄色通道）。 */
.filter-tip { margin: -4px 0 10px; font-size: var(--fs-12); color: var(--c-text-dim); }
.hid { display: flex; align-items: center; gap: 5px; font-size: var(--fs-12); margin: 0; color: var(--c-text-dim); }
.fname { display: inline-flex; align-items: center; gap: 7px; }
tr.sens { background: var(--c-warn-bg); }
.batch { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 10px 14px; }
.chk { width: 48px; text-align: center; }
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
