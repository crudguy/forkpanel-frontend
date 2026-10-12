<script setup lang="ts">
/**
 * 面板容器（评估报告 B3）：`.card` 的语义化 drop-in 封装。
 *
 * 为什么需要它：审计发现表格 / 表单 / 空态有的裹在 `.card`、有的裸奔，
 * 形态不一。把".card 作为唯一面板载体"收敛成一个组件，后续 CI 才能校验
 * "页面内容是否都进了 Panel"。
 *
 * 用法：
 *   <Panel>…表格/表单…</Panel>          默认带内边距
 *   <Panel flush>…满宽表格…</Panel>     去掉内边距、允许内部独立滚动（与 .card.flush 同义）
 * 额外 class / 事件会透传到根 <section>（Vue3 单根默认透传），所以
 * `<Panel flush class="procs-card">` 与原来的 `<div class="card flush procs-card">` 等价。
 */
withDefaults(defineProps<{ flush?: boolean }>(), { flush: false })
</script>

<template>
  <section class="card" :class="{ flush }">
    <slot />
  </section>
</template>
