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
  return new Date(ts * 1000).toLocaleString()
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

async function remove(n: NotificationItem) {
  try {
    await api.del(API.notifications.remove(n.id))
    await load()
  } catch (e) {
    error.value = errorText(e)
  }
}

onMounted(load)
</script>

<template>
  <section class="page">
    <header class="head">
      <h1>通知</h1>
      <div class="ops">
        <span v-if="unread > 0" class="badge">未读 {{ unread }}</span>
        <button class="btn" :disabled="!unread" @click="readAll">全部已读</button>
        <button class="btn" @click="load">刷新</button>
      </div>
    </header>

    <p v-if="error" class="err">{{ error }}</p>
    <p v-if="loading" class="muted">加载中…</p>
    <p v-if="!loading && !items.length" class="muted">
      暂无通知。备份失败、恢复失败等需要人工处置的事件会出现在这里。
    </p>

    <ul class="list">
      <li v-for="n in items" :key="n.id" class="item" :class="[n.level, { read: n.read }]">
        <div class="row">
          <strong>{{ n.title }}</strong>
          <span class="tag">{{ n.source }}</span>
          <span class="time">{{ fmt(n.ts) }}</span>
        </div>
        <p v-if="n.body" class="body">{{ n.body }}</p>
        <div class="ops">
          <button v-if="!n.read" class="btn small" @click="markRead(n)">标记已读</button>
          <button class="btn small danger" @click="remove(n)">删除</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.page { padding: 16px; }
.head { display: flex; align-items: center; justify-content: space-between; }
h1 { font-size: 18px; margin: 0; }
.ops { display: flex; gap: 8px; align-items: center; }
.badge { background: #c73e1f; color: #fff; border-radius: 10px; padding: 2px 8px; font-size: 12px; }
.btn { border: 1px solid #555; background: transparent; color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.small { padding: 2px 8px; font-size: 12px; }
.btn.danger { border-color: #c73e1f; color: #c73e1f; }
.list { list-style: none; padding: 0; margin-top: 12px; }
.item { border-left: 3px solid #666; padding: 10px 12px; margin-bottom: 8px; background: rgba(127,127,127,.08); border-radius: 6px; }
.item.crit { border-left-color: #e5484d; }
.item.warn { border-left-color: #f5a524; }
.item.info { border-left-color: #3b82f6; }
.item.read { opacity: .55; }
.row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.tag { font-size: 12px; opacity: .7; }
.time { font-size: 12px; opacity: .6; margin-left: auto; }
.body { margin: 6px 0; white-space: pre-wrap; font-size: 13px; opacity: .85; }
.muted { opacity: .6; }
.err { color: #e5484d; }
</style>
