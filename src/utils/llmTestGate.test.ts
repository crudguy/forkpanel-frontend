import { describe, it, expect } from 'vitest'
import { llmTestBlockReason } from './llmTestGate'

describe('llmTestBlockReason', () => {
  it('Endpoint 与已保存值一致时放行', () => {
    expect(llmTestBlockReason('http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1')).toBeNull()
    expect(llmTestBlockReason(' https://api.openai.com/v1 ', 'https://api.openai.com/v1')).toBeNull()
  })

  it('Endpoint 被改动时拦截，理由给出可操作动作', () => {
    const reason = llmTestBlockReason('https://a.example/v1', 'http://attacker.example/v1')
    expect(reason).toContain('先保存')
    expect(reason).toContain('已保存')
  })

  it('库里未保存 Endpoint 时，随手填一个也不放行', () => {
    expect(llmTestBlockReason('', 'https://api.openai.com/v1')).toContain('先保存')
  })

  it('两端都空时放行，由后端给「尚未配置」的 400', () => {
    expect(llmTestBlockReason('', '   ')).toBeNull()
  })
})
