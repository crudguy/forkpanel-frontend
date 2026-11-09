import { describe, it, expect } from 'vitest'
import { statusDetail, driverText } from './containerStatus'

/**
 * 判据是「界面会不会出现中英重复」与「有用信息会不会被吞掉」两件事，
 * 不是「函数返回什么字符串」——所以每个用例都带 docker 的真实 Status 串。
 */
describe('statusDetail：状态列要不要显示 docker 原始串', () => {
  it.each([
    // 同义状态：徽章已经说完，原始串是纯重复 ⇒ 不显示
    ['created', 'Created'],
    ['dead', 'Dead'],
    ['removing', 'Removing'],
    // 大小写 / 空白不该影响判定（docker 各版本大小写并不统一）
    ['CREATED', '  created '],
  ])('同义状态不显示原始串：%s / %s', (state, status) => {
    expect(statusDetail(state, status)).toBe('')
  })

  it.each([
    // 带运行时长 —— 徽章说不出来，必须留
    ['running', 'Up 3 hours'],
    ['running', 'Up 3 hours (Paused)'],
    // 带退出码与退出时间
    ['exited', 'Exited (0) 33 seconds ago'],
    ['exited', 'Exited (137) 2 days ago'],
    // 带重启次数
    ['restarting', 'Restarting (0) 7 seconds ago'],
    // 罕见但真实：命名的自定义状态，与 state 不同名 ⇒ 留
    ['paused', 'Up 5 minutes (Paused)'],
  ])('有增量信息时保留原始串：%s / %s', (state, status) => {
    expect(statusDetail(state, status)).toBe(status)
  })

  it('status 为空（后端字段缺失）时不渲染空 span', () => {
    expect(statusDetail('created', '')).toBe('')
    expect(statusDetail('running', '   ')).toBe('')
  })
})

/**
 * 网络表的驱动列：docker 对内置 `none` 网络返回的是**字面串** `null`。
 * 判据是「界面上不会出现一个像 bug 的 null」，同时真实驱动不被误伤。
 */
describe('driverText：网络驱动列的展示', () => {
  it.each(['bridge', 'host', 'overlay', 'macvlan'])('真实驱动原样透传：%s', (d) => {
    expect(driverText(d)).toBe(d)
  })

  it('docker 的字面串 null（内置 none 网络）显示破折号，而不是 null', () => {
    expect(driverText('null')).toBe('—')
  })

  it('字段缺失 / 空白同样显示破折号', () => {
    expect(driverText('')).toBe('—')
    expect(driverText('   ')).toBe('—')
  })
})
