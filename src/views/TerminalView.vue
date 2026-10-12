<script setup lang="ts">
/**
 * 内置 Web 终端（#51 / 后端 routes/terminal.rs）。
 *
 * 帧协议（与后端严格对应）：
 * - 服务端 → 前端：二进制帧 = PTY 原始输出字节（直接喂 xterm）；
 *   文本帧 = 控制 JSON {t:"ready",shell} / {t:"exit",code} / {t:"notice",msg}。
 * - 前端 → 服务端：二进制帧 = 用户输入原始字节（term.onData 的 UTF-8 串重新编码）；
 *   文本帧 = 控制 JSON {t:"resize",cols,rows}。
 *
 * 安全：WebSocket 升级无法带 X-CSRF-Token 头，浏览器自动带同源 Cookie（panel_sid），
 * 后端用 Origin == scheme://Host 同源校验替代 CSRF。前端**不**构造任何命令，
 * 所有输入只写进 PTY master，与后端"终端=合法代码执行入口、防线在会话建立时"一致。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuthStore } from '@/stores/auth'
import { CAP } from '@/api/types'
import EmptyState from '@/components/EmptyState.vue'
import RiskBanner from '@/components/RiskBanner.vue'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const enabled = computed(() => auth.enabled(CAP.TERMINAL_MANAGE, 'system.manage'))

const termEl = ref<HTMLElement | null>(null)
const status = ref('未连接')
const connected = ref(false)
const shell = ref<string | null>(null)
const errorMsg = ref('')

let term: Terminal | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null

/** 按当前页面地址构造同源 WS URL（dev 经 Vite /api 代理；prod 同主机）。 */
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/v1/terminal`
}

function ensureTerm() {
  if (term || !termEl.value) return
  term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(termEl.value)
  fit.fit()
  term.onData(onData)
  term.onResize(onResize)
}

function onData(d: string) {
  // 用户输入原样编码为字节写进 PTY（含多字节 UTF-8，如中文）
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d))
}

function onResize({ cols, rows }: { cols: number; rows: number }) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'resize', cols, rows }))
  }
}

function onResizeWin() { fit?.fit() }

function connect() {
  if (!enabled.value || ws) return
  ensureTerm()
  errorMsg.value = ''
  status.value = '连接中…'
  try {
    ws = new WebSocket(wsUrl())
  } catch {
    errorMsg.value = '无法建立终端连接'
    return
  }
  ws.binaryType = 'arraybuffer'
  // 捕获本次连接的 socket 引用：onclose 是异步触发的，重连时旧 socket 的 onclose
  // 会在新连接建好之后才跑，届时需要分辨「关掉的是不是当前这个」。
  const sock = ws

  ws.onopen = () => { connected.value = true; status.value = shell.value ? `已连接 · ${shell.value}` : '已连接' }
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data) as { t?: string; shell?: string; code?: number; msg?: string }
        if (m.t === 'ready') {
          shell.value = m.shell ?? null
          status.value = `已连接 · ${m.shell ?? 'shell'}`
          term?.writeln(`\r\n\x1b[2m[终端就绪 · ${m.shell ?? ''}]\x1b[0m`)
        } else if (m.t === 'exit') {
          term?.writeln(`\r\n\x1b[33m[会话结束 code=${m.code ?? 0}]\x1b[0m`)
          disconnect()
        } else if (m.t === 'notice') {
          term?.writeln(`\r\n\x1b[33m[提示] ${m.msg ?? ''}\x1b[0m`)
        }
      } catch { /* 忽略坏帧 */ }
    } else {
      // 二进制帧 = PTY 原始输出
      term?.write(new Uint8Array(ev.data as ArrayBuffer))
    }
  }
  ws.onclose = () => {
    // 重连场景：disconnect() 关闭旧 socket 后会立刻建新连接，而旧 socket 的 onclose
    // 是异步触发的。此处若无条件清 ws，会把刚建好的新连接引用抹掉——新连接从此
    // 无法被 disconnect()/onUnmounted 关闭（泄漏），终端还会多打一行「连接已关闭」。
    if (ws !== sock) return
    connected.value = false
    status.value = '已断开'
    term?.writeln('\r\n\x1b[33m[连接已关闭]\x1b[0m')
    ws = null
  }
  ws.onerror = () => { errorMsg.value = '终端连接出错（可能被只读模式 / 同源策略拒绝）' }
}

function disconnect() {
  if (ws) { ws.close(); ws = null }
  connected.value = false
}

function reconnect() { disconnect(); connect() }
function clearScreen() { term?.clear() }

onMounted(() => { if (enabled.value) connect(); window.addEventListener('resize', onResizeWin) })
onUnmounted(() => { window.removeEventListener('resize', onResizeWin); disconnect(); term?.dispose() })
</script>

<template>
  <div>
    <div class="page-head">
      <span class="spacer" />
      <span class="stat" :class="{ on: connected }">
        <span class="dot" /> {{ status }}
      </span>
      <button class="btn-primary" :disabled="!enabled || connected" @click="connect">
        <Icon name="bolt" :size="15" /> 连接
      </button>
      <button class="btn-ghost" :disabled="!connected" @click="disconnect">
        <Icon name="stop" :size="15" /> 断开
      </button>
      <button class="btn-ghost" :disabled="!connected" @click="reconnect">
        <Icon name="refresh" :size="15" /> 重连
      </button>
      <button class="btn-ghost" :disabled="!enabled" @click="clearScreen">
        <Icon name="trash" :size="15" /> 清屏
      </button>
    </div>

    <EmptyState v-if="!enabled"
      title="当前环境不支持 Web 终端"
      :reason="auth.capabilities[CAP.TERMINAL_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <p v-if="errorMsg" class="err" role="alert">{{ errorMsg }}</p>
      <div ref="termEl" class="term" :class="{ dim: !connected }" />
      <RiskBanner level="danger" title="宿主级权限"
        text="终端拥有宿主级权限，所有命令以面板运行身份执行；关闭页面即断开会话。" />
    </template>
  </div>
</template>

<style scoped>
.stat { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--c-text-mute); }
.stat.on { color: var(--c-ok, #3fb950); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-text-mute); }
.stat.on .dot { background: var(--c-ok, #3fb950); box-shadow: 0 0 8px var(--c-ok, #3fb950); }

.term {
  height: calc(100vh - 220px); min-height: 360px;
  background: #0d1117; border: 1px solid var(--c-border); border-radius: 12px;
  padding: 10px; transition: opacity .2s ease;
}
.term.dim { opacity: .55; }
.hint { color: var(--c-text-mute); font-size: 12px; margin: 8px 0 0; }
.err { color: var(--c-danger); font-size: 13px; }
</style>
