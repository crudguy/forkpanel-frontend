/**
 * 灾备清单与恢复密钥提示的纯逻辑（从 BackupsView 抽出，便于单测钉死）。
 *
 * 为什么抽成数据：这三件事是「重装后能不能救回来」的全部前提，而其中一条
 * 是安全边界——面板绝不下发 master.key / ca.key 本体到浏览器，只能给命令。
 * 抽出来后单测可以直接断言「清单里没有任何一步会把密钥内容送进前端」。
 */

export interface ReadinessStep {
  id: string
  title: string
  desc: string
  /** 展示给用户的命令；只复制文本，不在浏览器执行、不回传密钥内容 */
  commands: string[]
  /** 仅面板自签证书用户需要——明确标注，避免所有人误以为必须做 */
  conditional?: boolean
}

export const DR_STEPS: readonly ReadinessStep[] = [
  {
    id: 'artifacts',
    title: '① 备份产物要有异地副本',
    desc: '本机备份扛不住整机故障（磁盘坏、误删、换机器）。请开启计划的远端副本，或把产物拷到另一台机器。',
    commands: [],
  },
  {
    id: 'master-key',
    title: '② 主密钥离线副本（最关键）',
    desc: '面板不会替你下载密钥——请在服务器上执行下面三条命令，把导出的文件存到与备份不同的介质，并记下指纹。',
    commands: [
      'sudo panel key show',
      'sudo panel key export --out /mnt/usb/forkpanel-master.key',
      'sudo panel key check /mnt/usb/forkpanel-master.key',
    ],
  },
  {
    id: 'ca-key',
    title: '③ 自签 CA 私钥（仅用了面板自签证书才需要）',
    desc: 'ca.key 不进任何备份，也不被主密钥加密。先跑第一条命令自查：提示「没有那个文件」说明这台机器没用自签证书，直接跳过本步；文件存在就必须单独拷走，否则恢复后所有本地 HTTPS 站点信任链断掉。',
    commands: [
      'sudo ls -l /var/lib/forkpanel/ssl/ca/ca.key',
      'sudo cp -a /var/lib/forkpanel/ssl/ca/ca.key /mnt/usb/ca.key',
    ],
    conditional: true,
  },
] as const

/** 复制用的纯文本：一条命令一行，空命令不产生空行。 */
export function stepCopyText(s: ReadinessStep): string {
  return s.commands.map((c) => c.trim()).filter(Boolean).join('\n')
}

export type RestoreKeyLevel = 'warn' | 'danger'

export interface RestoreKeyHint {
  encrypted: boolean
  level: RestoreKeyLevel
  title: string
  text: string
}

/**
 * 恢复确认框里的密钥提示。
 *
 * 判据只认**产物名后缀**（`.enc` = 实际加密），不认计划上的 encrypt 配置：
 * 改过配置后，老产物仍可能是另一种形态；拿配置判断会对着 `.db.enc` 说"未加密"。
 */
export function restoreKeyHint(name: string, kind: string): RestoreKeyHint {
  const encrypted = /\.enc$/i.test(name ?? '')
  if (encrypted) {
    return {
      encrypted,
      level: 'warn',
      title: '此产物已加密：主密钥不对会被拒绝',
      text: '恢复时会用当前主密钥解密。如果不是加密它时那把密钥，校验会失败并中止，不会覆盖现有数据。请先确认异地密钥副本可用（panel key check）。',
    }
  }
  return {
    encrypted,
    level: 'danger',
    title: '此产物未加密：恢复不需要密钥',
    text: kind === 'panel'
      ? '面板库请停服后用 panel restore-db 恢复。若密钥不是原来那把，库能打开、也能登录，但数据库口令 / MFA / SSL 私钥会永久失效。'
      : '站点 / 数据库产物可直接恢复。注意面板库自身的密钥另算：若已更换，面板里的数据库连接、MFA、SSL 私钥仍会失效。',
  }
}

/** 灾备卡折叠态的持久化键。存 '0' = 用户主动收起，其余（含缺失）= 展开。 */
export const DR_EXPANDED_KEY = 'backups.drExpanded'

/**
 * 读折叠态。**默认展开**：这是安全提示，首次访问必须看见；
 * 只有用户主动收起才记为 false。读不到（隐私模式 / SSR / node 测试）一律按展开。
 */
export function loadDrExpanded(): boolean {
  try {
    return localStorage.getItem(DR_EXPANDED_KEY) !== '0'
  } catch {
    return true
  }
}

/** 写折叠态。写失败（隐私模式 / 配额满）不影响本次会话的交互。 */
export function saveDrExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(DR_EXPANDED_KEY, expanded ? '1' : '0')
  } catch {
    /* 隐私模式 / 配额：本次会话仍生效，刷新后回默认展开 */
  }
}
