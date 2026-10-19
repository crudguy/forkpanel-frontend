import { describe, it, expect } from 'vitest'
import {
  normalizeDescription, isMeaningfulDescription, looksLikeAppUnit, serviceAbout,
  isUnitNameRestatement,
} from './serviceAbout'

/**
 * 这些规则的现实来源：本机服务的 Description 大量是 LSB 占位或空串。
 * 若直接拼进模板，用户点开详情看到的是「LSB: ...」或者一片空白——
 * 而**页面不报错、类型检查也过**，属静默的信息缺失。这里把判定钉死。
 */
describe('normalizeDescription', () => {
  it('null / undefined / 空白 → 空串（不得渲染成 "null"）', () => {
    expect(normalizeDescription(null)).toBe('')
    expect(normalizeDescription(undefined)).toBe('')
    expect(normalizeDescription('   \n\t ')).toBe('')
  })

  it('压掉换行与连续空白（systemd 描述里偶有多余空白）', () => {
    expect(normalizeDescription('  A high   performance\nweb server '))
      .toBe('A high performance web server')
  })
})

describe('isMeaningfulDescription', () => {
  it('正常描述为真', () => {
    expect(isMeaningfulDescription('A high performance web server')).toBe(true)
    expect(isMeaningfulDescription('Regular background program processing daemon')).toBe(true)
  })

  it('LSB 占位一律判噪声（大小写不敏感，含中文尾部）', () => {
    expect(isMeaningfulDescription('LSB: 启动/停止系统')).toBe(false)
    expect(isMeaningfulDescription('lsb: Early console in setup code')).toBe(false)
    // "LSB " 无冒号形态同样要挡：实测有的包写成 "LSB  Foo"
    expect(isMeaningfulDescription('LSB something')).toBe(false)
  })

  it('description / none / unknown 这类元词也判噪声', () => {
    expect(isMeaningfulDescription('Description')).toBe(false)
    expect(isMeaningfulDescription('none')).toBe(false)
    expect(isMeaningfulDescription('Unknown')).toBe(false)
  })

  it('空串与 null 为假（缺描述不等于有描述）', () => {
    expect(isMeaningfulDescription('')).toBe(false)
    expect(isMeaningfulDescription(null)).toBe(false)
  })
})

/**
 * 实测来源：本机 `firewalld.service` 的 Description 字面量就是 `dead firewalld.service`。
 * 这类"把状态+单元名抄进 Description"的打包方式不算罕见，展示出来用户只会更困惑
 * ——"说明"里写着 dead xxx.service，看着像页面坏了。
 */
describe('isUnitNameRestatement', () => {
  it('状态词 + 单元名 → 复述（噪声）', () => {
    expect(isUnitNameRestatement('dead firewalld.service', 'firewalld.service')).toBe(true)
    expect(isUnitNameRestatement('fastgithub', 'fastgithub.service')).toBe(true)
    expect(isUnitNameRestatement('auto-cpufreq.service', 'auto-cpufreq.service')).toBe(true)
  })

  it('真描述不算复述', () => {
    expect(isUnitNameRestatement('A high performance web server', 'nginx.service')).toBe(false)
    expect(isUnitNameRestatement('Docker Application Container Engine', 'docker.service')).toBe(false)
    // 描述里含单元名但还有别的词 → 不算复述
    expect(isUnitNameRestatement('Nginx HTTP server', 'nginx.service')).toBe(false)
  })

  it('空描述不算复述（由空判据负责，别在这里重复判）', () => {
    expect(isUnitNameRestatement('', 'nginx.service')).toBe(false)
    expect(isUnitNameRestatement(null, 'nginx.service')).toBe(false)
  })
})

describe('looksLikeAppUnit', () => {  it('真实软件单元为真', () => {
    for (const u of ['nginx.service', 'mariadb.service', 'redis-server.service',
      'docker.service', 'php8.4-fpm.service', 'wg-quick@wg0.service']) {
      expect(looksLikeAppUnit(u)).toBe(true)
    }
  })

  it('发行版内部组件为假（不给"点了没结果"的入口）', () => {
    for (const u of ['systemd-journald.service', 'dbus.service', 'polkit.service',
      'accounts-daemon.service', 'cron.service', 'user@1000.service', 'udev.service']) {
      expect(looksLikeAppUnit(u)).toBe(false)
    }
  })

  it('前缀判据对 .socket / .timer 同样生效', () => {
    expect(looksLikeAppUnit('systemd-resolved.socket' as string)).toBe(false)
    expect(looksLikeAppUnit('nginx.socket' as string)).toBe(true)
  })

  it('空单元名为假（不崩）', () => {
    expect(looksLikeAppUnit('')).toBe(false)
    expect(looksLikeAppUnit('.service')).toBe(false)
  })
})

describe('serviceAbout', () => {
  it('有描述：原文展示，标记来源为 systemd，不给回退提示', () => {
    const a = serviceAbout('A high performance web server', 'nginx.service')
    expect(a.text).toBe('A high performance web server')
    expect(a.fromSystemd).toBe(true)
    expect(a.hint).toBe('')
  })

  it('无描述：给出非空文案 + 明确说明面板没有它的说明（不能是空白）', () => {
    const a = serviceAbout(null, 'accounts-daemon.service')
    // 关键断言：**永远非空**。留空会让用户以为页面坏了
    expect(a.text.length).toBeGreaterThan(0)
    expect(a.fromSystemd).toBe(false)
    expect(a.hint).toContain('accounts-daemon.service')
    expect(a.hint).toContain('面板没有')
  })

  it('LSB 噪声按"没有描述"处理，且不把 LSB 原文塞进 hint', () => {
    const a = serviceAbout('LSB: 启动/停止系统', 'cron.service')
    expect(a.fromSystemd).toBe(false)
    expect(a.text).not.toContain('LSB')
    expect(a.hint).not.toContain('LSB')
  })

  it('复述单元名的描述也走"没有描述"分支（实机 firewalld 就是这样）', () => {
    const a = serviceAbout('dead firewalld.service', 'firewalld.service')
    expect(a.fromSystemd).toBe(false)
    // 关键：不能把 "dead xxx.service" 当作说明展示
    expect(a.text).not.toContain('dead')
    expect(a.hint).toContain('firewalld.service')
  })
})
