<script setup lang="ts">
/**
 * 危险操作确认框。
 *
 * 刻意的设计：需要用户**输入确认词**才能提交（用于删站、封端口、恢复数据这类
 * 不可逆操作）。单纯点"确定"挡不住误触——人在批量清理时手速远快于思考。
 */
import { ref, computed } from 'vue'
import { useModal } from '@/composables/useModal'
import Icon from '@/components/Icon.vue'

const props = defineProps<{
  open: boolean
  title: string
  detail?: string
  /** 要求输入该词才能确认；留空则只需点击 */
  confirmWord?: string
  danger?: boolean
}>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const typed = ref('')
const ok = computed(() =>
  props.confirmWord ? typed.value.trim() === props.confirmWord : true
)

function confirm() {
  if (!ok.value) return
  emit('confirm')
  typed.value = ''
}
function cancel() { typed.value = ''; emit('cancel') }

// Esc 关闭 + Tab 焦点陷阱 + 打开时聚焦（审计 U1）：本组件被全项目危险操作复用，
// 一处接入全部确认框受益。返回值 `close` 是**统一关闭出口**（带离场动画 + 焦点返还），
// X 按钮 / 点遮罩 / 取消按钮三条路径都必须走它。
const box = ref<HTMLElement | null>(null)
const { close } = useModal(() => props.open, box, cancel)
</script>

<template>
  <div v-if="open" class="mask" @click.self="close">
    <div ref="box" class="modal stack" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 class="modal-title" :class="{ danger }">{{ title }}</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="close">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p v-if="detail" class="modal-lead">{{ detail }}</p>

      <label v-if="confirmWord">
        <span>请输入 <code>{{ confirmWord }}</code> 以确认</span>
        <input v-model="typed" :placeholder="confirmWord" />
      </label>

      <div class="modal-actions">
        <button class="btn-ghost" @click="close">取消</button>
        <!-- 危险操作一律实心红 .btn-danger（此前这里手写 .primary 复刻红色，
             与 Certs 的 btn-primary danger、Databases 的 .danger-btn 三足鼎立） -->
        <button :class="danger ? 'btn-danger' : 'btn-primary'" :disabled="!ok" @click="confirm">
          {{ danger ? '确认执行' : '确定' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩 / 弹窗框 / 标题 / 关闭按钮 / 操作条统一取 main.css 公共类，
   此处只留本组件独有的「确认词输入框」排布。 */
label { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-13); }
code { background: var(--c-hover); padding: 1px 5px; border-radius: 4px; }
</style>
