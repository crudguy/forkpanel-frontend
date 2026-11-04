<script setup lang="ts">
/**
 * 顶栏维护簇：版本号（点击弹出版本面板：检查更新 + 升级）、重装、重启（面板 / 系统）。
 *
 * 门控：整体只对 `system.manage` 可见；owner 判定由后端最终裁决（非 owner 点击后
 * 返回 10003，前端 toast 提示）。
 *
 * ⚠ 浮层（版本面板 / 重启下拉）必须 Teleport 到 body：顶栏 `.topbar` 有
 * `backdrop-filter: blur()`，它会成为 position:fixed 的包含块，留在顶栏内的浮层
 * 会被错误解算（遮罩只覆盖顶栏一条、点外面关不掉）。坐标由 placeXxx() 按触发按钮
 * 实测 getBoundingClientRect 下发（fixed + right 对齐），窗口缩放时重算。
 *
 * 重装 = 复用现有 `upgrade` 路由（发行包重新部署，保留配置与数据）；与「执行升级」
 * 同源，故同样受 `[danger] allow_web_upgrade` 门控（can_upgrade）。
 *
 * 重启系统打破「高危操作不暴露 Web UI」的默认纪律，故用「输入确认词 REBOOT」强二次确认。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { toast } from '@/composables/useToast'
import { usePolling } from '@/composables/usePolling'
import type { UpgradeCheck } from '@/api/types'

const auth = useAuthStore()
const canSys = computed(() => auth.can('system.manage'))
// 安装信息（can_upgrade / can_restart）。后端尚未就绪时按 true 处理：按钮照常显示，
// owner 由后端裁决；加载成功后若后端判定不可（如 allow_web_upgrade 关 / 非 owner），即按 false 收起。
interface Installation { can_upgrade: boolean; can_restart: boolean; upgrade_blocked_reason: string | null }
const installation = ref<Installation | null>(null)
const canUpgrade = computed(() => installation.value?.can_upgrade ?? true)
const canRestart = computed(() => installation.value?.can_restart ?? true)

// ── 版本号 ──
const appVersion = ref('')
async function loadVersion() {
  try {
    const v = await api.get<{ app: string }>(API.version())
    appVersion.value = v?.app ? `v${v.app}` : ''
  } catch { /* 静默：取不到不影响任何操作 */ }
}

// ── 安装信息（can_upgrade / can_restart）──
onMounted(() => { if (canSys.value) void loadInstallation() })
async function loadInstallation() {
  try {
    const r = await api.get<{ deployment: { installation: Installation } }>(API.settings.get())
    installation.value = r.deployment.installation
  } catch { /* 非 owner / 无 settings.manage 时取不到，按钮靠后端裁决 */ }
}

// ── 版本面板（popover）──
const verOpen = ref(false)
const verBtn = ref<HTMLElement | null>(null)
const verPos = ref({ top: '0px', right: '0px' })
function placeVerPanel() {
  const r = verBtn.value?.getBoundingClientRect()
  if (!r) return
  verPos.value = {
    top: `${Math.round(r.bottom + 6)}px`,
    right: `${Math.round(document.documentElement.clientWidth - r.right)}px`,
  }
}
function toggleVerPanel() {
  if (!verOpen.value) { placeVerPanel(); void checkUpgrade() }
  verOpen.value = !verOpen.value
}
watchVerOpenResize()
function watchVerOpenResize() {
  function onResize() { if (verOpen.value) placeVerPanel() }
  onMounted(() => window.addEventListener('resize', onResize))
  onUnmounted(() => window.removeEventListener('resize', onResize))
}

const upgrade = ref<UpgradeCheck | null>(null)
const checkingUpgrade = ref(false)
const upgradeErr = ref('')
async function checkUpgrade() {
  if (checkingUpgrade.value) return
  checkingUpgrade.value = true
  upgradeErr.value = ''
  try {
    const r = await api.get<UpgradeCheck>(API.system.upgradeCheck())
    upgrade.value = r
    if (r.error) upgradeErr.value = r.error
  } catch (e) {
    upgradeErr.value = errorText(e)
  } finally {
    checkingUpgrade.value = false
  }
}

// ── 自动定时检查更新提醒 ──
// 后台周期探测 GitHub Releases；发现新版本时版本号上亮起角标并弹一次提醒。
// 同一版本只提醒一次：已提醒过的版本记入 localStorage，避免每次刷新页面重复弹。
// 升级完成（版本变化）后下次检查即不再 available，角标自动消失。
const updateBadge = ref(false)
let dismissedVersion: string | null = null
function loadDismissed() {
  try { dismissedVersion = localStorage.getItem('fp-update-dismissed') } catch { /* 无 localStorage 时不提醒也无害 */ }
}
function onUpgradeResult() {
  const u = upgrade.value
  if (u && u.available && u.latest) {
    updateBadge.value = true
    if (u.latest !== dismissedVersion) {
      dismissedVersion = u.latest
      try { localStorage.setItem('fp-update-dismissed', u.latest) } catch { /* ignore */ }
      toast(`有新版本 ${u.latest}，点击右上角版本号可升级`)
    }
  } else {
    updateBadge.value = false
  }
}
watch(upgrade, onUpgradeResult)
loadDismissed()
const upgradeOpen = ref(false)   // 版本面板里的「升级」确认
const reinstallOpen = ref(false) // 顶栏「重装」确认
const upgrading = ref(false)
async function postUpgrade(version: string | null, label: string) {
  if (upgrading.value) return
  upgrading.value = true
  try {
    await api.post(API.system.upgrade(), { version })
    toast(`${label}已交给后台执行，页面会在服务恢复后刷新`)
    await waitForUpgrade(appVersion.value)
  } catch (e) {
    upgrading.value = false
    toast(errorText(e), 'err')
  }
}
async function doUpgrade() {
  upgradeOpen.value = false
  await postUpgrade(upgrade.value?.latest ?? null, '升级')
}
async function doReinstall() {
  reinstallOpen.value = false
  // 重装 = 重新安装最新发行版（version=null → 最新），配置与数据保留
  await postUpgrade(null, '重装')
}

/** 升级/重装期间服务先退再起：等「见过断连」或「版本号变了」再刷新，避免旧进程
 *  刚一应答就 reload、看起来像没生效。3 分钟兜底。 */
async function waitForUpgrade(from: string) {
  let sawDown = false
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const v = await api.get<{ app: string }>(API.version())
      if (sawDown || v.app !== from) { location.reload(); return }
    } catch { sawDown = true }
  }
  upgrading.value = false
  toast('操作 3 分钟内未完成：请 SSH 执行 journalctl -u panel-upgrade -n 50 查看', 'err')
}

// ── 重启（面板 / 系统）下拉 ──
const restartMenu = ref(false)
const restartBtn = ref<HTMLElement | null>(null)
const restartPos = ref({ top: '0px', right: '0px' })
function placeRestartMenu() {
  const r = restartBtn.value?.getBoundingClientRect()
  if (!r) return
  restartPos.value = {
    top: `${Math.round(r.bottom + 6)}px`,
    right: `${Math.round(document.documentElement.clientWidth - r.right)}px`,
  }
}
function toggleRestartMenu() {
  if (!restartMenu.value) placeRestartMenu()
  restartMenu.value = !restartMenu.value
}
watchRestartResize()
function watchRestartResize() {
  function onResize() { if (restartMenu.value) placeRestartMenu() }
  onMounted(() => window.addEventListener('resize', onResize))
  onUnmounted(() => window.removeEventListener('resize', onResize))
}

const restartOpen = ref(false)
const rebootOpen = ref(false)
const restarting = ref(false)
async function doRestart() {
  restartOpen.value = false
  if (restarting.value) return
  restarting.value = true
  try {
    await api.post(API.system.restart(), {})
  } catch {
    // 重启瞬间连接被切断是预期行为；是否真起来由 /version 轮询判定
  }
  toast('重启已发起，页面会在服务恢复后自动刷新')
  await waitForRestart()
}
async function waitForRestart() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      await api.get(API.version())
      location.reload()
      return
    } catch { /* 还没起来，继续等 */ }
  }
  restarting.value = false
  toast('面板 40 秒内未恢复：请用 SSH 执行 systemctl status panel 查看', 'err')
}
async function doReboot() {
  rebootOpen.value = false
  if (restarting.value) return
  restarting.value = true
  try {
    await api.post(API.system.reboot(), {})
  } catch {
    // 机器重启会切断连接，请求本身失败是预期；是否真重启由 /version 轮询判定
  }
  toast('服务器重启指令已发送，预计 1-3 分钟，请稍后重新访问')
  await waitForReboot()
}
/** 重启系统：机器起来后面板随之恢复。先等「见过断连」再等恢复；若始终没断连
 *  （reboot 未真正生效），超时提示手动检查。4 分钟兜底。 */
async function waitForReboot() {
  let sawDown = false
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      await api.get(API.version())
      if (sawDown) { location.reload(); return }
    } catch { sawDown = true }
  }
  restarting.value = false
  toast('重启指令已发送但未生效：请 SSH 执行 systemctl reboot 检查', 'err')
}

// 任意浮层打开时监听 Esc 关闭
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { verOpen.value = false; restartMenu.value = false }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

// 首屏即检查一次（让角标/提醒无需等待 12h），随后每 12h 自动复查一次；
// 页面不可见时 usePolling 自动暂停，回家再开不浪费 GitHub 配额。
onMounted(() => { void loadVersion(); if (canSys.value) void checkUpgrade() })
usePolling({ fn: () => { if (canSys.value) void checkUpgrade() }, ms: 12 * 60 * 60 * 1000 })
</script>

<template>
  <div v-if="canSys" class="maint">
    <!-- 版本号胶囊：点击弹出版本面板（检查更新 + 升级）；有新版本时右上角亮起角标 -->
    <button v-if="appVersion" ref="verBtn" type="button" class="ver-chip"
      :aria-expanded="verOpen" aria-haspopup="dialog"
      :title="updateBadge ? `面板版本 ${appVersion} · 有新版本 ${upgrade?.latest ?? ''}，点击查看并升级` : `面板版本 ${appVersion}（点击检查更新与升级）`" @click="toggleVerPanel">
      <Icon name="monitor" :size="13" />
      <span>{{ appVersion }}</span>
      <span v-if="updateBadge" class="up-dot" :title="`有新版本 ${upgrade?.latest ?? ''}`" />
    </button>

    <!-- 重装：复用 upgrade 路由（发行包重新部署） -->
    <button v-if="canUpgrade" type="button" class="m-btn" title="重新安装最新发行版（保留配置与数据）"
      :disabled="upgrading" @click="reinstallOpen = true">
      <Icon name="download" :size="15" />
      <span>{{ upgrading ? '重装中…' : '重装' }}</span>
    </button>

    <!-- 重启下拉（面板 / 系统） -->
    <div v-if="canRestart" class="restart-wrap">
      <button ref="restartBtn" type="button" class="m-btn" :aria-expanded="restartMenu"
        aria-haspopup="menu" title="重启面板应用或整台服务器" @click="toggleRestartMenu">
        <Icon name="restart" :size="15" />
        <span>重启</span>
        <Icon name="chevron" :size="13" class="caret" />
      </button>

      <Teleport to="body">
        <div v-if="restartMenu" class="backdrop" @click="restartMenu = false" />
        <div v-if="restartMenu" class="menu" :style="restartPos">
          <button class="mi" @click="restartMenu = false; restartOpen = true">
            <Icon name="restart" :size="16" /> 重启面板
            <span class="mi-sub">仅重启面板服务，不停机</span>
          </button>
          <button class="mi danger" @click="restartMenu = false; rebootOpen = true">
            <Icon name="restart" :size="16" /> 重启服务器
            <span class="mi-sub">重启整台机器，所有服务中断</span>
          </button>
        </div>
      </Teleport>
    </div>

    <!-- 版本面板（Teleport to body；backdrop-filter 包含块问题） -->
    <Teleport to="body">
      <div v-if="verOpen" class="backdrop" @click="verOpen = false" />
      <div v-if="verOpen" class="ver-panel" :style="verPos" role="dialog" aria-label="版本更新">
        <div class="vp-head">
          <Icon name="monitor" :size="15" />
          <span>面板版本</span>
          <b>{{ appVersion || '—' }}</b>
        </div>

        <button class="vp-check" type="button" :disabled="checkingUpgrade" @click="checkUpgrade">
          <Icon :name="checkingUpgrade ? 'refresh' : 'refresh'" :size="14" />
          {{ checkingUpgrade ? '检查中…' : '检查更新' }}
        </button>

        <p v-if="checkingUpgrade" class="vp-note">检查中…</p>
        <p v-else-if="upgradeErr" class="vp-note bad">检查失败：{{ upgradeErr }}</p>
        <template v-else-if="upgrade">
          <p v-if="upgrade.available" class="vp-note">
            有新版本 <b>{{ upgrade.latest }}</b>（当前 {{ upgrade.current }}）
          </p>
          <p v-else class="vp-note ok">已是最新（{{ upgrade.current }}）</p>
          <p v-if="upgrade.available && !canUpgrade" class="vp-note bad">
            Web 升级未开启：命令行 <code class="mono">sudo panel upgrade</code>
          </p>
          <button v-if="upgrade.available && canUpgrade" class="vp-upgrade" type="button"
            :disabled="upgrading" @click="upgradeOpen = true">
            <Icon name="download" :size="14" /> {{ upgrading ? '升级中…' : '执行升级' }}
          </button>
        </template>
      </div>
    </Teleport>

    <!-- 确认框：升级（输入 UPGRADE） -->
    <ConfirmDialog :open="upgradeOpen" danger title="执行升级" confirm-word="UPGRADE"
      :detail="`将从 ${appVersion} 升级到 ${upgrade?.latest ?? '最新版'}：下载签名包并验签后替换二进制并重启；失败会自动回滚旧版本。输入 UPGRADE 确认。`"
      @confirm="doUpgrade" @cancel="upgradeOpen = false" />

    <!-- 确认框：重装（输入 REINSTALL） -->
    <ConfirmDialog :open="reinstallOpen" danger title="重新安装面板" confirm-word="REINSTALL"
      detail="将从发行包重新部署最新版（保留配置与数据）：下载 → 验签 → 替换二进制 → 重启；失败自动回滚。输入 REINSTALL 确认。"
      @confirm="doReinstall" @cancel="reinstallOpen = false" />

    <!-- 确认框：重启面板（危险，一次确认） -->
    <ConfirmDialog :open="restartOpen" danger title="重启面板" confirm-word="RESTART"
      detail="仅重启面板服务（不影响系统与其他服务）：当前连接会短暂中断，服务恢复后页面自动刷新。输入 RESTART 确认。"
      @confirm="doRestart" @cancel="restartOpen = false" />

    <!-- 确认框：重启系统（危险，输入 REBOOT） -->
    <ConfirmDialog :open="rebootOpen" danger title="重启整台服务器" confirm-word="REBOOT"
      detail="将重启整台机器，所有服务与连接都会中断，预计 1-3 分钟。此操作无法撤销。输入 REBOOT 确认。"
      @confirm="doReboot" @cancel="rebootOpen = false" />
  </div>
</template>

<style scoped>
.maint { display: inline-flex; align-items: center; gap: 10px; flex: none; }

/* 版本胶囊：与现有顶栏胶囊同款外形 */
.ver-chip {
  display: inline-flex; align-items: center; gap: 6px; flex: none; height: 34px; padding: 0 12px;
  border: 1px solid var(--c-border); border-radius: 999px; position: relative;
  background: var(--c-bg); color: var(--c-text-dim);
  font-size: var(--fs-12-5); font-weight: 600; white-space: nowrap; cursor: pointer;
  transition: color .15s ease, background .15s ease, border-color .15s ease;
}
.ver-chip:hover { color: var(--c-text); background: var(--c-hover); border-color: var(--c-border-strong); }
/* 可更新角标：版本号右上角的小绿点，提示有新版本待升级 */
.up-dot {
  position: absolute; top: 4px; right: 4px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--c-ok); box-shadow: 0 0 0 2px var(--c-bg);
}

/* 通用维护按钮（重装 / 重启）：图标 + 文字的 ghost 按钮，与顶栏其余控件等高 */
.m-btn {
  display: inline-flex; align-items: center; gap: 6px; flex: none; height: 34px; padding: 0 12px;
  border: 1px solid var(--c-border); border-radius: 999px;
  background: var(--c-bg); color: var(--c-text); cursor: pointer;
  font-size: var(--fs-12-5); font-weight: 600; white-space: nowrap;
  transition: color .15s ease, background .15s ease, border-color .15s ease;
}
.m-btn:hover:not(:disabled) { background: var(--c-hover); border-color: var(--c-border-strong); }
.m-btn:disabled { opacity: .6; cursor: default; }
.m-btn .caret { color: var(--c-text-dim); transition: transform .15s; }
.m-btn[aria-expanded='true'] .caret { transform: rotate(90deg); }

.restart-wrap { position: relative; display: inline-flex; }

/* 浮层遮罩 + 菜单/面板：Teleport 到 body，fixed 由实测坐标下发 */
.backdrop { position: fixed; inset: 0; z-index: 40; }
.menu {
  position: fixed; z-index: 41; width: 230px;
  background: var(--c-surface-2); border: 1px solid var(--c-border-strong);
  border-radius: 12px; box-shadow: var(--shadow-lg); padding: 6px; overflow: hidden;
}
.mi {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%;
  text-align: left; padding: 9px 10px; border-radius: 8px; color: var(--c-text);
  background: transparent; border: none; font-size: var(--fs-13-5); cursor: pointer;
}
.mi:hover { background: var(--c-hover); }
.mi.danger { color: var(--c-danger); }
.mi.danger:hover { background: color-mix(in srgb, var(--c-danger) 12%, transparent); }
.mi-sub { font-size: var(--fs-12); color: var(--c-text-dim); font-weight: 400; }

/* 版本面板 */
.ver-panel {
  position: fixed; z-index: 41; width: 280px;
  background: var(--c-surface-2); border: 1px solid var(--c-border-strong);
  border-radius: 12px; box-shadow: var(--shadow-lg); padding: 14px;
}
.vp-head { display: flex; align-items: center; gap: 7px; font-size: var(--fs-13); color: var(--c-text-dim); margin-bottom: 12px; }
.vp-head b { margin-left: auto; color: var(--c-text); font-size: var(--fs-13-5); }
.vp-check {
  display: inline-flex; align-items: center; gap: 6px; width: 100%; justify-content: center;
  height: 34px; border: 1px solid var(--c-border); border-radius: 8px;
  background: var(--c-bg); color: var(--c-text); font-size: var(--fs-13); font-weight: 600; cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.vp-check:hover:not(:disabled) { background: var(--c-hover); border-color: var(--c-border-strong); }
.vp-check:disabled { opacity: .6; cursor: default; }
.vp-note { font-size: var(--fs-12-5); line-height: 1.5; margin: 10px 0 0; color: var(--c-text-dim); }
.vp-note b { color: var(--c-text); }
.vp-note.ok { color: var(--c-ok); }
.vp-note.bad { color: var(--c-danger); }
.vp-upgrade {
  display: inline-flex; align-items: center; gap: 6px; width: 100%; justify-content: center;
  height: 34px; margin-top: 10px; border: none; border-radius: 8px;
  background: var(--c-primary); color: #fff; font-size: var(--fs-13); font-weight: 600; cursor: pointer;
  transition: filter .15s ease;
}
.vp-upgrade:hover:not(:disabled) { filter: brightness(1.08); }
.vp-upgrade:disabled { opacity: .6; cursor: default; }

@media (max-width: 720px) {
  .m-btn span { display: none; }
  .m-btn { padding: 0 9px; }
}
</style>
