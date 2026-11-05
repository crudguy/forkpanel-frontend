/**
 * 空态 CTA 的共用动作：把用户带回**常驻**的新建表单并聚焦第一个输入框。
 *
 * 为什么不是「再开一个弹窗」：计划任务 / 数据库连接的新建表单本来就常驻在
 * 页面上方，空态出现在它们下面。空态只写「暂无数据」不给动作，用户会以为
 * 没处下手；再复制一套新建弹窗又会和上方表单形成两个事实源。故只做导航。
 */
export function focusCreateCard(cardId: string): void {
  const card = document.getElementById(cardId)
  if (!card) return
  // jsdom / 老浏览器没有 scrollIntoView；聚焦才是关键动作，不能因此抛错。
  card.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  card.querySelector<HTMLElement>('input, select, textarea')?.focus()
}
