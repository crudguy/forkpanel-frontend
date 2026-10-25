import { describe, it, expect } from 'vitest'
import {
  UNIT_HINTS,
  unitCandidates,
  findServiceUnit,
  groupInstalled,
  groupInstallable,
  majorUpgradeDetail,
  type CatalogGroup,
  type InstalledPkg,
} from './serviceCards'

/** 造一条服务记录；本模块只关心 name/state。 */
const svc = (name: string, state = 'active') => ({ name, state })

/** 造一个最小分类表（结构照 ServicesView 的 CATEGORIES，规模缩小以便断言顺序）。 */
const cats = (...spec: [string, string, string[]][]): CatalogGroup[] =>
  spec.map(([key, label, pkgs]) => ({ key, label, pkgs }))

/** 造一条已安装包记录。 */
const pkg = (name: string, unit?: { name: string; state: string } | null): InstalledPkg =>
  unit === undefined ? { name } : { name, unit }

describe('findServiceUnit：包名 → 本机服务单元', () => {
  it('包名本身带 .service 后缀时直接命中', () => {
    expect(findServiceUnit('nginx', [svc('nginx.service')])).toEqual({
      name: 'nginx.service',
      state: 'active',
    })
  })

  it('服务列表给无后缀形态时也能命中', () => {
    expect(findServiceUnit('nginx', [svc('nginx')])?.name).toBe('nginx')
  })

  it('★ 包名本身落空时走别名表（mariadb-server → mariadb.service）', () => {
    // 反例：本机只有 mariadb.service，若不做别名兜底，mariadb-server 卡片就
    // 永远没有启停入口 —— 而它恰恰是白名单里最常用的数据库。
    const hit = findServiceUnit('mariadb-server', [svc('mariadb.service')])
    expect(hit).toEqual({ name: 'mariadb.service', state: 'active' })
  })

  it('★ 包名本身存在时优先于别名（不被别名表的 mariadb 抢先）', () => {
    // 别名表给 mariadb-server 排了 ['mariadb','mysql','mysqld']。若先试别名，
    // 本机真有 mariadb-server.service 时会命中 mariadb.service —— 那是另一个单元。
    const hit = findServiceUnit('mariadb-server', [
      svc('mariadb.service', 'inactive'),
      svc('mariadb-server.service', 'active'),
    ])
    expect(hit).toEqual({ name: 'mariadb-server.service', state: 'active' })
  })

  it('别名表内也按顺序取第一个命中（httpd 是 apache2 在 RHEL 上的名字）', () => {
    expect(findServiceUnit('apache2', [svc('httpd.service')])?.name).toBe('httpd.service')
  })

  it('★ 没有任何候选命中时返回 null（不臆造单元名）', () => {
    // 反过来才是致命的：拿包名拼一个「应该有」的单元名给用户点，点了必失败。
    expect(findServiceUnit('nginx', [svc('caddy.service')])).toBeNull()
    expect(findServiceUnit('nginx', [])).toBeNull()
  })

  it('⚠ 已知落差：别名表登记为空，并不阻止包名本身参与匹配（certbot / ufw）', () => {
    // 注释写的是「certbot 靠定时器、ufw 不靠服务启停」，但候选序列恒含包名本身，
    // 故 `UNIT_HINTS.certbot = []` 与不登记 certbot 的行为完全一致 —— 那两行目前
    // 是「假控制」：看着在表达规则，实际没被任何代码读成规则（详见 serviceCards.ts 顶注释）。
    //
    // 这里钉住的是**当前实际行为**，不是期望行为：
    //   · 一旦真去实现「此包不关联服务」，下面三条必须一起翻转 —— 它们就是验收点；
    //   · 若只改了 UNIT_HINTS 或只改了匹配式，会立刻红，避免半改。
    expect(unitCandidates('certbot')).toEqual(['certbot'])
    expect(findServiceUnit('certbot', [svc('certbot.service')])).toEqual({
      name: 'certbot.service',
      state: 'active',
    })
    expect(findServiceUnit('ufw', [svc('ufw.service')])).toEqual({
      name: 'ufw.service',
      state: 'active',
    })
  })

  it('不因名称相近而误命中（redis 不会命中 valkey-server）', () => {
    expect(findServiceUnit('redis', [svc('valkey-server.service')])).toBeNull()
  })

  it('带出的是本机真实状态，不是别名表里的东西', () => {
    expect(findServiceUnit('redis', [svc('redis-server.service', 'failed')])?.state).toBe('failed')
  })
})

describe('unitCandidates：候选名序列', () => {
  it('包名本身排第一', () => {
    expect(unitCandidates('redis')[0]).toBe('redis')
  })

  it('别名表缺失的包只回包名本身', () => {
    expect(unitCandidates('nginx')).toEqual(['nginx'])
  })

  it('★ 别名表登记过的包会带上全部别名', () => {
    expect(unitCandidates('mariadb-server')).toEqual([
      'mariadb-server', 'mariadb', 'mysql', 'mysqld',
    ])
  })

  it('★ 别名表里的候选名都不带 .service 后缀（后缀由 findServiceUnit 统一补）', () => {
    // 若哪天有人在 UNIT_HINTS 里写成 'mariadb.service'，就会拼出 'mariadb.service.service'。
    for (const list of Object.values(UNIT_HINTS)) {
      for (const c of list) expect(c.endsWith('.service')).toBe(false)
    }
  })
})

describe('groupInstalled：已装软件按类别分组', () => {
  it('★ 类别顺序 = CATEGORIES 的顺序（展示顺序，非字典序）', () => {
    const cs = cats(['runtime', '运行环境', ['nodejs']], ['web', 'Web 服务', ['nginx']])
    const out = groupInstalled(cs, [pkg('nginx'), pkg('nodejs')], () => null)
    expect(out.map(c => c.key)).toEqual(['runtime', 'web'])
  })

  it('★ 组内顺序 = CATEGORIES.pkgs 的顺序，而非接口返回的顺序', () => {
    // 反例：接口先返回 caddy 后返回 nginx，若按接口顺序排，每轮轮询卡片都会跳位。
    const cs = cats(['web', 'Web 服务', ['nginx', 'caddy']])
    const out = groupInstalled(cs, [pkg('caddy'), pkg('nginx')], () => null)
    expect(out[0].items.map(p => p.name)).toEqual(['nginx', 'caddy'])
  })

  it('★ 空类别整类不渲染（连小标题一起）', () => {
    const cs = cats(['web', 'Web 服务', ['nginx']], ['db', '数据库', ['postgresql']])
    const out = groupInstalled(cs, [pkg('nginx')], () => null)
    expect(out.map(c => c.key)).toEqual(['web'])
  })

  it('★ 后端下发的实测 unit 优先于前端兜底', () => {
    // 后端 unit 绕过了 systemctl list-units 对 enabled-but-dead 单元的遗漏，
    // 兜底只应在它缺失时顶上 —— 顺序反了会拿旧状态盖掉准确的。
    const cs = cats(['db', '数据库', ['postgresql']])
    const fromApi = { name: 'postgresql.service', state: 'active' }
    const out = groupInstalled(cs, [pkg('postgresql', fromApi)], () => ({
      name: '兜底.service',
      state: 'inactive',
    }))
    expect(out[0].items[0].unit).toEqual(fromApi)
  })

  it('后端 unit 缺失时由兜底补上', () => {
    const cs = cats(['db', '数据库', ['mariadb-server']])
    const out = groupInstalled(
      cs,
      [pkg('mariadb-server', null)],
      () => ({ name: 'mariadb.service', state: 'active' }),
    )
    expect(out[0].items[0].unit).toEqual({ name: 'mariadb.service', state: 'active' })
  })

  it('★ 兜底也找不到时 unit 为 null（UI 据此不渲染入口，而不是渲染个必失败的）', () => {
    const cs = cats(['sec', '安全', ['certbot']])
    const out = groupInstalled(cs, [pkg('certbot', null)], () => null)
    expect(out[0].items[0].unit).toBeNull()
  })

  it('未在 CATEGORIES 里的已装包不出现（白名单外不渲染）', () => {
    const cs = cats(['web', 'Web 服务', ['nginx']])
    const out = groupInstalled(cs, [pkg('nginx'), pkg('curl')], () => null)
    expect(out[0].items.map(p => p.name)).toEqual(['nginx'])
  })

  it('一个都没装时返回空数组', () => {
    const cs = cats(['web', 'Web 服务', ['nginx']])
    expect(groupInstalled(cs, [], () => null)).toEqual([])
  })

  it('不改动传入的分类表与包对象（返回的是新数组）', () => {
    const cs = cats(['web', 'Web 服务', ['nginx']])
    const src = [pkg('nginx')]
    groupInstalled(cs, src, () => null)
    expect(src[0]).toEqual({ name: 'nginx' })
    expect(cs[0].pkgs).toEqual(['nginx'])
  })
})

describe('groupInstallable：可安装软件按类别分组', () => {
  it('已安装的包被排除', () => {
    const cs = cats(['web', 'Web 服务', ['nginx', 'caddy']])
    const out = groupInstallable(cs, new Set(['nginx']))
    expect(out[0].items).toEqual(['caddy'])
  })

  it('★ 全类都装满时返回空数组（而不是一堆空类别）', () => {
    const cs = cats(['web', 'Web 服务', ['nginx']], ['db', '数据库', ['postgresql']])
    expect(groupInstallable(cs, new Set(['nginx', 'postgresql']))).toEqual([])
  })

  it('★ 空类别被过滤，但保留 CATEGORIES 的原顺序', () => {
    const cs = cats(['web', 'Web 服务', ['nginx']], ['db', '数据库', ['postgresql']])
    const out = groupInstallable(cs, new Set(['nginx']))
    expect(out.map(c => c.key)).toEqual(['db'])
  })

  it('组内仍按 CATEGORIES.pkgs 的顺序', () => {
    const cs = cats(['web', 'Web 服务', ['nginx', 'caddy', 'haproxy']])
    const out = groupInstallable(cs, new Set(['caddy']))
    expect(out[0].items).toEqual(['nginx', 'haproxy'])
  })
})

describe('majorUpgradeDetail：跨主版本确认文案', () => {
  it('拼出「从 vX 升级到 vY」并附上后端 note', () => {
    expect(
      majorUpgradeDetail({ label: 'PostgreSQL', from: '17', to: '18', note: '需先备份数据目录' }),
    ).toBe('将把 PostgreSQL 从 v17 升级到 v18。需先备份数据目录')
  })

  it('note 为空时以句号收尾（记录现状：留了个孤零零的句号）', () => {
    expect(majorUpgradeDetail({ label: 'Node.js', from: '20', to: '24', note: '' })).toBe(
      '将把 Node.js 从 v20 升级到 v24。',
    )
  })

  it('★ note 首尾空白必须原样保留（等价搬运：实现刻意不 trim）', () => {
    // 夹具要能区分「trim / 不 trim」——用空串 note 的话两边结果一样，断言恒绿。
    // 抽逻辑不该顺手改产品文案：谁哪天加了 trim，这条立刻红。
    expect(
      majorUpgradeDetail({ label: 'PostgreSQL', from: '17', to: '18', note: ' 需先备份 ' }),
    ).toBe('将把 PostgreSQL 从 v17 升级到 v18。 需先备份 ')
  })

  it('用展示名而非原始包名（label 在调用方已解析）', () => {
    expect(majorUpgradeDetail({ label: '数据库', from: '17', to: '18', note: 'x' })).toContain(
      '将把 数据库 从',
    )
  })
})
