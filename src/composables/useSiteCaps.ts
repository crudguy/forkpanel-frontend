/**
 * 站点页「能不能做」的判定：**单一来源**。
 *
 * 抽出来的直接原因是 SitesView 拆出弹窗子组件后，列表（父级）与弹窗（子组件）
 * 都要问同样的问题——若两边各写一份 computed，短期看着无害，实际是「同一条规则
 * 两个副本」：将来改门禁口径（比如给 caddy 补上某个能力）只需改一处，漏一处就
 * 表现为「列表能点、弹窗里却是灰的」这类最难查的分叉。
 *
 * 两条口径（与后端一致，别混）：
 * - **RBAC 权限点**（`auth.can`，角色维度）：数据模型的增删改归它管，owner/admin 恒有，
 *   与机器上装没装 nginx 无关。
 * - **平台能力位**（`auth.supported`，环境维度）：配置下发 / SSL 签发这类**要动外部
 *   进程**的动作归它管。没装底座时它恒为 false，此时按钮必须置灰并说明原因，
 *   绝不伪造成功。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'

export function useSiteCaps() {
  const auth = useAuthStore()

  // 数据模型 CRUD 仅看 RBAC 权限点（角色维度，与平台能力无关，owner/admin 恒有）
  const canManage = computed(() => auth.can('site.manage'))
  const canSsl = computed(() => auth.can('ssl.manage'))

  // 配置下发 / SSL 受平台能力位约束
  const webSupported = computed(() => auth.supported(CAP.WEBSERVER_MANAGE))
  /** 当前 Web 服务器后端（`nginx` / `caddy` / null）。caddy 下**部分字段照常可填、渲染器却不产出**，
   *  必须置灰并说明原因——项目纪律：绝不提供「能填但不生效」的假控件。 */
  const webBackend = computed(() => auth.backend(CAP.WEBSERVER_MANAGE))
  const isCaddy = computed(() => webSupported.value && webBackend.value === 'caddy')
  /** 后端名（文案用；未接入时为通称） */
  const webName = computed(() => webBackend.value ?? 'Web 服务器')
  /** caddy 未实装项的统一 tooltip：说清「为什么灰」，而不是让用户自己猜 */
  const caddyNoop = '当前 Web 服务器为 Caddy：此项目前未实装，已置灰（填了也不会写进配置）'

  const sslSupported = computed(() => auth.supported(CAP.SSL_ACME))
  const selfSignedSupported = computed(() => auth.supported(CAP.SSL_SELFSIGNED))
  // SSL 需基础设施齐备：① 底座（nginx）能加载证书 ② 签发渠道（自签/ACME）③ 权限
  const sslReady = computed(() => webSupported.value && (sslSupported.value || selfSignedSupported.value) && canSsl.value)
  const sslHint = computed(() => {
    if (!canSsl.value) return '无 ssl.manage 权限'
    if (!webSupported.value) return '需先安装并启动 Web 服务器（nginx / caddy）——证书没有进程可加载'
    return '需 openssl 或 ACME'
  })
  const canReload = computed(() => webSupported.value && canManage.value)
  // 建站与配置下发同源：没有底座就不许建（后端 create 亦 501，前端只是提前挡住并说明原因）
  const canCreate = computed(() => webSupported.value && canManage.value)
  const createHint = computed(() => {
    if (!canManage.value) return '无 site.manage 权限'
    return webSupported.value ? '' : '需先安装并启动 Web 服务器（nginx / caddy）——否则站点建了也无法访问'
  })

  /** 原始配置编辑仅 owner 可保存（后端 403 同口径）；管理员可看不可写。 */
  const isOwner = computed(() => auth.me?.role === 'owner')

  return {
    canManage, canSsl, webSupported, webBackend, isCaddy, webName, caddyNoop,
    sslSupported, selfSignedSupported, sslReady, sslHint, canReload, canCreate, createHint,
    isOwner,
  }
}
