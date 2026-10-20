<script setup lang="ts">
/**
 * 容器日志查看对话框：包装后端 `GET /api/v1/containers/{id}/logs`（docker logs 只读最近 N 行）。
 *
 * 安全边界（与后端一致，刻意收敛）：
 * ① 只回显快照、**不带 --follow**——实时跟随会让 docker 的 stdout 永不 EOF，把面板请求挂死；
 *    UI 提供「自动刷新 (3s)」轮询来弥补"非实时"。
 * ② tail 上限 2000 行：前端只给档位选项（100/200/500/1000/2000），后端二次夹取，
 *    防一次把内存 / UI 打爆。
 * ③ 读操作，受 container.view 门控（父组件列表已按该权限渲染按钮）；不写、不删。
 *
 * 复用 CreateContainerDialog 的弹窗骨架（.mask > .modal.stack）与 useModal 可访问性
 * （Esc 关闭 / Tab 焦点陷阱 / 打开聚焦 / 离场动画 + 焦点返还），保持全站弹窗一致。
 */
import { ref, watch, computed } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useModal } from '@/composables/useModal'
import { usePolling } from '@/composables/usePolling'
import Icon from '@/components/Icon.vue'
import { toast } from '@/composables/useToast'

const props = defineProps<{
  open: boolean
  /** 容器 ID 或名称（后端白名单校验）；完整 ID 与短名皆可。 */
  containerId: string
  /** 展示用名称（标题与空态提示，不进请求体）。 */
  containerName: string
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

/** 单行日志（与后端 ContainerLogLine 对齐：ts 仅 timestamps=true 时存在）。 */
interface LogLine { ts?: string; text: string }

const TAILS = [100, 200, 500, 1000, 2000]
const tail = ref(200)
const withTs = ref(false)
const auto = ref(false)
const lines = ref<LogLine[]>([])
const loading = ref(false)
const error = ref('')

/** 把日志行拼成单段纯文本：带时间戳则前缀，方便整段复制 / 选择。 */
const text = computed(() =>
  lines.value.map((l) => (l.ts ? l.ts + ' ' : '') + l.text).join('\n'),
)
const hasLogs = computed(() => lines.value.length > 0)
const empty = computed(() => !loading.value && !error.value && lines.value.length === 0)

const box = ref<HTMLElement | null>(null)
const { close: modalClose } = useModal(() => props.open, box, () => emit('close'))

async function refresh() {
  if (!props.containerId) return
  loading.value = true
  try {
    const r = await api.get<LogLine[]>(API.containers.logs(props.containerId), {
      params: { tail: tail.value, timestamps: withTs.value },
    })
    lines.value = r
    error.value = ''
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}

function copyAll() {
  if (!hasLogs.value) return
  navigator.clipboard?.writeText(text.value).then(
    () => toast('已复制日志'),
    () => toast('复制失败，请手动选择', 'err'),
  )
}

// 打开即拉一次。tail / timestamps 变化（且开着）即重新拉取。
watch(() => props.open, (v) => {
  if (v) { lines.value = []; error.value = ''; refresh() }
})
watch([tail, withTs], () => { if (props.open) refresh() })

// 3s 一轮；「自动刷新」开关与弹窗开合用 enabled 表达，无需手写 start/stop。
// 顺带获得：标签隐藏时暂停（原先弹窗开着切到别的标签仍每 3s 拉一次日志）。
usePolling({ fn: refresh, ms: 3000, enabled: () => auto.value && props.open })
</script>

<template>
  <div v-if="open" class="mask" @click.self="modalClose">
    <div ref="box" class="modal stack" role="dialog" aria-modal="true" :aria-label="`容器日志 ${containerName}`">
      <div class="modal-head">
        <h3 class="modal-title">容器日志</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p class="modal-lead">
        容器 <code>{{ containerName }}</code> 的最近日志（只读快照，<b>不实时跟随</b>；勾选自动刷新可近似轮询）。
      </p>

      <div class="bar">
        <label class="bar-item">
          <span>行数</span>
          <select v-model.number="tail" aria-label="日志行数">
            <option v-for="t in TAILS" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label class="bar-item check">
          <input type="checkbox" v-model="withTs" />
          <span>时间戳</span>
        </label>
        <label class="bar-item check">
          <input type="checkbox" v-model="auto" />
          <span>自动刷新 (3s)</span>
        </label>
        <span class="spacer" />
        <button class="btn-ghost btn-sm" type="button" :disabled="loading" @click="refresh">
          <Icon name="refresh" :size="14" /> 刷新
        </button>
        <button class="btn-ghost btn-sm" type="button" :disabled="!hasLogs" @click="copyAll">
          复制
        </button>
      </div>

      <div class="logs-wrap">
        <p v-if="error" class="err">{{ error }}</p>
        <p v-else-if="empty" class="dim pad">该容器暂无日志输出。</p>
        <pre v-else class="logs" :class="{ busy: loading }">{{ text || ' ' }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩 / 弹窗框 / 标题行 / 关闭按钮统一取 main.css 公共类；以下只补本弹窗特有布局。 */
label { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-13); }
label > span { color: var(--c-text); font-weight: 500; }

/* 工具条：行数选择 + 两个开关 + 刷新/复制；整体随弹窗宽度换行。 */
.bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; }
.bar-item { flex-direction: row; align-items: center; gap: 6px; }
.bar-item > span { font-weight: 400; color: var(--c-text-dim); }
.bar-item.check { cursor: pointer; user-select: none; }
.bar-item.check input { width: 15px; height: 15px; accent-color: var(--c-primary); }
.bar select {
  height: 31px; padding: 0 8px; font-size: var(--fs-13); color: var(--c-text);
  background-color: var(--c-bg); border: 1px solid var(--c-border-strong); border-radius: var(--radius-xs);
}
.bar select:focus-visible { outline: none; border-color: var(--c-primary); }
.bar .spacer { flex: 1; }

/* 日志区：等宽、可滚动、最大高度受弹窗高度约束；loading 时降透明度提示刷新中。 */
.logs-wrap { min-height: 200px; }
.logs {
  margin: 0; max-height: 56vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-family: var(--font-mono); font-size: var(--fs-12); line-height: 1.6;
  color: var(--c-text); background: var(--c-bg); border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-xs); padding: 12px 14px;
}
.logs.busy { opacity: 0.6; }
.pad { padding: 14px; }
.dim { color: var(--c-text-dim); }
.code, code { font-family: var(--font-mono); font-size: var(--fs-12); background: var(--c-hover); padding: 1px 5px; border-radius: 4px; }
</style>
