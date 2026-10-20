/**
 * 编排表单的纯逻辑：表单态（多行/逗号分隔的文本框） ↔ 后端 `ComposeStackService`。
 *
 * 为什么单独成文件：这些转换是"用户看得见、写错了不报错"的典型——
 * 少切一个逗号、多留一个空行，结果就是 compose 里多一个空服务参数。
 * 留在 .vue 里永远测不了（vitest 只收 .test.ts，本仓库未配 vue 插件）。
 */

/** 单个服务的表单态。列表类字段用文本输入，提交前才切分成数组。 */
export interface ServiceDraft {
  name: string;
  image: string;
  /** 每行一个参数（命令参数可能含空格，不能用空格切） */
  commandText: string;
  /** 逗号或换行分隔 */
  portsText: string;
  /** 逗号或换行分隔，KEY=VALUE */
  envText: string;
  /** 逗号或换行分隔 */
  volumesText: string;
  restart: string;
  memLimit: string;
}

/** 后端服务结构（与 openapi ComposeStackService 一致） */
export interface StackServicePayload {
  name: string;
  image: string;
  command: string[];
  ports: string[];
  env: string[];
  volumes: string[];
  restart?: string | null;
  mem_limit?: string | null;
}

export function emptyServiceDraft(): ServiceDraft {
  return {
    name: '', image: '', commandText: '',
    portsText: '', envText: '', volumesText: '',
    restart: '', memLimit: '',
  }
}

/** 按逗号/换行切分，去空白、丢空项。
 *
 *  ⚠ 不用单纯的 `split(',')`：用户习惯在逗号后加空格或换行，
 *  不 trim 会得到 `" 8080:80"` 这种带前导空格的值，后端会判端口格式非法。 */
export function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 命令按**行**切分（不是按空格）：`["nginx", "-g", "daemon off;"]` 里
 *  最后一个参数本身含空格，按空格切会把它拆成两个参数。 */
export function splitCommand(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function toServicePayload(d: ServiceDraft): StackServicePayload {
  return {
    name: d.name.trim(),
    image: d.image.trim(),
    command: splitCommand(d.commandText),
    ports: splitList(d.portsText),
    env: splitList(d.envText),
    volumes: splitList(d.volumesText),
    // 空串表示"不设置"——传空串会让后端当成非法重启策略
    restart: d.restart.trim() ? d.restart.trim() : null,
    mem_limit: d.memLimit.trim() ? d.memLimit.trim() : null,
  }
}

export function fromServicePayload(s: StackServicePayload): ServiceDraft {
  return {
    name: s.name,
    image: s.image,
    commandText: (s.command ?? []).join('\n'),
    portsText: (s.ports ?? []).join(', '),
    envText: (s.env ?? []).join(', '),
    volumesText: (s.volumes ?? []).join(', '),
    restart: s.restart ?? '',
    memLimit: s.mem_limit ?? '',
  }
}

/** 提交前的**本地预检**（后端仍会强制校验，这里只是让用户少一次往返）。
 *
 *  返回第一条错误的中文说明；没有问题返回 null。
 *  ⚠ 不要在这里"顺手"放宽规则：两边口径不一致会让用户以为改对了。 */
export function draftError(d: ServiceDraft): string | null {
  if (!d.name.trim()) return '服务名不能为空'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d.name.trim())) {
    return `服务名非法：${d.name.trim()}（只能用字母数字与 . _ -，且不能以 - 开头）`
  }
  if (!d.image.trim()) return '镜像不能为空'
  for (const e of splitList(d.envText)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) {
      return `环境变量必须是 KEY=VALUE：${e}`
    }
  }
  return null
}

/** 项目名预检（与后端 validate_compose_project 同口径）。 */
export function projectError(project: string): string | null {
  const p = project.trim()
  if (!p) return '项目名不能为空'
  if (p.startsWith('-')) return '项目名不能以 - 开头'
  if (!/^[A-Za-z0-9._-]+$/.test(p)) return '项目名只能包含字母、数字与 . _ -'
  return null
}
