<script setup lang="ts">
/**
 * toast 的渲染宿主：只看队列、不做业务。
 *
 * 挂在 MainLayout 一处即可（全站唯一）。用 `position: fixed` 浮在所有内容之上，
 * 因此既不会顶偏页面布局，也不会被 .mask 遮罩挡住（z-index 见 main.css 的 .toast-host）。
 */
import Icon from '@/components/Icon.vue'
import { useToasts, dismiss, type ToastKind } from '@/composables/useToast'

const items = useToasts()

// 四态图标（err 用圆框感叹、warn 用三角感叹）：两者此前共用 alert，
// 导致「失败」和「警告」看起来完全一样，用户无法从视觉判断严重程度。
const ICON: Record<ToastKind, string> = {
  ok: 'check', err: 'alert-circle', warn: 'alert', info: 'info',
}
</script>

<template>
  <!-- aria-live=polite：屏幕阅读器在有新提示时播报，但不打断当前朗读 -->
  <div class="toast-host" aria-live="polite">
    <!-- TransitionGroup：出场用 CSS 的 .toast-leave-* 播右侧滑出，
         其余条目由 .toast-move 平滑补位（缺它就只会"跳"一下）。 -->
    <TransitionGroup name="toast">
      <div
        v-for="t in items"
        :key="t.id"
        class="toast"
        :class="`toast-${t.kind}`"
        role="status"
        tabindex="0"
        :title="`${t.text}（点击关闭）`"
        @click="dismiss(t.id)"
        @keydown.enter="dismiss(t.id)"
        @keydown.space.prevent="dismiss(t.id)"
      >
        <Icon :name="ICON[t.kind]" :size="15" class="ic" />
        <span class="tx">{{ t.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>
