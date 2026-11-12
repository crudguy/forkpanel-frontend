// @vitest-environment jsdom
/**
 * 编辑框「按文件类型自动高亮」的真挂载测试（查着色层 DOM，不读源码文本）。
 *
 * 覆盖三类退化：① 语言没按文件类型选（或选错）；② 未识别类型被强行套高亮，
 * 破坏纯文本文件的编辑链路；③ 叠了着色层后 v-model / 滚动同步断了 ——
 * 纯函数单测证明不了组件真的把 pre 接上、也证明不了保存值仍完整。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import LinedTextarea from './LinedTextarea.vue'
import NginxEditor from './NginxEditor.vue'

const apps: App[] = []
const hosts: HTMLElement[] = []

afterEach(() => {
  apps.splice(0).forEach((a) => a.unmount())
  hosts.splice(0).forEach((el) => el.remove())
  document.body.innerHTML = ''
})

function mount(comp: unknown, extraProps: Record<string, unknown> = {}, initial = '') {
  const value = ref(initial)
  const extra = ref(extraProps)
  const emitted: string[] = []
  const Parent = defineComponent({
    setup: () => () => h(comp as never, {
      modelValue: value.value,
      'onUpdate:modelValue': (v: string) => { value.value = v; emitted.push(v) },
      ...extra.value,
    }),
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  hosts.push(el)
  const instance = createApp(Parent)
  apps.push(instance)
  instance.mount(el)
  return {
    value,
    emitted,
    host: el,
    setValue: async (v: string) => { value.value = v; await nextTick(); await nextTick() },
    setProps: async (p: Record<string, unknown>) => { extra.value = p; await nextTick(); await nextTick() },
  }
}

const comments = (root: ParentNode) =>
  [...root.querySelectorAll('.lined-pre .tok-comment')].map((el) => el.textContent)

/** E2E 同款：受控输入必须走原生 setter + input 事件。 */
function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('LinedTextarea：按文件类型自动应用高亮规则', () => {
  it('.yml 按 yaml 规则着色，textarea 进入高亮态', async () => {
    const m = mount(LinedTextarea, { filename: 'compose.yml' }, 'services:\n  web: {} # tail\n')
    await nextTick(); await nextTick()
    expect(comments(m.host), 'yaml 的 # 注释没上色').toEqual(['# tail'])
    expect(m.host.querySelector('.lined-pre'), '着色层没渲染').not.toBeNull()
    expect(m.host.querySelector('.lined-ta')!.classList.contains('has-hl')).toBe(true)
  })

  it('路径含 nginx 的 .conf 走 nginx 规则，systemd drop-in 的 .conf 走 ini', async () => {
    const nginx = mount(LinedTextarea, { filename: '/etc/nginx/sites-enabled/a.conf' }, 'server { # c\n  listen 80;\n}')
    await nextTick(); await nextTick()
    expect(comments(nginx.host)).toEqual(['# c'])

    const unit = mount(LinedTextarea, { filename: '/etc/systemd/system/x.service.d/override.conf' }, '[Service]\n; note\nRestart=always')
    await nextTick(); await nextTick()
    // 两个挂载共用 host 变量，取第二个（后挂的）节点
    const pre = document.body.querySelectorAll('.lined-pre')[1]
    expect([...pre.querySelectorAll('.tok-comment')].map((el) => el.textContent)).toEqual(['; note'])
    expect([...pre.querySelectorAll('.tok-directive')].map((el) => el.textContent)).toEqual(['[Service]'])
  })

  it('filename 变化时规则跟着切换（yaml 的 # → sql 的 --）', async () => {
    const m = mount(LinedTextarea, { filename: 'a.yml' }, 'SELECT 1; # y')
    await nextTick(); await nextTick()
    expect(comments(m.host)).toEqual(['# y'])

    await m.setProps({ filename: 'a.sql' })
    expect(comments(m.host), '切成 sql 后 # 不该再当注释').toEqual([])

    await m.setValue('SELECT 1; -- s')
    expect(comments(m.host), 'sql 的 -- 注释没生效').toEqual(['-- s'])
  })

  it('显式 language 覆盖 filename；plain 可强制关闭', async () => {
    const m = mount(LinedTextarea, { filename: 'a.yml', language: 'plain' }, 'a: 1 # c')
    await nextTick(); await nextTick()
    expect(m.host.querySelector('.lined-pre')).toBeNull()
    expect(m.host.querySelector('.lined-ta')!.classList.contains('has-hl')).toBe(false)
  })

  it('未识别文件类型：不渲染任何着色层，编辑与保存值完整', async () => {
    const m = mount(LinedTextarea, { filename: 'notes.txt' }, 'plain # text\n')
    await nextTick(); await nextTick()
    expect(m.host.querySelector('.lined-pre'), 'plain 不该有着色层').toBeNull()
    expect(m.host.querySelector('.tok-comment'), 'plain 不该有 token span').toBeNull()
    expect(m.host.querySelector('.lined-ta')!.classList.contains('has-hl')).toBe(false)

    const ta = m.host.querySelector<HTMLTextAreaElement>('.lined-ta')!
    type(ta, 'new # value\nsecond line')
    await nextTick()
    expect(m.emitted.at(-1), 'v-model 没把完整新值交给保存方').toBe('new # value\nsecond line')
    expect(m.value.value).toBe('new # value\nsecond line')
  })

  it('高亮态下输入同样触发完整 v-model，着色层文本与 textarea 一致', async () => {
    const m = mount(LinedTextarea, { filename: 'a.yml' }, 'a: 1')
    await nextTick(); await nextTick()
    const ta = m.host.querySelector<HTMLTextAreaElement>('.lined-ta')!
    type(ta, 'a: 2 # c')
    await nextTick()
    expect(m.emitted.at(-1)).toBe('a: 2 # c')
    expect(m.host.querySelector('.lined-pre')!.textContent, '着色层与输入内容不一致').toBe('a: 2 # c')
    expect(comments(m.host)).toEqual(['# c'])
  })

  it('滚动时着色层跟随 textarea，行号窗口仍同步', async () => {
    const src = Array.from({ length: 400 }, (_, i) => 'key: ' + (i + 1) + ' # c').join('\n')
    const m = mount(LinedTextarea, { filename: 'a.yml' }, src)
    await nextTick(); await nextTick()
    const ta = m.host.querySelector<HTMLTextAreaElement>('.lined-ta')!
    const pre = m.host.querySelector<HTMLPreElement>('.lined-pre')!
    expect(m.host.querySelector('.ln'), '行号侧栏仍在').not.toBeNull()
    ta.scrollTop = 1900
    ta.scrollLeft = 40
    ta.dispatchEvent(new Event('scroll', { bubbles: true }))
    await nextTick()
    expect(pre.scrollTop).toBe(ta.scrollTop)
    expect(pre.scrollLeft).toBe(ta.scrollLeft)
    expect(Number(m.host.querySelector('.ln')!.textContent)).toBeGreaterThan(50)
  })
})

describe('NginxEditor：与通用编辑框共用同一套规则', () => {
  it('默认仍按 nginx 着色，显式 language 可切到别的语言', async () => {
    const m = mount(NginxEditor, {}, '# nginx comment\nlisten 80;')
    await nextTick(); await nextTick()
    expect([...m.host.querySelectorAll('.ne-pre .tok-comment')].map((el) => el.textContent))
      .toEqual(['# nginx comment'])

    const other = mount(NginxEditor, { language: 'sql' }, 'SELECT 1; -- c')
    await nextTick(); await nextTick()
    const pres = document.body.querySelectorAll('.ne-pre')
    expect([...pres[1].querySelectorAll('.tok-comment')].map((el) => el.textContent)).toEqual(['-- c'])
    expect([...pres[1].querySelectorAll('.tok-directive')].map((el) => el.textContent)).toEqual(['SELECT'])
  })
})
