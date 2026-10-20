import { describe, it, expect } from 'vitest'
import { hasFiles, droppedFiles, createDragDepth, dropHint } from './fileDrop'

/** 造一个最小 DataTransfer 替身：只实现被测代码真正读的字段。
 *  必须先过 unknown：DataTransfer 有 dropEffect/getData 等一大批成员，
 *  直接 as 会触发 TS2352（"两者不够重叠"）。 */
function dt(opts: { types?: string[]; items?: { kind: string }[]; files?: unknown[] }): DataTransfer {
  return {
    types: opts.types ?? [],
    items: (opts.items ?? []) as unknown as DataTransferItemList,
    files: (opts.files ?? []) as unknown as FileList,
  } as unknown as DataTransfer
}

describe('hasFiles — 区分「拖文件」与「拖文字/链接」', () => {
  it('types 含 Files 时判定为拖文件', () => {
    expect(hasFiles(dt({ types: ['Files'] }))).toBe(true)
  })

  it('只有 text/plain 时不算拖文件（在编辑器里拖选中的文字）', () => {
    expect(hasFiles(dt({ types: ['text/plain'] }))).toBe(false)
  })

  it('拖链接（text/uri-list）不算拖文件', () => {
    expect(hasFiles(dt({ types: ['text/uri-list', 'text/plain'] }))).toBe(false)
  })

  it('旧 WebKit 只给 items 时也认得出文件', () => {
    expect(hasFiles(dt({ types: [], items: [{ kind: 'file' }] }))).toBe(true)
  })

  it('items 只有 string 时不算', () => {
    expect(hasFiles(dt({ types: [], items: [{ kind: 'string' }] }))).toBe(false)
  })

  it('null / undefined 安全返回 false（拖拽移出窗口时会收到空 dt）', () => {
    expect(hasFiles(null)).toBe(false)
    expect(hasFiles(undefined)).toBe(false)
  })
})

describe('droppedFiles — 取文件列表', () => {
  it('返回 files 的全部内容', () => {
    const a = { name: 'a.txt' }, b = { name: 'b.txt' }
    expect(droppedFiles(dt({ files: [a, b] }))).toEqual([a, b])
  })

  it('空 files 返回空数组（不是 null）', () => {
    expect(droppedFiles(dt({}))).toEqual([])
  })

  it('null 安全返回空数组', () => {
    expect(droppedFiles(null)).toEqual([])
  })
})

describe('createDragDepth — enter/leave 在子元素间反复触发的对策', () => {
  it('初始为 0 且不活跃', () => {
    const d = createDragDepth()
    expect(d.value).toBe(0)
    expect(d.active()).toBe(false)
  })

  it('进入后活跃，离开后归零', () => {
    const d = createDragDepth()
    d.inc()
    expect(d.active()).toBe(true)
    d.dec()
    expect(d.active()).toBe(false)
  })

  it('⭐ 进入子元素（leave+enter 配对）时仍保持活跃，不闪烁', () => {
    const d = createDragDepth()
    d.inc()            // 进入容器
    d.inc()            // 进入子元素（浏览器先发 leave 再发 enter，但顺序不保证）
    d.dec()            // 离开上一层子元素
    expect(d.active()).toBe(true)   // 若按布尔量处理，这里就误判为"已离开"⇒遮罩闪
    d.dec()
    expect(d.active()).toBe(false)
  })

  it('⭐ dec 钳到 0，不为负（负数会让归零永远等不到）', () => {
    const d = createDragDepth()
    d.dec(); d.dec(); d.dec()
    expect(d.value).toBe(0)
    expect(d.active()).toBe(false)
    // 归零后再进入必须正常生效
    d.inc()
    expect(d.active()).toBe(true)
  })

  it('⭐ reset 归零——drop 后没有配对的 leave，不重置遮罩会卡住', () => {
    const d = createDragDepth()
    d.inc(); d.inc(); d.inc()
    expect(d.active()).toBe(true)
    d.reset()                       // drop 时调用
    expect(d.active()).toBe(false)
    expect(d.value).toBe(0)
  })
})

describe('dropHint — 文案不能对只读用户空口许诺', () => {
  it('可写且已知数量时给出具体数字', () => {
    expect(dropHint(true, 3)).toBe('松开即可上传 3 个文件')
  })

  it('可写但拿不到数量时给通用文案（dragover 阶段读不到文件名）', () => {
    expect(dropHint(true, 0)).toBe('松开即可上传到当前目录')
  })

  it('⭐ 只读用户必须说明不可用，不能出现「松开即可上传」', () => {
    const s = dropHint(false, 0)
    expect(s).not.toContain('即可上传')
    expect(s).toContain('权限')
  })

  it('只读 + 有文件数时也不许诺', () => {
    expect(dropHint(false, 5)).not.toContain('即可上传')
  })
})
