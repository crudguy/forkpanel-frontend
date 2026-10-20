/**
 * 常用镜像清单（内置，供「镜像」Tab 快速起步）。
 *
 * ## 为什么只有镜像名、不写版本 tag
 * ① 面板二进制内置清单，**不联网校验**——写死 `nginx:1.27-alpine` 这类 tag 无法验证
 *    是否仍存在，且必然随时间过时，用户点了拉不到只会以为面板坏了；
 * ② `latest` 对某些镜像（mysql/mongo 等）有跨大版本兼容风险。
 * 所以这里只给**镜像名**，点「拉取」时把它预填进拉取弹窗，tag 由用户当场确认或修改。
 *
 * ## 诚实边界
 * 这不是"官方认证清单"，也不是 Docker Hub 的镜像市场：不显示 star/下载量/官方标记
 * （那些都需要联网），只是编者按常见用途挑的一组名字。清单内容变更需发版。
 */

export interface PopularImage {
  /** 镜像名（不含 tag），如 `nginx` */
  ref: string
  /** 展示名 */
  name: string
  /** 分类键，见 CATEGORY_LABEL */
  category: string
  /** 一句话用途说明 */
  desc: string
}

/** 分类顺序即展示顺序 */
export const CATEGORY_LABEL: Record<string, string> = {
  web: 'Web 服务',
  db: '数据库与缓存',
  runtime: '运行时',
  infra: '运维工具',
  monitor: '监控',
  base: '基础镜像',
}

export const POPULAR_IMAGES: PopularImage[] = [
  { ref: 'nginx', name: 'Nginx', category: 'web', desc: '反向代理 / 静态站点服务器' },
  { ref: 'httpd', name: 'Apache httpd', category: 'web', desc: '经典 Apache Web 服务器' },
  { ref: 'caddy', name: 'Caddy', category: 'web', desc: '自动 HTTPS 的 Web 服务器' },
  { ref: 'traefik', name: 'Traefik', category: 'web', desc: '容器感知的反向代理' },

  { ref: 'mysql', name: 'MySQL', category: 'db', desc: '关系型数据库' },
  { ref: 'mariadb', name: 'MariaDB', category: 'db', desc: 'MySQL 兼容分支' },
  { ref: 'postgres', name: 'PostgreSQL', category: 'db', desc: '功能完整的关系型数据库' },
  { ref: 'mongo', name: 'MongoDB', category: 'db', desc: '文档型 NoSQL 数据库' },
  { ref: 'redis', name: 'Redis', category: 'db', desc: '内存键值库 / 缓存' },
  { ref: 'memcached', name: 'Memcached', category: 'db', desc: '纯内存缓存' },

  { ref: 'node', name: 'Node.js', category: 'runtime', desc: 'JavaScript 运行时' },
  { ref: 'python', name: 'Python', category: 'runtime', desc: 'Python 运行时' },
  { ref: 'openjdk', name: 'OpenJDK', category: 'runtime', desc: 'Java 运行时' },
  { ref: 'golang', name: 'Go', category: 'runtime', desc: 'Go 编译与运行环境' },
  { ref: 'php', name: 'PHP', category: 'runtime', desc: 'PHP 运行时（含 FPM）' },

  { ref: 'adminer', name: 'Adminer', category: 'infra', desc: '单文件数据库管理界面' },
  { ref: 'phpmyadmin', name: 'phpMyAdmin', category: 'infra', desc: 'MySQL/MariaDB 网页管理' },
  { ref: 'portainer', name: 'Portainer', category: 'infra', desc: 'Docker 图形管理界面' },
  { ref: 'registry', name: 'Docker Registry', category: 'infra', desc: '自建镜像仓库' },
  { ref: 'minio', name: 'MinIO', category: 'infra', desc: 'S3 兼容对象存储' },
  { ref: 'rabbitmq', name: 'RabbitMQ', category: 'infra', desc: '消息队列' },

  { ref: 'grafana', name: 'Grafana', category: 'monitor', desc: '指标可视化面板' },
  { ref: 'prometheus', name: 'Prometheus', category: 'monitor', desc: '指标采集与时序库' },
  { ref: 'uptime-kuma', name: 'Uptime Kuma', category: 'monitor', desc: '站点可用性监控' },

  { ref: 'alpine', name: 'Alpine', category: 'base', desc: '极小基础镜像（约 8MB）' },
  { ref: 'busybox', name: 'BusyBox', category: 'base', desc: '精简工具集' },
  { ref: 'hello-world', name: 'Hello World', category: 'base', desc: '验证 Docker 是否可用的最小镜像' },
]

/** 按名称/说明过滤（大小写不敏感）。空查询返回原列表。 */
export function filterPopular(list: PopularImage[], query: string): PopularImage[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (i) => i.ref.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || i.desc.includes(q),
  )
}

/** 按分类分组，**保持 CATEGORY_LABEL 的顺序**（而不是按数据出现顺序），
 *  并丢弃空分组（过滤后某类可能一条不剩，否则会留下一个空标题）。 */
export function groupByCategory(list: PopularImage[]): { key: string; label: string; items: PopularImage[] }[] {
  const order = Object.keys(CATEGORY_LABEL)
  const out: { key: string; label: string; items: PopularImage[] }[] = []
  for (const key of order) {
    const items = list.filter((i) => i.category === key)
    if (items.length) out.push({ key, label: CATEGORY_LABEL[key] ?? key, items })
  }
  // 兜底：数据里出现未知分类时不能静默丢弃
  for (const i of list) {
    if (!order.includes(i.category)) {
      const g = out.find((x) => x.key === i.category)
      if (g) g.items.push(i)
      else out.push({ key: i.category, label: i.category, items: [i] })
    }
  }
  return out
}

/** 判断某镜像是否已在本地（任一 tag 存在即算）。
 *
 *  ⚠ 不能只比 `repository === ref`：docker 会把官方镜像显示成 `nginx`，
 *  但用户显式拉过 `docker.io/library/nginx` 时 repository 可能带前缀。
 *  故同时接受「以 `/ref` 结尾」的形态。 */
export function isPulled(ref: string, local: { repository: string; tag: string }[]): boolean {
  const target = ref.toLowerCase()
  return local.some((i) => {
    const repo = (i.repository ?? '').toLowerCase()
    // `<none>` 是悬空镜像，不代表这个 ref 存在
    if (!repo || repo === '<none>' || i.tag === '<none>') return false
    return repo === target || repo.endsWith(`/${target}`)
  })
}
