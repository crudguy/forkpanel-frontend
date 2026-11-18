<script setup lang="ts">
/**
 * 全局命令面板（Ctrl/⌘ + K）。
 *
 * 候选来自路由表（见 commandPalette.ts），不在本组件里维护第二份清单——
 * 手抄清单必然漂移，面板里出现点不开的假入口比没有面板更伤信任。
 * 可达性统一走 navPolicy.whyDisabledForPath，与侧栏/路由守卫同一判据，
 * 能力不足的页面照常列出但置灰并写明原因（诚实降级，不做假入口）。
 *
 * ⚠ 组件常驻在 MainLayout 根层（不在任何 v-if 内），浮层本身 Teleport 到 body：
 * 一来 backdrop-filter 会造 fixed 包含块，二来缩进层级一挪进 v-if 就会静默不渲染
 * （历史事故：tsc/build/单测全绿但真机一个 .mask 都不出现）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { whyDisabledForPath } from '@/composables/navPolicy'
import { buildCommands, filterCommands, type RouteLike } from '@/composables/commandPalette'
import Icon from '@/components/Icon.vue'

const props = defineProps<{ routes?: RouteLike[] }>()
const emit = defineEmits<{ close: [] }>()

const open = ref(false)
const query = ref('')
const active = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const router = useRouter()
const auth = useAuthStore()

const results = computed(() =>
  filterCommands(buildCommands(props.routes ?? []), query.value).map((it) => ({
    ...it,
    disabled: whyDisabledForPath(auth, it.path),
  })),
)

watch(open, async (v) => {
  if (!v) return
  query.value = ''
  active.value = 0
  await nextTick()
  inputEl.value?.focus()
})

// 全局只绑开关键与 Esc；方向键/回车交给 input 自己的 @keydown，避免双触发。
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    open.value = !open.value
    return
  }
  if (open.value && e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function close() {
  open.value = false
  emit('close')
}

function go(it?: (typeof results.value)[number]) {
  if (!it || it.disabled) return
  void router.push(it.path)
  close()
}

function onInput() {
  active.value = 0
}

/** 输入框按键统一在此判断：不依赖框架按键修饰符的键名规范化，测试与真机一致。 */
function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    active.value = Math.min(active.value + 1, results.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = Math.max(active.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    go(results.value[active.value])
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cp-mask" @click.self="close">
      <div class="cp-panel" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div class="cp-search">
          <Icon name="search" :size="16" />
          <input
            ref="inputEl"
            v-model="query"
            class="cp-input"
            type="text"
            placeholder="搜索页面…（Ctrl/⌘ + K 打开，Esc 关闭）"
            @input="onInput"
            @keydown="onInputKeydown"
          />
        </div>
        <div class="cp-list">
          <button
            v-for="(it, i) in results"
            :key="it.path"
            type="button"
            class="cp-item"
            :class="{ 'is-active': i === active, 'is-disabled': !!it.disabled }"
            :disabled="!!it.disabled"
            :title="it.disabled ?? `跳转到 ${it.path}`"
            @click="go(it)"
            @mouseenter="active = i"
          >
            <span class="cp-title">{{ it.title }}</span>
            <code class="cp-path">{{ it.path }}</code>
            <span v-if="it.disabled" class="cp-why">{{ it.disabled }}</span>
          </button>
          <p v-if="!results.length" class="cp-empty">没有匹配的页面</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cp-mask {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh; background: var(--c-scrim);
}
.cp-panel {
  z-index: 80; width: min(560px, 92vw);
  background: var(--c-surface); border: 1px solid var(--c-border-strong);
  border-radius: var(--radius); box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.cp-search {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--c-border);
  color: var(--c-text-dim);
}
.cp-input {
  flex: 1; min-width: 0; border: 0; outline: 0;
  background: transparent; color: var(--c-text); font-size: var(--fs-14);
}
.cp-input::placeholder { color: var(--c-text-mute); }
.cp-list { max-height: 50vh; overflow: auto; padding: 6px; }
.cp-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 10px; border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--c-text); text-align: left; cursor: pointer;
}
.cp-item.is-active { background: var(--c-primary-soft); }
.cp-item.is-disabled { opacity: .45; cursor: not-allowed; }
.cp-title { font-size: var(--fs-13); }
.cp-path { margin-left: auto; font-family: var(--mono); font-size: var(--fs-12); color: var(--c-text-dim); }
.cp-why { font-size: var(--fs-12); color: var(--c-warn); }
.cp-empty { padding: 18px; text-align: center; color: var(--c-text-dim); font-size: var(--fs-13); }
</style>
