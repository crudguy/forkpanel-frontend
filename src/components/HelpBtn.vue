<script setup lang="ts">
/**
 * 「?」帮助按钮——全站唯一长相（与 RefreshBtn 同一思路）。
 *
 * 为什么抽组件：此前每页手写 `<button class="btn-icon ghost"><Icon name="help">`，
 * 且 AppsView 把它塞进 `.hint-note` 段落里、ContainersView 漏了 aria-label，
 * 摆法/可访问性不一致；也没有"打开态"反馈。收成单一事实源后统一为：
 *   - 圆形（border-radius 999px）+ 无边框 + 静音色（--c-text-dim），退为次要控件，
 *     不与主操作争夺注意力；橙色保留给状态/操作色，默认不用于帮助。
 *   - 悬浮：淡填充（--c-hover）+ 图标提亮到 --c-text；打开态（expanded）同悬浮色，
 *     让按钮成为 toggle 而非单纯 open。
 * 注意：不要改全局 `.btn-icon`（顶栏命令面板/通知/主题、进程 act-* 都在用），
 * 圆形/静音只靠本组件加的 `.help-btn` 修饰类生效。
 */
import Icon from '@/components/Icon.vue'

defineProps<{
  title?: string
  ariaLabel?: string
  disabled?: boolean
  sm?: boolean
  expanded?: boolean
}>()
const emit = defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <button
    class="btn-icon help-btn"
    :class="{ sm, 'is-open': expanded }"
    type="button"
    :title="title ?? '说明'"
    :aria-label="ariaLabel ?? title ?? '说明'"
    :aria-expanded="expanded ?? undefined"
    :disabled="disabled"
    @click="emit('click')"
  >
    <Icon name="help" :size="sm ? 14 : 16" />
  </button>
</template>

<style scoped>
/* 尺寸沿用 .btn-icon（34×34）；下面只覆盖"形状/颜色/反馈"。 */
.help-btn {
  border-color: transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--c-text-dim);
}
.help-btn:hover:not(:disabled) {
  background: var(--c-hover);
  color: var(--c-text);
}
/* 抽屉打开时给常亮态，表明这是 toggle。 */
.help-btn.is-open {
  background: var(--c-hover);
  color: var(--c-text);
}
/* 卡片级紧凑档：28×28 + 图标 14。 */
.help-btn.sm {
  width: 28px;
  height: 28px;
  padding: 5px;
}
</style>
