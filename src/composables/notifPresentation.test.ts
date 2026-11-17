import { describe, it, expect } from 'vitest'
import { notifSourceLabel, notifSourceRoute, notifBodyText } from './notifPresentation'

describe('通知来源展示', () => {
  it('六个契约来源都有中文名', () => {
    for (const [v, label] of Object.entries({
      backup: '备份', restore: '恢复', cert: '证书',
      task: '任务', security: '安全', system: '系统',
    })) expect(notifSourceLabel(v)).toBe(label)
  })

  it('未知来源回退原值，原型链键不能混进来', () => {
    expect(notifSourceLabel('plugin')).toBe('plugin')
    expect(notifSourceLabel(null)).toBe('—')
    expect(notifSourceLabel('toString')).toBe('toString')
  })

  it('来源映射到真实业务页，未知来源不给链接', () => {
    expect(notifSourceRoute('backup')).toBe('/backups')
    expect(notifSourceRoute('restore')).toBe('/backups')
    expect(notifSourceRoute('cert')).toBe('/certs')
    expect(notifSourceRoute('task')).toBe('/cron/tasks')
    expect(notifSourceRoute('security')).toBe('/waf')
    expect(notifSourceRoute('system')).toBe('/settings')
    expect(notifSourceRoute('plugin')).toBeNull()
    expect(notifSourceRoute('')).toBeNull()
    expect(notifSourceRoute('constructor')).toBeNull()
  })
})

describe('通知正文纯文本化', () => {
  it('去掉历史 Markdown 强调符，保留换行与其它原文', () => {
    expect(notifBodyText('本地产物已生成，**异地副本缺失**，请检查。\n\nWebDAV 401'))
      .toBe('本地产物已生成，异地副本缺失，请检查。\n\nWebDAV 401')
    expect(notifBodyText(null)).toBe('')
    expect(notifBodyText('')).toBe('')
  })
})
