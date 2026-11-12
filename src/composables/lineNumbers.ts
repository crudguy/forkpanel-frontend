/**
 * 行号侧栏的窗口计算（纯函数）。
 *
 * 为什么必须窗口化：行号侧栏若把每一行都渲染成真实 DOM 节点，① 2MB 文本会有
 * 几万个节点；② 更致命的是这些节点会把 flex 容器一起撑高，textarea 被 stretch
 * 到内容全高 ⇒ 编辑框失去内部滚动，随文件行数无限长。
 *
 * 因此侧栏只渲染「可见区 + 前后缓冲」的行号，用 transform 平移到与当前滚动位置
 * 对应的位置；侧栏本身不滚动、不撑高容器。行号 y = paddingTop + 行号起点×行高
 * - scrollTop，与 textarea 内部同一起点的文本行严格对齐。
 */
export interface LineNumberWindowInput {
  /** 逻辑行总数（按 \n 计，空文本也至少 1 行） */
  lineCount: number
  /** 单行高度（px，取 textarea 的 computed line-height） */
  lineHeight: number
  /** 当前纵向滚动位置（px） */
  scrollTop: number
  /** 编辑区可视高度（px，textarea.clientHeight） */
  viewportHeight: number
  /** textarea / gutter 共用的 padding-top（px） */
  paddingTop: number
  /** 前后各多渲染几行，覆盖滚动条、亚像素与快速滚动 */
  buffer?: number
}

export interface LineNumberWindow {
  /** 窗口内首个行号（1-based） */
  first: number
  /** 窗口内需要渲染的行号 */
  numbers: number[]
  /** 窗口容器相对侧栏顶部应平移的距离（px，可为负） */
  offsetY: number
}

export function lineNumberWindow(input: LineNumberWindowInput): LineNumberWindow {
  const lineHeight = Number.isFinite(input.lineHeight) && input.lineHeight > 0 ? input.lineHeight : 1
  const paddingTop = Number.isFinite(input.paddingTop) ? input.paddingTop : 0
  const scrollTop = Number.isFinite(input.scrollTop) && input.scrollTop > 0 ? input.scrollTop : 0
  const viewportHeight = Number.isFinite(input.viewportHeight) && input.viewportHeight > 0 ? input.viewportHeight : 0
  const buffer = Number.isFinite(input.buffer) && (input.buffer ?? 0) >= 0 ? Math.floor(input.buffer ?? 8) : 8
  const lineCount = Math.max(1, Math.floor(input.lineCount))

  // 起点向前退 buffer 行，末尾至少覆盖一屏；上限钉在总行数，避免渲染空行号。
  const startIndex = Math.min(
    lineCount - 1,
    Math.max(0, Math.floor(scrollTop / lineHeight) - buffer),
  )
  const visible = Math.ceil(viewportHeight / lineHeight) + buffer * 2 + 1
  const endIndex = Math.min(lineCount, startIndex + Math.max(1, visible))

  const numbers: number[] = []
  for (let n = startIndex + 1; n <= endIndex; n += 1) numbers.push(n)

  return {
    first: numbers[0] ?? 1,
    numbers,
    offsetY: paddingTop + startIndex * lineHeight - scrollTop,
  }
}
