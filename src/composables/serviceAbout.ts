/**
 * 服务的「说明」区文案装配（服务详情页用）。
 *
 * 为什么单独一个模块：这段逻辑原本会写在 `ServiceDetailView.vue` 的模板里——而
 * SFC 里的函数**测不了**（vitest 只收 `src/**\/*.test.ts`，且本项目没装 vue 插件），
 * 结果就是「注释里写着的判定规则」永远只是承诺。抽出来后每条规则都有测试钉住。
 *
 * 要解决的现实问题：本机的服务**绝大多数不是面板装的**（accounts-daemon、cron、
 * systemd-resolved…）。它们的 `description` 是 systemd 单元的 Description 字段，
 * 常见三种形态：
 *   1) 有一句正常英文描述（"Regular background program processing daemon"）
 *   2) 空串 / null（单元没写 Description）
 *   3) 占位噪声（"LSB: ..."、"LSB: 启动/停止系统"、"Description"）
 * 直接把它当"说明"整段展示，用户得到的是一行看不懂的英文、或一行毫无意义的 LSB 前缀。
 * 所以这里做三件事：剔除噪声 → 判断"像不像一句真描述" → 给出可读的回退文案。
 */

/** 判定为噪声的 Description（大小写不敏感，去空白后比对前缀）。 */
const NOISE_PREFIXES = ['lsb:', 'lsb ', 'description', 'n/a', 'none', 'unknown']

/** 展示用：去掉首尾空白、把内部连续空白压成单个空格（systemd 里偶有换行/多空格）。 */
export function normalizeDescription(raw?: string | null): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Description 只是把单元名抄了一遍吗？
 *
 * 实测本机 `firewalld.service` 的 Description 就是字面量 `dead firewalld.service`——
 * 有些打包把「状态 + 单元名」塞进 Description 当占位。这种串对用户零信息量，
 * 展示出来反而像页面出了故障（为什么"说明"里写着 dead xxx.service？）。
 * 判据：去掉状态词与扩展名后，剩下的与单元名主干相同即判噪声。
 */
const STATE_WORDS = ['dead', 'running', 'exited', 'failed', 'inactive', 'active']

export function isUnitNameRestatement(raw: string | null | undefined, unitName: string): boolean {
  const desc = normalizeDescription(raw).toLowerCase()
  const unit = unitName.toLowerCase().replace(/\.(service|socket|timer|target|mount)$/, '')
  if (!desc || !unit) return false
  // 去掉状态词与标点后，看描述里是否只剩单元名本身
  let rest = desc
  for (const w of STATE_WORDS) rest = rest.split(w).join(' ')
  rest = rest.replace(/[^a-z0-9@._-]+/g, ' ').trim()
  // 描述里除单元名外没有别的词 → 视为复述
  return rest === unit || rest === `${unit}.service`
}


/**
 * 这串 Description 是否值得展示（不是空、不是 LSB 之类占位、不是把单元名抄一遍）。
 *
 * `unitName` 可选：给了才能识别"复述单元名"这一类占位（实测 firewalld）。
 * 老调用点只传 description 也仍然安全（退化为只看前缀噪声）。
 */
export function isMeaningfulDescription(
  raw?: string | null, unitName?: string,
): boolean {
  const s = normalizeDescription(raw)
  if (!s) return false
  const low = s.toLowerCase()
  if (NOISE_PREFIXES.some(p => low.startsWith(p))) return false
  if (unitName && isUnitNameRestatement(s, unitName)) return false
  return true
}

/**
 * 该单元是否看起来像一个"软件"（而非内核/桌面/发行版内部组件）。
 *
 * **当前无调用方**，仅保留实现与其测试以便追溯。历史用途：详情页只在"像软件"的单元上
 * 显示「去『软件』页点 ?」的跳转，避免系统组件点了落到查不到说明的页面。
 *
 * 为什么现在不用了：那套判据是**猜的**（按单元名黑名单），而真实依据早就有——后端
 * catalog 里的 `units` 字段写明「哪个包对应哪些单元」，反查命中就是软件、没命中就不是。
 * 用黑名单猜比用真数据查更容易出错（漏列一个系统单元就会给用户一个点了没结果的入口），
 * 所以详情页改为按 `units` 精确反查（见 composables/pkgUnitLookup.ts）。
 *
 * 保留而不删的理由：它自己的测试钉住了"哪些单元不该被当成软件"这一知识，将来若需要
 * 在别处做粗筛（比如列表页提前折叠），这份名单仍可复用到——但那时请先想清楚
 * 能不能直接用 `units` 反查，而不是重新捡起这套猜测。
 */
const SYSTEM_UNIT_HINTS = [
  'systemd-', 'dbus', 'polkit', 'accounts-daemon', 'cron', 'rsyslog',
  'getty', 'ssh.socket', 'user@', 'session-', 'modprobe', 'udev',
]

export function looksLikeAppUnit(unit: string): boolean {
  const n = unit.replace(/\.(service|socket|timer|target)$/, '').toLowerCase()
  if (!n) return false
  return !SYSTEM_UNIT_HINTS.some(h => n.includes(h))
}

/**
 * 详情页「说明」区的最终展示模型。
 *
 * @param description systemd 单元的 Description
 * @param unitName    完整单元名（仅用于回退文案，不含任何实现细节）
 */
export function serviceAbout(description: string | null | undefined, unitName: string) {
  const cleaned = normalizeDescription(description)
  const meaningful = isMeaningfulDescription(description, unitName)
  // 有真描述 → 用它；没有 → **明确说没有**，而不是留空或显示 "null"。
  // 回退文案里带上单元名，用户至少知道自己在看哪个单元（本机多数服务面板没有文案）。
  const text = meaningful ? cleaned : '该系统单元未提供描述信息。'
  return {
    /** 主文案（永远非空） */
    text,
    /** 是否来自 systemd（是 → UI 可标注"取自 systemd 单元描述"） */
    fromSystemd: meaningful,
    /** 尾部提示：面板没有这个单元的人工说明时给出下一步该看什么 */
    hint: meaningful
      ? ''
      : `「${unitName}」不是面板托管的软件，面板没有它的用途说明。你仍可以在这里启停、看日志、改配置。`,
  }
}
