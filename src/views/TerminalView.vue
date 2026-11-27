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
 * ⚠ 并发上限由后端下发：`TERMINAL_SEM` 是**全局**固定容量（见 routes/terminal.rs），
 * 超出返回 503。前端用 `auth.terminalMax`（读 /system/capabilities 的
 * limits.terminal_max_sessions）而不是自己写死一个数——两端各写一个 4，改一端忘
 * 另一端就是「面板说能开、一点就 503」。触顶时禁用「+ 新标签」+ 说明原因，
 * 而不是让用户点出一个连不上的空会话。
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
import HelpBtn from '@/components/HelpBtn.vue'
import HelpDrawer from '@/components/HelpDrawer.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import TerminalCommandDialog from '@/components/TerminalCommandDialog.vue'
import { toast, toastError } from '@/composables/useToast'
import {
  PRESET_COMMANDS,
  useQuickCommands,
  type QuickCommand,
  type QuickCommandInput,
} from '@/composables/useQuickCommands'

const auth = useAuthStore()
const enabled = computed(() => auth.enabled(CAP.TERMINAL_MANAGE, 'system.manage'))

/**
 * 帮助抽屉开关。宿主级权限这类的**完整说明**放这里（与全站 HelpBtn/HelpDrawer 同款），
 * 页面流里不再铺一条彩色警示条——终端本身要占满一屏，那条 banner 常驻会挤掉两行终端。
 */
const helpOpen = ref(false)

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
/** 容器尺寸变化（错误条出现/消失、标签栏折行、切换标签显隐）时把 xterm
    重新 fit 到新尺寸；否则画布仍是旧高度，会比终端黑框高出一截。pane 高度由外层
    flex 分配、不受 xterm 内容影响，故不会形成「fit → 尺寸变化 → 再 fit」的循环。 */
let paneObs: ResizeObserver | null = null

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
  const old = panes.get(id)
  if (old) paneObs?.unobserve(old)
  if (el instanceof HTMLElement) {
    panes.set(id, el)
    paneObs?.observe(el)
  } else panes.delete(id)
}

/** 按当前页面地址构造同源 WS URL（dev 经 Vite /api 代理；prod 同主机）。 */
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/v1/terminal`
}

/** xterm 的配色取自 main.css 的 --term-* token（终端恒深色，不随明暗主题切换）。
    读不到 token 时退回同一组值，保证「容器底色」与「终端画布色」不会错位。 */
function termTheme() {
  const cs = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    background: pick('--term-bg', '#0d1117'),
    foreground: pick('--term-fg', '#e6edf3'),
    cursor: pick('--term-fg', '#e6edf3'),
  }
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
    theme: termTheme(),
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
  // 首进 / 新标签在 connect 前先按容器实际尺寸 fit：否则 PTY 以 xterm 默认 80×24
  // 启动，终端只占容器左侧一条（vim/htop 布局错乱），要等用户拖窗才纠正。
  s.fit?.fit()
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
    // 重连/复用名额的场景：若关掉的不是当前这个 socket，直接忽略（否则会把新连接抹掉）。
    // 主动「断开」按钮会先把 s.ws 置 null 再 close，这里据此区分是"用户主动断开"
    // 还是"连接意外掉线"，两种情形都要写提示行——否则终端停在旧提示符上，
    // 看着像还能敲命令，实际已经没有任何东西在接收输入。
    const voluntary = s.ws === null
    if (!voluntary && s.ws !== sock) return
    tab.connected = false
    tab.status = '已断开'
    s.ws = null
    if (s.term) {
      s.term.writeln(voluntary
        ? '\r\n\x1b[33m[已断开，点「重连」恢复会话]\x1b[0m'
        : '\r\n\x1b[33m[连接已关闭]\x1b[0m')
    }
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
  if (!s?.ws) { if (tab) tab.connected = false; return }
  const sock = s.ws
  // s.ws 必须**先**置 null：reconnect 会紧接着调 connect，而 connect 开头
  // `if (s.ws) return` 靠它判断"是否已有连接"，不清就会静默不重连。
  // 置 null 同时充当「这次是用户主动断开」的信号，onclose 据此选提示文案
  // （见 onclose 里的 voluntary 判定），避免终端停在旧提示符上像还能用。
  s.ws = null
  sock.close()
  if (tab) { tab.connected = false; if (tab.status === '连接中…') tab.status = '未连接' }
}

function reconnect(id: string = activeId.value) {
  disconnect(id)
  connect(id)
}

function clearScreen(id: string = activeId.value) {
  sessions.get(id)?.term?.clear()
}

// ── 快捷命令 ──
// 自定义命令存服务端（按登录用户隔离、跨设备），预置命令是前端常量；数据层只管
// 清单，把命令写进当前会话 PTY 的逻辑留在 sendQuick（本文件）。
const {
  custom: customCommands,
  loading: quickLoading,
  load: loadQuick,
  add: addQuick,
  update: updateQuick,
  remove: removeQuick,
} = useQuickCommands()

/** 入口在右上角工具栏；只在打开浮层时拉一次服务端清单，平时页面零请求。 */
const quickBtn = ref<HTMLElement | null>(null)
const quickOpen = ref(false)
const quickPos = ref({ top: '0px', right: '0px' })

// 浮层 Teleport 到 body（顶栏 backdrop-filter 会成为 fixed 包含块），脱离工具栏
// 锚点后改用 fixed，坐标按触发按钮实测下发；与主布局用户菜单同款做法。
function placeQuick() {
  const r = quickBtn.value?.getBoundingClientRect()
  if (!r) return
  quickPos.value = {
    top: `${Math.round(r.bottom + 6)}px`,
    right: `${Math.round(document.documentElement.clientWidth - r.right)}px`,
  }
}
async function toggleQuick() {
  if (quickOpen.value) { closeQuick(); return }
  placeQuick()               // 先量后开：否则首帧先落在 (0,0) 再跳到位
  quickOpen.value = true
  try { await loadQuick() } catch (e) { toastError(e) }
}
function closeQuick() { quickOpen.value = false }
function onQuickEsc() {
  // 表单/删除确认还开着时 Esc 归内层：它们各自接了 useModal 的焦点栈，
  // 这里再关一次会连浮层带弹窗一起收掉。
  if (dialogOpen.value || pendingDelete.value) return
  closeQuick()
  quickBtn.value?.focus()
}
function onQuickResize() { if (quickOpen.value) placeQuick() }
/** Esc 关闭浮层：挂在 document 捕获阶段。删完命令后列表刷新、原删除按钮被卸载，
    焦点会落空，此时浮层自身的 @keydown.escape 根本收不到冒泡上来的按键。 */
function onQuickDocKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !quickOpen.value) return
  if (dialogOpen.value || pendingDelete.value) return   // 内层弹窗优先，一层层关
  onQuickEsc()
}

/** 浮层内的命令输入框：可编辑后再送进终端，它不是终端的一部分。 */
const quickInput = ref('')
const quickInputEl = ref<HTMLInputElement | null>(null)
const dialogOpen = ref(false)
const editing = ref<QuickCommand | null>(null)
const pendingDelete = ref<QuickCommand | null>(null)

/** 已占用命令：预置 + 当前用户自定义。编辑态按 **id** 排除自身（不是按命令——
    按命令会把内容相同的预置项一起排除掉），否则「只改说明」会被自己挡住；
    改成同用户另一条已有的命令仍会被拦。 */
const dialogTakenCmds = computed<string[]>(() => {
  const ownId = editing.value?.id
  return [
    ...PRESET_COMMANDS.map((c) => c.cmd),
    ...customCommands.value.filter((c) => c.id !== ownId).map((c) => c.cmd),
  ]
})

function fillCommand(c: QuickCommand) {
  quickInput.value = c.cmd
  nextTick(() => quickInputEl.value?.focus())
}

async function copyCommand(c: QuickCommand) {
  try {
    await navigator.clipboard.writeText(c.cmd)
  } catch {
    // 非安全上下文 / 无剪贴板权限：退回 execCommand；两者都失败也只影响复制这一下
    const ta = document.createElement('textarea')
    ta.value = c.cmd
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* 剪贴板完全不可用，忽略 */ }
    document.body.removeChild(ta)
  }
  toast('已复制到剪贴板')
}

/** 把输入框内容写进当前激活会话的 PTY；execute 为真时补回车让 shell 执行。 */
function sendQuick(execute: boolean) {
  const text = quickInput.value.trim()
  if (!text) { toast('请先选择或输入命令', 'warn'); return }
  const s = sessions.get(activeId.value)
  if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) {
    toast('请先连接终端', 'warn')
    return
  }
  s.ws.send(new TextEncoder().encode(execute ? `${text}\n` : text))
  s.term?.focus()
}

function openAdd() { editing.value = null; dialogOpen.value = true }
function openEdit(c: QuickCommand) { editing.value = c; dialogOpen.value = true }

async function saveQuick(v: QuickCommandInput) {
  const wasEdit = !!editing.value
  try {
    if (editing.value) await updateQuick(editing.value.id, v)
    else await addQuick(v)
  } catch (e) {
    toastError(e)          // 后端校验/超限/网络错误统一走错误闸门，不吞根因
    return
  }
  dialogOpen.value = false
  toast(wasEdit ? '命令已更新' : '命令已添加')
}

async function confirmDelete() {
  if (!pendingDelete.value) return
  try {
    await removeQuick(pendingDelete.value.id)
  } catch (e) {
    toastError(e)
    return
  }
  pendingDelete.value = null
  toast('命令已删除')
}

// ── 标签栏 ──
async function openTab() {
  if (tabs.value.length >= auth.terminalMax) return
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
  onQuickResize()   // 浮层锚在右上角按钮上，窗口缩放后重算坐标
}

onMounted(async () => {
  window.addEventListener('resize', onResizeWin)
  document.addEventListener('keydown', onQuickDocKeydown, true)
  if (!enabled.value) return
  await nextTick()
  ensureTerm(tabs.value[0].id)
  connect(tabs.value[0].id)
  if (typeof ResizeObserver !== 'undefined') {
    paneObs = new ResizeObserver(() => {
      const el = panes.get(activeId.value)
      if (!el || !el.clientWidth || !el.clientHeight) return
      sessions.get(activeId.value)?.fit?.fit()
    })
    for (const el of panes.values()) paneObs.observe(el)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', onResizeWin)
  document.removeEventListener('keydown', onQuickDocKeydown, true)
  paneObs?.disconnect()
  paneObs = null
  // 所有标签都要收：漏一个就是一条 WS 泄漏 + 一个 PTY 常驻。
  for (const id of [...sessions.keys()]) disposeSession(id)
})
</script>

<template>
  <div class="term-view">
    <!-- 多页签与工具条同一行：标签栏 + 操作按钮共用一行，不单独占一行 -->
    <div class="fp-head-row">
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
        :disabled="tabs.length >= auth.terminalMax"
        :title="tabs.length >= auth.terminalMax ? `已达上限：后端最多同时 ${auth.terminalMax} 个终端会话` : '新建一个终端会话'"
        @click="openTab">
        <Icon name="plus" :size="14" />
      </button>
    </div>

    <div class="tools-row">
      <span class="spacer" />
      <!-- 权限/会话说明入口：与全站各页一致摆在这一行的最右侧（spacer 之后第一组）。
           宿主级权限这类「背景说明」收进抽屉，页面流里不再常驻一条警示条。 -->
      <HelpBtn title="终端说明" aria-label="终端说明" :expanded="helpOpen" @click="helpOpen = true" />
      <!-- 快捷命令入口：disclosure（trigger + aria-controls + expanded），不声明
           aria-haspopup=menu——面板里有输入框和分段操作，套 menu 键盘模型会让读屏
           把普通按钮当菜单项跳过。面板 Teleport 到 body，见下方浮层。 -->
      <button ref="quickBtn" class="btn-ghost btn-sm" type="button"
        :aria-expanded="quickOpen" aria-controls="quick-cmd-popup"
        :disabled="!enabled" title="快捷命令（保存在当前账号，跨设备同步）"
        @click="toggleQuick" @keydown.escape="onQuickEsc">
        <Icon name="bolt" :size="14" /> 快捷命令
      </button>
      <!-- 会话开关：断开与重连是同一件事的两个方向，合并成一个按钮，按当前状态二选一。
           不并排放两个按钮——它们互斥，同时摆出来只会让用户判断"现在该点哪个"。
           连接本身是自动的（onMounted / openTab 都会建连），所以不需要「连接」按钮；
           会话状态改由标签上的状态点 + 终端内 [终端就绪]/[连接已关闭] 行表达。 -->
      <button v-if="connected" class="btn-ghost" type="button"
        title="断开会话：shell 与它启动的进程一并结束，立刻归还并发名额"
        @click="disconnect()">
        <Icon name="stop" :size="15" /> 断开
      </button>
      <!-- 重连用 btn-ghost 而非 btn-primary：两个状态共用一个位置，权重必须一致，
           否则按下「断开」的瞬间按钮从幽灵色跳成橙色实心，视觉上像多出了一个主操作。
           需要醒目时靠 refresh 图标 + 文案本身，不靠颜色抢。 -->
      <button v-else class="btn-ghost" type="button" :disabled="!enabled"
        title="重新建立终端会话"
        @click="reconnect()">
        <Icon name="refresh" :size="15" /> 重连
      </button>
      <!-- 清屏只清本机 xterm 缓冲，不写 PTY、不影响正在运行的命令。
           因此它不能被 clear 命令替代：命令跑着的时候输入进不了 shell。 -->
      <button class="btn-ghost" :disabled="!enabled" title="清空本机屏幕显示（不等于 clear 命令，不影响正在运行的命令）"
        @click="clearScreen()">
        <Icon name="eraser" :size="15" /> 清屏
      </button>
    </div>
    </div>

    <EmptyState v-if="!enabled"
      title="当前环境不支持 Web 终端"
      :reason="auth.capabilities[CAP.TERMINAL_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="errorMsg" class="err" role="alert">{{ errorMsg }}</p>

      <!-- 快捷命令浮层：Teleport 到 body，避免顶栏 backdrop-filter 把 fixed 浮层
           困进包含块（与主布局用户菜单、列选择器同款处置）。平时不渲染、不请求。 -->
      <Teleport to="body">
        <div v-if="quickOpen" class="qc-backdrop" aria-hidden="true" @click="closeQuick" />
        <div v-if="quickOpen" id="quick-cmd-popup" class="qc-popup"
          role="group" aria-label="快捷命令" :style="quickPos" @keydown.escape="onQuickEsc">
          <div class="qc-head">
            <strong>快捷命令</strong>
            <span class="qc-tip">保存在当前账号 · 跨设备同步</span>
            <button class="qc-x" type="button" aria-label="关闭" @click="closeQuick">
              <Icon name="close" :size="15" />
            </button>
          </div>
          <div class="qc-input-row">
            <input ref="quickInputEl" v-model="quickInput" class="qb-input" type="text"
              placeholder="输入命令，可编辑后插入/执行" spellcheck="false"
              @keydown.enter.prevent="sendQuick(true)" />
            <button class="btn-ghost btn-sm" type="button" :disabled="!connected" @click="sendQuick(false)">
              <Icon name="terminal" :size="14" /> 插入
            </button>
            <button class="btn-primary btn-sm" type="button" :disabled="!connected" @click="sendQuick(true)">
              <Icon name="play" :size="14" /> 执行
            </button>
          </div>
          <div class="qc-scroll">
            <div v-if="quickLoading" class="empty-inline qb-empty">加载中…</div>
            <template v-else>
              <div class="qc-group">
                <span class="qb-label">常用</span>
                <div class="qb-items">
                  <div v-for="c in PRESET_COMMANDS" :key="c.id" class="qb-item">
                    <button class="qb-cmd" type="button" :title="c.desc" @click="fillCommand(c)">
                      <code>{{ c.cmd }}</code>
                      <span v-if="c.desc" class="qb-desc">{{ c.desc }}</span>
                    </button>
                    <button class="qb-act" type="button" :aria-label="`复制 ${c.cmd}`" title="复制"
                      @click="copyCommand(c)"><Icon name="copy" :size="14" /></button>
                  </div>
                </div>
              </div>
              <div class="qc-group">
                <span class="qb-label">我的命令<em v-if="customCommands.length">（{{ customCommands.length }}）</em></span>
                <div class="qb-items">
                  <template v-if="customCommands.length">
                    <div v-for="c in customCommands" :key="c.id" class="qb-item">
                      <button class="qb-cmd" type="button" :title="c.desc || c.cmd" @click="fillCommand(c)">
                        <code>{{ c.cmd }}</code>
                        <span v-if="c.desc" class="qb-desc">{{ c.desc }}</span>
                      </button>
                      <button class="qb-act" type="button" :aria-label="`复制 ${c.cmd}`" title="复制"
                        @click="copyCommand(c)"><Icon name="copy" :size="14" /></button>
                      <button class="qb-act" type="button" :aria-label="`编辑 ${c.cmd}`" title="编辑"
                        @click="openEdit(c)"><Icon name="edit" :size="14" /></button>
                      <button class="qb-act danger" type="button" :aria-label="`删除 ${c.cmd}`" title="删除"
                        @click="pendingDelete = c"><Icon name="trash" :size="14" /></button>
                    </div>
                  </template>
                  <span v-else class="empty-inline qb-empty">暂无自定义命令</span>
                </div>
              </div>
            </template>
          </div>
          <div class="qc-foot">
            <button class="btn-ghost btn-sm" type="button" @click="openAdd">
              <Icon name="plus" :size="14" /> 新增自定义命令
            </button>
          </div>
        </div>
      </Teleport>

      <!-- 每个标签一个常驻容器：隐藏而非销毁，切回来才能保住滚动缓冲与回显 -->
      <div v-for="t in tabs" :key="t.id" :ref="(el) => bindPane(t.id, el)"
        class="term-pane" :class="{ active: t.id === activeId }" />

      <TerminalCommandDialog :open="dialogOpen" :initial="editing" :taken-cmds="dialogTakenCmds"
        @close="dialogOpen = false" @save="saveQuick" />
      <ConfirmDialog :open="!!pendingDelete" title="删除自定义命令"
        :detail="`确定删除命令「${pendingDelete?.cmd ?? ''}」吗？`" danger
        @confirm="confirmDelete" @cancel="pendingDelete = null" />
    </template>

    <!-- 终端说明：宿主级权限这类「高危背景约束」的完整交代，入口是工具栏的「?」。 -->
    <HelpDrawer :open="helpOpen" title="终端说明" @close="helpOpen = false">
      <p>这里打开的是运行面板那台服务器上的真实 shell，不是模拟器。</p>
      <h4>权限级别</h4>
      <p>终端拥有<b>宿主级权限</b>：所有命令都以面板进程的运行身份执行。<b>若面板本身以 root 运行，这里的每条命令就是 root 命令</b>，可以读写任意文件、停掉任何服务、重装或重格式化磁盘，面板自身与其他管理功能也一并包含在内。命令产生的后果<u>不受面板的权限校验、敏感文件黑名单和审计规则约束</u>，没有任何二次确认。</p>
      <p>因此这项能力只应对<b>确实需要 shell 的人</b>开放；不需要时请在账号权限里收回终端的「管理」权限。</p>
      <h4>会话生命周期</h4>
      <ul>
        <li>打开页面或新建标签会<b>自动连上</b>，不需要手动点「连接」。</li>
        <li>关闭页面或关闭标签即断开对应会话，shell 进程随之结束（后台任务会收到挂断信号）。</li>
        <li>无任何输入满 <b>15 分钟</b>会自动断开，避免会话被遗忘后常驻。</li>
        <li>同时最多 <b>{{ auth.terminalMax }}</b> 个会话（服务端全局上限，超出只能先关掉别的标签）。</li>
        <li>网络中断不代表命令停止：断线时已发出的命令仍在服务器上继续跑完。</li>
      </ul>
      <h4>断开与重连</h4>
      <p>工具栏那个按钮按当前状态二选一：连着时是<b>断开</b>，已断时是<b>重连</b>。断开会把整个会话连同它启动的进程一起结束，并<b>立刻把并发名额归还</b>；断线后唯一能恢复会话的也是这个按钮（系统不会自动重连）。</p>
      <p><b>它和 <code>Ctrl+C</code> 不是一回事</b>：<code>Ctrl+C</code> 只给前台进程发 SIGINT，回到提示符但<b>会话仍然连著、仍占一个名额</b>，后台任务完全不受影响；在提示符下按更是只会显示 <code>^C</code>。想真正释放会话、或者误连后想主动收掉，只能用「断开」。</p>
      <h4>清屏</h4>
      <p>「清屏」清的是<b>本机屏幕缓冲</b>，不往会话里发任何字符，所以命令正在跑（<code>tail -f</code>、<code>htop</code>、日志刷屏）时也能直接用它把屏幕清干净。它<b>不等于 <code>clear</code> 命令</b>：<code>clear</code> 要按回车才会执行，而命令占着终端时输入进不了 shell。</p>
      <h4>快捷命令</h4>
      <p>工具栏「快捷命令」里保存的命令存在<b>当前登录账号</b>下，换设备、换浏览器都还在，别的账号看不到。它只是把文本填进终端，<b>不会绕过上面的权限约束</b>。</p>
      <h4>操作建议</h4>
      <p>破坏性操作前先确认当前所在目录与用户（<code>pwd</code>、<code>whoami</code>）；需要长期运行的服务请交给 systemd 之类的守护进程，不要挂在这个终端里。</p>
    </HelpDrawer>
  </div>
</template>

<style scoped>
/* 标签栏：与文件管理的 .tabbar 同源（玻璃标签 + 激活浅底），共享 --seg-* token。
   「+ 新标签」一律中性色，不抢 tools-row 里唯一的 btn-primary（连接）。 */
.tabbar { display: flex; align-items: stretch; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
.tab { display: inline-flex; align-items: center; gap: 6px; max-width: 200px; padding: 6px 10px;
  border: 1px solid var(--c-border); border-radius: var(--seg-radius); background: var(--c-glass);
  color: var(--seg-fg); cursor: pointer; font-size: var(--fs-12-5); user-select: none; }
.tab:hover { background: var(--c-hover); color: var(--c-text); }
.tab.on { background: var(--seg-on-bg); color: var(--seg-on-fg); border-color: transparent; font-weight: 600; }
.tab .tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tdot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-text-mute); flex: none; }
.tdot.on { background: var(--c-ok); box-shadow: 0 0 6px var(--c-ok); }
.tab.on .tdot.on { background: var(--seg-on-fg); box-shadow: none; }
.tab-x { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  margin-left: 2px; border: none; background: none; color: inherit; border-radius: var(--radius-chip); cursor: pointer; padding: 0; }
/* 透明伪元素把命中区扩到 28×28，视觉尺寸与 hover 底色不变 */
.tab-x::after { content: ''; position: absolute; inset: -5px; }
/* 关闭钮 hover 的浅色覆盖层：跟着标签自身的前景色走，激活态（白字）与非激活态
   （次要文字色）共用一条规则，不再为两种状态各写一份 rgba。 */
.tab-x:hover { background: color-mix(in srgb, currentColor 28%, transparent); }
.tab.add { color: var(--c-text-dim); }
.tab.add:hover:not(:disabled) { color: var(--c-primary); }
.tab.add:disabled { opacity: .45; cursor: not-allowed; }

/* 页面定高成 flex column：工具行固定，终端 flex:1 吃满剩余视口。
   高度取 100vh - var(--page-chrome-h)（顶栏 + .content 上下内边距的单一来源，窄屏
   自动变小），与 FilesView 的全高布局同源；此前写死 258px 把提示条高度算进常量，
   提示条换行变高就会把整页顶出一屏滚动。 */
.term-view {
  display: flex; flex-direction: column; min-height: 0;
  height: calc(100vh - var(--page-chrome-h));
}
.term-view > .fp-head-row { flex: none; }
.term-view > .err { flex: none; }
/* 终端容器：所有标签共用一套尺寸；非激活的隐藏（保活）而非销毁。 */
.term-pane {
  flex: 1 1 0; min-height: 360px;
  background: var(--term-bg); border: 1px solid var(--c-border); border-radius: var(--radius-md);
  padding: 10px;
}
.term-pane:not(.active) { display: none; }

/* 快捷命令浮层：Teleport 到 body、fixed 定位由脚本按触发钮实测下发。
   层级沿用主布局用户菜单的 40（遮罩）/41（浮层），不另造数值。 */
.qc-backdrop { position: fixed; inset: 0; z-index: 40; }
.qc-popup {
  position: fixed; z-index: 41; width: min(420px, calc(100vw - 24px));
  background: var(--c-surface-2); border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
  padding: 10px; overflow: hidden;
}
.qc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.qc-head strong { font-size: var(--fs-14); }
.qc-tip { font-size: var(--fs-12); color: var(--c-text-mute); }
.qc-x {
  margin-left: auto; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: none; background: none;
  color: var(--c-text-dim); border-radius: var(--radius-chip); cursor: pointer;
}
.qc-x:hover:not(:disabled) { background: var(--c-hover); color: var(--c-primary); transform: none; }
.qc-input-row { display: flex; align-items: center; gap: 8px; }
/* flex 条里先 width:auto 压掉全局 input{width:100%}，再交给 flex 分配余量。 */
.qb-input {
  flex: 1 1 auto; min-width: 0; width: auto; height: 38px;
  font-family: var(--mono); font-size: var(--fs-13);
}
.qc-scroll { margin-top: 10px; max-height: min(420px, 60vh); overflow-y: auto; }
.qc-group { display: flex; align-items: flex-start; gap: 10px; margin-top: 7px; }
.qc-group:first-child { margin-top: 0; }
.qb-label { flex: 0 0 62px; padding-top: 8px; font-size: var(--fs-12-5); color: var(--c-text-mute); }
.qb-label em { font-style: normal; }
.qb-items { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.qb-item {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--c-border); border-radius: var(--radius-xs);
  background: var(--c-glass); padding: 3px 5px 3px 3px;
}
.qb-item:hover { border-color: var(--c-primary); }
.qb-cmd {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 4px 5px; border: none; background: none; color: var(--c-text);
  font-size: var(--fs-12-5); text-align: left; min-width: 0;
}
.qb-cmd code { background: none; padding: 0; }
/* 说明常驻在命令下方：命令名本身看不出用途，靠悬停 title 才读到等于没有。 */
.qb-desc {
  font-size: var(--fs-12); line-height: 1.35; color: var(--c-text-mute);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
.qb-act {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: none; background: none;
  color: var(--c-text-dim); border-radius: var(--radius-chip); cursor: pointer;
}
.qb-act:hover:not(:disabled) { background: var(--c-hover); color: var(--c-primary); transform: none; }
.qb-act.danger:hover:not(:disabled) { color: var(--c-danger); }
.qb-empty { padding: 6px 0; }
.qc-foot { display: flex; justify-content: flex-end; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--c-border); }
</style>
