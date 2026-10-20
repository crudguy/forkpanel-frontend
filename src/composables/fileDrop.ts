/**
 * 拖拽上传的**纯逻辑**（无 DOM、无 Vue）——刻意外置以便单测。
 *
 * 为什么不在视图里就地写：拖拽有三个极易写错的隐性规则，写在 `.vue` 里就永远
 * 无法被 vitest 覆盖（只收 src 下的 .test.ts，且本仓没装 vue 插件），而它们的
 * 失败形态全是「静默」——不报错、不影响构建，只是行为不对：
 *
 * 1. **dragenter/dragleave 会在子元素之间反复触发**。把指针从空白处移到表格行上，
 *    浏览器会先发 leave 再发 enter。直接按 enter→显示 / leave→隐藏 处理，遮罩
 *    会狂闪。正解是深度计数：enter +1、leave −1，归零才算真正离开。
 * 2. **不做 preventDefault 的 dragover/drop，浏览器会直接打开被拖入的文件**，
 *    整个面板被替换成一张图片或一段文本——这是用户眼里最像「面板坏了」的表现。
 * 3. **拖动的是文字/链接而不是文件**时不能拦截：用户在编辑器里选中一段文字拖拽、
 *    或把网页里的链接拖进来，都不该触发上传遮罩。
 *
 * 对应的三个函数各自只做一件事，视图只负责接线。
 */

/** 判断一次拖拽事件里是否携带**文件**（而非选中的文字、链接等）。 */
export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  // types 是 DOMStringList/数组，兼容两种情况
  const types = Array.from(dt.types ?? [])
  // 'Files' 是规范里的固定标记；部分环境（旧 WebKit）拖文件时只给 items
  if (types.includes('Files')) return true
  return Array.from(dt.items ?? []).some((it) => it.kind === 'file')
}

/**
 * 从 drop 事件里取出文件列表。
 *
 * ⚠ 必须在事件回调里**同步**取：`DataTransfer.files` 只在事件派发期间有效，
 * 一旦放进 await 之后再读，多数浏览器会返回空列表（这是「拖上去没反应」的
 * 最常见成因）。调用方拿到数组后再异步上传是安全的。
 */
export function droppedFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  return Array.from(dt.files ?? [])
}

/**
 * 拖拽深度计数器：解决 enter/leave 在子元素间反复触发导致的遮罩闪烁。
 *
 * 用法：`inc()` 在 dragenter，`dec()` 在 dragleave，`active()` 决定是否显示遮罩。
 * `reset()` 用于 drop 之后与容器卸载时归零——否则计数会停在正数，遮罩再也不消失
 * （drop 之后通常不会再有配对的 dragleave，这是最典型的「遮罩卡住」事故）。
 */
export function createDragDepth() {
  let depth = 0
  return {
    inc(): number { return ++depth },
    dec(): number {
      // 钳到 0：leave 可能多于 enter（例如从窗口外直接离开），负数会让后续
      // 的「归零判定」永远等不到。
      if (depth > 0) depth--
      return depth
    },
    active(): boolean { return depth > 0 },
    reset(): void { depth = 0 },
    get value(): number { return depth },
  }
}

/**
 * 给遮罩写提示文案。分开是因为「只读用户拖动」与「正常拖动」的预期不同：
 * 前者不该收到「松手即上传」的承诺——那会让人以为拖进去就成功了。
 */
export function dropHint(canWrite: boolean, fileCount: number): string {
  if (!canWrite) return '当前账号没有文件写入权限，拖拽上传不可用'
  if (fileCount > 0) return `松开即可上传 ${fileCount} 个文件`
  // 拖动中拿不到实际文件数（安全限制：dragover 阶段不允许读取文件名）
  return '松开即可上传到当前目录'
}
