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
import { onMounted, ref } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { fmtDateTime, notifLevelLabel } from '@/api/types'

interface NotificationItem {
  id: number
  ts: number
  level: string
  source: string
  title: string
  body: string | null
  read: boolean
}

const items = ref<NotificationItem[]>([])
const unread = ref(0)
const loading = ref(false)
const error = ref('')

function fmt(ts: number): string {
  return fmtDateTime(ts)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    items.value = await api.get<NotificationItem[]>(API.notifications.list(), {
      params: { limit: 100 },
    })
    const r = await api.get<{ count: number }>(API.notifications.unreadCount())
    unread.value = r.count
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}

async function markRead(n: NotificationItem) {
  try {
    await api.post(API.notifications.markRead(n.id))
    n.read = true
    unread.value = Math.max(0, unread.value - 1)
  } catch (e) {
    error.value = errorText(e)
  }
}

async function readAll() {
  try {
    await api.post(API.notifications.readAll())
    await load()
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
    await load()
  } catch (e) {
    error.value = errorText(e)
  }
}

onMounted(load)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h2 class="page-title">通知</h2>
      <span class="spacer" />
      <span v-if="unread > 0" class="badge badge-danger">未读 {{ unread }}</span>
      <button class="btn-ghost btn-sm" :disabled="!unread" @click="readAll">全部已读</button>
      <button class="btn-ghost btn-sm" @click="load">刷新</button>
    </div>

    <p v-if="error" class="err-bar">{{ error }}</p>
    <p v-if="loading" class="muted">加载中…</p>
    <EmptyState v-if="!loading && !items.length"
      title="暂无通知"
      hint="备份失败、恢复失败等需要人工处置的事件会出现在这里" />

    <ul class="list">
      <li v-for="n in items" :key="n.id" class="item" :class="[n.level, { read: n.read }]">
        <div class="row">
          <strong>{{ n.title }}</strong>
          <span class="tag">{{ n.source }}</span>
          <!-- 级别文案走共享词表：后端返回英文枚举，直接渲染会中英混杂。
               此前 notifLevelLabel 已导入却从未使用，级别完全没有展示。 -->
          <span class="lvl">{{ notifLevelLabel(n.level) }}</span>
          <span class="time">{{ fmt(n.ts) }}</span>
        </div>
        <p v-if="n.body" class="body">{{ n.body }}</p>
        <div class="row-actions">
          <button v-if="!n.read" class="btn-ghost btn-sm" @click="markRead(n)">标记已读</button>
          <button class="btn-ghost btn-sm danger" @click="delTarget = n">删除</button>
        </div>
      </li>
    </ul>

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
.list { list-style: none; padding: 0; margin-top: 12px; }
.item { border-left: 3px solid var(--c-border-strong); padding: 10px 12px; margin-bottom: 8px; background: var(--c-glass); border-radius: 6px; }
.item.crit { border-left-color: var(--c-danger); }
.item.warn { border-left-color: var(--c-warn); }
.item.info { border-left-color: var(--c-cyan); }
/* 后端级别取值是 info/warn/error（见 types.ts 的 notifLevelLabel），
   此前只定义了 crit/warn/info——error 级通知左边框无色，看不出是错误。
   crit 保留以兼容旧数据。 */
.item.error { border-left-color: var(--c-danger); }
.item.crit { border-left-color: var(--c-danger); }
.lvl { font-size: 11px; color: var(--c-text-dim); }
.item.read { opacity: .55; }
.row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.tag { font-size: 12px; opacity: .7; }
.time { font-size: 12px; opacity: .6; margin-left: auto; }
.body { margin: 6px 0; white-space: pre-wrap; font-size: 13px; opacity: .85; }
</style>
