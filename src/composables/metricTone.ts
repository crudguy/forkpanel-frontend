/**
 * 指标卡 tone：**类型与阈值刻度的单一事实源**（评估报告 B5 收尾）。
 *
 * 为什么抽出来：`MetricCard`（tone→颜色的实现）与 `MetricItem`（tone 的类型约束）
 * 此前各写一份联合类型，且 `MetricItem` 多列了一个从未实现的 `'cpu'`——传进去会
 * 静默落到「无匹配类名 → 基础样式」，即本项目高发的「契约层有、实现层丢」。
 * 现在两端 import 同一份，杜绝再次漂移（与「同约束必抽公共函数两路共用」同纪律）。
 *
 * 配色原则（B5）：品牌橙 `primary` 只作**状态/操作色**（主操作/强调）；
 * 普通数据项正常态一律中性/冷色，橙 `hot` 只留给偏热（≥60%），红 `danger`
 * 留给危险（≥85%）——与图表柱/线同阈值、同 token（`--chart-*`）。
 */
export type MetricTone =
  | 'primary'  // 品牌橙：显式「主操作/强调」语义；数据卡正常态不再默认用它
  | 'cyan'     // 冷色数据项（内存等），= --c-cyan
  | 'ok'       // 绿：正常/通过/磁盘，= --c-ok
  | 'warn'     // 琥珀：真实告警，= --c-warn
  | 'danger'   // 红：危险（≥85%），= --c-danger
  | 'hot'      // 橙：偏热（≥60%），= --chart-hot（「橙只留给 hot」）
  | 'cpu'      // 中性灰：CPU 等无专属色的数据系列，= --chart-cpu
  | 'load'     // 紫：负载系列，= --chart-load
  | 'neutral'  // 中性 UI 灰：非数据项计数（如「不适用」），= --c-text-dim

/** 占用率（%）→ tone：<60 中性灰 / ≥60 hot / ≥85 danger。
 *  与图表柱（ProfessionalView `coreColor`）同一套阈值，头部卡与图表不会各说各话。 */
export function cpuTone(pct?: number | null): MetricTone {
  const v = pct ?? 0
  return v >= 85 ? 'danger' : v >= 60 ? 'hot' : 'cpu'
}
