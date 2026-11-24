// @vitest-environment jsdom
// 快捷设置必须真的改到表达式（emit 出去的值），不是只把下拉框点亮。
import { describe, it, expect } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import CronScheduleBar from './CronScheduleBar.vue'
import { mountView, type Mounted } from '@/test/mount'

async function mountBar(expr = '0 3 * * *') {
  const emitted: string[] = []
  const state = reactive({ expr })
  // 父组件把 emit 的值回写进 modelValue，与真实 v-model 行为一致：
  // 这样既能捕获发出的表达式，也能验证回声不会冲掉正在编辑的中间态。
  const Wrapper = defineComponent({
    setup: () => () => h(CronScheduleBar, {
      modelValue: state.expr,
      'onUpdate:modelValue': (v: string) => { emitted.push(v); state.expr = v },
    }),
  })
  const m = await mountView({ component: Wrapper })
  return { ...m, emitted, setExpr: (v: string) => { state.expr = v } }
}

function select(m: Mounted, label: string): HTMLSelectElement {
  return m.host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
}
function input(m: Mounted, label: string): HTMLInputElement {
  return m.host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
}
function setSelect(el: HTMLSelectElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('change'))
}
function setInput(el: HTMLInputElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('input'))
}
function last(emitted: string[]): string | undefined {
  return emitted[emitted.length - 1]
}

describe('CronScheduleBar · 快捷设置联动', () => {
  it('按已有表达式反推模式与时间，不依赖用户重新选', async () => {
    const m = await mountBar('10 3 * * *')
    expect(select(m, '快捷设置执行频率').value).toBe('daily')
    expect(input(m, '执行时间').value).toBe('03:10')
    expect(m.host.textContent).toContain('每天 03:10 执行一次')
    expect(m.emitted).toHaveLength(0)
    m.cleanup()
  })

  it('切到每 N 分钟，再改间隔，发出的是标准五段表达式', async () => {
    const m = await mountBar()
    setSelect(select(m, '快捷设置执行频率'), 'every')
    await m.flush()
    expect(last(m.emitted)).toBe('*/5 * * * *')

    setInput(input(m, '间隔分钟数'), '10')
    await m.flush()
    expect(last(m.emitted)).toBe('*/10 * * * *')
    expect(m.host.textContent).toContain('每 10 分钟执行一次')
    m.cleanup()
  })

  it('切到每周，星期和时间都能改，且只让 dow 非星', async () => {
    const m = await mountBar()
    setSelect(select(m, '快捷设置执行频率'), 'weekly')
    await m.flush()
    expect(last(m.emitted)).toBe('0 3 * * 1')

    setSelect(select(m, '执行星期'), '0')
    await m.flush()
    setInput(input(m, '执行时间'), '04:20')
    await m.flush()
    expect(last(m.emitted)).toBe('20 4 * * 0')
    expect(m.host.textContent).toContain('每周日 04:20 执行')
    m.cleanup()
  })

  it('外部改值（模板填充/编辑弹窗）会重新反推，不沿用上一份中间态', async () => {
    const m = await mountBar()
    m.setExpr('20 4 * * 1')
    await m.flush()
    expect(select(m, '快捷设置执行频率').value).toBe('weekly')
    expect(input(m, '执行时间').value).toBe('04:20')
    expect(m.host.textContent).toContain('每周一 04:20 执行')
    m.cleanup()
  })

  it('表达式输入框只在自定义模式可见，手填后自动切到自定义', async () => {
    const m = await mountBar('0 3 * * *')
    const expr = input(m, '表达式')
    expect(expr, '输入框须始终在 DOM 中，由 v-show 控制可见性').toBeTruthy()
    // v-show 写在 label 上；jsdom 的 getComputedStyle 不会把祖先 display:none 继承给 input
    expect((expr.closest('label') as HTMLElement).style.display).toBe('none')

    setInput(expr, '5 6 * * *')
    await m.flush()
    expect(select(m, '快捷设置执行频率').value).toBe('custom')
    expect((input(m, '表达式').closest('label') as HTMLElement).style.display).not.toBe('none')
    expect(last(m.emitted)).toBe('5 6 * * *')
    m.cleanup()
  })

  it('手写复杂表达式归自定义且原样回显，不被快捷设置改写', async () => {
    const m = await mountBar('0 3 * * 1,5')
    expect(select(m, '快捷设置执行频率').value).toBe('custom')
    expect(m.host.textContent).toContain('按自定义规则执行：0 3 * * 1,5')
    expect(m.host.querySelector('input[aria-label="执行时间"]')).toBeNull()
    m.cleanup()
  })

  it('禁用态下所有控件不可操作', async () => {
    const m = await mountView({
      component: CronScheduleBar,
      props: { modelValue: '0 3 * * *', disabled: true },
    })
    expect(select(m, '快捷设置执行频率').disabled).toBe(true)
    m.cleanup()
  })
})
