import { describe, it, expect } from 'vitest'
import {
  validatePortInput, isSamePort, portSummary, riskNotice, canSubmit,
  changeMessage, SSH_PORT_CONFIRM_WORD,
  type SshPortState, type SshPortChange,
} from './sshPort'

function state(over: Partial<SshPortState> = {}): SshPortState {
  return {
    effective: 22, explicit: true, source_file: '/etc/ssh/sshd_config',
    configured: [22], sshd_present: true, ...over,
  }
}

function change(over: Partial<SshPortChange> = {}): SshPortChange {
  return {
    changed: true, effective: 2222, target_file: '/etc/ssh/sshd_config.d/00-panel-port.conf',
    backup: '/etc/ssh/sshd_config.d/00-panel-port.conf.panel.bak-1',
    validated: true, listening_ports: [22, 2222], next_steps: [], ...over,
  }
}

describe('validatePortInput', () => {
  it('接受合法端口', () => {
    expect(validatePortInput('2222', 22)).toBe('')
    expect(validatePortInput('1', 22)).toBe('')
    expect(validatePortInput('65535', 22)).toBe('')
  })

  it('空输入给出明确提示', () => {
    expect(validatePortInput('', 22)).toBe('请输入端口号')
    expect(validatePortInput('   ', 22)).toBe('请输入端口号')
  })

  it('拒绝非纯数字：Number() 能接受但 sshd 不认的写法', () => {
    // 这几种在 Number() 下都"是数字"，若放过，用户会以为改成了另一个端口
    expect(validatePortInput('0x16', 22)).toContain('纯数字')
    expect(validatePortInput('2_222', 22)).toContain('纯数字')
    expect(validatePortInput('+22', 22)).toContain('纯数字')
    expect(validatePortInput('22.0', 22)).toContain('纯数字')
    expect(validatePortInput('二二', 22)).toContain('纯数字')
  })

  it('越界端口被拒', () => {
    expect(validatePortInput('0', 22)).toContain('1-65535')
    expect(validatePortInput('65536', 22)).toContain('1-65535')
    expect(validatePortInput('99999', 22)).toContain('1-65535')
  })

  it('与当前端口相同时提示无需修改', () => {
    expect(validatePortInput('22', 22)).toContain('无需修改')
    expect(validatePortInput(' 22 ', 22)).toContain('无需修改')
  })

  it('读不到现状（current=null）时不判重复', () => {
    expect(validatePortInput('22', null)).toBe('')
  })
})

describe('isSamePort', () => {
  it('只在有现状且完全相同时为真', () => {
    expect(isSamePort('22', 22)).toBe(true)
    expect(isSamePort(' 22 ', 22)).toBe(true)
    expect(isSamePort('2222', 22)).toBe(false)
    expect(isSamePort('22', null)).toBe(false)
  })
})

describe('portSummary', () => {
  it('未读到配置时如实说未读到', () => {
    expect(portSummary(null)).toContain('未读取到')
  })

  it('没有 sshd 时直接说明本机无 SSH', () => {
    const s = portSummary(state({ sshd_present: false }))
    expect(s).toContain('未检测到 SSH')
    expect(s).toContain('无意义')
  })

  it('显式配置时带出来源文件', () => {
    const s = portSummary(state({ effective: 2222, source_file: '/etc/ssh/sshd_config.d/00-panel-port.conf' }))
    expect(s).toContain('2222')
    expect(s).toContain('00-panel-port.conf')
  })

  it('非显式配置时必须说明走的是编译默认', () => {
    const s = portSummary(state({ effective: 22, explicit: false, configured: [] }))
    expect(s).toContain('编译默认')
  })

  it('多端口监听必须如实披露，不能只报生效值', () => {
    // 这是「我改成 2222 了但 22 还在听」的认知偏差源头
    const s = portSummary(state({ effective: 2222, configured: [2222, 22] }))
    expect(s).toContain('另有端口')
    expect(s).toContain('22')
    expect(s).toContain('也在监听')
  })

  it('单端口时不画蛇添足', () => {
    const s = portSummary(state({ effective: 22, configured: [22] }))
    expect(s).not.toContain('另有端口')
  })
})

describe('riskNotice', () => {
  it('必须说清两件事：连接会断、防火墙要放行', () => {
    const s = riskNotice()
    expect(s).toContain('断开')
    expect(s).toContain('防火墙')
    expect(s).toContain('回退')
  })
})

describe('canSubmit', () => {
  it('三项条件缺一不可', () => {
    expect(canSubmit('2222', 22, SSH_PORT_CONFIRM_WORD)).toBe(true)
    expect(canSubmit('2222', 22, '')).toBe(false)                  // 没输确认词
    expect(canSubmit('2222', 22, '确认')).toBe(false)               // 近似词
    expect(canSubmit('22', 22, SSH_PORT_CONFIRM_WORD)).toBe(false)  // 与现状相同
    expect(canSubmit('0', 22, SSH_PORT_CONFIRM_WORD)).toBe(false)   // 非法端口
  })

  it('确认词容忍首尾空白但仍须逐字一致', () => {
    expect(canSubmit('2222', 22, '  确认改端口  ')).toBe(true)
  })
})

describe('changeMessage', () => {
  it('未改动时如实说未改动', () => {
    expect(changeMessage(change({ changed: false, effective: 22 }))).toContain('未做改动')
  })

  it('无额外动作时只报结果与备份', () => {
    const m = changeMessage(change({ next_steps: [], backup: '/b' }))
    expect(m).toContain('2222')
    expect(m).toContain('/b')
    expect(m).not.toContain('还需')
  })

  it('有 next_steps 时必须逐条带出（否则用户会被锁在门外）', () => {
    const m = changeMessage(change({
      next_steps: ['防火墙放行 TCP 2222', '重启 SSH 服务'],
    }))
    expect(m).toContain('还需')
    expect(m).toContain('防火墙放行 TCP 2222')
    expect(m).toContain('重启 SSH 服务')
  })

  it('没有备份文件时不显示 null', () => {
    const m = changeMessage(change({ backup: null, next_steps: [] }))
    expect(m).not.toContain('null')
    expect(m).toContain('2222')
  })
})
