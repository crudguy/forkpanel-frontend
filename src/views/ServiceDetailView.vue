<script setup lang="ts">
/**
 * 服务详情（独立路由页 /services/:unit）。
 *
 * 为什么从「列表页里的模态弹窗」改成独立页：
 * 弹窗里同时塞了启停操作 + 日志 + 配置编辑三块内容，模态承载过重——
 * 配置编辑器在弹窗里只有半屏高、日志区更挤。改成独立路由页后：
 *  - 地址可分享、浏览器「返回」可用（弹窗两者都不支持）
 *  - 配置编辑/日志有完整高度
 *  - 仍保留列表页作为入口，点行即进详情
 *
 * 安全约束（沿用弹窗时期的设计，勿删）：
 * - sshd 禁止停止（防失联），后端也会拒绝，此处是双保险。
 * - 未托管服务的停止需二次确认。
 * - 配置写入默认单元文件本体，但**推荐 drop-in**：发行版单元文件会在包升级时被覆盖。
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, errorText, isUnsupported } from '@/api/client'
import { API } from '@/api/endpoints'
import {
  CAP, ServiceConfig, ServiceInfo, ServiceJournal, serviceStateLabel,
} from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import EmptyState from '@/components/EmptyState.vue'
import Icon from '@/components/Icon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const unit = computed(() => String(route.params.unit ?? ''))
const canManage = computed(() => auth.enabled(CAP.SERVICE_MANAGE, 'service.manage'))

// 返回上一页面。深链直接进入时 window.history 里没有本站历史，
// router.back() 会退出应用——此时兜底回服务列表。
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push({ name: 'services-units' })
}

const svc = ref<ServiceInfo | null>(null)
const init = ref('')
const loading = ref(true)
const error = ref('')
const actError = ref('')
const busy = ref('')            // `${name}:${action}`
const notFound = ref(false)

// 优先用单服务端点（GET /services/{unit}）：它用 `systemctl show` 按需加载单元，
// 绕开 list 的 `list-units --all` 全量枚举——后者只含已加载进运行时的单元，
// 把 enabled 但从未启动（dead）的服务（典型：刚装好还没 start 的 nginx）整体漏掉，
// 之前导致这类服务点进详情就报"未找到该服务"。
// 请求序号：换 unit（路由参数变化）时前后两次加载会并发，
// 旧的那个若后到，会把新服务的详情覆盖掉（页面显示 A 的名字却配着 B 的数据）。
let svcSeq = 0
async function loadSvc() {
  const seq = ++svcSeq
  loading.value = true; error.value = ''
  try {
    const r = await api.get<{ init_system: string; service: ServiceInfo }>(
      API.services.show(unit.value),
    )
    if (seq !== svcSeq) return
    init.value = r.init_system
    svc.value = r.service
    notFound.value = false
  } catch (e) {
    // 单服务端点失败（单元名非法 / 真不存在 / 网络抖）时退回列表反查兜底，
    // 保证 active 服务的老路径仍可用，且 notFound 语义不变。
    if (seq !== svcSeq) return
    try {
      const r2 = await api.get<{ init_system: string; services: ServiceInfo[] }>(API.services.list())
      if (seq !== svcSeq) return
      init.value = r2.init_system
      const found = (r2.services ?? []).find(s => s.name === unit.value) ?? null
      svc.value = found
      notFound.value = !found
    } catch (e2) { if (seq === svcSeq) error.value = errorText(e2) }
  }
  finally { if (seq === svcSeq) loading.value = false }
}

async function svcAct(action: 'start' | 'stop' | 'restart') {
  if (!svc.value) return
  const name = svc.value.name
  busy.value = `${name}:${action}`; actError.value = ''
  try {
    const url = action === 'start' ? API.services.start(name)
      : action === 'stop' ? API.services.stop(name)
      : API.services.restart(name)
    await api.post(url)
    const st = await api.get<{ name: string; state: string }>(API.services.status(name))
    if (svc.value) svc.value.state = st.state
  } catch (e) { actError.value = errorText(e) }
  finally { busy.value = '' }
}

async function toggleEnable() {
  if (!svc.value) return
  const name = svc.value.name
  busy.value = `${name}:enable`; actError.value = ''
  try {
    await api.put(API.services.setEnabled(name), { enabled: !svc.value.enabled })
    if (svc.value) svc.value.enabled = !svc.value.enabled
  } catch (e) { actError.value = errorText(e) }
  finally { busy.value = '' }
}

/** sshd 不允许 stop：防失联（后端也会拒绝，双保险） */
function stopDisabled(s: ServiceInfo) { return s.name === 'sshd' || s.name === 'ssh' }

function stateBadge(s: string) {
  return s === 'active' ? 'badge-ok' : s === 'failed' ? 'badge-danger'
    : (s === 'activating' || s === 'deactivating') ? 'badge-warn' : ''
}

// ─────────────── 未托管服务停止的二次确认 ───────────────
const confirmStop = ref(false)
function askStop() {
  if (!svc.value) return
  if (svc.value.managed) svcAct('stop')
  else confirmStop.value = true
}

// ─────────────── 日志 ───────────────
const tab = ref<'log' | 'config'>('log')
const journal = ref<string[]>([])
const jLoading = ref(false)
const jError = ref('')

// 日志请求比列表慢得多，换 unit 时最容易后到并覆盖新服务的日志
// （表现：切到 B 服务，日志区显示的仍是 A 的日志，还停留在"加载中"之后）。
let jSeq = 0
async function loadJournal() {
  if (!svc.value) return
  const seq = ++jSeq
  jLoading.value = true; jError.value = ''
  try {
    const r = await api.get<ServiceJournal>(API.services.journal(svc.value.name), { params: { lines: 200 } })
    if (seq !== jSeq) return
    journal.value = r.lines ?? []
  } catch (e) {
    if (seq !== jSeq) return
    if (isUnsupported(e)) jError.value = '日志查看功能即将推出'
    else jError.value = errorText(e)
  } finally { if (seq === jSeq) jLoading.value = false }
}

// ── 日志跟随（SSE）──
// 底层 journalctl -f：连上先补最近 N 行历史，再持续推增量。
// 与一次性 journal 的区别是"不用反复点刷新才能看到新日志"。
const follow = ref(false)
const MAX_KEEP = 500
const MAX_ES_RETRIES = 5
let es: EventSource | null = null
let esRetries = 0

function closeFollow() { if (es) { es.close(); es = null } }

function openFollow() {
  closeFollow()
  esRetries = 0
  journal.value = []
  es = new EventSource(API.services.journalStream(unit.value, 200))
  es.onopen = () => { esRetries = 0 }
  es.addEventListener('log', (ev: MessageEvent) => {
    try {
      const d = JSON.parse(ev.data) as { line: string }
      journal.value.push(d.line)
      if (journal.value.length > MAX_KEEP) journal.value.splice(0, journal.value.length - MAX_KEEP)
    } catch { /* 忽略坏帧 */ }
  })
  // EventSource 断线会自动重连，但要给失败反馈与重连上限（审计 P7）
  es.onerror = () => {
    esRetries += 1
    if (esRetries > MAX_ES_RETRIES) {
      closeFollow()
      follow.value = false
      jError.value = `实时跟随已断开（连续 ${MAX_ES_RETRIES} 次重连失败），已退回静态日志`
      void loadJournal()
    }
  }
}

function toggleFollow() {
  follow.value = !follow.value
  if (follow.value) openFollow()
  else { closeFollow(); void loadJournal() }
}

// ─────────────── 配置（单元文件 / drop-in） ───────────────
//
// 两种写入目标（后端 ConfigTarget）：
//  - unit：单元文件本体。位于 /lib、/usr/lib 的发行版文件**会被包升级覆盖**。
//  - dropin：/etc/systemd/system/<unit>.d/override.conf，与单元文件合并生效、
//    不被包升级覆盖——systemd 官方推荐做法，界面上标为「推荐」。
type CfgTarget = 'unit' | 'dropin'

const cfgTarget = ref<CfgTarget>('unit')
const cfg = ref<ServiceConfig | null>(null)
const cfgDraft = ref('')
const cfgLoading = ref(false)
const cfgError = ref('')
const cfgSaving = ref(false)
const cfgRestart = ref(false)
const cfgSaved = ref(false)

async function loadConfig() {
  cfgLoading.value = true; cfgError.value = ''; cfg.value = null; cfgSaved.value = false
  try {
    const r = await api.get<ServiceConfig>(
      API.services.config(unit.value), { params: { target: cfgTarget.value } })
    cfg.value = r
    cfgDraft.value = r.content
  } catch (e) {
    if (isUnsupported(e)) cfgError.value = '当前环境不支持在线编辑配置'
    else cfgError.value = errorText(e)
  } finally { cfgLoading.value = false }
}

function openConfigTab() {
  tab.value = 'config'
  if (!cfg.value) void loadConfig()
}

watch(cfgTarget, () => { if (tab.value === 'config') void loadConfig() })

async function saveConfig() {
  if (!cfg.value) return
  cfgSaving.value = true; cfgError.value = ''; cfgSaved.value = false
  try {
    await api.put(API.services.configUpdate(unit.value), {
      content: cfgDraft.value,
      restart: cfgRestart.value,
      target: cfgTarget.value,
    })
    cfgSaved.value = true
    await loadConfig()
    if (cfgRestart.value) await loadSvc()
  } catch (e) { cfgError.value = errorText(e) }
  finally { cfgSaving.value = false }
}

onMounted(async () => {
  await loadSvc()
  if (svc.value) void loadJournal()
})

// 同一路由内换 unit 时组件会被复用，onMounted 不会重跑——不监听就会停在旧服务的数据
// 上（且上一个服务的日志跟随流还开着）。必须先关流再重载。
watch(() => route.params.unit, async () => {
  closeFollow()
  follow.value = false
  cfg.value = null          // 否则会带着上一个服务的配置内容进入新服务
  tab.value = 'log'
  await loadSvc()
  if (svc.value) void loadJournal()
})

onUnmounted(closeFollow)
</script>

<template>
  <div>
    <div class="page-head">
      <!-- 返回**上一页面**而非硬编码跳服务页签：本页可从软件页、概览等多处进入，
           写死跳 services-units 会把用户送到一个他从没待过的地方。
           深链直接进入（无历史）时才兜底回服务列表。 -->
      <button class="btn-ghost btn-sm icon-only" title="返回上一页" aria-label="返回上一页"
              @click="goBack">
        <Icon name="chevron-left" :size="14" />
      </button>
      <span v-if="init" class="badge badge-primary">init: {{ init }}</span>
      <span class="spacer" />
      <button class="btn-primary" :disabled="loading || !!busy" @click="loadSvc">
        <Icon name="refresh" :size="15" /> 刷新
      </button>
    </div>

    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <EmptyState v-if="!auth.supported(CAP.SERVICE_MANAGE)"
      title="当前环境不支持服务管理"
      :reason="auth.capabilities[CAP.SERVICE_MANAGE]?.reason ?? undefined" />

    <template v-else>
      <div v-if="loading" class="skeleton" style="height:120px;border-radius:var(--radius)" />

      <EmptyState v-else-if="notFound || !svc" title="未找到该服务"
        :hint="`单元 ${unit} 不在服务列表中，可能已被移除或名称有误`" />

      <template v-else>
        <section class="card svc-head">
          <div class="title-row">
            <h2 class="mono">{{ svc.name }}</h2>
            <span class="badge" :class="stateBadge(svc.state)">{{ serviceStateLabel(svc.state) }}</span>
            <span v-if="!svc.managed" class="badge badge-warn">未托管</span>
          </div>
          <p class="desc">{{ svc.description ?? '无描述' }}</p>

          <p v-if="actError" class="err">{{ actError }}</p>

          <div class="m-acts">
            <button class="btn-ghost" :disabled="!canManage || !!busy || svc.state === 'active'"
              @click="svcAct('start')">
              {{ busy === svc.name + ':start' ? '执行中…' : '启动' }}
            </button>
            <button class="btn-ghost danger" :disabled="!canManage || !!busy || stopDisabled(svc)"
              :title="stopDisabled(svc) ? '禁止停止 SSH 服务以防失联' : ''" @click="askStop">
              {{ busy === svc.name + ':stop' ? '执行中…' : '停止' }}
            </button>
            <button class="btn-ghost" :disabled="!canManage || !!busy" @click="svcAct('restart')">
              {{ busy === svc.name + ':restart' ? '执行中…' : '重启' }}
            </button>
            <span class="spacer" />
            <label class="switch-row" :class="{ on: svc.enabled }">
              <span class="sl-label">开机自启</span>
              <span class="switch">
                <input type="checkbox" :checked="svc.enabled"
                  :disabled="!canManage || !!busy" @change="toggleEnable" /><i />
              </span>
              <span class="sl-state">{{ svc.enabled ? '已启用' : '已关闭' }}</span>
            </label>
          </div>

          <p v-if="!svc.managed" class="tip warn-tip">
            ⚠ 该服务不受面板托管，停止前请确认影响；sshd 的停止会被拒绝以防失联。
          </p>
        </section>

        <section class="card">
          <div class="m-tabs">
            <button class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">日志</button>
            <button class="tab" :class="{ active: tab === 'config' }" :disabled="!canManage"
              @click="openConfigTab">配置</button>
          </div>

          <!-- 日志 -->
          <div v-if="tab === 'log'" class="m-log">
            <div class="sec-head">
              最近日志
              <span v-if="follow" class="badge badge-ok">
                <span class="dot ok" /> 实时跟随中
              </span>
              <span class="spacer" />
              <button class="btn-ghost btn-sm" :class="{ 'tab-active': follow }" @click="toggleFollow">
                <Icon name="refresh" :size="14" /> {{ follow ? '停止跟随' : '实时跟随' }}
              </button>
              <button class="btn-ghost btn-sm" :disabled="jLoading || follow" @click="loadJournal">
                <Icon name="refresh" :size="14" /> 刷新
              </button>
            </div>
            <p v-if="jError" class="err">{{ jError }}</p>
            <pre v-if="jLoading" class="skeleton" style="height:220px" />
            <pre v-else-if="journal.length" class="out">{{ journal.join('\n') }}</pre>
            <p v-else class="tip dim" style="margin:0">暂无日志输出</p>
          </div>

          <!-- 配置 -->
          <div v-else class="m-config">
            <div class="cfg-target">
              <span class="seg-label">写入目标</span>
              <div class="seg">
                <button class="seg-btn" :class="{ active: cfgTarget === 'unit' }"
                  @click="cfgTarget = 'unit'">单元文件</button>
                <button class="seg-btn" :class="{ active: cfgTarget === 'dropin' }"
                  @click="cfgTarget = 'dropin'">drop-in <span class="rec">推荐</span></button>
              </div>
              <span class="spacer" />
              <button class="btn-ghost btn-sm" :disabled="cfgLoading" @click="loadConfig">重新读取</button>
            </div>

            <p v-if="cfgLoading" class="skeleton" style="height:260px" />
            <p v-else-if="cfgError && !cfg" class="err">{{ cfgError }}</p>
            <template v-else-if="cfg">
              <p class="tip dim cfg-path">{{ cfg.path }}</p>
              <p v-if="cfgTarget === 'dropin' && !cfg.exists" class="tip">
                该 drop-in 文件尚不存在，保存后将创建（systemd 会把它与单元文件合并生效）。
              </p>
              <p v-if="cfgTarget === 'unit' && !cfg.writable" class="tip warn-tip">
                ⚠ 该文件位于发行版目录，修改可能在软件包升级时被覆盖。建议改用上方的「drop-in」。
              </p>
              <p v-if="cfgError" class="err">{{ cfgError }}</p>
              <textarea v-model="cfgDraft" class="cfg-edit" spellcheck="false" :disabled="cfgSaving" />
              <div class="cfg-foot">
                <label class="switch-row">
                  <span>保存后重启服务</span>
                  <span class="switch">
                    <input type="checkbox" v-model="cfgRestart" :disabled="cfgSaving" /><i />
                  </span>
                </label>
                <span class="spacer" />
                <span v-if="cfgSaved" class="badge badge-ok">已保存</span>
                <button class="btn-primary" :disabled="cfgSaving || !canManage" @click="saveConfig">
                  {{ cfgSaving ? '保存中…' : '保存配置' }}
                </button>
              </div>
            </template>
          </div>
        </section>
      </template>
    </template>

    <ConfirmDialog :open="confirmStop" danger title="停止服务"
      :detail="`${svc?.name ?? ''} 不受面板托管，停止可能影响依赖它的业务。请确认你了解此操作的后果。`"
      @confirm="() => { confirmStop = false; svcAct('stop') }" @cancel="confirmStop = false" />
  </div>
</template>

<style scoped>
.svc-head { padding: 18px; margin-bottom: 14px; }
/* 返回按钮去掉文字后需保持可点击面积：固定为正方形，图标居中 */
.icon-only { display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; }
.title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.title-row h2 { margin: 0; font-size: 17px; }
.desc { margin: 6px 0 0; font-size: 13px; color: var(--c-text-dim); }
.m-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.mono { font-family: var(--mono); }
.warn-tip { color: var(--c-warn); }
.dim { color: var(--c-text-dim); }

.m-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--c-border); }
.tab { background: none; border: none; padding: 8px 14px; font-size: 13.5px; color: var(--c-text-dim);
      cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab:hover:not(:disabled) { color: var(--c-text); }
.tab.active { color: var(--c-text); border-bottom-color: var(--c-primary); font-weight: 600; }
.tab:disabled { opacity: .5; cursor: not-allowed; }

.m-log { padding-top: 14px; }
.m-log .sec-head { margin-bottom: 8px; }
.tab-active { color: var(--c-primary); border-color: var(--c-primary); }

.m-config { padding-top: 14px; }
.cfg-target { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.seg-label { font-size: 13px; color: var(--c-text-dim); }
.seg { display: inline-flex; border: 1px solid var(--c-border-strong); border-radius: var(--radius-xs); overflow: hidden; }
.seg-btn { border: none; border-radius: 0; background: transparent; padding: 5px 12px; font-size: 13px; color: var(--c-text-dim); }
.seg-btn:hover:not(.active) { background: var(--c-hover); transform: none; }
.seg-btn.active { background: var(--c-primary-soft); color: var(--c-primary); font-weight: 600; }
.rec { font-size: 11px; color: var(--c-ok); margin-left: 4px; }
.cfg-path { font-family: var(--mono); word-break: break-all; margin: 0 0 8px; }
.cfg-edit { width: 100%; min-height: 320px; resize: vertical; box-sizing: border-box;
           padding: 12px 14px; background: var(--c-bg); color: var(--c-text);
           border: 1px solid var(--c-border); border-radius: var(--radius-sm);
           font-family: var(--mono); font-size: 12.5px; line-height: 1.55;
           white-space: pre; overflow: auto; tab-size: 2; }
.cfg-edit:focus { outline: none; border-color: var(--c-primary); }
.cfg-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }

.out { margin: 0; padding: 12px 14px; background: var(--c-bg); border: 1px solid var(--c-border);
       border-radius: var(--radius-sm); font-family: var(--mono); font-size: 12.5px;
       white-space: pre-wrap; word-break: break-all; max-height: 420px; overflow: auto; }

.switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--c-text-dim); cursor: pointer; user-select: none; }
.switch-row.on { color: var(--c-primary); font-weight: 600; }
.sl-label { line-height: 1; }
.sl-state { font-size: 12px; padding: 2px 9px; border-radius: 999px; line-height: 1.4; white-space: nowrap; }
.switch-row.on .sl-state { color: var(--c-primary); background: var(--c-primary-soft); }
.switch-row:not(.on) .sl-state { color: var(--c-text-dim); background: var(--c-hover); }
</style>
