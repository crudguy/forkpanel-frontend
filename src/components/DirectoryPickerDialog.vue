<script setup lang="ts">
/**
 * 通用目录选择器：复用 /api/v1/files/list 在服务器端浏览目录树，
 * 仅列出目录，供「选目录」类场景使用（如新建站点根目录）。
 *
 * 不在这里强制 site_root 约束——那是后端 resolve_site_root 的职责，
 * 保存越界时后端会报错并在上层弹窗显示。这里只给出导航与提示。
 */
import { ref, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import Icon from '@/components/Icon.vue'

interface DirEntry { name: string; kind: string; modified: number }
interface ListResp { path: string; entries: DirEntry[]; truncated: boolean }

const props = defineProps<{ open: boolean; initialPath?: string }>()
const emit = defineEmits<{ (e: 'select', p: string): void; (e: 'cancel'): void }>()

const DEFAULT_ROOT = '/'
const curPath = ref(DEFAULT_ROOT)
const dirs = ref<DirEntry[]>([])
const loading = ref(false)
const error = ref('')
const selected = ref<string | null>(null)
const newName = ref('')
let seq = 0

const norm = (p: string) => p.replace(/\/+$/, '') || '/'
const joinDir = (base: string, name: string) => norm(base) + '/' + name

async function load() {
  const s = ++seq
  loading.value = true; error.value = ''
  try {
    const r = await api.get<ListResp>(API.files.list(), {
      params: { path: curPath.value, hidden: false },
    })
    if (s !== seq) return
    curPath.value = r.path || curPath.value
    // 只保留目录（symlink 也允许选中，但不可进入，避免后端沙箱之外的误判）
    dirs.value = (r.entries ?? [])
      .filter((e) => e.kind === 'dir' || e.kind === 'symlink')
      .sort((a, b) => a.name.localeCompare(b.name))
    selected.value = null
  } catch (e) {
    if (s !== seq) return
    error.value = errorText(e)
    dirs.value = []
  } finally { if (s === seq) loading.value = false }
}

function open_(p: string) { curPath.value = norm(p); load() }
function enter(d: DirEntry) { if (d.kind === 'dir') open_(joinDir(curPath.value, d.name)) }
function up() {
  const p = norm(curPath.value)
  const i = p.lastIndexOf('/')
  open_(i <= 0 ? '/' : p.slice(0, i))
}
function crumbs() {
  const p = norm(curPath.value)
  if (p === '/') return [{ name: '/', path: '/' }]
  const parts = p.split('/').filter(Boolean)
  const out: { name: string; path: string }[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const x of parts) { acc += '/' + x; out.push({ name: x, path: acc }) }
  return out
}
function goto(p: string) { open_(p) }
function pick(d: DirEntry) { selected.value = d.name }
function confirm() { if (selected.value) emit('select', joinDir(curPath.value, selected.value)) }

async function doMkdir() {
  const n = newName.value.trim()
  if (!n) return
  try {
    await api.post(API.files.mkdir(), { path: joinDir(curPath.value, n) })
    newName.value = ''
    await load()
    selected.value = n
  } catch (e) { error.value = errorText(e) }
}

watch(() => props.open, (v) => {
  if (v) {
    curPath.value = norm(props.initialPath || DEFAULT_ROOT)
    selected.value = null
    newName.value = ''
    load()
  }
})
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true">
      <h3>选择目录 <span class="dim tiny">（仅显示目录）</span></h3>

      <div class="crumbs">
        <button v-for="(c, i) in crumbs()" :key="c.path" class="crumb"
          :class="{ cur: i === crumbs().length - 1 }" @click="goto(c.path)">{{ c.name }}</button>
      </div>

      <div class="bar">
        <button class="btn-ghost btn-sm" :disabled="curPath === '/'" @click="up">
          <Icon name="chevron-left" :size="13" /> 上级
        </button>
        <span class="dim tiny">须选择服务器站点根目录之内的目录</span>
      </div>

      <div class="list">
        <div v-if="loading" class="skeleton" />
        <p v-else-if="error" class="err">{{ error }}</p>
        <p v-else-if="!dirs.length" class="dim empty-dir">此目录没有子目录</p>
        <button v-for="d in dirs" :key="d.name" class="row" :class="{ sel: selected === d.name }"
          @click="pick(d)" @dblclick="enter(d)">
          <Icon name="folder" :size="15" />
          <span class="nm">{{ d.name }}</span>
          <span v-if="d.kind === 'symlink'" class="dim tiny">链接</span>
          <Icon v-if="selected === d.name" class="check" name="check" :size="14" />
        </button>
      </div>

      <div class="newdir">
        <input v-model="newName" placeholder="新建子目录名" @keyup.enter="doMkdir" />
        <button class="btn-ghost btn-sm" :disabled="!newName.trim()" @click="doMkdir">
          <Icon name="plus" :size="13" /> 新建
        </button>
      </div>

      <div class="modal-actions">
        <button class="btn-ghost" @click="emit('cancel')">取消</button>
        <button class="btn-primary" :disabled="!selected" @click="confirm">选择此目录</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .55);
  display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { width: min(520px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--c-surface-2); border: 1px solid var(--c-border); border-radius: 12px; padding: 18px 20px; }
.modal h3 { margin: 0 0 12px; font-size: 15px; display: flex; align-items: center; gap: 6px; }

.crumbs { display: flex; flex-wrap: wrap; gap: 2px; font-size: 12px; padding: 6px 8px;
  background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 8px; }
.crumb { background: none; border: none; color: var(--c-primary); cursor: pointer; padding: 2px 4px;
  border-radius: 5px; font-size: 12px; }
.crumb:hover { background: rgba(255, 138, 76, .12); }
.crumb.cur { color: var(--c-text); cursor: default; font-weight: 600; }

.bar { display: flex; align-items: center; gap: 10px; margin: 10px 0; flex-wrap: wrap; }

.list { flex: 1; overflow-y: auto; min-height: 140px; max-height: 40vh;
  border: 1px solid var(--c-border); border-radius: 8px; padding: 4px; background: var(--c-surface); }
.list .row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  background: none; border: none; color: var(--c-text); padding: 8px 10px; border-radius: 6px;
  cursor: pointer; font-size: 13px; }
.list .row:hover { background: rgba(255, 138, 76, .1); }
.list .row.sel { background: rgba(255, 138, 76, .18); outline: 1px solid var(--c-primary); }
.list .row .nm { flex: 1; }
.list .row .check { color: var(--c-primary); margin-left: auto; }
.empty-dir { padding: 18px; text-align: center; }
.skeleton { height: 140px; border-radius: 8px;
  background: linear-gradient(90deg, var(--c-surface) 25%, var(--c-surface-2) 37%, var(--c-surface) 63%);
  background-size: 400% 100%; animation: sk 1.2s infinite; }
@keyframes sk { 0% { background-position: 100% 0 } 100% { background-position: -100% 0 } }

.newdir { display: flex; gap: 8px; margin: 10px 0 4px; }
.newdir input { flex: 1; }

.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
</style>
