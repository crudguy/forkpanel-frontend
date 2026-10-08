<script setup lang="ts">
/**
 * 安装软件对话框：先选版本，再确认安装。
 *
 * 为什么不再用行内输入框 / 右上角「指定版本」总开关：
 * ① 让用户手输版本号极易出错——Debian 版本号形如 `1.26.3-3+deb13u9`（含 epoch 与
 *    修订号），凭记忆写几乎必错，错了只能等 apt 报错；
 * ② 总开关放在区块右上角容易被看漏，用户直接点「+ 安装」就按源默认装上了，
 *    等于版本能力形同虚设。
 * 现在改成「点安装 → 弹窗选版本 → 确认」，选择入口就在操作路径上，不会漏。
 *
 * 默认值：下拉**默认选中可用版本里最新的一个**（`versions` 由后端按新→旧下发，
 * 首项即跨源最高版本），不再提供「最新版本」这类占位选项——用户要换版本自己选即可。
 *
 * 版本列表由父组件按需拉取（打开弹窗时才查，避免列表页为 25 个包各跑一次 apt）。
 */
import { ref, watch } from 'vue'
import { useModal } from '@/composables/useModal'

const props = defineProps<{
  open: boolean
  name: string          // 逻辑包名（提交用）
  label?: string        // 品牌名（展示用）；缺省则退回 name
  versions: string[]    // 可用版本（新→旧）；空数组=查不到
  /** 该包当前已安装的版本（未安装则为空/不传）；下拉里会标「（已安装）」 */
  installed?: string | null
  loading?: boolean     // 正在查询版本列表
  external?: boolean    // 官方仓库通常不含，需先配第三方源
}>()
const emit = defineEmits<{
  (e: 'confirm', version: string | undefined): void   // undefined = 无版本可选，交后端按源默认装
  (e: 'cancel'): void
}>()

// 默认选中最新版：`versions` 已按版本从新到旧下发（apt 的输出顺序即如此，且跨源排序），
// 首项就是"官方源/系统源里更新的那个"。列表为空（查不到 / 非 apt）时留空，
// 确认时传 undefined，交后端按软件源当前版本安装。
const picked = ref('')

// 打开时、以及版本列表异步到达时都同步默认值——列表是"弹窗先开、随后到达"的。
// 加载期间下拉是 disabled 的，故此刻覆盖 picked 不会打断用户已经开始的选择。
function syncDefaultVersion() { picked.value = props.versions[0] ?? '' }
watch(() => props.open, (v) => { if (v) syncDefaultVersion() })
watch(() => props.versions, () => { if (props.open) syncDefaultVersion() })

function confirm() { emit('confirm', picked.value || undefined) }
function cancel() { emit('cancel') }

// Esc 关闭 + Tab 焦点陷阱 + 打开时聚焦（与 ConfirmDialog 同一套可访问性基线）
const box = ref<HTMLElement | null>(null)
useModal(() => props.open, box, cancel)
</script>

<template>
  <div v-if="open" class="mask" @click.self="cancel">
    <div ref="box" class="box" role="dialog" aria-modal="true">
      <!-- 已安装的软件也能打开此弹窗（换版本），此时标题要说清是"切换"而非"安装" -->
      <h3>{{ installed ? '切换版本' : '安装' }} {{ label || name }}</h3>
      <p class="detail">
        {{ installed
          ? '选择要切换到的版本，当前版本已在下拉中标注；默认选中可用的最新版本。'
          : '选择要安装的版本，默认选中软件源里可用的最新版本。' }}
      </p>

      <label>
        <span>版本</span>
        <select v-model="picked" :disabled="loading || !versions.length">
          <!-- 列表未就绪时的占位：加载中显示"查询中"，查完仍为空才说明确实查不到。
               列表就绪后此处被 v-for 的真实版本取代，默认选中首项（最新）。 -->
          <option v-if="!versions.length" value="" disabled>{{ loading ? '正在查询…' : '（未查到可用版本）' }}</option>
          <option v-for="v in versions" :key="v" :value="v">{{ v === installed ? v + '（已安装）' : v }}</option>
        </select>
      </label>

      <p v-if="loading" class="hint">正在查询可用版本…</p>
      <p v-else-if="!versions.length" class="hint">
        未查到可用版本列表，将安装软件源当前提供的版本。
      </p>
      <p v-if="external" class="warn">
        该软件官方仓库通常不含，需先在目标机配置第三方软件源，否则安装会失败。
      </p>

      <div class="acts">
        <button @click="cancel">取消</button>
        <button class="primary" :disabled="loading" @click="confirm">{{ installed ? '切换版本' : '安装' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: grid; place-items: center; z-index: 50; }
.box { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius);
       padding: 20px; width: min(440px, 92vw); display: flex; flex-direction: column; gap: 12px; }
h3 { margin: 0; font-size: 16px; }
.detail { margin: 0; font-size: 13px; color: var(--c-text-dim); line-height: 1.6; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
/* 版本下拉：原先用 --c-border/--c-glass（弱边框弱背景），在弹窗里几乎看不出是个
   可点的控件。改对齐全站输入基线（--c-border-strong + --c-bg），并补一个明确的
   箭头指示——原生箭头在深色主题下几乎不可见。
   版本号可能很长（如 5:8.0.2-3+deb13u3），故右侧留足箭头空间 + 文本溢出省略。 */
select {
  width: 100%; padding: 9px 34px 9px 11px; font-size: 13.5px; color: var(--c-text);
  background-color: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-xs);
  appearance: none; -webkit-appearance: none; -moz-appearance: none;
  /* 中间灰箭头：深浅两套主题下都可见（data-uri 无法用 currentColor） */
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%238a8f98' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat; background-position: right 11px center;
  cursor: pointer;
  transition: border-color .14s ease, box-shadow .14s ease;
}
select:hover:not(:disabled) { border-color: var(--c-primary-2); }
select:focus-visible { outline: none; border-color: var(--c-primary);
  box-shadow: 0 0 0 3px var(--c-primary-soft); }
select:disabled { opacity: .55; cursor: not-allowed; }
.hint { margin: 0; font-size: 12.5px; color: var(--c-text-dim); }
.warn { margin: 0; font-size: 12.5px; color: var(--c-text-dim);
  padding: 7px 10px; border-left: 3px solid var(--gradient); background: var(--c-hover);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0; line-height: 1.6; }
.acts { display: flex; justify-content: flex-end; gap: 8px; }
.primary { background: var(--gradient); color: #fff; border: none; }
.primary:disabled { opacity: .55; cursor: not-allowed; }
</style>
