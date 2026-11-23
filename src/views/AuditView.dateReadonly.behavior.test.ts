// @vitest-environment jsdom
// 审计页日期框「只读化」行为：禁止键盘改值，只能点日历图标选日期。
//
// 真挂载后对 input[type=datetime-local] 派发 keydown，断言 defaultPrevented——
// 这是唯一能挡住「放行集合退化」的判据：Tab/Enter/Esc 必须放行（键盘可达），
// 数字/字母/方向键/Backspace 必须拦掉（否则又露出原生 yyyy/mm/日 编辑态）。
import { describe, it, expect } from 'vitest'
import AuditView from './AuditView.vue'
import { mountView, capsAllOk } from '@/test/mount'
import { API } from '@/api/endpoints'

async function mountAudit() {
  const m = await mountView({
    component: AuditView,
    caps: capsAllOk(),
    perms: ['audit.view', 'system.view'],
    routes: { [API.audit()]: { items: [], page: 1, page_size: 20, total: 0 } } as never,
  })
  await m.flush()
  return m
}

/** 派发一个 cancelable 的 keydown，返回事件是否被 preventDefault。 */
function dispatchKey(input: HTMLInputElement, key: string, mods: Partial<KeyboardEventInit> = {}): boolean {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  input.dispatchEvent(ev)
  return ev.defaultPrevented
}

describe('审计页日期框只读化', () => {
  it('导航/无障碍键放行：Tab、Shift+Tab、Enter、Escape、Ctrl/Meta/Alt 组合', async () => {
    const m = await mountAudit()
    const input = m.host.querySelector<HTMLInputElement>('input[type=datetime-local]')!
    expect(dispatchKey(input, 'Tab')).toBe(false)
    expect(dispatchKey(input, 'Tab', { shiftKey: true })).toBe(false)
    expect(dispatchKey(input, 'Enter')).toBe(false)
    expect(dispatchKey(input, 'Escape')).toBe(false)
    expect(dispatchKey(input, 'a', { ctrlKey: true })).toBe(false)
    expect(dispatchKey(input, 'r', { metaKey: true })).toBe(false)
  })

  it('改值键全部拦掉：数字、字母、方向键、退格、删除', async () => {
    const m = await mountAudit()
    const inputs = m.host.querySelectorAll<HTMLInputElement>('input[type=datetime-local]')
    expect(inputs.length).toBe(2)
    for (const input of inputs) {
      for (const key of ['0', '2', '9', 'a', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']) {
        expect(dispatchKey(input, key), `${key} 应被拦截`).toBe(true)
      }
    }
  })

  it('点框任意位置都尝试弹出日期选择卡（showPicker 接线），而非只能点日历图标', async () => {
    const m = await mountAudit()
    const inputs = m.host.querySelectorAll<HTMLInputElement>('input[type=datetime-local]')
    // jsdom 无原生 showPicker，挂 spy 断言 @click 真的调用了它
    let calls = 0
    for (const input of inputs) input.showPicker = () => { calls++ }
    inputs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(1)
    inputs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(calls).toBe(2)
  })

  it('空值显示中文占位，有值后占位消失（只能由日历图标/快捷区间填入）', async () => {
    const m = await mountAudit()
    const labels = [...m.host.querySelectorAll<HTMLElement>('label.dt')]
    expect(labels.length).toBe(2)
    for (const lab of labels) {
      expect(lab.querySelector('.dt-ph')?.textContent?.trim()).toBe('年/月/日')
    }
    // 模拟 picker 回填：原生 setter + input 事件
    const input = labels[0].querySelector('input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, '2026-01-02T03:04')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await m.flush()
    expect(labels[0].querySelector('.dt-ph')).toBeNull()
    expect(labels[1].querySelector('.dt-ph')?.textContent?.trim()).toBe('年/月/日')
  })
})
