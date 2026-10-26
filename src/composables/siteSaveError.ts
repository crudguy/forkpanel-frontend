/**
 * 保存失败 → 「错误该挂在哪里」的决策。
 *
 * ## 为什么从 `.vue` 里抽出来
 * 这段逻辑原先在 `SiteFormDialog.vue` 的 `mapSaveError()` 里，直接读写组件的
 * `fieldErrs` / `formError` / `errSeq` 三个 ref。后果是**它一行都测不了**——
 * vitest 只收 `src/**\/*.test.ts` 且没有 vue 插件，读不到 `.vue`。而这里恰恰是
 * 最容易错、错了又最难发现的地方：
 *
 *  - 后端返回的 `field` 是**下划线命名**（`redirect_target`、`waf.rate_per_sec`），
 *    前端表单字段是驼峰（`redirectTarget`、`wafRate`）。映射表漏一条，用户就只能
 *    看到笼统的"提交内容有误"，后端辛苦给出的具体原因被丢掉。
 *  - `50001` 是路径越界，必须落到「根目录」字段旁——落错地方用户找不到。
 *  - 定位不到字段时才该用通用错误条；反过来会让用户对着一个不存在的字段红字发呆。
 *
 * 抽成纯函数后：输入一个 error，输出「挂哪个字段 / 什么文案」，组件只负责应用，
 * 这张决策表就能被穷举测试（见 `siteSaveError.test.ts`）。
 */
import { BACKEND_FIELD, fieldMsg } from '@/composables/useSiteForm'
import { errorFieldDetail, errorText } from '@/api/client'

/** 决策结果：要么是字段级（挂到某个输入框旁），要么是通用条（弹窗顶部）。 */
export type SaveErrorTarget =
  | {
      kind: 'field'
      /** 表单字段名（与 `fieldErrs` 的键、模板里 `data-f` 一致） */
      key: string
      /** 给用户看的中文说明 */
      message: string
    }
  | {
      kind: 'form'
      /** 挂到通用错误条（归属不到具体输入框） */
      message: string
    }

/**
 * 决定保存失败后错误提示挂在哪。
 *
 * 优先级（顺序即语义，改顺序会改变用户看到的东西）：
 *  1. 后端指名了字段，且我们能把它映射到表单字段 → 挂字段旁（最具体，用户能立刻改）
 *  2. 后端指名了字段，但映射表没这条 → 通用条，并带上后端 reason（不静默丢掉）
 *  3. `50001` 路径越界 → 挂 `root`（本表单唯一的路径输入）
 *  4. 其余（网络 / 未预期异常）→ 通用条
 */
export function resolveSaveError(e: unknown): SaveErrorTarget {
  // **能定位到字段就挂在字段旁**；定位不到（网络/服务端异常）才用通用错误条。
  const fd = errorFieldDetail(e)
  if (fd) {
    const m = BACKEND_FIELD[fd.field]
    if (m) {
      return { kind: 'field', key: m.key, message: fieldMsg(m.msg, fd.reason) }
    }
    // 后端给了字段名但我们没有对应输入框：退回通用条，**保留 reason**。
    return { kind: 'form', message: fieldMsg('提交内容有误，请检查后重试', fd.reason) }
  }
  if ((e as { code?: number } | null)?.code === 50001) {
    // 50001 = 路径越界。本表单里唯一的路径输入就是根目录，落到它旁边。
    return { kind: 'field', key: 'root', message: errorText(e) }
  }
  return { kind: 'form', message: errorText(e) }
}
