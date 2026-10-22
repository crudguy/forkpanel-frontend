import { watch, onMounted, onUnmounted, nextTick, type Ref } from 'vue'

/**
 * 弹窗统一行为：**Esc 关闭 + Tab 焦点陷阱 + 打开自动聚焦 + 关闭后焦点返还 + 离场动画**。
 *
 * 全项目此前 0 处 Esc 监听——所有弹窗 / SQL 控制台 / 恢复框键盘用户都无法退出，
 * 读屏用户会被困在遮罩里。此 composable 把这几件事收敛到一处，接入方式：
 *
 *   const root = ref<HTMLElement | null>(null)
 *   const { close } = useModal(() => props.open, root, () => emit('cancel'))
 *
 * 约定：root 指向弹窗**内容容器**（role="dialog" 那一层），不是遮罩层。
 *
 * ── ⭐ 所有关闭路径都必须走返回的 `close()`：右上角 X、点遮罩（@click.self）、
 *    底部「取消」按钮。Esc 由本函数内部接管，同样走它。
 *    为什么：只有同一个出口才能保证「离场动画 + 焦点返还」行为一致；
 *    各写各的（X 直接改 ref、遮罩走另一个函数）会出现"Esc 关了但焦点丢了"、
 *    "点 X 有动画、点遮罩没有"这类不一致。
 *
 * 细节：
 * - keydown 在捕获阶段监听：即使焦点落在弹窗内部被 stopPropagation 的
 *   控件（如 Terminal）上，Esc 也能到达这里；
 * - Tab 陷阱把焦点循环限制在容器内可聚焦元素中（Shift+Tab 反向），
 *   容器内没有可聚焦元素时不拦截（避免死锁）；
 * - 打开时记录来源焦点元素，关闭后**还回去**——否则键盘用户关掉弹窗后焦点
 *   掉回 body，得从头再 Tab 一遍才能回到刚才的操作；已卸载的元素则跳过。
 */
const CLOSE_MS = 140 // 与 main.css 的 .is-closing 动画时长（.14s）保持一致

/**
 * 打开中的浮层栈（模块级，跨组件共享）。**Esc / Tab 只归栈顶那个浮层处理。**
 *
 * 为什么需要：每个 useModal 都各自在 `document` 上挂**捕获阶段**的 keydown，
 * 而同节点同阶段的监听按**注册顺序**触发——父弹窗先挂载 ⇒ 它先收到 Esc。
 * 于是二级浮层（站点弹窗里的根证书指引 / 全屏配置编辑器）按 Esc 时，
 * **父子两层一起关**。真机实测过这个存量 bug：打开「安装面板根证书」再按 Esc，
 * `.site-modal` 与二级浮层同时消失，用户只想关掉里面那一层。
 *
 * 用栈而不是布尔「有没有嵌套」：三层及以上同样要逐层关，且互不相关的两个浮层
 * （回收站 + SQL 控制台）也不会再互相抢 Esc。
 */
const openStack: symbol[] = []

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useModal(
  isOpen: () => boolean,
  root: Ref<HTMLElement | null>,
  onClose: () => void,
) {
  /** 关闭中标记：连按 Esc / 反复点遮罩时不要叠加多次 setTimeout */
  let closing = false
  /** 本实例在栈里的身份（同一组件多处 useModal 也不会混） */
  const token = Symbol('useModal')
  const push = () => { if (!openStack.includes(token)) openStack.push(token) }
  const pop = () => { const i = openStack.indexOf(token); if (i >= 0) openStack.splice(i, 1) }
  /** 是否轮到本实例处理键盘：非栈顶一律让位（父弹窗的监听更早触发，不拦就一起关） */
  const isTopmost = () => openStack[openStack.length - 1] === token

  function focusables(): HTMLElement[] {
    const el = root.value
    if (!el) return []
    return Array.from(el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter((x) => !x.hasAttribute('disabled'))
  }

  /**
   * 统一关闭出口：先给遮罩加 .is-closing 播完离场动画，再真正卸载。
   * 用 v-if 卸载的元素没法做纯 CSS 出场动画——必须在卸载**之前**先播完。
   */
  function close() {
    if (closing) return
    const mask = root.value?.parentElement
    if (!mask || prefersReducedMotion()) { onClose(); return }
    closing = true
    mask.classList.add('is-closing')
    window.setTimeout(() => {
      mask.classList.remove('is-closing')
      closing = false
      onClose()
    }, CLOSE_MS)
  }

  function onKeydown(e: KeyboardEvent) {
    if (!isOpen() || !root.value) return
    // 嵌套浮层：只有栈顶响应。父弹窗的监听注册更早、先执行，不拦这一下父子会一起关。
    if (!isTopmost()) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
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

  // 打开时把焦点搬进弹窗（autofocus 语义）；关闭时把它还给来源元素
  // ⚠️ immediate: true —— 有些浮层（回收站面板 / SQL 控制台）**没有 open prop**，
  //    由父组件 v-if 控制挂载，"挂载即打开"。没有 immediate 的话 watch 永远不触发，
  //    这类浮层的焦点管理与 Tab 陷阱就形同虚设。
  let opener: HTMLElement | null = null
  let stop: (() => void) | undefined
  onMounted(() => {
    document.addEventListener('keydown', onKeydown, true)
    stop = watch(isOpen, (v) => {
      if (v) {
        push()
        opener = document.activeElement as HTMLElement | null
        nextTick(() => focusables()[0]?.focus())
      } else {
        pop()
        closing = false
        const back = opener
        opener = null
        nextTick(() => {
          // 来源按钮可能已被卸载（如删完这一行），还回去会抛错/焦点落空
          if (back && back.isConnected) back.focus()
        })
      }
    }, { immediate: true })
  })
  onUnmounted(() => {
    document.removeEventListener('keydown', onKeydown, true)
    pop()   // 父组件卸载时子浮层可能还开着：不摘栈会留下永久的假栈顶
    stop?.()
  })

  return { close }
}
