/**
 * Compose 项目 ↔ 容器下钻的纯语义。
 *
 * 为什么单独成文件：这些判定（某项目有几个容器、点开该显示什么、状态串怎么读）
 * 都是**用户直接看得见、写错了却不报错**的逻辑。留在 .vue 里就永远测不了
 * （vitest 只收 src 下的 .test.ts，且本仓库未配 vue 插件）。
 */

/** 容器侧参与判定的最小字段（后端 ContainerSummary 的子集）。 */
export interface ComposableContainer {
  name: string
  state: string
  compose_project?: string | null
  compose_service?: string | null
}

/** 取某个 Compose 项目下的容器。
 *
 *  判据是**项目名精确相等**，不是前缀/包含：`web-stack` 与 `web-stack-old` 是两个
 *  不同项目，用 startsWith 会把它们混在一起（这类静默错误用户只会看到"数量不对"）。 */
export function containersOfProject<T extends ComposableContainer>(
  containers: T[],
  project: string,
): T[] {
  if (!project) return []
  return containers.filter((c) => c.compose_project === project)
}

/** compose `ls` 的 Status 串里括号内的容器数（如 `running(3)` → 3）。
 *
 *  解析不出来就返回 null —— **不要回退成 0**：0 和"不知道"在 UI 上完全是两回事
 *  （0 会让用户以为项目是空的）。compose 的格式在不同版本间略有差异，宁可显示
 *  "—" 也不要编一个数字。 */
export function projectServiceCount(status: string): number | null {
  const m = /\((\d+)\)/.exec(status ?? '')
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** 下钻面板里"项目容器数"与"compose 自报数量"是否一致。
 *
 *  不一致说明**面板看到的容器与 compose 认为的不一样**（典型场景：容器刚被删、
 *  或 compose 项目由另一台机器/另一个 daemon 管理、或 `docker ps` 有过滤）。
 *  这种情况要如实提示，而不是假装一致——这正是本项目"能力位不撒谎"的延伸。 */
export function projectCountMismatch(
  status: string,
  actual: number,
): { declared: number | null; actual: number; differs: boolean } {
  const declared = projectServiceCount(status)
  return {
    declared,
    actual,
    // declared 为 null（格式不认识）时不算不一致：没有可比对的数
    differs: declared !== null && declared !== actual,
  }
}

/** 空态文案：区分"项目里真的没有容器"与"有容器但没拿到"。 */
export function drillEmptyHint(declared: number | null): string {
  if (declared === null) {
    return '未找到该项目的容器。可能是容器已被删除，或它们运行在其他 Docker 守护进程上。'
  }
  if (declared === 0) {
    return '该项目当前没有容器。用 docker compose up 启动后即可在此看到。'
  }
  return `compose 报告该项目有 ${declared} 个容器，但容器列表里没有匹配项。可能是容器刚被删除，或它们运行在其他 Docker 守护进程上。`
}
