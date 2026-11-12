/**
 * 行号侧栏与 textarea 的状态同步（LinedTextarea / NginxEditor 共用）。
 *
 * 度量一律取自真实 textarea 的 computed style 与 clientHeight，不另写一份行高常量：
 * 行高改了 CSS 而这里写死，是行号错位最隐蔽的来源。ResizeObserver 覆盖「用户拖动
 * resize、弹层全屏切换、父容器宽度变化」等布局变化；内容变化由调用方在 nextTick 后
 * 调 sync()（浏览器会 clamp scrollTop）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, type Ref } from 'vue'
import { lineNumberWindow } from '@/composables/lineNumbers'

export function useLineGutter(ta: Ref<HTMLTextAreaElement | null>, lineCount: Ref<number>) {
  const scrollTop = ref(0)
  const lineHeight = ref(19)
  const paddingTop = ref(9)
  const viewportHeight = ref(200)
  let observer: ResizeObserver | null = null

  function measure() {
    const el = ta.value
    if (!el) return
    const cs = getComputedStyle(el)
    const lh = Number.parseFloat(cs.lineHeight)
    const fs = Number.parseFloat(cs.fontSize)
    lineHeight.value = Number.isFinite(lh) && lh > 0
      ? lh
      : (Number.isFinite(fs) && fs > 0 ? fs * 1.55 : 19)
    const pt = Number.parseFloat(cs.paddingTop)
    paddingTop.value = Number.isFinite(pt) ? pt : 0
    viewportHeight.value = el.clientHeight || 0
    scrollTop.value = el.scrollTop || 0
  }

  /** textarea 滚动 / 内容变化后调用：只更新状态，不写回 DOM 位置。 */
  function sync() {
    const el = ta.value
    if (!el) return
    scrollTop.value = el.scrollTop || 0
    if (el.clientHeight) viewportHeight.value = el.clientHeight
  }

  const lnWindow = computed(() => lineNumberWindow({
    lineCount: lineCount.value,
    lineHeight: lineHeight.value,
    scrollTop: scrollTop.value,
    viewportHeight: viewportHeight.value,
    paddingTop: paddingTop.value,
  }))

  onMounted(() => {
    void nextTick(() => {
      measure()
      if (typeof ResizeObserver !== 'undefined' && ta.value) {
        observer = new ResizeObserver(() => measure())
        observer.observe(ta.value)
      }
    })
  })
  onUnmounted(() => {
    observer?.disconnect()
    observer = null
  })

  return { lnWindow, sync, measure }
}
