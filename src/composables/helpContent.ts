/**
 * 帮助中心的内容（纯数据 + 纯函数）。
 *
 * 为什么单独成 `.ts`：vitest 只收 `src/**\/*.test.ts` 且没有 vue 插件，纯数据住在
 * `.vue` 里就只能靠肉眼核对。内容一旦与真实功能漂移（菜单改名了、路由换了、
 * 命令改参数了），页面不会报错，只会**理直气壮地说错话**——比没有帮助页更糟。
 *
 * 单一事实源口径：
 * - 「模块速览」的**标签 / 图标 / 顺序**全部取自 `navItems.ts`，本文件只维护说明，
 *   键为路由 path。新增/删除菜单时，`helpContent.test.ts` 会因「有菜单没说明」或
 *   「有说明没菜单」变红，不必靠人记得来改这里。
 * - 「常用操作」只记 `to + 标题 + 描述`，能力位与权限点同样回查 `navItems`。
 * - 「终端命令」的真实名称/参数/前置条件以 CLI 的 clap 定义为源头；这里的内容由
 *   `helpContent.test.ts` 钉住关键命令与高危提示在场，防止删改后悄悄失真。
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

/** 一条终端命令：用途 / 场景 / 参数 / 前置 / 注意，字段齐全才能独立完成任务。 */
export interface CliCommand {
  /** 完整写法，含必要参数占位，如 `panel backup --out <路径>` */
  cmd: string
  /** 一句话用途 */
  purpose: string
  /** 什么时候该用它 */
  when: string
  /** 关键参数（每项形如「--xxx：作用」）；无参数则留空数组 */
  params: string[]
  /** 权限、停机、组件等前置条件；无特殊前置写「无特殊前置」 */
  requires: string
  /** 注意事项与常见异常提示 */
  caution: string
  /** 高危操作：改完可能覆盖数据 / 影响整台服务器，界面上标红 */
  risk?: boolean
}

/** 终端命令按运维流程分组，便于「按想做的事」查到命令。 */
export interface CliGroup {
  title: string
  lead: string
  commands: CliCommand[]
}

/**
 * 每个菜单的说明（键 = `navItems.ts` 的 `to`）。
 *
 * 文案纪律：只写**页面里真有的东西**，不写"规划中"的能力。能力位不支持的模块
 * 由侧边栏置灰并给出原因，帮助页不重复判定，也绝不承诺"即将支持"。
 * 每条按「是什么 / 什么时候用 / 注意什么」写，避免只写名词让人仍不知道能干嘛。
 */
const MODULE_DESC: Record<string, string> = {
  '/': 'CPU、内存、磁盘、负载与网络的实时总览，用于快速判断服务器是否异常。排障时先看这里确认是整体负载还是单一资源告警。',
  '/system': '实时曲线、磁盘占用、性能快照与进程管理。定位 CPU 或内存长期偏高时，用曲线看趋势、用进程列表找占用者；结束进程前先确认它的用途。',
  '/services': '系统软件包与 systemd 软件的安装、启停、日志和配置。装软件、重启服务或查服务为什么起不来时在这里操作；「软件与服务」与「应用」是两套不同概念。',
  '/apps': '托管应用的运行与域名绑定，绑定后即可通过域名访问。适合把面板管理的进程对外提供访问；域名需先解析到本机。',
  '/sites': '创建网站：静态、反向代理、PHP 与跳转。新建站点先选类型并绑定域名，需要 HTTPS 时再到「证书」页申请。',
  '/waf': '为每个站点设置访问防护与频率限制。站点受骚扰或需限制访问来源时在此配置；规则生效范围以所选站点为单位。',
  '/certs': 'HTTPS 证书的申请、续期与信任管理。给站点启用 HTTPS 前先确认域名可解析；使用自签证书时需先把根证书加入信任。',
  '/databases': '数据库连接、数据浏览与备份。用于管理与站点配套的数据库；改动数据前建议先在「备份」页留一份。',
  '/containers': '容器、镜像与编排项目的管理。按项目启动、停止或重启服务；停止不会删除数据卷，编排文件里的具名卷需在顶层声明。',
  '/backups': '备份计划、手动备份与数据恢复。改重要配置前可先手动备份；恢复会覆盖现有数据，需输入确认词，面板自身的数据要在服务器上恢复。',
  '/files': '在线浏览、编辑、上传与下载文件。可直接修改文本文件，改配置前先备份一份，避免改错后服务起不来。',
  '/firewall': '端口放行与入侵防护规则，修改后需点「应用」生效。放行新服务端口时别关闭当前连接所用端口，否则会把自己挡在外面。',
  '/expose': '通过域名与 HTTPS 将服务安全地开放到公网。默认不暴露任何端口；撤销暴露只撤反代、面板仍绑回环，不等于卸载面板。',
  '/logs': '系统日志与操作记录，支持过滤与实时跟随。排障时先按时间找到报错，再用操作记录确认此前改过什么。',
  '/cron': '定时任务与后台任务中心，可查看执行进度。用于周期备份、清理或脚本执行；任务没跑先查启用状态与上次执行结果。',
  '/terminal': '内置终端，可直接在服务器执行命令，属高危操作。能用功能页面完成的就不要在终端手改；一条误命令可能影响整台服务器。',
  '/assistant': '基于系统现状给出诊断建议，不自动执行。把它当排障线索，执行前仍需自己确认建议是否适合当前环境。',
  '/users': '面板账号、角色与权限管理。按角色分配最小权限，日常巡检建议用只读账号；每位管理员使用独立账号便于回溯操作。',
  '/dirs': '面板、数据、日志与 Web 服务器的实际落点，均来自运行时配置。排障、手工备份或迁移前先在这里确认路径，不要凭默认路径猜测。',
  '/settings': '面板设置、运行状态与系统自检。改配置后先跑自检确认可用；升级前先备份，卸载本体需在服务器上用命令完成。',
  '/help': '常用操作、模块说明、终端命令与常见问题（即本页）。从侧边栏「帮助」随时返回，内容会随权限过滤，只显示当前账号可用的入口。',
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
 * ⚠ 前两条保持为 /sites、/certs：权限过滤测试用它们验证「只留 site.view」。
 */
export const QUICK_TASKS: QuickTask[] = [
  { to: '/sites', title: '上线一个网站', desc: '选网站类型并绑定域名即可通过域名访问；域名需先解析到本机，要 HTTPS 再配证书。' },
  { to: '/certs', title: '给站点配 HTTPS', desc: '申请证书并自动续期；用自签证书时需先信任根证书，否则浏览器仍会报不安全。' },
  { to: '/firewall', title: '放行或关闭端口', desc: '修改规则后需点「应用」生效；放行新服务端口时别关掉当前连接所用端口。' },
  { to: '/cron', title: '定时执行任务', desc: '按设定周期自动执行备份、清理或脚本；任务没跑先看启用状态和上次执行结果。' },
  { to: '/backups', title: '建立备份计划', desc: '设定周期与保留份数；改站点、防火墙等重要配置前可先手动备份以便回滚。' },
  { to: '/logs', title: '排查故障', desc: '先看系统日志按时间定位报错，再看操作记录确认此前改过什么。' },
  { to: '/files', title: '改配置或传文件', desc: '用内置编辑器直接修改文本文件；改前先备份，改错时还能退回原配置。' },
  { to: '/containers', title: '用编排跑服务', desc: '按项目启动、停止或重启服务；停止不会删除数据卷，具名卷须在编排文件顶层声明。' },
  { to: '/dirs', title: '查面板装在哪 / 数据在哪', desc: '查看面板、数据、日志与 Web 服务器的实际落点，排障或迁移前先确认，别猜默认路径。' },
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

/**
 * 终端命令的全局参数与裸跑行为。
 * 这些不是子命令，单独列出来避免读者以为 `--config` 只属于某一条命令。
 */
export const CLI_GLOBALS: string[] = [
  'panel —— 交互终端直接运行即进入配置菜单；脚本或管道里不带子命令会打印帮助并以非零码退出。',
  '--config <路径> —— 指定配置文件，省略时用安装布局的默认位置；面板实际装在别处时要显式给出。',
  '--tier <nano|small|standard|auto> —— 覆盖数据库资源档位，缺省 auto 由本机的探测结果决定。',
]

/**
 * 终端命令参考：按「想做的事」分组。
 *
 * 内容口径与 CLI 的 clap 定义一致：只写真实存在的子命令与参数，不写"计划中"。
 * 高危条目（覆盖数据 / 改密钥 / 对外暴露 / 卸载 / 改监听地址）标 `risk`，
 * 提醒用户先看 caution 再执行。命令在服务器上执行，浏览器终端页与 SSH 等价。
 */
export const CLI_GROUPS: CliGroup[] = [
  {
    title: '安装与自检',
    lead: '装完或改完配置先自检，确认无误再启动服务。',
    commands: [
      {
        cmd: 'panel init [--force] [--owner <用户名>] [--owner-pass <口令>]',
        purpose: '首次初始化目录、主密钥、配置模板、数据库结构与首个 owner 账号。',
        when: '全新安装后执行一次；已经初始化过的机器不要重复跑。',
        params: [
          '--force：按默认路径重建配置，会清掉自定义的路径设置，属破坏性操作',
          '--owner / --owner-pass：非交互创建 owner；不给则交互提示，口令不回显',
        ],
        requires: '以安装时使用的系统用户执行，一般需要 sudo；写系统目录与库文件。',
        caution: '配置已存在时默认复用、不覆盖；已有 owner 会跳过创建。若初始化后是「空面板」，多半是路径设置被覆盖导致库还在旧位置——先查「目录与位置」页确认实际路径，不要直接加 --force 重建。',
        risk: true,
      },
      {
        cmd: 'panel doctor',
        purpose: '部署前自检：逐项检查 init 应建好的目录、密钥、配置、库与账号。',
        when: '装完、改过配置文件后、升级前，或 serve 起不来时先跑。',
        params: [],
        requires: '无特殊前置；不需要 root 也能读配置。',
        caution: '它和 serve 用同一套启动前校验。若 doctor 报全绿但服务仍起不来，优先确认两者读的是同一份配置（用 --config 指向实际文件）。',
      },
      {
        cmd: 'panel capabilities [--json]',
        purpose: '打印本机能力位清单，供脚本或排障时判断环境支持哪些功能。',
        when: '侧边栏某菜单灰着、想知道本机到底缺什么组件时。',
        params: ['--json：输出机器可读的 JSON，供脚本消费'],
        requires: '无特殊前置。',
        caution: '--json 只属于本命令；给其他子命令加会直接报错，这是刻意设计，避免"收下参数却不生效"。',
      },
      {
        cmd: 'panel migrate',
        purpose: '执行数据库结构迁移，可重复执行。',
        when: '升级后，或 doctor 提示库结构落后时。',
        params: [],
        requires: '以安装时使用的系统用户执行，一般需要 sudo；迁移前会自动对库做快照。',
        caution: '幂等，重复执行不会重复改结构；迁移快照落在备份目录，出问题可据此回退。',
      },
      {
        cmd: 'panel systemd-unit [--install]',
        purpose: '输出 systemd 单元文件内容，供审阅或交给 systemd 托管服务。',
        when: '排查服务为什么没自启，或需要手工安装单元文件时。',
        params: ['--install：真正写入并安装单元文件；不给则只在终端打印'],
        requires: '仅 --install 需要 root；不带参数时可安全审阅。',
        caution: '默认只打印不安装，就是为了让非 root 也能先看清楚会写入什么。',
      },
    ],
  },
  {
    title: '服务与网络',
    lead: '改网络和监听设置要格外小心：面板以 root 运行，错配会把自己锁在门外。',
    commands: [
      {
        cmd: 'panel serve',
        purpose: '前台启动面板服务；生产环境由 systemd 托管，这条主要用于调试或临时启动。',
        when: '临时起服务观察日志，或排查 systemd 启动失败时。',
        params: [],
        requires: '以安装时使用的系统用户执行，一般需要 sudo。',
        caution: '面板以 root 运行且本构建不提供内置 HTTPS，监听是明文 HTTP。绑到非回环地址时终端会强警告：若机器可被局域网或公网访问，等于把 root 操作入口暴露出去。对外访问优先用 panel expose。',
        risk: true,
      },
      {
        cmd: 'panel menu',
        purpose: '进入交互式配置菜单；在交互终端里直接运行 panel 效果相同。',
        when: '不熟悉命令参数，想按菜单逐项操作时。',
        params: [],
        requires: '操作网络配置的那几项仍需 root。',
        caution: '脚本或管道里裸跑 panel 不会进菜单，而是打印帮助并以非零码退出，请显式写子命令。',
      },
      {
        cmd: 'panel config status',
        purpose: '查看当前配置与面板服务状态。',
        when: '确认端口、监听地址是否正确，或改完配置后核对结果。',
        params: [],
        requires: '不需要 root，可放心执行。',
        caution: '它读的是配置文件与进程状态；若你用 --config 指定了非默认文件，查询时也要带同一个 --config。',
      },
      {
        cmd: 'panel config set port <端口> --yes',
        purpose: '修改面板的监听端口，写入配置后会自动重启服务并验证可达。',
        when: '端口冲突，或需要固定为某个端口时。',
        params: [
          '<端口>：1-65535 之间的整数',
          '--yes：显式确认，不给会拒绝执行',
        ],
        requires: '需要 root：要写配置文件并重启服务。',
        caution: '执行流程是「快照配置 → 写入 → 重启 → 验证可达 → 失败回滚」。改错端口会把自己锁在面板外，改前先确认新端口已在防火墙放行；连不上时用 panel config status 查实际端口。',
        risk: true,
      },
      {
        cmd: 'panel config set bind <地址> --yes',
        purpose: '修改面板的监听地址，决定从哪个网卡或地址接受连接。',
        when: '需要改回环地址，或明确要把面板绑到某个网卡时。',
        params: [
          '<地址>：IPv4、IPv6 或主机名',
          '--yes：非回环地址必须显式确认',
        ],
        requires: '需要 root：要写配置文件并重启服务。',
        caution: '回环地址可直接设置；非回环地址默认拒绝，加 --yes 会同时放开本机保护设置，等于把 root 面板以明文 HTTP 暴露到网络。只是想对外提供访问，请优先用 panel expose 走反代与 TLS。',
        risk: true,
      },
      {
        cmd: 'panel config set metrics-token',
        purpose: '设置 Prometheus 抓取 token，从标准输入读取后写入数据目录的独立状态文件。',
        when: '把面板指标接入 Prometheus 等监控时。',
        params: [],
        requires: '以安装时使用的系统用户执行；凭据只写独立文件，不写配置文件。',
        caution: 'token 从 stdin 读入而非命令行参数，避免出现在进程列表与命令历史里。',
      },
    ],
  },
  {
    title: '备份与恢复',
    lead: '恢复会覆盖现有库，执行前务必先验证产物、先停服务。',
    commands: [
      {
        cmd: 'panel backup [--out <路径>] [--no-encrypt]',
        purpose: '在线备份面板数据库，不停服；默认产出加密文件，权限 0600。',
        when: '升级、改重要配置前手动留一份，或配合备份计划做周期备份。',
        params: [
          '--out <路径>：指定产物路径',
          '--no-encrypt：产出明文 .db，仅供本机临时查看，不要交给外部介质',
        ],
        requires: '加密需要数据目录里的主密钥存在；写产物目录的权限。',
        caution: '目标文件已存在会直接拒绝，不会覆盖，请先换路径或删除旧文件。加密备份离不开主密钥：恢复前先用 panel key check <离线副本> 确认副本可用。密钥读不到时会报错中止，绝不会用新生成的钥匙做出一份打不开的备份。',
      },
      {
        cmd: 'panel verify-backup <路径>',
        purpose: '校验备份产物真的能恢复：解密、解压并执行完整性检查，不改动任何现有库。',
        when: '备份完成后、真正恢复之前，先跑一次确认产物可用。',
        params: ['<路径>：.db / .tar.gz 及其 .enc 加密变体'],
        requires: '加密产物需要对应的主密钥。',
        caution: '这是只读校验，可以放心执行。若提示解密失败，先确认用的是轮换前的密钥对应的副本，不要急着重做备份。',
      },
      {
        cmd: 'panel restore-db <路径> [--remote <计划ID>] [--artifact <名称>] [--force]',
        purpose: '离线恢复面板数据库，覆盖现有库。',
        when: '库损坏、误删数据，或迁移后需要还原面板自身数据时。',
        params: [
          '<路径>：本地产物（.db 或 .db.enc）；站点 .tar.gz 会被拒绝',
          '--remote <计划ID>：本地盘没了时从远端副本取，计划须为面板库类型且配了远端副本',
          '--artifact <名称>：指定远端产物名，缺省取该计划最新的一份',
          '--force：跳过「服务仍在监听」检查，仅在容器里进程名不同或已确认停机时用',
        ],
        requires: '必须先停止面板服务：在线覆盖会损坏 SQLite 的 WAL。服务仍在监听会直接拒绝。',
        caution: '恢复会覆盖当前库，先确认已有可用备份。用明文产物且本机没有主密钥时，库能恢复但里面的密文（SSL 私钥、数据库口令、MFA 密钥、远端备份凭据等）将永久解不开，界面会明确警告——恢复后请立刻补回密钥副本并验证。',
        risk: true,
      },
      {
        cmd: 'panel vacuum',
        purpose: '重建数据库以回收空间。',
        when: '数据库文件明显膨胀、删除大量记录后想压缩体积时。',
        params: [],
        requires: '以安装时使用的系统用户执行，一般需要 sudo。',
        caution: '动的是面板自身的库；执行前仍建议先 panel backup 留一份。',
      },
    ],
  },
  {
    title: '账号与安全',
    lead: '密钥是解开全库密文的唯一钥匙；告警通道要「测过」才算接通。',
    commands: [
      {
        cmd: 'panel passwd <用户名> [--pass <口令>]',
        purpose: '修改已存在用户的口令。',
        when: '忘记管理员密码，或需要重置某个账号的登录口令时。',
        params: ['--pass <口令>：非交互指定新口令；不给则交互读取且不回显'],
        requires: '以安装时使用的系统用户执行，一般需要 sudo。',
        caution: '只能改已存在的账号，不能用来新建用户；建号走初始化或首启引导令牌。界面不提供绕过密码的入口。',
      },
      {
        cmd: 'panel key show | export --out <路径> | check <路径> | rotate [--yes]',
        purpose: '主密钥运维：查看指纹、导出离线副本、校验副本、轮换密钥。',
        when: '异地备份密钥、迁移机器，或怀疑密钥泄露需要轮换时。',
        params: [
          'show：打印路径、权限与指纹，不打印密钥本体',
          'export --out <路径>：导出 0600 离线副本，拒绝写进数据目录（同盘等于没备份）',
          'check <路径>：比对指纹，并真拿副本解一条库里的密文',
          'rotate [--force] [--yes]：用新密钥重加密全库；必须先停服务，--yes 为执行确认',
        ],
        requires: 'rotate 必须先停服务；其他子命令只读或只写指定副本。',
        caution: '这份钥匙解开的是 MFA 密钥、SSL 私钥、数据库口令、远端备份凭据与模型 API Key。轮换不可逆，运行中的进程内存里还是旧密钥，所以必须先停服务；不给 --yes 时只打印将要发生什么。轮换后旧加密备份需对应的旧密钥才能解。',
        risk: true,
      },
      {
        cmd: 'panel alert status | test',
        purpose: '查看外部告警通道是否接好，或发一条测试告警。',
        when: '配完告警地址后，确认「配了」变成「真的能发」。',
        params: [
          'status：打印是否已接、节流口径与配置文件名，不回显 URL',
          'test：走与业务告警相同的发送路径，真发一条测试消息',
        ],
        requires: '告警地址写在安装目录的 alert-webhook 文件里（单行 URL），需先配置。',
        caution: 'status 不回显 URL 是因为它常带 token；地址通常也用于崩溃告警，改动会影响两者。',
      },
      {
        cmd: 'panel healthcheck [--install | --uninstall]',
        purpose: '安装或卸载外部探活，补上「进程还活着但已经不服务」这类故障。',
        when: '服务假死但 systemd 显示 active，需要自动重启兜底时。',
        params: [
          '--install：安装探活脚本与 systemd 定时单元',
          '--uninstall：卸载脚本与单元文件',
        ],
        requires: '仅安装 / 卸载需要 root；不带参数只打印，便于审阅。',
        caution: '它补的是 Restart=on-failure 管不了的场景，不能替代服务本身的健康检查。',
      },
    ],
  },
  {
    title: '公网、升级与卸载',
    lead: '「撤销公网访问」和「卸载面板」是两件事，别混用。',
    commands: [
      {
        cmd: 'panel expose [-d <域名>] [-a <CIDR>] [--self-signed | --fullchain <证书> --key <私钥>] [--uninstall]',
        purpose: '引导式安全暴露：配置域名反代并终结 HTTPS，面板本身仍只绑回环。',
        when: '需要从公网访问面板时；默认零暴露，不执行就没有对外入口。',
        params: [
          '-d / --domain <域名>：对外域名，省略则交互询问',
          '-a / --allow <CIDR>：允许访问的来源网段，可重复，如 1.2.3.4/32',
          '--self-signed：现场生成自签证书；与 --fullchain / --key 互斥',
          '--fullchain / --key：自带证书链与私钥文件（PEM）',
          '--no-firewall：已有独立防火墙策略时跳过写规则',
          '--uninstall：撤下反代、面板恢复只绑回环',
        ],
        requires: '需要 root：要写反代配置、systemd 单元与防火墙规则。',
        caution: '拒绝 0.0.0.0/0 这种全放开写法；域名与 CIDR 会先做校验再由脚本复核。自签与自带证书互斥，同时给会被拦下，不会静默降级。--uninstall 只是撤销公网暴露，面板、账号和数据都还在；要卸载本体请用 panel uninstall。',
        risk: true,
      },
      {
        cmd: 'panel upgrade [--check] [--dry-run] [--version <版本>] [--base-url <地址>]',
        purpose: '升级面板：下载签名发行包、验签、解包、安装，失败自动回滚。',
        when: '有新版本且已备份，需要升级时。',
        params: [
          '--check：只检查有没有新版本，不下载',
          '--dry-run：下载并验签后停下，不安装',
          '--version <版本>：指定版本，带不带 v 均可',
          '--base-url <地址>：用自建镜像下载，签名仍用内嵌公钥校验',
        ],
        requires: '需要 root：替换二进制与重启服务。升级前先备份。',
        caution: '验签不通过会立即中止，不会执行包内任何文件。安装前会把旧二进制留为备份，安装失败或装完服务异常都会回滚；配置与数据不删。',
        risk: true,
      },
      {
        cmd: 'panel uninstall',
        purpose: '卸载面板本体：停服务、移除 systemd 单元、移除二进制。',
        when: '确定不再使用面板，或准备换机重装时。',
        params: [],
        requires: '需要 root：停止服务、删单元与二进制都要 root。',
        caution: '保留数据目录与站点目录，账号、站点、审计与备份都还在，重新安装后仍可读取；彻底清除数据需手动删除数据目录。若要彻底清掉请先备份。只是不想对外暴露，请用 panel expose --uninstall，不要卸载本体。',
        risk: true,
      },
    ],
  },
]

/**
 * 常见问题：答案只写在面板里能验证的事实，不写"请联系厂商"之类的空话。
 * 与「终端命令」的分工：这里回答现象「为什么 / 怎么办」，命令表回答「怎么执行」。
 */
export const FAQS: FaqItem[] = [
  {
    q: '为什么某个菜单是灰色的？',
    a: '两种原因：账号缺少对应权限，需管理员分配；或本机未安装所需组件。鼠标悬停可查看具体原因，终端执行 panel capabilities 可看本机支持哪些能力。',
  },
  {
    q: '提示「当前环境不支持」是什么意思？',
    a: '该功能所需的组件尚未就绪，例如未安装 Web 服务器或容器服务。按菜单提示安装组件后需重启面板才会重新探测。',
  },
  {
    q: '忘记管理员密码怎么办？',
    a: '在服务器执行 panel passwd 用户名 重置，加 --pass 新口令可非交互完成。界面不提供绕过密码的入口，也不能用这条命令新建账号。',
  },
  {
    q: '支持 Windows 或 macOS 服务器吗？',
    a: '仅支持 Linux。面板依赖系统自带的服务、防火墙与计划任务等能力，其他系统无法安装。',
  },
  {
    q: '终端页面和直接 SSH 执行命令有什么区别？',
    a: '权限等价：终端页以面板自身的系统用户执行命令，能做的和 SSH 一样，误操作同样影响整台服务器。能用功能页面完成的，优先用页面操作；需要面板自身运维时，再用本文的 panel 命令。',
  },
  {
    q: '执行 panel 命令提示「需要 root 权限」怎么办？',
    a: '写系统目录、改配置、改监听地址、装单元或替换二进制的命令都需要 sudo，按提示加 sudo 重跑即可。panel config status、panel doctor、panel capabilities 等只读命令不需要。',
  },
  {
    q: '恢复或换密钥时提示「服务仍在运行」，怎么处理？',
    a: 'panel restore-db 和 panel key rotate 必须先停服务，否则会损坏数据库或留下内存里的旧密钥。请按部署方式停掉面板服务再重试；确认已停机但在容器里被误判时，才考虑 --force 跳过检查。',
  },
  {
    q: '备份提示「读不到主密钥」，或者加密备份恢复后解不开？',
    a: '加密备份绑的是当时那份主密钥：读不到密钥时会直接报错、不会生成无效产物；轮换密钥后旧备份也需要旧密钥才能解。先用 panel key check <离线副本> 确认副本可用，再决定恢复方式。',
  },
  {
    q: '改完端口连不上面板了怎么办？',
    a: '先用 panel config status 确认实际端口，再检查防火墙是否放行了新端口。面板装在非默认位置时，记得给命令带上同一个 --config。',
  },
  {
    q: '为什么 panel --json 会报错？',
    a: '--json 只由 panel capabilities 支持，其他子命令刻意不接受它，避免"收下参数却不生效"让人误以为拿到了机器可读结果。正确写法是 panel capabilities --json。',
  },
  {
    q: '怎么升级或卸载面板？',
    a: '升级在「设置」页检查执行，或用 panel upgrade，建议先备份。卸载本体用 panel uninstall（保留数据）；只想撤销公网访问用 panel expose --uninstall，面板仍绑回环，不会卸载。',
  },
]
