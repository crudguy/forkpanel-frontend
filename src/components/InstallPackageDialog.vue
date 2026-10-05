<script setup lang="ts">
/**
 * 安装软件对话框：先选版本，再确认安装。
 *
 * 为什么不再用行内输入框 / 右上角「指定版本」总开关：
 * ① 让用户手输版本号极易出错——Debian 版本号形如 `1.26.3-3+deb13u9`（含 epoch 与
 *    修订号），凭记忆写几乎必错，错了只能等 apt 报错；
 * ② 总开关放在区块右上角容易被看漏，用户直接点「+ 安装」就装了最新版，
 *    等于版本能力形同虚设。
 * 现在改成「点安装 → 弹窗选版本 → 确认」，选择入口就在操作路径上，不会漏。
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
  loading?: boolean     // 正在查询版本列表
  external?: boolean    // 官方仓库通常不含，需先配第三方源
}>()
const emit = defineEmits<{
  (e: 'confirm', version: string | undefined): void   // undefined = 装最新版
  (e: 'cancel'): void
}>()

// '' 代表「最新版本」：不向后端传 version，让 apt 自己选候选版本
const picked = ref('')

// 每次打开都重置为最新版——否则上次选的版本会残留，用户以为这次也是最新版
watch(() => props.open, (v) => { if (v) picked.value = '' })

function confirm() { emit('confirm', picked.value || undefined) }
function cancel() { emit('cancel') }

// Esc 关闭 + Tab 焦点陷阱 + 打开时聚焦（与 ConfirmDialog 同一套可访问性基线）
const box = ref<HTMLElement | null>(null)
useModal(() => props.open, box, cancel)
</script>

<template>
  <div v-if="open" class="mask" @click.self="cancel">
    <div ref="box" class="box" role="dialog" aria-modal="true">
      <h3>安装 {{ label || name }}</h3>
      <p class="detail">选择要安装的版本。默认「最新版本」，即软件源当前的候选版本。</p>

      <label>
        <span>版本</span>
        <select v-model="picked" :disabled="loading">
          <option value="">最新版本（软件源默认）</option>
          <option v-for="v in versions" :key="v" :value="v">{{ v }}</option>
        </select>
      </label>

      <p v-if="loading" class="hint">正在查询可用版本…</p>
      <p v-else-if="!versions.length" class="hint">
        未查到可用版本列表，将按软件源最新版安装。
      </p>
      <p v-if="external" class="warn">
        该软件官方仓库通常不含，需先在目标机配置第三方软件源，否则安装会失败。
      </p>

      <div class="acts">
        <button @click="cancel">取消</button>
        <button class="primary" :disabled="loading" @click="confirm">安装</button>
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
/* 版本号可能很长（如 5:8.0.2-3+deb13u3），select 宽度固定 + 文本溢出省略，
   避免长版本把弹窗撑宽。 */
select { width: 100%; padding: 7px 9px; font-size: 13px; color: var(--c-text);
  background: var(--c-glass); border: 1px solid var(--c-border);
  border-radius: var(--radius-sm); text-overflow: ellipsis; }
select:disabled { opacity: .55; cursor: not-allowed; }
.hint { margin: 0; font-size: 12.5px; color: var(--c-text-dim); }
.warn { margin: 0; font-size: 12.5px; color: var(--c-text-dim);
  padding: 7px 10px; border-left: 3px solid var(--gradient); background: var(--c-hover);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0; line-height: 1.6; }
.acts { display: flex; justify-content: flex-end; gap: 8px; }
.primary { background: var(--gradient); color: #fff; border: none; }
.primary:disabled { opacity: .55; cursor: not-allowed; }
</style>
