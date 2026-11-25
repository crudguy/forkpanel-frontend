/**
 * 终端快捷命令的数据层。
 *
 * 职责边界：这里只管「命令清单」——预置项、自定义项、校验与浏览器本地持久化；
 * 命令如何送进终端（WebSocket 二进制帧）由 TerminalView 负责，本模块不碰 WS。
 *
 * 为什么存 localStorage 而不是后端：自定义命令是**浏览器本地的操作偏好**，和主题、
 * 列宽、折叠态同类；不涉及宿主权限、不跨设备共享，也不该进审计/备份链路。
 *  localStorage 的键只在本模块定义，避免散落到视图里。
 *
 * ⚠ localStorage 是用户可改的：脏数据（非数组 / 缺字段 / 超长 / 内嵌换行）必须在
 *  读取时归一，不能让一条坏记录把整个面板打不开，更不能把换行带进 shell 输入。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

export interface QuickCommand {
  id: string
  /** 列表里显示的短名，如「仓库状态」 */
  label: string
  /** 真正送进 PTY 的命令文本（单行） */
  cmd: string
  /** 一行说明，仅用于列表 hover/副标题 */
  desc: string
  /** 预置项不可编辑/删除 */
  builtin?: boolean
}

export const LS_KEY = 'forkpanel.terminal.quick-commands'
const MAX_CUSTOM = 50
const MAX_LABEL = 40
const MAX_CMD = 500
const MAX_DESC = 80

/** 预置命令：低频高危动作不预置（不帮用户一键执行 rm / reboot 之类）。 */
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

/**
 * 表单校验：返回面向用户的错误文案，合法返回 null。
 * 拒绝换行——粘贴进 PTY 的多行文本会被 shell 逐行执行，一键填充不该变成一键执行。
 */
export function validateQuickCommand(input: QuickCommandInput): string | null {
  const label = (input.label ?? '').trim()
  const cmd = (input.cmd ?? '').trim()
  const desc = (input.desc ?? '').trim()
  if (!label) return '请填写名称'
  if (label.length > MAX_LABEL) return `名称最多 ${MAX_LABEL} 个字符`
  if (!cmd) return '请填写命令'
  if (/[\r\n\0]/.test(cmd)) return '命令必须是单行，不能包含换行'
  if (cmd.length > MAX_CMD) return `命令最多 ${MAX_CMD} 个字符`
  if (desc.length > MAX_DESC) return `说明最多 ${MAX_DESC} 个字符`
  return null
}

/**
 * 把 localStorage 里的任意值归一成合法清单。
 * 纯函数，便于单测把「坏数据不进 UI」钉死，而不依赖浏览器环境。
 */
export function normalizeCustomCommands(raw: unknown): QuickCommand[] {
  if (!Array.isArray(raw)) return []
  const out: QuickCommand[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) continue
    if (seen.has(o.id)) continue
    const candidate: QuickCommandInput = {
      label: typeof o.label === 'string' ? o.label : '',
      cmd: typeof o.cmd === 'string' ? o.cmd : '',
      desc: typeof o.desc === 'string' ? o.desc : '',
    }
    if (validateQuickCommand(candidate)) continue
    // 预置 id 被伪造进自定义清单时，直接丢弃——否则分组里会出现两个同名 id。
    if (PRESET_COMMANDS.some((p) => p.id === o.id)) continue
    seen.add(o.id)
    out.push({
      id: o.id,
      label: candidate.label.trim(),
      cmd: candidate.cmd.trim(),
      desc: (candidate.desc ?? '').trim(),
    })
    if (out.length >= MAX_CUSTOM) break
  }
  return out
}

function readFromStorage(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    return normalizeCustomCommands(JSON.parse(raw))
  } catch {
    return []
  }
}

export interface QuickCommandsApi {
  custom: Ref<QuickCommand[]>
  all: ComputedRef<QuickCommand[]>
  add: (input: QuickCommandInput) => QuickCommand | null
  update: (id: string, input: QuickCommandInput) => boolean
  remove: (id: string) => boolean
}

/** 视图侧唯一入口：响应式清单 + 变更后立即落盘。 */
export function useQuickCommands(): QuickCommandsApi {
  const custom = ref<QuickCommand[]>(readFromStorage())

  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(custom.value))
    } catch {
      // 隐私模式 / 配额满：本次会话内仍然可用，只是刷新后丢失
    }
  }

  function makeId(): string {
    return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  function add(input: QuickCommandInput): QuickCommand | null {
    if (validateQuickCommand(input)) return null
    if (custom.value.length >= MAX_CUSTOM) return null
    const cmd: QuickCommand = {
      id: makeId(),
      label: input.label.trim(),
      cmd: input.cmd.trim(),
      desc: (input.desc ?? '').trim(),
    }
    custom.value.push(cmd)
    persist()
    return cmd
  }

  function update(id: string, input: QuickCommandInput): boolean {
    if (validateQuickCommand(input)) return false
    const i = custom.value.findIndex((c) => c.id === id)
    if (i < 0) return false
    custom.value[i] = {
      id,
      label: input.label.trim(),
      cmd: input.cmd.trim(),
      desc: (input.desc ?? '').trim(),
    }
    persist()
    return true
  }

  function remove(id: string): boolean {
    const i = custom.value.findIndex((c) => c.id === id)
    if (i < 0) return false
    custom.value.splice(i, 1)
    persist()
    return true
  }

  const all = computed(() => [...PRESET_COMMANDS, ...custom.value])

  return { custom, all, add, update, remove }
}
