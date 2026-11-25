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
  '/': 'CPU、内存、磁盘、负载与网络的实时总览。',
  '/system': '实时曲线、磁盘占用、性能快照与进程管理。',
  '/services': '系统软件与服务的安装、启停、日志和配置。',
  '/apps': '托管应用的运行与域名绑定，绑定后即可通过域名访问。',
  '/sites': '创建网站：静态、反向代理、PHP 与跳转。',
  '/waf': '为每个站点设置访问防护与频率限制。',
  '/certs': 'HTTPS 证书的申请、续期与信任管理。',
  '/databases': '数据库连接、数据浏览与备份。',
  '/containers': '容器、镜像与编排项目的管理。',
  '/backups': '备份计划、手动备份与数据恢复。',
  '/files': '在线浏览、编辑、上传与下载文件。',
  '/firewall': '端口放行与入侵防护规则，修改后需应用生效。',
  '/expose': '通过域名与 HTTPS 将服务安全地开放到公网。',
  '/logs': '系统日志与操作记录，支持过滤与实时跟随。',
  '/cron': '定时任务与后台任务中心，可查看执行进度。',
  '/terminal': '内置终端，可直接在服务器执行命令，属高危操作。',
  '/assistant': '基于系统现状给出诊断建议，不自动执行。',
  '/users': '面板账号、角色与权限管理。',
  '/dirs': '面板、数据、日志与 Web 服务器的实际落点，均来自运行时配置。',
  '/settings': '面板设置、运行状态与系统自检。',
  '/help': '常用操作、模块说明与常见问题（即本页）。',
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
  { to: '/sites', title: '上线一个网站', desc: '选择网站类型并绑定域名，即可通过域名访问。' },
  { to: '/certs', title: '给站点配 HTTPS', desc: '申请证书并自动续期；用自签证书时需先信任根证书。' },
  { to: '/firewall', title: '放行或关闭端口', desc: '修改规则后需点「应用」生效，注意别挡住自己的连接。' },
  { to: '/cron', title: '定时执行任务', desc: '按设定的时间周期自动执行备份、清理或脚本。' },
  { to: '/backups', title: '建立备份计划', desc: '设定周期与保留份数，改配置前可先手动备份。' },
  { to: '/logs', title: '排查故障', desc: '先看系统日志定位时间，再看操作记录确认改动。' },
  { to: '/files', title: '改配置或传文件', desc: '用内置编辑器直接修改文本文件，改前先备份。' },
  { to: '/containers', title: '用编排跑服务', desc: '按项目启动、停止或重启服务，停止不会删除数据卷。' },
  { to: '/dirs', title: '查面板装在哪 / 数据在哪', desc: '查看面板、数据、日志与 Web 服务器的实际落点，排障或迁移前先确认。' },
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
  whyDisabledForPath?: (to: string) => string | null,
): Array<QuickTask & { icon: string }> {
  return QUICK_TASKS.flatMap((t) => {
    const nav = NAV_ITEMS.find((n) => n.to === t.to)
    // 找不到对应导航项属于内容错误，测试会拦；运行期直接跳过，不渲染死链接。
    if (!nav) return []
    // 权限点允许写成数组（有任一即可，见 NavDef）。数组形没法塞进「单权限」签名里，
    // 交给侧栏同一判据 whyDisabledForPath（HelpView 传 auth→navPolicy 那个）。
    // 没传（纯函数测试里）时退化为逐项判：任一通过即可。
    if (Array.isArray(nav.perm)) {
      const blocked = whyDisabledForPath
        ? whyDisabledForPath(nav.to)
        : (nav.perm.every((p) => whyDisabled(nav.cap, p) !== null) ? '权限不足' : null)
      if (blocked) return []
    } else if (whyDisabled(nav.cap, nav.perm)) return []
    return [{ ...t, icon: nav.icon }]
  })
}

/** 常见问题：答案只写在面板里能验证的事实，不写"请联系厂商"之类的空话。 */
export const FAQS: FaqItem[] = [
  {
    q: '为什么某个菜单是灰色的？',
    a: '两种原因：账号缺少对应权限，需管理员分配；或本机未安装所需组件。鼠标悬停可查看具体原因。',
  },
  {
    q: '提示「当前环境不支持」是什么意思？',
    a: '该功能所需的组件尚未就绪，例如未安装 Web 服务器或容器服务。按菜单提示处理后刷新即可。',
  },
  {
    q: '忘记管理员密码怎么办？',
    a: '在服务器执行 panel passwd 用户名 重置。界面不提供绕过密码的入口。',
  },
  {
    q: '支持 Windows 或 macOS 服务器吗？',
    a: '仅支持 Linux。面板依赖系统自带的服务、防火墙与计划任务等能力，其他系统无法安装。',
  },
  {
    q: '怎么升级或卸载面板？',
    a: '升级在「设置」页检查执行，建议先备份。卸载需在服务器上通过命令完成，界面不提供入口以免误删数据。',
  },
]
