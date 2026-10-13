<script setup lang="ts">
/**
 * 首启上手清单（评估报告 C2）。
 *
 * 为什么要有它：证书页自己就写着"首次部署、尚未建站时也应先完成这步（信任根证书）"——
 * 这类「顺序上的前置知识」此前散落在各个页面里，新用户第一次登录面对的是一张
 * 空站点表，不知道第一步该干嘛。这里把它收成一条 5 步清单，每步可跳转、可勾选、
 * 进度落库、可随时关闭。
 *
 * ⭐**进度不撒谎**：`done = 勾选 ∪ 后端真实状态`。建了站但没勾 → 也算完成；
 * 勾了但没做 → 若后端能判定（如备份计划数=0），`auto=false` 而 `checked=true`，
 * 仍显示为已完成——这一步**只能靠用户守约**，所以勾选框对可自动判定的步骤
 * 直接禁用（`auto=true`）：勾不勾结果都一样，做成可点就是假动作。
 *
 * 权限：读取对全员开放；勾选 / 关闭需 settings.manage（面板级共享进度）。
 */
import { computed, onMounted, ref } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import type { OnboardingState, OnboardingStepId } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const state = ref<OnboardingState | null>(null)
const err = ref('')
const busy = ref(false)

const canEdit = computed(() => auth.can('settings.manage'))
const allDone = computed(() => !!state.value && state.value.done_count >= state.value.total)
/** 清单的意义是「还差什么」：已关闭或已全做完就不再占首屏位置 */
const visible = computed(() => !!state.value && !state.value.dismissed && !allDone.value)
const pct = computed(() =>
  state.value && state.value.total ? Math.round((state.value.done_count / state.value.total) * 100) : 0,
)

async function load() {
  try {
    state.value = await api.get<OnboardingState>(API.settings.onboarding())
  } catch (e) {
    // 静默到卡片内部：清单是引导性内容，读失败只是不显示这一块，不该让整个概览报错
    err.value = errorText(e)
  }
}

async function save(checked: OnboardingStepId[], dismissed?: boolean) {
  if (busy.value) return
  busy.value = true
  err.value = ''
  try {
    const body: { checked: OnboardingStepId[]; dismissed?: boolean } = { checked }
    if (dismissed !== undefined) body.dismissed = dismissed
    state.value = await api.put<OnboardingState>(API.settings.onboarding(), body)
  } catch (e) {
    err.value = errorText(e)
  } finally {
    busy.value = false
  }
}

function checkedIds(): OnboardingStepId[] {
  return (state.value?.steps ?? []).filter((s) => s.checked).map((s) => s.id)
}

// 组件自管加载：挂载即取一次。此前漏了这句调用——数据永远不来，清单永远不渲染
// （模板 v-if 依赖 state，空态与失败态看起来完全一样，只有实机才发现）。
onMounted(load)

/** 勾选切换。可自动判定的步骤（`auto`）禁用：勾了也不改变结果 */
function toggle(s: { id: OnboardingStepId; auto: boolean; checked: boolean }) {
  if (!canEdit.value || s.auto) return
  const ids = checkedIds()
  void save(s.checked ? ids.filter((x) => x !== s.id) : [...ids, s.id])
}
</script>

<template>
  <section v-if="visible && state" class="card onboard">
    <div class="sec-head">
      <Icon name="list" :size="16" />
      <span>上手清单</span>
      <span class="prog">{{ state.done_count }} / {{ state.total }}</span>
      <span class="spacer" />
      <button v-if="canEdit" class="btn-ghost btn-sm" :disabled="busy" title="关闭清单（进度仍保留，可随时在设置里重新开始）"
        @click="save(checkedIds(), true)">
        不再显示
      </button>
    </div>

    <div class="bar" role="progressbar" :aria-valuenow="state.done_count" :aria-valuemin="0"
      :aria-valuemax="state.total" :aria-label="`上手清单进度 ${state.done_count} / ${state.total}`">
      <i :style="{ width: `${pct}%` }" />
    </div>

    <p v-if="err" class="err" role="alert">{{ err }}</p>

    <ul>
      <li v-for="s in state.steps" :key="s.id" :class="{ done: s.done }">
        <input type="checkbox" :checked="s.done" :disabled="!canEdit || busy || s.auto"
          :title="s.auto ? '已由系统判定完成（无需勾选）' : canEdit ? '勾选标记完成' : '需要设置管理权限'"
          :aria-label="s.title" @change="toggle(s)" />
        <div class="txt">
          <span class="t">{{ s.title }}</span>
          <span class="d">{{ s.desc }}</span>
        </div>
        <span v-if="s.auto" class="badge badge-ok" title="按服务器上的真实数据判定已完成">已自动完成</span>
        <RouterLink :to="s.route" class="btn-ghost btn-sm go">
          前往<Icon name="chevron" :size="13" />
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sec-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: var(--fs-14); margin-bottom: 12px; }
.sec-head :deep(.icon) { color: var(--c-primary); }
.spacer { flex: 1; }
.prog { font-size: var(--fs-12-5); font-weight: 500; color: var(--c-text-dim); font-family: var(--mono); }

.bar { height: 5px; border-radius: 999px; background: var(--c-surface-2); overflow: hidden; margin-bottom: 10px; }
.bar i { display: block; height: 100%; border-radius: 999px; background: var(--c-primary); transition: width .25s ease; }

ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
li { display: flex; align-items: flex-start; gap: 11px; padding: 9px 0; border-top: 1px solid var(--c-border); }
li:first-child { border-top: none; }
/* 全局 input{width:100%} 会把勾选框拉满整行，必须复位 */
li input { width: auto; margin-top: 2px; flex: none; accent-color: var(--c-primary); }
li input:disabled { cursor: not-allowed; }
.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.t { font-size: var(--fs-13-5); font-weight: 500; }
.d { font-size: var(--fs-12-5); color: var(--c-text-dim); line-height: 1.5; }
li.done .t { color: var(--c-text-dim); }
.go { flex: none; display: inline-flex; align-items: center; gap: 3px; }
.err { color: var(--c-danger); font-size: var(--fs-13); margin: 6px 0 0; }
</style>
