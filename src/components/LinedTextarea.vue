<script setup lang="ts">
/**
 * LinedTextarea —— 带行号侧栏、按文件类型自动高亮的多行文本框。
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
 *
 * 高亮是可选叠加层：识别到语言时透明 textarea 叠在着色 pre 之上；识别不到
 * （plain）时 pre 根本不渲染、textarea 文字色也不变 —— 纯文本文件的编辑、
 * 选中、复制与保存链路与改造前等价。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useLineGutter } from '@/composables/useLineGutter'
import { detectLanguage, tokenize, type SyntaxLang } from '@/composables/syntaxHighlight'

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
  /** 关联文件名 / 路径：据此自动选高亮规则（优先级低于显式 language） */
  filename?: string
  /** 显式语言；传 'plain' 可强制关闭高亮 */
  language?: SyntaxLang
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
const pre = ref<HTMLPreElement | null>(null)

const lineCount = computed(() => {
  const v = model.value ?? ''
  return v === '' ? 1 : v.split('\n').length
})

const { lnWindow, sync } = useLineGutter(ta, lineCount)

// 内容嗅探只在「既无 language 又无 filename」时兜底，且用挂载时的内容算一次：
// 跟着每次输入重算会让语言跳变（删掉一个关键字着色就消失），界面会闪。
const sniffed = detectLanguage({ content: model.value ?? '' })
const lang = computed<SyntaxLang>(() => props.language ?? (props.filename
  ? detectLanguage({ filename: props.filename })
  : sniffed))
const highlighted = computed(() => lang.value !== 'plain')
const segs = computed(() => highlighted.value ? tokenize(model.value ?? '', lang.value) : [])
const taStyle = computed(() => props.padRight ? { paddingRight: props.padRight + 'px' } : undefined)

function onScroll() {
  sync()
  if (pre.value && ta.value) {
    pre.value.scrollTop = ta.value.scrollTop
    pre.value.scrollLeft = ta.value.scrollLeft
  }
}

// 外部赋值 / 清空会让浏览器 clamp scrollTop，重读一次以免窗口与着色层停在旧位置
watch(() => model.value, () => nextTick(onScroll))

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
    <div class="lined-body">
      <pre v-if="highlighted" ref="pre" class="lined-pre" :class="{ mono }" aria-hidden="true"><code><span v-for="(s, i) in segs" :key="i" :class="s.c">{{ s.t }}</span></code></pre>
      <textarea
        ref="ta"
        v-bind="$attrs"
        v-model="model"
        class="lined-ta"
        :class="{ mono, 'has-hl': highlighted }"
        wrap="off"
        :rows="rows"
        :readonly="readonly"
        :disabled="disabled"
        :spellcheck="spellcheck"
        :placeholder="placeholder"
        :aria-label="ariaLabel"
        :style="taStyle"
        @scroll="onScroll"
      />
    </div>
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

/* 着色层与输入层的相对定位上下文；pre 绝对铺满，不参与 flex 尺寸计算 */
.lined-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
}

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

/* 高亮态：textarea 只留 caret，文字由下层 pre 渲染。两者同盒模型/字体/padding，
   并同时预留滚动条槽位，否则出现纵向滚动条时正文与着色层会横向错位。 */
.lined-pre {
  position: absolute;
  inset: 0;
  z-index: 0;
  margin: 0;
  padding: 9px 11px;
  border: 0;
  font-size: var(--fs-12-5);
  line-height: var(--editor-line-h);
  white-space: pre;
  overflow: hidden;
  overflow-wrap: normal;
  tab-size: 2;
  color: var(--c-text);
  background: transparent;
  pointer-events: none;
  box-sizing: border-box;
  scrollbar-gutter: stable;
}
.lined-pre.mono { font-family: var(--mono); }
.lined-ta.has-hl {
  position: relative;
  z-index: 1;
  color: transparent;
  caret-color: var(--c-text);
  scrollbar-gutter: stable;
}
.lined-ta.has-hl::placeholder { color: var(--c-text-mute); }
.lined:has(.lined-ta:disabled) .lined-pre { opacity: .6; }
</style>
