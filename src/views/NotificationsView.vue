<script setup lang="ts">
/**
 * 站内通知中心。
 *
 * 面板此前**没有任何告警出口**：备份/恢复失败只有服务端日志，用户无从知晓。
 * 这里把它们汇总成人能看见、能处置、能消掉的列表。
 *
 * 纪律：只展示**需要人处置**的事件（失败/风险），成功不通知——
 * 通知一旦变成噪音，用户会整体忽略它。
 */
import { computed, onMounted, ref } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import RefreshBtn from '@/components/RefreshBtn.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { fmtDateTime, notifLevelLabel } from '@/api/types'
import { useAsync } from '@/composables/useAsync'
import { useAuthStore } from '@/stores/auth'
import { useNotificationsStore } from '@/stores/notifications'
import { notifBodyText, notifSourceLabel, notifSourceRoute } from '@/composables/notifPresentation'

interface NotificationItem {
  id: number
  ts: number
  level: string
  source: string
  title: string
  body: string | null
  read: boolean
}

const auth = useAuthStore()
// 未读数与其他页面（顶栏铃铛）共用同一份状态：这里改完，徽标立即跟着变。
const notifications = useNotificationsStore()
const canView = computed(() => auth.can('system.view'))
// 「确认」会改全局 read 旗标，属于写操作：只读角色（viewer）不能清掉别人的未读。
const canAck = computed(() => auth.can('notification.manage'))
const PAGE_SIZE = 100
const items = ref<NotificationItem[]>([])
const unread = computed(() => notifications.unread)
// nextOffset=null 表示没有更早的了；不是用 items.length 猜——
// 恰好满一页时还必须再拉一次才知道后面有没有。
const nextOffset = ref<number | null>(null)
const loadingMore = ref(false)
const allLoaded = ref(false)
const { loading, error, run } = useAsync()

function routeOf(n: NotificationItem) { return notifSourceRoute(n.source) }

async function load() {
  await run(async () => {
    const page = (await api.get<NotificationItem[]>(API.notifications.list(), {
      params: { limit: PAGE_SIZE, offset: 0 },
    })) ?? []
    items.value = page
    nextOffset.value = page.length === PAGE_SIZE ? PAGE_SIZE : null
    allLoaded.value = page.length < PAGE_SIZE
    await notifications.refresh()
  })
}

/** 追加下一页。失败只提示、不清空已加载内容。 */
async function loadMore() {
  if (loadingMore.value || nextOffset.value === null) return
  const offset = nextOffset.value
  loadingMore.value = true
  try {
    const more = (await api.get<NotificationItem[]>(API.notifications.list(), {
      params: { limit: PAGE_SIZE, offset },
    })) ?? []
    // offset 分页在翻页期间来新通知时会整体后移一位，下一页可能重复上一页末尾那条。
    // 按 id 去重，否则 Vue 会因重复 key 复用错行、用户也会看到两条同样的通知。
    const seen = new Set(items.value.map((n) => n.id))
    items.value.push(...more.filter((n) => !seen.has(n.id)))
    nextOffset.value = more.length === PAGE_SIZE ? offset + PAGE_SIZE : null
    allLoaded.value = more.length < PAGE_SIZE
  } catch (e) {
    error.value = errorText(e)
  } finally { loadingMore.value = false }
}

const markingId = ref<number | null>(null)
async function markRead(n: NotificationItem) {
  if (n.read || markingId.value === n.id) return   // 防连点重复 POST / 未读数多减
  markingId.value = n.id
  try {
    await api.post(API.notifications.markRead(n.id))
    n.read = true
    // 乐观更新共享未读数（顶栏徽标同一帧消失），再向后端对账一次。
    notifications.setUnread(unread.value - 1)
    void notifications.refresh()
  } catch (e) {
    error.value = errorText(e)
  } finally { markingId.value = null }
}

async function readAll() {
  try {
    await api.post(API.notifications.readAll())
    notifications.setUnread(0)
    // 不重拉列表：会把已加载的更早页丢回第一页、滚动位置也回到顶部。
    // 全读是幂等状态，本地把已加载项置已读即可，再向后端对账一次。
    for (const n of items.value) n.read = true
    void notifications.refresh()
  } catch (e) {
    error.value = errorText(e)
  }
}

/** 待删除通知（经 ConfirmDialog 确认后执行，审计 U10：此前删除无确认） */
const delTarget = ref<NotificationItem | null>(null)

async function remove(n: NotificationItem) {
  try {
    await api.del(API.notifications.remove(n.id))
    delTarget.value = null
    // 删掉一条未读后徽标要立刻减一，不能等页面重新加载（顶栏与这里共用 store）。
    if (!n.read) notifications.setUnread(unread.value - 1)
    await load()
  } catch (e) {
    error.value = errorText(e)
  }
}

onMounted(() => { if (canView.value) load() })
</script>

<template>
  <section class="view">
    <div class="tools-row">
      <span class="spacer" />
      <span v-if="unread > 0" class="badge badge-danger">未读 {{ unread }}</span>
      <button v-if="canAck" class="btn-ghost btn-sm" :disabled="!unread" @click="readAll">全部已读</button>
      <RefreshBtn @click="load" />
    </div>

    <p v-if="error" class="err-bar">{{ error }}</p>
    <p v-if="!canView" class="muted">当前账号无通知查看权限（需要 system.view）。</p>
    <p v-if="canView && loading" class="muted">加载中…</p>
    <!-- 空态不再放「刷新」：右上角工具行已有同一个 load() 入口，
         两处并存只是重复按钮（与其它页空态只放「新建/清空搜索」不同）。 -->
    <EmptyState v-if="canView && !loading && !error && !items.length"
      title="暂无通知"
      hint="备份失败、恢复失败等需要人工处置的事件会出现在这里" />

    <ul v-if="canView" class="list">
      <li v-for="n in items" :key="n.id" class="item" :class="['lv-' + n.level, { read: n.read }]">
        <div class="head">
          <RouterLink v-if="routeOf(n)" :to="routeOf(n)!" class="title-link">{{ n.title }}</RouterLink>
          <strong v-else>{{ n.title }}</strong>
          <span class="tag">{{ notifSourceLabel(n.source) }}</span>
          <!-- 级别文案走共享词表：后端返回英文枚举，直接渲染会中英混杂。
               此前 notifLevelLabel 已导入却从未使用，级别完全没有展示。 -->
          <span class="lvl">{{ notifLevelLabel(n.level) }}</span>
          <span class="time">{{ fmtDateTime(n.ts) }}</span>
        </div>
        <p v-if="n.body" class="body">{{ notifBodyText(n.body) }}</p>
        <div class="row-actions">
          <button v-if="canAck && !n.read" class="btn-ghost btn-sm" :disabled="markingId === n.id" @click="markRead(n)">标记已读</button>
          <button v-if="auth.can('system.manage')" class="btn-ghost btn-sm danger" title="删除通知（需 system.manage）" @click="delTarget = n">删除</button>
        </div>
      </li>
    </ul>

    <div v-if="canView && nextOffset !== null" class="list-more">
      <span class="muted">已显示 {{ items.length }} 条，可加载更早通知</span>
      <button class="btn-ghost btn-sm" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? '加载中…' : '加载更多' }}
      </button>
    </div>
    <p v-if="canView && allLoaded && nextOffset === null && items.length >= PAGE_SIZE" class="muted list-end">
      已加载全部 {{ items.length }} 条通知
    </p>

    <ConfirmDialog
      :open="!!delTarget"
      title="删除这条通知？"
      detail="删除后不可恢复（通知记录无回收站）。"
      danger
      @confirm="delTarget && remove(delTarget)"
      @cancel="delTarget = null"
    />
  </section>
</template>

<style scoped>
.list { list-style: none; padding: 0; }
.item { border-left: 3px solid var(--c-border-strong); padding: 10px 12px; margin-bottom: 8px; background: var(--c-glass); border-radius: var(--radius-chip); }
/* 级别用 `lv-` 前缀，**不能**直接把 level 当类名：`main.css` 里有全局工具类
   `.warn { color: var(--c-warn) }`，裸用 `warn` 会把整行文字（含标题）染成琥珀色，
   与「级别只用左边框表达」的设计冲突，而 scoped 样式只改 border-left-color 看不出来。
   crit 即「错误」，用危险色左边框；后端已用编译期枚举禁止 `.error` 这个取值。 */
.item.lv-crit { border-left-color: var(--c-danger); }
.item.lv-warn { border-left-color: var(--c-warn); }
.item.lv-info { border-left-color: var(--c-cyan); }
.lvl { font-size: var(--fs-12); color: var(--c-text-dim); }
/* 可点的标题必须看得出能点：下划线颜色原用 --c-border-strong (rgba(255,255,255,.16))，
   深色底上 1x 几乎不可见，等于「长得像纯文本的链接」。改用次级文字色，仍不抢正文。 */
.title-link { color: inherit; text-decoration: underline dotted var(--c-text-dim); text-underline-offset: 3px; }
.title-link:hover { color: var(--c-primary); }
.list-more { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 4px; }
.list-end { margin: 4px 0 0; }
.item.read { opacity: .55; }
/* 叫 .head 而不是 .row：main.css 里 `.row` 是**全局表单行**（align-items: flex-end）。
   虽然这里逐条覆盖了它声明的四个属性、当前没有可见差异，但那是「刚好没踩中」——
   `.warn` 就是这么踩中的（见上）。私有语义就用私有类名。 */
.head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.tag { font-size: var(--fs-12); opacity: .7; }
.time { font-size: var(--fs-12); opacity: .6; margin-left: auto; }
.body { margin: 6px 0; white-space: pre-wrap; font-size: var(--fs-13); opacity: .85;
  overflow-wrap: anywhere; word-break: break-word; }
</style>
