import { describe, it, expect } from 'vitest'
import { matchFields } from './listSearch'

describe('matchFields：列表搜索判据', () => {
  it('空串与纯空白都视为「未搜索」，全部放行', () => {
    expect(matchFields('', ['nginx'])).toBe(true)
    expect(matchFields('   ', ['nginx'])).toBe(true)
  })

  it('按子串匹配且不区分大小写', () => {
    expect(matchFields('NGI', ['nginx.service'])).toBe(true)
    expect(matchFields('ngx', ['nginx.service'])).toBe(false)
  })

  it('任一关键字段命中即可，空值字段不报错', () => {
    expect(matchFields('example.com', ['site-a', null, '*.example.com', undefined])).toBe(true)
    expect(matchFields('missing', ['site-a', null, undefined])).toBe(false)
  })

  it('查询词首尾空白不参与匹配', () => {
    expect(matchFields('  web  ', ['web-01'])).toBe(true)
  })

  it('负向对照：字段里的空白与查询词不匹配（不是 trim 字段）', () => {
    expect(matchFields('web', ['  web-01'])).toBe(true)
    expect(matchFields('web01', ['web 01'])).toBe(false)
  })
})
