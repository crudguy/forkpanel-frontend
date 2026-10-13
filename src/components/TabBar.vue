<script setup lang="ts">
/**
 * 通用 Tab 条：承载同一功能域下的多个子视图（如主机监控的 实时趋势/专业快照/进程管理）。
 *
 * 两种驱动模式：
 * - 路由模式（默认，传 `to`）：激活态按 route.path **精确**比对，不用 router-link-active
 *   以免概览 '/' 在所有页面都亮；点击走 RouterLink 切路由，内容由父级 <RouterView /> 渲染。
 *   这也是大多数页（主机监控/日志/任务/安全）的用法，标题随子路由 meta.title 变化。
 * - 受控模式（传 `value`）：不切路由，仅作为本地 Tab 状态的展示。由父级用 `model-value`
 *   传入当前选中值、`@change` 接收切换意图（父级自己决定要不要重新拉数据）。
 *   容器页面的「容器/镜像」即此模式——同一能力下的两个本地列表视图。
 *
 * `icon` 为可选图标位（当前用 currentColor 着色，激活态白底上自动变白）。
 *
 * 「哪些 Tab 可见」由父级按权限点决定并传给 `tabs`，不与路由表漂移。
 */
import { useRoute } from 'vue-router'
import Icon from '@/components/Icon.vue'

defineProps<{
  tabs: { to?: string; value?: string; label: string; icon?: string }[]
  modelValue?: string
}>()
const emit = defineEmits<{ (e: 'change', value: string): void }>()
const route = useRoute()
</script>

<template>
  <div class="tabs" role="tablist">
    <template v-for="t in tabs" :key="t.to ?? t.value">
      <RouterLink v-if="t.to" :to="t.to" class="tab"
        :class="{ on: route.path === t.to }" role="tab" :aria-selected="route.path === t.to">
        <Icon v-if="t.icon" :name="t.icon" :size="14" />{{ t.label }}
      </RouterLink>
      <button v-else class="tab" type="button"
        :class="{ on: modelValue === t.value }" role="tab" :aria-selected="modelValue === t.value"
        @click="emit('change', t.value as string)">
        <Icon v-if="t.icon" :name="t.icon" :size="14" />{{ t.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.tabs { display: inline-flex; gap: 4px; padding: 4px; align-self: flex-start;
        border: 1px solid var(--c-border); border-radius: 10px; background: var(--c-surface-2); }
/* RouterLink 与 button 两种元素都要同样的视觉：button 必须显式重置默认边框/背景/字体 */
.tab { display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px;
       border: none; background: none; font-family: inherit; font-size: var(--fs-13-5);
       color: var(--c-text-dim); text-decoration: none; cursor: pointer;
       transition: color .15s ease, background .15s ease; }
.tab:hover { color: var(--c-text); }
.tab.on { background: var(--gradient); color: #fff; font-weight: 500; }
</style>
