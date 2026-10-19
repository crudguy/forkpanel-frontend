/**
 * 服务单元名 → 软件说明条目 的反查（服务详情页用）。
 *
 * 要解决的问题：用户在「服务」页点进一个单元（`nginx.service`、`mariadb.service`），
 * 详情页原本只有一行 systemd 的 Description，再加一个「去『软件』页点 ?」的跳转——
 * 等于把他踢到另一个页面，还要求他自己在那 22 个卡片里找到同一个软件再点一次。
 * 说明本来就在手上（`catalog` 已随 `/packages` 下发过），没有理由不在本页直接展开。
 *
 * 为什么不能按包名拼单元名（`name + '.service'`）：包名与单元名**不是同一个字符串**，
 * 差异还没有规律。后端实测（`dpkg -L`）：
 *
 *   mariadb-server → mariadb.service          （包名多 -server，单元名没有）
 *   grafana        → grafana-server.service   （反过来：单元名多 -server）
 *   redis          → redis-server.service     （逻辑名 redis，Debian 包名 redis-server）
 *   php-fpm        → php8.4-fpm.service       （元包无单元，版本号随发行版变）
 *
 * 这四条按包名拼**全部落空**，而且落空是静默的——用户看到的是「这个服务没有软件说明」，
 * 与「这个软件本来就没说明」长得一模一样，无从区分。所以映射必须由后端随 catalog 下发
 * （`PackageCatalogEntry.units`），这里只做纯查找，不做任何模糊猜测。
 *
 * 本模块刻意**不**做「模糊匹配」（比如拿单元名前缀去 startsWith 包名）：`mysql.service`
 * 与 `mysqld.service` 都指向 mariadb 包，模糊匹配会把两个不同单元错误合并；而真正需要
 * 兼容的别名字符串（apache2 ↔ httpd 之类）后端 `units` 里已经写全了。
 */

import type { PackageCatalogEntry } from '@/api/types'

/** 单元名规范化：剥掉 systemd 的类型后缀并转小写，用于跨来源比对。 */
export function normalizeUnit(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replace(/\.(service|socket|timer|target)$/, '')
}

/**
 * 按单元名在 catalog 里反查软件说明条目；找不到返回 `null`。
 *
 * @param catalog `/packages` 的 `catalog`（条目带 `units`）
 * @param unit    当前单元名，带不带 `.service` 后缀均可（列表页给带后缀的，路由参数两者都可能）
 *
 * 匹配规则：`normalizeUnit(条目.units[i]) === normalizeUnit(unit)`，即后缀无关、大小写无关的
 * **精确**比对。不用 `includes`/`startsWith`——`redis` 与 `redis-server` 是两条不同的单元，
 * 用包含关系会让 `redis-server` 同时命中 `redis` 与 `valkey` 这类条目。
 *
 * 模板单元（`wg-quick@.service`、`postgresql@.service`）的另一半情况：实例名形如
 * `wg-quick@wg0.service`，与登记的模板名不相等。这类按「`@` 前半段 + 实例」比对——
 * 面板只有在 catalog 里明写了模板单元时才会这样做，属于后端显式声明，不是前端猜的。
 */
export function findPkgByUnit(
  catalog: readonly PackageCatalogEntry[],
  unit: string,
): PackageCatalogEntry | null {
  const want = normalizeUnit(unit)
  if (!want) return null
  // 模板单元的实例名拆分：`wg-quick@wg0` → 前缀 `wg-quick@`
  for (const entry of catalog) {
    for (const u of entry.units ?? []) {
      const have = normalizeUnit(u)
      if (!have) continue
      if (have === want) return entry
      // 只对**登记时就是模板**的单元（`xxx@`）做实例匹配，且要求实例名非空
      if (have.endsWith('@') && want.startsWith(have) && want.length > have.length) {
        return entry
      }
    }
  }
  return null
}

/**
 * 说明区要展示的行（服务详情页直接渲染，顺序固定）。
 *
 * 为什么在这里定顺序而不是模板里写死：顺序是「先知道是什么 → 再看怎么用 → 最后动手」
 * 的阅读路径，改它属于设计决策，应该有测试盯着而不是散在模板字符串里。
 */
export function pkgAboutRows(entry: PackageCatalogEntry): { key: string; label: string; text: string }[] {
  return [
    { key: 'summary', label: '用途', text: entry.summary },
    { key: 'features', label: '主要功能', text: entry.features },
    { key: 'scenes', label: '适用场景', text: entry.scenes },
    { key: 'entry', label: '去哪配', text: entry.entry },
    { key: 'howto', label: '怎么配', text: entry.howto },
  ].filter(r => r.text.trim() !== '')
}
