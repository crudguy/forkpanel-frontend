<script setup lang="ts">
/**
 * 新增 / 编辑终端快捷命令的弹窗。
 * 样式复用 main.css 的公共 .mask / .modal / .blk，行为复用 useModal（Esc / 焦点陷阱）。
 */
import { ref, watch, computed } from 'vue'
import Icon from '@/components/Icon.vue'
import { useModal } from '@/composables/useModal'
import { quickFieldError, type QuickCommandField, type QuickCommand, type QuickCommandInput } from '@/composables/useQuickCommands'

const props = defineProps<{
  open: boolean
  /** 传入即为编辑态，否则新增态 */
  initial?: QuickCommand | null
  /** 已被占用的命令文本：预置 + 同用户自定义；编辑态由父级排除自身旧命令 */
  takenCmds?: string[]
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', value: QuickCommandInput): void
}>()

const cmd = ref('')
const desc = ref('')
/** 字段级错误：只挂在出错的输入框下方，不再在弹窗底部堆一条统一错误条。
 *  判定与文案仍由 quickFieldError 唯一提供，这里只负责落到哪个字段。 */
const fieldErrors = ref<Partial<Record<QuickCommandField, string>>>({})
/** 每次提交时按最新 props 构造，避免数组引用变化时旧 Set 残留。 */
const takenSet = computed(() => new Set(props.takenCmds ?? []))

const box = ref<HTMLElement | null>(null)
const { close } = useModal(() => props.open, box, () => emit('close'))

watch(() => props.open, (v) => {
  if (!v) return
  cmd.value = props.initial?.cmd ?? ''
  desc.value = props.initial?.desc ?? ''
  fieldErrors.value = {}
})

function submit() {
  fieldErrors.value = {}
  const value = { cmd: cmd.value, desc: desc.value }
  const err = quickFieldError(value, takenSet.value)
  if (err) { fieldErrors.value = { [err.field]: err.message }; return }
  emit('save', {
    cmd: value.cmd.trim(),
    desc: value.desc.trim(),
  })
}
</script>

<template>
  <Teleport to="body">
  <div v-if="open" class="mask" @click.self="close">
    <div ref="box" class="modal" role="dialog" aria-modal="true" aria-labelledby="quick-cmd-title">
      <div class="modal-head">
        <h3 id="quick-cmd-title" class="modal-title">
          <Icon name="terminal" :size="16" /> {{ initial ? '编辑命令' : '新增命令' }}
        </h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="close">
          <Icon name="close" :size="16" />
        </button>
      </div>

      <form @submit.prevent="submit">
        <label class="blk" :class="{ 'has-err': !!fieldErrors.cmd }">命令
          <input v-model="cmd" type="text" maxlength="500" class="mono" placeholder="如：git status"
            autocomplete="off" spellcheck="false" :aria-invalid="!!fieldErrors.cmd"
            @input="delete fieldErrors.cmd" />
          <span v-if="fieldErrors.cmd" class="field-err" role="alert">{{ fieldErrors.cmd }}</span>
        </label>
        <label class="blk" :class="{ 'has-err': !!fieldErrors.desc }">说明（可选）
          <input v-model="desc" type="text" maxlength="80" placeholder="如：查看 Git 工作区状态"
            autocomplete="off" :aria-invalid="!!fieldErrors.desc"
            @input="delete fieldErrors.desc" />
          <span v-if="fieldErrors.desc" class="field-err" role="alert">{{ fieldErrors.desc }}</span>
        </label>

        <div class="modal-foot">
          <div class="modal-actions">
            <button class="btn-ghost" type="button" @click="close">取消</button>
            <button class="btn-primary" type="submit">{{ initial ? '保存' : '添加' }}</button>
          </div>
        </div>
      </form>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.mono { font-family: var(--mono); }
</style>
