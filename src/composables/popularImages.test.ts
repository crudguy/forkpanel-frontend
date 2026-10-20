import { describe, expect, it } from 'vitest'
import {
  CATEGORY_LABEL,
  POPULAR_IMAGES,
  filterPopular,
  groupByCategory,
  isPulled,
  type PopularImage,
} from './popularImages'

const sample: PopularImage[] = [
  { ref: 'nginx', name: 'Nginx', category: 'web', desc: '反向代理' },
  { ref: 'redis', name: 'Redis', category: 'db', desc: '内存缓存' },
  { ref: 'alpine', name: 'Alpine', category: 'base', desc: '极小基础镜像' },
]

describe('filterPopular', () => {
  it('空查询返回全部', () => {
    expect(filterPopular(sample, '')).toHaveLength(3)
    expect(filterPopular(sample, '   ')).toHaveLength(3)
  })
  it('按镜像名匹配（大小写不敏感）', () => {
    expect(filterPopular(sample, 'NGINX').map((i) => i.ref)).toEqual(['nginx'])
  })
  it('按展示名与说明匹配', () => {
    expect(filterPopular(sample, '内存').map((i) => i.ref)).toEqual(['redis'])
    expect(filterPopular(sample, 'Alpine').map((i) => i.ref)).toEqual(['alpine'])
  })
  it('无命中返回空数组', () => {
    expect(filterPopular(sample, 'zzz-not-exist')).toEqual([])
  })
})

describe('groupByCategory', () => {
  it('按 CATEGORY_LABEL 顺序分组，而非数据顺序', () => {
    // 数据顺序 base→db→web，输出必须是 web(dict 顺序第一) 在前
    const shuffled = [sample[2], sample[1], sample[0]]
    const groups = groupByCategory(shuffled)
    expect(groups.map((g) => g.key)).toEqual(['web', 'db', 'base'])
  })

  it('丢弃空分组（过滤后不该留空标题）', () => {
    const groups = groupByCategory([sample[0]])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('web')
  })

  it('未知分类不被静默丢弃', () => {
    const odd: PopularImage[] = [{ ref: 'x', name: 'X', category: 'weird', desc: '' }]
    const groups = groupByCategory(odd)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('weird')
  })
})

describe('isPulled', () => {
  it('同名仓库视为已拉取', () => {
    expect(isPulled('nginx', [{ repository: 'nginx', tag: 'latest' }])).toBe(true)
  })
  it('带 registry 前缀也视为已拉取', () => {
    expect(isPulled('nginx', [{ repository: 'docker.io/library/nginx', tag: '1.27' }])).toBe(true)
    expect(isPulled('myorg/app', [{ repository: 'registry.example.com/myorg/app', tag: 'v1' }])).toBe(true)
  })
  it('不同仓库不算（前缀相似但不同名）', () => {
    expect(isPulled('nginx', [{ repository: 'nginx-proxy', tag: 'latest' }])).toBe(false)
    expect(isPulled('node', [{ repository: 'node-exporter', tag: 'latest' }])).toBe(false)
  })
  it('悬空镜像 <none> 不算', () => {
    expect(isPulled('nginx', [{ repository: '<none>', tag: '<none>' }])).toBe(false)
    expect(isPulled('nginx', [{ repository: 'nginx', tag: '<none>' }])).toBe(false)
  })
  it('空列表返回 false', () => {
    expect(isPulled('nginx', [])).toBe(false)
  })
  it('大小写不敏感', () => {
    expect(isPulled('Nginx', [{ repository: 'nginx', tag: 'latest' }])).toBe(true)
  })
})

describe('内置清单自身', () => {
  it('ref 唯一', () => {
    const refs = POPULAR_IMAGES.map((i) => i.ref)
    expect(new Set(refs).size).toBe(refs.length)
  })
  it('每条的分类都在 CATEGORY_LABEL 里（否则会渲染成一个孤立分组）', () => {
    for (const i of POPULAR_IMAGES) {
      expect(Object.keys(CATEGORY_LABEL)).toContain(i.category)
    }
  })
  it('ref 不含 tag 或空白（tag 由用户在拉取弹窗里确认）', () => {
    for (const i of POPULAR_IMAGES) {
      expect(i.ref).not.toContain(':')
      expect(i.ref.trim()).toBe(i.ref)
    }
  })
})
