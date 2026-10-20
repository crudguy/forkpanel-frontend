import { describe, expect, it } from 'vitest'
import {
  draftError,
  emptyServiceDraft,
  fromServicePayload,
  projectError,
  splitCommand,
  splitList,
  toServicePayload,
  type ServiceDraft,
} from './stackForm'

describe('splitList', () => {
  it('按逗号切分并 trim', () => {
    expect(splitList('8080:80, 443:443')).toEqual(['8080:80', '443:443'])
  })
  it('也接受换行分隔', () => {
    expect(splitList('a\nb,c')).toEqual(['a', 'b', 'c'])
  })
  it('丢弃空项与纯空白', () => {
    expect(splitList('a, ,\n, b')).toEqual(['a', 'b'])
    expect(splitList('')).toEqual([])
    expect(splitList('   ')).toEqual([])
  })
  it('不切分值内部的冒号（端口映射）', () => {
    expect(splitList('22:22')).toEqual(['22:22'])
  })
})

describe('splitCommand', () => {
  it('按行切分，保留参数内空格', () => {
    // 关键场景：`daemon off;` 是一个参数，不能被空格拆开
    expect(splitCommand('nginx\n-g\ndaemon off;')).toEqual(['nginx', '-g', 'daemon off;'])
  })
  it('丢弃空行', () => {
    expect(splitCommand('sh\n\n-c\n  echo hi  \n')).toEqual(['sh', '-c', 'echo hi'])
  })
})

describe('toServicePayload', () => {
  it('完整映射并 trim', () => {
    const d: ServiceDraft = {
      name: ' web ',
      image: ' nginx:1.27-alpine ',
      commandText: 'nginx\n-g\ndaemon off;',
      portsText: '8080:80',
      envText: 'FOO=bar, BAZ=1',
      volumesText: 'data:/data',
      restart: 'unless-stopped',
      memLimit: '512m',
    }
    expect(toServicePayload(d)).toEqual({
      name: 'web',
      image: 'nginx:1.27-alpine',
      command: ['nginx', '-g', 'daemon off;'],
      ports: ['8080:80'],
      env: ['FOO=bar', 'BAZ=1'],
      volumes: ['data:/data'],
      restart: 'unless-stopped',
      mem_limit: '512m',
    })
  })

  it('空的可选项应传 null 而不是空串', () => {
    // 空串会被后端当成非法重启策略 / 非法内存上限
    const p = toServicePayload(emptyServiceDraft())
    expect(p.restart).toBeNull()
    expect(p.mem_limit).toBeNull()
  })
})

describe('fromServicePayload', () => {
  it('与 toServicePayload 往返一致', () => {
    const payload = {
      name: 'web',
      image: 'nginx:1.27-alpine',
      command: ['nginx', '-g', 'daemon off;'],
      ports: ['8080:80'],
      env: ['FOO=bar'],
      volumes: ['data:/data'],
      restart: 'always',
      mem_limit: '1g',
    }
    expect(toServicePayload(fromServicePayload(payload))).toEqual(payload)
  })

  it('null 的可选项回填成空串（表单里显示为空）', () => {
    const d = fromServicePayload({
      name: 'w', image: 'i', command: [], ports: [], env: [], volumes: [],
      restart: null, mem_limit: null,
    })
    expect(d.restart).toBe('')
    expect(d.memLimit).toBe('')
  })
})

describe('draftError', () => {
  it('缺少服务名报错', () => {
    expect(draftError({ ...emptyServiceDraft(), image: 'nginx' })).toContain('服务名')
  })
  it('服务名以 - 开头报错', () => {
    expect(draftError({ ...emptyServiceDraft(), name: '-x', image: 'nginx' })).toContain('服务名非法')
  })
  it('缺少镜像报错', () => {
    expect(draftError({ ...emptyServiceDraft(), name: 'web' })).toContain('镜像')
  })
  it('环境变量缺少等号报错', () => {
    const d = { ...emptyServiceDraft(), name: 'w', image: 'i', envText: 'NOEQ' }
    expect(draftError(d)).toContain('KEY=VALUE')
  })
  it('合法服务返回 null', () => {
    const d = { ...emptyServiceDraft(), name: 'web', image: 'nginx', envText: 'FOO=1' }
    expect(draftError(d)).toBeNull()
  })
})

describe('projectError', () => {
  it('拒绝空、前导 - 与非法字符', () => {
    expect(projectError('')).not.toBeNull()
    expect(projectError('-p')).not.toBeNull()
    expect(projectError('a b')).not.toBeNull()
    expect(projectError('a/b')).not.toBeNull()
  })
  it('接受常见项目名', () => {
    expect(projectError('web-stack')).toBeNull()
    expect(projectError('my_app.v2')).toBeNull()
  })
})
