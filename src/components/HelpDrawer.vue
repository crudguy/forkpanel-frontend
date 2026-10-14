<script setup lang="ts">
/**
 * 帮助抽屉（评估报告 A6）：把页面顶部「长篇说明文案」收进右侧滑出抽屉，
 * 页面上只留一个 `?` 图标触发（挂在常驻的提示行或卡片顶栏，随页面而定）。首次进入可自动展开一次（由调用方用 localStorage 控制），
 * 之后默认收起——解决"界面像文档"的问题，新用户看得到、老用户不被反复打扰。
 *
 * 与 RiskBanner 分工：本组件承载**完整的背景/约束说明**（长文），RiskBanner 承载
 * **常驻的高危提示**（短文）。前者按需展开，后者始终可见。
 */
import Icon from '@/components/Icon.vue'

defineProps<{ open: boolean; title?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <aside class="hd" role="dialog" aria-label="说明">
      <div class="hd-head">
        <Icon name="help" :size="18" />
        <span class="hd-title">{{ title ?? '说明' }}</span>
        <span class="spacer" />
        <button class="hd-x" type="button" aria-label="关闭" @click="emit('close')">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <div class="hd-body"><slot /></div>
    </aside>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(0, 0, 0, .4);
  display: flex; justify-content: flex-end;
}
.hd {
  width: min(440px, 92vw); height: 100%;
  background: var(--c-surface);
  border-left: 1px solid var(--c-border-strong);
  box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column;
  animation: slidein .18s ease;
}
@keyframes slidein { from { transform: translateX(24px); opacity: .6 } to { transform: none; opacity: 1 } }
.hd-head {
  display: flex; align-items: center; gap: 9px;
  padding: 14px 16px; border-bottom: 1px solid var(--c-border);
}
.hd-title { font-weight: 600; font-size: var(--fs-15); }
.spacer { flex: 1; }
.hd-x {
  width: 32px; height: 32px; border: none; background: transparent;
  color: var(--c-text-dim); border-radius: 8px; cursor: pointer;
  display: grid; place-items: center;
}
.hd-x:hover { background: var(--c-hover); color: var(--c-text); }
.hd-body { padding: 16px; overflow-y: auto; font-size: var(--fs-13-5); line-height: 1.7; color: var(--c-text); }
.hd-body :deep(h4) { margin: 18px 0 6px; font-size: var(--fs-13); color: var(--c-text-dim); }
.hd-body :deep(p) { margin: 0 0 10px; }
.hd-body :deep(ul) { margin: 0 0 10px; padding-left: 18px; }
.hd-body :deep(li) { margin: 2px 0; }
.hd-body :deep(code) {
  font-family: var(--mono); background: var(--c-glass);
  padding: 1px 5px; border-radius: 5px; font-size: var(--fs-12);
}
</style>
