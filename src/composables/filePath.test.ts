import { describe, it, expect } from 'vitest'
import {
  normalizePath, baseName, parentPath, joinPath, dirLabel,
  buildCrumbs, buildAllowedCrumbs, collapseCrumbs, enclosingRoot, isOctalMode, isWithinRoots, type Crumb,
} from './filePath'

describe('normalizePath', () => {
  it('去尾斜杠', () => {
    expect(normalizePath('/a/')).toBe('/a')
    expect(normalizePath('/a/b/')).toBe('/a/b')
  })
  it('根与空串都是 /（空串当根，不是当空）', () => {
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('')).toBe('/')
    expect(normalizePath('///')).toBe('/')
  })
  it('无尾斜杠时原样返回', () => {
    expect(normalizePath('/a/b')).toBe('/a/b')
  })
})

describe('baseName', () => {
  it('取最后一段', () => {
    expect(baseName('/a/b')).toBe('b')
    expect(baseName('/a/b/')).toBe('b')
  })
  it('根路径返回 / 而不是空串（供调用方判"已在根"）', () => {
    expect(baseName('/')).toBe('/')
    expect(baseName('')).toBe('/')
  })
})

describe('parentPath', () => {
  it('逐级向上', () => {
    expect(parentPath('/a/b/c')).toBe('/a/b')
    expect(parentPath('/a/b/')).toBe('/a')
  })
  it('到顶一律停在 /，不返回空串', () => {
    expect(parentPath('/a')).toBe('/')
    expect(parentPath('/')).toBe('/')
    expect(parentPath('')).toBe('/')
  })
})

describe('joinPath', () => {
  it('普通目录拼接', () => {
    expect(joinPath('/a', 'x')).toBe('/a/x')
    expect(joinPath('/a/', 'x')).toBe('/a/x')
  })
  it('★根目录下拼接不得出现 //（目录树按路径字符串做 key，//bin 与 /bin 是两个值）', () => {
    expect(joinPath('/', 'bin')).toBe('/bin')
    expect(joinPath('', 'bin')).toBe('/bin')
    expect(joinPath('/', 'bin')).not.toContain('//')
  })
})

describe('dirLabel', () => {
  it('取目录名做标签', () => {
    expect(dirLabel('/var/log')).toBe('log')
    expect(dirLabel('/var/log/')).toBe('log')
  })
  it('根目录有专用文案', () => {
    expect(dirLabel('/')).toBe('根目录')
    expect(dirLabel('')).toBe('根目录')
  })
})

describe('buildCrumbs', () => {
  it('根目录只有一段，且显示 / 而非「根目录」（避免与标签页标题重复）', () => {
    expect(buildCrumbs('/')).toEqual([{ label: '/', to: '/' }])
    expect(buildCrumbs('')).toEqual([{ label: '/', to: '/' }])
  })
  it('逐段拼回绝对路径（前端不解析 ..）', () => {
    expect(buildCrumbs('/a/b')).toEqual([
      { label: '根目录', to: '/' },
      { label: 'a', to: '/a' },
      { label: 'b', to: '/a/b' },
    ])
  })
  it('尾斜杠不影响分段', () => {
    expect(buildCrumbs('/a/b/')).toEqual(buildCrumbs('/a/b'))
  })
})

describe('白名单路径判断', () => {
  it('空白名单 = 不限制目录（owner 默认态）', () => {
    expect(isWithinRoots('/etc/shadow', [])).toBe(true)
    expect(enclosingRoot('/etc', [])).toBe('/')
  })

  it('按组件边界比较：/home 放行自身与子目录，不放行同前缀兄弟', () => {
    expect(isWithinRoots('/home', ['/home'])).toBe(true)
    expect(isWithinRoots('/home/a/b', ['/home'])).toBe(true)
    // ★负向对照：裸 startsWith 会把 /homework 误判为授权，这里必须挡住
    expect('/homework'.startsWith('/home')).toBe(true)
    expect(isWithinRoots('/homework', ['/home'])).toBe(false)
    expect(isWithinRoots('/home2/a', ['/home'])).toBe(false)
  })

  it('尾斜杠归一化；授权 / 等于整个文件系统', () => {
    expect(isWithinRoots('/home/a', ['/home/'])).toBe(true)
    expect(isWithinRoots('/home', ['/home/'])).toBe(true)
    expect(isWithinRoots('/var/log', ['/'])).toBe(true)
    expect(enclosingRoot('/var/log', ['/'])).toBe('/')
  })

  it('enclosingRoot 取最长匹配根；越界返回 null', () => {
    expect(enclosingRoot('/home/a/b', ['/home', '/home/a'])).toBe('/home/a')
    expect(enclosingRoot('/var/log', ['/home', '/home/a'])).toBeNull()
    expect(enclosingRoot('/homework', ['/home'])).toBeNull()
  })
})

describe('buildAllowedCrumbs（白名单内导航）', () => {
  it('★白名单无 / 时不得生成 to:/ 的根面包屑', () => {
    const r = buildAllowedCrumbs('/home/a/b', ['/home'])
    expect(r).toEqual([
      { label: 'home', to: '/home' },
      { label: 'a', to: '/home/a' },
      { label: 'b', to: '/home/a/b' },
    ])
    expect(r.some((c) => c.to === '/')).toBe(false)
    // 负向对照：旧版 buildCrumbs 必然给出可点的根目录
    expect(buildCrumbs('/home/a/b')[0].to).toBe('/')
  })

  it('停在授权根时只有一段（没有可点的上级，符合「不要让用户点到根目录」）', () => {
    expect(buildAllowedCrumbs('/home', ['/home'])).toEqual([{ label: 'home', to: '/home' }])
  })

  it('越界路径保留可点的「回到授权目录」锚点，不让用户困在错误页', () => {
    const r = buildAllowedCrumbs('/etc', ['/home'])
    expect(r[0]).toEqual({ label: 'home', to: '/home' })
    expect(r[1]).toEqual({ label: 'etc', to: '/etc' })
  })

  it('多根时从最长根开始；授权 / 时与旧版逐项一致', () => {
    expect(buildAllowedCrumbs('/home/a/b', ['/home', '/home/a'])[0].to).toBe('/home/a')
    expect(buildAllowedCrumbs('/a/b', ['/'])).toEqual(buildCrumbs('/a/b'))
    expect(buildAllowedCrumbs('/', ['/'])).toEqual(buildCrumbs('/'))
  })
})

const deep = (n: number): Crumb[] => buildCrumbs('/' + Array.from({ length: n }, (_, i) => `s${i}`).join('/'))

describe('collapseCrumbs', () => {
  it('不超过阈值时原样返回（引用相等，调用方据此不做额外处理）', () => {
    const c = deep(3)
    expect(collapseCrumbs(c, 6)).toBe(c)
  })
  it('超阈值时中段折成一个可点的 …', () => {
    const c = deep(8) // 根 + 8 段 = 9
    const r = collapseCrumbs(c, 6)
    expect(r).toHaveLength(6)
    expect(r[2].label).toBe('…')
  })
  it('★折叠段落在第 2 段（一段真实存在的路径），不是凭空造的', () => {
    const c = deep(8)
    const r = collapseCrumbs(c, 6)
    expect(r[2].to).toBe(c[1].to)
    expect(r[2].to).toBe('/s0')
  })
  it('首尾都保住：根 + 第一级 + … + 末三级', () => {
    const c = deep(8)
    const r = collapseCrumbs(c, 6)
    expect(r[0]).toBe(c[0])
    expect(r[1]).toBe(c[1])
    expect(r.slice(3)).toEqual(c.slice(-3))
  })
  it('空面包屑不越界', () => {
    expect(collapseCrumbs([], 6)).toEqual([])
  })
})

describe('isOctalMode', () => {
  it('3-4 位八进制', () => {
    expect(isOctalMode('644')).toBe(true)
    expect(isOctalMode('0755')).toBe(true)
  })
  it('两侧空白不算错（输入框里常见）', () => {
    expect(isOctalMode('  644 ')).toBe(true)
  })
  it('非八进制数字 / 位数不符 / 非数字一律拒绝', () => {
    expect(isOctalMode('888')).toBe(false)
    expect(isOctalMode('64')).toBe(false)
    expect(isOctalMode('06445')).toBe(false) // 5 位：chmod 不收
    expect(isOctalMode('abc')).toBe(false)
    expect(isOctalMode('')).toBe(false)
  })
})
