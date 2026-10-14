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
 * placeholder 而非报错条（users 的 notReady），或失败要顺带清空列表（backups 清
 * plans / containers 清 lists）。传第二个参数接管 catch，行为与原先各写各的 catch
 * 逐字一致。**有 onError 时它恒被调用（含 silent）**，由它自己决定 silent 时做不
 * 做什么——run 不再替它吞。
 *
 * 可选 opts.silent：**后台静默刷新**（轮询 / 可见性补拉）。true 时 run 完全不碰
 * loading 与 error（不置加载中、不清错、不因失败落错），让轮询不闪骨架、不打扰用户；
 * 需要"轮询成功自愈清错"的视图在 fn 里自己 `if (silent) error.value = ''`。
 * 省略/false 时行为与早期版本逐字一致（对已接管视图零影响）。
 *
 * run 语义：
 * - 非 silent：进入即 error='' + loading=true；finally 恒清 loading（成败都清）。
 * - silent：不置 loading、不清 error；finally 不动 loading。
 * - 异常：有 onError 恒调 onError(e)；否则非 silent 才 error.value = errorText(e)
 *   （silent 且无 onError ⇒ 静默吞掉，交由下一轮轮询自愈）。
 */
export function useAsync(initialLoading = false) {
  const loading = ref(initialLoading)
  const error = ref('')

  async function run(
    fn: () => Promise<unknown>,
    onError?: (e: unknown) => void,
    opts?: { silent?: boolean },
  ): Promise<boolean> {
    const silent = opts?.silent === true
    if (!silent) {
      error.value = ''
      loading.value = true
    }
    try {
      await fn()
      return true
    } catch (e) {
      if (onError) onError(e)
      else if (!silent) error.value = errorText(e)
      return false
    } finally {
      if (!silent) loading.value = false
    }
  }

  return { loading, error, run }
}
