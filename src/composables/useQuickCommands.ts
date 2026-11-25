/**
 * 终端快捷命令的数据层（服务端存储，按登录用户隔离，跨设备）。
 *
 * 职责边界：这里只管「命令清单」——预置项、自定义项的读写与校验；命令如何送进
 * 终端（WebSocket 二进制帧）由 TerminalView 负责，本模块不碰 WS。
 *
 * 自定义命令存在服务端 `user_quick_commands`，按 `user_id` 隔离；预置命令仍是
 * 前端常量，不入库。读只在打开浮层时触发一次，写后 reload 列表取 id（服务端的
 * create 不返回 id）。
 *
 * ⚠ 服务端响应同样视为不可信：字段缺失 / 超长 / 内嵌换行的记录必须归一掉，
 * 不能让一条坏数据把整个浮层打不开，更不能把换行带进 shell 输入。
 */
import { ref, type Ref } from 'vue'
import { api, ValidationError } from '@/api/client'
import { API } from '@/api/endpoints'

export interface QuickCommand {
  id: string
  /** 列表里显示的短名，如「仓库状态」 */
  label: string
  /** 真正送进 PTY 的命令文本（单行） */
  cmd: string
  /** 一行说明 */
  desc: string
  /** 预置项不可编辑/删除 */
  builtin?: boolean
}

export const PRESET_COMMANDS: readonly QuickCommand[] = [
  { id: 'p_pwd', label: '当前目录', cmd: 'pwd', desc: '显示当前工作目录', builtin: true },
  { id: 'p_ls', label: '列出文件', cmd: 'ls -la', desc: '列出全部文件（含隐藏项）', builtin: true },
  { id: 'p_cdup', label: '上级目录', cmd: 'cd ..', desc: '返回上一级目录', builtin: true },
  { id: 'p_gitstatus', label: '仓库状态', cmd: 'git status', desc: '查看 Git 工作区状态', builtin: true },
  { id: 'p_gitlog', label: '最近提交', cmd: 'git log --oneline -10', desc: '最近 10 条提交记录', builtin: true },
  { id: 'p_df', label: '磁盘占用', cmd: 'df -h', desc: '查看各分区磁盘占用', builtin: true },
  { id: 'p_free', label: '内存占用', cmd: 'free -h', desc: '查看内存与交换分区', builtin: true },
  { id: 'p_clear', label: '清屏', cmd: 'clear', desc: '清空终端当前屏幕', builtin: true },
]

export interface QuickCommandInput {
  label: string
  cmd: string
  desc?: string
}

const MAX_LABEL = 40
const MAX_CMD = 500
const MAX_DESC = 80

/**
 * 表单校验：返回面向用户的错误文案，合法返回 null。与后端 check_input 同规则。
 * `takenLabels` 由视图传入（预置 + 同用户已有命令，编辑态已排除自身）；后端另有
 * 按 user_id 的查重兜底，两处文案必须一致。
 */
export function validateQuickCommand(
  input: QuickCommandInput,
  takenLabels?: ReadonlySet<string>,
): string | null {
  const label = (input.label ?? '').trim()
  const cmd = (input.cmd ?? '').trim()
  const desc = (input.desc ?? '').trim()
  if (!label) return '请填写名称'
  if (label.length > MAX_LABEL) return `名称最多 ${MAX_LABEL} 个字符`
  if (takenLabels?.has(label)) return '名称已存在，请换一个'
  if (!cmd) return '请填写命令'
  if (/[\r\n\0]/.test(cmd)) return '命令必须是单行，不能包含换行'
  if (cmd.length > MAX_CMD) return `命令最多 ${MAX_CMD} 个字符`
  if (desc.length > MAX_DESC) return `说明最多 ${MAX_DESC} 个字符`
  return null
}

/**
 * 把服务端返回的任意值归一成合法清单。
 * 纯函数，便于单测把「坏数据不进 UI」钉死，而不依赖浏览器环境。
 */
export function normalizeCustomCommands(raw: unknown): QuickCommand[] {
  if (!Array.isArray(raw)) return []
  const out: QuickCommand[] = []
  const seen = new Set<string>()
  const usedLabels = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    // 服务端 id 是自增整数；字符串 id（含伪造的预置 id）一律当脏数据丢弃，
    // 否则删除时会拿它拼出永远 404 的 URL。
    if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id <= 0) continue
    const id = String(o.id)
    if (!id || seen.has(id)) continue
    const candidate: QuickCommandInput = {
      label: typeof o.label === 'string' ? o.label : '',
      cmd: typeof o.cmd === 'string' ? o.cmd : '',
      desc: typeof o.desc === 'string' ? o.desc : '',
    }
    if (validateQuickCommand(candidate)) continue
    if (PRESET_COMMANDS.some((p) => p.id === id)) continue
    const label = candidate.label.trim()
    // 服务端已查重；这里再挡一层历史脏数据，否则浮层里两条同名仍会让用户误解。
    if (usedLabels.has(label)) continue
    usedLabels.add(label)
    seen.add(id)
    out.push({
      id,
      label,
      cmd: candidate.cmd.trim(),
      desc: (candidate.desc ?? '').trim(),
    })
  }
  return out
}

function guard(input: QuickCommandInput) {
  const err = validateQuickCommand(input)
  if (err) throw new ValidationError(err)
}

export interface QuickCommandsApi {
  custom: Ref<QuickCommand[]>
  loading: Ref<boolean>
  load: () => Promise<void>
  add: (input: QuickCommandInput) => Promise<void>
  update: (id: string, input: QuickCommandInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

/** 视图侧唯一入口：所有变更走 API，成功后重新拉列表拿最新 id。 */
export function useQuickCommands(): QuickCommandsApi {
  const custom = ref<QuickCommand[]>([])
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      const data = await api.get<unknown>(API.quickCommands.list())
      custom.value = normalizeCustomCommands(data)
    } finally {
      loading.value = false
    }
  }

  async function add(input: QuickCommandInput) {
    guard(input)
    await api.post(API.quickCommands.list(), input)
    await load()
  }

  async function update(id: string, input: QuickCommandInput) {
    guard(input)
    await api.patch(API.quickCommands.item(id), input)
    await load()
  }

  async function remove(id: string) {
    await api.del(API.quickCommands.item(id))
    await load()
  }

  return { custom, loading, load, add, update, remove }
}
