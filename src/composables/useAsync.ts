import { ref } from 'vue'
import { errorText } from '@/api/client'

/**
 * 异步加载状态机 —— 把每个列表页重复抄写几十遍的
 * 「loading 置位 + 清错误 + try/catch + errorText 兜底 + finally 清 loading」
 * 收敛到一处。全项目 20+ 个 views 各写一份，行为靠各自记得，容易漂移
 * （漏 finally ⇒ 骨架卡死；漏 errorText ⇒ 把内部英文甩给用户）。
 *
 * 用法：
 *   const { loading, error, run } = useAsync()
 *   function load() {
 *     return run(async () => { rows.value = await api.get(API.x.list()) })
 *   }
 *   onMounted(load)
 *   // 错误态即重试：<button @click="load">重试</button>（load 会再 run 一次）
 *
 * 初始 loading：少数视图首屏就想显示「加载中…」（users 等 ref(true) 起手），
 * 传 useAsync(true)；默认 false（与多数视图一致）。
 *
 * 可选 onError：个别视图对失败有**自定义分流**——如 isUnsupported/占位端点要落到
 * placeholder 而非报错条（users 的 notReady、services 的能力提示）。传第二个参数
 * 接管 catch，行为与原先各写各的 catch 逐字一致；不传则统一 errorText(e) 落到
 * error（含 10009 能力未接入的通用中文兜底）。**保留这条**是因为全量迁移时多数
 * 视图都带 isUnsupported 分支，没有它就无法在不改行为的前提下收敛。
 *
 * run 语义（与视图原 try/catch 对齐）：
 * - 进入即 error='' + loading=true；
 * - await fn() 成功返回 true；异常进 onError（有则）或 errorText→error，返回 false；
 * - finally 恒清 loading——成败都清，骨架绝不卡死（审计里首屏静默卡骨架的大坑）。
 */
export function useAsync(initialLoading = false) {
  const loading = ref(initialLoading)
  const error = ref('')

  async function run(
    fn: () => Promise<unknown>,
    onError?: (e: unknown) => void,
  ): Promise<boolean> {
    error.value = ''
    loading.value = true
    try {
      await fn()
      return true
    } catch (e) {
      if (onError) onError(e)
      else error.value = errorText(e)
      return false
    } finally {
      loading.value = false
    }
  }

  return { loading, error, run }
}
