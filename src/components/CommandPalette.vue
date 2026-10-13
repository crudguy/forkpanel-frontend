<script setup lang="ts">
/**
 * 命令面板（评估报告 A11：服务器面板高频操作场景投入产出比最高的一项）。
 *
 * 设计：
 * - 单一事实源 = `navItems.ts`（与侧边栏共用），按能力矩阵过滤后即是「可达页面」索引；
 *   能力/权限不支持的页面不进列表，与菜单置灰口径一致，不会出现"搜得到点过去却 501"。
 * - 纯前端导航 + 少量本地快捷操作（打开通知）。刻意**不做**需要后端接入的动作
 *   （重启 nginx / 放行端口），那些依赖具体能力位与接口，留待各页内操作，避免面板里
 *   造出与后端不一致的执行入口。
 * - 交互：搜索（标题/路径）、↑↓ 选择、Enter 执行、Esc 关闭； mousemove 同步高亮。
 *   由 MainLayout 用全局 ⌘K / Ctrl+K 唤起，顶栏搜索按钮亦可触发。
 */
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { NAV_ITEMS, type NavDef } from '@/composables/navItems'
import Icon from '@/components/Icon.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const auth = useAuthStore()
const router = useRouter()
const q = ref('')
const active = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)

interface Cmd {
  key: string
  label: string
  icon: string
  group: string
  hint?: string
  run: () => void
}

const pages = computed<Cmd[]>(() =>
  NAV_ITEMS
    .filter((n: NavDef) => auth.whyDisabled(n.cap, n.perm) === null)
    .map((n) => ({
      key: 'nav:' + n.to,
      label: n.label,
      icon: n.icon,
      group: n.group,
      hint: n.to,
      run: () => router.push(n.to),
    })),
)

const extras = computed<Cmd[]>(() => [
  { key: 'act:notif', label: '打开通知', icon: 'bell', group: '快捷操作', run: () => router.push('/notifications') },
])

const all = computed<Cmd[]>(() => [...pages.value, ...extras.value])

const results = computed<Cmd[]>(() => {
  const s = q.value.trim().toLowerCase()
  if (!s) return all.value
  return all.value.filter(
    (c) => c.label.toLowerCase().includes(s) || (c.hint?.toLowerCase().includes(s) ?? false),
  )
})

watch(() => props.open, (v) => {
  if (v) {
    q.value = ''
    active.value = 0
    nextTick(() => inputEl.value?.focus())
  }
})
watch(results, () => { active.value = 0 })

function move(d: number) {
  const n = results.value.length
  if (!n) return
  active.value = (active.value + d + n) % n
}
function choose(c?: Cmd) {
  const cmd = c ?? results.value[active.value]
  if (!cmd) return
  emit('close')
  cmd.run()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); choose() }
  else if (e.key === 'Escape') { e.preventDefault(); emit('close') }
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div class="pal" role="dialog" aria-label="命令面板">
      <div class="box">
        <Icon name="search" :size="16" class="si" />
        <input
          ref="inputEl"
          v-model="q"
          class="inp"
          type="text"
          placeholder="搜索页面或操作…"
          aria-label="搜索"
          @keydown="onKey"
        />
        <kbd class="kbd">Esc</kbd>
      </div>
      <ul class="list" role="listbox">
        <li
          v-for="(c, i) in results"
          :key="c.key"
          :class="{ on: i === active }"
          role="option"
          :aria-selected="i === active"
          @mousemove="active = i"
          @click="choose(c)"
        >
          <Icon :name="c.icon" :size="16" class="ci" />
          <span class="lab">{{ c.label }}</span>
          <span class="grp">{{ c.group }}</span>
        </li>
        <li v-if="!results.length" class="empty">无匹配结果</li>
      </ul>
      <div class="foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 打开</span>
        <span><kbd>esc</kbd> 关闭</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 80;
  background: rgba(0, 0, 0, .45);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh;
  backdrop-filter: blur(2px);
}
.pal {
  width: min(560px, 92vw);
  background: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.box {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--c-border);
}
.si { color: var(--c-text-dim); flex: none; }
.inp {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--c-text); font: inherit; font-size: 15px;
}
.inp::placeholder { color: var(--c-text-mute); }
.kbd {
  flex: none; font-size: var(--fs-12); color: var(--c-text-dim);
  border: 1px solid var(--c-border); border-radius: 6px;
  padding: 2px 6px; background: var(--c-bg);
}
.list {
  list-style: none; margin: 0; padding: 6px;
  max-height: 52vh; overflow-y: auto;
}
.list li {
  display: flex; align-items: center; gap: 11px;
  padding: 9px 11px; border-radius: 9px; cursor: pointer;
  color: var(--c-text); font-size: 14px;
}
.list li.on { background: var(--c-active); color: var(--c-primary); }
.ci { flex: none; color: var(--c-text-dim); }
.list li.on .ci { color: var(--c-primary); }
.lab { flex: 1; min-width: 0; }
.grp {
  flex: none; font-size: var(--fs-12); color: var(--c-text-mute);
  border: 1px solid var(--c-border); border-radius: 999px; padding: 1px 8px;
}
.empty { color: var(--c-text-mute); text-align: center; padding: 20px; cursor: default; }
.foot {
  display: flex; gap: 16px; padding: 8px 14px;
  border-top: 1px solid var(--c-border);
  font-size: var(--fs-12); color: var(--c-text-mute);
}
.foot .kbd { margin-right: 3px; }
</style>
