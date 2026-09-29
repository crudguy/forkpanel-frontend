<script setup lang="ts">
/**
 * AI 运维助手（#52 / 后端 routes/assistant.rs）。
 *
 * 诚实定位：内核为**内置规则诊断引擎**（确定性、可解释、零外部依赖），
 * 问句经关键词路由到诊断域；LLM 叙事层为可选后续。
 * 护栏：助手只读——「去处理」仅导航到对应视图，处置由用户人工确认。
 */
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import type { AssistantReport, AssistantFinding } from '@/api/types'
import Icon from '@/components/Icon.vue'

const auth = useAuthStore()
const router = useRouter()
const canOpen = computed(() => auth.can('system.view'))

const question = ref('')
const busy = ref(false)
const errorMsg = ref('')
/** 问答历史（本地 state，不持久化——诊断数据无留存价值） */
const turns = ref<Array<{ q: string; report: AssistantReport | null; err?: string }>>([])

const chips = ['系统体检', '为什么 CPU 高', '最近的报错', '安全风险', '备份状况'] as const

async function ask(q: string) {
  const text = q.trim()
  if (!text || busy.value) return
  busy.value = true
  errorMsg.value = ''
  const turn = { q: text, report: null as AssistantReport | null, err: undefined as string | undefined }
  turns.value.push(turn)
  try {
    turn.report = await api.post<AssistantReport>(API.assistant.diagnose(), { question: text })
  } catch (e) {
    turn.err = errorText(e)
  } finally {
    busy.value = false
    question.value = ''
  }
}

/** 报告整体等级：有 crit 用红、有 warn 用黄、否则绿 */
function worst(r: AssistantReport): 'crit' | 'warn' | 'ok' {
  if (r.findings.some(f => f.severity === 'crit')) return 'crit'
  if (r.findings.some(f => f.severity === 'warn')) return 'warn'
  return 'ok'
}

const sevLabel: Record<AssistantFinding['severity'], string> = { crit: '严重', warn: '风险', info: '提醒' }

function fmtKib(kib: number): string {
  if (kib >= 1024 * 1024) return (kib / 1024 / 1024).toFixed(1) + ' GiB'
  if (kib >= 1024) return (kib / 1024).toFixed(1) + ' MiB'
  return kib + ' KiB'
}
function fmtUp(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  return d > 0 ? `${d} 天 ${h} 小时` : `${h} 小时`
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">AI 助手</h2>
        <p class="page-sub">内置规则诊断 · 基于真实系统数据 · 只建议不自动执行</p>
      </div>
    </div>

    <EmptyState v-if="!canOpen" title="无权访问诊断助手" />

    <template v-else>
      <!-- 提问区 -->
      <div class="ask glass">
        <div class="chips">
          <button v-for="c in chips" :key="c" class="chip" :disabled="busy" @click="ask(c)">{{ c }}</button>
        </div>
        <div class="row">
          <input
            v-model="question" class="inp" type="text" :disabled="busy"
            placeholder="问点什么，例如：为什么 CPU 高 / 最近有没有报错"
            @keyup.enter="ask(question)"
          >
          <button class="btn-primary" :disabled="busy || !question.trim()" @click="ask(question)">
            <Icon name="sparkles" :size="15" /> {{ busy ? '诊断中…' : '诊断' }}
          </button>
        </div>
        <p v-if="errorMsg" class="err" role="alert">{{ errorMsg }}</p>
      </div>

      <!-- 空态 -->
      <p v-if="turns.length === 0 && !busy" class="empty-hint">
        输入问题或点上面的快捷提问。诊断采集：指标 · 进程 · 服务状态 · 系统日志 · 安全基线 · 备份记录。
      </p>

      <!-- 问答历史 -->
      <section v-for="(t, i) in turns" :key="i" class="turn">
        <p class="q"><Icon name="chevron" :size="13" /> {{ t.q }}</p>

        <p v-if="t.err" class="err">{{ t.err }}</p>

        <template v-else-if="t.report">
          <div class="report" :class="worst(t.report)">
            <p class="summary">
              <Icon :name="worst(t.report) === 'ok' ? 'check' : 'alert'" :size="14" />
              {{ t.report.summary }}
            </p>

            <!-- 体检基线 -->
            <div class="ctx">
              <span>CPU {{ t.report.ctx.cpu_pct.toFixed(0) }}%</span>
              <span>load {{ t.report.ctx.load1.toFixed(1) }} / {{ t.report.ctx.load5.toFixed(1) }} / {{ t.report.ctx.load15.toFixed(1) }}</span>
              <span>内存 {{ fmtKib(t.report.ctx.mem_used_kib) }} / {{ fmtKib(t.report.ctx.mem_total_kib) }}</span>
              <span v-if="t.report.ctx.top_disk">磁盘 {{ t.report.ctx.top_disk.mount }} {{ t.report.ctx.top_disk.used_pct.toFixed(0) }}%</span>
              <span>进程 {{ t.report.ctx.proc_count }}</span>
              <span>运行 {{ fmtUp(t.report.ctx.uptime_sec) }}</span>
              <span class="scope-tag">域：{{ t.report.scope }}</span>
            </div>

            <!-- 发现卡片 -->
            <article v-for="f in t.report.findings" :key="f.id" class="finding" :class="f.severity">
              <header>
                <span class="badge" :class="f.severity">{{ sevLabel[f.severity] }}</span>
                <strong>{{ f.title }}</strong>
              </header>
              <ul class="evidence">
                <li v-for="(e, j) in f.evidence" :key="j">{{ e }}</li>
              </ul>
              <p class="sug">{{ f.suggestion }}</p>
              <button v-if="f.action?.kind === 'navigate'" class="btn-ghost go" @click="router.push(f.action.view)">
                去处理 <Icon name="chevron" :size="13" />
              </button>
            </article>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ask { padding: 14px; border: 1px solid var(--c-border); border-radius: 12px; margin-bottom: 14px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.chip {
  border: 1px solid var(--c-border); background: transparent; color: var(--c-text-dim);
  padding: 5px 12px; border-radius: 999px; font-size: 12.5px; cursor: pointer;
}
.chip:hover:not(:disabled) { border-color: var(--c-primary); color: var(--c-text); }
.row { display: flex; gap: 8px; }
.inp {
  flex: 1; background: var(--c-surface); border: 1px solid var(--c-border);
  border-radius: 10px; padding: 9px 12px; color: var(--c-text); font-size: 13.5px;
}
.inp:focus { outline: none; border-color: var(--c-primary); }
.err { color: var(--c-danger); font-size: 13px; margin: 8px 0 0; }
.empty-hint { color: var(--c-text-mute); font-size: 13px; }

.turn { margin: 14px 0; }
.q { color: var(--c-text-dim); font-size: 13px; margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }

.report { border: 1px solid var(--c-border); border-radius: 12px; padding: 12px; background: var(--c-glass); }
.report.crit { border-color: var(--c-danger); }
.report.warn { border-color: var(--c-warn); }
.summary { display: flex; align-items: center; gap: 7px; font-size: 13.5px; margin: 0 0 10px; color: var(--c-text); }
.report.crit .summary { color: var(--c-danger); }
.report.warn .summary { color: var(--c-warn); }

.ctx {
  display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--c-text-mute);
  font-family: var(--mono); border-bottom: 1px dashed var(--c-border); padding-bottom: 9px; margin-bottom: 10px;
}
.scope-tag { margin-left: auto; }

.finding {
  border: 1px solid var(--c-border); border-left-width: 3px; border-radius: 10px;
  padding: 10px 12px; margin-bottom: 8px; background: var(--c-surface);
}
.finding.crit { border-left-color: var(--c-danger); }
.finding.warn { border-left-color: var(--c-warn); }
.finding.info { border-left-color: var(--c-ok); }
.finding header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
.badge.crit { background: var(--c-danger-soft, rgba(248,81,73,.15)); color: var(--c-danger); }
.badge.warn { background: var(--c-warn-bg); color: var(--c-warn); }
.badge.info { background: var(--c-ok-soft, rgba(63,185,80,.15)); color: var(--c-ok); }

.evidence { margin: 0 0 6px; padding-left: 18px; color: var(--c-text-dim); font-family: var(--mono); font-size: 12px; }
.evidence li { margin: 2px 0; word-break: break-all; }
.sug { color: var(--c-text-mute); font-size: 12.5px; margin: 0 0 8px; }
.go { font-size: 12.5px; }
</style>
