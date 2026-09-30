import { watch, onMounted, onUnmounted, nextTick, type Ref } from 'vue'

/**
 * 弹窗统一行为（审计 U1）：Esc 关闭 + Tab 焦点陷阱 + 打开时自动聚焦。
 *
 * 全项目此前 0 处 Esc 监听——所有弹窗/SQL 控制台/恢复框键盘用户都无法退出，
 * 读屏用户会被困在遮罩里。此 composable 把三件事收敛到一处，接入方式：
 *
 *   const root = ref<HTMLElement | null>(null)
 *   useModal(() => props.open, root, () => emit('cancel'))
 *
 * 约定：root 指向弹窗**内容容器**（role="dialog" 那一层），不是遮罩层。
 *
 * 细节：
 * - keydown 在捕获阶段监听：即使焦点落在弹窗内部被 stopPropagation 的
 *   控件（如 Terminal）上，Esc 也能到达这里；
 * - Tab 陷阱把焦点循环限制在容器内可聚焦元素中（Shift+Tab 反向），
 *   容器内没有可聚焦元素时不拦截（避免死锁）；
 * - open 变 true 时自动聚焦容器内第一个可聚焦元素，键盘流从弹窗内开始。
 */
export function useModal(
  isOpen: () => boolean,
  root: Ref<HTMLElement | null>,
  onClose: () => void,
) {
  function focusables(): HTMLElement[] {
    const el = root.value
    if (!el) return []
    return Array.from(el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter((x) => !x.hasAttribute('disabled'))
  }

  function onKeydown(e: KeyboardEvent) {
    if (!isOpen() || !root.value) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const list = focusables()
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus()
    } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === document.body)) {
      e.preventDefault(); first.focus()
    }
  }

  // 打开时把焦点搬进弹窗（autofocus 语义）
  let stop: (() => void) | undefined
  onMounted(() => {
    document.addEventListener('keydown', onKeydown, true)
    stop = watch(isOpen, (v) => {
      if (v) nextTick(() => focusables()[0]?.focus())
    })
  })
  onUnmounted(() => {
    document.removeEventListener('keydown', onKeydown, true)
    stop?.()
  })
}
