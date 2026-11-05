/**
 * SSL 门禁判据：**唯一来源**（纯函数，不碰 store / 不碰 Vue，可直接单测）。
 *
 * 为什么单独成文件：这条规则同时被三处查——站点表单（`useSiteCaps`）、证书页
 * （`CertsView`）、以及将来的建站向导。此前 `CertsView` 与 `useSiteCaps` 各写一份
 * computed，三个分支的文案逐字相同——看着无害，实际是「同一条规则两个副本」：
 * 将来改口径（比如给 caddy 补上 DNS-01 渠道）只需改一处，漏一处就表现为
 * 「证书页说能签、站点表单里却是灰的」这类最难查的分叉。
 *
 * 口径（与后端一致，别混）：
 * - **RBAC 权限点**（`auth.can`，角色维度）：`ssl.manage` 归它管。
 * - **平台能力位**（`auth.supported`，环境维度）：底座能否加载证书、有没有签发渠道。
 *
 * ⚠ 只在 `useSiteCaps` / `CertsView` 里做接线，判据本身不要再复制一份。
 */

/** 判定 SSL 可用性所需的四项事实，由调用方从 store 取。 */
export interface SslFacts {
  /** 平台能力位 `sslvhost.manage`：底座（nginx/caddy）能否加载并下发证书 */
  webSupported: boolean
  /** 签发渠道之一：ACME（`ssl.acme`） */
  sslSupported: boolean
  /** 签发渠道之二：自签（`ssl.selfsigned`） */
  selfSignedSupported: boolean
  /** RBAC 权限点 `ssl.manage` */
  canSsl: boolean
}

/**
 * SSL 真正可用 = 底座就绪 + 至少一条签发渠道 + 有权限。
 * `hint` 是给**置灰态** tooltip 的原因文案，顺序即优先级：权限 → 底座 → 渠道。
 */
export function sslGate(f: SslFacts): { ready: boolean; hint: string } {
  const ready = f.webSupported && (f.sslSupported || f.selfSignedSupported) && f.canSsl
  if (!f.canSsl) return { ready, hint: '无 ssl.manage 权限' }
  if (!f.webSupported) {
    return { ready, hint: '需先安装并启动 Web 服务器（nginx / caddy）——证书没有进程可加载' }
  }
  return { ready, hint: '需 openssl 或 ACME' }
}
