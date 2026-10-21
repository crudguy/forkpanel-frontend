<script setup lang="ts">
/**
 * 404 页（布局内，侧栏保留）。
 *
 * ## 为什么不再 `redirect: '/'`
 * 原先未知路径直接重定向到概览：用户看到的是**正常的首页**，只会以为"点了没反应"
 * 或"面板把我踢回去了"——旧书签、拼错的地址、后端改过的路由都表现成同一种静默。
 * 现在明确告知"这个地址不存在"，并把尝试访问的路径显示出来（复制给维护者最有用）。
 *
 * 放在 MainLayout 的 children 里（而非顶层）：404 不是"离开应用"，侧栏应当还在，
 * 用户可以直接点去别的页面，而不是靠浏览器后退。
 */
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

function back() {
  // 没有历史时（直接粘贴地址进来）退回概览
  if (window.history.length > 1) router.back()
  else void router.push('/')
}
</script>

<template>
  <div class="nf">
    <div class="nf-code">404</div>
    <h3 class="nf-title">这个页面不存在</h3>
    <p class="nf-hint">
      地址 <code class="nf-path">{{ route.fullPath }}</code> 没有对应的页面。
      可能是收藏的链接过期（面板改过路由），或地址拼写有误。
    </p>
    <div class="nf-actions">
      <button class="btn-primary btn-sm" type="button" @click="router.push('/')">回到概览</button>
      <button class="btn-ghost btn-sm" type="button" @click="back">返回上一页</button>
    </div>
  </div>
</template>

<style scoped>
.nf {
  max-width: 520px;
  margin: 48px auto;
  padding: 28px 30px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
  background: var(--c-surface);
  text-align: center;
}
.nf-code {
  font-family: var(--mono);
  font-size: 44px;
  line-height: 1;
  color: var(--c-text-mute);
  letter-spacing: .04em;
}
.nf-title { margin: 10px 0 6px; font-size: var(--fs-16); }
.nf-hint { margin: 0; font-size: var(--fs-13); color: var(--c-text-dim); line-height: 1.7; }
.nf-path {
  font-family: var(--mono);
  font-size: var(--fs-12);
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-inset);
  word-break: break-all;
}
.nf-actions { display: flex; gap: 8px; justify-content: center; margin-top: 18px; }
</style>
