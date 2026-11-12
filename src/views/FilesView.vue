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
import { ref, onMounted, computed, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { CAP, fmtDateTime, fmtSize } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import SortTh from '@/components/SortTh.vue'
import TablePager from '@/components/TablePager.vue'
import { useTableControls, type SortDir } from '@/composables/useTableControls'
import Icon from '@/components/Icon.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import HelpBtn from '@/components/HelpBtn.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import { useModal } from '@/composables/useModal'
import { filterEntries, filterHint, matchesQuery } from '@/composables/fileFilter'
import { hasFiles, droppedFiles, createDragDepth, dropHint } from '@/composables/fileDrop'
import {
  buildCrumbs, collapseCrumbs, dirLabel, isOctalMode, joinPath, parentPath,
} from '@/composables/filePath'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import TrashPanel from '@/components/TrashPanel.vue'
import LinedTextarea from '@/components/LinedTextarea.vue'
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
  /** 升/降序：每标签独立（与 sortBy 同一份状态，切标签互不串） */
  sortDir: SortDir
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
    selected: new Set(), sortBy: 'name', sortDir: 'asc', showHidden: false, seq: 0, filter: '',
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
const sortDir = computed({ get: () => activeTab.value.sortDir, set: (v) => { activeTab.value.sortDir = v } })
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

/**
 * 排序：列由本地点选、方向可切（升/降），**不再为一次点击回源**。
 *
 * 为什么从「后端 sort 参数」改成「本地排序」：后端只返回一种顺序（dirs_first + 升序），
 * 而表头规范要求同列再点一次能切降序——为此回源也没有参数可传。本地排序只作用于
 * **已加载的这批条目**（后端上限 1000 且首屏已提示截断），所见即所排，不会出现
 * 「界面上按降序、实际顺序仍是后端升序」的错位。
 * `sort: tab.sortBy` 仍随请求发出去：它决定首次加载的初始顺序，本地排序在其之上覆盖。
 */
function setSortBy(v: 'name' | 'size' | 'modified') {
  if (sortBy.value === v) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortBy.value = v; sortDir.value = 'asc' }
}

/** 目录恒在前（文件管理器的固定约定），方向只反转**组内**顺序——
 *  把目录也一起反转会让「点一下降序，文件夹全跑到底部」，与直觉相反。 */
const sortedEntries = computed(() => {
  const k = sortBy.value
  const d = sortDir.value === 'asc' ? 1 : -1
  return visibleEntries.value.slice().sort((a, b) => {
    const dd = Number(b.kind === 'dir') - Number(a.kind === 'dir')
    if (dd) return dd
    if (k === 'name') return a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) * d
    // 目录没有大小/时间可比（后端给 0），组内比较本就只在同类间发生
    if (k === 'size') return (a.size - b.size) * d
    return ((a.modified ?? 0) - (b.modified ?? 0)) * d
  })
})

// 分页（项目规范）：目录动辄上千项，一次全铺进 DOM 对滚动与选择都是负担
const { size, page, pageCount, pageRows, total, changeSize, gotoPage } =
  useTableControls<Entry>({ rows: sortedEntries, defaultSize: 100, persistKey: 'files.entries' })
/** 换目录 / 改筛选词回第 1 页：停在第 5 页看新目录必然空一屏再被夹回 */
watch([path, filterQuery], () => { page.value = 1 })
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
const crumbs = computed(() => buildCrumbs(path.value))
/** 折叠规则与「…」的落脚点见 composables/filePath.ts（根目录 + 5 级足够定位，
 *  更深的路径整行会挤爆表头）。 */
const crumbsVisible = computed(() => collapseCrumbs(crumbs.value, 6))
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
  load(parentPath(path.value))
}
function enter(e: Entry) {
  if (e.kind !== 'dir') return open(e)
  load(joinPath(path.value, e.name))
}

async function open(e: Entry) {
  if (e.sensitive) { error.value = '该文件受保护，不可通过面板读取'; return }
  try {
    const r = await api.get<{ content: string | null; binary: boolean; size: number; has_more: boolean }>(
      API.files.read(), {
        params: { path: joinPath(path.value, e.name) },
      })
    if (r.binary) { error.value = '二进制文件不支持在线编辑'; return }
    // has_more 为真说明后端按 2MB 上限截断了：完整文件比这大，编辑框里只有前半截。
    // 若允许写回，会用截断版覆盖原文件——这是唯一会造成不可逆数据丢失的口子，必须拦死。
    editing.value = { dir: path.value, name: e.name, content: r.content ?? '', mtime: e.modified, hasMore: r.has_more }
  } catch (err) { error.value = errorText(err) }
}

async function save() {
  if (!editing.value) return
  // 只读账号：编辑器已只读化、保存钮已隐藏，这里再兜一道，防止绕过按钮直接调用
  if (!canWrite.value) { error.value = '当前账号无文件写入权限，保存已阻止'; return }
  // 截断预览严禁写回：否则覆盖原文件即丢失后半截（不可逆）
  if (editing.value.hasMore) {
    error.value = '当前文件大于 2MB，编辑器只载入了前半部分；保存会截断原文件，已禁止。请下载后用本地编辑器修改。'
    return
  }
  try {
    // ⚠ 必须是 PUT：契约 `/files/write` 只注册了 PUT（后端 `route(..., put(files::write))`）。
    // 此前写成 api.post，浏览器发 POST ⇒ 405 Method Not Allowed ⇒ 保存永远失败，
    // 而文案只显示「请求失败，请稍后重试」。后端 e2e-files.sh 用 `put /files/write`
    // 直接打接口，所以后端侧全绿、前端这条接线错了整整一版无人发现。
    // 判据：`ci/check-api-method.py` 比对前端调用方法与 openapi 契约。
    await api.put(API.files.write(), {
      path: joinPath(editing.value.dir, editing.value.name),
      content: editing.value.content,
      // 乐观锁：带上读到的 mtime，被别人改过则拒绝覆盖
      expect_mtime: editing.value.mtime,
    })
    // 成功反馈走 toast（与建目录/重命名/改权限/删除/恢复一致）。此前保存成功只是
    // 让编辑器消失，没有任何确认 —— 在「保存会改磁盘上的真实文件」这个场景下，
    // 用户无法区分「存上了」和「面板出错了但没报」。
    toast(`已保存 ${editing.value.name}`)
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

/**
 * 上传一批文件（**两个入口共用**：文件选择框 + 拖拽）。
 *
 * 刻意从 `onUploadFiles(ev)` 里剥出来：原实现直接从 `ev.target.files` 取文件，
 * 于是拖拽路径根本无法复用它——只能再写一份，而上传含分片/续传/失败汇总三段
 * 逻辑，副本一旦分叉（比如只在一边加了分片阈值判断）就会静默不一致。
 * 现在事件处理只负责「从哪拿到 File[]」，其余全部走这里。
 */
async function uploadFiles(files: File[]) {
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
    else toast(`已上传 ${files.length} 个文件`)
    await load()
    // 上传成功后如果有筛选词且新文件不匹配，列表里会「看不见刚传上去的文件」——
    // 用户第一反应是上传失败。这里补一句明确提示并给出清除筛选的出口。
    // 不自动清空查询：用户正在按条件找东西时，替他清掉搜索框更粗暴。
    if (!failed.length && filterQuery.value) {
      // 复用 fileFilter 的 matchesQuery（与列表筛选同一规则），不在这里重写 includes。
      const names = files.map(f => f.name).filter(n => !matchesQuery(n, filterQuery.value))
      if (names.length) {
        toast(names.length === 1
          ? `已上传，但 ${names[0]} 不匹配当前筛选「${filterQuery.value.trim()}」，列表中不可见`
          : `已上传，但 ${names.length} 个文件不匹配当前筛选「${filterQuery.value.trim()}」，列表中不可见`)
      }
    }
  } finally { uploading.value = false; uploadLabel.value = '' }
}

function onUploadFiles(ev: Event) {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 允许重复选同一文件
  void uploadFiles(files)
}

// ── 拖拽上传 ──
// 三条隐性规则见 composables/fileDrop.ts 的头部注释（深度计数防闪烁、必须
// preventDefault 否则浏览器直接打开文件、只认文件不认拖文字/链接）。这里只接线。
const dragDepth = createDragDepth()
/** 遮罩可见性：用 ref 而非常规 computed，因为 depth 是普通计数器（非响应式），
 *  必须显式同步；顺带避免模板依赖一个每次都读普通变量的 getter（不会重渲染）。 */
const dragActive = ref(false)
const dragTip = computed(() => dropHint(canWrite.value, 0))

/** 只在拖的是**文件**时介入；否则让浏览器按默认行为处理（拖文字/链接）。 */
function onDragEnter(e: DragEvent) {
  if (!hasFiles(e.dataTransfer)) return
  // 必须阻止默认：不拦的话 drop 时浏览器会直接导航到这个文件。
  e.preventDefault()
  dragDepth.inc()
  dragActive.value = true
}
function onDragOver(e: DragEvent) {
  if (!hasFiles(e.dataTransfer)) return
  // dragover 也必须 preventDefault，否则 drop 事件根本不会触发（规范如此）。
  // 同时把 dropEffect 设为 copy，光标才会显示「+」而不是「禁止」。
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(e: DragEvent) {
  if (!hasFiles(e.dataTransfer)) return
  // 不需要 preventDefault：leave 不参与「是否允许放置」的判定。
  dragDepth.dec()
  if (!dragDepth.active()) dragActive.value = false
}
function onDrop(e: DragEvent) {
  if (!hasFiles(e.dataTransfer)) return
  // 拦掉默认行为，否则浏览器会打开这个文件（整页被替换成文件内容）。
  e.preventDefault()
  // ⚠ 必须在**同步**阶段取文件：DataTransfer.files 只在事件派发期间有效，
  // 放进 await 之后再读，多数浏览器返回空列表（「拖上去没反应」的元凶）。
  const files = droppedFiles(e.dataTransfer)
  // drop 之后通常**没有**配对的 dragleave ⇒ 不重置遮罩会永久卡在屏上。
  dragDepth.reset(); dragActive.value = false
  // 只读用户拖进来：明确告知不可用，而不是静默吞掉（那看起来像面板没反应）。
  if (!canWrite.value) {
    error.value = '当前账号没有文件写入权限，无法上传'
    return
  }
  void uploadFiles(files)
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
    validate: (v) => (isOctalMode(v) ? null : '必须是 3-4 位八进制数，如 644'),
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
// 分页之后「看得见」= **当前页渲染出来的行**（不再是整个筛选集）：批量删除/移动只能
// 作用于眼前这一页勾中的条目，否则用户会删掉自己在别的页上从没核对过的文件——
// 这正是 check-bulk-scope 立的规矩。翻页/换目录/改筛选时清空选择（见下方 watch），
// 保证「勾选框看到的」与「批量条上的数量」永远指同一批行。
const pageSelectable = computed(() => pageRows.value.filter(e => !e.sensitive))
const allChecked = computed({
  get: () => pageSelectable.value.length > 0 &&
    pageSelectable.value.every(e => selected.value.has(e.name)),
  set: (v: boolean) => {
    if (!v) { selected.value = new Set(); return }
    // 勾「全选」= 选中本页全部可选项（**替换**而非并集）：本页之外的选择已在翻页时清空，
    // 这里再并集只会把上一页的残留又悄悄带回来。
    selected.value = new Set(pageSelectable.value.map(e => e.name))
  },
})
function toggle(e: Entry) {
  if (e.sensitive) return
  const s = new Set(selected.value)
  s.has(e.name) ? s.delete(e.name) : s.add(e.name)
  selected.value = s
}
// 批量动作的作用范围只认**当前页**：与 allChecked 同源于 pageRows（check-bulk-scope 的
// 「判定/写入/计数三者同源」）。分页/换目录/改筛选后清空选择，不留下跨页的隐形已选项。
const selectedEntries = computed(() =>
  pageRows.value.filter(e => selected.value.has(e.name)))
watch([page, size, path, filterQuery], () => { selected.value = new Set() })

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

const editing = ref<{ dir: string; name: string; content: string; mtime: number; hasMore: boolean } | null>(null)
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
  return joinPath(path.value, p)
}

// fmtSize 已统一到 types.ts（此前此处与 TrashPanel 各写一份，BackupsView 是第三份且更差）
</script>

<template>
  <PageLayout>
   <!-- 拖拽上传的作用域包住整页内容：用户不会瞄准某个精确的投放区，而是
        「把文件丢到这块页面上」。用独立 div 而不用 PageLayout 的属性透传，
        是为了让绑定点显式可见（透传会让人看不出这些事件挂在哪个元素上）。 -->
   <div class="drop-zone" @dragenter="onDragEnter" @dragover="onDragOver"
     @dragleave="onDragLeave" @drop="onDrop">
    <!-- 多页签与工具条同一行：标签栏 + 操作按钮共用一行，不单独占一行 -->
    <div class="fp-head-row">
    <div class="tabbar" role="tablist" aria-label="文件标签">
      <div v-for="t in tabs" :key="t.id" class="tab" :class="{ on: t.id === activeId }"
        role="tab" :aria-selected="t.id === activeId" tabindex="0"
        @click="switchTab(t.id)" @keydown.enter.prevent="switchTab(t.id)">
        <Icon name="folder" :size="14" />
        <span class="tab-label" :title="t.path">{{ dirLabel(t.path) }}</span>
        <button v-if="tabs.length > 1" class="tab-x" type="button" aria-label="关闭标签"
          @click.stop="closeTab(t.id)"><Icon name="close" :size="12" /></button>
      </div>
      <button class="tab add" type="button" aria-label="新建标签" @click="openTab">
        <Icon name="plus" :size="14" />
      </button>
    </div>

    <div class="tools-row">
      <!-- A7 面包屑：路径分段可点直达；原先是整行 <code> 全路径 + 只有「上级」，
           深目录要连点多级。当前目录（末段）为纯文本，其余为按钮。 -->
      <nav class="crumbs" aria-label="路径">
        <template v-for="(c, i) in crumbsVisible" :key="c.to">
          <span v-if="i > 0" class="sep" aria-hidden="true">/</span>
          <button v-if="i < crumbsVisible.length - 1" class="crumb" type="button" :title="`跳到 ${c.to}`" @click="goto(c.to)">{{ c.label }}</button>
          <span v-else class="crumb now" :title="path">{{ c.label }}</span>
        </template>
      </nav>
      <span class="spacer" />
      <!-- 动作组：搜索框 + 帮助 + 显示隐藏 + 五个按钮。合成**一个** flex 项，
           换行时整组一起下去——这样既不会出现「上传」单独掉在第二行的孤儿，
           也不需要靠视口断点猜「这一行还放不放得下」（能不能放下取决于路径长度）。 -->
      <div class="tools-actions">
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
        <!-- 工具行按钮的「文字 → 图标」降级（≤1400）。四个纯导航/辅助动作
             （上级 / 刷新 / 新建文件夹 / 回收站）收成图标，合计省 192px。
             「上传」是主操作且要显示分片进度文案（如 `big.iso（3/12 片）`），
             隐藏文字会丢掉唯一的进度反馈，故保留文字。
             ⚠ 文字被 CSS 隐藏后，可访问名称只剩 aria-label —— 每个降级按钮都必须带
               （刷新按钮由 RefreshBtn 的 collapsible 分支自带），否则读屏用户面对
               一排无名图标。判据只能在真机读 accessibility name，jsdom 不求值媒体查询。 -->
        <button class="btn-ghost" :disabled="path === '/'" title="上一级目录" aria-label="上一级目录" @click="up">
          <Icon name="chevron-left" :size="14" /><span class="tool-label">上级</span>
        </button>
        <RefreshBtn :disabled="loading" collapsible @click="() => load()" />
        <button v-if="canWrite" class="btn-ghost" :disabled="loading" title="新建文件夹" aria-label="新建文件夹" @click="askMkdir">
          <Icon name="plus" :size="15" /><span class="tool-label">新建文件夹</span>
        </button>
        <button class="btn-ghost" :disabled="!auth.supported(CAP.FILE_READ)" title="回收站：被移入的文件可在这里恢复" aria-label="回收站" @click="showTrash = true">
          <Icon name="trash" :size="15" /><span class="tool-label">回收站</span>
        </button>
        <button v-if="canWrite" class="btn-primary" :disabled="uploading" @click="pickUpload"
          :title="`超过 ${MULTIPART_THRESHOLD / 1024 / 1024} MiB 的文件自动走分片上传（中断后可续传）`">
          <Icon name="plus" :size="15" /> {{ uploadLabel || (uploading ? '上传中…' : '上传') }}
        </button>
        <input ref="fileInput" type="file" multiple hidden @change="onUploadFiles" />
      </div>
    </div>
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
          <th v-if="canWrite" class="chk"><input type="checkbox" aria-label="全选本页"
            :checked="allChecked" :title="`全选本页可操作项（共 ${pageSelectable.length} 项）`"
            :disabled="!pageSelectable.length" @change="allChecked = !allChecked" /></th>
          <!-- 排序：目录恒在前，同列再点切升降（本地排序，见 sortedEntries 上方注释） -->
          <SortTh label="名称" :active="sortBy === 'name'" :dir="sortDir" @sort="setSortBy('name')" />
          <SortTh class="num" label="大小" :active="sortBy === 'size'" :dir="sortDir" @sort="setSortBy('size')" />
          <th>权限</th>
          <th class="col-opt">属主</th>
          <SortTh class="num" label="修改时间" :active="sortBy === 'modified'" :dir="sortDir" @sort="setSortBy('modified')" />
          <th />
        </tr></thead>
        <tbody>
          <tr v-for="e in pageRows" :key="e.name" :class="{ sens: e.sensitive }">
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
            <td class="nowrap acts">
              <!-- 宽屏：纯文字按钮（.acts-ico 默认 display:none，零视觉变化）。
                   <=1200：文字换成图标（见 <style> 里的媒体查询）——5 个带文字按钮
                   要 292px，加上其余固定列共 814px，1024 宽下表格只能横向滚。 -->
              <button v-if="e.kind === 'file' && !e.sensitive" class="btn-ghost btn-sm"
                title="下载" aria-label="下载" @click="download(e)"><Icon name="download" :size="14" class="acts-ico" /><span class="btn-label">下载</span></button>
              <button v-if="canWrite && e.kind === 'file' && !e.sensitive" class="btn-ghost btn-sm"
                title="编辑" aria-label="编辑" @click="open(e)"><Icon name="note" :size="14" class="acts-ico" /><span class="btn-label">编辑</span></button>
              <!-- 重命名 / 权限（审计 F3）：行内直接入口，目录与文件均可 -->
              <button v-if="canWrite && !e.sensitive" class="btn-ghost btn-sm"
                title="重命名" aria-label="重命名" @click="askRename(e)"><Icon name="edit" :size="14" class="acts-ico" /><span class="btn-label">重命名</span></button>
              <button v-if="canWrite && !e.sensitive" class="btn-ghost btn-sm"
                title="权限" aria-label="权限" @click="askChmod(e)"><Icon name="key" :size="14" class="acts-ico" /><span class="btn-label">权限</span></button>
              <button v-if="canWrite && !e.sensitive" class="btn-ghost btn-sm danger"
                title="删除" aria-label="删除" @click="confirmDel = { name: e.name, isDir: e.kind === 'dir' }"><Icon name="trash" :size="14" class="acts-ico" /><span class="btn-label">删除</span></button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <TablePager :total="total" :page="page" :size="size" :page-count="pageCount"
        @update:page="gotoPage" @update:size="changeSize" />
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
        <button v-if="canWrite" class="btn-primary" :disabled="editing.hasMore" @click="save">保存</button>
      </header>
      <p v-if="editing.hasMore" class="warn" role="alert">
        该文件大于 2MB，编辑器仅载入了前半部分内容。保存已禁用，以免覆盖并截断原文件。请用「下载」取到完整文件后在本地编辑。
      </p>
      <LinedTextarea
        v-model="editing.content"
        :min-height="'320px'"
        :readonly="!canWrite"
        :filename="editing.dir + '/' + editing.name"
        aria-label="文件内容"
      />
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
    <Teleport to="body">
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
    </Teleport>

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

    <!-- 拖拽遮罩：position:fixed 覆盖视口。必须 Teleport 到 body——本页卡片用了
         backdrop-filter（.card），它会让该元素成为 fixed 的包含块，遮罩若不 Teleport
         就只在卡片范围内定位（全站浮层纪律见 MEMORY）。
         只读态用 .deny 换文案与配色：给出「拖不进来」的明确反馈，而不是让用户
         松手后才发现什么都没发生。 -->
    <Teleport to="body">
      <div v-if="dragActive" class="drop-mask" :class="{ deny: !canWrite }" aria-hidden="true">
        <div class="drop-box">
          <Icon :name="canWrite ? 'download' : 'lock'" :size="34" />
          <p class="drop-title">{{ dragTip }}</p>
          <p v-if="canWrite" class="drop-sub">目标目录：{{ path }}</p>
        </div>
      </div>
    </Teleport>
   </div>
  </PageLayout>
</template>

<style scoped>
/* ── 工具行 = 面包屑 + 动作组两段；放不放得下由**内容**决定，不靠视口断点 ──
   历史（前两版都没治好的原因，别再走回去）：
   ① 硬撑单行（flex-wrap:nowrap）：1440 视口下面包屑 154 + 筛选框 260 + 六个文字
      按钮 445 + 九个间距 108 = 1099 > 可用 1008，全局 `.tools-row{wrap}` 于是把最后
      一个 btn-primary（上传）单独甩到第二行，左侧留一大片空白。
   ② 再补「≤某宽度就换行」的断点：**同一断点下放不放得下其实取决于路径有多长**
      （5 段路径的面包屑 205px，比根目录多 145px），断点写在哪里都会留一段「已经溢出
      但还没换行」的窗口（实测 1151 视口深路径溢出 60px）。
   现在按内容布局：动作全部合成一个 `.tools-actions` flex 项，放不下就**整组**换行——
   既没有「上传」孤儿，也不再有断点窗口。
   ⚠ 只覆盖文件页，不动全局 `.tools-row`（其它视图没有面包屑，折行语义不同）。 */
.fp-head-row > .tools-row { gap: 12px; align-items: center; }
/* 动作组：搜索框 + 帮助 + 显示隐藏 + 五个按钮。`flex-shrink:1` 只在「已经单独占一行
   且仍放不下」时才生效（极窄视口），此时组内再按 flex-wrap 折行。 */
.fp-head-row > .tools-row > .tools-actions {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end;
  flex: 0 1 auto; min-width: 0;
}
/* 组内除筛选框外**一律不收缩**：按钮一旦被压窄，「新建文件夹」这类四字标签会折成
   两行，整行高度 38 → 61px —— 比换行更难看（实测）。唯一允许收缩的是筛选框：
   变窄仍能输入、仍能看全已输入的词，是这里唯一「缩了不丢信息」的元素。 */
.fp-head-row > .tools-row > .tools-actions > *:not(.fsearch) { flex-shrink: 0; }
/* 面包屑不参与收缩：被压窄会内部折行（3 段路径也折成两行）。 */
.fp-head-row > .tools-row > .crumbs { flex: 0 0 auto; }
/* ≥1401（文字态）：动作组**不参与盒模型**（display:contents），子项直接成为工具行的
   flex 项 —— 几何与拆组前逐像素一致，只是多了一个可收缩的筛选框（260 → 120）来吸收
   1440 视口那 90px 缺口。
   ⚠ 这里必须 contents，不能留成 flex 项：wrap 容器的 max-content 在 Chrome 里**不等于**
     子项之和（实测文字态内容 873px，容器 max-content 只报 846px），于是 1600 视口明明
     放得下，动作组也会被压窄并把自己的「上传」挤到第二行。 */
@media (min-width: 1401px) {
  .fp-head-row > .tools-row { flex-wrap: nowrap; gap: 8px; }
  .fp-head-row > .tools-row > .tools-actions { display: contents; }
}
/* 工具行文字的「只留图标」降级（≤1400）。与表格行内的 `.btn-label` 刻意分开：
   那个类由全局 main.css 在 ≤1200 隐藏，而工具行需要更早（≤1400）降级，共用一个类
   会互相牵制。实测（真机 getBoundingClientRect）：上级 78→44、刷新 79→45、
   新建文件夹 121→45、回收站 93→45，合计省 192px。
   ⚠ 文字收起后按钮的可访问名称只剩 aria-label（见模板注释），别删。 */
@media (max-width: 1400px) {
  .fp-head-row > .tools-row .tool-label { display: none; }
  /* 筛选框基准宽度同步收到 140：换行判据取的是**基准宽度**，仍按 260 算会让这一行
     更早整组换行（深路径：205 + 12 + 681 = 898 > 1200 视口的 786；收到 140 后
     205 + 12 + 561 = 778，刚好还是一行）。 */
  .fp-head-row > .tools-row > .tools-actions > .fsearch { flex: 0 1 140px; min-width: 110px; }
}
/* 多页签标签栏（2026-10-16）：与容器页 TabBar 同源但形态不同——可关闭标签条
   vs 导航分段。两者共享 --seg-* token，激活态一律浅底 + 品牌色文字 + 加粗。
   标签是目录视图，不是页面级主操作，故「+ 新标签」走中性色，不抢走 tools-row
   里唯一的 btn-primary（上传）。 */
.tabbar { display: flex; align-items: stretch; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
.tab { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; padding: 6px 10px;
  border: 1px solid var(--c-border); border-radius: var(--seg-radius); background: var(--c-glass);
  color: var(--seg-fg); cursor: pointer; font-size: var(--fs-12-5); user-select: none; }
.tab:hover { background: var(--c-hover); color: var(--c-text); }
.tab.on { background: var(--seg-on-bg); color: var(--seg-on-fg); border-color: transparent; font-weight: 600; }
.tab .tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  margin-left: 2px; border: none; background: none; color: inherit; border-radius: 4px; cursor: pointer; padding: 0; }
/* 关闭钮 hover 的浅色覆盖层跟着标签前景色走（与 TerminalView 同源）。 */
.tab-x:hover { background: color-mix(in srgb, currentColor 28%, transparent); }
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
.fsearch { position: relative; display: flex; align-items: center; flex: 0 1 260px; min-width: 120px; }
.fsearch > .icon { position: absolute; left: 9px; color: var(--c-text-dim); pointer-events: none; }
.fsearch-in { padding: 7px 26px 7px 29px; font-size: var(--fs-13); }
/* 清除按钮：有内容才出现（v-if），压住原生 type=search 的取消叉（宽度给它留出）。 */
.fsearch-x { position: absolute; right: 5px; display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0; border: none; border-radius: 50%; cursor: pointer;
  background: transparent; color: var(--c-text-dim); }
.fsearch-x:hover { background: var(--c-hover); color: var(--c-text); }
/* 过滤提示条：中性信息，不用 .warn（那是"出了状况"的黄色通道）。 */
.filter-tip { margin: -4px 0 10px; font-size: var(--fs-12); color: var(--c-text-dim); }

/* 拖拽上传作用域 + 文件页滚动模型。.drop-zone 定高成 flex column，让表格卡片
   flex:1 吃满剩余视口、.t-scroll 自身滚动 —— main.css 的 `.t-scroll>thead>th`
   本就是 `position:sticky; top:0`，但其注释写明「只对自身可滚动的容器生效」：
   此前 .t-scroll 不限高，实测 clientHeight === scrollHeight === 1285（根本不自滚），
   表头便随整页滚走。现在三层（顶栏 / 页签工具行 / 列名表头）全固定，只有数据行滚。
   ⭐高度取 `100vh - var(--page-chrome-h)`：那是「顶栏 + .content 上下内边距」的
     单一来源（main.css 的 :root），窄屏会自己变小。此前写死 120px，并靠注释
     提醒「窄屏 padding 其实是 16px 但因顺序 bug 没生效」——顺序 bug 已修，
     写死的 120 在 <=900px 会多算 24px、把页面顶出一屏纵向滚动。
   ⚠ .drop-zone 原为 `flex:1`（flex-basis:0%），在 .page-root 里 `height` 会被 flex
     分配覆盖 ⇒ 必须改 `flex:none`，否则限高完全无效（实测 dzHeight 仍 1347px）。
   ⚠ .card.flush 全局是 `overflow:auto`，这里必须改 hidden，否则与 .t-scroll 形成
     双层滚动容器；横滚交给内部 .t-scroll 独担。
   拖拽反馈仍在 Teleport 出去的全屏遮罩上（本元素不画遮罩），故表格、页签不被重排。 */
.drop-zone {
  position: relative; flex: none; min-height: 0;
  display: flex; flex-direction: column;
  height: calc(100vh - var(--page-chrome-h));
}
.drop-zone > .fp-head-row { flex: none; }
.drop-zone > .card.flush {
  flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.card.flush > .t-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
/* 页签栏 + 功能按钮完全固定：滚动时零位移，消除「先往上顶一下再吸住」的偏移感。
   ⭐关键：sticky 的 top 阈值必须等于元素**未滚动时的视口顶边位置**。原先顶边在
   58px + .content 的 padding-top(22px) = 80px，却吸附到 58px ⇒ 滚动瞬间先跟内容
   上移 22px 才停住（真机量到 head.top 80→58、控件 104.4→82.4），这就是偏移感来源。
   修法：负 margin-top 抵消 .content 的 padding-top，把顶边提到 var(--topbar-h)
   与阈值对齐；再补等量 padding-top 让控件视觉位置不变。两者相抵，
   故 head-row 总占位高度不变、下方表格位置也不变（实测 table.top 恒 184.8）。
   背景用页面底色铺满整行遮住下方滚动的表格；padding-bottom 替代 margin-bottom 让
   底色覆盖原间距，避免钉住后留一条透出表格的窄缝。z-index 20 < 顶栏 30，互不遮挡。
   ⭐ 三个偏移量全部走 main.css 的布局变量，**不再写死 58/-22**：窄屏（<=900px）
     --content-pt 会变成 16px，负 margin 自动跟着变成 -16px，不需要「分档补偿」。
     此前这里写死 -22，并留了一整段「若修好顺序 bug 须同步本行」的警告——
     那个耦合本身就是缺陷，现在由变量消掉了。 */
.fp-head-row { position: sticky; top: var(--topbar-h); z-index: 20; background: var(--c-bg);
  margin-top: calc(-1 * var(--content-pt)); margin-bottom: 0; padding: 24px 2px 14px; }
.drop-mask {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--c-bg) 72%, transparent);
  /* 遮罩本身不接收指针事件：拖拽期间指针仍属于拖拽上下文，遮罩若吃掉事件会
     导致 drop 落在遮罩而不是 .drop-zone 上，上传静默失效。 */
  pointer-events: none;
}
.drop-box {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 34px 48px; border: 2px dashed var(--c-primary); border-radius: var(--radius);
  background: var(--c-surface); color: var(--c-text);
  box-shadow: var(--shadow-lg);
}
.drop-box .icon { color: var(--c-primary); }
.drop-title { margin: 0; font-size: var(--fs-15); font-weight: 600; }
.drop-sub { margin: 0; font-size: var(--fs-12); color: var(--c-text-dim); font-family: var(--mono); max-width: 52ch; overflow-wrap: anywhere; }
/* 只读态：换成中性灰虚线 + 锁图标，避免用主色暗示"可以"。 */
.drop-mask.deny .drop-box { border-color: var(--c-border-strong); }
.drop-mask.deny .drop-box .icon { color: var(--c-text-dim); }
.hid { display: flex; align-items: center; gap: 5px; font-size: var(--fs-12); margin: 0; color: var(--c-text-dim); }
.fname { display: inline-flex; align-items: center; gap: 7px; }
tr.sens { background: var(--c-warn-bg); }
.batch { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 10px 14px; }
.chk { width: 48px; text-align: center; }
.editor { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.editor header { display: flex; align-items: center; gap: 8px; }
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

/* 操作列随宽度换形态（S-04）：
   宽屏纯文字（`.acts-ico` 默认不显示 ⇒ 与改动前逐像素一致）；
   <=1200 换成纯图标：5 个带文字按钮实测要 292px，加上其余固定列共 814px，
   而 1024 宽下可用宽度只有 734 ⇒ 表格被迫横向滚动，768 更糟（712 可用）。
   图标态 5×28 + 4×6 间距 = 164，加单元格内边距 26 = 190，取 196 留余量；
   收窄后固定列合计 690px，1024/768 都不再需要横滚。
   ⚠ 与 SitesView 的差异是刻意的：那边一直显示「图标+文字」，这里宽屏保持纯文字，
     避免为了窄屏降级而改动宽屏的列宽分配（名称列是唯一弹性列，改它会牵动整表）。
   ⚠ 可辨识性由 title + aria-label 保留，点击目标不变。 */
.acts-ico { display: none; }
@media (max-width: 1200px) {
  col.w-facts { width: 196px; }
  .acts .acts-ico { display: inline-block; vertical-align: -2px; }
  .acts .btn-label { display: none; }
  .acts .btn-sm { padding: 4px 7px; }
}
</style>
