<script setup lang="ts">
/**
 * 「刷新」按钮——全站唯一长相。
 *
 * 为什么抽组件：这个按钮曾在 17 个文件里手写 20 遍，于是漂成了三种长相
 * （页级 `.tools-row` 高 38 + 图标 15；卡片级顶栏高 31 + 图标 15/14/13 三种；
 * notifications 干脆没有图标），更有两页把 `btn-primary`（橙渐变 + 阴影）用在刷新上
 * ——橙色只该给页面唯一主操作。手写值必然漂移，故收成单一事实源：长相与档位
 * 只在这一个文件里定义，改一处全站生效（同 `navItems.ts` / `SITE_COLS` 的思路）。
 *
 * 档位判据（与 `.tools-row` / `.card-toolbar` 的分层一致，勿按个人喜好选）：
 *   - 页级 `.tools-row`          → 默认档（高 38，图标 15）
 *   - 卡片级 `card-toolbar` 等   → `sm`（高 31，图标 14）
 * 空态 CTA 里的刷新跟随所在列表的档位，不另起第三档。
 */
// ⚠ 漏掉这条 import 时 Vue 不会报错：`<Icon>` 被当成未知自定义元素渲染成空
// `<icon>`，只有 console warning，tsc / build / 源码断言全绿而按钮没有图标。
// 由 RefreshBtn.behavior.test.ts（真挂载查 svg.icon）与
// scripts/check-component-imports.mjs（全仓接线守卫）双向钉住。
import Icon from '@/components/Icon.vue'

defineProps<{
  /** 加载中 / 无权限 / 实时跟随中等场景禁用 */
  disabled?: boolean
  /** 工具提示；不传则不设 title */
  title?: string
  /** 卡片级顶栏用小档；页级工具行省略此 prop */
  sm?: boolean
  /**
   * 横向空间紧张处（文件页工具行）：≤1400 视口把「刷新」二字收起，只留图标。
   *
   * ⚠ 必须是**显式开关**而不是全局行为：其余 23 处（大多在卡片顶栏）空间宽松，
   *   「刷新」二字就是按钮的主要含义，不能被连带收起。
   * ⚠ 文字被 CSS 收起后，唯一的可访问名称是 aria-label —— 模板里恒给
   *   （有 title 用 title，否则「刷新」），否则读屏用户面对一个无名图标。
   *   判据只能是**真机量宽度 + 读 aria-label**：jsdom 不求值媒体查询。
   */
  collapsible?: boolean
}>()

const emit = defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <!-- 图标与文字之间不再靠模板空格分隔（`.btn-*` 是 inline-flex + gap:6px，
       空格作为 flex 容器的文本节点会被丢掉），文字包进 <span> 才能被 CSS 收起。 -->
  <button class="btn-ghost" :class="{ 'btn-sm': sm, collapsible }" :disabled="disabled"
    :title="title" :aria-label="title || '刷新'" @click="emit('click')">
    <Icon name="refresh" :size="sm ? 14 : 15" /><span class="tool-label">刷新</span>
  </button>
</template>

<style scoped>
/* 只在显式声明 collapsible 的调用点收起文字（79 → 34px）。断点与文件页工具行的
   「只留图标」降级同档（≤1400），两边必须一致，否则同一行里有的按钮收了字、
   有的没收，宽度算不准。 */
@media (max-width: 1400px) {
  .collapsible .tool-label { display: none; }
}
</style>
