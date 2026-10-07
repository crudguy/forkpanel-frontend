<script setup lang="ts">
/**
 * 通用目录选择器（树形，全文件系统浏览）：复用 /api/v1/files/list，
 * 树根固定在服务器根目录 `/`，可逐级展开任意层级、选择任意目录。
 *
 * 打开时自动展开到 initialPath（通常是站点根目录，方便着陆），
 * 但用户可一路回退到 `/`、再进入任意目录——不受 site_root 约束。
 * 越界保存时由后端 resolve_site_root 报错，并在上层弹窗呈现。
 */
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import Icon from '@/components/Icon.vue'

interface Node {
  path: string
  name: string
  kind: 'dir' | 'symlink'
  expanded: boolean
  loaded: boolean
  loading: boolean
  error: string
  children: string[] // 子路径列表
}

const props = defineProps<{ open: boolean; initialPath?: string }>()
const emit = defineEmits<{ (e: 'select', p: string): void; (e: 'cancel'): void }>()

const norm = (p: string) => p.replace(/\/+$/, '') || '/'
const basename = (p: string) => (p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1) || '/')
const parentOf = (p: string) => {
  if (p === '/') return null
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
// 注意 base 为 `/` 时的拼接：`norm('/')` 仍是 `/`，直接 `+ '/' + name` 会得到 `//bin`
// 这种双斜杠路径。它照样能过一次网络请求，但 `visibleRows` 的 walk 是沿 children
// 里的路径字符串找节点的，`//home` 与 expandTo 展开的 `/home` 是两个不同 key，
// 于是展开链在根的子级处断掉——树只显示一层，且看不出任何报错。
const joinDir = (base: string, name: string) => (norm(base) === '/' ? '' : norm(base)) + '/' + name

const ROOT = '/'
const nodes = reactive<Record<string, Node>>({})
const selected = ref<string | null>(null)
const treeEl = ref<HTMLElement | null>(null)
const newName = ref('')
const formError = ref('')

function mkNode(path: string, name: string, kind: 'dir' | 'symlink'): Node {
  return { path, name, kind, expanded: false, loaded: false, loading: false, error: '', children: [] }
}

async function loadChildren(path: string) {
  const n = nodes[path] ?? (nodes[path] = mkNode(path, basename(path), 'dir'))
  if (n.kind !== 'dir' || n.loading) return
  n.loading = true; n.error = ''
  try {
    const r = await api.get<{ entries: { name: string; kind: string; modified: number }[] }>(
      API.files.list(), { params: { path, hidden: false } })
    const kids = (r.entries ?? [])
      .filter((e) => e.kind === 'dir' || e.kind === 'symlink')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const cp = joinDir(path, e.name)
        if (!nodes[cp]) nodes[cp] = mkNode(cp, e.name, e.kind === 'symlink' ? 'symlink' : 'dir')
        return cp
      })
    n.children = kids
    n.loaded = true
    n.expanded = true // 加载即展开，使展开链路保持可见
    ensureChildVisible(path) // 被 hidden 过滤掉的层显式接回树上，见函数注释
  } catch (e) {
    n.error = errorText(e)
  } finally { n.loading = false }
}

/// 把 `path` 接回父节点的 children（若缺失）。
///
/// 存在的理由：列表接口一律带 `hidden=false`，隐藏目录（如 `.workbuddy`）不会出现
/// 在父级结果里。可站点根目录完全可能落在隐藏目录下——此时 walk 走到父级就断了，
/// 整条**已经展开**的链在视觉上凭空消失。expandTo 既已显式加载这一层，就把它接回
/// 树上，否则"自动展开到 site_root"只是后台白干活。
function ensureChildVisible(path: string) {
  const par = parentOf(path)
  if (!par) return
  const pn = nodes[par]
  if (!pn || !pn.loaded || pn.children.includes(path)) return
  pn.children.push(path)
  pn.children.sort((a, b) => basename(a).localeCompare(basename(b)))
}

// 从根目录逐层展开到 target，使 target 在打开时即处于可见路径上
async function expandTo(target: string) {
  const t = norm(target)
  await loadChildren(ROOT)
  if (t === ROOT) return
  const segs = t.split('/').filter(Boolean)
  let acc = ''
  for (const s of segs) {
    acc += '/' + s
    await loadChildren(acc)
  }
}

function toggle(path: string) {
  const n = nodes[path]
  if (!n || n.kind !== 'dir') return
  if (n.expanded) { n.expanded = false; return }
  if (!n.loaded) loadChildren(path)
  else n.expanded = true
}

function select(path: string) { selected.value = path; formError.value = '' }

function ensureRoot() {
  for (const k in nodes) delete nodes[k] // 每次打开重新拉，避免陈旧缓存
  nodes[ROOT] = mkNode(ROOT, '/', 'dir')
  selected.value = null
  newName.value = ''
  formError.value = ''
  const ip = norm(props.initialPath || ROOT)
  expandTo(ip).then(async () => {
    const n = nodes[ip]
    // 初始路径真实存在则预选中，方便直接确认
    if (n && n.loaded && !n.error) selected.value = ip
    // 把选中行滚进视野：树默认停在最顶层，不滚动的话"展开到 site_root"
    // 等于把人送到楼下就走了——看得见路径才算着陆。
    await nextTick()
    treeEl.value?.querySelector('.row.sel')?.scrollIntoView({ block: 'center' })
  })
}

// 深度优先展平：只收集「已展开」节点的子级，得到当前可见行 + 层级深度
const visibleRows = computed(() => {
  const rows: { node: Node; depth: number }[] = []
  const walk = (path: string, depth: number) => {
    const n = nodes[path]
    if (!n) return
    rows.push({ node: n, depth })
    if (n.expanded) for (const c of n.children) walk(c, depth + 1)
  }
  walk(ROOT, 0)
  return rows
})

async function doMkdir() {
  const base = selected.value ?? ROOT
  const n = newName.value.trim()
  if (!n) return
  formError.value = ''
  try {
    await api.post(API.files.mkdir(), { path: joinDir(base, n) })
    newName.value = ''
    const bn = nodes[base]
    if (bn && bn.kind === 'dir') {
      if (!bn.loaded) await loadChildren(base)
      else { bn.expanded = true; await loadChildren(base) }
    }
    selected.value = joinDir(base, n)
  } catch (e) { formError.value = errorText(e) }
}

watch(() => props.open, (v) => { if (v) ensureRoot() })
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true">
      <h3>选择目录 <span class="dim tiny">（可浏览服务器任意目录，仅显示目录）</span></h3>

      <div class="tree" ref="treeEl">
        <div v-if="!visibleRows.length" class="dim empty">读取中…</div>
        <template v-for="row in visibleRows" :key="row.node.path">
          <div class="row" :class="{ sel: selected === row.node.path }"
            :style="{ paddingLeft: 8 + row.depth * 16 + 'px' }"
            @click="select(row.node.path)">
            <button v-if="row.node.kind === 'dir'" class="tw" :class="{ open: row.node.expanded }"
              @click.stop="toggle(row.node.path)" :aria-label="row.node.expanded ? '折叠' : '展开'">
              <Icon name="chevron" :size="13" />
            </button>
            <span v-else class="tw ph" />
            <Icon name="folder" :size="15" />
            <span class="nm">{{ row.node.name }}</span>
            <span v-if="row.node.kind === 'symlink'" class="dim tiny link">链接</span>
            <Icon v-if="selected === row.node.path" class="check" name="check" :size="14" />
          </div>
          <p v-if="row.node.error" class="err" :style="{ paddingLeft: 8 + (row.depth + 1) * 16 + 'px' }">
            {{ row.node.error }}
          </p>
        </template>
      </div>

      <p v-if="formError" class="err form-err">{{ formError }}</p>

      <div class="newdir">
        <input v-model="newName" placeholder="在所选目录内新建子目录" @keyup.enter="doMkdir" />
        <button class="btn-ghost btn-sm" :disabled="!newName.trim()" @click="doMkdir">
          <Icon name="plus" :size="13" /> 新建
        </button>
      </div>

      <div class="selpath dim tiny">
        已选：<code>{{ selected || '（未选择）' }}</code>
      </div>

      <div class="modal-actions">
        <button class="btn-ghost" @click="emit('cancel')">取消</button>
        <button class="btn-primary" :disabled="!selected" @click="emit('select', selected!)">选择此目录</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .55);
  display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { width: min(540px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--c-surface-2); border: 1px solid var(--c-border); border-radius: 12px; padding: 18px 20px; }
.modal h3 { margin: 0 0 12px; font-size: 15px; display: flex; align-items: center; gap: 6px; }

.tree { flex: 1; overflow-y: auto; min-height: 160px; max-height: 44vh;
  border: 1px solid var(--c-border); border-radius: 8px; padding: 4px; background: var(--c-surface); }
.tree .empty { padding: 18px; text-align: center; }
.tree .row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  background: none; border: none; color: var(--c-text); padding: 7px 10px 7px 8px; border-radius: 6px;
  cursor: pointer; font-size: 13px; }
.tree .row:hover { background: rgba(255, 138, 76, .1); }
.tree .row.sel { background: rgba(255, 138, 76, .18); outline: 1px solid var(--c-primary); }
.tree .row .nm { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tree .row .tw { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  flex: 0 0 18px; background: none; border: none; color: var(--c-text-dim); cursor: pointer; border-radius: 4px; }
.tree .row .tw:hover { background: rgba(255, 138, 76, .15); color: var(--c-text); }
.tree .row .tw.ph { visibility: hidden; }
.tree .row .tw.open { transform: rotate(90deg); transition: transform .12s ease; }
.tree .row .link { margin-left: 2px; }
.tree .row .check { color: var(--c-primary); margin-left: 4px; flex: 0 0 auto; }
.tree .err { color: var(--c-danger, #f85149); font-size: 12px; margin: 2px 0 4px; }

.newdir { display: flex; gap: 8px; margin: 10px 0 4px; }
.newdir input { flex: 1; }
.selpath { margin: 2px 0 6px; word-break: break-all; }
.selpath code { color: var(--c-text); background: var(--c-surface); padding: 1px 5px; border-radius: 4px; }
.form-err { margin: 0 0 8px; }

.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
</style>
