/**
 * 站点主表的列治理（A3：10 列挤在内容区 → 主表 6 列 + 行展开）。
 *
 * 为什么抽出来：列定义、`shown()` 的唯一出口、弹性列推导、表格下限宽度与 colspan
 * 是**同一件事的五个面**——判据分散就必然漂移（曾出现过 colgroup 按 11 列算、
 * 而 CSS 只渲染 7 列，于是表格凭空多出 4 个空列、操作列被压到 58px）。
 * 这里一处定义，视图只管消费。
 *
 * ⚠ 本模块只管「列渲染与否」和「宽度几何」，不碰任何业务数据。
 */
import { computed } from 'vue'
import { useNarrow, useTableCols } from '@/composables/useTablePrefs'

// 默认收起 4 个次要列（根目录 / 类型 / 特性 / 上次下发），主表只剩
// 「站点 / 域名 / WAF / 状态 / TLS / 操作」（外加选择列）。想要的列可在「列」里
// 勾回来（记在本机，下次仍有效）。
// ⭐收起的列**不会丢信息**：根目录此前被截成 `/home/…` 正是报告点名的痛点，
//   收起后它的完整取值在**行展开**里以等宽文本呈现并可一键复制——比
//   "在窄列里截断 + 靠 title 悬停"可靠得多。
export const SITE_COLS: {
  id: string
  label: string
  w: number
  locked?: boolean
  align?: 'left' | 'right' | 'center'
}[] = [
  // 名称是这张表的**身份列**：没有它，"站点列表"就只剩一堆域名和按钮。
  // 且它同时是弹性列的兜底（见 elasticId）——允许隐藏会让整表既无身份列、
  // 又无弹性列（余量被平摊成空转留白），故标记为不可隐藏。
  { id: 'name', label: '名称', w: 200, locked: true },
  { id: 'dom', label: '域名', w: 180 },
  { id: 'root', label: '根目录', w: 220 }, // 弹性列：这个值只是它的**下限**
  { id: 'kind', label: '类型', w: 64 },
  { id: 'feat', label: '特性', w: 84 },
  { id: 'waf', label: 'WAF', w: 116 },
  { id: 'state', label: '状态', w: 120 },
  // 日期右对齐，便于纵向比对（B9 列类型/对齐规范：数字/日期/字节列 right，文本与徽标 left）
  { id: 'applied', label: '上次下发', w: 108, align: 'right' },
  { id: 'tls', label: 'TLS', w: 84 },
]

/** 锁定列（名称）不受偏好影响：本机 localStorage 里若存着脏值（手改 / 旧版本写坏），
 *  仅靠选择器把勾选框置灰挡不住——必须在这里兜住，否则渲染层会真的把它藏掉。 */
const LOCKED_IDS = SITE_COLS.filter((c) => c.locked).map((c) => c.id)

/** 窄屏隐藏的次要列：与 main.css 里 `.col-opt` 的标记一致。
 *  ⚠️ 由 JS 判而不是只交给 CSS：colgroup 列数 / 行展开的 colspan 都得跟着少这 4 列，
 *  只靠 CSS 隐藏时 JS 仍按 11 列算——实测（480px + 全列开启）表格凭空多出 4 个空列、
 *  操作列被压到 58px、展开行错位。 */
const NARROW_HIDDEN = ['root', 'kind', 'feat', 'applied']

/** 选择列宽 */
const SEL_W = 40
/** 与 main.css `@media (max-width:1799px) { col.w-sacts }` 一致；≥1800 时容器够宽，
 *  下限根本用不上，故这里恒取窄档值即可，不必把断点也复制到 JS。 */
const ACTS_W = 168

export function useSiteColumns() {
  // 解构成顶层 ref 后由本函数逐个返回：模板里 `cols.hidden` 拿到的是 Ref 对象
  // （只有 setup 顶层的 ref 才会自动解包），故中途绝不能再裹一层对象。
  const { hidden: hiddenCols, shown: rawShown, toggle: toggleCol, reset: resetCols } =
    useTableCols('sites.main', ['root', 'kind', 'feat', 'applied'])

  const narrow = useNarrow()

  /** 「这一列现在渲染吗」的唯一出口：锁定列恒真，其余看偏好，窄屏再砍掉次要列。 */
  const shown = (id: string) =>
    LOCKED_IDS.includes(id) || (!(narrow.value && NARROW_HIDDEN.includes(id)) && rawShown(id))

  /** 唯一弹性列：`table-layout:fixed` 下若所有列都有固定宽度，多出来的宽度会被**平摊
   *  到每一列**变成空转留白（此前踩过）。根目录是首选弹性列；它被隐藏时让域名吃余量，
   *  再退到名称（名称恒可见，故兜底一定成立）。
   *  ⚠️ 弹性列**不能靠 min-width 兜底**：实测 `col` 与 `th` 上的 min-width 在
   *  `table-layout:fixed` 下都被忽略（三态量出来都是 9px）。真正管用的是给 `<table>`
   *  一个下限宽度（见 tableMinW）——它小于内容时表格横向滚动，弹性列就不会被压成 0。 */
  const elasticId = computed(() => ['root', 'dom', 'name'].find((id) => shown(id)) ?? null)

  /** 表格下限宽度 = 勾选列宽之和 + 选择列 + 操作列。
   *  低于它就让表格横向滚动（容器 .card.flush 自带 overflow-x:auto）——
   *  11 列在 1160px 表宽里本来就不可能都可读，硬挤的结果是某列被压到 0。 */
  const tableMinW = computed(
    () => SEL_W + ACTS_W + SITE_COLS.filter((c) => shown(c.id)).reduce((s, c) => s + c.w, 0),
  )

  /** 行展开 / 空态行的 colspan：必须等于**实际渲染的列数**（含选择列与操作列），
   *  写死 11 会在用户收起列之后错位。 */
  const colCount = computed(() => 2 + SITE_COLS.filter((c) => shown(c.id)).length)

  // `narrow` 一并交出去：它是「窄屏强制收起次要列」的同一个判断源，视图里是否有
  // 「列选择器」/ 表格是否压 `minWidth` 都得跟着它走——各读一份就会漂移。
  return { narrow, hiddenCols, rawShown, toggleCol, resetCols, shown, elasticId, tableMinW, colCount }
}
