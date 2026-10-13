<script setup lang="ts">
/**
 * 回收站面板。
 *
 * 与「文件管理」的分工：这里只做两件事——**恢复**与**彻底删除**。
 * - 恢复绝不覆盖同名文件（后端会拒绝，前端如实展示原因）；
 * - 彻底删除（单条与清空）都要过二次确认：回收站是误删的最后一道防线，
 *   不能让它被"顺手清空"。
 */
import { ref, onMounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import { fmtDateTime, fmtSize } from '@/api/types'
import { toast } from '@/composables/useToast'
import { useModal } from '@/composables/useModal'

const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>()

interface TrashEntry {
  id: string
  original_path: string
  name: string
  deleted_at: number
  kind: 'file' | 'dir'
  size_bytes: number
}

const items = ref<TrashEntry[]>([])
const loading = ref(false)
const busy = ref('')
const error = ref('')
const confirmPurge = ref<TrashEntry | null>(null)
const confirmAll = ref(false)

async function load() {
  loading.value = true; error.value = ''
  try {
    const r = await api.get<{ items: TrashEntry[] }>(API.files.trash())
    items.value = r.items
  } catch (e) { error.value = errorText(e); items.value = [] }
  finally { loading.value = false }
}

async function restore(t: TrashEntry) {
  busy.value = t.id; error.value = ''
  try {
    await api.post(API.files.trashRestore(), { id: t.id })
    toast(`已恢复到 ${t.original_path}`)
    await load(); emit('changed')
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = '' }
}

async function purge(t: TrashEntry) {
  busy.value = t.id; error.value = ''
  try {
    await api.post(API.files.trashPurge(), { id: t.id })
    toast(`已彻底删除 ${t.name}`)
    confirmPurge.value = null
    await load(); emit('changed')
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = '' }
}

async function purgeAll() {
  busy.value = '*'; error.value = ''
  try {
    const r = await api.post<{ purged: number }>(API.files.trashPurge(), {})
    toast(`已清空回收站（${r.purged} 项）`)
    confirmAll.value = false
    await load(); emit('changed')
  } catch (e) { error.value = errorText(e) }
  finally { busy.value = '' }
}

function fmtTime(ts: number) {
  return fmtDateTime(ts)
}

// Esc 关闭 + Tab 焦点陷阱 + 打开聚焦 + 关闭后焦点返还（此前本面板三者皆无）。
// X / 点遮罩 / Esc 统一走 modalClose。
// ⚠️ 本面板**没有 open prop**——由父组件 v-if 控制挂载，故传 () => true
//    （useModal 用 immediate watch 处理"挂载即打开"）。
const box = ref<HTMLElement | null>(null)
const { close: modalClose } = useModal(() => true, box, () => emit('close'))

onMounted(load)
</script>

<template>
  <!-- 二级浮层（可从一级弹窗内再展开）→ .level-2；遮罩外观统一取公共 .mask -->
  <div class="mask level-2" @click.self="modalClose">
    <div ref="box" class="trash-panel">
      <div class="modal-head">
        <Icon name="trash" :size="16" />
        <span class="modal-title">回收站</span>
        <span class="spacer" />
        <button class="btn-ghost btn-sm" :disabled="!items.length || busy === '*'" @click="confirmAll = true">清空</button>
        <!-- 关闭只留右上角 X（与全站弹窗一致）；「关闭」文字按钮与它重复 -->
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <!-- 面板级错误统一 .err-bar（此前是纯红字 .err，与弹窗错误条不一致） -->
      <p v-if="error" class="err-bar" role="alert">{{ error }}</p>
      <div v-if="loading" class="muted">加载中…</div>
      <EmptyState v-else-if="!items.length" title="回收站为空" />
      <ul v-else class="tp-list">
        <li v-for="t in items" :key="t.id">
          <div class="tp-main">
            <!-- 长文件名会被 ellipsis 截断，配 title 才能悬停看全名（同 ServiceView pkg-name） -->
            <span class="tp-name" :title="t.name">{{ t.name }}</span>
            <span class="tp-kind">{{ t.kind === 'dir' ? '目录' : fmtSize(t.size_bytes) }}</span>
            <span class="tp-path" :title="t.original_path">{{ t.original_path }}</span>
            <span class="tp-time">{{ fmtTime(t.deleted_at) }}</span>
          </div>
          <div class="tp-acts">
            <button class="btn-ghost btn-sm" :disabled="busy === t.id" @click="restore(t)">恢复</button>
            <button class="btn-ghost btn-sm danger" :disabled="busy === t.id" @click="confirmPurge = t">彻底删除</button>
          </div>
        </li>
      </ul>

      <div v-if="confirmPurge" class="tp-confirm">
        <p>彻底删除 <b>{{ confirmPurge.name }}</b>？<span class="muted">此操作不可恢复。</span></p>
        <div class="tp-acts">
          <button class="btn-ghost btn-sm" @click="confirmPurge = null">取消</button>
          <!-- 危险主操作 → 实心 .btn-danger（此前是 .btn-primary，与"删除"语义不符） -->
          <button class="btn-danger btn-sm" :disabled="busy === confirmPurge.id" @click="purge(confirmPurge)">确认删除</button>
        </div>
      </div>
      <div v-if="confirmAll" class="tp-confirm">
        <p>清空回收站？<span class="muted">共 {{ items.length }} 项，将全部彻底删除且不可恢复。</span></p>
        <div class="tp-acts">
          <button class="btn-ghost btn-sm" @click="confirmAll = false">取消</button>
          <button class="btn-danger btn-sm" :disabled="busy === '*'" @click="purgeAll">确认清空</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩（.mask.level-2）与标题行 / 关闭按钮统一取 main.css；这里只留面板自身尺寸，
   并通过 --modal-py/--modal-px 告诉公共 .modal-head 本面板的内边距是多少。 */
.trash-panel {
  --modal-py: 16px;
  --modal-px: 18px;
  width: min(760px, 100%); max-height: 82vh; overflow: auto;
  background: var(--c-surface-2); border: 1px solid var(--c-border);
  border-radius: var(--radius-lg); padding: var(--modal-py) var(--modal-px);
  display: flex; flex-direction: column;
}
.tp-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.tp-list > li {
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--c-border); border-radius: 9px; padding: 9px 11px;
}
.tp-main { flex: 1; min-width: 0; display: grid; grid-template-columns: auto auto; gap: 2px 10px; }
.tp-name { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-kind { font-size: var(--fs-12); color: var(--c-text-mute); }
.tp-path {
  grid-column: 1 / -1; font-size: var(--fs-12); color: var(--c-text-mute);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tp-time { grid-column: 1 / -1; font-size: var(--fs-12); color: var(--c-text-mute); }
.tp-acts { display: flex; gap: 6px; flex: 0 0 auto; }
.tp-acts .danger { color: var(--c-danger); }
.tp-confirm {
  margin-top: 12px; border: 1px solid #6b3a3a; background: rgba(255, 107, 107, .07);
  border-radius: 9px; padding: 11px 13px;
}
.tp-confirm p { margin: 0 0 9px; font-size: 13px; }
</style>
