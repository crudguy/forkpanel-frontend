<script setup lang="ts">
/**
 * 目录与位置：面板装到了哪 / 数据在哪 / 日志在哪 / Web 服务器是哪来的。
 *
 * **为什么独立成页**：原先这块内容挂在「实时趋势」页最底部，而没有用户
 * 想查"装到哪"时会去点"实时趋势"。真机实测原位置在 1139px 处、视口仅 577px，
 * 两屏之外——等于藏起来。2026-11-19 再由「主机监控」的 Tab 提升为侧栏
 * 「系统」组一级页 /dirs：它是部署事实，不属监控指标域。
 */
import DirectoriesPanel from '@/components/DirectoriesPanel.vue'
</script>

<template>
  <div class="dirs-view">
    <p class="intro dim">
      以下路径来自面板的实际布局，修改配置后会自动同步。
      面板<b>不负责安装</b> Web 服务器与数据库，数据保存在内置数据库中。
    </p>
    <DirectoriesPanel />
  </div>
</template>

<style scoped>
.dirs-view { display: flex; flex-direction: column; gap: 4px; }
.intro { margin: 0 2px 10px; font-size: var(--fs-12-5); line-height: 1.7; }
.intro code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: color-mix(in srgb, var(--c-border) 60%, transparent);
  padding: 1px 5px; border-radius: var(--radius-chip); color: var(--c-text); }
.intro b { color: var(--c-text); font-weight: 600; }
</style>
