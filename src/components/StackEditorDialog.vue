<script setup lang="ts">
/**
 * 编排编辑器（Compose stack）：面板**生成** compose.yaml，而不是让用户直接写 YAML。
 *
 * 为什么不做自由 YAML 编辑：本仓库依赖预算 38/38 已满（加不了 YAML 解析器），
 * 更要紧的是自由 YAML 等于允许 `privileged: true` / 挂载 `/` / 挂 `docker.sock`
 * ——那正是后端口令创建容器时一直在拦的东西。这里提交的字段由后端类型白名单限定，
 * 危险字段**在结构上不存在**。
 *
 * 复用 CreateContainerDialog 的弹窗骨架（.mask > .modal.stack）与 useModal 可访问性，
 * 保持全站弹窗一致；字符串↔数组的转换在 composables/stackForm.ts（可单测）。
 */
import { ref, watch } from 'vue'
import { useModal } from '@/composables/useModal'
import Icon from '@/components/Icon.vue'
import {
  draftError,
  emptyServiceDraft,
  fromServicePayload,
  projectError,
  toServicePayload,
  type ServiceDraft,
  type StackServicePayload,
} from '@/composables/stackForm'

const props = defineProps<{
  open: boolean
  busy?: boolean
  /** 编辑既有项目时传入；新建时为空 */
  project?: string
  services?: StackServicePayload[]
}>()

const emit = defineEmits<{
  (e: 'submit', project: string, services: StackServicePayload[]): void
  (e: 'cancel'): void
}>()

const box = ref<HTMLElement | null>(null)
const projectName = ref('')
const drafts = ref<ServiceDraft[]>([emptyServiceDraft()])
const localErr = ref('')

const isEdit = () => !!props.project

watch(
  () => props.open,
  (v) => {
    if (!v) return
    localErr.value = ''
    projectName.value = props.project ?? ''
    drafts.value = props.services?.length
      ? props.services.map(fromServicePayload)
      : [emptyServiceDraft()]
  },
)

function addService() {
  drafts.value.push(emptyServiceDraft())
}
function removeService(i: number) {
  // 至少留一个服务：空列表后端会拒，但更重要的是别让用户点没了没法加回来
  if (drafts.value.length <= 1) return
  drafts.value.splice(i, 1)
}

function submit() {
  const pe = projectError(projectName.value)
  if (pe) { localErr.value = pe; return }
  for (const d of drafts.value) {
    const de = draftError(d)
    if (de) { localErr.value = de; return }
  }
  localErr.value = ''
  emit('submit', projectName.value.trim(), drafts.value.map(toServicePayload))
}

function cancel() { emit('cancel') }

const { close: modalClose } = useModal(() => props.open, box, cancel)
</script>

<template>
  <div v-if="open" class="mask" @click.self="modalClose">
    <div ref="box" class="modal stack wide" role="dialog" aria-modal="true" aria-label="编排项目">
      <div class="modal-head">
        <h3 class="modal-title">{{ isEdit() ? '编辑编排' : '新建编排' }}</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>

      <p class="modal-lead">
        面板据此生成 <code>compose.yaml</code>。只支持下列字段——
        <b>特权模式、宿主敏感挂载、host 网络等不在可填范围内</b>（后端不会接受）。
      </p>

      <label class="req">
        <span>项目名</span>
        <input v-model="projectName" type="text" :disabled="isEdit()"
          placeholder="如 my-stack（决定容器名前缀与卷名前缀）" autocomplete="off" />
      </label>

      <div class="svc-list">
        <div v-for="(d, i) in drafts" :key="i" class="svc-card">
          <div class="svc-head">
            <b>服务 {{ i + 1 }}</b>
            <button v-if="drafts.length > 1" class="btn-ghost btn-sm danger" type="button"
              @click="removeService(i)">移除</button>
          </div>

          <div class="fields two">
            <label class="req">
              <span>服务名</span>
              <input v-model="d.name" type="text" placeholder="web" autocomplete="off" />
            </label>
            <label class="req">
              <span>镜像</span>
              <input v-model="d.image" type="text" placeholder="nginx:1.27-alpine" autocomplete="off" />
            </label>
          </div>

          <label>
            <span>启动命令<small>（每行一个参数；含空格的参数写在一行里）</small></span>
            <textarea v-model="d.commandText" rows="2" placeholder="nginx&#10;-g&#10;daemon off;" spellcheck="false" />
          </label>

          <div class="fields two">
            <label>
              <span>端口<small>（逗号分隔）</small></span>
              <input v-model="d.portsText" type="text" placeholder="8080:80, 443:443" autocomplete="off" />
            </label>
            <label>
              <span>重启策略</span>
              <select v-model="d.restart">
                <option value="">（不设置）</option>
                <option value="no">no</option>
                <option value="on-failure">on-failure</option>
                <option value="always">always</option>
                <option value="unless-stopped">unless-stopped</option>
              </select>
            </label>
          </div>

          <label>
            <span>环境变量<small>（逗号分隔 KEY=VALUE）</small></span>
            <input v-model="d.envText" type="text" placeholder="TZ=Asia/Shanghai, NGINX_PORT=80" autocomplete="off" />
          </label>

          <div class="fields two">
            <label>
              <span>卷<small>（逗号分隔；具名卷或非敏感宿主路径）</small></span>
              <input v-model="d.volumesText" type="text" placeholder="data:/data" autocomplete="off" />
            </label>
            <label>
              <span>内存上限<small>（如 512m）</small></span>
              <input v-model="d.memLimit" type="text" placeholder="512m" autocomplete="off" />
            </label>
          </div>
        </div>
      </div>

      <button class="btn-ghost btn-sm add-svc" type="button" @click="addService">+ 添加服务</button>

      <p v-if="localErr" class="err" role="alert">{{ localErr }}</p>

      <p class="hint-note">
        <b>具名卷会带项目名前缀</b>：这里写 <code>data:/data</code>，实际卷名是
        <code>&lt;项目名&gt;_data</code>（compose 的默认行为）。
      </p>

      <div class="modal-actions">
        <button class="btn-ghost" type="button" @click="modalClose">取消</button>
        <button class="btn-primary" type="button" :disabled="busy" @click="submit">
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fields.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.svc-list { display: flex; flex-direction: column; gap: 12px; margin: 10px 0; }
.svc-card {
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 12px;
  background: var(--c-surface-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.svc-head { display: flex; align-items: center; justify-content: space-between; }
.svc-head b { font-size: var(--fs-13); color: var(--c-text); }
.add-svc { align-self: flex-start; margin-bottom: 8px; }
</style>
