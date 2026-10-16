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
defineProps<{
  /** 加载中 / 无权限 / 实时跟随中等场景禁用 */
  disabled?: boolean
  /** 工具提示；不传则不设 title */
  title?: string
  /** 卡片级顶栏用小档；页级工具行省略此 prop */
  sm?: boolean
}>()

const emit = defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <button class="btn-ghost" :class="{ 'btn-sm': sm }" :disabled="disabled" :title="title"
    @click="emit('click')">
    <Icon name="refresh" :size="sm ? 14 : 15" /> 刷新
  </button>
</template>
