import { describe, it, expect } from 'vitest'
import { DR_STEPS, stepCopyText, restoreKeyHint } from './disasterReadiness'

describe('灾备清单：三件事缺一不可', () => {
  it('恰好三步且 id 唯一', () => {
    expect(DR_STEPS).toHaveLength(3)
    expect(new Set(DR_STEPS.map((s) => s.id)).size).toBe(3)
  })

  it('主密钥那一步给出 show / export / check 三条命令', () => {
    const step = DR_STEPS.find((s) => s.id === 'master-key')!
    expect(step.commands).toHaveLength(3)
    expect(step.commands.join('\n')).toContain('panel key export')
    expect(step.commands.join('\n')).toContain('panel key check')
  })

  it('清单里没有任何一步会把密钥内容送进浏览器（安全边界）', () => {
    const all = DR_STEPS.flatMap((s) => s.commands).join('\n').toLowerCase()
    // 只允许「导出到文件 + 校验」，不允许 cat / 打印 / 下载密钥本体
    expect(all).not.toMatch(/cat\s+\S*master\.key/)
    expect(all).not.toMatch(/curl|wget|download/)
    expect(all).not.toMatch(/key show\s*\|/ )
  })

  it('CA 私钥那一步明确标注为条件项', () => {
    expect(DR_STEPS.find((s) => s.id === 'ca-key')?.conditional).toBe(true)
  })

  it('CA 私钥先给自查命令：不看文件在不在就盲拷，用户分不清是否需要这一步', () => {
    const step = DR_STEPS.find((s) => s.id === 'ca-key')!
    expect(step.commands[0]).toContain('ls -l')
    expect(step.commands[0]).toContain('ca.key')
    expect(step.desc).toContain('自查')
  })

  it('主密钥是三步里唯一带 export 的，且排第一位（产物可以重来，密钥丢了无解）', () => {
    const withExport = DR_STEPS.filter((s) => s.commands.some((c) => c.includes('key export')))
    expect(withExport).toHaveLength(1)
    expect(withExport[0].id).toBe('master-key')
  })

  it('复制文本一条命令一行，过滤空行', () => {
    expect(stepCopyText({ id: 'x', title: '', desc: '', commands: [' a ', '', 'b'] })).toBe('a\nb')
    expect(stepCopyText({ id: 'x', title: '', desc: '', commands: [] })).toBe('')
  })
})

describe('恢复提示：按产物后缀而非计划配置判断', () => {
  it('.enc 产物判为加密，提示密钥不匹配会被拒绝', () => {
    const h = restoreKeyHint('plan1-123.db.enc', 'panel')
    expect(h.encrypted).toBe(true)
    expect(h.level).toBe('warn')
    expect(h.title).toContain('密钥')
    expect(h.text).toContain('不会覆盖')
  })

  it('后缀大小写不敏感', () => {
    expect(restoreKeyHint('plan1-1.DB.ENC', 'db').encrypted).toBe(true)
  })

  it('明文产物判为未加密，panel 库额外警告密文失效', () => {
    const h = restoreKeyHint('plan1-1.db', 'panel')
    expect(h.encrypted).toBe(false)
    expect(h.level).toBe('danger')
    expect(h.text).toContain('MFA')
    expect(h.text).toContain('restore-db')
  })

  it('站点 / 数据库明文产物不误报为面板库密文问题', () => {
    expect(restoreKeyHint('plan2-1.tar.gz', 'site').text).toContain('可直接恢复')
    expect(restoreKeyHint('plan3-1.sql', 'db').text).toContain('可直接恢复')
  })

  it('空名按明文处理，不抛错', () => {
    expect(() => restoreKeyHint('', 'panel')).not.toThrow()
    expect(restoreKeyHint('', 'panel').encrypted).toBe(false)
  })
})
