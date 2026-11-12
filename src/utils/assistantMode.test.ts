import { describe, it, expect } from 'vitest'
import { assistantMode, shouldShowDiagnostics } from './assistantMode'

describe('assistantMode：意图由入口显式决定，不猜关键词', () => {
  it('自由输入走 chat；快捷提问与页面解释走 diagnose', () => {
    expect(assistantMode('input')).toBe('chat')
    expect(assistantMode('chip')).toBe('diagnose')
    expect(assistantMode('page')).toBe('diagnose')
  })

  it('函数不接收问句内容 ⇒ 普通对话不可能被关键词误判为体检', () => {
    // 负向对照：把 assistantMode 改回「按问句关键词猜意图」或恒返回 diagnose，
    // 这条即红。意图与问句文本完全解耦是本函数存在的理由。
    expect(assistantMode.length).toBe(1)
    expect(assistantMode('input')).not.toBe('diagnose')
  })

  it('chat 模式不渲染体检报告，diagnose 模式才渲染', () => {
    expect(shouldShowDiagnostics('chat')).toBe(false)
    expect(shouldShowDiagnostics('diagnose')).toBe(true)
  })
})
