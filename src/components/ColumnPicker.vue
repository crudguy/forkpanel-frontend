<script setup lang="ts">
/**
 * 表格列显隐选择器（评估报告 A3「列显隐（本地持久化）」）。
 *
 * 为什么是独立组件：列选择器会出现在多张表（站点表先接，后续审计/证书等表同样
 * 有 10 列拥挤的问题）。各视图各抄一份勾选列表必然漂移——一处改了交互、另一处
 * 还是老样子。这里把「触发按钮 + 弹层 + 勾选 + 恢复默认」收成一处。
 *
 * 取舍：只报「要显示哪几列」这件事，不持有状态——持久化由 `useTableCols` 负责，
 * 本组件只 emit。否则每张表都会长出第二份偏好来源。
 */
import { ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { useModal } from '@/composables/useModal'

// 注：`<script setup>` 不允许具名导出，故此处不导出——调用方用数组字面量即可，
// 形状不符会由 defineProps 的运行时/类型校验兜住。
interface PickerCol {
  id: string
  label: string
  /** 不可隐藏的列（如全选复选框、操作列）——隐藏它们会让表格没法用 */
  locked?: boolean
}

const props = defineProps<{
  cols: PickerCol[]
  /** 当前被隐藏的列 id */
  hidden: string[]
  /** 表标题（用于无障碍标签） */
  label: string
}>()

const emit = defineEmits<{ toggle: [id: string]; reset: [] }>()

const open = ref(false)
const box = ref<HTMLElement | null>(null)
const { close } = useModal(() => open.value, box, () => (open.value = false))

const shownCount = () => props.cols.filter((c) => c.locked || !props.hidden.includes(c.id)).length
</script>

<template>
  <div class="col-pick">
    <button class="btn-ghost btn-sm" type="button" :aria-expanded="open"
      :title="`选择显示的列（当前 ${shownCount()} / ${cols.length} 列）`" @click="open = !open">
      <Icon name="list" :size="13" /> 列
    </button>

    <!-- ⭐ 必须 Teleport 到 body：本组件挂在 .page-head 里，而 page-head 有
         `backdrop-filter: blur(14px)` —— **backdrop-filter 会让该元素成为
         position:fixed 的包含块**，`.mask{position:fixed;inset:0}` 于是按 page-head
         的盒子解算（实测遮罩只有 1160×64），弹窗被居中到这个 64px 高的盒子里 →
         顶部全是负坐标，标题、说明、大半个列表全在视口外（截图看着像"弹窗没背景"）。
         移到 body 下就与页面结构无关，以后 page-head 再加 filter/transform 也不会复现。 -->
    <Teleport to="body">
      <div v-if="open" class="mask" @click.self="close">
        <div ref="box" class="modal" role="dialog" aria-modal="true" :aria-label="`${label}：选择显示的列`">
          <div class="modal-head">
            <h3 class="modal-title">{{ label }} · 显示的列</h3>
            <button class="modal-close" type="button" aria-label="关闭" @click="close">
              <Icon name="close" :size="16" />
            </button>
          </div>
          <p class="hint-note">
            勾选控制列是否显示；不常看的列收起来后，可在行末展开图标里看到<b>完整不截断</b>的取值。
            选择会记在本机，下次打开仍然有效。
          </p>
          <div class="cp-list">
            <label v-for="c in cols" :key="c.id" class="cp-row" :class="{ locked: c.locked }">
              <input type="checkbox" :checked="c.locked || !hidden.includes(c.id)" :disabled="c.locked"
                @change="emit('toggle', c.id)" />
              <span>{{ c.label }}</span>
              <span v-if="c.locked" class="cp-why">必需</span>
            </label>
          </div>
          <div class="modal-actions">
            <button class="btn-ghost" @click="emit('reset')">恢复默认</button>
            <button class="btn-ghost" @click="close">完成</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.col-pick { display: inline-flex; }
.cp-list { display: flex; flex-direction: column; gap: 2px; margin: 4px 0 2px; }
.cp-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 9px; cursor: pointer; font-size: 13.5px;
}
.cp-row:hover { background: var(--c-hover); }
.cp-row.locked { cursor: default; opacity: .75; }
/* 全局 input{width:100%} 会把勾选框拉满整行，必须复位 */
.cp-row input { width: auto; }
.cp-why { margin-left: auto; font-size: 11.5px; color: var(--c-text-mute); }
</style>
