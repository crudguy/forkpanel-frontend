<script setup lang="ts">
/**
 * 内联备注（对象说明，022）。
 *
 * 一处组件四处用（站点 / 容器 / 数据库连接 / 本机说明）：点击文字进入编辑，
 * Esc 取消、Shift+Enter 或失焦保存；保存失败**保持编辑态**并把错误落在组件内
 * （不静默丢弃用户输入）。保存成功走全局浮层 toast。
 * 编辑框高度随内容自适应（auto-grow）：长备注不再出现内部滚动条、无需手动拖拽。
 *
 * 与「大表单保存」刻意分开：备注是轻量、高频、可独立失败的字段，不应拖累
 * 整张表单的保存链路（站点编辑表单尤其如此——那里保存一次要走 nginx 校验）。
 */
import { nextTick, ref, computed } from 'vue'
import { errorText } from '@/api/client'
import { toast } from '@/composables/useToast'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{
  /** 当前备注（空串 = 无） */
  modelValue: string
  /** 保存动作：调用方负责发 PATCH；失败须 reject（错误原文经 errorText 展示） */
  saver: (v: string) => Promise<void>
  /** 无编辑权限时只读展示（按钮降级为静态文本） */
  editable?: boolean
  /** 字符上限，与后端一致（按 Unicode 码点计） */
  max?: number
  placeholder?: string
}>(), { editable: true, max: 500, placeholder: '添加备注…' })

const editing = ref(false)
const draft = ref(props.modelValue)
const busy = ref(false)
const err = ref('')
/** Esc 取消后元素卸载触发的 blur 不得再触发保存 */
const escaped = ref(false)
const inputEl = ref<HTMLTextAreaElement | null>(null)

const display = computed(() => props.modelValue.trim() || props.placeholder)
/** 与后端 `chars().count()` 对齐：按码点计，不用 UTF-16 length（emoji 会少数） */
const count = computed(() => [...draft.value].length)

async function start() {
  if (!props.editable || busy.value) return
  draft.value = props.modelValue
  escaped.value = false
  err.value = ''
  editing.value = true
  await nextTick()
  inputEl.value?.focus()
  grow()
}

function cancel() {
  escaped.value = true
  editing.value = false
  err.value = ''
}

/** 高度自适应：先归零让 scrollHeight 反映真实内容高度，再撑开（下限 46px≈两行）。
 *  固定 rows=2 的方案在长备注下会出现内部滚动条，只能手动拖拽。 */
function grow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.max(el.scrollHeight, 46)}px`
}

async function save() {
  if (escaped.value) { escaped.value = false; return }
  const v = draft.value.trim()
  // 无实质变化直接收起，不发请求
  if (v === props.modelValue.trim()) { editing.value = false; return }
  if (count.value > props.max) { err.value = `备注最多 ${props.max} 字`; return }
  busy.value = true
  err.value = ''
  try {
    await props.saver(v)
    editing.value = false
    toast('备注已保存')
  } catch (e) {
    // 失败保编辑态：用户输入不丢，错误就地显示
    err.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="iremark">
    <button v-if="!editing" class="iremark-show" type="button"
      :class="{ empty: !modelValue.trim(), ro: !editable }"
      :disabled="!editable" @click="start">
      <Icon name="note" :size="13" />
      <span class="iremark-text">{{ display }}</span>
      <Icon v-if="editable" name="edit" :size="12" class="iremark-pen" />
    </button>
    <template v-else>
      <textarea ref="inputEl" v-model="draft" class="iremark-input" rows="2"
        :placeholder="placeholder" :disabled="busy"
        @keydown.esc.prevent="cancel" @keydown.enter.shift.exact.prevent="save" @blur="save" @input="grow" />
      <div class="iremark-meta">
        <span v-if="err" class="iremark-err">{{ err }}</span>
        <span v-else class="iremark-hint">Shift + Enter 或点击空白处保存</span>
        <span class="iremark-count" :class="{ over: count > max }">{{ count }}/{{ max }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.iremark { font-size: 13px; max-width: 100%; }
.iremark-show { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 8px;
  border: 1px dashed transparent; border-radius: 8px; background: none; color: var(--c-text);
  font: inherit; cursor: pointer; text-align: left; }
.iremark-show:hover:not(:disabled) { border-color: var(--c-border-strong); background: var(--c-surface-2); }
.iremark-show:disabled { cursor: default; }
.iremark-show.empty { color: var(--c-text-dim); }
.iremark-show.ro { padding-left: 0; }
.iremark-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iremark-pen { color: var(--c-text-dim); flex: none; opacity: 0; transition: opacity .12s ease; }
.iremark-show:hover .iremark-pen { opacity: 1; }
/* 高度由 auto-grow（script grow()）接管，故去掉 resize: vertical——手动拖出的高度
   会在下一次 input 时被重算冲掉，保留只会造成「拖了又弹回」的割裂感 */
.iremark-input { width: 100%; box-sizing: border-box; min-height: 46px; padding: 6px 9px;
  border: 1px solid var(--c-border-strong); border-radius: 8px; background: var(--c-surface);
  color: var(--c-text); font: inherit; font-size: 13px; line-height: 1.5; }
.iremark-input:focus { outline: none; border-color: var(--c-primary); }
.iremark-meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 3px;
  font-size: 11.5px; color: var(--c-text-dim); }
.iremark-err { color: var(--c-danger); }
.iremark-count.over { color: var(--c-danger); font-weight: 600; }
</style>
