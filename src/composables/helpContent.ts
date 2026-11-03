/**
 * 帮助中心的内容（纯数据 + 纯函数）。
 *
 * 为什么单独成 `.ts`：vitest 只收 `src/**\/*.test.ts` 且没有 vue 插件，纯数据住在
 * `.vue` 里就只能靠肉眼核对。内容一旦与真实功能漂移（菜单改名了、路由换了），
 * 页面不会报错，只会**理直气壮地说错话**——比没有帮助页更糟。
 *
 * 单一事实源口径：
 * - 「模块速览」的**标签 / 图标 / 顺序**全部取自 `navItems.ts`，本文件只维护一句说明，
 *   键为路由 path。新增/删除菜单时，`helpContent.test.ts` 会因「有菜单没说明」或
 *   「有说明没菜单」变红，不必靠人记得来改这里。
 * - 「常用操作」只记 `to + 标题 + 描述`，能力位与权限点同样回查 `navItems`，
 *   避免同一路由在两处各写一份 cap/perm 然后漂移。
 */
import { NAV_ITEMS } from './navItems'

export interface ModuleDoc {
  to: string
  label: string
  icon: string
  desc: string
}

export interface QuickTask {
  to: string
  title: string
  desc: string
}

export interface FaqItem {
  q: string
  a: string
}

/**
 * 每个菜单一句说明（键 = `navItems.ts` 的 `to`）。
 *
 * 文案纪律：只写**页面里真有的东西**，不写"规划中"的能力。能力位不支持的模块
 * 由侧边栏置灰并给出原因，帮助页不重复判定，也绝不承诺"即将支持"。
 */
const MODULE_DESC: Record<string, string> = {
  '/': '资源占用与运行状态总览：CPU / 内存 / 磁盘 / 负载 / 网络。',
  '/system': '实时趋势、目录占用、专业快照与进程管理。',
  '/services': '系统软件包与 systemd 服务：启停、日志、配置。',
  '/apps': '面板托管的进程：绑定域名后自动反向代理，构建请自行完成。',
  '/sites': '站点管理：静态、反向代理、PHP、整站重定向。',
  '/waf': '各站点防护档位与 CC 限速，随 nginx 配置一同下发。',
  '/certs': '证书总览、申请、续期与根证书信任。',
  '/databases': '连接管理、只读浏览与备份任务。',
  '/containers': 'Docker 容器、镜像与 Compose 项目编排。',
  '/backups': '本地备份计划、手动执行与产物列表（含从产物恢复）。',
  '/files': '在线文件管理：浏览、编辑、上传、下载。',
  '/firewall': '端口放行规则与入侵防御（fail2ban），改动需应用后下发。',
  '/expose': '域名反代 + 防火墙白名单 + TLS 向导，把服务安全地开放到公网。',
  '/logs': '系统日志与操作审计，支持字面量过滤与实时跟随。',
  '/cron': '平台原生计划任务，以及后台任务中心（含执行进度）。',
  '/terminal': '内置 Web 终端（宿主级 shell）——高危操作面，用完请登出。',
  '/assistant': '内置规则诊断，基于真实系统数据，只给建议、不自动执行。',
  '/users': '面板账号、角色与权限点（RBAC）。',
  '/settings': '面板配置、能力矩阵与系统自检。',
  '/help': '常用指引、模块说明与排障入口（即本页）。',
}

/** 模块速览：标签与图标直接复用导航项，不在此重复维护。 */
export const MODULE_DOCS: ModuleDoc[] = NAV_ITEMS.map((n) => ({
  to: n.to,
  label: n.label,
  icon: n.icon,
  desc: MODULE_DESC[n.to] ?? '',
}))

/**
 * 常用操作：新手最常问的「这件事到底在哪做」。
 *
 * 只放**确实有对应页面**的条目（测试会校验 `to` 必须存在于导航项），
 * 描述里写清前置条件与后果，避免"点进去才发现要先做别的"。
 */
export const QUICK_TASKS: QuickTask[] = [
  { to: '/sites', title: '上线一个网站', desc: '选运行方式（静态 / 反代 / PHP / 重定向），绑定域名后即可访问。' },
  { to: '/certs', title: '给站点配 HTTPS', desc: '申请证书并自动续期；用面板自签证书时，先在本机信任根证书。' },
  { to: '/firewall', title: '放行或关闭端口', desc: '规则改完要「应用」才下发；先确认不会把自己的连接挡掉。' },
  { to: '/cron', title: '定时执行任务', desc: '备份、清理、脚本都可按 cron 表达式周期执行，表达式由后端校验。' },
  { to: '/backups', title: '建立备份计划', desc: '设定周期与保留份数，改关键配置前可先手动跑一次以便回滚。' },
  { to: '/logs', title: '排查故障', desc: '先用系统日志定位时间点，再用审计日志确认那段时间谁改了什么。' },
  { to: '/files', title: '改配置或传文件', desc: '内置编辑器可直接改文本文件；改前先复制一份，便于对比回退。' },
  { to: '/containers', title: '用 Compose 跑服务', desc: '项目级 up / stop / restart / down；down 不会删除命名卷。' },
]

/**
 * 按当前权限/能力过滤常用操作。
 *
 * 为什么是「过滤」而不是「置灰」：这是**快捷入口**，不是导航清单——把用户
 * 永远进不去的入口摆一排灰按钮，只会让人以为是故障；模块本身在侧边栏仍在
 * （置灰 + 悬停给出原因），想查"为什么进不去"去那里看。
 *
 * `whyDisabled` 由调用方传入（组件里是 `auth.whyDisabled`），这样这段选择逻辑
 * 是纯函数，能直接测「全可用 / 全不可用 / 部分可用」三条分支。
 */
export function pickQuickTasks(
  whyDisabled: (cap: string, perm: string) => string | null,
): Array<QuickTask & { icon: string }> {
  return QUICK_TASKS.flatMap((t) => {
    const nav = NAV_ITEMS.find((n) => n.to === t.to)
    // 找不到对应导航项属于内容错误，测试会拦；运行期直接跳过，不渲染死链接。
    if (!nav) return []
    if (whyDisabled(nav.cap, nav.perm)) return []
    return [{ ...t, icon: nav.icon }]
  })
}

/** 常见问题：答案只写在面板里能验证的事实，不写"请联系厂商"之类的空话。 */
export const FAQS: FaqItem[] = [
  {
    q: '为什么某个菜单是灰色的？',
    a: '两种原因：一是当前角色缺少对应权限点（RBAC），需要管理员分配；二是这台机器缺少该功能依赖的组件。鼠标悬停在菜单上会显示具体原因，不会只给一个灰按钮。',
  },
  {
    q: '提示「当前环境不支持」是什么意思？',
    a: '该模块依赖的底层组件尚未就绪，例如未安装 nginx、Docker 守护进程不可达、未检测到数据库引擎。菜单提示里会带可执行的归因（如 need_nginx、non_root），按提示处理后刷新页面即可。',
  },
  {
    q: '怎样快速跳到某个页面？',
    a: '按 ⌘K（macOS 浏览器）或 Ctrl+K（Windows / Linux 浏览器）打开命令面板，输入关键词即可搜索并直达任意模块，不必在侧边栏逐级找。Esc 关闭面板。',
  },
  {
    q: '忘记管理员密码怎么办？',
    a: '在服务器上以 root 执行 panel passwd <用户名> 重置（登录页底部也有这条提示）。出于安全考虑，Web 界面不提供任何绕过密码的重置入口。',
  },
  {
    q: '支持 Windows 或 macOS 服务器吗？',
    a: '仅支持 Linux。面板的软件包、服务、防火墙、计划任务等能力直接建立在 systemd、nginx、nftables / iptables、cron 之上，其他系统没有这些底座，无法安装。',
  },
  {
    q: '怎么升级或卸载面板？',
    a: '升级在「设置」页检查更新并执行，升级前建议先做一次备份。卸载属于高危操作，只提供服务器上的 root 命令行入口，Web 界面刻意不提供——避免误点造成不可逆的数据删除。',
  },
]
