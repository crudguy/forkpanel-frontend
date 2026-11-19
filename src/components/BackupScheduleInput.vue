<script setup lang="ts">
/**
 * 备份计划「自动备份时间」输入控件。
 *
 * 对外仍然只是一个 cron_expr 字符串（v-model），后端契约零改动；
 * 对内把常用周期拆成看得懂的选项，复杂的既有表达式原样收进「自定义」。
 * 与 RemoteTargetForm 同一套 inline 约定：传 inline 时根盒子 display:contents，
 * 内部 label 直接成为宿主 .row 的 flex item，不独占一行。
 */
import { ref, watch } from 'vue'
import {
  parseSchedule, scheduleToCron, type ScheduleMode, type ScheduleView,
} from '@/composables/backupSchedule'

const props = defineProps<{
  modelValue: string
  disabled?: boolean
  inline?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const sched = ref<ScheduleView>(parseSchedule(props.modelValue))

/**
 * 外部改值（打开别的计划 / 创建后重置）时重新解析。
 * 判据是「新值与当前可视化状态生成的表达式不同」，避免自己 emit 后的回声
 * 把用户正在编辑的中间态（如 time 输入到一半）冲掉。
 */
watch(() => props.modelValue, (v) => {
  if ((v ?? '').trim() !== scheduleToCron(sched.value).trim()) {
    sched.value = parseSchedule(v ?? '')
  }
})

function push() { emit('update:modelValue', scheduleToCron(sched.value)) }
function setMode(v: string) { sched.value = { ...sched.value, mode: v as ScheduleMode }; push() }
function setTime(v: string) { sched.value = { ...sched.value, time: v }; push() }
function setWeekday(v: string) { sched.value = { ...sched.value, weekday: v }; push() }
function setMonthday(v: string) { sched.value = { ...sched.value, monthday: v }; push() }
function setCustom(v: string) { sched.value = { ...sched.value, custom: v }; push() }

const timed = () => sched.value.mode === 'daily' || sched.value.mode === 'weekly' || sched.value.mode === 'monthly'
</script>

<template>
  <div class="sched" :class="{ inline }">
    <label>自动备份
      <select :value="sched.mode" :disabled="disabled" @change="setMode(($event.target as HTMLSelectElement).value)">
        <option value="manual">仅手动（不自动）</option>
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
        <option value="custom">自定义（高级）</option>
      </select>
    </label>

    <label v-if="timed()">执行时间
      <input type="time" :value="sched.time" :disabled="disabled"
        @input="setTime(($event.target as HTMLInputElement).value)" />
    </label>

    <label v-if="sched.mode === 'weekly'">星期
      <select :value="sched.weekday" :disabled="disabled"
        @change="setWeekday(($event.target as HTMLSelectElement).value)">
        <option value="1">周一</option>
        <option value="2">周二</option>
        <option value="3">周三</option>
        <option value="4">周四</option>
        <option value="5">周五</option>
        <option value="6">周六</option>
        <option value="0">周日</option>
      </select>
    </label>

    <label v-if="sched.mode === 'monthly'">日期
      <select :value="sched.monthday" :disabled="disabled"
        @change="setMonthday(($event.target as HTMLSelectElement).value)">
        <option v-for="d in 31" :key="d" :value="String(d)">{{ d }} 日</option>
      </select>
    </label>

    <label v-if="sched.mode === 'custom'" title="按平台本地时间执行。五段依次为：分钟 小时 日 月 星期。">
      执行规则
      <input :value="sched.custom" :disabled="disabled" placeholder="0 3 * * *"
        @input="setCustom(($event.target as HTMLInputElement).value)" />
    </label>
  </div>
</template>

<style scoped>
/* 与 BackupsView 的 .row / RemoteTargetForm 同一套排布：label 纵向、自动换行。 */
.sched { display: flex; flex-wrap: wrap; gap: 10px 14px; }
.sched label { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-12); color: var(--c-text-dim); }
/* 字号与宿主 .row > label 保持一致（12px）：13px 会让 select 的 line-height:normal
   比同行 input 高出一截，看起来像没对齐。高度由 main.css 的 .row 规则统一兜底。 */
/* 原生时间控件在深色主题下需显式声明配色，否则弹出的时间面板是白底黑字。 */
.sched input[type='time'] { color-scheme: dark; }
/* 并入宿主 .row：根盒子不生成，内部 label 直接成为 flex item。
   ⚠ display:contents 只是渲染层合并，DOM 上级数没变 ⇒ 全局 `.row > label` 的
   flex:1 / min-width 命中不到这里，必须自己补齐，否则同行控件宽窄不一。 */
.sched.inline { display: contents; }
/* flex 基值须与全局 `.row > label`（flex:1 = 1 1 0%）完全一致，只写 140px basis
   会让内联字段比同行普通字段宽一截（实测 148 vs 140px）。min-width 兜窄屏。 */
.sched.inline label { flex: 1; min-width: 140px; }
</style>
