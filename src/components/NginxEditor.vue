<script setup lang="ts">
/**
 * NginxEditor —— 带语法高亮 + 行号的 Nginx 配置编辑框。
 *
 * 实现：透明 <textarea> 叠在着色 <pre> 背景层之上（highlight-within-textarea 模式）。
 * - textarea 负责输入/光标/滚动；文字色透明，只显示 caret。
 * - pre 渲染同文本内容（token 用 Vue 元素渲染，非 v-html，避免 XSS 且可走 scoped 样式），
 *   配色走主题 CSS 变量（暗/亮自动切换）。
 * - 两者盒模型、字体、行高、padding、border 完全相同 → 叠层像素对齐。
 * - 行号侧栏与输入层共用 useLineGutter：不软折行 + 只渲染可见窗口。
 *   软折行会让固定行高的行号从第一处折行起整体错位，且会把侧栏撑到内容全高。
 *
 * 着色为轻量正则 tokenizer：注释 / 字符串 / 变量($x) / 指令(行首词) / 数字·IP / 标点。
 * 语义仅做近似（值关键字也会被当指令上色），对配置编辑足够，且零运行时依赖。
 */
import { computed, ref } from 'vue'
import { useLineGutter } from '@/composables/useLineGutter'

const props = defineProps<{
  modelValue: string
  rows?: number
  readonly?: boolean
  spellcheck?: boolean
  placeholder?: string
  ariaLabel?: string
  /** 填充父容器高度（全屏编辑用）：textarea 撑满且禁手动缩放 */
  fill?: boolean
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const ta = ref<HTMLTextAreaElement | null>(null)
const pre = ref<HTMLPreElement | null>(null)

interface Seg { t: string; c?: string }

// 顺序：字符串 > 注释 > 变量 > 指令 > 数字/IP > 标点。指令按「后接空白/;/{」判定。
// 注释分支必须是字符类 `[^\n]*`：写成 `\[` 会退化成「字面 [ + 行首断言 + 换行」，
// 整条分支恒不命中（着色层永远不出现 .tok-comment）。
const TOKEN_RE =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#[^\n]*)|(\$[A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*(?=[\s;{]))|(\b\d+(?:\.\d+){3}\b|\b\d+(?:\.\d+)?\b)|([{};])/g

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

const lineCount = computed(() => {
  const v = props.modelValue ?? ''
  return v === '' ? 1 : v.split('\n').length
})

const { lnWindow, sync } = useLineGutter(ta, lineCount)

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
}

function syncScroll() {
  if (ta.value && pre.value) {
    pre.value.scrollTop = ta.value.scrollTop
    pre.value.scrollLeft = ta.value.scrollLeft
  }
  sync()
}
</script>

<template>
  <div class="nginx-editor" :class="{ 'ne-fill': fill }">
    <div class="ne-gutter" aria-hidden="true">
      <div class="ne-ln-window" :style="{ transform: `translateY(${lnWindow.offsetY}px)` }">
        <div v-for="n in lnWindow.numbers" :key="n" class="ne-ln">{{ n }}</div>
      </div>
    </div>
    <div class="ne-body">
      <pre ref="pre" class="ne-pre" aria-hidden="true"><code><span v-for="(s, i) in segs" :key="i" :class="s.c">{{ s.t }}</span></code></pre>
      <textarea
        ref="ta"
        class="ne-ta mono"
        wrap="off"
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
  </div>
</template>

<style scoped>
.nginx-editor {
  position: relative;
  display: flex;
  width: 100%;
}
/* 行号侧栏：与 ne-ta 同字体/行高/padding，随滚动平移；绝对定位层不撑高容器 */
.ne-gutter {
  position: relative;
  flex: 0 0 auto;
  min-width: 3.4em;
  padding: 9px 8px 9px 10px;
  text-align: right;
  font-family: var(--mono);
  font-size: var(--fs-12);
  line-height: var(--editor-line-h);
  color: var(--c-text-mute);
  background: var(--c-surface-2);
  border: 1px solid var(--c-border-strong);
  border-right: 0;
  border-radius: var(--radius-xs) 0 0 var(--radius-xs);
  user-select: none;
  overflow: hidden;
  box-sizing: border-box;
  white-space: nowrap;
}
.ne-ln-window { position: absolute; top: 0; left: 0; right: 0; }
.ne-ln { line-height: var(--editor-line-h); }
/* 着色层 + 输入层所在的主体（相对定位上下文；pre 绝对铺满） */
.ne-body {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}
/* 背景着色层：与 textarea 完全相同的盒模型/字体，pointer-events:none 不挡输入 */
.ne-pre,
.ne-ta {
  width: 100%;
  min-height: 190px;
  margin: 0;
  padding: 9px 11px;
  border: 1px solid var(--c-border-strong);
  border-left: 0;
  border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
  font-family: var(--mono);
  font-size: var(--fs-12);
  line-height: var(--editor-line-h);
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
  /* 两端都预留滚动条槽位，避免内容超长出现纵向滚动条时 textarea 与 pre 宽度不一致 */
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
  overflow-wrap: normal;
}
.ne-ta:focus-visible {
  outline: none;
  border-color: var(--c-primary);
  box-shadow: 0 0 0 3px var(--c-primary-soft);
}
/* 填充模式（全屏编辑弹窗）：容器给高、内部撑满，禁 resize（有滚动条就够了）。
   pre 是 absolute inset:0，自动跟随；只需把 textarea 撑开。 */
.nginx-editor.ne-fill { height: 100%; display: flex; }
.nginx-editor.ne-fill .ne-body { height: 100%; min-height: 0; }
.nginx-editor.ne-fill .ne-ta { flex: 1 1 auto; min-height: 0; height: 100%; resize: none; }
/* 只读态（非 owner / 未接入底座时整框禁写）：必须与可编辑态有可见差异，
   否则用户以为能改、敲半天没反应。:has() 让着色层跟着 textarea 的 readonly 一起变
   （pre 在前、textarea 在后，兄弟选择器够不着，故从根容器反查）。 */
.nginx-editor:has(.ne-ta:read-only) .ne-pre { background: var(--c-hover); border-color: var(--c-border); }
.nginx-editor:has(.ne-ta:read-only) .ne-gutter { background: var(--c-hover); border-color: var(--c-border); }
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
