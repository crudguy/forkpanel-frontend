<script setup lang="ts">
/**
 * 创建容器对话框：包装后端 `POST /api/v1/containers`（`docker create`，默认不启动）。
 *
 * 安全边界（与后端一致，刻意收敛，不做 docker run 的完整能力）：
 * ① 二次确认词 `confirm_token` 必须**手输**精确等于「创建容器」——创建容器等价在宿主
 *    执行任意代码，不允许随手点 OK 就开。
 * ② 不放「特权模式」开关：后端对 `privileged=true` 直接拒绝，前端干脆不提供该入口，
 *    避免用户误开宿主级提权。
 * ③ 卷挂载为自由文本 `src:dst[:ro]`，但**敏感宿主挂载**（如 `/`、docker.sock）会被后端
 *    拒绝（400）；这里只给格式提示，不做前端白名单（白名单在后端，前端校验不可作数）。
 * ④ 端口/环境变量/命令均为"每行一条"的多行输入，提交时按行解析成数组，空行丢弃。
 *
 * 复用 InstallPackageDialog 的弹窗骨架（.mask > .modal.stack）与 useModal 可访问性
 * （Esc 关闭 / Tab 焦点陷阱 / 打开聚焦 / 离场动画 + 焦点返还），保持全站弹窗一致。
 */
import { ref, watch } from 'vue'
import { useModal } from '@/composables/useModal'
import Icon from '@/components/Icon.vue'

/** 提交给父组件的载荷（已解析成后端期望的数组/可选字段；未填的可选项省略）。 */
export interface CreateContainerPayload {
  name: string
  image: string
  confirm_token: string
  cmd?: string[]
  ports?: string[]
  env?: string[]
  volumes?: string[]
  restart?: string
  cpu_quota?: number
  mem_limit?: string
}

const props = defineProps<{
  open: boolean
  busy?: boolean
}>()
const emit = defineEmits<{
  (e: 'confirm', payload: CreateContainerPayload): void
  (e: 'cancel'): void
}>()

const name = ref('')
const image = ref('')
const restart = ref('no')
const portsText = ref('')     // 每行一条 host:container[/proto]
const envText = ref('')       // 每行一条 KEY=VALUE
const volumesText = ref('')   // 每行一条 src:dst[:ro]
const cmdText = ref('')       // 每行一个参数
const cpuQuota = ref<string>('') // 空 = 不限制
const memLimit = ref<string>('') // 空 = 不限制
const confirmToken = ref('')

const CONFIRM_WORD = '创建容器'

// 把多行文本解析成非空数组（去空格、去空行）；全空返回 undefined（不发送该字段）。
function lines(v: string): string[] | undefined {
  const arr = v.split('\n').map((s) => s.trim()).filter(Boolean)
  return arr.length ? arr : undefined
}

const confirmOk = ref(false)
watch(confirmToken, (v) => { confirmOk.value = v === CONFIRM_WORD })

// 表单是否可提交：必填项齐全 + 确认词精确匹配。后端仍会再校验一次（前端校验不可作数）。
const canSubmit = ref(false)
watch(
  () => [name.value, image.value, confirmToken.value],
  () => { canSubmit.value = !!name.value.trim() && !!image.value.trim() && confirmToken.value === CONFIRM_WORD },
  { immediate: true },
)

// 打开时重置——避免上一次的输入残留（尤其是确认词）。
watch(() => props.open, (v) => {
  if (v) {
    name.value = ''; image.value = ''; restart.value = 'no'
    portsText.value = ''; envText.value = ''; volumesText.value = ''
    cmdText.value = ''; cpuQuota.value = ''; memLimit.value = ''
    confirmToken.value = ''; confirmOk.value = false; canSubmit.value = false
  }
})

function confirm() {
  if (!canSubmit.value || props.busy) return
  const payload: CreateContainerPayload = {
    name: name.value.trim(),
    image: image.value.trim(),
    confirm_token: CONFIRM_WORD,
    restart: restart.value,
  }
  const cmd = lines(cmdText.value)
  const ports = lines(portsText.value)
  const env = lines(envText.value)
  const volumes = lines(volumesText.value)
  if (cmd) payload.cmd = cmd
  if (ports) payload.ports = ports
  if (env) payload.env = env
  if (volumes) payload.volumes = volumes
  if (cpuQuota.value.trim()) {
    const n = Number(cpuQuota.value)
    if (!Number.isNaN(n) && n > 0) payload.cpu_quota = n
  }
  if (memLimit.value.trim()) payload.mem_limit = memLimit.value.trim()
  emit('confirm', payload)
}
function cancel() { emit('cancel') }

// Esc 关闭 + Tab 焦点陷阱 + 打开时聚焦（与 ConfirmDialog / InstallPackageDialog 同一套基线）。
const box = ref<HTMLElement | null>(null)
const { close: modalClose } = useModal(() => props.open, box, cancel)
</script>

<template>
  <div v-if="open" class="mask" @click.self="modalClose">
    <div ref="box" class="modal stack" role="dialog" aria-modal="true" aria-label="创建容器">
      <div class="modal-head">
        <h3 class="modal-title">创建容器</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p class="modal-lead">
        等价于 <code>docker create</code>：<b>创建后不会自动启动</b>，请在列表中对它执行「启动」。
        创建容器等同在宿主机执行代码，须手输确认词方可提交。
      </p>

      <div class="fields">
        <label class="req">
          <span>名称</span>
          <input v-model="name" type="text" placeholder="如 my-nginx" autocomplete="off" />
        </label>
        <label class="req">
          <span>镜像</span>
          <input v-model="image" type="text" placeholder="如 nginx:1.27-alpine" autocomplete="off" />
        </label>

        <label>
          <span>重启策略</span>
          <select v-model="restart">
            <option value="no">no（默认，不自动重启）</option>
            <option value="on-failure">on-failure（非 0 退出时重启）</option>
            <option value="always">always（始终重启）</option>
            <option value="unless-stopped">unless-stopped（除非手动停止）</option>
          </select>
        </label>

        <label>
          <span>端口映射<small>（每行一条 host:container[/proto]）</small></span>
          <textarea v-model="portsText" rows="2" placeholder="8080:80&#10;443:443/tcp" spellcheck="false" />
        </label>

        <label>
          <span>环境变量<small>（每行一条 KEY=VALUE）</small></span>
          <textarea v-model="envText" rows="2" placeholder="TZ=Asia/Shanghai&#10;NGINX_PORT=80" spellcheck="false" />
        </label>

        <label>
          <span>卷挂载<small>（每行一条 src:dst[:ro]）</small></span>
          <textarea v-model="volumesText" rows="2" placeholder="/srv/data:/var/lib/data:ro" spellcheck="false" />
          <p class="hint-note is-warn">
            敏感宿主挂载（如 <code>/</code>、<code>/var/run/docker.sock</code>）会被后端拒绝；挂载宿主目录请确认用途。
          </p>
        </label>

        <label>
          <span>启动命令<small>（每行一个参数，覆盖镜像 ENTRYPOINT）</small></span>
          <textarea v-model="cmdText" rows="2" placeholder="nginx&#10;-g&#10;daemon off;" spellcheck="false" />
        </label>

        <div class="row2">
          <label>
            <span>CPU 配额<small>（核数，留空不限制）</small></span>
            <input v-model="cpuQuota" type="number" min="0" step="0.1" placeholder="如 1.5" />
          </label>
          <label>
            <span>内存上限<small>（留空不限制）</small></span>
            <input v-model="memLimit" type="text" placeholder="如 512m / 2g" autocomplete="off" />
          </label>
        </div>

        <label class="req confirm">
          <span>确认词</span>
          <input v-model="confirmToken" type="text" placeholder="请输入：创建容器" autocomplete="off" :class="{ ok: confirmOk }" />
          <p v-if="confirmToken && !confirmOk" class="hint err-tip">确认词须精确为「创建容器」（不含多余空格）。</p>
          <p v-else class="hint">手输「创建容器」以确认你了解这是在宿主机创建进程。</p>
        </label>
      </div>

      <div class="modal-foot">
        <div class="modal-actions">
          <button class="btn-ghost" type="button" :disabled="busy" @click="modalClose">取消</button>
          <button class="btn-primary" type="button" :disabled="!canSubmit || busy" @click="confirm">
            {{ busy ? '创建中…' : '创建容器' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩 / 弹窗框 / 标题行 / 关闭按钮 / 操作条统一取 main.css 公共类。
   以下只补本弹窗特有的表单布局：单列 .fields + 两列 .row2。 */
label { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-13); }
label > span { display: flex; align-items: baseline; gap: 6px; color: var(--c-text); font-weight: 500; }
label > span small { color: var(--c-text-dim); font-weight: 400; font-size: var(--fs-11-5); }
.req > span::after { content: ' *'; color: var(--c-danger); }
.fields { display: flex; flex-direction: column; gap: 14px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
small { line-height: 1.2; }
input, textarea, select {
  width: 100%; padding: 9px 11px; font-size: var(--fs-13); color: var(--c-text);
  background-color: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-xs);
  transition: border-color .14s ease, box-shadow .14s ease;
  font-family: inherit;
}
textarea { resize: vertical; line-height: 1.5; }
input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: none; border-color: var(--c-primary); box-shadow: 0 0 0 3px var(--c-primary-soft);
}
.confirm input.ok { border-color: var(--c-ok); box-shadow: 0 0 0 3px var(--c-ok-soft); }
.code, code { font-family: var(--font-mono); font-size: var(--fs-12); }
.hint { margin: 0; font-size: var(--fs-12); color: var(--c-text-dim); }
.err-tip { color: var(--c-danger); }
.hint-note { margin: 2px 0 0; }
/* 在弹窗里说明性引用 code 用静音色底，避免与输入框混淆 */
.modal-lead code { background: var(--c-hover); padding: 1px 5px; border-radius: 4px; }
</style>
