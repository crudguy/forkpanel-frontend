/**
 * 「软件与服务」页软件区的卡片装配纯逻辑（ServicesView.vue 用）。
 *
 * 为什么单独一个模块：这段逻辑原本写在 `ServicesView.vue` 的 `<script setup>` 里，而
 * SFC 里的函数**测不了**（vitest 只收 `src/**\/*.test.ts`，本项目也没装 vue 插件）。
 * 结果就是注释里写着的分组规则、兜底顺序，永远只是承诺 —— 改坏了没人会红。
 * 抽出来之后每条规则都有测试钉住。
 *
 * 本模块刻意**不**持有 `CATEGORIES`（可安装/可卸载包集合）。那份数据留在
 * `ServicesView.vue` 里，是后端仓 `ci/check-pkg-whitelist.sh` 的提取锚点
 * （脚本硬编码了 `FE_SRC=…/src/views/ServicesView.vue`，并正则抽 `pkgs: [...]`）。
 * 一旦搬走，那个 FCC 门禁就会「本地硬失败 / CI 静默跳过」——都属于门禁失效。
 * 所以这里只承接需要传 categories 进来的**派生**，事实源不动。
 *
 * 同理，本模块的 `UNIT_HINTS` 与 CATEGORIES 是两件事，别合并：
 *   · CATEGORIES = 能装什么（后端 ALLOWED_PACKAGES 的投影，由跨仓门禁把守）
 *   · UNIT_HINTS = 装完之后对应哪个 systemd 单元（前端知识，无门禁消费者）
 */

import type { ServiceRef } from '@/api/types'

/**
 * 软件（包）→ 服务（systemd 单元）的候选名。
 *
 * 用户想要的是「装上去的软件能管理」。但**包 ≠ 服务单元，名字也不总一致**：
 * mariadb-server 包对应的是 mariadb.service，apache2 包在 RHEL 上叫 httpd.service，
 * certbot 根本没有常驻服务（它是 certbot.timer 定时器），ufw 也不是靠服务启停来管理。
 * 所以不能假设「每个软件都有服务」去给通用按钮 —— 那等于给用户一批点了必失败的入口。
 *
 * 做法：只在**本机真实服务列表**（svcs）里反查，查到才渲染入口与状态，查不到就不显示。
 *
 * ⚠⚠ **已知落差（2026-10-25 实测确认，尚未修复，等裁决）**：
 * 下面 `certbot: []` / `ufw: []` 两行，注释上说「没有常驻服务可管」，但**它们不产生
 * 任何效果**——因为候选序列恒为 `[包名本身, ...别名]`，登记 `[]` 与根本不登记，
 * `unitCandidates()` 的输出完全一致（都是 `['certbot']`）。要让「此包不关联服务」
 * 真正生效，得有独立的信号（比如一张"无服务"名单），而不是靠"别名表为空"。
 * 现状下两条路径都会给出 unit：
 *   · 主路径：后端 `service_unit()` 对 certbot 跑 `dpkg -L certbot`，Debian trixie
 *     该包确实带 `/usr/lib/systemd/system/certbot.service`（已查 packages.debian.org
 *     文件清单证实），规则 1「stem 与包名一致」直接命中 → `PackageInfo.unit` 非空。
 *   · 兜底路径：本机服务列表里有 `certbot.service` 时，`findServiceUnit` 也会命中。
 * 即：装了 certbot 的用户会看到它的服务状态/启停入口，而那是个由 timer 触发的
 * oneshot 单元，"启停"没有意义。用户可见，但**修它属于改产品行为**，
 * 故本次「抽逻辑」刻意保持等价，只在测试里钉住现状（见 serviceCards.test.ts）。
 *
 * ⚠ 与后端 `PackageCatalogEntry.units`（`crates/panel-api/src/routes/services/packages.rs`
 * 的 `units:` 字段）是**两条独立的数据流**，不要互相替代：
 *   · 后端的 `units` 服务于「服务详情页 → 反查软件说明」（见 pkgUnitLookup.ts），
 *     是包→单元名的**声明**，没有后端的实测状态。
 *   · 本表服务于「软件页卡片 → 去本机服务列表里兜底找一个单元」，是**候选名清单**。
 * 两者会重叠（mariadb、redis-server、apache2 两边都写了），重叠不是 bug ——
 * 缺任一边才会在对应页面上显示不出来。但**改一边不必改另一边**，别当同义词。
 * （对照：pkgUnitLookup.ts 曾写「别名字符串后端 units 里已经写全了」，这句不实 ——
 *   后端 apache2 只登记了 `apache2.service`，本表里的 `httpd` 后端没有。）
 */
export const UNIT_HINTS: Record<string, readonly string[]> = {
  'mariadb-server': ['mariadb', 'mysql', 'mysqld'],
  redis: ['redis-server', 'redis'],
  apache2: ['apache2', 'httpd'],
  certbot: [],   // 靠定时器触发续期，没有常驻服务可管
  ufw: [],       // 规则由「防火墙」页管理
}

/** 候选单元名序列：包名本身优先，再试别名表。顺序即匹配优先级。 */
export function unitCandidates(pkg: string): string[] {
  return [pkg, ...(UNIT_HINTS[pkg] ?? [])]
}

/**
 * 从「本机服务列表」兜底找该软件包对应的服务单元；找不到返回 `null`。
 *
 * 主路径是后端在 `/packages` 里随包下发的 `unit`（绕过 systemctl list-units 对
 * enabled-but-dead 单元的遗漏）；这里是兜底：已运行/已加载的服务也照样能关联。
 *
 * @param pkg  逻辑包名
 * @param svcs 本机服务列表（`ServiceInfo[]`，只要有 name/state 即可）
 *
 * 匹配规则：`s.name === cand + '.service' || s.name === cand`。
 * 后端服务的 name 是完整单元名（带 `.service` 后缀），也兼容无后缀形态。
 * **先试包名本身、再试别名** —— 顺序不能反：`mariadb-server` 若本机真有一个
 * 同名单元，就该命中它，而不是被别名表的 `mariadb` 抢先。
 */
export function findServiceUnit(
  pkg: string,
  svcs: readonly { name: string; state: string }[],
): ServiceRef | null {
  for (const cand of unitCandidates(pkg)) {
    const hit = svcs.find(s => s.name === `${cand}.service` || s.name === cand)
    if (hit) return { name: hit.name, state: hit.state }
  }
  return null
}

/** 分类条目（与 ServicesView 的 CATEGORIES 同形；本模块不持有它）。 */
export interface CatalogGroup {
  key: string
  label: string
  pkgs: readonly string[]
}

/** 已安装包的一条记录（只取本模块用得到的字段，便于构造测试夹具）。 */
export interface InstalledPkg {
  name: string
  /** 后端随包下发的实测单元；缺失时由 fallbackUnit 兜底。 */
  unit?: ServiceRef | null
}

export interface InstalledGroup<T extends InstalledPkg = InstalledPkg> extends CatalogGroup {
  /**
   * 该类别下**确实已安装**的包。
   * `unit: null` 表示该软件没有可管理的服务（如 certbot/ufw）—— UI 据此不渲染入口。
   *
   * 泛型是为了**不收窄**传入的条目类型：模板还要读 `held` / `version` / `manager`
   * 等 PackageInfo 字段，收窄成 InstalledPkg 会让它们全部报 TS2339。
   */
  items: (T & { unit: ServiceRef | null })[]
}

export interface InstallableGroup extends CatalogGroup {
  items: string[]
}

/**
 * 已安装软件按类别分组。
 *
 * 两条顺序约束都是用户可见的，别在重构时弄丢：
 *   1. **类别顺序 = CATEGORIES 的顺序**（展示顺序，不是字典序、也不是后端返回顺序）
 *   2. **组内顺序 = CATEGORIES.pkgs 的顺序**，不是 `pkgs` 列表（接口数据）的顺序 ——
 *      卡片位置必须稳定，否则每轮轮询刷新卡片会跳位。
 * 另外：一个类别下没有任何已装包时，**整类不渲染**（含小标题），否则用户会看到
 * 一排空标题。
 */
export function groupInstalled<T extends InstalledPkg>(
  cats: readonly CatalogGroup[],
  pkgs: readonly T[],
  fallbackUnit: (name: string) => ServiceRef | null,
): InstalledGroup<T>[] {
  return cats
    .map(c => ({
      key: c.key,
      label: c.label,
      pkgs: c.pkgs,
      items: c.pkgs
        .map(n => pkgs.find(x => x.name === n))
        .filter((x): x is T => !!x)
        // 后端下发的实测单元优先（它绕过了 list-units 的遗漏），查不到才兜底
        .map(p => ({ ...p, unit: p.unit ?? fallbackUnit(p.name) })),
    }))
    .filter(c => c.items.length > 0)
}

/** 可安装软件按类别分组：白名单内、且尚未安装的包（同样过滤空类别）。 */
export function groupInstallable(
  cats: readonly CatalogGroup[],
  installedNames: ReadonlySet<string>,
): InstallableGroup[] {
  return cats
    .map(c => ({
      key: c.key,
      label: c.label,
      pkgs: c.pkgs,
      items: c.pkgs.filter(p => !installedNames.has(p)),
    }))
    .filter(c => c.items.length > 0)
}

/** 跨主版本升级确认弹窗的正文（后端对 17→18、20→24 这类强制二次确认）。 */
export interface MajorUpgradePrompt {
  /** 已解析的展示名（不再是原始包名）。 */
  label: string
  from: string
  to: string
  note: string
}

/**
 * 拼装确认文案。
 *
 * ⚠ 这是从 .vue 里**等价**搬来的，刻意没顺手改行为：`note` 直接原样拼在句号后。
 * 后端下发空 note 时，文案会止于「…升级到 v18。」留一个句号 —— 这是个小的文案瑕疵，
 * 但改它属于改产品文案，不该混在「抽逻辑」里做，且改了就没有对得上的基线了。
 * 修它的前提是后端保证 note 非空（目前没这约束）。
 */
export function majorUpgradeDetail(m: MajorUpgradePrompt): string {
  return `将把 ${m.label} 从 v${m.from} 升级到 v${m.to}。${m.note}`
}
