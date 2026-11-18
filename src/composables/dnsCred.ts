/**
 * dns-01 证书签发的纯逻辑（P2-10 前端配套）。
 *
 * 单拎成 `.ts` 的理由与 `sshPort.ts` 相同：`vitest.config.ts` 的 include 只收
 * `src/** /*.test.ts`，住在 `.vue` 里的判断逻辑一行都测不到。而这里的三条判断
 * （能不能提交、该显示什么提示、提示里要不要含"先去配凭据"）恰恰是用户唯一
 * 能看到的引导——写错了界面会给出「点了申请没反应」或「让你去做已经做过的事」。
 *
 * # 本模块不含任何网络请求
 * 只做「给定凭据列表 + 输入值 → 得出 UI 结论」，便于穷举边界。
 */

/** dns-01 用到的凭据（与 openapi `DnsCredential` 对齐，此处只取前端要用的字段） */
export interface DnsCred {
  id: number
  provider: string
  /** 展示名由后端给（`provider_label`）——前端不自己维护映射，否则两边文案会不一致 */
  provider_label: string
  label: string
  secret_masked: string
  zone_hint: string
  /** false = 库里密文解不开（主密钥换过），必须重填 */
  usable: boolean
  last_check_at: number
  last_check_ok: boolean
  last_check_msg: string
  created_at: number
  updated_at: number
}

/** 目前支持的 DNS 提供商。与后端 `PROVIDER_CLOUDFLARE` 同一份事实（留数组便于后续扩展）。 */
export const DNS_PROVIDERS = ['cloudflare'] as const
export type DnsProvider = (typeof DNS_PROVIDERS)[number]

export function providerLabel(p: string): string {
  switch (p) {
    case 'cloudflare':
      return 'Cloudflare'
    default:
      return p
  }
}

/**
 * 可选凭据判定：**只有 `usable` 的才能用来签发**。
 *
 * `usable=false` 意味着密文解不开（典型：主密钥被更换）。若把它也列进可选项，
 * 用户会选中它、提交、然后收到一个和"凭据"两个字看不出关系的报错。
 */
export function selectableCreds(creds: DnsCred[]): DnsCred[] {
  return creds.filter((c) => c.usable)
}

/**
 * dns-01 是否具备提交条件，以及缺什么。
 *
 * 返回 `ok=false` 时 `reason` 必须直接可显示——它是用户在弹窗里唯一的线索。
 * 三种缺失的处置完全不同，所以必须分开说：
 * - 一张凭据都没配 → 让他先去配（这是配置问题，不是填错）
 * - 配了但都解不开 → 让他重填 token（不是"没配"，重配一遍没用）
 * - 选中的凭据不可用 → 明确指出是哪一条
 */
export function dns01Gate(
  creds: DnsCred[],
  provider: string | null,
): { ok: boolean; reason: string; resolved: string } {
  const usable = selectableCreds(creds)
  if (creds.length === 0) {
    return {
      ok: false,
      reason: '还没有配置任何 DNS 提供商凭据。dns-01 需要凭据才能写入验证记录，请先在下方「DNS 凭据」里添加',
      resolved: '',
    }
  }
  if (usable.length === 0) {
    return {
      ok: false,
      reason: '已存的 DNS 凭据无法解密（通常是主密钥被更换过），请重新填写 API Token',
      resolved: '',
    }
  }
  const p = (provider ?? '').trim()
  if (!p) {
    // 只有一家时自动选中它——让用户在一个单选项上做选择纯属多余
    if (usable.length === 1) return { ok: true, reason: '', resolved: usable[0].provider }
    return {
      ok: false,
      reason: `有 ${usable.length} 家 DNS 凭据可用，请指定本次用哪一家`,
      resolved: '',
    }
  }
  const hit = usable.find((c) => c.provider === p)
  if (!hit) {
    return {
      ok: false,
      reason: `所选提供商「${providerLabel(p)}」没有可用凭据，请先配置或改选其它提供商`,
      resolved: '',
    }
  }
  return { ok: true, reason: '', resolved: hit.provider }
}

/**
 * dns-01 的说明文案（写在单选项下方那行灰字里）。
 *
 * 必须讲清它和 http-01 的**差别**（不要求 80 可达），否则用户在内网机上会以为
 * 两个选项都一样，随便选一个然后失败。
 */
export function dns01Hint(): string {
  return 'ACME dns-01：用 DNS TXT 记录证明域名归属，**不要求本机 80 端口可达**（内网机/只开 443 时唯一可行）；需先在下方配置 DNS API Token'
}

/** 凭据校验结论 → 一行可读状态。 */
export function credCheckText(c: DnsCred): string {
  if (!c.usable) return '无法解密，请重填 Token'
  if (!c.last_check_at) return '尚未校验'
  return c.last_check_ok ? '上次校验通过' : `上次校验失败：${c.last_check_msg || '原因未记录'}`
}

/**
 * 校验状态徽章的语义分类。返回 `main.css` 里 `badge-*` 的档位名。
 *
 * 刻意不返回颜色值：状态色的唯一事实源是 `main.css` 的 `badge-ok/warn/err`，
 * 视图里写死颜色就会与全站其它页面不一致。
 */
export function credBadge(c: DnsCred): 'ok' | 'warn' | 'err' {
  if (!c.usable) return 'err'
  if (!c.last_check_at) return 'warn'
  return c.last_check_ok ? 'ok' : 'err'
}

/** 凭据表单校验：返回错误文案（空串 = 通过）。 */
export function validateCredInput(provider: string, secret: string, isNew: boolean): string {
  if (!DNS_PROVIDERS.includes(provider as DnsProvider)) {
    return `不支持的 DNS 提供商「${provider}」`
  }
  const s = secret.trim()
  if (s === '') {
    // 编辑态留空是合法的"保持原值"——这条不能和"首次必填"混为一谈，
    // 否则用户改个备注名都会被拦住。
    return isNew ? '首次添加必须填写 API Token' : ''
  }
  // Cloudflare Token 是 40 位左右的字母数字加 - _。只挡明显不可能的值（含空格、
  // 中文、URL），不按长度硬卡——各家 token 长度会变，卡死了会把合法 token 拦掉。
  if (/[\s\u4e00-\u9fa5]/.test(s)) {
    return 'API Token 不应包含空格或中文，请检查是否复制错了内容'
  }
  if (/^https?:\/\//i.test(s)) {
    return '这里要填 API Token 本身，不是 Cloudflare 后台的网址'
  }
  return ''
}

/**
 * 剥掉后端错误串里的**内部包装前缀**。
 *
 * 背景：`PanelError::Validation` 的 `Display` 是 `invalid input: {field}: {reason}`，
 * 而 provider 侧会把它 `format!("{e}")` 再包一层塞进新的 `reason`，于是用户看到
 * `invalid input: token: invalid input: dns: 校验 API Token 失败：…`——三重内部前缀，
 * 真正的原因被埋到最后。
 *
 * 这是**后端**该修的事，但用户不该为此等到下次后端改动：本函数只做纯字符串清洗，
 * 不动任何语义，剥完如果为空就回落到原串（不允许因为清洗把错误信息弄没）。
 */
export function stripErrorWrappers(msg: string): string {
  let s = msg.trim()
  // 反复剥：一层剥完可能还有一层（实测就是两层）
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/^invalid input:\s*[A-Za-z_][A-Za-z0-9_]*:\s*/i, '')
    if (next === s) break
    s = next.trim()
  }
  return s === '' ? msg : s
}
