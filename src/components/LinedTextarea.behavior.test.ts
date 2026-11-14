// @vitest-environment jsdom
/**
 * 行号编辑框的**行为**测试（真挂载，不读源码文本）。
 *
 * 覆盖三类退化：① 行号不随内容走；② 大文本把几万行号节点灌进 DOM（并顺带把
 * 编辑框撑高）；③ 外部事件落在根 div 而不是 textarea（focus 不冒泡 ⇒ 静默收不到）。
 * 滚动窗口跟随也在这里验，纯函数只保证算得对，不保证组件真的接了滚动。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import LinedTextarea from './LinedTextarea.vue'
import NginxEditor from './NginxEditor.vue'

let app: App | null = null
let host: HTMLElement | null = null

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.innerHTML = ''
})

function mount(comp: unknown, extra: Record<string, unknown> = {}, initial = '') {
  const value = ref(initial)
  const exposed = ref<{ focus?: () => void } | null>(null)
  const Parent = defineComponent({
    setup: () => () => h(comp as never, {
      ref: exposed,
      modelValue: value.value,
      'onUpdate:modelValue': (v: string) => { value.value = v },
      ...extra,
    }),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(Parent)
  app.mount(host)
  const setValue = async (v: string) => {
    value.value = v
    await nextTick()
    await nextTick()
  }
  return { value, exposed, host: host!, setValue }
}

const lnTexts = (root: ParentNode, sel: string) =>
  [...root.querySelectorAll(sel)].map((el) => el.textContent?.trim())

describe('LinedTextarea：行号随逻辑行变化', () => {
  it('空文本 1 行 / 三行 / 末尾换行各展示正确行号', async () => {
    const m = mount(LinedTextarea)
    await nextTick(); await nextTick()
    expect(lnTexts(m.host, '.ln')).toEqual(['1'])

    await m.setValue('alpha\nbeta\ngamma')
    expect(lnTexts(m.host, '.ln')).toEqual(['1', '2', '3'])

    await m.setValue('tail\n')
    expect(lnTexts(m.host, '.ln')).toEqual(['1', '2'])
  })

  it('12000 行只渲染一屏 + 缓冲的行号节点，不把 DOM 撑爆', async () => {
    const m = mount(LinedTextarea)
    await nextTick(); await nextTick()
    await m.setValue(Array.from({ length: 12_000 }, (_, i) => 'row ' + (i + 1)).join('\n'))
    const nodes = m.host.querySelectorAll('.ln')
    expect(nodes.length, '窗口化失效：行号节点数随文件行数线性增长').toBeLessThan(60)
    expect(nodes[0].textContent?.trim()).toBe('1')
  })

  it('滚动后窗口跟着移动，第一支行号不再是 1', async () => {
    const m = mount(LinedTextarea, {}, Array.from({ length: 400 }, (_, i) => 'row ' + (i + 1)).join('\n'))
    await nextTick(); await nextTick()
    const ta = m.host.querySelector<HTMLTextAreaElement>('.lined-ta')!
    ta.scrollTop = 1900
    ta.dispatchEvent(new Event('scroll', { bubbles: true }))
    await nextTick()
    expect(Number(lnTexts(m.host, '.ln')[0]), '滚动后行号窗口没有跟随').toBeGreaterThan(50)
    expect(m.host.querySelector('.ln-window')!.getAttribute('style')).toContain('translateY')
  })
})

describe('LinedTextarea：外部属性与事件落在 textarea 上', () => {
  it('onFocus 由 textarea 收到（绑在根 div 时 focus 不冒泡，会静默丢失）', async () => {
    let hits = 0
    const m = mount(LinedTextarea, { onFocus: () => { hits += 1 } })
    await nextTick(); await nextTick()
    const ta = m.host.querySelector<HTMLTextAreaElement>('.lined-ta')!
    ta.focus()
    expect(hits, '外部事件没有透传到 textarea').toBe(1)
    expect(document.activeElement).toBe(ta)
  })

  it('readonly / disabled / aria-label / wrap=off 都落在真实输入元素上', async () => {
    const m = mount(LinedTextarea, {
      readonly: true, disabled: true, ariaLabel: '文件内容', spellcheck: false,
    })
    await nextTick(); await nextTick()
    const ta = m.host.querySelector<HTMLTextAreaElement>('.lined-ta')!
    expect(ta.readOnly).toBe(true)
    expect(ta.disabled).toBe(true)
    expect(ta.getAttribute('aria-label')).toBe('文件内容')
    expect(ta.getAttribute('wrap'), '缺少 wrap=off，长行仍会软折行导致行号错位').toBe('off')
    expect(m.host.querySelector('.lined-gutter')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('defineExpose 的 focus() 能把光标交到 textarea', async () => {
    const m = mount(LinedTextarea)
    await nextTick(); await nextTick()
    m.exposed.value?.focus?.()
    expect(document.activeElement).toBe(m.host.querySelector('.lined-ta'))
  })
})

describe('NginxEditor：高亮层与行号侧栏共用一份滚动位置', () => {
  it('行号随内容走，大文本同样窗口化', async () => {
    const m = mount(NginxEditor, {}, 'server {\n  listen 80;\n}\n')
    await nextTick(); await nextTick()
    expect(lnTexts(m.host, '.ne-ln')).toEqual(['1', '2', '3', '4'])

    await m.setValue(Array.from({ length: 12_000 }, () => 'set $x 1;').join('\n'))
    expect(m.host.querySelectorAll('.ne-ln').length).toBeLessThan(60)
  }, 15_000)

  it('滚动时行号窗口与着色层都跟随 textarea', async () => {
    const m = mount(NginxEditor, {}, Array.from({ length: 400 }, (_, i) => '# line ' + (i + 1)).join('\n'))
    await nextTick(); await nextTick()
    const ta = m.host.querySelector<HTMLTextAreaElement>('.ne-ta')!
    const pre = m.host.querySelector<HTMLPreElement>('.ne-pre')!
    expect(ta.getAttribute('wrap')).toBe('off')
    // 内容是纯注释行：顺带钉住「大文本窗口化后着色层仍渲染注释 token」。
    // 旧断言查 .tok-num 其实在吃 bug 的副作用——注释正则失效时 `# line 1`
    // 里的数字才会被当成数字 token；注释修好后它必然变红。数字着色由下方
    // 「# 注释高亮」用例单独覆盖。
    expect(m.host.querySelector('.tok-comment'), '注释 token 没渲染').not.toBeNull()
    ta.scrollTop = 1900
    ta.scrollLeft = 40
    ta.dispatchEvent(new Event('scroll', { bubbles: true }))
    await nextTick()
    expect(pre.scrollTop).toBe(ta.scrollTop)
    expect(pre.scrollLeft).toBe(ta.scrollLeft)
    expect(Number(lnTexts(m.host, '.ne-ln')[0])).toBeGreaterThan(50)
  })
})

describe('NginxEditor：# 注释高亮（真挂载，查着色层 DOM）', () => {
  const comments = (root: ParentNode) =>
    [...root.querySelectorAll('.ne-pre .tok-comment')].map((el) => el.textContent)

  it('整行 / 行尾 / 紧跟方括号的注释各自命中到行尾，且不吞下一行', async () => {
    const m = mount(NginxEditor, {}, [
      '# whole line',
      'listen 80; # tail comment',
      '#[anchor] 80',
      'set $x 1;',
    ].join('\n'))
    await nextTick(); await nextTick()
    expect(comments(m.host), '注释须整段落进 .tok-comment，每行一条且不跨行').toEqual([
      '# whole line', '# tail comment', '#[anchor] 80',
    ])
    // 注释之外的 token 仍按各自身份着色：防「整行被吞」或 tokenizer 提前停摆
    expect([...m.host.querySelectorAll('.tok-directive')].map((el) => el.textContent)).toEqual(['listen', 'set'])
    expect([...m.host.querySelectorAll('.tok-num')].map((el) => el.textContent)).toEqual(['80', '1'])
    expect([...m.host.querySelectorAll('.tok-var')].map((el) => el.textContent)).toEqual(['$x'])
  })

  it('字符串里的 # 不当注释；内容变化后注释跟着重算', async () => {
    const m = mount(NginxEditor, {}, 'set $msg "a # b";')
    await nextTick(); await nextTick()
    expect(comments(m.host), '字符串内的 # 被误判成注释').toEqual([])
    expect(m.host.querySelector('.tok-string')?.textContent).toBe('"a # b"')

    await m.setValue('set $msg "a # b";\n# real one')
    expect(comments(m.host)).toEqual(['# real one'])
    expect(m.host.querySelector('.tok-string')?.textContent).toBe('"a # b"')
  })
})
