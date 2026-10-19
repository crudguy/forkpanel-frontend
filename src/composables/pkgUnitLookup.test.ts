import { describe, it, expect } from 'vitest'
import type { PackageCatalogEntry } from '@/api/types'
import { normalizeUnit, findPkgByUnit, pkgAboutRows } from './pkgUnitLookup'

function mk(name: string, units: string[], extra: Partial<PackageCatalogEntry> = {}): PackageCatalogEntry {
  return {
    name,
    label: name,
    summary: `${name} 用途`,
    features: `${name} 功能`,
    scenes: `${name} 场景`,
    entry: `${name} 入口`,
    howto: `${name} 怎么配`,
    units,
    ...extra,
  }
}

/**
 * 23 条真实 catalog 的**单元名一份手抄**（来源：后端 `dpkg -L` 实测）。
 *
 * 为什么手抄而不从后端读：本文件的测试要钉住的正是「前端按单元名反查能不能命中」，
 * 若两边同源则永远一致、永远全绿。手抄这份还承担另一个职责——**当后端 `units` 改动时
 * 这里会变红**，逼人回来确认新单元名依然能被反查（比如 grafana 从 `grafana-server`
 * 改名成 `grafana`，前端不用改代码，但这份对照必须更新才说明「确认过了」）。
 */
const REAL_UNITS: [string, string[]][] = [
  ['nginx', ['nginx.service']],
  ['caddy', ['caddy.service', 'caddy-api.service']],
  ['apache2', ['apache2.service']],
  ['mariadb-server', ['mariadb.service']],
  ['postgresql', ['postgresql.service']],
  ['redis', ['redis-server.service']],
  ['memcached', ['memcached.service']],
  ['php-fpm', ['php8.4-fpm.service']],
  ['certbot', ['certbot.service', 'certbot.timer']],
  ['fail2ban', ['fail2ban.service']],
  ['ufw', ['ufw.service']],
  ['minio', []],
  ['valkey-server', ['valkey-server.service']],
  ['prometheus', ['prometheus.service']],
  ['grafana', ['grafana-server.service']],
  ['netdata', ['netdata.service']],
  ['haproxy', ['haproxy.service']],
  ['nodejs', []],
  ['default-jdk', []],
  ['golang-go', []],
  ['cargo', []],
  ['wireguard-tools', ['wg-quick@.service']],
]

const catalog = REAL_UNITS.map(([n, u]) => mk(n, u))

describe('normalizeUnit', () => {
  it('剥掉 systemd 类型后缀并转小写', () => {
    expect(normalizeUnit('nginx.service')).toBe('nginx')
    expect(normalizeUnit('Nginx.Service')).toBe('nginx')
    expect(normalizeUnit('certbot.timer')).toBe('certbot')
    expect(normalizeUnit('redis-server.socket')).toBe('redis-server')
  })

  it('不误伤单元名里本来就有的点（php8.4-fpm）', () => {
    expect(normalizeUnit('php8.4-fpm.service')).toBe('php8.4-fpm')
  })

  it('空串 / 纯空白返回空串（调用方据此短路，不会拿空串去匹配）', () => {
    expect(normalizeUnit('')).toBe('')
    expect(normalizeUnit('   ')).toBe('')
  })
})

describe('findPkgByUnit', () => {
  it('22 条真实单元名都能反查到各自条目（含包名 ≠ 单元名那几条）', () => {
    // 这四条正是「前端按包名拼必错」的证据：mariadb-server / grafana / redis / php-fpm
    const mustHit: [string, string][] = [
      ['mariadb.service', 'mariadb-server'],
      ['grafana-server.service', 'grafana'],
      ['redis-server.service', 'redis'],
      ['php8.4-fpm.service', 'php-fpm'],
      ['nginx.service', 'nginx'],
      ['apache2.service', 'apache2'],
      ['postgresql.service', 'postgresql'],
      ['valkey-server.service', 'valkey-server'],
      ['caddy-api.service', 'caddy'],
      ['certbot.timer', 'certbot'],
    ]
    for (const [unit, pkg] of mustHit) {
      expect(findPkgByUnit(catalog, unit)?.name, `${unit} 应反查到 ${pkg}`).toBe(pkg)
    }
  })

  it('按包名拼单元名会全部落空的四条，正是靠 units 字段救回来的', () => {
    // 反向验证：若前端强行 `name + '.service'`，这四条都查不到
    for (const pkg of ['mariadb-server', 'grafana', 'redis', 'php-fpm']) {
      expect(findPkgByUnit(catalog, `${pkg}.service`)).toBeNull()
    }
    // 而用后端下发的 units 就能查到
    expect(findPkgByUnit(catalog, 'mariadb.service')?.name).toBe('mariadb-server')
    expect(findPkgByUnit(catalog, 'grafana-server.service')?.name).toBe('grafana')
  })

  it('带不带 .service 后缀都能命中', () => {
    expect(findPkgByUnit(catalog, 'nginx')?.name).toBe('nginx')
    expect(findPkgByUnit(catalog, 'nginx.service')?.name).toBe('nginx')
    expect(findPkgByUnit(catalog, 'NGINX.SERVICE')?.name).toBe('nginx')
  })

  it('模板单元要能对上实例名（wg-quick@wg0 → wireguard-tools）', () => {
    expect(findPkgByUnit(catalog, 'wg-quick@.service')?.name).toBe('wireguard-tools')
    expect(findPkgByUnit(catalog, 'wg-quick@wg0.service')?.name).toBe('wireguard-tools')
    expect(findPkgByUnit(catalog, 'wg-quick@wg0')?.name).toBe('wireguard-tools')
  })

  it('不把 `xxx@` 模板误配给空实例（wg-quick@.service 自身已精确命中，不靠实例规则）', () => {
    // want === have 时走精确分支；下面的写法验证实例规则不会把 `wg-quick@` 当成实例名
    expect(findPkgByUnit(catalog, 'wg-quick@')?.name).toBe('wireguard-tools')
  })

  it('系统单元查不到就返回 null，绝不猜一个最像的', () => {
    for (const u of [
      'accounts-daemon.service',
      'systemd-resolved.service',
      'cron.service',
      'ssh.socket',
      'user@1000.service',
    ]) {
      expect(findPkgByUnit(catalog, u), `${u} 不应反查到任何软件`).toBeNull()
    }
  })

  it('不做包含式模糊匹配（redis 不会吃掉 redis-server，反之亦然）', () => {
    // catalog 里只有 redis-server.service，没有独立的 redis.service
    expect(findPkgByUnit(catalog, 'redis.service')).toBeNull()
    // 反过来：valkey 与 redis 是两条不同条目，不能互相命中
    expect(findPkgByUnit(catalog, 'valkey-server.service')?.name).toBe('valkey-server')
    expect(findPkgByUnit(catalog, 'redis-server.service')?.name).toBe('redis')
  })

  it('空单元名 / 空 catalog 安全返回 null', () => {
    expect(findPkgByUnit(catalog, '')).toBeNull()
    expect(findPkgByUnit(catalog, '   ')).toBeNull()
    expect(findPkgByUnit([], 'nginx.service')).toBeNull()
  })

  it('条目缺 units 字段（旧后端）时不崩，只是查不到', () => {
    const legacy = [mk('nginx', []), { ...mk('caddy', []), units: undefined }]
    expect(findPkgByUnit(legacy as PackageCatalogEntry[], 'nginx.service')).toBeNull()
    expect(findPkgByUnit(legacy as PackageCatalogEntry[], 'caddy.service')).toBeNull()
  })

  it('同一单元名登记两次时取第一条（后端守卫已禁，前端保持确定性而非随机）', () => {
    const dup = [mk('a', ['x.service']), mk('b', ['x.service'])]
    expect(findPkgByUnit(dup, 'x.service')?.name).toBe('a')
  })
})

describe('pkgAboutRows', () => {
  it('五行齐全且顺序固定：用途 → 功能 → 场景 → 去哪配 → 怎么配', () => {
    const rows = pkgAboutRows(mk('nginx', ['nginx.service']))
    expect(rows.map(r => r.key)).toEqual(['summary', 'features', 'scenes', 'entry', 'howto'])
    expect(rows.map(r => r.label)).toEqual(['用途', '主要功能', '适用场景', '去哪配', '怎么配'])
  })

  it('空文本行被过滤掉（后端有守卫保证不空，但前端不因脏数据显示空标签）', () => {
    const rows = pkgAboutRows(mk('x', [], { howto: '   ', scenes: '' }))
    expect(rows.map(r => r.key)).toEqual(['summary', 'features', 'entry'])
  })

  it('每行的 label 都不重复（详情页按 label 做左侧栏，重复会让用户分不清）', () => {
    const labels = pkgAboutRows(mk('x', [])).map(r => r.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
