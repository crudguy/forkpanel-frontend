<script setup lang="ts">
/**
 * 帮助抽屉（评估报告 A6）：把页面顶部「长篇说明文案」收进右侧滑出抽屉，
 * 页面上只留一个 `?` 图标触发（挂在常驻的提示行或卡片顶栏，随页面而定）。首次进入可自动展开一次（由调用方用 localStorage 控制），
 * 之后默认收起——解决"界面像文档"的问题，新用户看得到、老用户不被反复打扰。
 *
 * 与 RiskBanner 分工：本组件承载**完整的背景/约束说明**（长文），RiskBanner 承载
 * **常驻的高危提示**（短文）。前者按需展开，后者始终可见。
 *
 * ⚠ Esc 关闭必须挂 document 的捕获阶段，不能只写 `@keydown.esc.window`：
 * `KeyboardEvent` 派发给的是**当前焦点元素**，抽屉打开时焦点往往还停在触发器或已落空到
 * `<body>`，事件从 body 冒泡到 document 后就结束，`window` 上的监听点（`@keydown.esc.window`
 * 挂的是 window）收不到——表现为「焦点在抽屉里 Esc 能关、焦点在外面 Esc 没反应」。
 * document 捕获阶段在事件下达给任何焦点元素之前就执行，焦点在哪都能收到。
 * （同款处置见 TerminalView 的 onQuickDocKeydown。）
 */
import { nextTick, onUnmounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'

const props = defineProps<{ open: boolean; title?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const hd = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** 抽屉之外还有 modal 时让位：一次 Esc 只关最里面那一层。 */
function hasInnerDialog() {
  for (const el of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
    if (el !== hd.value) return true
  }
  return false
}

/** 与 useModal 同口径的 Tab 陷阱：焦点只在抽屉内循环，Shift+Tab 反向。 */
function trapTab(e: KeyboardEvent) {
  const root = hd.value
  if (!root) return
  const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(x => !x.hasAttribute('disabled'))
  if (!list.length) return
  const first = list[0]
  const last = list[list.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && (document.activeElement === last || document.activeElement === document.body)) {
    e.preventDefault(); first.focus()
  }
}

function onDocKeydown(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Tab') {
    if (!hasInnerDialog()) trapTab(e)
    return
  }
  if (e.key !== 'Escape') return
  if (hasInnerDialog()) return
  emit('close')
}

// 只在打开期间挂监听，关闭即摘：抽屉收着还占一个全局 keydown 是无谓开销，
// 且多个页面复用时不会互相抢。焦点管理沿用 useModal 口径：打开搬进去、关闭还回去。
watch(() => props.open, (open) => {
  if (open) {
    opener = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', onDocKeydown, true)
    nextTick(() => { hd.value?.querySelector<HTMLElement>(FOCUSABLE)?.focus() })
  } else {
    document.removeEventListener('keydown', onDocKeydown, true)
    const back = opener
    opener = null
    nextTick(() => { if (back?.isConnected) back.focus() })
  }
}, { immediate: true })
onUnmounted(() => document.removeEventListener('keydown', onDocKeydown, true))
</script>

<template>
  <Teleport to="body">
  <div v-if="open" class="mask" @click.self="emit('close')">
    <aside ref="hd" class="hd" role="dialog" aria-modal="true" aria-label="说明">
      <div class="hd-head">
        <Icon name="help" :size="18" />
        <span class="hd-title">{{ title ?? '说明' }}</span>
        <span class="spacer" />
        <button class="hd-x" type="button" aria-label="关闭" @click="emit('close')">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <div class="hd-body"><slot /></div>
    </aside>
  </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 70;
  background: var(--c-scrim);
  display: flex; justify-content: flex-end;
}
.hd {
  width: min(440px, 92vw); height: 100%;
  background: var(--c-surface);
  border-left: 1px solid var(--c-border-strong);
  box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column;
  animation: slidein .18s ease;
}
@keyframes slidein { from { transform: translateX(24px); opacity: .6 } to { transform: none; opacity: 1 } }
.hd-head {
  display: flex; align-items: center; gap: 9px;
  padding: 14px 16px; border-bottom: 1px solid var(--c-border);
}
.hd-title { font-weight: 600; font-size: var(--fs-15); }
.spacer { flex: 1; }
.hd-x {
  width: 32px; height: 32px; border: none; background: transparent;
  color: var(--c-text-dim); border-radius: var(--radius-xs); cursor: pointer;
  display: grid; place-items: center;
}
.hd-x:hover { background: var(--c-hover); color: var(--c-text); }
.hd-body { padding: 16px; overflow-y: auto; font-size: var(--fs-13-5); line-height: 1.7; color: var(--c-text); }
.hd-body :deep(h4) { margin: 18px 0 6px; font-size: var(--fs-13); color: var(--c-text-dim); }
.hd-body :deep(p) { margin: 0 0 10px; }
.hd-body :deep(ul) { margin: 0 0 10px; padding-left: 18px; }
.hd-body :deep(li) { margin: 2px 0; }
.hd-body :deep(code) {
  font-family: var(--mono); background: var(--c-glass);
  padding: 1px 5px; border-radius: var(--radius-chip); font-size: var(--fs-12);
}
</style>
