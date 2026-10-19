/**
 * 「应用」页新建表单的**字段填写指引**——按运行时给出该抄什么。
 *
 * 为什么放在 .ts 而不是 .vue：本项目的 vitest 只收 `src/**\/*.test.ts` 且未配 vue 插件，
 * SFC 里的函数无法被 import。这段是纯展示语义（输入运行时 → 输出几行文本），没有任何
 * 响应式依赖，抽出来才能上测试。放在 composables/ 下不叫 `useXxx` 也没关系——这里约束
 * 的是「可单测的纯逻辑」，不是「必须是 composable」。
 *
 * 为什么需要它：`AppRuntime` 后端只下发了 purpose / choose_when / default_exec，回答的是
 * 「这个运行时是什么、什么时候选」，**没回答表单里那五个框各自填什么**。用户选完运行时
 * 对着「工作目录 / 启动命令 / 监听端口 / 运行用户 / 域名」仍然要猜，尤其「工作目录须已存在」
 * 与「启动命令写程序名还是绝对路径」这两处最常卡住（后端的字段错误提示要提交后才出现）。
 *
 * 纪律：这里写的字段名必须与 `AppsView.vue` 表单里真实的 label 逐字一致
 * （workdir=`工作目录`、exec_start=`启动命令`、port=`监听端口`、domains=`域名`），
 * 否则用户按指引去页面里找会找不到。测试 `appsFieldGuide.test.ts` 逐条钉住。
 */

/** 表单里的字段名——与 AppsView.vue 的 label 文案保持逐字一致，改一处必须改两处。 */
export const FIELD_LABELS = {
  name: '名称',
  workdir: '工作目录',
  execStart: '启动命令',
  port: '监听端口',
  runUser: '运行用户',
  domains: '域名',
} as const

export interface FieldHint {
  /** 字段名（用于加粗展示，值取自 FIELD_LABELS） */
  field: string
  /** 该字段要填什么（典型值 + 易错点） */
  what: string
}

/**
 * 按运行时给出「每个框填什么」。
 *
 * 只覆盖真正会因运行时不同而不同的三项：工作目录的内容、启动命令、端口来源。
 * 「名称 / 运行用户 / 域名」三个与运行时无关，见 `COMMON_FIELD_HINTS`——
 * 把它们在每个分支里重复一遍，将来改一处必然漏改其余。
 */
export function runtimeFieldHints(key: string): FieldHint[] {
  switch (key) {
    case 'node':
      return [
        { field: FIELD_LABELS.workdir, what: '放 package.json 的目录，如 /opt/blog（须已存在，可用「浏览…」选）' },
        { field: FIELD_LABELS.execStart, what: 'node server.js --port 3000（也可只写 node，参数另在下方环境变量里给）' },
        { field: FIELD_LABELS.port, what: 'Node 自己 listen 的端口，如 3000；面板据此生成反代到 127.0.0.1:3000' },
      ]
    case 'go':
      return [
        { field: FIELD_LABELS.workdir, what: '跟着二进制走没必要，填放运行所需文件（配置/模板）的目录，如 /opt/app' },
        { field: FIELD_LABELS.execStart, what: '二进制路径，如 /opt/app/server；Go 只在编译时需要，服务器上不必装 Go' },
        { field: FIELD_LABELS.port, what: '程序里监听的端口，如 8080；面板据此生成反代' },
      ]
    case 'rust':
      return [
        { field: FIELD_LABELS.workdir, what: '放运行所需文件（配置/静态资源）的目录，如 /opt/app' },
        { field: FIELD_LABELS.execStart, what: '/opt/app/target/release/app（或 cargo run --release，但生产别用 cargo run）' },
        { field: FIELD_LABELS.port, what: '程序里监听的端口，如 8080' },
      ]
    case 'java':
      return [
        { field: FIELD_LABELS.workdir, what: '放 jar 的目录，如 /opt/myapp（jar 路径相对它）' },
        { field: FIELD_LABELS.execStart, what: 'java -jar app.jar；要调内存写成 java -Xmx512m -jar app.jar' },
        { field: FIELD_LABELS.port, what: 'Spring Boot 默认 8080；用 server.port 改过就填改后的值' },
      ]
    case 'python':
      return [
        { field: FIELD_LABELS.workdir, what: '放 manage.py / main.py 的目录，如 /opt/myapp；venv 也建在这里' },
        { field: FIELD_LABELS.execStart, what: 'gunicorn app:app -b 127.0.0.1:8000（Django 用 project.wsgi:application）' },
        { field: FIELD_LABELS.port, what: '与 -b 里写的端口一致，如 8000' },
      ]
    case 'dotnet':
      return [
        { field: FIELD_LABELS.workdir, what: 'publish 产物的目录，如 /opt/myapp（不是源码目录）' },
        { field: FIELD_LABELS.execStart, what: 'dotnet MyApp.dll' },
        { field: FIELD_LABELS.port, what: 'Kestrel 监听的端口，如 5000；也可在 launchSettings 里配' },
      ]
    case 'php':
      return [
        { field: FIELD_LABELS.workdir, what: '项目根目录，如 /var/www/laravel（须已存在）' },
        { field: FIELD_LABELS.execStart, what: '常驻型应用才用得上（如 php artisan serve）；普通 PHP 建站请直接用「网站」页的 PHP 类型' },
        { field: FIELD_LABELS.port, what: '常驻进程自己监听的端口，如 8000；走 php-fpm 的站点不需要启动命令，端口由 Web 服务器转进 fpm，这里可留空' },
      ]
    case 'custom':
      return [
        { field: FIELD_LABELS.workdir, what: '启动命令的工作目录，命令里用相对路径时以它为准，如 /opt/app' },
        { field: FIELD_LABELS.execStart, what: '完整启动命令，如 ./run.sh 或 /usr/bin/python3 main.py' },
        { field: FIELD_LABELS.port, what: '服务实际监听的端口，如 3000；确实不监听 TCP（如只跑定时任务）才留空' },
      ]
    default:
      // 运行时还没选：不猜，返回空数组让上层不渲染这一段。
      return []
  }
}

/**
 * 与运行时无关的三个框——同样的值对所有运行时都成立。
 *
 * 「运行用户」与「域名」的具体语义由表单自己的 hint 说明（面板建 site-<应用名>、
 * 自动建反代站点），这里只补**最常填错**的那一点，不重复表单已有文案。
 */
export const COMMON_FIELD_HINTS: FieldHint[] = [
  { field: FIELD_LABELS.name, what: '小写字母 / 数字 / 连字符，如 my-blog；它同时决定 systemd 单元名与默认运行用户' },
  { field: FIELD_LABELS.runUser, what: '留空即由面板建 site-my-blog 这样的账号（禁止登录）；手填则必须是本机已存在的账号，填错会报错' },
  { field: FIELD_LABELS.domains, what: '填了才会自动建反代站点，如 blog.example.com；域名须已解析到本机并放行 80/443' },
]

/** 把两组指引拼起来，供模板一次渲染。空运行时返回空数组。 */
export function allFieldHints(key: string): FieldHint[] {
  const own = runtimeFieldHints(key)
  if (!own.length) return []
  return [...own, ...COMMON_FIELD_HINTS]
}
