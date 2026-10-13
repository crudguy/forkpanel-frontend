<script setup lang="ts">
/**
 * NginxEditor —— 带语法高亮的 Nginx 配置编辑框。
 *
 * 实现：透明 <textarea> 叠在着色 <pre> 背景层之上（highlight-within-textarea 模式）。
 * - textarea 负责输入/光标/滚动；文字色透明，只显示 caret。
 * - pre 渲染同文本内容（token 用 Vue 元素渲染，非 v-html，避免 XSS 且可走 scoped 样式），
 *   配色走主题 CSS 变量（暗/亮自动切换）。
 * - 两者盒模型、字体、行高、padding、border 完全相同 → 叠层像素对齐。
 *
 * 着色为轻量正则 tokenizer：注释 / 字符串 / 变量($x) / 指令(行首词) / 数字·IP / 标点。
 * 语义仅做近似（值关键字也会被当指令上色），对配置编辑足够，且零运行时依赖。
 */
import { computed, ref } from 'vue'

const props = defineProps<{
  modelValue: string
  rows?: number
  readonly?: boolean
  spellcheck?: boolean
  placeholder?: string
  ariaLabel?: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const ta = ref<HTMLTextAreaElement | null>(null)
const pre = ref<HTMLPreElement | null>(null)

interface Seg { t: string; c?: string }

// 顺序：字符串 > 注释 > 变量 > 指令 > 数字/IP > 标点。指令按「后接空白/;/{」判定。
const TOKEN_RE =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#\[^\n]*)|(\$[A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*(?=[\s;{]))|(\b\d+(?:\.\d+){3}\b|\b\d+(?:\.\d+)?\b)|([{};])/g

function tokenize(src: string): Seg[] {
  const segs: Seg[] = []
  let last = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(src))) {
    if (m.index > last) segs.push({ t: src.slice(last, m.index) })
    let cls = ''
    if (m[1]) cls = 'tok-string'
    else if (m[2]) cls = 'tok-comment'
    else if (m[3]) cls = 'tok-var'
    else if (m[4]) cls = 'tok-directive'
    else if (m[5]) cls = 'tok-num'
    else if (m[6]) cls = 'tok-punc'
    segs.push({ t: m[0], c: cls })
    last = m.index + m[0].length
  }
  if (last < src.length) segs.push({ t: src.slice(last) })
  // 末尾换行：textarea 会多渲染一个空行，pre 末尾补一个空格对齐高度。
  if (src.endsWith('\n')) segs.push({ t: ' ' })
  return segs
}

const segs = computed(() => tokenize(props.modelValue ?? ''))

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
}

function syncScroll() {
  if (ta.value && pre.value) {
    pre.value.scrollTop = ta.value.scrollTop
    pre.value.scrollLeft = ta.value.scrollLeft
  }
}
</script>

<template>
  <div class="nginx-editor">
    <pre ref="pre" class="ne-pre" aria-hidden="true"><code><span v-for="(s, i) in segs" :key="i" :class="s.c">{{ s.t }}</span></code></pre>
    <textarea
      ref="ta"
      class="ne-ta mono"
      :value="modelValue"
      :rows="rows ?? 10"
      :readonly="readonly || false"
      :spellcheck="spellcheck ?? false"
      :placeholder="placeholder"
      :aria-label="ariaLabel || 'Nginx 配置'"
      @input="onInput"
      @scroll="syncScroll"
    ></textarea>
  </div>
</template>

<style scoped>
.nginx-editor {
  position: relative;
  width: 100%;
}
/* 背景着色层：与 textarea 完全相同的盒模型/字体，pointer-events:none 不挡输入 */
.ne-pre,
.ne-ta {
  width: 100%;
  min-height: 190px;
  margin: 0;
  padding: 9px 11px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-xs);
  font-family: var(--mono);
  font-size: var(--fs-12);
  line-height: 1.55;
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  /* 两端都预留滚动条槽位，避免内容超长出现纵向滚动条时 textarea 与 pre 宽度不一致导致换行错位 */
  scrollbar-gutter: stable;
  box-sizing: border-box;
}
.ne-pre {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  background: var(--c-bg);
  color: var(--c-text);
  pointer-events: none;
}
.ne-ta {
  position: relative;
  z-index: 1;
  display: block;
  min-height: 190px;
  overflow: auto;
  resize: vertical;
  background: transparent;
  color: transparent;
  caret-color: var(--c-text);
}
.ne-ta:focus-visible {
  outline: none;
  border-color: var(--c-primary);
  box-shadow: 0 0 0 3px var(--c-primary-soft);
}
/* 只读态（非 owner / 未接入底座时整框禁写）：必须与可编辑态有可见差异，
   否则用户以为能改、敲半天没反应。:has() 让着色层跟着 textarea 的 readonly 一起变
   （pre 在前、textarea 在后，兄弟选择器够不着，故从根容器反查）。 */
.nginx-editor:has(.ne-ta:read-only) .ne-pre { background: var(--c-hover); border-color: var(--c-border); }
.nginx-editor:has(.ne-ta:read-only) .ne-ta { cursor: default; }
</style>

<!-- token 配色：用 .nginx-editor 前缀（非 scoped），以命中 v-for 渲染的 span -->
<style>
.nginx-editor .tok-comment { color: var(--c-text-mute); font-style: italic; }
.nginx-editor .tok-string { color: var(--c-ok); }
.nginx-editor .tok-var { color: var(--c-cyan); }
.nginx-editor .tok-directive { color: var(--c-primary); font-weight: 600; }
.nginx-editor .tok-num { color: var(--c-warn); }
.nginx-editor .tok-punc { color: var(--c-text-dim); }
</style>
