<script setup lang="ts">
/**
 * 新增 / 编辑终端快捷命令的弹窗。
 * 样式复用 main.css 的公共 .mask / .modal / .blk，行为复用 useModal（Esc / 焦点陷阱）。
 */
import { ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { useModal } from '@/composables/useModal'
import { validateQuickCommand, type QuickCommand, type QuickCommandInput } from '@/composables/useQuickCommands'

const props = defineProps<{
  open: boolean
  /** 传入即为编辑态，否则新增态 */
  initial?: QuickCommand | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', value: QuickCommandInput): void
}>()

const label = ref('')
const cmd = ref('')
const desc = ref('')
const error = ref('')

const box = ref<HTMLElement | null>(null)
const { close } = useModal(() => props.open, box, () => emit('close'))

watch(() => props.open, (v) => {
  if (!v) return
  label.value = props.initial?.label ?? ''
  cmd.value = props.initial?.cmd ?? ''
  desc.value = props.initial?.desc ?? ''
  error.value = ''
})

function submit() {
  const value = { label: label.value, cmd: cmd.value, desc: desc.value }
  const err = validateQuickCommand(value)
  if (err) { error.value = err; return }
  emit('save', {
    label: value.label.trim(),
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
        <label class="blk">名称
          <input v-model="label" type="text" maxlength="40" placeholder="如：查看状态"
            autocomplete="off" />
        </label>
        <label class="blk">命令
          <input v-model="cmd" type="text" maxlength="500" class="mono" placeholder="如：git status"
            autocomplete="off" spellcheck="false" />
        </label>
        <label class="blk">说明（可选）
          <input v-model="desc" type="text" maxlength="80" placeholder="一句话说明用途"
            autocomplete="off" />
        </label>
        <p v-if="error" class="err-bar" role="alert">{{ error }}</p>

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
