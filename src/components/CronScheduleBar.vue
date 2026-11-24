<script setup lang="ts">
/**
 * 计划任务「执行频率」快捷设置栏。
 *
 * 对外仍只是一个标准 cron 字符串（v-model），后端契约零改动；
 * 对内把每 N 分钟 / 每小时 / 每天 / 每周 / 每月收敛成看得懂的控件。
 * 手写的复杂表达式由 describeCron 原样回显，不改写、不吞掉。
 */
import { ref, watch } from 'vue'
import {
  parseCronSchedule, cronScheduleToCron, describeCron, type CronScheduleView, type CronMode,
} from '@/composables/cronSchedule'

const props = defineProps<{
  modelValue: string
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const view = ref<CronScheduleView>(parseCronSchedule(props.modelValue))

// 空表达式时主动落入默认频率：快捷栏已经显示「每天 03:00」，表单里却没有值
// 会让创建按钮一直禁用。预填一次即可，后续改动仍由用户决定。
if (!(props.modelValue ?? '').trim()) {
  emit('update:modelValue', cronScheduleToCron(view.value))
}

/**
 * 外部改值（模板填充、打开别的任务、创建后重置）时重新解析。
 * 判据是「新值与当前可视化状态生成的表达式不同」，避免自己 emit 后的回声
 * 把用户正在编辑的中间态（如 time 输入到一半）冲掉。
 */
watch(() => props.modelValue, (v) => {
  if ((v ?? '').trim() !== cronScheduleToCron(view.value).trim()) {
    view.value = parseCronSchedule(v ?? '')
  }
})

function push() { emit('update:modelValue', cronScheduleToCron(view.value)) }
function setMode(v: string) { view.value = { ...view.value, mode: v as CronMode }; push() }
function setEvery(e: Event) { view.value = { ...view.value, every: Number((e.target as HTMLInputElement).value) }; push() }
function setTime(e: Event) { view.value = { ...view.value, time: (e.target as HTMLInputElement).value }; push() }
function setWeekday(v: string) { view.value = { ...view.value, weekday: v }; push() }
function setMonthday(v: string) { view.value = { ...view.value, monthday: v }; push() }
/**
 * 直接发出用户敲入的原值：走 cronScheduleToCron 会把中间态 trim 掉，
 * 输入到一半的空格会被吞。watch 的比较口径与该值一致，不会引发回声重置。
 */
function setCustom(e: Event) {
  const v = (e.target as HTMLInputElement).value
  view.value = { ...view.value, mode: 'custom', custom: v }
  emit('update:modelValue', v)
}

const timed = () => view.value.mode === 'daily' || view.value.mode === 'weekly' || view.value.mode === 'monthly'
</script>

<template>
  <div class="cron-sched">
    <label>快捷设置
      <select :value="view.mode" :disabled="disabled" aria-label="快捷设置执行频率"
        @change="setMode(($event.target as HTMLSelectElement).value)">
        <option value="every">每 N 分钟</option>
        <option value="hourly">每小时</option>
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
        <option value="custom">自定义</option>
      </select>
    </label>

    <label v-show="view.mode === 'custom'">表达式
      <input class="cron-expr-input" :value="view.custom || modelValue" :disabled="disabled"
        aria-label="表达式" placeholder="0 3 * * *" @input="setCustom" />
    </label>

    <label v-if="view.mode === 'every'">间隔(分钟)
      <input type="number" min="1" max="59" :value="view.every" :disabled="disabled" aria-label="间隔分钟数"
        @input="setEvery" />
    </label>

    <label v-if="timed()">时间
      <input type="time" :value="view.time" :disabled="disabled" aria-label="执行时间" @input="setTime" />
    </label>

    <label v-if="view.mode === 'weekly'">星期
      <select :value="view.weekday" :disabled="disabled" aria-label="执行星期"
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

    <label v-if="view.mode === 'monthly'">日期
      <select :value="view.monthday" :disabled="disabled" aria-label="执行日期"
        @change="setMonthday(($event.target as HTMLSelectElement).value)">
        <option v-for="d in 31" :key="d" :value="String(d)">{{ d }} 日</option>
      </select>
    </label>

    <span class="cron-sched-desc">{{ describeCron(modelValue) }}</span>
  </div>
</template>

<style scoped>
.cron-sched { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.cron-sched label { display: flex; flex-direction: row; align-items: center; gap: 6px;
  font-size: var(--fs-12); color: var(--c-text-dim); }
.cron-sched select, .cron-sched input { height: 34px; }
.cron-sched select { width: auto; min-width: 118px; }
.cron-sched input[type='number'] { width: 88px; }
.cron-sched .cron-expr-input { width: 240px; }
/* 原生时间控件在深色主题下需显式声明配色，否则弹出的时间面板是白底黑字。 */
.cron-sched input[type='time'] { width: 120px; color-scheme: dark; }
.cron-sched-desc { align-self: center; font-size: var(--fs-12); color: var(--c-text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
