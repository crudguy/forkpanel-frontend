/**
 * 侧边栏「禁用项必须说得出原因」守卫（源码级）。
 *
 * ## 为什么需要它
 *
 * 菜单可见性 = 后端能力位 AND RBAC 权限点，被禁的项置灰并把原因挂在 `:title` 上。
 * 曾经挡点击靠的是 CSS `.item.disabled { pointer-events: none }`——**它把 hover 一起
 * 屏蔽了**，于是 tooltip 永远不出、键盘因 `tabindex="-1"` 也够不着。用户看到的是
 * "有一项灰着，点了没反应，悬停也没提示"，观感上等同于"这功能压根没做"。
 *
 * 能力位不支持的项尤其致命：「公网访问」在本机没装 nginx 时就是这种状态——
 * 看不出原因，就不知道该装 nginx 还是该改配置，只能干瞪眼。
 *
 * ## 为什么只能源码级断言
 *
 * 这里没有可调用的运行时入口：`.disabled` 只是个类名绑定，`pointer-events` 只是条
 * CSS 声明。组件没挂载就没有 DOM 可查，而"悬停时浏览器是否弹原生 tooltip"更是
 * 单测够不着的浏览器行为。故退一步守住**源码里的写法**——这也是本项目通行做法
 * （见 `routes.rs` 的 `wiring_guard_tests`、CLI 的 `expose_arm_invokes_script_via_bash`）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

// 测试文件位于 src/components/，故 '..' 即 src/；下方路径一律相对 src/ 传，
// 不能再带 src/ 前缀（否则拼成 src/src/...，ENOENT）。
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')

/**
 * 剥掉注释（块注释 + 行注释）。
 *
 * ⚠ 必须**先剥块注释**：本文件与被测文件的注释里都会出现 `pointer-events` 字样
 *   （正是在讲这条坑），只用「按行过滤行首 //」的写法剥不掉跨行块注释，
 *   会把"注释在讲这件事"误判成"代码真这么写了"——恒红陷阱的经典形态。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
}

describe('SideNav 禁用项必须说得出原因', () => {
  const src = stripComments(read('components/SideNav.vue'))

  it('禁用规则不得用 pointer-events 屏蔽事件', () => {
    // 反例（曾真实存在）：`.item.disabled { opacity: .4; pointer-events: none; }`
    // —— hover 一并失效，`:title` 里的禁用原因永远看不到。
    expect(src).not.toMatch(/\.item\.disabled[^{]*\{[^}]*pointer-events/)
  })

  it('禁用原因必须绑到 :title', () => {
    expect(src).toMatch(/:title="it\.off \?\? it\.label"/)
  })

  it('必须有 JS 侧点击拦截（CSS 不再挡事件后，点击得由代码拦）', () => {
    expect(src).toMatch(/function onNavClick\(it: NavItem, e: MouseEvent\)/)
    expect(src).toMatch(/if \(it\.off\) e\.preventDefault\(\)/)
  })

  // ⚠️ 拦截必须挂在**捕获阶段**：`<RouterLink>` 内部自带 `onClick: link.navigate`，
  //   我们写在外层的普通 `@click` 会被合并成 `[navigate, ours]`——ours 后跑，
  //   此时路由已 push，preventDefault 拦不住。`.capture` 才先于 navigate。
  it('点击拦截必须是 .capture（普通 @click 会晚于 RouterLink 的 navigate）', () => {
    expect(src).toMatch(/@click\.capture="onNavClick\(it, \$event\)"/)
    expect(src, '不得退回普通 @click（会拦不住跳转）')
      .not.toMatch(/[^.]@click="onNavClick/)
  })
})
