<script setup lang="ts">
/**
 * 软件说明弹窗：点开某个软件，直接看到它「大致是做什么用的」。
 *
 * 为什么是弹窗而不是抽屉：说明是**单个软件**的属性，用户在软件卡片这一行点进来，
 * 关掉后视线还在原处；抽屉（HelpDrawer，440px 从右侧滑出）留给整页说明，两者语义
 * 不同不要混用。
 *
 * 文案来源：**全部来自后端** `catalog`（`PackageCatalogEntry`），本组件一个字都不写死。
 * 这既是「单一事实源」纪律，也保证 22 条说明与包的集合永远同步——前端另存一份文案表
 * 会在后端加包时静默变成「点开是空的」。
 *
 * 浮层纪律（见 check-overlay-teleport.mjs）：
 *  - 必须 Teleport 到 body：祖先若带 backdrop-filter / transform 会成为 fixed 包含块，
 *    弹窗会「歪」在卡片里而不是居中于视口。
 *  - 调用方必须把它放在 template 链尾、与其它浮层同级，**不得**嵌在某个 v-if 块内部
 *    （父块不渲染时本组件整块消失，设了 open 也弹不出来，且编译/类型全绿）。
 */
import { computed } from 'vue'
import Icon from '@/components/Icon.vue'
import PkgIcon from '@/components/PkgIcon.vue'
import type { PackageCatalogEntry } from '@/api/types'

const props = defineProps<{
  open: boolean
  /** 当前软件的说明；为 null 时不渲染（保持调用方简单，不必在外面再包一层 v-if） */
  info: PackageCatalogEntry | null
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

/** 四行说明的展示顺序与标签。顺序固定：先「是什么」再「能做什么」再「什么时候用」，
 *  最后「去哪操作」——与用户的心智顺序一致。 */
const ROWS = [
  { key: 'summary', label: '用途' },
  { key: 'features', label: '主要功能' },
  { key: 'scenes', label: '适用场景' },
  { key: 'entry', label: '使用方式' },
] as const

const rows = computed(() => {
  const i = props.info
  if (!i) return []
  return ROWS.map(r => ({ label: r.label, text: (i[r.key] ?? '').trim() }))
    .filter(r => r.text)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open && info" class="mask" @click.self="emit('close')"
         @keydown.esc.window="emit('close')">
      <div class="dlg" role="dialog" aria-modal="true"
           :aria-label="`${info.label} 说明`">
        <div class="dlg-head">
          <PkgIcon :name="info.name" :label="info.label" :size="22" />
          <div class="hd-txt">
            <div class="hd-name">{{ info.label }}</div>
            <div class="hd-pkg mono">{{ info.name }}</div>
          </div>
          <span v-if="info.external" class="badge badge-warn nowrap"
                title="官方仓库通常不含此包，需先在目标机配置第三方软件源，否则安装会失败">需配源</span>
          <span class="spacer" />
          <button class="hd-x" type="button" aria-label="关闭" @click="emit('close')">
            <Icon name="close" :size="16" />
          </button>
        </div>

        <div class="dlg-body">
          <dl class="help-list">
            <template v-for="r in rows" :key="r.label">
              <dt>{{ r.label }}</dt>
              <dd>{{ r.text }}</dd>
            </template>
          </dl>
          <p class="foot dim">
            文中端口均为软件默认值，实际以你的配置为准。安装 / 升级 / 卸载在「软件」页完成，
            启停与日志在「服务」页。
          </p>
        </div>

        <div class="dlg-foot">
          <button class="btn-ghost" type="button" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(0, 0, 0, .45);
  display: grid; place-items: center;
  padding: 16px;
}
.dlg {
  width: min(560px, 94vw);
  max-height: min(84vh, 640px);
  background: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column;
  animation: pop .16s ease;
}
@keyframes pop { from { transform: translateY(6px); opacity: .6 } to { transform: none; opacity: 1 } }

.dlg-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px; border-bottom: 1px solid var(--c-border);
}
.hd-txt { min-width: 0; }
.hd-name { font-weight: 600; font-size: var(--fs-15); }
.hd-pkg { font-size: var(--fs-12); color: var(--c-text-dim); }
.spacer { flex: 1; }
.nowrap { white-space: nowrap; flex: none; }
.hd-x {
  width: 32px; height: 32px; border: none; background: transparent;
  color: var(--c-text-dim); border-radius: 8px; cursor: pointer;
  display: grid; place-items: center; flex: none;
}
.hd-x:hover { background: var(--c-hover); color: var(--c-text); }

.dlg-body { padding: 14px 16px; overflow-y: auto; }
.help-list { margin: 0; }
.help-list dt {
  font-size: var(--fs-12); color: var(--c-text-dim);
  margin: 0 0 3px;
}
.help-list dt:not(:first-child) { margin-top: 12px; }
.help-list dd {
  margin: 0; font-size: var(--fs-13-5); line-height: 1.65; color: var(--c-text);
}
.foot {
  margin: 16px 0 0; padding-top: 10px;
  border-top: 1px solid var(--c-border);
  font-size: var(--fs-12); line-height: 1.6;
}

.dlg-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--c-border);
}
.mono { font-family: var(--mono); }
.dim { color: var(--c-text-dim); }
</style>
