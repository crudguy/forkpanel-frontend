<script setup lang="ts">
/**
 * 可放大编辑的多行输入框。
 *
 * 为什么单独成组件：编排表单里的「启动命令」「compose YAML」「.env」经常是十几行，
 * 塞在弹窗的小 textarea 里改起来很痛苦。这里给每个多行框加一个「放大」按钮，
 * 弹出一块接近全屏的编辑区；同一份 v-model 双向同步，不会出现两份数据。
 *
 * 弹层刻意复用全局 `.mask` / `.modal`（level-2）并接入 useModal：
 * 二级浮层只有栈顶响应 Esc，因此按 Esc 只关放大层，不会把底下的编排弹窗一起关掉。
 */
import { nextTick, ref } from 'vue'
import { useModal } from '@/composables/useModal'
import LinedTextarea from '@/components/LinedTextarea.vue'

const model = defineModel<string>({ default: '' })

const props = withDefaults(defineProps<{
  rows?: number
  placeholder?: string
  spellcheck?: boolean
}>(), {
  rows: 3,
  placeholder: '',
  spellcheck: false,
})

const expanded = ref(false)
const fullscreen = ref(false)
const box = ref<HTMLElement | null>(null)
const bigBox = ref<{ focus: () => void } | null>(null)

const { close: modalClose } = useModal(
  () => expanded.value,
  box,
  () => {
    expanded.value = false
    fullscreen.value = false
  },
)

function open() {
  fullscreen.value = false
  expanded.value = true
  // useModal 会自动聚焦第一个可聚焦元素（本组件里就是大 textarea），
  // 这里再补一次，避免浏览器差异导致光标没落进去。
  nextTick(() => bigBox.value?.focus())
}
</script>

<template>
  <div class="expand-wrap">
    <LinedTextarea
      v-model="model"
      :rows="props.rows"
      :placeholder="props.placeholder"
      :spellcheck="props.spellcheck"
      :pad-right="34"
      aria-label="可放大编辑的多行文本"
    />
    <button
      class="expand-open"
      type="button"
      title="放大编辑"
      aria-label="放大编辑"
      @click="open"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M6 2H2v4M10 14h4v-4M2 2l4.5 4.5M14 14l-4.5-4.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="expanded" class="mask level-2" @click.self="modalClose">
        <div
          ref="box"
          class="modal expand-modal"
          :class="{ 'is-full': fullscreen }"
          role="dialog"
          aria-modal="true"
          aria-label="放大编辑"
        >
          <LinedTextarea
            ref="bigBox"
            v-model="model"
            fill
            :placeholder="props.placeholder"
            :spellcheck="props.spellcheck"
            aria-label="放大编辑的多行文本"
            @keydown.ctrl.enter.prevent="modalClose"
            @keydown.meta.enter.prevent="modalClose"
          />
          <div class="expand-foot">
            <span class="expand-tip">Esc 取消 · Ctrl/⌘ + Enter 完成</span>
            <button class="btn-ghost btn-sm" type="button" @click="fullscreen = !fullscreen">
              {{ fullscreen ? '退出全屏' : '全屏' }}
            </button>
            <button class="btn-primary btn-sm" type="button" @click="modalClose">完成</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.expand-wrap { position: relative; }

.expand-open {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--c-text-dim);
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  opacity: .8;
  transition: color .14s ease, border-color .14s ease, opacity .14s ease;
}
.expand-open:hover {
  color: var(--c-primary);
  border-color: var(--c-primary);
  opacity: 1;
}

/* 放大层：覆盖 .modal 的默认宽度 / 内边距，让编辑区吃满 */
.expand-modal {
  display: flex;
  flex-direction: column;
  width: min(1100px, 94vw);
  height: 86vh;
  max-height: 86vh;
  padding: 0;
  overflow: hidden;
}
.expand-modal.is-full {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  max-height: 100vh;
  border: 0;
  border-radius: 0;
}

.expand-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--c-surface-2);
  border-top: 1px solid var(--c-border);
}
.expand-tip {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-12);
  color: var(--c-text-dim);
}
</style>
