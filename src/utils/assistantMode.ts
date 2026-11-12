import type { AssistantMode } from '@/api/types'

/** 意图来源：自由输入 / 快捷提问 / 当前页解释。 */
export type AskSource = 'input' | 'chip' | 'page'

/**
 * 意图只由「用户从哪个入口发起」决定，绝不靠关键词猜。
 * 后端关键词路由仅存在于 diagnose 模式内部（选诊断域），不参与意图判定。
 */
export function assistantMode(source: AskSource): AssistantMode {
  return source === 'input' ? 'chat' : 'diagnose'
}

/** chat 模式不展示体检基线与发现卡片，避免对话被误认成体检报告。 */
export function shouldShowDiagnostics(mode: AssistantMode): boolean {
  return mode === 'diagnose'
}
