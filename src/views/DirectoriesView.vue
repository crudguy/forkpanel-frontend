<script setup lang="ts">
/**
 * 目录与位置：面板装到了哪 / 数据在哪 / 日志在哪 / Web 服务器是哪来的。
 *
 * **为什么独立成 Tab**：原先这块内容挂在「实时趋势」页最底部，而没有用户
 * 想查"装到哪"时会去点"实时趋势"。真机实测原位置在 1139px 处、视口仅 577px，
 * 两屏之外——等于藏起来。
 */
import DirectoriesPanel from '@/components/DirectoriesPanel.vue'
</script>

<template>
  <div class="dirs-view">
    <p class="intro dim">
      以下路径来自面板运行时的实际布局（改过配置里的 <code>[paths]</code> 会同步反映）。
      面板<b>不安装</b> Web 服务器与数据库：nginx 由系统包管理器提供，数据存于内嵌 SQLite。
    </p>
    <DirectoriesPanel />
  </div>
</template>

<style scoped>
.dirs-view { display: flex; flex-direction: column; gap: 4px; }
.intro { margin: 0 2px 10px; font-size: var(--fs-12-5); line-height: 1.7; }
.intro code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: color-mix(in srgb, var(--c-border) 60%, transparent);
  padding: 1px 5px; border-radius: 4px; color: var(--c-text); }
.intro b { color: var(--c-text); font-weight: 600; }
</style>
