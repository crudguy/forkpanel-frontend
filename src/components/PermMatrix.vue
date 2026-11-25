<script setup lang="ts">
/**
 * 权限勾选矩阵。
 *
 * 用户弹窗（新建/编辑用户）与设置页（新建/编辑自定义角色）共用同一份渲染：
 * 两处各写一份，就会出现「一处能勾、另一处勾不到」的权限集合，而权限名是纯
 * 字符串，TS 与后端都不会报错。选项**只来自后端** `/roles` 的
 * `known_permissions`（经权限点注册表下发），前端绝不自行发明名字。
 *
 * 交互约定：
 * - 受控组件：勾选结果通过 `update:modelValue` 回传，父级持有真正的数组。
 * - `readonlyPerms` 里的权限渲染为**锁定勾选**（内置角色/自定义角色的既定权限）：
 *   它们是勾选结果的一部分，但不允许就地取消——否则用户以为「少给了一项」，
 *   提交后后端会把该权限摘掉。
 * - 超出 `granted`（当前登录者自身权限）的项**禁用**：后端 `check_permissions`
 *   本来就会 400，这里提前置灰是省掉一次注定失败的请求，判据与后端同一口径。
 */
import { computed } from 'vue'

const props = defineProps<{
  /** 当前选中：所有 `checked` 的权限名 */
  modelValue: string[]
  /** 全量可选权限（后端 known_permissions） */
  all: string[]
  /** 锁定项：恒为选中且不可取消 */
  locked?: string[]
  /** 可选上限：当前登录者自身权限，不在其中的项禁用 */
  granted?: string[]
  /** 为空时的提示（权限清单还没加载到） */
  emptyHint?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const lockedSet = computed(() => new Set(props.locked ?? []))
const grantedSet = computed(() => (props.granted ? new Set(props.granted) : null))
const chosen = computed(() => new Set(props.modelValue))

function isLocked(p: string): boolean { return lockedSet.value.has(p) }
function isGranted(p: string): boolean {
  return grantedSet.value === null || grantedSet.value.has(p)
}
function isChecked(p: string): boolean {
  return isLocked(p) || chosen.value.has(p)
}

function toggle(p: string, e: Event) {
  if (isLocked(p) || !isGranted(p)) return
  const target = e.target as HTMLInputElement | null
  const next = new Set(chosen.value)
  // 以组件状态为准，不读 DOM 的 checked：真机点 label 时事件顺序与 v-model
  // 无关，读 DOM 会在快速连点时把状态带偏。
  if (next.has(p)) next.delete(p); else next.add(p)
  if (target) target.checked = next.has(p)
  emit('update:modelValue', props.all.filter(x => next.has(x)))
}
</script>

<template>
  <div v-if="all.length" class="perm-grid">
    <label
      v-for="p in all" :key="p"
      class="perm-chk"
      :class="{ locked: isLocked(p), denied: !isGranted(p) }"
      :title="isLocked(p) ? '该角色已包含此权限' : (!isGranted(p) ? '你自身没有该权限，不能授予' : p)"
    >
      <input
        type="checkbox"
        :value="p"
        :checked="isChecked(p)"
        :disabled="isLocked(p) || !isGranted(p)"
        @change="toggle(p, $event)"
      />
      <code>{{ p }}</code>
    </label>
  </div>
  <p v-else class="perm-empty">{{ emptyHint || '权限清单加载中…' }}</p>
</template>

<style scoped>
.perm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 4px 10px;
}
.perm-chk {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 4px; border-radius: var(--radius-xs); cursor: pointer;
  font-size: var(--fs-12-5); min-width: 0;
}
.perm-chk:hover { background: var(--c-hover); }
.perm-chk code {
  font-family: var(--mono); color: var(--c-text-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.perm-chk input { flex: none; margin: 0; }
.perm-chk.locked { cursor: default; }
.perm-chk.locked code { color: var(--c-text); }
.perm-chk.denied { cursor: not-allowed; opacity: .45; }
.perm-empty { color: var(--c-text-mute); font-size: var(--fs-12-5); margin: 4px 0; }
</style>
