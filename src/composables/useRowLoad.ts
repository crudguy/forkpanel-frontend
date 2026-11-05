import type { Ref } from 'vue'
import { errorText } from '@/api/client'
import { useAsync } from '@/composables/useAsync'

/**
 * 列表 Tab 的加载动作 = `useAsync` 的状态机 + 三条**列表页固定策略**。
 *
 * 容器页拆成 6 个 Tab 后，每个 Tab 都手写了一遍
 * 「非 silent 置 loading → 成功清错 → 失败就清列表 + 落 errorText → silent 成功自愈清错」。
 * 六份的写法还不一样：网络/卷 Tab 没有 silent 分支，容器/镜像/资源 Tab 有；"成功清错"
 * 有的写在 `try` 里、有的写在 `if (silent)` 分支里。这层差异没有任何理由——它只是抄写
 * 时的手感，而手感会漂移（漏一次 `finally` 就是骨架卡死，漏一次清列表就是旧行与错误条
 * 并排显示）。
 *
 * 收敛后职责切成两半：`useAsync` 管状态机（它自带 7 条行为测试），本模块只管**列表页
 * 特有的那两点**：
 *  1. 失败时清空列表——否则旧行会留在屏上，看起来像"加载出了几行"；
 *  2. silent（轮询）成功时自愈清错——轮询把服务等回来了，错误条必须自己消失。
 *
 * ⚠ `load` 固定带 `silent` 参数，所以模板里**必须写 `load()`**：裸 `@click="load"`
 * 会把 PointerEvent 当成 silent（truthy）⇒ 手动刷新被当作轮询，既不置 loading 也不
 * 落错。这条由 `scripts/check-load-binding.mjs` 钉住（网络/卷 Tab 原来没有 silent
 * 参数、写的是裸绑定，收敛时一并改成 `load()`）。
 */
export function useRowLoad<T>(fetcher: () => Promise<T[]>, rows: Ref<T[]>) {
  const { loading, error, run } = useAsync()

  /**
   * 加载一次。返回 `Promise<void>` 而不是 `run` 的 `Promise<boolean>`：各 Tab 只
   * `await load()`，没人消费成功与否；而 `usePolling({ fn })` 的签名是
   * `void | Promise<void>`，多带一个 boolean 反而让 `fn: () => load(true)` 类型不兼容。
   */
  async function load(silent = false): Promise<void> {
    await run(
      async () => {
        rows.value = await fetcher()
        if (silent) error.value = '' // 自愈：轮询成功即清错，错误条不该比数据活得久
      },
      (e) => {
        // 轮询失败不改任何可见状态：骨架不闪、错误条不跳，下一轮成功会自愈。
        if (silent) return
        rows.value = []
        error.value = errorText(e)
      },
      { silent },
    )
  }

  return { loading, error, load }
}
