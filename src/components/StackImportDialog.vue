<script setup lang="ts">
/**
 * 安全导入助手（Compose stack）：粘贴外部 docker-compose YAML（可选 .env），
 * 后端只抽取白名单子集并报告被忽略的字段，确认后再走既有「保存编排」创建。
 *
 * 设计要点（与后端一致）：这不是"放开原始 YAML"——面板只取白名单字段，
 * 危险字段（privileged / 挂 / / docker.sock / network_mode）在抽取阶段就被挡掉。
 * 复用 StackEditorDialog 的弹窗骨架（.mask > .modal.stack）与 useModal。
 */
import { computed, ref, watch } from 'vue'
import { useModal } from '@/composables/useModal'
import Icon from '@/components/Icon.vue'
import ExpandableTextarea from '@/components/ExpandableTextarea.vue'
import {
  projectError,
  type StackServicePayload,
} from '@/composables/stackForm'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'

interface ImportDropped { service: string; field: string }
interface ImportPreview {
  spec: { project: string; services: StackServicePayload[] }
  dropped: ImportDropped[]
  warnings: string[]
  errors: string[]
}

const props = defineProps<{
  open: boolean
  /** 父级正在执行保存（PUT stacks/{project}）时为 true */
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', project: string, services: StackServicePayload[]): void
  (e: 'cancel'): void
}>()

const box = ref<HTMLElement | null>(null)
const yamlText = ref('')
const envText = ref('')
const preview = ref<ImportPreview | null>(null)
const parsing = ref(false)
const parseErr = ref('')

const { close: modalClose } = useModal(() => props.open, box, cancel)

watch(
  () => props.open,
  (v) => {
    if (!v) return
    parseErr.value = ''
    // 每次打开重置为空白，让用户重新粘贴（不在两次导入间串数据）
    if (!preview.value) {
      yamlText.value = ''
      envText.value = ''
    }
  },
)

const projectName = ref('')
watch(preview, (p) => {
  if (p) projectName.value = p.spec.project ?? ''
})

const projectErr = computed(() => projectError(projectName.value))
const canConfirm = computed(() => {
  if (!preview.value || parsing.value || props.busy) return false
  if ((preview.value.errors?.length ?? 0) > 0) return false
  if (projectErr.value) return false
  return true
})

/** 被忽略字段按服务归组，方便阅读 */
const droppedByService = computed(() => {
  const map = new Map<string, string[]>()
  for (const d of preview.value?.dropped ?? []) {
    const arr = map.get(d.service) ?? []
    arr.push(d.field)
    map.set(d.service, arr)
  }
  return [...map.entries()]
})

async function parse() {
  parseErr.value = ''
  preview.value = null
  if (!yamlText.value.trim()) {
    parseErr.value = '请粘贴 compose YAML 内容'
    return
  }
  parsing.value = true
  try {
    const data = await api.post<ImportPreview>(API.containers.stackImportPreview(), {
      yaml: yamlText.value,
      env: envText.value.trim() ? envText.value : undefined,
    })
    preview.value = data
  } catch (e) {
    parseErr.value = errorText(e)
  } finally {
    parsing.value = false
  }
}

function confirm() {
  if (!preview.value || !canConfirm.value) return
  emit('submit', projectName.value.trim(), preview.value.spec.services)
}

function cancel() { emit('cancel') }
</script>

<template>
  <Teleport to="body">
  <div v-if="open" class="mask" @click.self="modalClose">
    <div ref="box" class="modal stack wide" role="dialog" aria-modal="true" aria-label="导入编排">
      <div class="modal-head">
        <h3 class="modal-title">导入编排</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>

      <p class="modal-lead">
        粘贴外部 <code>docker-compose.yml</code>（可选 <code>.env</code>）。面板只抽取
        <b>镜像 / 端口 / 环境变量 / 卷 / 重启 / 内存上限</b> 这些受支持字段，其余字段会列出并忽略，
        <b>特权模式、宿主敏感挂载、host 网络等不会进入编排</b>。
      </p>

      <label>
        <span>compose YAML<small>（必填）</small></span>
        <ExpandableTextarea v-model="yamlText" :rows="7"
          :placeholder="'version: \'3\'\nservices:\n  web:\n    image: nginx:1.27-alpine\n    ports:\n      - 8080:80'" />
      </label>

      <label>
        <span>环境变量文件（.env）<small>（可选；KEY=VALUE 每行一个，合并到所有服务）</small></span>
        <ExpandableTextarea v-model="envText" :rows="3"
          :placeholder="'TZ=Asia/Shanghai\nNGINX_PORT=80'" />
      </label>

      <div class="actions-row">
        <button class="btn-primary btn-sm" type="button" :disabled="parsing" @click="parse">
          {{ parsing ? '解析中…' : '解析' }}
        </button>
        <span v-if="parseErr" class="err" role="alert">{{ parseErr }}</span>
      </div>

      <template v-if="preview">
        <label class="req">
          <span>项目名</span>
          <input v-model="projectName" type="text" autocomplete="off"
            placeholder="如 my-stack（决定容器名前缀与卷名前缀）" />
        </label>
        <p v-if="projectErr" class="err" role="alert">{{ projectErr }}</p>

        <!-- 抽取到的服务 -->
        <div class="preview-block">
          <h4>将创建 {{ preview.spec.services.length }} 个服务</h4>
          <div v-for="s in preview.spec.services" :key="s.name" class="svc-mini">
            <b class="mono">{{ s.name }}</b>
            <span class="dim mono">{{ s.image }}</span>
            <div class="chips">
              <span v-for="p in (s.ports ?? [])" :key="'p' + p" class="chip">{{ p }}</span>
              <span v-for="v in (s.volumes ?? [])" :key="'v' + v" class="chip vol">{{ v }}</span>
              <span v-if="s.restart" class="chip">{{ s.restart }}</span>
              <span v-if="s.mem_limit" class="chip">{{ s.mem_limit }}</span>
              <span v-for="e in (s.env ?? [])" :key="'e' + e" class="chip env">{{ e }}</span>
            </div>
          </div>
        </div>

        <!-- 被忽略字段 -->
        <div v-if="droppedByService.length" class="preview-block warn">
          <h4>以下字段不在支持范围，导入后将忽略</h4>
          <ul class="dropped">
            <li v-for="[svc, fields] in droppedByService" :key="svc">
              <b class="mono">{{ svc }}</b>：{{ fields.join('、') }}
            </li>
          </ul>
        </div>

        <!-- 提示 -->
        <p v-for="w in (preview.warnings ?? [])" :key="w" class="hint" role="alert">{{ w }}</p>
        <!-- 阻断性错误 -->
        <p v-for="e in (preview.errors ?? [])" :key="e" class="err" role="alert">{{ e }}</p>
      </template>

      <div class="modal-actions">
        <button class="btn-ghost" type="button" @click="modalClose">取消</button>
        <button class="btn-primary" type="button" :disabled="!canConfirm" @click="confirm">
          {{ busy ? '保存中…' : '确认导入' }}
        </button>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
label { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-13); margin-top: 10px; }
label > span { display: flex; align-items: baseline; gap: 6px; color: var(--c-text); font-weight: 500; }
label > span small { color: var(--c-text-dim); font-weight: 400; font-size: var(--fs-12); }
.req > span::after { content: ' *'; color: var(--c-danger); }
textarea, input {
  width: 100%; padding: 9px 11px; font-size: var(--fs-13); color: var(--c-text);
  background-color: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-xs);
  transition: border-color .14s ease, box-shadow .14s ease;
  font-family: var(--mono);
}
textarea { resize: vertical; line-height: 1.5; }
textarea:focus-visible, input:focus-visible {
  outline: none; border-color: var(--c-primary); box-shadow: 0 0 0 3px var(--c-primary-soft);
}
.actions-row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
.err { color: var(--c-danger); font-size: var(--fs-12); }
.hint { color: var(--c-warn); font-size: var(--fs-12); margin: 8px 0 0; line-height: 1.5; }
.preview-block { margin-top: 14px; padding: 12px; border: 1px solid var(--c-border); border-radius: var(--radius-sm); background: var(--c-surface-2); }
.preview-block h4 { margin: 0 0 8px; font-size: var(--fs-13); color: var(--c-text); }
.preview-block.warn { border-color: var(--c-warn-bg); }
.preview-block.warn h4 { color: var(--c-warn); }
.svc-mini { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: 1px dashed var(--c-border); }
.svc-mini:first-of-type { border-top: 0; }
.svc-mini .dim { font-size: var(--fs-12); color: var(--c-text-dim); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  font-family: var(--mono); font-size: var(--fs-12); padding: 2px 7px; border-radius: 5px;
  background: var(--bg-inset); color: var(--c-text-dim); border: 1px solid var(--c-border);
}
.chip.vol { color: var(--c-primary); }
.chip.env { color: var(--c-text-mute); }
.dropped { margin: 0; padding-left: 18px; font-size: var(--fs-12); color: var(--c-text-dim); line-height: 1.7; }
.dropped .mono { color: var(--c-text); }
</style>
