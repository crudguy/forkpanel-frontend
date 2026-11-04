<script setup lang="ts">
/**
 * 编辑容器资源限制对话框：`GET /containers/{id}/limits` 预填 + `PATCH /containers/{id}` 提交。
 *
 * ## 为什么只有三个字段
 * Docker 的约束是硬的：容器 `create` 成功那一刻，`image` / `ports` / `env` /
 * `volumes` / `cmd` / `privileged` 就固化了，**没有任何命令能改**（`name` 另有
 * `docker rename`，面板未开放）。`docker update` 能动的只有 CPU 配额、内存上限、
 * 重启策略。把它做成"编辑容器"那样的大表单，等于让用户填完一整屏再告诉他
 * 大半字段改了没用——所以只开三个字段，并把"其余改不了"直接写在弹窗里。
 *
 * ## 为什么"留空"是保持不变，而不是不限制
 * `docker update --cpus 0` / `--memory 0` 会被守护进程**静默忽略**（实测 rc=0
 * 而值纹丝不动），`--memory -1` 直接报 `invalid size`。也就是说"把限制去掉"
 * 在 `docker update` 里根本做不到。给一个"清空即不限制"的入口，就是一个
 * 点了没反应的假按钮。所以：留空 = 这项不动；要彻底去掉限制只能删容器重建。
 * 这句话必须出现在界面上，而不是只写在代码注释里。
 *
 * ## 数据自持
 * 现值由本组件自己拉（父级只给 id/名称），loading 与错误也自己管，失败时就地
 * 给"重试"——不拖累容器列表，也不让用户在"现值未知"的状态下盲改生产容器。
 */
import { computed, reactive, ref, watch } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useModal } from '@/composables/useModal'
import Icon from '@/components/Icon.vue'
import {
  buildPayload,
  canSubmit as canSubmitOf,
  cpuError,
  fmtCurrent,
  formFromCurrent,
  memError,
  type CurrentLimits,
  type LimitsForm,
} from '@/components/containers/limitsForm'

const props = defineProps<{
  open: boolean
  busy?: boolean
  /** 容器 ID 或名称（后端两者都认；用名称更稳——ID 随重建变化）。 */
  containerId: string
  containerName?: string
  containerImage?: string
}>()
const emit = defineEmits<{
  (e: 'confirm', payload: ReturnType<typeof buildPayload>): void
  (e: 'cancel'): void
}>()

const form = reactive<LimitsForm>({ cpuQuota: '', memLimit: '', restart: 'no' })
const cur = ref<CurrentLimits | null>(null)
const loading = ref(false)
const loadErr = ref('')

async function load() {
  if (!props.containerId) return
  loading.value = true
  loadErr.value = ''
  try {
    const r = await api.get<CurrentLimits>(API.containers.limits(props.containerId))
    cur.value = r
    Object.assign(form, formFromCurrent(r))
  } catch (e) {
    // 现值读不到就**不允许提交**：不知道会改成什么的时候改生产容器，是最坏的一种
    cur.value = null
    loadErr.value = errorText(e)
  } finally {
    loading.value = false
  }
}

// 每次打开都重拉：容器可能被外部 CLI 改过，缓存一份旧现值会误导用户
watch(() => props.open, (v) => {
  if (v) {
    cur.value = null
    loadErr.value = ''
    Object.assign(form, { cpuQuota: '', memLimit: '', restart: 'no' })
    void load()
  }
})

const cpuMsg = computed(() => cpuError(form.cpuQuota))
const memMsg = computed(() => memError(form.memLimit))
const canSubmit = computed(() => !loading.value && !props.busy && canSubmitOf(form, cur.value))
const currentText = computed(() => fmtCurrent(cur.value))

function confirm() {
  if (!canSubmit.value) return
  emit('confirm', buildPayload(form))
}
function cancel() { emit('cancel') }

const box = ref<HTMLElement | null>(null)
const { close: modalClose } = useModal(() => props.open, box, cancel)
</script>

<template>
  <Teleport to="body">
  <div v-if="open" class="mask" @click.self="modalClose">
    <div ref="box" class="modal stack" role="dialog" aria-modal="true" aria-label="编辑资源限制">
      <div class="modal-head">
        <h3 class="modal-title">编辑资源限制</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>

      <p class="modal-lead">
        等价于 <code>docker update</code>：<b>不会重启容器</b>。CPU / 内存是热改
        cgroup，重启策略只影响它下次退出时的行为。
      </p>

      <p v-if="containerName" class="target">
        <span class="mono">{{ containerName }}</span>
        <span v-if="containerImage" class="dim mono">（{{ containerImage }}）</span>
      </p>

      <!-- 现值：用户必须先看到"现在是多少"，否则调大调小全是盲改 -->
      <p v-if="currentText !== '—'" class="cur-line">
        当前：<span class="mono">{{ currentText }}</span>
      </p>

      <p v-if="loading" class="hint loading-line">正在读取当前限制…</p>

      <p v-else-if="loadErr" class="err-bar" role="alert">
        {{ loadErr }}
        <button class="btn-ghost btn-sm" type="button" @click="load()">重试</button>
      </p>

      <template v-else>
        <div class="fields">
          <div class="row2-wrap">
            <div class="row2">
              <label>
                <span>CPU 配额</span>
                <input v-model="form.cpuQuota" type="number" min="0" step="0.1"
                  placeholder="如 1.5" :class="{ bad: !!cpuMsg }" />
              </label>
              <label>
                <span>内存上限</span>
                <input v-model="form.memLimit" type="text" placeholder="如 512m"
                  autocomplete="off" :class="{ bad: !!memMsg }" />
              </label>
            </div>
            <p v-if="cpuMsg || memMsg" class="hint err-tip">{{ cpuMsg || memMsg }}</p>
            <p v-else class="hint">CPU 为核数，可带小数；内存支持 k / m / g 后缀。<b>留空 = 这项保持不变</b>。</p>
          </div>

          <label>
            <span>重启策略</span>
            <select v-model="form.restart">
              <option value="no">no（不自动重启）</option>
              <option value="on-failure">on-failure（非 0 退出时重启）</option>
              <option value="always">always（始终重启）</option>
              <option value="unless-stopped">unless-stopped（除非手动停止）</option>
            </select>
          </label>

          <p class="hint-note is-warn">
            <Icon name="alert" :size="14" class="ic" />
            <span>
              <b>取消限制做不到：</b>把限制去掉需要重建容器——<code>docker update</code>
              传 0 会被静默忽略（看着成功、值不变），传负数直接报错。留空只是"不动这项"。
            </span>
          </p>

          <p class="hint-note">
            <Icon name="info" :size="14" class="ic" />
            <span>
              <b>镜像、端口映射、环境变量、卷挂载、启动命令创建后不可修改</b>，
              Docker 没有对应命令。要改这些请删除容器后用新参数重建。
            </span>
          </p>
        </div>
      </template>

      <!-- 操作条常驻：加载中 / 读取失败时也要有可见的「取消」出口，
           否则弹窗看着像卡死（`.modal-foot` 若跟着表单一起条件渲染就会这样）。 -->
      <div class="modal-foot">
        <div class="modal-actions">
          <button class="btn-ghost" type="button" :disabled="busy" @click="modalClose">取消</button>
          <button class="btn-primary" type="button" :disabled="!canSubmit" @click="confirm">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
/* 遮罩 / 弹窗框 / 标题行 / 关闭按钮 / 操作条取 main.css 公共类，此处只补表单布局 */
label { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-13); }
label > span { display: flex; align-items: baseline; gap: 6px; color: var(--c-text); font-weight: 500; }
.fields { display: flex; flex-direction: column; gap: 14px; }
/* 窄弹窗（.modal 内容宽 ~392px）里两列各约 190px：列宽必须写 minmax(0,1fr)，
   裸 1fr 的下限是 auto，输入框的固有宽度会把列撑出容器。 */
.row2-wrap { display: flex; flex-direction: column; gap: 6px; }
.row2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
input, select {
  width: 100%; padding: 9px 11px; font-size: var(--fs-13); color: var(--c-text);
  background-color: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-xs);
  transition: border-color .14s ease, box-shadow .14s ease;
  font-family: inherit;
}
input:focus-visible, select:focus-visible {
  outline: none; border-color: var(--c-primary); box-shadow: 0 0 0 3px var(--c-primary-soft);
}
input.bad { border-color: var(--c-danger); }
.hint { margin: 0; font-size: var(--fs-12); color: var(--c-text-dim); }
.err-tip { color: var(--c-danger); }
/* .hint-note 是 flex：图标独立居左，整段文字必须自成**一个** span item */
.hint-note { margin: 0; }
.modal-lead code { background: var(--c-hover); padding: 1px 5px; border-radius: 4px; }
.target { margin: -4px 0 10px; font-size: var(--fs-13); }
.target code, .target .mono { font-family: var(--font-mono); }
.cur-line { margin: 0 0 12px; font-size: var(--fs-12); color: var(--c-text-dim); }
.cur-line .mono { font-family: var(--font-mono); color: var(--c-text); }
.dim { color: var(--c-text-dim); }
.loading-line { margin: 0 0 12px; }
</style>
