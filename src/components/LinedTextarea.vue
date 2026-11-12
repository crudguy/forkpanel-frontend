<script setup lang="ts">
/**
 * LinedTextarea —— 带行号侧栏的多行文本框。
 *
 * 对齐契约（三条缺一不可，scripts/check-line-numbers.mjs 钉住）：
 * 1. 不软折行：white-space:pre + wrap="off"，长行走横向滚动。若允许软折行，
 *    一个逻辑行会占多个视觉行，而固定行高的行号侧栏必然从第一处折行起整体错位。
 * 2. 侧栏只渲染可见窗口：行号是绝对定位的一层，不撑开 flex 容器；否则几千行
 *    内容会把编辑框撑成几千行高，textarea 被 stretch 到全高 ⇒ 内部滚动失效。
 * 3. 侧栏与 textarea 共用 --editor-line-h（行高）、--fs-12-5（字号）、padding-top，
 *    行号 y = paddingTop + (行号-1)×行高 - scrollTop，与正文逐行对齐。
 *
 * 外部未声明的属性/事件经 $attrs 全部落到 textarea（inheritAttrs:false）；
 * 若沿用默认透传到根 div，focus 这类不冒泡的事件会静默收不到。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useLineGutter } from '@/composables/useLineGutter'

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ default: '' })

const props = withDefaults(defineProps<{
  rows?: number
  readonly?: boolean
  disabled?: boolean
  spellcheck?: boolean
  placeholder?: string
  ariaLabel?: string
  /** 撑满父容器（弹层内整块编辑用）：改为 flex:1 且禁手动缩放 */
  fill?: boolean
  /** 等宽字体（代码 / 配置类内容默认开） */
  mono?: boolean
  /** 最小高度（非 fill 时生效） */
  minHeight?: string
  /** 背景：bg（默认，与卡片同底）或 surface2（次级面，如 SQL 框） */
  surface?: 'bg' | 'surface2'
  /** 右侧额外留白（px），给叠在框内的按钮（如「放大」）让位 */
  padRight?: number
}>(), {
  rows: 6,
  readonly: false,
  disabled: false,
  spellcheck: false,
  placeholder: '',
  ariaLabel: '文本编辑框',
  fill: false,
  mono: true,
  minHeight: '200px',
  surface: 'bg',
  padRight: 0,
})

const ta = ref<HTMLTextAreaElement | null>(null)

const lineCount = computed(() => {
  const v = model.value ?? ''
  return v === '' ? 1 : v.split('\n').length
})

const { lnWindow, sync } = useLineGutter(ta, lineCount)
// 外部赋值 / 清空会让浏览器 clamp scrollTop，重读一次以免窗口停留在旧位置
watch(() => model.value, () => nextTick(sync))

defineExpose({ focus: () => ta.value?.focus() })
</script>

<template>
  <div
    class="lined"
    :class="{ 'is-fill': fill, [`surf-${surface}`]: true }"
    :style="fill ? undefined : { minHeight }"
  >
    <div class="lined-gutter" :class="{ mono }" aria-hidden="true">
      <div class="ln-window" :style="{ transform: `translateY(${lnWindow.offsetY}px)` }">
        <div v-for="n in lnWindow.numbers" :key="n" class="ln">{{ n }}</div>
      </div>
    </div>
    <textarea
      ref="ta"
      v-bind="$attrs"
      v-model="model"
      class="lined-ta"
      :class="{ mono }"
      wrap="off"
      :rows="rows"
      :readonly="readonly"
      :disabled="disabled"
      :spellcheck="spellcheck"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      :style="padRight ? { paddingRight: padRight + 'px' } : undefined"
      @scroll="sync"
    />
  </div>
</template>

<style scoped>
.lined {
  display: flex;
  width: 100%;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-xs);
  background: var(--c-bg);
  overflow: hidden;
  box-sizing: border-box;
  transition: border-color .14s ease, box-shadow .14s ease;
}
.lined.surf-surface2 { background: var(--c-surface-2); }
.lined:focus-within {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 3px var(--c-primary-soft);
}
.lined.is-fill { flex: 1 1 auto; min-height: 0; }

/* 侧栏不参与输入，也不撑开容器：行号层绝对定位，随滚动整体平移 */
.lined-gutter {
  position: relative;
  flex: 0 0 auto;
  min-width: 3.4em;
  padding: 9px 8px 9px 10px;
  text-align: right;
  font-size: var(--fs-12-5);
  line-height: var(--editor-line-h);
  color: var(--c-text-mute);
  background: var(--c-surface-2);
  border-right: 1px solid var(--c-border);
  user-select: none;
  overflow: hidden;
  box-sizing: border-box;
  white-space: nowrap;
}
.lined-gutter.mono { font-family: var(--mono); }
.lined.surf-surface2 .lined-gutter { background: var(--c-hover); }
.ln-window { position: absolute; top: 0; left: 0; right: 0; }
.ln { line-height: var(--editor-line-h); }

.lined-ta {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  margin: 0;
  padding: 9px 11px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--c-text);
  font-size: var(--fs-12-5);
  line-height: var(--editor-line-h);
  white-space: pre;
  overflow: auto;
  overflow-wrap: normal;
  tab-size: 2;
  resize: vertical;
  outline: none;
  box-sizing: border-box;
}
.lined-ta.mono { font-family: var(--mono); }
.lined.is-fill .lined-ta { height: 100%; min-height: 0; resize: none; }
.lined-ta:disabled { opacity: .6; cursor: not-allowed; }
</style>
