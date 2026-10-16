<script setup lang="ts">
/**
 * 内置 Web 终端（多页签）。PROTOCOL 与后端 routes/terminal.rs 严格对应，见下。
 *
 * 帧协议（后端同源）：
 * - 服务端 → 前端：二进制帧 = PTY 原始输出字节（直接喂 xterm）；
 *   文本帧 = 控制 JSON {t:"ready",shell} / {t:"exit",code} / {t:"notice",msg}。
 * - 前端 → 服务端：二进制帧 = 用户输入原始字节（term.onData 的 UTF-8 串重新编码）；
 *   文本帧 = 控制 JSON {t:"resize",cols,rows}。
 *
 * 安全：WebSocket 升级无法带 X-CSRF-Token 头，浏览器自动带同源 Cookie（panel_sid），
 * 后端用 Origin == scheme://Host 同源校验替代 CSRF。前端**不**构造任何命令，
 * 所有输入只写进 PTY master，与后端"终端=合法代码执行入口、防线在会话建立时"一致。
 *
 * 多页签（2026-10-17）：每个标签是一个**独立会话**——各自一条 WebSocket、各自一个
 * PTY（后端每条升级独立 spawn_pty），各自持有滚动缓冲区；切换标签不重连、不丢回显。
 *
 * ⚠ 并发上限必须前端同步：后端 `TERMINAL_SEM` 是**全局**固定容量（见 routes/terminal.rs
 * 第 6 条卫士），超出返回 503。因此这里 MAX_TABS 与后端保持一致，并在触顶时禁用
 * 「+ 新标签」+ 说明原因，而不是让用户点出一个连不上的空会话。
 *
 * ⚠ xterm Terminal / WebSocket 实例**绝不能放进响应式数组**：ref([]) 会深度代理，
 * 代理会包住这两类复杂实例，读写其内部结构时极易踩坑（且会拖慢渲染）。故重量级
 * 实例按 id 存在普通 Map（非响应式），标签数组只放展示态。
 */
import {
  ref, computed, onMounted, onUnmounted, nextTick,
  type ComponentPublicInstance,
} from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import Icon from '@/components/Icon.vue'

/** 与后端 TERMINAL_SEM 容量一致：全局最多 4 个并发终端会话。 */
const MAX_TABS = 4

const auth = useAuthStore()
const enabled = computed(() => auth.enabled(CAP.TERMINAL_MANAGE, 'system.manage'))

/** 标签展示态（保持在响应式数组里；重量级实例一律走 sessions Map）。 */
interface TermTab {
  id: string
  title: string
  status: string
  connected: boolean
  errorMsg: string
  shell: string | null
}

/** 单个会话的重量级实例（非响应式，存在普通 Map）。 */
interface TermSession {
  term: Terminal | null
  fit: FitAddon | null
  ws: WebSocket | null
}

const sessions = new Map<string, TermSession>()
/** 每个标签各自的终端容器 DOM（同样非响应式）。 */
const panes = new Map<string, HTMLElement>()

let seqNo = 0
function makeTab(): TermTab {
  return {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: `终端 ${++seqNo}`,
    status: '未连接', connected: false, errorMsg: '', shell: null,
  }
}

const tabs = ref<TermTab[]>([makeTab()])
const activeId = ref(tabs.value[0].id)
const activeTab = computed<TermTab>(
  () => tabs.value.find((t) => t.id === activeId.value) ?? tabs.value[0],
)

// 工具栏作用于「当前激活标签」：这里一并代理过去（对齐 FilesView 的同款写法）。
const status = computed({ get: () => activeTab.value.status, set: (v) => { activeTab.value.status = v } })
const connected = computed({ get: () => activeTab.value.connected, set: (v) => { activeTab.value.connected = v } })
const errorMsg = computed({ get: () => activeTab.value.errorMsg, set: (v) => { activeTab.value.errorMsg = v } })

function tabById(id: string) { return tabs.value.find((t) => t.id === id) ?? null }

function sessionFor(id: string): TermSession {
  let s = sessions.get(id)
  if (!s) { s = { term: null, fit: null, ws: null }; sessions.set(id, s) }
  return s
}

/** 模板里的函数 ref：把每个标签的容器 DOM 收进 panes。 */
function bindPane(id: string, el: Element | ComponentPublicInstance | null | undefined) {
  if (el instanceof HTMLElement) panes.set(id, el)
  else panes.delete(id)
}

/** 按当前页面地址构造同源 WS URL（dev 经 Vite /api 代理；prod 同主机）。 */
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/v1/terminal`
}

/** 为该标签建好 xterm 实例并挂进它自己的容器（幂等）。容器必须在 DOM 里——故新标签须先 nextTick。 */
function ensureTerm(id: string): TermSession | null {
  const s = sessionFor(id)
  if (s.term) return s
  const el = panes.get(id)
  if (!el) return null
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)
  // 输入 / 尺寸变化都按「来源标签」路由，避免多标签串前台PTY。
  term.onData((d) => {
    const sock = sessionFor(id).ws
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(new TextEncoder().encode(d))
  })
  term.onResize(({ cols, rows }) => {
    const sock = sessionFor(id).ws
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'resize', cols, rows }))
  })
  s.term = term; s.fit = fit
  return s
}

function connect(id: string = activeId.value) {
  const tab = tabById(id)
  if (!enabled.value || !tab) return
  const s = ensureTerm(id)
  if (!s || s.ws) return          // 已有连接则不重复建（WS 一条 = 一个 PTY = 一个并发名额）
  tab.errorMsg = ''
  tab.status = '连接中…'
  let ws: WebSocket
  try { ws = new WebSocket(wsUrl()) } catch {
    tab.errorMsg = '无法建立终端连接'; tab.status = '未连接'; return
  }
  ws.binaryType = 'arraybuffer'
  s.ws = ws
  // 捕获本次连接的 socket 引用：onclose 是异步触发的，重连时旧 socket 的 onclose
  // 会在新连接建好之后才跑，届时需要分辨「关掉的是不是当前这个」。
  const sock = ws

  ws.onopen = () => {
    tab.connected = true
    tab.status = tab.shell ? `已连接 · ${tab.shell}` : '已连接'
  }
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data) as { t?: string; shell?: string; code?: number; msg?: string }
        if (m.t === 'ready') {
          tab.shell = m.shell ?? null
          tab.status = `已连接 · ${m.shell ?? 'shell'}`
          s.term?.writeln(`\r\n\x1b[2m[终端就绪 · ${m.shell ?? ''}]\x1b[0m`)
        } else if (m.t === 'exit') {
          s.term?.writeln(`\r\n\x1b[33m[会话结束 code=${m.code ?? 0}]\x1b[0m`)
          disconnect(id)
        } else if (m.t === 'notice') {
          s.term?.writeln(`\r\n\x1b[33m[提示] ${m.msg ?? ''}\x1b[0m`)
        }
      } catch { /* 忽略坏帧 */ }
    } else {
      s.term?.write(new Uint8Array(ev.data as ArrayBuffer))
    }
  }
  ws.onclose = () => {
    // 重连/复用名额定场景：若关掉的不是当前这个 socket，直接忽略（否则会把新连接抹掉）。
    if (s.ws !== sock) return
    tab.connected = false
    tab.status = '已断开'
    s.ws = null
    if (s.term) s.term.writeln('\r\n\x1b[33m[连接已关闭]\x1b[0m')
  }
  ws.onerror = () => {
    // WS 握手失败（如并发名额用尽、只读模式、同源校验不通过）都走 onerror，
    // 浏览器不暴露 HTTP 状态码——故文案要覆盖这几种可能，不误导单一归因。
    tab.errorMsg = '终端连接失败：可能是并发会话已满（后端最多 4 个）、只读模式或同源校验未通过'
    tab.status = '未连接'
  }
}

function disconnect(id: string = activeId.value) {
  const s = sessions.get(id)
  const tab = tabById(id)
  if (s?.ws) { s.ws.close(); s.ws = null }
  if (tab) { tab.connected = false; if (tab.status === '连接中…') tab.status = '未连接' }
}

function reconnect(id: string = activeId.value) {
  disconnect(id)
  connect(id)
}

function clearScreen(id: string = activeId.value) {
  sessions.get(id)?.term?.clear()
}

// ── 标签栏 ──
async function openTab() {
  if (tabs.value.length >= MAX_TABS) return
  const t = makeTab()
  tabs.value.push(t)
  activeId.value = t.id
  await nextTick()             // 等新标签的容器进入 DOM 才能 open xterm
  if (!enabled.value) return
  ensureTerm(t.id)
  connect(t.id)                // 新标签立即建连（与文件页新标签即加载同一 UX）
}

async function switchTab(id: string) {
  if (id === activeId.value) return
  activeId.value = id
  await nextTick()
  const s = sessions.get(id)
  if (!s?.term) {              // 兜底：标签还没实例（如当时未授权）就补一个并连上
    if (enabled.value) { ensureTerm(id); connect(id) }
    return
  }
  // 容器此前是 display:none，fit 量不到尺寸 → 切回来必须重新 fit 并聚焦。
  s.fit?.fit()
  s.term.focus()
}

function closeTab(id: string) {
  if (tabs.value.length <= 1) return   // 至少保留一个标签
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx < 0) return
  disposeSession(id)
  tabs.value.splice(idx, 1)
  if (id === activeId.value) activeId.value = tabs.value[Math.max(0, idx - 1)].id
}

/** 释放一个会话：关 WebSocket（让出并发名额）+ dispose xterm。 */
function disposeSession(id: string) {
  const s = sessions.get(id)
  if (!s) return
  if (s.ws) { s.ws.close(); s.ws = null }
  s.term?.dispose()
  s.term = null; s.fit = null
  sessions.delete(id)
  panes.delete(id)
}

function onResizeWin() {
  const s = sessions.get(activeId.value)
  if (s?.term) s.fit?.fit()
}

onMounted(async () => {
  window.addEventListener('resize', onResizeWin)
  if (!enabled.value) return
  await nextTick()
  ensureTerm(tabs.value[0].id)
  connect(tabs.value[0].id)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResizeWin)
  // 所有标签都要收：漏一个就是一条 WS 泄漏 + 一个 PTY 常驻。
  for (const id of [...sessions.keys()]) disposeSession(id)
})
</script>

<template>
  <div>
    <!-- 多页签：每个标签一个独立会话（一条 WS / 一个 PTY），互不干扰 -->
    <div class="tabbar" role="tablist" aria-label="终端会话">
      <div v-for="t in tabs" :key="t.id" class="tab" :class="{ on: t.id === activeId }"
        role="tab" :aria-selected="t.id === activeId" tabindex="0"
        @click="switchTab(t.id)" @keydown.enter.prevent="switchTab(t.id)">
        <span class="tdot" :class="{ on: t.connected }" />
        <Icon name="terminal" :size="14" />
        <span class="tab-label">{{ t.title }}</span>
        <button v-if="tabs.length > 1" class="tab-x" type="button" aria-label="关闭标签"
          @click.stop="closeTab(t.id)"><Icon name="close" :size="12" /></button>
      </div>
      <button class="tab add" type="button" aria-label="新建终端标签"
        :disabled="tabs.length >= MAX_TABS"
        :title="tabs.length >= MAX_TABS ? `已达上限：后端最多同时 ${MAX_TABS} 个终端会话` : '新建一个终端会话'"
        @click="openTab">
        <Icon name="plus" :size="14" /> 新标签
      </button>
    </div>

    <div class="tools-row">
      <span class="spacer" />
      <span class="stat" :class="{ on: connected }">
        <span class="dot" /> {{ status }}
      </span>
      <button class="btn-primary" :disabled="!enabled || connected" @click="connect()">
        <Icon name="bolt" :size="15" /> 连接
      </button>
      <button class="btn-ghost" :disabled="!connected" @click="disconnect()">
        <Icon name="stop" :size="15" /> 断开
      </button>
      <button class="btn-ghost" :disabled="!connected" @click="reconnect()">
        <Icon name="refresh" :size="15" /> 重连
      </button>
      <button class="btn-ghost" :disabled="!enabled" @click="clearScreen()">
        <Icon name="trash" :size="15" /> 清屏
      </button>
    </div>

    <EmptyState v-if="!enabled"
      title="当前环境不支持 Web 终端"
      :reason="auth.capabilities[CAP.TERMINAL_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="errorMsg" class="err" role="alert">{{ errorMsg }}</p>
      <!-- 每个标签一个常驻容器：隐藏而非销毁，切回来才能保住滚动缓冲与回显 -->
      <div v-for="t in tabs" :key="t.id" :ref="(el) => bindPane(t.id, el)"
        class="term-pane" :class="{ active: t.id === activeId }" />
      <RiskBanner level="danger" title="宿主级权限"
        text="终端拥有宿主级权限，所有命令以面板运行身份执行；关闭页面或关闭标签即断开会话。" />
    </template>
  </div>
</template>

<style scoped>
/* 标签栏：与文件管理的 .tabbar 同源（玻璃胶囊 + 激活主色），复用现有设计 token。
   「+ 新标签」一律中性色，不抢 tools-row 里唯一的 btn-primary（连接）。 */
.tabbar { display: flex; align-items: stretch; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
.tab { display: inline-flex; align-items: center; gap: 6px; max-width: 200px; padding: 6px 10px;
  border: 1px solid var(--c-border); border-radius: var(--radius-sm, 7px); background: var(--c-glass);
  color: var(--c-text-dim); cursor: pointer; font-size: var(--fs-12-5); user-select: none; }
.tab:hover { background: var(--c-hover); color: var(--c-text); }
.tab.on { background: var(--c-primary); color: #fff; border-color: var(--c-primary); }
.tab .tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tdot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-text-mute); flex: none; }
.tdot.on { background: var(--c-ok, #3fb950); box-shadow: 0 0 6px var(--c-ok, #3fb950); }
.tab.on .tdot.on { background: #fff; box-shadow: none; }
.tab-x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  margin-left: 2px; border: none; background: none; color: inherit; border-radius: 4px; cursor: pointer; padding: 0; }
.tab-x:hover { background: rgba(127, 127, 127, 0.28); }
.tab.on .tab-x:hover { background: rgba(255, 255, 255, 0.28); }
.tab.add { color: var(--c-text-dim); }
.tab.add:hover:not(:disabled) { color: var(--c-primary); }
.tab.add:disabled { opacity: .45; cursor: not-allowed; }

.stat { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-12-5); color: var(--c-text-mute); }
.stat.on { color: var(--c-ok, #3fb950); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-text-mute); }
.stat.on .dot { background: var(--c-ok, #3fb950); box-shadow: 0 0 8px var(--c-ok, #3fb950); }

/* 终端容器：所有标签共用一套尺寸；非激活的隐藏（保活）而非销毁。 */
.term-pane {
  height: calc(100vh - 258px); min-height: 360px;
  background: #0d1117; border: 1px solid var(--c-border); border-radius: 12px;
  padding: 10px;
}
.term-pane:not(.active) { display: none; }
.err { color: var(--c-danger); font-size: var(--fs-13); }
</style>
