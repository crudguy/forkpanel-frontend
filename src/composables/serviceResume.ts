import { api } from '@/api/client'
import { API } from '@/api/endpoints'

/**
 * 「等面板/机器恢复，然后刷新页面」——升级、重装、重启面板、重启系统四处共用。
 *
 * 四处的等待骨架完全一样：
 *   睡 `intervalMs` → 探一次 `/version` → 判断够不够格刷新 → 到点还没好就提示用户
 * 差异只有三处：**多久探一次**、**什么算恢复**、**超时了复位什么**。此前顶栏
 * （`TopbarMaintenance.vue`）与设置页（`SettingsView.vue`）各写一份，其中
 * `waitForUpgrade` 两份逐字相同、`waitForRestart` 两份逐字相同——改一处漏一处就是
 * 两边行为分叉，而这种分叉只在"刚好在另一页操作"时才看得见，极难发现。
 *
 * 恢复判据刻意写成三种**具名**形态，而不是压成一个布尔开关——它们回答的是三个不同
 * 的问题，混成一个参数后没人能说清"为什么这里要版本号变、那里只要应答"：
 *
 * - `any-response`   重启面板：单元是 `Type=simple`，进程一换立刻应答。能应答就是好了。
 * - `after-down`     重启系统：整机重启**必然**先断连。若从头到尾没断过连，说明 reboot
 *                    根本没生效（无权限 / 被 polkit 拦），此时"能应答"根本不能当恢复
 *                    的证据——必须先见过断连，之后的应答才算数。
 * - `version-changed` 升级/重装：要同时容忍两种竞态——①新二进制已落盘但旧进程还没被杀，
 *                    旧进程应答的是**旧版本号**；②进程很快重启完，探测时既没抓到断连、
 *                    版本也已经变了。故判据是 `见过断连 || 版本号变了`。
 */

/** 恢复判据。三形态各有明确适用场景，见文件头。 */
export type ResumeRule =
  | { kind: 'any-response' }
  | { kind: 'after-down' }
  /** `from` 必须与 `GET /version` 返回的 `app` 同格式（不带 `v` 前缀，见 fetchAppVersion）。 */
  | { kind: 'version-changed'; from: string }

/** 探测结果够不够格刷新页面。纯函数：不碰 DOM、不看时间，决策表可直接穷举断言。 */
export function isRecovered(rule: ResumeRule, app: string, sawDown: boolean): boolean {
  if (rule.kind === 'any-response') return true
  if (rule.kind === 'after-down') return sawDown
  return sawDown || app !== rule.from
}

/**
 * `GET /version` → 面板版本号（不带 `v` 前缀，与后端 `CARGO_PKG_VERSION` 同格式）。
 * 取不到会照常抛错：调用方按"服务还没起来"处理。
 */
export async function fetchAppVersion(): Promise<string> {
  const v = await api.get<{ app: string }>(API.version())
  return v?.app ?? ''
}

export interface RecoveryOptions {
  /** 探测服务是否已恢复。**抛错 = 仍不可用**（先退后起期间连接被切断是预期行为）。 */
  probe: () => Promise<string>
  rule: ResumeRule
  /** 两次探测之间的间隔。 */
  intervalMs: number
  /**
   * 总超时。按**总时长**计，不是按探测次数：探测本身卡住时（TCP 超时）也能保证用户
   * 在这么多秒内拿到结论，不会"次数 × 单次超时"叠加成十几分钟。
   */
  timeoutMs: number
  /** 超时仍未恢复：调用方复位自己的 loading 态并给出可执行的排查指令。 */
  onTimeout: () => void
  /** 恢复后执行的刷新动作；生产不传（默认 reload），测试注入以便断言。 */
  onReload?: () => void
}

/**
 * 轮询等到服务恢复后刷新页面；超时则交回 `onTimeout`（不刷新、不抛错）。
 *
 * 刷新后立即返回——页面正在卸载，调用方后续语句不应再执行。
 */
export async function waitForRecovery(opts: RecoveryOptions): Promise<void> {
  const reload = opts.onReload ?? (() => { location.reload() })
  let sawDown = false
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.intervalMs))
    try {
      const app = await opts.probe()
      if (isRecovered(opts.rule, app, sawDown)) {
        reload()
        return
      }
    } catch {
      sawDown = true
    }
  }
  opts.onTimeout()
}
