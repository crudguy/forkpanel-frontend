import { describe, it, expect } from 'vitest'
import { filterEntries, filterHint, normalizeQuery, type FilterableEntry } from './fileFilter'

const mk = (name: string, kind = 'file'): FilterableEntry => ({ name, kind, sensitive: false })

const ENTRIES: FilterableEntry[] = [
  mk('boot', 'dir'),
  mk('etc', 'dir'),
  mk('README.md'),
  mk('deploy.sh'),
  mk('Dockerfile'),
]

describe('normalizeQuery', () => {
  it('trim + 小写', () => {
    expect(normalizeQuery('  DockerFILE  ')).toBe('dockerfile')
  })
  it('纯空白规范化为空串（= 不过滤）', () => {
    expect(normalizeQuery('   ')).toBe('')
    expect(normalizeQuery('\t\n')).toBe('')
  })
})

describe('filterEntries', () => {
  it('空查询返回入参本身（引用相等，供调用方判「无过滤」）', () => {
    expect(filterEntries(ENTRIES, '')).toBe(ENTRIES)
    expect(filterEntries(ENTRIES, '   ')).toBe(ENTRIES)
  })

  it('大小写不敏感的子串匹配', () => {
    const r = filterEntries(ENTRIES, 'docker')
    expect(r.map((e) => e.name)).toEqual(['Dockerfile'])
  })

  it('中段子串也能命中（不是前缀匹配）', () => {
    const r = filterEntries(ENTRIES, 'eadm')
    expect(r.map((e) => e.name)).toEqual(['README.md'])
  })

  it('多命中时保持原顺序（只筛选、不排序）', () => {
    // 原顺序：boot(d) etc(d) README deploy Dockerfile
    const r = filterEntries(ENTRIES, 'e')
    expect(r.map((e) => e.name)).toEqual(['etc', 'README.md', 'deploy.sh', 'Dockerfile'])
  })

  it('目录也被匹配（不区分 kind）', () => {
    const r = filterEntries(ENTRIES, 'bo')
    expect(r.map((e) => e.name)).toEqual(['boot'])
  })

  it('无命中返回空数组', () => {
    expect(filterEntries(ENTRIES, 'zzz')).toEqual([])
  })

  it('不修改入参', () => {
    const before = ENTRIES.map((e) => e.name)
    filterEntries(ENTRIES, 'e')
    expect(ENTRIES.map((e) => e.name)).toEqual(before)
  })
})

describe('filterHint', () => {
  it('无查询时不提示', () => {
    expect(filterHint(5, 5, '')).toBe('')
    expect(filterHint(5, 5, '  ')).toBe('')
  })

  it('0 命中给出「没有匹配」，而不是报筛掉多少', () => {
    expect(filterHint(24, 0, 'zzz')).toBe('没有匹配「zzz」的文件或文件夹')
  })

  it('全部命中如实说「全部匹配」', () => {
    expect(filterHint(3, 3, 'e')).toBe('共 3 项，全部匹配')
  })

  it('部分命中给出 显示/总数（用户要知道被筛掉了多少）', () => {
    expect(filterHint(24, 3, ' conf ')).toBe('已按「conf」筛选：显示 3 / 24 项')
  })
})
