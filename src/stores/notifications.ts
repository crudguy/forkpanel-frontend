import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api/client'
import { API } from '@/api/endpoints'

/**
 * 未读通知数：**顶栏铃铛与通知页共用同一份状态**。
 *
 * 此前两边各持一个 `ref(0)`：通知页标记已读/全部已读/删除后，顶栏徽标
 * 仍显示旧值，最长要等 60s 轮询才自愈——同一屏内自相矛盾，用户会以为
 * 操作没生效。抽成 store 后，任何一方改 `unread`，另一方立即跟着变。
 *
 * 纪律：
 * - `refresh()` 失败**只保留上一次的值并静默**：未读数取不到不该影响任何操作，
 *   更不该把徽标清零（清零等于谎称"没有未读"）。
 * - 写操作后用 `setUnread()` 做**乐观更新**，再 `void refresh()` 对账；
 *   不要等一次额外请求回来才动徽标。
 */
export const useNotificationsStore = defineStore('notifications', () => {
  const unread = ref(0)

  /** 从后端拉未读数（失败保留旧值）。 */
  async function refresh(): Promise<void> {
    try {
      const r = await api.get<{ count: number }>(API.notifications.unreadCount())
      setUnread(r?.count ?? 0)
    } catch {
      /* 静默重试：不是关键路径，下一轮轮询会再试 */
    }
  }

  /** 直接写入（乐观更新/清零用）。负数与非整数一律收敛到非负整数。 */
  function setUnread(n: number): void {
    unread.value = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
  }

  return { unread, refresh, setUnread }
})
