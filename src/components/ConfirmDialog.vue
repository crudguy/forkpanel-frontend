<script setup lang="ts">
/**
 * 危险操作确认框。
 *
 * 刻意的设计：需要用户**输入确认词**才能提交（用于删站、封端口、恢复数据这类
 * 不可逆操作）。单纯点"确定"挡不住误触——人在批量清理时手速远快于思考。
 */
import { ref, computed } from 'vue'

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
</script>

<template>
  <div v-if="open" class="mask" @click.self="cancel">
    <div class="box" role="dialog" aria-modal="true">
      <h3 :class="{ danger }">{{ title }}</h3>
      <p v-if="detail" class="detail">{{ detail }}</p>

      <label v-if="confirmWord">
        <span>请输入 <code>{{ confirmWord }}</code> 以确认</span>
        <input v-model="typed" :placeholder="confirmWord" />
      </label>

      <div class="acts">
        <button @click="cancel">取消</button>
        <button :class="{ primary: danger }" :disabled="!ok" @click="confirm">
          {{ danger ? '确认执行' : '确定' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: grid; place-items: center; z-index: 50; }
.box { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius);
       padding: 20px; width: min(420px, 92vw); display: flex; flex-direction: column; gap: 12px; }
h3 { margin: 0; font-size: 16px; }
h3.danger { color: var(--c-danger); }
.detail { margin: 0; font-size: 13px; color: var(--c-text-dim); line-height: 1.6; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
code { background: var(--c-hover); padding: 1px 5px; border-radius: 4px; }
.acts { display: flex; justify-content: flex-end; gap: 8px; }
.primary { background: var(--c-danger); color: #fff; border-color: var(--c-danger); }
</style>
