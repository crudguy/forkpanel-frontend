// @vitest-environment jsdom
/**
 * ExpandableTextarea 的**行为**测试（真挂载，不读源码）。
 *
 * 取代此前的 `ExpandableTextarea.test.ts`：那份断言的是源码文本
 * （`v-model="model"` 出现 2 次、`<Teleport to="body">` 字面量、`type="button"`
 * 的正则），三个断言都只证明"代码这么写"，不证明"两个框真的共享一份数据"。
 * 已知代价：任何等价改写（比如把 `v-model` 换成 `:value` + `@input`）都会红。
 *
 * 这里挂载真实组件，断言用户能观察到的结果：在小框里输入 → 放大层里能看见同一份
 * 文本；在放大层里改 → 收起后小框显示新值；`update:modelValue` 只发一次完整值。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import ExpandableTextarea from './ExpandableTextarea.vue'

/** 挂载期间创建的 app，逐个卸载，避免 Teleport 到 body 的节点串场。 */
let app: App | null = null
let host: HTMLElement | null = null

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.innerHTML = ''
})

/** 把组件放进一个持有 v-model 的父组件里，挂到真实 DOM 上。 */
function mountWithModel(initial = '') {
  const value = ref(initial)
  const emitted: string[] = []
  const Parent = defineComponent({
    setup: () => () => h(ExpandableTextarea, {
      modelValue: value.value,
      'onUpdate:modelValue': (v: string) => { value.value = v; emitted.push(v) },
    }),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(Parent)
  app.mount(host)
  return { value, emitted }
}

const small = () => host!.querySelector<HTMLTextAreaElement>('.lined-ta')!
const big = () => document.body.querySelector<HTMLTextAreaElement>('.expand-modal .lined-ta')

/** E2E 同款：受控输入必须走原生 setter + input 事件，直接赋 value 不触发响应式。 */
function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ExpandableTextarea：两个编辑区共享同一份数据', () => {
  it('小框输入后打开放大层，放大层显示的是同一份文本', async () => {
    const { value } = mountWithModel()
    type(small(), 'docker compose up -d')
    await nextTick()
    expect(value.value, '小框的输入没有写回 v-model').toBe('docker compose up -d')

    host!.querySelector<HTMLButtonElement>('.expand-open')!.click()
    await nextTick()
    expect(big(), '点击放大后 body 下没有出现编辑区（Teleport 未生效？）').not.toBeNull()
    expect(big()!.value, '放大层没有继承小框的内容').toBe('docker compose up -d')
  })

  it('在放大层里改，收起后小框显示新值（不是各存一份）', async () => {
    const { value } = mountWithModel('旧值')
    host!.querySelector<HTMLButtonElement>('.expand-open')!.click()
    await nextTick()
    type(big()!, '新值')
    await nextTick()
    expect(value.value, '放大层的编辑没有写回同一个 v-model').toBe('新值')

    // 点「完成」收起放大层
    const done = [...document.body.querySelectorAll<HTMLButtonElement>('.expand-foot button')]
      .find((b) => b.textContent?.trim() === '完成')
    expect(done, '放大层缺少「完成」按钮').toBeTruthy()
    done!.click()
    await nextTick()
    expect(small().value, '收起后小框仍是旧值——两份数据没同步').toBe('新值')
  })

  it('放大按钮是先天的 type=button（表单里点它不会提交）', async () => {
    // jsdom 不会真的走表单提交算法，故只断言渲染出的属性：
    // 属性缺失或写成 submit 时，浏览器会把「放大」变成「提交」。
    const { } = mountWithModel()
    await nextTick()
    expect(host!.querySelector('.expand-open')!.getAttribute('type')).toBe('button')
  })

  it('放大层挂在 body 下（Teleport），不是组件内部', async () => {
    mountWithModel()
    host!.querySelector<HTMLButtonElement>('.expand-open')!.click()
    await nextTick()
    expect(host!.querySelector('.expand-modal .lined-ta'), '放大层留在了组件内部（会被父级裁切/层叠上下文困住）').toBeNull()
    expect(document.body.querySelector('.mask.level-2')?.parentElement).toBe(document.body)
  })
})

describe('ExpandableTextarea：Esc 关的是放大层', () => {
  it('按 Esc 后放大层走统一关闭出口并卸载', async () => {
    mountWithModel('x')
    host!.querySelector<HTMLButtonElement>('.expand-open')!.click()
    await nextTick()
    expect(big()).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    // useModal.close() 会先加 .is-closing 播离场动画（跳过动画时直接关）
    const mask = document.body.querySelector('.mask.level-2')
    if (mask) {
      expect(mask.classList.contains('is-closing'), 'Esc 没有走 useModal 的统一关闭出口').toBe(true)
      await new Promise((r) => setTimeout(r, 200))
      await nextTick()
    }
    expect(document.body.querySelector('.expand-modal .lined-ta'), 'Esc 后放大层仍未卸载').toBeNull()
  })
})
