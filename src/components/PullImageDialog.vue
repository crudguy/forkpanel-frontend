<script setup lang="ts">
/**
 * 拉取 / 更新镜像对话框：包装后端 `POST /api/v1/containers/images/pull`（等价 `docker pull`）。
 *
 * 安全边界（与后端一致）：
 * ① 镜像引用须安全（无空白 / shell 元字符），后端 `image_is_safe()` 二次校验，
 *    前端只给格式提示，不把白名单当安全边界（前端校验不可作数）。
 * ② 拉取是**网络下载 + 写盘**（不是代码执行），风险低于「创建容器」，故不放特权开关，
 *    也不需要「创建容器」那类强确认词；但仍是写操作，仅 container.manage 可见可点。
 * ③ 镜像来源经 `/etc/docker/daemon.json` 的 registry-mirrors 或默认 Docker Hub——
 *    若宿主网络到 registry 不可达，拉取会失败，错误由后端透传、走 toast 提示。
 *
 * 复用 CreateContainerDialog / InstallPackageDialog 的弹窗骨架与 useModal 可访问性
 * （Esc 关闭 / Tab 焦点陷阱 / 打开聚焦 / 离场动画 + 焦点返还），保持全站弹窗一致。
 */
import { ref, watch } from 'vue'
import { useModal } from '@/composables/useModal'
import Icon from '@/components/Icon.vue'

const props = defineProps<{
  open: boolean
  busy?: boolean
  /** 预填镜像名（来自「常用镜像」的快捷入口）。为空则打开时清空输入。 */
  preset?: string
}>()
const emit = defineEmits<{
  (e: 'confirm', image: string): void
  (e: 'cancel'): void
}>()

const image = ref('')

const canSubmit = ref(false)
watch(
  () => [props.open, image.value],
  () => { canSubmit.value = props.open && !!image.value.trim() },
  { immediate: true },
)

// 打开时重置，避免上次输入的镜像名残留；有 preset 时用它预填
// （预设只是镜像名，不带 tag——tag 由用户在此确认，见 popularImages.ts 的说明）。
watch(() => props.open, (v) => {
  if (v) { image.value = props.preset ?? ''; canSubmit.value = !!image.value.trim() }
})

function confirm() {
  if (!canSubmit.value || props.busy) return
  emit('confirm', image.value.trim())
}
function cancel() { emit('cancel') }

const box = ref<HTMLElement | null>(null)
const { close: modalClose } = useModal(() => props.open, box, cancel)
</script>

<template>
  <div v-if="open" class="mask" @click.self="modalClose">
    <div ref="box" class="modal stack" role="dialog" aria-modal="true" aria-label="拉取镜像">
      <div class="modal-head">
        <h3 class="modal-title">拉取 / 更新镜像</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p class="modal-lead">
        等价于 <code>docker pull</code>：按 <b>仓库:标签</b> 从 registry 拉取（默认 <code>latest</code>）。
        已有同名同标签镜像会被更新为本地的另一层。拉取是网络下载 + 写盘操作，仅容器管理权限可执行。
      </p>

      <div class="fields">
        <label class="req">
          <span>镜像引用</span>
          <input v-model="image" type="text" placeholder="如 nginx:1.27-alpine 或 library/alpine:latest" autocomplete="off" @keyup.enter="confirm" />
          <p class="hint">支持 <code>repo:tag</code>、<code>repo</code>（默认 latest）、或带仓库域名的完整引用（如 <code>ccr.ccs.tencentyun.com/.../...:tag</code>）。不得含空白或 shell 元字符。</p>
        </label>
      </div>

      <div class="modal-foot">
        <div class="modal-actions">
          <button class="btn-ghost" type="button" :disabled="busy" @click="modalClose">取消</button>
          <button class="btn-primary" type="button" :disabled="!canSubmit || busy" @click="confirm">
            {{ busy ? '拉取中…' : '拉取镜像' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
label { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-13); }
label > span { display: flex; align-items: baseline; gap: 6px; color: var(--c-text); font-weight: 500; }
.req > span::after { content: ' *'; color: var(--c-danger); }
.fields { display: flex; flex-direction: column; gap: 14px; }
input {
  width: 100%; padding: 9px 11px; font-size: var(--fs-13); color: var(--c-text);
  background-color: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-xs);
  transition: border-color .14s ease, box-shadow .14s ease;
  font-family: inherit;
}
input:focus-visible { outline: none; border-color: var(--c-primary); box-shadow: 0 0 0 3px var(--c-primary-soft); }
.code, code { font-family: var(--font-mono); font-size: var(--fs-12); }
.hint { margin: 0; font-size: var(--fs-12); color: var(--c-text-dim); line-height: 1.6; }
.modal-lead code { background: var(--c-hover); padding: 1px 5px; border-radius: 4px; }
</style>
