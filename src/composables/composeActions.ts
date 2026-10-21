/**
 * Compose 生命周期动作的**唯一清单**。
 *
 * ## 为什么单独成文件
 * 这份列表有两个消费者：
 * 1. `ComposeTab.vue` —— 渲染按钮（v-for）；
 * 2. `ContainersView.vue` —— 帮助抽屉里那句「生命周期写操作已开放：…」。
 *
 * 曾经两端各写一遍，结果帮助里写着「仍不提供 up / down / restart」而按钮就在
 * 同一屏——文案与实现漂移过一次（用户读到"不提供"就不会去点，功能等于白做）。
 * 现在按钮与句子都从这一份派生，增删动作时文案自动跟着变。
 *
 * `down` **不在这里**：危险色 + 需手输项目名确认，单独走 `askComposeDown()`。
 */
export const COMPOSE_ACTIONS = [
  { key: 'up', label: '启动 up' },
  { key: 'restart', label: '重启' },
  { key: 'stop', label: '停止' },
] as const

export type ComposeActionKey = (typeof COMPOSE_ACTIONS)[number]['key']

/** 帮助文案里用的动作枚举（由上面那份派生，不手写第二遍） */
export const COMPOSE_ACTIONS_TEXT = COMPOSE_ACTIONS.map((a) => a.label).join(' / ')
