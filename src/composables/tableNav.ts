import type { Directive } from 'vue'

/**
 * C7 表格键盘方向键行导航（roving tabindex）。
 * 仅给主数据 <table> 加 `v-table-nav` 即可；行级 tabindex/role 在运行时注入，
 * 不受 Vue 重渲染影响（tbody 的 MutationObserver 在行增删后重新应用）。
 *
 * 行为：
 *   ↑/↓     在行间移动焦点并滚动入视
 *   Home/End 跳首/末行
 *   Enter/Space 不自动触发动作（避免误触删除等），行内按钮仍可用 Tab 进入
 *   焦点在 input/textarea/select 内时方向键走原生行为（不打断输入）
 *
 * 焦点环复用 main.css 的 [role="row"]:focus-visible 品牌色描边；状态存 WeakMap，
 * 指令卸载即清理，无 any、无全局副作用。
 */
interface NavState {
  active: number
  rows: HTMLTableRowElement[]
  observer: MutationObserver | null
  onKey: (e: KeyboardEvent) => void
  onFocusIn: (e: FocusEvent) => void
}

const stateMap = new WeakMap<HTMLTableElement, NavState>()

// 跳过展开明细行与「空态」行（单行且唯一 td 带 colspan），其余 tbody 直接子行皆纳入导航
function isNavRow(tr: Element): boolean {
  if (tr.classList.contains('detail-row')) return false
  const tds = tr.querySelectorAll('td')
  if (tds.length === 1 && tds[0].hasAttribute('colspan')) return false
  return true
}

function collect(table: HTMLTableElement): HTMLTableRowElement[] {
  const tbody = table.querySelector('tbody')
  if (!tbody) return []
  return Array.from(tbody.querySelectorAll(':scope > tr')).filter(
    (tr): tr is HTMLTableRowElement => isNavRow(tr)
  )
}

function apply(table: HTMLTableElement, state: NavState): void {
  state.rows = collect(table)
  if (state.active >= state.rows.length) state.active = Math.max(0, state.rows.length - 1)
  state.rows.forEach((tr, i) => {
    tr.setAttribute('role', 'row')
    tr.tabIndex = i === state.active ? 0 : -1
  })
}

function focusRow(table: HTMLTableElement, state: NavState, i: number): void {
  if (!state.rows.length) return
  const idx = Math.min(Math.max(i, 0), state.rows.length - 1)
  state.active = idx
  state.rows.forEach((tr, j) => (tr.tabIndex = j === idx ? 0 : -1))
  const tr = state.rows[idx]
  tr.focus({ preventScroll: true })
  tr.scrollIntoView({ block: 'nearest' })
}

export const tableNav: Directive<HTMLTableElement> = {
  mounted(el) {
    const onKey = (e: KeyboardEvent) => {
      const state = stateMap.get(el)
      if (!state) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      )
        return
      if (!el.contains(t)) return
      let handled = true
      switch (e.key) {
        case 'ArrowDown':
          focusRow(el, state, state.active + 1)
          break
        case 'ArrowUp':
          focusRow(el, state, state.active - 1)
          break
        case 'Home':
          focusRow(el, state, 0)
          break
        case 'End':
          focusRow(el, state, state.rows.length - 1)
          break
        default:
          handled = false
      }
      if (handled) e.preventDefault()
    }

    const onFocusIn = (e: FocusEvent) => {
      const state = stateMap.get(el)
      if (!state) return
      const tr = (e.target as HTMLElement | null)?.closest?.('tbody > tr') as HTMLTableRowElement | null
      if (tr && state.rows.includes(tr)) {
        const i = state.rows.indexOf(tr)
        state.active = i
        state.rows.forEach((r, j) => (r.tabIndex = j === i ? 0 : -1))
      }
    }

    const state: NavState = { active: 0, rows: [], observer: null, onKey, onFocusIn }
    stateMap.set(el, state)
    apply(el, state)
    el.addEventListener('keydown', onKey)
    el.addEventListener('focusin', onFocusIn)
    const tbody = el.querySelector('tbody')
    if (tbody) {
      state.observer = new MutationObserver(() => apply(el, state))
      state.observer.observe(tbody, { childList: true })
    }
  },
  unmounted(el) {
    const state = stateMap.get(el)
    if (!state) return
    el.removeEventListener('keydown', state.onKey)
    el.removeEventListener('focusin', state.onFocusIn)
    state.observer?.disconnect()
    stateMap.delete(el)
  },
}
