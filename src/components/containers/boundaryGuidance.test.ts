/**
 * 容器页「刻意不提供的操作」**在上下文里的引导**守卫（源码级）。
 *
 * 为什么需要它：容器页有 5 项能力是**刻意排除**的（docker exec / 网络增删与接入 /
 * 卷增删 / 镜像删除 / compose 项目级日志）。这些能力没有按钮，用户的第一反应是
 * "功能坏了"，而不是"面板故意不做"。帮助抽屉里虽写了「仍不提供」，但用户停在某个
 * Tab 上不会去翻抽屉——**引导必须出现在那个 Tab 里**。
 *
 * 删掉某条 banner 后编译 / 类型 / 构建 / 其它单测全绿，用户却重新面对一个没有解释的
 * 空白。故用源码级守卫钉住：每个含"刻意不提供"项的 Tab，必须有一条 RiskBanner，
 * 且文案点到那一项、并给出可执行的下一步（「终端」/ docker CLI）。
 *
 * ⚠ 断言必须**限定在 RiskBanner 标签内**：各 Tab 的头注释里本身就写着
 * "创建 / 删除卷"等字样，全文 `toContain('删除卷')` 会被注释命中而恒绿。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

// 测试位于 src/components/containers/ ⇒ '../../' 即 src/
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')

/** 剥注释行：把"注释在讲这件事"与"banner 真说了"分开（恒绿陷阱的经典形态）。 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

/** 取出 `<RiskBanner … />` 这一个标签的源码（含 text 属性）。
 *  找不到就**响亮失败**——而不是安静地检查了空串。 */
function bannerTag(src: string): string {
  const at = src.indexOf('<RiskBanner')
  expect(at, '该 Tab 必须有 <RiskBanner>（放在 Tab 内、用户看得到的位置说明边界）').toBeGreaterThan(-1)
  const end = src.indexOf('/>', at)
  expect(end, 'RiskBanner 应为自闭合标签').toBeGreaterThan(at)
  return src.slice(at, end)
}

describe('容器页：刻意不提供的操作必须在对应 Tab 内有上下文引导', () => {
  // [文件, 必须是 banner 文本里出现的点名词, 人类可读的"那一项"]
  const cases: Array<[string, string, string]> = [
    ['components/containers/ContainersTab.vue', 'docker exec', '进入容器执行命令（docker exec）'],
    ['components/containers/ImagesTab.vue', '删除镜像', '删除镜像'],
    ['components/containers/NetworksTab.vue', '创建 / 删除网络', '网络创建 / 删除与容器接入 / 断开'],
    ['components/containers/VolumesTab.vue', '创建 / 删除卷', '卷创建 / 删除'],
    ['components/containers/ComposeTab.vue', '项目级日志', 'compose 项目级日志'],
  ]

  for (const [file, keyword, what] of cases) {
    it(`${file} 的 RiskBanner 点明「${what}」未提供，并给出下一步`, () => {
      const tag = bannerTag(stripComments(read(file)))
      expect(tag, `banner 文案须点明「${what}」`).toContain(keyword)
      // 只写"不行"三个字对用户毫无帮助：必须给可执行的出口
      expect(tag, 'banner 须给出可执行下一步（「终端」页 / docker CLI）').toMatch(/docker CLI|终端/)
    })
  }
})
