<script setup lang="ts">
/**
 * 「保存手动维护的站点」二选一弹窗。
 *
 * 从 SiteFormDialog 搬出来的边界：**只呈现一个已被算好的抉择**——文案由宿主的
 * `saveAskLead` 计算（它要知道表单规格基线、站点快照与实时 manual/stale 三份状态），
 * 这里只负责把三种行为（取消 / 仅保存 / 按表单重新生成）原样转达。
 *
 * 为什么这一步不能省：手动维护站点 `apply` 不会自动更新磁盘配置（后端整段跳过渲染与
 * 下发）。不弹这一步 = 表单值静默入库而磁盘配置不动 → 面板与 nginx 分叉（as11 真实
 * 踩过，017 迁移为它而立）。
 */
import { ref } from 'vue'
import { useModal } from '@/composables/useModal'
import Icon from '@/components/Icon.vue'

const props = defineProps<{
  open: boolean
  /** 说明文案（含「为什么弹」与「三个选项各自的代价」），由宿主拼装 */
  lead: string
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  /** true = 按表单重新生成（覆盖磁盘配置，覆盖前自动备份）；false = 仅保存 */
  choose: [boolean]
}>()

const box = ref<HTMLElement | null>(null)
const { close } = useModal(() => props.open, box, () => { emit('update:open', false) })

function pick(regenerate: boolean) {
  emit('update:open', false)
  emit('choose', regenerate)
}
</script>

<template>
  <!-- 保存二选一：手动维护站点 + 表单改了影响配置的字段（或已未同步）。
       不弹这步 = 表单值静默入库而磁盘配置不动 → 面板与 nginx 分叉。
       level-2：叠加在编辑弹窗之上（与目录选择器同级抬层）。 -->
  <div v-if="open" class="mask level-2" @click.self="close">
    <div ref="box" class="modal stack" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 class="modal-title">保存手动维护的站点</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="close">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p class="modal-lead">{{ lead }}</p>
      <div class="modal-actions">
        <button class="btn-ghost" @click="close">取消</button>
        <button class="btn-ghost" title="只把表单值入库；磁盘配置保持不变（随后会标记「未同步」）"
          @click="pick(false)">仅保存（不覆盖配置）</button>
        <button class="btn-primary" title="按当前表单覆盖磁盘配置：先自动备份原配置，再重新渲染并重载"
          @click="pick(true)">按表单重新生成</button>
      </div>
    </div>
  </div>
</template>
