<script setup lang="ts">
/**
 * 统一风险提示条（评估报告 C3）。
 *
 * 为什么需要它：备份「主密钥丢了就解不开」、终端「宿主级权限」、防火墙「封禁端口可能
 * SSH 失联」、容器「不提供创建容器」——这些文案本身都写得很好，但此前**形态各异、
 * 位置各异**（有的 `<p class="tip">`、有的 `<p class="hint">`、有的 drawer 注释），
 * 用户记不住"哪里会有危险提示"。这里抽成全站复用的三档组件：
 *   info 中性说明 / warn 警告 / danger 高危，各带对应图标与语义配色。
 *
 * 用法：页面顶部或操作区前置一条；高危操作前用 ConfirmDialog 复述后果（与审计联动），
 * 本组件负责"常驻提示"，ConfirmDialog 负责"执行前二次确认"，分工不重叠。
 */
import Icon from '@/components/Icon.vue'

type Level = 'info' | 'warn' | 'danger'

const props = defineProps<{
  level?: Level
  /** 可选标题，让"是什么"与"会怎样"分两行，比一整段更可读 */
  title?: string
  /** 提示正文（面向用户的完整句子） */
  text: string
}>()

const ICONS: Record<Level, string> = { info: 'info', warn: 'alert', danger: 'alert-circle' }
const level = props.level ?? 'info'
</script>

<template>
  <div class="risk" :class="`is-${level}`" role="note">
    <Icon :name="ICONS[level]" :size="18" class="ico" />
    <div class="body">
      <p v-if="title" class="t">{{ title }}</p>
      <p class="x">{{ text }}</p>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.risk {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 11px 13px; border-radius: 10px;
  border: 1px solid var(--c-border);
  margin: 0 0 14px;
  font-size: var(--fs-13); line-height: 1.55;
  color: var(--c-text-dim);
}
.ico { flex: none; margin-top: 1px; color: var(--c-primary); }
.body { min-width: 0; }
.t { margin: 0 0 2px; font-weight: 600; font-size: var(--fs-13); color: var(--c-text); }
.x { margin: 0; }

.is-info { background: var(--c-glass); }
.is-warn {
  background: var(--c-warn-bg);
  border-color: color-mix(in srgb, var(--c-warn) 42%, transparent);
  color: var(--c-text);
}
.is-warn .ico { color: var(--c-warn); }
.is-danger {
  background: var(--c-danger-soft);
  border-color: color-mix(in srgb, var(--c-danger) 42%, transparent);
  color: var(--c-text);
}
.is-danger .ico { color: var(--c-danger); }
</style>
