<script setup lang="ts">
/**
 * 渲染错误边界（两级部署）。
 *
 * ## 为什么需要它
 * 此前没有任何兜底：`app.config.errorHandler` 未设、全仓 0 个 `onErrorCaptured`、
 * 没有 ErrorBoundary。某个视图的 computed 对异常响应形状取值（后端 5xx / 降级返回 /
 * 字段缺失）就会抛出——用户看到半张空白页，没有提示、没有可复制的信息。
 * **一个用来排障的面板自己坏了却静默**，这是最不该有的反差，而且这类问题在真机上
 * 极难复现定位。
 *
 * ## 两级部署
 * - `App.vue` 外层：兜**布局壳**（MainLayout 自身）崩掉 → 全屏兜底，至少还能重新加载。
 * - `MainLayout` 内层：兜**页面组件**崩掉 → 侧栏与顶栏仍可用，切到别的页面就能继续干活。
 *
 * ## 为什么 Catch 后返回 false
 * `onErrorCaptured` 返回 false 会**阻止继续向上冒泡**（到 `app.config.errorHandler`）。
 * 边界已经给出了可见反馈，再让全局 toast 弹一条同样的错误就是重复打扰。
 *
 * ## 重试语义
 * 只清 `err` 不会让失败的子树重新渲染（Vue 不会因为父组件状态变化就重建它），
 * 所以用 `:key` 自增强制重挂载——这是唯一能真正"再试一次"的做法。
 * 若错误可复现，重挂载后会立刻再次落到兜底，不会骗人。
 */
import { onErrorCaptured, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/components/Icon.vue'

const props = defineProps<{
  /** 兜底标题，区分层级（布局崩 / 页面崩） */
  title?: string
}>()

const err = ref('')
const detail = ref('')
const retryKey = ref(0)

onErrorCaptured((e: unknown) => {
  err.value = e instanceof Error ? e.message : String(e)
  // 栈只留在控制台/剪贴板，不铺在页面上（对用户无用，还会把布局撑乱）
  detail.value = e instanceof Error ? (e.stack ?? '') : ''
  console.error('[panel] 渲染异常已被错误边界拦截：', e)
  return false
})

// 切路由即清空：用户去别的页面就该能继续，不必先点"重试"
const route = useRoute()
watch(() => route.fullPath, () => { err.value = '' })

function retry() {
  err.value = ''
  detail.value = ''
  retryKey.value += 1
}
function reload() {
  window.location.reload()
}
/** 给用户一条能贴进工单的完整信息 */
async function copy() {
  const text = `${err.value}\n\nroute: ${route.fullPath}\n\n${detail.value}`
  try {
    await navigator.clipboard.writeText(text)
  } catch { /* 无剪贴板权限时静默：不要让兜底页自己再报错 */ }
}
</script>

<template>
  <div v-if="err" class="err-boundary" role="alert">
    <div class="eb-head">
      <Icon name="alert-circle" :size="18" />
      <b>{{ props.title ?? '页面渲染出错' }}</b>
    </div>
    <p class="eb-msg">{{ err }}</p>
    <p class="eb-hint">
      这是前端渲染异常，通常由后端返回的数据形状与预期不符引起。可以重试或刷新；
      若反复出现，请把下面这条错误的完整信息（含浏览器控制台栈）反馈给维护者。
    </p>
    <p class="eb-path">当前路由：<code>{{ route.fullPath }}</code></p>
    <div class="eb-actions">
      <button class="btn-primary btn-sm" type="button" @click="retry">重试</button>
      <button class="btn-ghost btn-sm" type="button" @click="reload">重新加载页面</button>
      <button class="btn-ghost btn-sm" type="button" @click="copy">复制错误信息</button>
    </div>
  </div>
  <!-- :key 变化 ⇒ 子树强制重挂载，这是"重试"真正生效的关键 -->
  <div v-else :key="retryKey"><slot /></div>
</template>

<style scoped>
.err-boundary {
  margin: 16px;
  padding: 18px 20px;
  border: 1px solid var(--c-danger);
  border-radius: var(--radius, 10px);
  background: var(--c-surface);
}
.eb-head { display: flex; align-items: center; gap: 8px; color: var(--c-danger); }
.eb-msg {
  margin: 10px 0 0;
  font-family: var(--mono);
  font-size: var(--fs-13);
  color: var(--c-text);
  word-break: break-word;
}
.eb-hint { margin: 8px 0 0; font-size: var(--fs-12); color: var(--c-text-dim); line-height: 1.7; }
.eb-path { margin: 8px 0 0; font-size: var(--fs-12); color: var(--c-text-dim); }
.eb-actions { display: flex; gap: 8px; margin-top: 14px; }
</style>
