import { describe, expect, it } from 'vitest'
import {
  containersOfProject,
  drillEmptyHint,
  projectCountMismatch,
  projectServiceCount,
  type ComposableContainer,
} from './composeDrill'

function c(name: string, project: string | null, state = 'running'): ComposableContainer {
  return { name, state, compose_project: project, compose_service: 'web' }
}

describe('containersOfProject', () => {
  it('只取项目名精确相等的容器', () => {
    const list = [c('a-1', 'web-stack'), c('b-1', 'other'), c('x', null)]
    const got = containersOfProject(list, 'web-stack')
    expect(got.map((x) => x.name)).toEqual(['a-1'])
  })

  it('前缀相同不算同一项目（web-stack vs web-stack-old）', () => {
    const list = [c('a-1', 'web-stack'), c('a-2', 'web-stack-old')]
    expect(containersOfProject(list, 'web-stack').map((x) => x.name)).toEqual(['a-1'])
    expect(containersOfProject(list, 'web-stack-old').map((x) => x.name)).toEqual(['a-2'])
  })

  it('空项目名返回空（不返回整个列表）', () => {
    const list = [c('a-1', 'web-stack'), c('b-1', null)]
    expect(containersOfProject(list, '')).toEqual([])
  })

  it('null 项目的容器不会被任何项目收走', () => {
    const list = [c('loose', null)]
    expect(containersOfProject(list, 'anything')).toEqual([])
  })
})

describe('projectServiceCount', () => {
  it('解析 running(3)', () => {
    expect(projectServiceCount('running(3)')).toBe(3)
  })
  it('解析多段退出态 exited(2)', () => {
    expect(projectServiceCount('exited(2)')).toBe(2)
  })
  it('解析运行+退出混合', () => {
    expect(projectServiceCount('running(1), exited(2)')).toBe(1)
  })
  it('解析不出来返回 null 而不是 0', () => {
    expect(projectServiceCount('running')).toBeNull()
    expect(projectServiceCount('')).toBeNull()
    expect(projectServiceCount(undefined as unknown as string)).toBeNull()
  })
})

describe('projectCountMismatch', () => {
  it('数量一致不算不一致', () => {
    const r = projectCountMismatch('running(2)', 2)
    expect(r.declared).toBe(2)
    expect(r.actual).toBe(2)
    expect(r.differs).toBe(false)
  })

  it('数量不一致要如实报出来', () => {
    const r = projectCountMismatch('running(3)', 1)
    expect(r.differs).toBe(true)
  })

  it('status 解析不出数字时不算不一致（没有可比对的数）', () => {
    const r = projectCountMismatch('unknown', 5)
    expect(r.declared).toBeNull()
    expect(r.differs).toBe(false)
  })

  it('实际为 0 而 compose 说 3 ⇒ 必须报不一致', () => {
    const r = projectCountMismatch('running(3)', 0)
    expect(r.differs).toBe(true)
  })
})

describe('drillEmptyHint', () => {
  it('compose 说 0 个：说"确实没有容器"，并给下一步', () => {
    const h = drillEmptyHint(0)
    expect(h).toContain('当前没有容器')
    expect(h).toContain('docker compose up')
  })

  it('compose 说 N 个但拿到 0：提示可能是别的 daemon 或已删除', () => {
    const h = drillEmptyHint(3)
    expect(h).toContain('3')
    expect(h).toContain('其他 Docker 守护进程')
  })

  it('不知道数量：不编造数字', () => {
    const h = drillEmptyHint(null)
    expect(h).toContain('未找到')
    expect(h).not.toContain('0 个')
  })
})
